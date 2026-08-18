import express from "express";
import { z } from "zod";
import { characterAgentProfile } from "../../society/profiles";
import { ALL_SCENARIOS, SCENARIO_METADATA } from "../../society/scenarios";
import type { AgentProfile, AgentRuntimeEvent, ScenarioId, ScenarioSummary, SpectatorMode } from "../../society/contracts";
import { contextLabel } from "../../society/context-manager";
import type { SocietyRoom, SocietyRoomEventEnvelope, SocietyRoomSnapshot } from "../../society/room";
import { defaultCapabilities, defaultContextPolicy, persistRegistry, type AgentModelBinding, type ContextPolicy, type ModelProfile } from "../../society/models";
import { projectEventFor, type SpectatorViewer } from "../../society/spectator/projection";
import type { ServerContext } from "../context";
import { getProviderSettings, publicSettings, saveProviderSettings, testProviderSettings, writeEnvKey } from "../settings";
import { mergeProbeResult, probeCapabilities } from "../probe";

function sanitizeEnvName(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
}

/**
 * Resolve the spectator seat for a request. Human players are hard-capped at
 * public / self-pov during play and may unlock the full reveal only after the
 * game ends (AGENTS.md §8.3).
 */
function resolveViewer(request: express.Request, room: SocietyRoom): SpectatorViewer {
  const raw = request.query.mode;
  const requested: SpectatorMode =
    raw === "public" || raw === "omniscient" || raw === "agent-pov" || raw === "postgame"
      ? raw
      : "omniscient";
  const token = queryToken(request);
  const tokenActor = token ? room.actorForToken(token) : undefined;
  if (tokenActor) {
    if (requested === "postgame") {
      return room.currentStatus() === "finished" ? { mode: "postgame" } : { mode: "public" };
    }
    if (requested === "omniscient") return { mode: "public" };
    if (requested === "agent-pov") return { mode: "agent-pov", agentId: tokenActor };
    return { mode: requested };
  }
  const agentId = typeof request.query.agent === "string" && request.query.agent.trim()
    ? request.query.agent.trim()
    : undefined;
  return {
    mode: requested,
    ...(requested === "agent-pov" && agentId ? { agentId } : {})
  };
}

const scenarioIds = Object.keys(SCENARIO_METADATA) as [ScenarioId, ...ScenarioId[]];

const settingsSchema = z.object({
  baseURL: z.string().max(500).optional(),
  apiKey: z.string().max(400).optional(),
  models: z.array(z.string().min(1).max(180)).min(1).max(16).optional()
}).strict();

