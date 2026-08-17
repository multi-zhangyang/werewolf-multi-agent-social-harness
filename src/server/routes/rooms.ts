import express from "express";
import { z } from "zod";
import { createAgentProfiles, modelCatalogFor } from "../../society/profiles";
import { ALL_SCENARIOS, SCENARIO_METADATA } from "../../society/scenarios";
import type { ScenarioId } from "../../society/contracts";
import { contextLabel, contextLimitForModel } from "../../society/context-manager";
import type { SocietyRoomSnapshot } from "../../society/room";
import type { ServerContext } from "../context";
import { getProviderSettings, publicSettings, saveProviderSettings, testProviderSettings } from "../settings";

const scenarioIds = Object.keys(SCENARIO_METADATA) as [ScenarioId, ...ScenarioId[]];

const settingsSchema = z.object({
  baseURL: z.string().max(500).optional(),
  apiKey: z.string().max(400).optional(),
  models: z.array(z.string().min(1).max(180)).min(1).max(16).optional()
}).strict();

const createRoomSchema = z.object({
  scenarioId: z.enum(scenarioIds),
  models: z.array(z.string().min(1).max(180)).min(1).max(8),
  rounds: z.number().int().positive().max(20).optional(),
  temperature: z.number().min(0).max(2).optional(),
  mode: z.enum(["ai", "human"]).default("ai"),
  playerName: z.string().trim().min(1).max(40).optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).default("low"),
  season: z.enum(["season", "one-shot"]).default("season")
}).strict().superRefine((input, issueContext) => {
  if (input.mode === "human" && !input.playerName) {
    issueContext.addIssue({ code: z.ZodIssueCode.custom, path: ["playerName"], message: "Human mode requires a playerName." });
  }
  if (input.rounds === undefined) return;
  const scenario = SCENARIO_METADATA[input.scenarioId];
  if (input.rounds < scenario.minRounds || input.rounds > scenario.maxRounds) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rounds"],
      message: `${scenario.name} requires between ${scenario.minRounds} and ${scenario.maxRounds} rounds.`
    });
  }
});

export function registerRoomRoutes(app: express.Express, context: ServerContext): void {
  app.get("/api/health", (_request, response) => {
    const settings = getProviderSettings();
    response.json({
      status: "ok",
      runtime: "@openai/agents",
      providerConfigured: Boolean(settings.apiKey),
      baseURL: settings.baseURL ? "configured" : "default"
    });
  });

  app.get("/api/settings", (_request, response) => {
    response.json(publicSettings());
  });

  app.put("/api/settings", (request, response, next) => {
    try {
      const input = settingsSchema.parse(request.body ?? {});
      response.json(saveProviderSettings(input));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/settings/test", (_request, response, next) => {
    void testProviderSettings()
      .then((result) => response.json(result))
      .catch(next);
  });

  app.get("/api/scenarios", (_request, response) => {
    const models = modelCatalogFor(getProviderSettings().models).map((model) => {
      const context = contextLimitForModel(model.id);
      return { ...model, context, contextLabel: contextLabel(context) };
    });
    response.json({ scenarios: ALL_SCENARIOS, models });
  });

  app.get("/api/rooms", (_request, response) => {
    response.json({ rooms: context.rooms.list() });
  });

  app.get("/api/season", (_request, response) => {
    response.json({
      dossiers: context.season.list().map((dossier) => ({
        characterKey: dossier.characterKey,
        games: dossier.games.slice(-6).map((game) => ({
          scenarioId: game.scenarioId,
          ...(game.role ? { role: game.role } : {}),
          outcome: game.outcome
        })),
        memoryCount: dossier.memories.length,
        updatedAt: dossier.updatedAt
      }))
    });
  });

  // A fresh season: forget every cross-game memory and start over.
  app.delete("/api/season", (_request, response) => {
    context.season.clear();
    response.json({ cleared: true, dossiers: [] });
  });

  app.post("/api/rooms", (request, response, next) => {
    try {
      const input = createRoomSchema.parse(request.body);
      const scenario = SCENARIO_METADATA[input.scenarioId];
      const profiles = createAgentProfiles(input.models, scenario.players, input.temperature);
      for (const profile of profiles) profile.reasoningEffort = input.reasoningEffort;
      if (input.mode === "human") {
        profiles[0] = {
          ...profiles[0],
          displayName: input.playerName!,
          model: "human",
          controller: "human"
        };
        for (let index = 1; index < profiles.length; index += 1) {
          profiles[index].model = input.models[(index - 1) % input.models.length];
        }
      }
      const room = context.rooms.create({
        scenarioId: input.scenarioId,
        profiles,
        rounds: input.rounds,
        apiKey: getProviderSettings().apiKey || undefined,
        baseURL: getProviderSettings().baseURL || undefined,
        seasonMode: input.season,
        ...(input.season === "season" ? { season: context.season } : {})
      });
      void room.start();
      response.status(202).json(room.creationResult());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/rooms/:roomId", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    const token = queryToken(request);
    const actorId = token ? room.actorForToken(token) : undefined;
    if (token && !actorId) {
      response.status(401).json({ error: "PLAYER_TOKEN_INVALID", message: "The player token is invalid." });
      return;
    }
    response.json(room.snapshotFor(actorId));
  });

  app.post("/api/rooms/:roomId/pause", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    if (room.humanActorId) {
      const actorId = room.actorForToken(queryToken(request) ?? bodyToken(request));
      if (!actorId) {
        response.status(401).json({ error: "PLAYER_TOKEN_INVALID", message: "A valid player token is required to pause this room." });
        return;
      }
    }
    room.pause();
    response.json(room.snapshotFor());
  });

  app.post("/api/rooms/:roomId/action", (request, response, next) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    const token = queryToken(request) ?? bodyToken(request);
    const action = request.body?.action;
    if (typeof action !== "string" || !action.trim()) {
      response.status(400).json({ error: "ACTION_REQUIRED", message: "Provide a structured action name." });
      return;
    }
    const actorId = room.actorForToken(token);
    if (!actorId) {
      response.status(401).json({ error: "PLAYER_TOKEN_INVALID", message: "A valid player token is required." });
      return;
    }
    void room.submitHumanAction(token!, action, request.body?.payload).then((commit) => {
      response.status(202).json({ commit, room: room.snapshotFor(actorId) });
    }).catch(next);
  });

  app.get("/api/rooms/:roomId/events", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    const token = queryToken(request);
    const actorId = token ? room.actorForToken(token) : undefined;
    if (token && !actorId) {
      response.status(401).json({ error: "PLAYER_TOKEN_INVALID", message: "The player token is invalid." });
      return;
    }
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    const writeSnapshot = (envelope?: unknown) => {
      if (response.writableEnded) return;
      writeEvent(response, "snapshot", room.snapshotFor(actorId));
      if (envelope) writeEvent(response, "event", envelope);
    };
    writeSnapshot();
    const unsubscribe = room.subscribe((envelope) => writeSnapshot(envelope));
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(`: ${Date.now()}\n\n`);
    }, 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

function queryToken(request: express.Request): string | undefined {
  const value = request.query.token;
  return typeof value === "string" && value ? value : undefined;
}

function bodyToken(request: express.Request): string | undefined {
  const header = request.header("x-player-token") ?? request.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  if (header) return header.trim();
  const value = request.body?.token;
  return typeof value === "string" && value ? value : undefined;
}

function writeEvent(response: express.Response, name: string, data: SocietyRoomSnapshot | unknown): void {
  if (response.writableEnded) return;
  response.write(`event: ${name}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}
