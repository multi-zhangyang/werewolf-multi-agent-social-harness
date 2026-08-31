import express from "express";
import { z } from "zod";
import { characterAgentProfile } from "../../society/profiles";
import { ALL_SCENARIOS, SCENARIO_METADATA } from "../../society/scenarios";
import type { AgentProfile, ScenarioId, ScenarioSummary, SpectatorMode } from "../../society/contracts";
import { contextLabel } from "../../society/context-manager";
import type { SocietyRoom, SocietyRoomArchive, SocietyRoomEventEnvelope, SocietyRoomSnapshot } from "../../society/room";
import { deleteRoomArchive, isArchiveOwner, listRoomArchives, readRoomArchive, writeRoomArchive } from "../../server/archives";
import {
  defaultCapabilities,
  defaultContextPolicy,
  effectiveProtocolCheck,
  isModelProtocolReady,
  persistRegistry,
  type AgentModelBinding,
  type ContextPolicy,
  type ModelProfile
} from "../../society/models";
import { projectEventFor, type SpectatorViewer } from "../../society/spectator/projection";
import type { ServerContext } from "../context";
import {
  requireGlobalOperator,
  roomAuthorityFor,
  setTokenCookie,
  tokenFromRequest,
  type RoomAuthority
} from "../auth";
import { getProviderSettings, writeEnvKey } from "../settings";
import { fetchRemoteModels } from "../probe";
import { resolveKeyRef, runModelProbe } from "../model-probe-service";

function sanitizeEnvName(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
}

/**
 * Resolve the spectator seat for a request.
 * The anonymous default is PUBLIC — omniscient and agent-pov seats require a
 * participant, owner or operator token. Postgame reveals the world after the
 * game ends, but private minds stay gated behind owner/operator.
 */
function resolveViewer(
  request: express.Request,
  room: SocietyRoom,
  authority: RoomAuthority,
  isOperator: boolean
): SpectatorViewer {
  const raw = request.query.mode;
  const requested: SpectatorMode =
    raw === "public" || raw === "omniscient" || raw === "agent-pov" || raw === "postgame"
      ? raw
      : "public";
  if (requested === "postgame") {
    const privileged = authority.owner || isOperator;
    return room.currentStatus() === "finished" ? { mode: "postgame", privileged } : { mode: "public", privileged };
  }
  if (requested === "omniscient") {
    return authority.owner || isOperator ? { mode: "omniscient" } : { mode: "public" };
  }
  if (requested === "agent-pov") {
    // Participants watch only their own seat; owner/operator may watch any.
    if (authority.participantActorId) return { mode: "agent-pov", agentId: authority.participantActorId };
    if (authority.owner || isOperator) {
      const requestedAgent = typeof request.query.agent === "string" && request.query.agent.trim()
        ? request.query.agent.trim()
        : undefined;
      return { mode: "agent-pov", privileged: true, ...(requestedAgent ? { agentId: requestedAgent } : {}) };
    }
    return { mode: "public" };
  }
  return { mode: "public", privileged: authority.owner || isOperator };
}

/** What the UI should display as this connection's real information boundary. */
function viewerDescription(viewer: SpectatorViewer): {
  mode: SpectatorMode;
  privileged: boolean;
  agentId?: string;
} {
  return {
    mode: viewer.mode,
    privileged: viewer.privileged === true,
    ...(viewer.agentId ? { agentId: viewer.agentId } : {})
  };
}

/** Owner / strict-operator gate for room control operations. */
function requireRoomControl(
  request: express.Request,
  response: express.Response,
  room: SocietyRoom,
  auth: ServerContext["auth"]
): RoomAuthority | undefined {
  const authority = roomAuthorityFor(request, room);
  if (authority.owner) return authority;
  if (auth.localAdministrationEnabled()) return authority;
  if (auth.isOperatorToken(tokenFromRequest(request))) return authority;
  response.status(403).json({
    error: "CONTROL_FORBIDDEN",
    message: "A valid room-owner or operator token is required to control this room."
  });
  return undefined;
}

