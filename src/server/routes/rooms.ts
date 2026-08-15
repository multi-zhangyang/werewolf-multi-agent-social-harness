import express from "express";
import { z } from "zod";
import { MODEL_CATALOG, createAgentProfiles } from "../../society/profiles";
import { ALL_SCENARIOS, SCENARIO_METADATA } from "../../society/scenarios";
import type { SocietyRoomSnapshot } from "../../society/room";
import type { ServerContext } from "../context";

const createRoomSchema = z.object({
  scenarioId: z.enum(["prisoners-dilemma", "public-goods", "trust-game", "werewolf"]),
  models: z.array(z.string().min(1).max(180)).min(1).max(8),
  rounds: z.number().int().positive().max(20).optional(),
  temperature: z.number().min(0).max(2).optional()
}).strict().superRefine((input, issueContext) => {
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
    response.json({
      status: "ok",
      runtime: "@openai/agents",
      providerConfigured: hasProviderKey(),
      baseURL: process.env.OPENAI_BASE_URL ? "configured" : "default"
    });
  });

  app.get("/api/scenarios", (_request, response) => {
    response.json({ scenarios: ALL_SCENARIOS, models: MODEL_CATALOG });
  });

  app.get("/api/rooms", (_request, response) => {
    response.json({ rooms: context.rooms.list() });
  });

  app.post("/api/rooms", (request, response, next) => {
    try {
      const input = createRoomSchema.parse(request.body);
      const scenario = SCENARIO_METADATA[input.scenarioId];
      const profiles = createAgentProfiles(input.models, scenario.players, input.temperature);
      const room = context.rooms.create({ scenarioId: input.scenarioId, profiles, rounds: input.rounds });
      void room.start();
      response.status(202).json(room.snapshot());
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
    response.json(room.snapshot());
  });

  app.post("/api/rooms/:roomId/pause", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    room.pause();
    response.json(room.snapshot());
  });

  app.get("/api/rooms/:roomId/events", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    const snapshot = room.snapshot();
    writeEvent(response, "snapshot", snapshot, String(snapshot.recentEvents.at(-1)?.seq ?? 0));
    const since = Number(request.query.since ?? 0);
    if (Number.isFinite(since) && since > 0) {
      for (const event of room.eventsSince(since)) writeEvent(response, "room", event, String(event.seq));
    }
    const unsubscribe = room.subscribe((event) => writeEvent(response, "room", event, String(event.seq)));
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(`: ${Date.now()}\n\n`);
    }, 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

function hasProviderKey(): boolean {
  const value = process.env.OPENAI_API_KEY?.trim();
  return Boolean(value && !value.startsWith("replace-with"));
}

function writeEvent(response: express.Response, name: string, data: SocietyRoomSnapshot | unknown, id?: string): void {
  if (response.writableEnded) return;
  if (id) response.write(`id: ${id}\n`);
  response.write(`event: ${name}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}