const createRoomSchema = z.object({
  scenarioId: z.enum(scenarioIds),
  /** Legacy entry: model IDs, round-robined per seat. */
  models: z.array(z.string().min(1).max(180)).min(1).max(8).optional(),
  /** Model-profile ids, round-robined per seat (wins over `models`). */
  modelProfileIds: z.array(z.string().min(1).max(120)).min(1).max(12).optional(),
  /** Per-seat overrides: slot index → model profile id. */
  agentModelOverrides: z.record(z.string().min(1).max(8), z.string().min(1).max(120)).optional(),
  /** Per-seat tuning overrides: slot index → temperature / effort. */
  agentTuning: z.record(z.string().min(1).max(8), z.object({
    temperature: z.number().min(0).max(2).optional(),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional()
  }).strict()).optional(),
  rounds: z.number().int().positive().max(20).optional(),
  /** Seat count for this room; defaults to the scenario's default. */
  players: z.number().int().positive().max(12).optional(),
  /** Character picks for the front seats (built-in ids or custom character ids). */
  characterIds: z.array(z.string().min(1).max(120)).max(12).optional(),
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
      baseURL: settings.baseURL ? "configured" : "default",
      activations: {
        active: context.limiter.concurrency(),
        pending: context.limiter.pending(),
        max: context.limiter.maxConcurrent
      }
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
    const profiles = context.models.listModelProfiles().filter((profile) => profile.enabled);
    const models = profiles.length
      ? profiles.map((profile) => ({
          id: profile.modelId,
          profileId: profile.id,
          name: profile.name,
          provider: "OpenAI-compatible",
          context: profile.contextWindow,
          contextLabel: contextLabel(profile.contextWindow),
          capabilitySummary: summarizeCapabilities(profile)
        }))
      : modelCatalogForEnv(context);
    response.json({ scenarios: ALL_SCENARIOS, models });
  });

  app.get("/api/model-config", (_request, response) => {
    response.json(publicModelConfig(context));
  });

  app.post("/api/model-config/probe", (request, response, next) => {
    const profileId = typeof request.body?.modelProfileId === "string" ? request.body.modelProfileId : "";
    const profile = context.models.modelProfile(profileId);
    if (!profile) {
      response.status(404).json({ error: "MODEL_PROFILE_MISSING", message: "The requested model profile does not exist." });
      return;
    }
    const provider = context.models.providerProfile(profile.providerProfileId);
    if (!provider) {
      response.status(400).json({ error: "PROVIDER_PROFILE_MISSING", message: "The profile's provider does not exist." });
      return;
    }
    void probeCapabilities({
      baseURL: provider.baseURL,
      apiKey: resolveKeyRef(provider.apiKeyRef),
      modelId: profile.modelId
    }).then((result) => {
      const merged = { ...profile, capabilities: mergeProbeResult(profile.capabilities, result.capabilities) };
      context.models.upsertModelProfile(merged);
      persistRegistry(context.models);
      response.json({ ...result, capabilities: merged.capabilities });
    }).catch(next);
  });

  app.put("/api/model-config", (request, response, next) => {
    try {
      const input = modelConfigSchema.parse(request.body ?? {});
      const state = applyModelConfig(context, input);
      response.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/rooms", (_request, response) => {
    response.json({ rooms: context.rooms.list(), archived: context.archive.list() });
  });

  // Remove a room: stops it, finalizes its archive checkpoint, frees memory.
  // Human rooms require the player's own token; AI rooms are observer-owned.
  app.delete("/api/rooms/:roomId", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    if (room.humanActorId) {
      const actorId = room.actorForToken(queryToken(request) ?? bodyToken(request));
      if (!actorId) {
        response.status(401).json({ error: "PLAYER_TOKEN_INVALID", message: "A valid player token is required to remove this room." });
        return;
      }
    }
    const removed = context.rooms.remove(request.params.roomId);
    response.json({ removed: Boolean(removed), roomId: request.params.roomId, archived: context.archive.list() });
  });

  app.get("/api/rooms/:roomId/archive", (request, response) => {
    const checkpoint = context.archive.load(request.params.roomId);
    if (!checkpoint) {
      response.status(404).json({ error: "ARCHIVE_NOT_FOUND", message: "No checkpoint exists for this room." });
      return;
    }
    response.json(checkpoint);
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

  // Forget ONE character's cross-game memory (§7.2): their next game starts
  // from a clean slate while everyone else keeps their history.
  app.delete("/api/season/:characterKey", (request, response) => {
    const key = decodeURIComponent(request.params.characterKey);
    if (!key.trim() || key.length > 60) {
      response.status(400).json({ error: "CHARACTER_KEY_INVALID", message: "Provide a valid character key." });
      return;
    }
    const removed = context.season.remove(key);
    response.json({ removed, characterKey: key, dossiers: context.season.list().length });
  });

  app.post("/api/rooms", (request, response, next) => {
    try {
      const input = createRoomSchema.parse(request.body);
      const scenario = SCENARIO_METADATA[input.scenarioId];
      const seatCount = resolveSeatCount(scenario, input.players);
      const models = resolveModelIds(context, input, seatCount);
      if (seatCount < 2) throw new Error(`PLAYER_COUNT_INVALID: ${scenario.name} needs at least 2 participants.`);
      // Explicit character picks fill the front seats; the rest get built-ins.
      const roster = context.characters.roster(input.characterIds, seatCount);
      const profiles = roster.map((character, index) => characterAgentProfile(character, index, models, input.temperature));
      for (const profile of profiles) profile.reasoningEffort = input.reasoningEffort;
      if (input.mode === "human") {
        profiles[0] = {
          ...profiles[0],
          displayName: input.playerName!,
          model: "human",
          controller: "human"
        };
        for (let index = 1; index < profiles.length; index += 1) {
          profiles[index].model = models[(index - 1) % models.length];
        }
      }
      const agentBindings = buildAgentBindings(context, input, profiles);
      const roomDefaults = roomDefaultsFor(context, input);
      const room = context.rooms.create({
        scenarioId: input.scenarioId,
        profiles,
        rounds: input.rounds,
        apiKey: getProviderSettings().apiKey || undefined,
        baseURL: getProviderSettings().baseURL || undefined,
        seasonMode: input.season,
        modelRegistry: context.models,
        limiter: context.limiter,
        ...(roomDefaults ? { roomDefaults } : {}),
        ...(agentBindings ? { agentBindings } : {}),
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
      // Archive fallback (§5.9): a finished or interrupted room that left the
      // process memory can still be viewed read-only from its checkpoint.
      const checkpoint = context.archive.load(request.params.roomId);
      if (checkpoint?.snapshot) {
        response.json(checkpoint.snapshot);
        return;
      }
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    const token = queryToken(request);
    const actorId = token ? room.actorForToken(token) : undefined;
    if (token && !actorId) {
      response.status(401).json({ error: "PLAYER_TOKEN_INVALID", message: "The player token is invalid." });
      return;
    }
    response.json(room.snapshotForViewer(resolveViewer(request, room)));
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

  app.post("/api/rooms/:roomId/resume", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    if (room.humanActorId) {
      const actorId = room.actorForToken(queryToken(request) ?? bodyToken(request));
      if (!actorId) {
        response.status(401).json({ error: "PLAYER_TOKEN_INVALID", message: "A valid player token is required to resume this room." });
        return;
      }
    }
    if (room.currentStatus() !== "paused") {
      response.status(400).json({ error: "ROOM_NOT_PAUSED", message: "The room is not paused." });
      return;
    }
    room.resume();
    response.json(room.snapshotFor());
  });

  app.post("/api/rooms/:roomId/agents/:actorId/pause", (request, response) => {
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
    try {
      const reason = typeof request.body?.reason === "string" && request.body.reason.trim()
        ? request.body.reason.trim().slice(0, 200)
        : undefined;
      room.pauseAgent(request.params.actorId, reason);
      response.json(room.snapshotFor());
    } catch (error) {
      response.status(400).json({ error: "AGENT_PAUSE_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/rooms/:roomId/agents/:actorId/resume", (request, response) => {
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
    room.resumeAgent(request.params.actorId);
    response.json(room.snapshotFor());
  });

  // Model switch (§12.4): swap one agent's model while paused; identity,
  // session and memory survive. The room must be paused (or just that agent).
  app.post("/api/rooms/:roomId/agents/:actorId/model", (request, response, next) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    if (room.humanActorId) {
      const actorId = room.actorForToken(queryToken(request) ?? bodyToken(request));
      if (!actorId) {
        response.status(401).json({ error: "PLAYER_TOKEN_INVALID", message: "A valid player token is required to switch a model in this room." });
        return;
      }
    }
    const input = z.object({ modelProfileId: z.string().min(1).max(120) }).strict().parse(request.body);
    void room.switchAgentModel(request.params.actorId, input.modelProfileId).then((switched) => {
      response.json({ switched, room: room.snapshotFor() });
    }).catch(next);
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
    const viewer = resolveViewer(request, room);
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();

    // SSE cursor recovery (AGENTS.md §9.4): a (re)connecting client resumes
    // from its last sequence via ?afterSequence= or the Last-Event-ID header
    // EventSource sends automatically. Backlog events are replayed first, then
    // only increments flow — snapshots anchor the stream, they don't replace it.
    const writeEnvelope = (envelope: SocietyRoomEventEnvelope): void => {
      if (response.writableEnded) return;
      const projected = projectEnvelopeForViewer(envelope, viewer, room);
      if (!projected) return;
      writeEvent(response, "event", projected, projected.seq);
    };
    const backlog = room.eventsSince(afterSequence(request));
    for (const envelope of backlog) writeEnvelope(envelope);

    let lastSnapshotAt = 0;
    const writeSnapshot = (): void => {
      if (response.writableEnded) return;
      lastSnapshotAt = Date.now();
      writeEvent(response, "snapshot", room.snapshotForViewer(viewer));
    };
    writeSnapshot();

    const unsubscribe = room.subscribe((envelope) => {
      writeEnvelope(envelope);
      // Scoped snapshots stay available for self-healing, but are coalesced so
      // high-frequency streaming does not resend the whole room every event.
      if (Date.now() - lastSnapshotAt >= 1_000) writeSnapshot();
    });
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(`: ${Date.now()}\n\n`);
    }, 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

const modelConfigSchema = z.object({
  globalDefaults: z.object({
    modelProfileId: z.string().min(1).max(120).optional(),
    contextPolicyId: z.string().min(1).max(120).optional()
  }).strict().optional(),
  providers: z.array(z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    kind: z.enum(["openai", "openai-compatible", "local", "custom"]),
    baseURL: z.string().min(1).max(500),
    /** Env-var reference; raw keys are never accepted here. */
    apiKeyRef: z.string().min(1).max(120).optional(),
    /** Optional one-time secret: written to .env.local under a managed env var. */
    apiKey: z.string().min(1).max(400).optional(),
    apiMode: z.enum(["responses", "chat-completions", "auto"]),
    enabled: z.boolean()
  }).strict()).optional(),
  removeProviderIds: z.array(z.string().min(1).max(120)).max(32).optional(),
  removeModelProfileIds: z.array(z.string().min(1).max(120)).max(64).optional(),
  modelProfiles: z.array(z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    providerProfileId: z.string().min(1).max(120),
    modelId: z.string().min(1).max(180),
    contextWindow: z.number().int().positive().max(100_000_000),
    enabled: z.boolean(),
    capabilities: z.object({
      streaming: z.enum(["yes", "no", "unknown"]),
      tools: z.enum(["yes", "no", "unknown"]),
      parallelToolCalls: z.enum(["yes", "no", "unknown"]),
      reasoning: z.enum(["yes", "no", "unknown"]),
      reasoningSummary: z.enum(["yes", "no", "unknown"]),
      structuredOutput: z.enum(["yes", "no", "unknown"]),
      promptCaching: z.enum(["yes", "no", "unknown"]),
      nativeCompaction: z.enum(["yes", "no", "unknown"]),
      seed: z.enum(["yes", "no", "unknown"]),
      stopSequences: z.enum(["yes", "no", "unknown"]),
      imageInput: z.enum(["yes", "no", "unknown"]),
      maxOutputTokens: z.enum(["yes", "no", "unknown"])
    }).strict().optional()
  }).strict()).optional(),
  contextPolicies: z.array(z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    mode: z.enum(["automatic", "custom"]),
    watchRatio: z.number().min(0.1).max(0.98),
    retrievalTightRatio: z.number().min(0.1).max(0.98),
    softCompactRatio: z.number().min(0.1).max(0.98),
    deepCompactRatio: z.number().min(0.1).max(0.98),
    emergencyRatio: z.number().min(0.1).max(0.98),
    hardLimitRatio: z.number().min(0.1).max(0.98),
    targetAfterCompactionMin: z.number().min(0.1).max(0.98),
    targetAfterCompactionMax: z.number().min(0.1).max(0.98),
    recentTurnsToKeep: z.number().int().min(1).max(20),
    recentRawMessagesToKeep: z.number().int().min(1).max(100),
    recentToolResultsToKeep: z.number().int().min(1).max(100),
    maxRetrievedMemoryTokens: z.number().int().positive().max(1_000_000)
  }).strict()).optional()
}).strict();

/** Public, secret-free view of the model registry. */
function publicModelConfig(context: ServerContext): Record<string, unknown> {
  const providers = context.models.listProviders().map((profile) => ({
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    baseURL: profile.baseURL,
    apiMode: profile.apiMode,
    enabled: profile.enabled,
    hasKey: Boolean(resolveKeyRef(profile.apiKeyRef)),
    updatedAt: profile.updatedAt
  }));
  const modelProfiles = context.models.listModelProfiles().map((profile) => ({
    id: profile.id,
    name: profile.name,
    providerProfileId: profile.providerProfileId,
    modelId: profile.modelId,
    contextWindow: profile.contextWindow,
    contextWindowSource: profile.contextWindowSource,
    contextLabel: contextLabel(profile.contextWindow),
    capabilities: profile.capabilities,
    defaults: profile.defaults,
    contextPolicyId: profile.contextPolicyId,
    enabled: profile.enabled
  }));
  return {
    providers,
    modelProfiles,
    contextPolicies: context.models.listContextPolicies(),
    globalDefaults: context.models.globalDefaults()
  };
}

function applyModelConfig(context: ServerContext, input: z.infer<typeof modelConfigSchema>): Record<string, unknown> {
  if (input.globalDefaults) context.models.setGlobalDefaults(input.globalDefaults);
  if (input.providers) {
    for (const update of input.providers) {
      const existing = context.models.providerProfile(update.id);
      let apiKeyRef = update.apiKeyRef ?? existing?.apiKeyRef;
      // A pasted secret is persisted into .env.local under a managed env var
      // and only the reference is kept — the registry file never sees keys.
      if (update.apiKey) {
        const envName = `SOCIETY_PROVIDER_${sanitizeEnvName(update.id)}_KEY`;
        writeEnvKey(envName, update.apiKey);
        apiKeyRef = `env:${envName}`;
      }
      context.models.upsertProvider({
        ...(existing ?? {
          kind: update.kind,
          createdAt: new Date().toISOString()
        }),
        id: update.id,
        name: update.name,
        baseURL: update.baseURL,
        apiMode: update.apiMode,
        enabled: update.enabled,
        ...(apiKeyRef ? { apiKeyRef } : {}),
        updatedAt: new Date().toISOString()
      });
    }
  }
  for (const id of input.removeProviderIds ?? []) context.models.removeProvider(id);
  for (const id of input.removeModelProfileIds ?? []) context.models.removeModelProfile(id);
  if (input.modelProfiles) {
    for (const update of input.modelProfiles) {
      const existing = context.models.modelProfile(update.id);
      const merged: ModelProfile = existing
        ? { ...existing, ...update }
        : {
            id: update.id,
            name: update.name,
            providerProfileId: update.providerProfileId,
            modelId: update.modelId,
            contextWindow: update.contextWindow,
            contextWindowSource: "manual",
            capabilities: defaultCapabilities(),
            defaults: {},
            contextPolicyId: "policy-balanced-auto",
            enabled: update.enabled
          };
      context.models.upsertModelProfile(merged);
    }
  }
  if (input.contextPolicies) {
    for (const update of input.contextPolicies) {
      const existing = context.models.contextPolicy(update.id);
      const merged: ContextPolicy = {
        ...(existing ?? defaultContextPolicy()),
        ...update,
        reservedOutputTokens: existing?.reservedOutputTokens ?? "auto",
        reservedToolTokens: existing?.reservedToolTokens ?? "auto",
        safetyMarginTokens: existing?.safetyMarginTokens ?? "auto",
        compactionCooldownActivations: existing?.compactionCooldownActivations ?? 4,
        tokenizer: existing?.tokenizer ?? "heuristic",
        heuristicSafetyMultiplier: existing?.heuristicSafetyMultiplier ?? 1.15,
        useNativeCompaction: existing?.useNativeCompaction ?? "auto",
        verifyPinnedFacts: existing?.verifyPinnedFacts ?? true,
        consolidateDuringIdle: existing?.consolidateDuringIdle ?? true
      };
      context.models.upsertContextPolicy(merged);
    }
  }
  persistRegistry(context.models);
  return publicModelConfig(context);
}

function resolveKeyRef(ref: string | undefined): string {
  if (!ref) return process.env.OPENAI_API_KEY ?? "";
  if (ref.startsWith("env:")) return process.env[ref.slice(4)] ?? "";
  return "";
}

/** Seat count for a room: creator choice clamped to the scenario's own range. */
function resolveSeatCount(scenario: ScenarioSummary, requested: number | undefined): number {
  const range = scenario.playerRange ?? { min: scenario.players, max: scenario.players };
  const fallback = scenario.players;
  if (requested === undefined) return fallback;
  return Math.max(range.min, Math.min(range.max, Math.floor(requested)));
}

/** Model IDs for each seat: profile-based input wins, legacy env list otherwise. */
function resolveModelIds(context: ServerContext, input: z.infer<typeof createRoomSchema>, seatCount: number): string[] {
  const scenario = SCENARIO_METADATA[input.scenarioId];
  const profileIds = input.modelProfileIds ?? Object.values(input.agentModelOverrides ?? {});
  if (profileIds && profileIds.length) {
    const ids = profileIds
      .map((id) => context.models.modelProfile(id)?.modelId)
      .filter((id): id is string => Boolean(id));
    if (ids.length) return ids;
  }
  const profiles = context.models.listModelProfiles().filter((profile) => profile.enabled);
  if (profiles.length) {
    const ids = profiles.map((profile) => profile.modelId);
    return Array.from({ length: seatCount }, (_, index) => ids[index % ids.length]);
  }
  return input.models ?? getProviderSettings().models;
}

/** Per-agent model bindings from profile-id / per-seat override input. */
function buildAgentBindings(
  context: ServerContext,
  input: z.infer<typeof createRoomSchema>,
  profiles: AgentProfile[]
): Record<string, AgentModelBinding> | undefined {
  const bindings: Record<string, AgentModelBinding> = {};
  if (input.modelProfileIds && input.modelProfileIds.length) {
    profiles.forEach((profile, index) => {
      bindings[profile.id] = {
        defaultModelProfileId: input.modelProfileIds![index % input.modelProfileIds!.length]
      };
    });
  }
  if (input.agentModelOverrides) {
    profiles.forEach((profile, index) => {
      const override = input.agentModelOverrides![String(index)];
      if (!override) return;
      const modelProfile = context.models.modelProfile(override);
      if (!modelProfile) {
        throw new Error(`MODEL_PROFILE_MISSING: '${override}' is not a registered model profile.`);
      }
      bindings[profile.id] = { ...(bindings[profile.id] ?? {}), defaultModelProfileId: override };
    });
  }
  if (input.agentTuning) {
    profiles.forEach((profile, index) => {
      const tuning = input.agentTuning![String(index)];
      if (!tuning) return;
      bindings[profile.id] = {
        ...(bindings[profile.id] ?? {}),
        tuningOverrides: { ...(bindings[profile.id]?.tuningOverrides ?? {}), ...tuning }
      };
    });
  }
  return Object.keys(bindings).length ? bindings : undefined;
}

function roomDefaultsFor(context: ServerContext, input: z.infer<typeof createRoomSchema>): Record<string, unknown> | undefined {
  const global = context.models.globalDefaults();
  const roomModelProfileId = input.modelProfileIds?.[0]
    ?? Object.values(input.agentModelOverrides ?? {})[0]
    ?? global.modelProfileId;
  const defaults: Record<string, unknown> = {};
  if (roomModelProfileId) defaults.modelProfileId = roomModelProfileId;
  if (global.contextPolicyId) defaults.contextPolicyId = global.contextPolicyId;
  if (input.temperature !== undefined) defaults.tuning = { temperature: input.temperature };
  if (input.reasoningEffort) defaults.tuning = { ...(defaults.tuning as Record<string, unknown> ?? {}), reasoningEffort: input.reasoningEffort };
  return Object.keys(defaults).length ? defaults : undefined;
}

function summarizeCapabilities(profile: ModelProfile): string {
  const states = profile.capabilities;
  const parts: string[] = [];
  for (const [name, state] of Object.entries(states)) {
    if (state === "unknown") continue;
    parts.push(`${name}:${state}`);
  }
  return parts.join(",");
}

function modelCatalogForEnv(context: ServerContext): Array<{ id: string; name: string; provider: string; context: number; contextLabel: string }> {
  const ids = getProviderSettings().models;
  return ids.map((id) => {
    const profile = context.models.listModelProfiles().find((entry) => entry.modelId === id);
    const contextWindow = profile?.contextWindow ?? 256_000;
    return { id, name: id, provider: "OpenAI-compatible", context: contextWindow, contextLabel: contextLabel(contextWindow) };
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

/**
 * SSE cursor from the query string or the Last-Event-ID header that
 * EventSource re-sends automatically on reconnect. Undefined = fresh stream.
 */
function afterSequence(request: express.Request): number {
  const raw = typeof request.query.afterSequence === "string"
    ? request.query.afterSequence
    : request.header("last-event-id");
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Per-viewer envelope projection. Besides the event-family rules of
 * `projectEventFor`, the world snapshot carried by a `world.updated` envelope
 * is the room's internal view: it must be re-scoped to the viewer's seat
 * before it crosses the wire, otherwise a public seat would receive private
 * and team-channel messages (AGENTS.md §8.3).
 */
function projectEnvelopeForViewer(
  envelope: SocietyRoomEventEnvelope,
  viewer: SpectatorViewer,
  room: SocietyRoom
): SocietyRoomEventEnvelope | undefined {
  const event = envelope.event;
  const projected = projectEventFor(event, viewer);
  if (!projected) return undefined;
  if (event.type === "world.updated") {
    return {
      ...envelope,
      event: { ...event, snapshot: room.snapshotForViewer(viewer).world }
    };
  }
  if (event.type === "agent.message" && viewer.mode === "public" && event.message.channel !== "public") {
    return undefined;
  }
  if (projected === event) return envelope;
  return { ...envelope, event: projected };
}

function writeEvent(response: express.Response, name: string, data: SocietyRoomSnapshot | unknown, id?: number): void {
  if (response.writableEnded) return;
  response.write(`event: ${name}\n`);
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}