const scenarioIds = Object.keys(SCENARIO_METADATA) as [ScenarioId, ...ScenarioId[]];

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
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional()
  }).strict()).optional(),
  rounds: z.number().int().positive().max(20).optional(),
  /** Seat count for this room; defaults to the scenario's default. */
  players: z.number().int().positive().max(12).optional(),
  /** Character picks for the front seats (built-in ids or custom character ids). */
  characterIds: z.array(z.string().min(1).max(120)).max(12).optional(),
  temperature: z.number().min(0).max(2).optional(),
  mode: z.enum(["ai", "human"]).default("ai"),
  playerName: z.string().trim().min(1).max(40).optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
  /** Explicit opt-in: persist the finished game as a local archive file. */
  archive: z.boolean().default(false)
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
    const profiles = context.models.listModelProfiles().filter((profile) => profile.enabled);
    const checks = profiles.map((profile) => effectiveProtocolCheck(
      profile,
      context.models.providerProfile(profile.providerProfileId)
    ));
    response.json({
      ok: true,
      rooms: context.rooms.list().length,
      models: {
        enabled: profiles.length,
        ready: profiles.filter((profile) => isModelProtocolReady(
          profile,
          context.models.providerProfile(profile.providerProfileId)
        )).length,
        failed: checks.filter((check) => check.status === "failed").length,
        stale: checks.filter((check) => check.status === "stale").length
      },
      storage: context.storage.snapshot()
    });
  });

  // ── Archives (opt-in persistence of finished games) ─────────────────────────
  //
  // Listing is metadata-only and open; opening one serves the full omniscient
  // room (minds included) to the archive's owner or the operator, and the
  // postgame public room to everyone else. The raw owner token is never
  // stored — only its sha256, compared in constant time.

  app.get("/api/archives", (_request, response) => {
    void listRoomArchives(context.storage)
      .then((archives) => response.json({ archives }))
      .catch(() => response.status(500).json({ error: "ARCHIVE_LIST_FAILED", message: "读取归档列表失败。" }));
  });

  app.get("/api/archives/:archiveId", (request, response) => {
    const archiveId = request.params.archiveId;
    void readRoomArchive(archiveId, context.storage)
      .then((archive) => {
        if (!archive) {
          response.status(404).json({ error: "ARCHIVE_NOT_FOUND", message: "归档不存在。" });
          return;
        }
        const token = tokenFromRequest(request);
        const privileged = context.auth.isOperatorToken(token) || isArchiveOwner(archive, token);
        response.json({
          viewer: { mode: "postgame" as SpectatorMode, privileged },
          room: privileged ? archive.room : archive.publicRoom,
          envelopes: privileged ? archive.envelopes : []
        });
      })
      .catch(() => response.status(500).json({ error: "ARCHIVE_READ_FAILED", message: "读取归档失败。" }));
  });

  app.delete("/api/archives/:archiveId", (request, response) => {
    const archiveId = request.params.archiveId;
    void readRoomArchive(archiveId, context.storage)
      .then(async (archive) => {
        if (!archive) {
          response.status(404).json({ error: "ARCHIVE_NOT_FOUND", message: "归档不存在。" });
          return;
        }
        const token = tokenFromRequest(request);
        if (!context.auth.isOperatorToken(token) && !isArchiveOwner(archive, token)) {
          response.status(403).json({ error: "ARCHIVE_DELETE_FORBIDDEN", message: "只有房主或操作员可以删除归档。" });
          return;
        }
        const removed = await deleteRoomArchive(archiveId);
        response.json({ removed, archiveId });
      })
      .catch(() => response.status(500).json({ error: "ARCHIVE_DELETE_FAILED", message: "删除归档失败。" }));
  });

  app.get("/api/scenarios", (_request, response) => {
    const profiles = context.models.listModelProfiles().filter((profile) =>
      isModelProtocolReady(profile, context.models.providerProfile(profile.providerProfileId))
    );
    const models = profiles.map((profile) => ({
          id: profile.modelId,
          profileId: profile.id,
          name: profile.name,
          provider: "OpenAI-compatible",
          context: profile.contextWindow,
          contextLabel: contextLabel(profile.contextWindow),
          capabilitySummary: summarizeCapabilities(profile)
        }));
    // The registry-configured random pool, filtered to protocol-ready profiles —
    // room creation's 随机混合 deals seats from it by default.
    const pool = context.models.globalDefaults().randomPoolProfileIds ?? [];
    const randomPoolProfileIds = pool.filter((id) => profiles.some((profile) => profile.id === id));
    response.json({ scenarios: ALL_SCENARIOS, models, randomPoolProfileIds });
  });

  app.get("/api/model-config", (_request, response) => {
    response.json(publicModelConfig(context));
  });

  // Live model catalog from the provider itself (GET {baseURL}/models) so the
  // settings UI can offer a pick list instead of hand-typed model ids.
  app.get("/api/model-config/providers/:providerId/remote-models", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    const provider = context.models.providerProfile(request.params.providerId);
    if (!provider) {
      response.status(404).json({ error: "PROVIDER_PROFILE_MISSING", message: "The requested provider does not exist." });
      return;
    }
    void fetchRemoteModels({ baseURL: provider.baseURL, apiKey: resolveKeyRef(provider.apiKeyRef) })
      .then((result) => response.status(result.ok ? 200 : 502).json(result))
      .catch(() => response.status(502).json({ ok: false, modelIds: [], message: "获取模型列表失败，请稍后重试。" }));
  });

  app.post("/api/model-config/probe", (request, response, next) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    const probeInput = z.object({
      modelProfileId: z.string().min(1).max(120),
      reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional()
    }).strict().safeParse(request.body ?? {});
    if (!probeInput.success) {
      response.status(400).json({ error: "MODEL_TEST_INPUT_INVALID", message: "模型测试参数无效。" });
      return;
    }
    const profile = context.models.modelProfile(probeInput.data.modelProfileId);
    if (!profile) {
      response.status(404).json({ error: "MODEL_PROFILE_MISSING", message: "The requested model profile does not exist." });
      return;
    }
    const provider = context.models.providerProfile(profile.providerProfileId);
    if (!provider) {
      response.status(400).json({ error: "PROVIDER_PROFILE_MISSING", message: "The profile's provider does not exist." });
      return;
    }
    void runModelProbe(context, profile.id, probeInput.data.reasoningEffort)
      .then((result) => response.json(result))
      .catch(next);
  });

  app.put("/api/model-config", (request, response, next) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    try {
      const input = modelConfigSchema.parse(request.body ?? {});
      // The random pool may reference profiles registered now or created by
      // this same update; anything else is a typo and is rejected outright.
      const pool = input.globalDefaults?.randomPoolProfileIds;
      if (pool) {
        const known = new Set([
          ...context.models.listModelProfiles().map((profile) => profile.id),
          ...(input.modelProfiles ?? []).map((profile) => profile.id)
        ]);
        const unknown = pool.filter((id) => !known.has(id));
        if (unknown.length) {
          response.status(400).json({
            error: "MODEL_PROFILE_MISSING",
            message: `The random pool references unregistered model profiles: ${unknown.join(", ")}.`
          });
          return;
        }
      }
      const state = applyModelConfig(context, input);
      response.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/rooms", (_request, response) => {
    response.json({ rooms: context.rooms.list(), archived: [] });
  });

  // Remove a room: stops it and frees memory.
  // Human rooms require the player's own token; AI rooms are observer-owned.
  app.delete("/api/rooms/:roomId", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    if (!requireRoomControl(request, response, room, context.auth)) return;
    const removed = context.rooms.remove(request.params.roomId);
    response.json({ removed: Boolean(removed), roomId: request.params.roomId, archived: [] });
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
        modelRegistry: context.models,
        limiter: context.limiter,
        ...(roomDefaults ? { roomDefaults } : {}),
        ...(agentBindings ? { agentBindings } : {}),
        // Opt-in persistence: the sink writes the finished game to disk once.
        // Default (archive=false) keeps the strict zero-disk runtime.
        ...(input.archive
          ? {
              archiveSink: (archive: SocietyRoomArchive) => {
                void writeRoomArchive(archive, context.storage).catch((cause) => {
                  console.error(`[archive ${archive.id}] write failed:`, cause instanceof Error ? cause.message : cause);
                });
              }
            }
          : {})
      });
      void room.start();
      const created = room.creationResult();
      setTokenCookie(response, created.ownerToken);
      response.status(202).json(created);
    } catch (error) {
      next(error);
    }
  });

  // Metrics carry ground truth (true roles, resolved beliefs) on top of the
  // compliance counters — an owner/operator surface, never a public one.
  app.get("/api/rooms/:roomId/metrics", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    if (!requireRoomControl(request, response, room, context.auth)) return;
    response.json(room.metrics());
  });

  // Model-vs-model standings over finished games (public end-of-game facts
  // only: winners and scores are revealed at finish).
  app.get("/api/leaderboard", (_request, response) => {
    response.json({ models: context.rooms.modelStandings() });
  });

  app.get("/api/rooms/:roomId", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    const authority = roomAuthorityFor(request, room);
    const token = tokenFromRequest(request);
    if (token && !authority.owner && !authority.participantActorId && !context.auth.isOperatorToken(token)) {
      response.status(401).json({ error: "PLAYER_TOKEN_INVALID", message: "The player token is invalid." });
      return;
    }
    if (token) setTokenCookie(response, token);
    const isOperator = context.auth.isOperatorToken(token);
    const viewer = resolveViewer(request, room, authority, isOperator);
    // The effective viewer rides along with every snapshot so the UI shows
    // the boundary actually granted — never the one requested and silently
    // downgraded.
    response.json({ ...room.snapshotForViewer(viewer), viewer: viewerDescription(viewer) });
  });

  app.post("/api/rooms/:roomId/pause", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    if (!requireRoomControl(request, response, room, context.auth)) return;
    room.pause();
    response.json(room.snapshotFor());
  });

  app.post("/api/rooms/:roomId/resume", (request, response) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    if (!requireRoomControl(request, response, room, context.auth)) return;
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
    if (!requireRoomControl(request, response, room, context.auth)) return;
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
    if (!requireRoomControl(request, response, room, context.auth)) return;
    room.resumeAgent(request.params.actorId);
    response.json(room.snapshotFor());
  });

  // Model switch: swap one agent's model while paused; identity,
  // session and memory survive. The room must be paused (or just that agent).
  app.post("/api/rooms/:roomId/agents/:actorId/model", (request, response, next) => {
    const room = context.rooms.get(request.params.roomId);
    if (!room) {
      response.status(404).json({ error: "ROOM_NOT_FOUND", message: "The requested room does not exist in this process." });
      return;
    }
    if (!requireRoomControl(request, response, room, context.auth)) return;
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
    const token = tokenFromRequest(request);
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
    const token = tokenFromRequest(request);
    const authority = roomAuthorityFor(request, room);
    if (token && !authority.owner && !authority.participantActorId && !context.auth.isOperatorToken(token)) {
      response.status(401).json({ error: "PLAYER_TOKEN_INVALID", message: "The player token is invalid." });
      return;
    }
    if (token) setTokenCookie(response, token);
    const viewer = resolveViewer(request, room, authority, context.auth.isOperatorToken(token));
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    const untrackConnection = context.liveConnections.track(response);

    // SSE cursor recovery: a (re)connecting client resumes
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
      writeEvent(response, "snapshot", {
        ...room.snapshotForViewer(viewer),
        viewer: viewerDescription(viewer)
      });
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
      untrackConnection();
    });
  });
}

const modelConfigSchema = z.object({
  globalDefaults: z.object({
    modelProfileId: z.string().min(1).max(120).optional(),
    contextPolicyId: z.string().min(1).max(120).optional(),
    /** Default random-assignment pool: model-profile ids, validated on apply. */
    randomPoolProfileIds: z.array(z.string().min(1).max(120)).max(16).optional()
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
    defaults: z.object({
      reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional()
    }).strict().optional(),
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
    protocolCheck: effectiveProtocolCheck(profile, context.models.providerProfile(profile.providerProfileId)),
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
        ? {
            ...existing,
            ...update,
            defaults: update.defaults
              ? mergeReasoningDefaults(existing.defaults, update.defaults)
              : existing.defaults
          }
        : {
            id: update.id,
            name: update.name,
            providerProfileId: update.providerProfileId,
            modelId: update.modelId,
            contextWindow: update.contextWindow,
            contextWindowSource: "manual",
            capabilities: defaultCapabilities(),
            defaults: update.defaults
              ? mergeReasoningDefaults({ reasoningEffort: "high" }, update.defaults)
              : { reasoningEffort: "high" },
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
  if (input.globalDefaults) {
    const requestedDefault = input.globalDefaults.modelProfileId;
    if (requestedDefault) assertReadyModelProfile(context, requestedDefault);
    const readyPool = input.globalDefaults.randomPoolProfileIds?.filter((id) => {
      const profile = context.models.modelProfile(id);
      return Boolean(profile && isModelProtocolReady(profile, context.models.providerProfile(profile.providerProfileId)));
    });
    context.models.setGlobalDefaults({
      ...input.globalDefaults,
      ...(readyPool ? { randomPoolProfileIds: readyPool } : {})
    });
  }
  persistRegistry(context.models, context.modelRegistryFile, context.storage);
  return publicModelConfig(context);
}

function mergeReasoningDefaults(
  current: ModelProfile["defaults"],
  update: { reasoningEffort?: "low" | "medium" | "high" | "xhigh" }
): ModelProfile["defaults"] {
  const next = { ...current };
  if (update.reasoningEffort) next.reasoningEffort = update.reasoningEffort;
  else delete next.reasoningEffort;
  return next;
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
  const profileIds = input.modelProfileIds ?? Object.values(input.agentModelOverrides ?? {});
  if (profileIds && profileIds.length) {
    const ids = profileIds
      .map((id) => {
        const profile = context.models.modelProfile(id);
        return profile && isModelProtocolReady(profile, context.models.providerProfile(profile.providerProfileId))
          ? profile.modelId
          : undefined;
      })
      .filter((id): id is string => Boolean(id));
    if (ids.length) return ids;
  }
  const profiles = context.models.listModelProfiles().filter((profile) =>
    isModelProtocolReady(profile, context.models.providerProfile(profile.providerProfileId))
  );
  if (profiles.length) {
    const ids = profiles.map((profile) => profile.modelId);
    return Array.from({ length: seatCount }, (_, index) => ids[index % ids.length]);
  }
  if (input.models?.length) {
    const readyIds = new Set(profiles.map((profile) => profile.modelId));
    const selected = input.models.filter((id) => readyIds.has(id));
    if (selected.length) return selected;
  }
  throw new Error("MODEL_PROTOCOL_NOT_READY: 请先在模型设置中启用模型并通过 Agents SDK 协议检查。");
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
      assertReadyModelProfile(context, input.modelProfileIds![index % input.modelProfileIds!.length]);
      bindings[profile.id] = {
        defaultModelProfileId: input.modelProfileIds![index % input.modelProfileIds!.length]
      };
    });
  }
  if (input.agentModelOverrides) {
    profiles.forEach((profile, index) => {
      const override = input.agentModelOverrides![String(index)];
      if (!override) return;
      assertReadyModelProfile(context, override);
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
  if (roomModelProfileId) {
    assertReadyModelProfile(context, roomModelProfileId);
    defaults.modelProfileId = roomModelProfileId;
  }
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

function assertReadyModelProfile(context: ServerContext, id: string): ModelProfile {
  const profile = context.models.modelProfile(id);
  if (!profile) throw new Error(`MODEL_PROFILE_MISSING: '${id}' is not a registered model profile.`);
  if (!isModelProtocolReady(profile, context.models.providerProfile(profile.providerProfileId))) {
    throw new Error(`MODEL_PROTOCOL_NOT_READY: '${profile.name}' 尚未通过当前配置的 Agents SDK 协议检查。`);
  }
  return profile;
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
 * and team-channel messages.
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
