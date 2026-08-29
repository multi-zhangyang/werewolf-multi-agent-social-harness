import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { OpenAIProvider, type OpenAIProvider as OpenAIProviderType } from "@openai/agents";
import OpenAI from "openai";
import type {
  AgentMindState,
  AgentProfile,
  AgentRuntimeEvent,
  AgentStatus,
  AgentTurnResult,
  DecisionBias,
  ParticipantController,
  PlayerActionSpec,
  RoomStatus,
  ScenarioId,
  SocialMessage,
  SocialWorld,
  WorldActionCommit,
  WorldActivation,
  WorldSnapshot
} from "./contracts";
import type { SpectatorViewer } from "./spectator/projection";
import { apiKeyFromEnv, baseUrlFromEnv, createSocietyAgent, type AutonomousSocietyAgent } from "./participant";
import { createWorld } from "./scenarios";
import {
  ModelRegistry,
  resolveAgentModelConfig,
  seedRegistryFromEnv,
  type AgentModelBinding,
  type ModelProfile,
  type ProviderProfile,
  type RegistryGlobalDefaults,
  type ResolvedModelConfig
} from "./models";
import { reasoningFallbackFetch, type ReasoningFallbackNotice } from "./models/reasoning-fallback";
import { buildExtractionRequest, parseExtractedDeclarations, type ExtractionRosterEntry } from "./social/message-extractor";
import { extractText } from "./context-manager";
import { EnvelopeWindow, type EnvelopeWindowBudget } from "./envelope-window";
import { CinematicDirector } from "./spectator/cinematic-director";
import { ActivationLimiter } from "./activation-limiter";

/**
 * Rolling event windows: both buffers are capped by count AND bytes —
 * `world.*-frame` envelopes embed full snapshots, so a count-only cap lets a
 * single room's buffers grow unbounded. Budgets are env-overridable.
 */
const EVENT_WINDOW_BUDGET: EnvelopeWindowBudget = {
  maxCount: 500,
  maxBytes: positiveIntegerFromEnv("SOCIETY_EVENT_BUDGET_BYTES", 4 * 1024 * 1024),
  minKeep: 20
};
const REPLAY_WINDOW_BUDGET: EnvelopeWindowBudget = {
  maxCount: 5_000,
  maxBytes: positiveIntegerFromEnv("SOCIETY_REPLAY_BUDGET_BYTES", 8 * 1024 * 1024),
  minKeep: 100
};

export interface SocietyRoomCreateOptions {
  id?: string;
  scenarioId: ScenarioId;
  profiles: AgentProfile[];
  rounds?: number;
  provider?: OpenAIProviderType;
  apiKey?: string;
  baseURL?: string;
  /** Provider/model/context-policy registry used to resolve each agent's model. */
  modelRegistry?: ModelRegistry;
  /** Room-wide model defaults (统一模型 / 推理强度), below agent overrides. */
  roomDefaults?: { modelProfileId?: string; tuning?: Record<string, unknown>; contextPolicyId?: string };
  /** Per-agent model bindings, keyed by profile id. */
  agentBindings?: Record<string, AgentModelBinding>;
  /**
   * Process-wide provider backpressure: every agent turn acquires a permit
   * from this shared pool before calling the model, so multiple rooms never
   * fan out more concurrent activations than the deployment can bear.
   */
  limiter?: ActivationLimiter;
  /**
   * Explicit opt-in archive sink. When provided, the room hands its finished
   * state to this callback exactly once — the server wires it to a disk
   * write. The runtime core stays fs-free: without a sink, nothing is ever
   * persisted (zero-disk default).
   */
  archiveSink?: (archive: SocietyRoomArchive) => void;
}

/**
 * One finished game as plain data — produced by the room at finish time and
 * consumed by the server's opt-in archive writer. `ownerTokenHash` is
 * sha256(owner token) so the archive can authenticate its owner without
 * storing the raw secret.
 */
export interface SocietyRoomArchive {
  schemaVersion: 1;
  id: string;
  scenarioId: ScenarioId;
  title: string;
  createdAt: string;
  finishedAt: string;
  ownerTokenHash: string;
  /** The full observer seat: revealed world, private minds, complete causality. */
  room: SocietyRoomSnapshot;
  /** The postgame public seat: revealed world, no private minds. */
  publicRoom: SocietyRoomSnapshot;
  /** Presentation envelopes for a static client-side replay (no token streams, no snapshot payloads). */
  envelopes: SocietyRoomEventEnvelope[];
}

/** sha256 hex of a room owner token — archive ownership check without storing the secret. */
export function archiveOwnerTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Token streams and full snapshots never enter an archive file. */
const ARCHIVE_EVENT_BLOCKLIST: ReadonlySet<string> = new Set(["agent.delta", "agent.reasoning-content", "world.updated"]);

export interface SocietyRoomEventEnvelope {
  /** Stable, unique event id (replay / dedupe). */
  id: string;
  /** Monotonic room sequence. */
  seq: number;
  event: AgentRuntimeEvent;
}

export interface SocietyParticipantProfile {
  id: string;
  displayName: string;
  /** The stable character behind this seat. */
  characterId: string;
  model: string;
  controller: ParticipantController;
  /**
   * Character-definition data (the person, not the in-game role): persona,
   * stable judgment biases, speech voice and formative memories. Public by
   * design — this is who the character is, never what they privately know or
   * believe inside this game.
   */
  persona?: string;
  decisionBiases?: DecisionBias[];
  voice?: string;
  autobiographicalAnchors?: string[];
}

export interface SocietyParticipantCard {
  profile: SocietyParticipantProfile;
  status: AgentStatus;
  alive: boolean;
  score?: number;
  role?: string;
  /** Public-facing emotional state from the agent's latest inner update. */
  mood?: string;
  energy?: number;
  /** Latest private mind snapshot, useful for observer/debugging UIs. */
  mind?: AgentMindState;
  /** True while this single agent is paused (it stops being activated). */
  paused?: boolean;
}

export interface SocietyPlayerState {
  actorId: string;
  displayName: string;
  waiting: boolean;
  activationLabel?: string;
  actions: PlayerActionSpec[];
}

export interface HighlightSummary {
  id: string;
  at: string;
  title: string;
  subtitle?: string;
  camera: string;
  priority: number;
  focusAgentIds: string[];
}

export interface SocietyRoomSnapshot {
  id: string;
  scenarioId: ScenarioId;
  title: string;
  mode: "human" | "ai";
  status: RoomStatus;
  createdAt: string;
  updatedAt: string;
  world: WorldSnapshot;
  participants: SocietyParticipantCard[];
  player?: SocietyPlayerState;
  /** Endgame highlights derived from high-priority cinematic cues. */
  highlights?: HighlightSummary[];
  error?: string;
}

export interface SocietyRoomCreateResult {
  room: SocietyRoomSnapshot;
  /** Control token for this room: pause/resume/remove/model switches. */
  ownerToken: string;
  playerActorId?: string;
  playerToken?: string;
}

type RoomListener = (event: SocietyRoomEventEnvelope) => void;

interface RuntimeCard {
  profile: AgentProfile;
  status: AgentStatus;
  turnCount: number;
  totalTokens: number;
  /** Public-facing summary of the agent's last inner update. */
  moodLabel?: string;
  energy?: number;
  lastOutput?: string;
  mind?: AgentMindState;
}

interface HumanWaiter {
  activationId: string;
  activationLabel: string;
  actorId: string;
  acceptedActions: Set<string>;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class SocietyRoom {
  readonly id: string;
  readonly scenarioId: ScenarioId;
  readonly createdAt: string;
  readonly humanActorId?: string;

  private readonly world: SocialWorld;
  private readonly cards = new Map<string, RuntimeCard>();
  private readonly agents = new Map<string, AutonomousSocietyAgent>();
  private readonly events = new EnvelopeWindow<SocietyRoomEventEnvelope>(EVENT_WINDOW_BUDGET, envelopeByteSize);
  private readonly replayEvents = new EnvelopeWindow<SocietyRoomEventEnvelope>(REPLAY_WINDOW_BUDGET, envelopeByteSize);
  private readonly listeners = new Set<RoomListener>();
  private abortController = new AbortController();
  private readonly provider?: OpenAIProviderType;
  private readonly apiKey?: string;
  private readonly baseURL?: string;
  private readonly modelRegistry: ModelRegistry;
  private readonly roomDefaults?: SocietyRoomCreateOptions["roomDefaults"];
  private readonly agentBindings: Record<string, AgentModelBinding>;
  /** Shared stateless provider clients, keyed by provider profile id. */
  private readonly providerClients = new Map<string, OpenAIProvider>();
  /** Sidecar extraction runs strictly one-at-a-time, off the send path. */
  private actExtractionChain: Promise<void> = Promise.resolve();
  /** Last reconciliation logical time surfaced as a display note per actor. */
  private readonly notedReconciliationSeq = new Map<string, number>();
  private extractionFailures = 0;
  private readonly extractionProviders = new Map<string, OpenAIProviderType>();
  /** Process-wide activation pool; absent in embedded single-room use. */
  private readonly limiter?: ActivationLimiter;
  /** Opt-in archive sink; absent means the game leaves no trace on disk. */
  private readonly archiveSink?: (archive: SocietyRoomArchive) => void;
  private readonly pausedAgents = new Set<string>();
  /** Per-agent abort controllers for turns that are running right now. */
  private readonly activeSignals = new Map<string, AbortController>();
  private readonly turnTimeoutMs: number;
  /** Extra wall-clock grace for providers that swallow the abort signal. */
  private readonly turnGraceMs: number;
  private readonly humanTurnTimeoutMs: number;
  private readonly humanToken?: string;
  /** Control token for this room (owner); returned once at creation. */
  private readonly ownerToken: string;
  /** Turns the room gave up on locally while the request kept running. */
  private abandonedRunningTurns = 0;
  /** Of those, how many have since truly settled (or were terminated). */
  private settledAbandonedTurns = 0;
  /** In-memory counters, exposed via /api/rooms/:id/metrics. */
  private completedActivations = 0;
  private retriedActivations = 0;
  /** Successful turn wall-clock durations in ms (provider p50/p95 source, capped). */
  private readonly providerTurnDurationsMs: number[] = [];
  private runningPromise?: Promise<void>;
  private waitingHuman?: HumanWaiter;
  private humanActionInFlight = false;
  private status: RoomStatus = "lobby";
  private updatedAt: string;
  private error?: string;
  /** Presentation-only spectator director: reads events, emits cues/tension. */
  private readonly director: CinematicDirector;
  /** Endgame highlights derived from high-priority cues (presentation-only). */
  private readonly highlights: HighlightSummary[] = [];

  constructor(options: SocietyRoomCreateOptions) {
    this.id = options.id ?? `room_${randomUUID()}`;
    this.scenarioId = options.scenarioId;
    this.createdAt = now();
    this.updatedAt = this.createdAt;
    this.provider = options.provider;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.modelRegistry = options.modelRegistry ?? fallbackRegistryFromEnv();
    this.roomDefaults = options.roomDefaults;
    this.agentBindings = options.agentBindings ?? {};
    this.limiter = options.limiter;
    this.archiveSink = options.archiveSink;
    this.director = new CinematicDirector({
      roomId: this.id,
      emit: (event) => this.emit(event)
    });
    this.turnTimeoutMs = positiveIntegerFromEnv("SOCIETY_AGENT_TURN_TIMEOUT_MS", 300_000);
    this.turnGraceMs = positiveIntegerFromEnv("SOCIETY_AGENT_TURN_GRACE_MS", 15_000);
    this.humanTurnTimeoutMs = positiveIntegerFromEnv("SOCIETY_HUMAN_TURN_TIMEOUT_MS", 1_800_000);
    const humans = options.profiles.filter((profile) => profile.controller === "human");
    if (humans.length > 1) throw new Error("HUMAN_LIMIT_EXCEEDED: A room supports at most one human participant.");
    this.humanActorId = humans[0]?.id;
    this.humanToken = this.humanActorId ? randomBytes(32).toString("base64url") : undefined;
    this.ownerToken = randomBytes(32).toString("base64url");
    this.world = createWorld({
      roomId: this.id,
      scenarioId: options.scenarioId,
      profiles: options.profiles,
      rounds: options.rounds
    });
    this.world.onUpdate((snapshot) => this.onWorldUpdate(snapshot));
    // Message sidecar: structured social acts are extracted off-thread from
    // every discussion message so the causality page reflects what was
    // actually said, not only self-reported cognition. Skipped for injected
    // (scripted) providers — their finite response queues exist to drive
    // agent turns, and a sidecar call would consume them.
    if (!options.provider) {
      this.world.socialActExtractor = (message) => {
        this.queueActExtraction(message);
        return Promise.resolve();
      };
    }
    for (const profile of options.profiles) {
      this.cards.set(profile.id, {
        profile: structuredClone({ ...profile, controller: profile.controller ?? "agent" }),
        status: "lobby",
        turnCount: 0,
        totalTokens: 0
      });
    }
    this.onWorldUpdate(this.world.snapshotFor());
  }

  creationResult(): SocietyRoomCreateResult {
    return {
      room: this.snapshotFor(this.humanActorId),
      ownerToken: this.ownerToken,
      ...(this.humanActorId && this.humanToken
        ? { playerActorId: this.humanActorId, playerToken: this.humanToken }
        : {})
    };
  }

  /** Constant-time check for the room's control token (owner). */
  isOwnerToken(token: string): boolean {
    if (!token) return false;
    const expected = Buffer.from(this.ownerToken);
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /**
   * The finished game as plain data. The owner seat gets the omniscient room
   * (minds included); everyone else gets the postgame public room. Envelopes
   * exclude token streams and snapshot payloads — the client reducer rebuilds
   * the presentation layer from what remains.
   */
  buildArchive(): SocietyRoomArchive {
    return {
      schemaVersion: 1,
      id: this.id,
      scenarioId: this.scenarioId,
      title: this.world.snapshot().title,
      createdAt: this.createdAt,
      finishedAt: this.updatedAt,
      ownerTokenHash: archiveOwnerTokenHash(this.ownerToken),
      room: this.snapshotForViewer({ mode: "omniscient" }),
      publicRoom: this.snapshotForViewer({ mode: "postgame", privileged: false }),
      envelopes: this.events.toArray()
        .filter((envelope) => !ARCHIVE_EVENT_BLOCKLIST.has(envelope.event.type))
    };
  }

  snapshotFor(actorId?: string): SocietyRoomSnapshot {
    if (actorId && actorId !== this.humanActorId) {
      throw new Error("PLAYER_SCOPE_INVALID: This actor does not own the human seat.");
    }
    const world = this.world.snapshotFor(actorId);
    const waiting = Boolean(actorId && this.waitingHuman?.actorId === actorId);
    return {
      id: this.id,
      scenarioId: this.scenarioId,
      title: world.title,
      mode: this.humanActorId ? "human" : "ai",
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      world,
      participants: this.participantCards(world, actorId === undefined),
      ...(actorId
        ? {
            player: {
              actorId,
              displayName: this.cards.get(actorId)?.profile.displayName ?? actorId,
              waiting,
              ...(waitingHumanLabel(this.waitingHuman, actorId) ? { activationLabel: waitingHumanLabel(this.waitingHuman, actorId) } : {}),
              actions: waiting ? this.world.playerActions(actorId) : []
            }
          }
        : {}),
      ...(this.highlights.length ? { highlights: this.highlights.map((highlight) => structuredClone(highlight)) } : {}),
      ...(this.error ? { error: this.error } : {})
    };
  }

  /**
   * Spectator-mode projection. The server enforces each mode's information
   * boundary before anything crosses the wire:
   *
   *  - public: no minds, public-channel messages only, living roles hidden;
   *  - omniscient: the full observer seat (private minds included);
   *  - agent-pov: the watched agent's scoped world view, no minds;
   *  - postgame: the world is fully revealed after the game ends, but
   *    private minds stay behind owner/operator permission.
   */
  snapshotForViewer(viewer: SpectatorViewer): SocietyRoomSnapshot {
    const mode = viewer.mode;
    const world = this.world.snapshotFor(mode === "agent-pov" ? viewer.agentId : undefined);

    if (mode === "public") {
      const publicWorld = structuredClone(world);
      publicWorld.messages = publicWorld.messages.filter((message) => message.channel === "public");
      return {
        id: this.id,
        scenarioId: this.scenarioId,
        title: publicWorld.title,
        mode: this.humanActorId ? "human" : "ai",
        status: this.status,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        world: publicWorld,
        participants: this.participantCards(publicWorld, false),
        // Highlights derive from public-facts-only cues, so the endgame reveal
        // may show them to the public seat too — but only once the game ends.
        ...(this.status === "finished" && this.highlights.length
          ? { highlights: this.highlights.map((highlight) => structuredClone(highlight)) }
          : {}),
        ...(this.error ? { error: this.error } : {})
      };
    }

    if (mode === "postgame") {
      const reveal = structuredClone(world);
      if (this.status === "finished") {
        const internal = this.world.snapshot();
        const roles = new Map(internal.agents.map((agent) => [agent.id, agent.observerRole]));
        reveal.agents = reveal.agents.map((agent) => ({
          ...agent,
          ...(roles.get(agent.id) ? { observerRole: roles.get(agent.id) } : {})
        }));
      }
      return {
        id: this.id,
        scenarioId: this.scenarioId,
        title: reveal.title,
        mode: this.humanActorId ? "human" : "ai",
        status: this.status,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        world: reveal,
        participants: this.participantCards(reveal, false),
        ...(this.highlights.length ? { highlights: this.highlights.map((highlight) => structuredClone(highlight)) } : {}),
        ...(this.error ? { error: this.error } : {})
      };
    }

    if (mode === "agent-pov") {
      const target = viewer.agentId ?? this.humanActorId;
      const povWorld = target ? this.world.snapshotFor(target) : world;
      const waiting = Boolean(target && target === this.humanActorId && this.waitingHuman?.actorId === target);
      return {
        id: this.id,
        scenarioId: this.scenarioId,
        title: povWorld.title,
        mode: this.humanActorId ? "human" : "ai",
        status: this.status,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        world: povWorld,
        participants: this.participantCards(povWorld, false),
        ...(target && target === this.humanActorId
          ? {
              player: {
                actorId: target,
                displayName: this.cards.get(target)?.profile.displayName ?? target,
                waiting,
                ...(waitingHumanLabel(this.waitingHuman, target) ? { activationLabel: waitingHumanLabel(this.waitingHuman, target) } : {}),
                actions: waiting ? this.world.playerActions(target) : []
              }
            }
          : {}),
        ...(this.error ? { error: this.error } : {})
      };
    }

    // omniscient: the full observer seat. Living hidden roles ARE revealed
    // (全知第三视角: 显示角色), unlike the public seat — so the observer
    // gets the same role map the internal world holds, overlaid onto the
    // scoped (channel-filtered) world view.
    if (mode === "omniscient") {
      const reveal = structuredClone(world);
      const internal = this.world.snapshot();
      const roles = new Map(internal.agents.map((agent) => [agent.id, agent.observerRole]));
      reveal.agents = reveal.agents.map((agent) => ({
        ...agent,
        ...(roles.get(agent.id) ? { observerRole: roles.get(agent.id) } : {})
      }));
      reveal.details = {
        ...reveal.details,
        socialCausality: this.world.socialCausalityFor(undefined, true)
      };
      return {
        id: this.id,
        scenarioId: this.scenarioId,
        title: reveal.title,
        mode: this.humanActorId ? "human" : "ai",
        status: this.status,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        world: reveal,
        participants: this.participantCards(reveal, true),
        ...(this.highlights.length ? { highlights: this.highlights.map((highlight) => structuredClone(highlight)) } : {}),
        ...(this.error ? { error: this.error } : {})
      };
    }

    // Fallback (should not be reached): omniscient default.
    return this.snapshotFor();
  }

  private participantCards(world: WorldSnapshot, includeMinds: boolean): SocietyParticipantCard[] {
    return [...this.cards.values()].map((card) => {
      const state = world.agents.find((agent) => agent.id === card.profile.id);
      return {
        profile: {
          id: card.profile.id,
          displayName: card.profile.displayName,
          characterId: card.profile.characterId,
          model: card.profile.model,
          controller: card.profile.controller ?? "agent",
          persona: card.profile.persona,
          decisionBiases: card.profile.decisionBiases,
          voice: card.profile.voice,
          autobiographicalAnchors: card.profile.autobiographicalAnchors
        },
        status: card.status,
        alive: state?.alive ?? true,
        paused: this.pausedAgents.has(card.profile.id),
        ...(state?.score === undefined ? {} : { score: state.score }),
        ...(state?.observerRole ? { role: state.observerRole } : {}),
        ...(card.moodLabel ? { mood: card.moodLabel, energy: card.energy } : {}),
        ...(includeMinds && card.mind ? { mind: structuredClone(card.mind) } : {})
      };
    });
  }

  actorForToken(token: string | undefined): string | undefined {
    if (!token || !this.humanToken || !this.humanActorId) return undefined;
    const supplied = Buffer.from(token);
    const expected = Buffer.from(this.humanToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
    return this.humanActorId;
  }

  eventsSince(seq = 0): SocietyRoomEventEnvelope[] {
    return this.events.toArray().filter((entry) => entry.seq > seq).map((entry) => structuredClone(entry));
  }

  subscribe(listener: RoomListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = this.run().catch((error) => {
      if (this.status !== "paused") this.fail(error);
    });
    return this.runningPromise;
  }

  pause(reason = "房间已暂停"): void {
    if (this.status !== "running") return;
    this.status = "paused";
    const pauseError = new Error(reason);
    if (!this.abortController.signal.aborted) this.abortController.abort(pauseError);
    if (this.waitingHuman) {
      clearTimeout(this.waitingHuman.timer);
      const waiter = this.waitingHuman;
      this.waitingHuman = undefined;
      waiter.reject(pauseError);
    }
    this.world.pause();
    // Close the command gate so requests the room gave up on cannot mutate
    // a later phase after a pause.
    this.world.endActivation();
    this.emit({ type: "room.status", roomId: this.id, status: "paused", detail: reason, at: now() });
  }

  /**
   * Pause a room that is not yet "running" (agent construction stage), where
   * `pause()` would no-op on its status guard. The room stays paused and
   * recoverable; an observer can fix the configuration and resume.
   */
  private failToPause(reason: string): void {
    this.status = "paused";
    if (!this.abortController.signal.aborted) this.abortController.abort(new Error(reason));
    this.world.pause();
    this.world.endActivation();
    this.emit({ type: "room.status", roomId: this.id, status: "paused", detail: reason, at: now() });
  }

  /**
   * Resume a room-level pause (timeouts, repeated binding failures, observer
   * pause). The scheduler re-enters the same activation with fresh signals —
   * committed actions are idempotent, missing ones are retried, and the room
   * never substitutes a decision for any participant.
   */
  resume(): void {
    if (this.status !== "paused") return;
    this.abortController = new AbortController();
    this.status = "running";
    this.world.start();
    this.emit({ type: "room.status", roomId: this.id, status: "running", detail: "房间已恢复", at: now() });
    this.runningPromise = this.run().catch((error) => {
      if (this.status !== "paused") this.fail(error);
    });
  }

  /**
   * Stop and release a room: abort all in-flight work and detach the
   * director. Nothing is persisted — the room dies with the process.
   */
  dispose(reason = "房间已被移除"): void {
    if (this.status === "running") {
      this.status = "paused";
      if (!this.abortController.signal.aborted) this.abortController.abort(new Error(reason));
      if (this.waitingHuman) {
        clearTimeout(this.waitingHuman.timer);
        const waiter = this.waitingHuman;
        this.waitingHuman = undefined;
        waiter.reject(new Error(reason));
      }
      this.world.pause();
    }
    // Late in-flight requests must not mutate the world after removal.
    this.world.endActivation();
    this.director.dispose();
    this.emit({ type: "room.status", roomId: this.id, status: this.status, detail: reason, at: now() });
  }

  /** Pause one agent without sinking the room: its running turn is interrupted
   *  and it stops being activated until resumed. */
  pauseAgent(actorId: string, reason = "已由观察者暂停"): void {
    const card = this.cards.get(actorId);
    if (!card) throw new Error(`PARTICIPANT_NOT_FOUND: '${actorId}' is not in the room.`);
    if (this.pausedAgents.has(actorId)) return;
    this.pausedAgents.add(actorId);
    card.status = "paused";
    this.world.setAgentStatus(actorId, "paused");
    // Interrupt a turn that is already streaming so the pause takes effect now.
    this.activeSignals.get(actorId)?.abort(new Error("AGENT_PAUSED"));
    this.emit({ type: "agent.paused", roomId: this.id, actorId, reason, at: now() });
  }

  /** Resume a paused agent; the room activates it again from the next phase. */
  resumeAgent(actorId: string): void {
    if (!this.pausedAgents.has(actorId)) return;
    this.pausedAgents.delete(actorId);
    const card = this.cards.get(actorId);
    if (card) {
      card.status = "idle";
      this.world.setAgentStatus(actorId, "idle");
    }
    this.emit({ type: "agent.resumed", roomId: this.id, actorId, at: now() });
  }

  isAgentPaused(actorId: string): boolean {
    return this.pausedAgents.has(actorId);
  }

  /**
   * Model switch: swaps one agent's model binding while the room (or
   * that agent) is paused. Identity, session, memory and world role are kept;
   * the new binding is resolved through the registry, the context budget is
   * recomputed, and a history compaction runs first when the new window is
   * smaller. Old/new models are recorded and the switch is broadcast.
   */
  async switchAgentModel(actorId: string, modelProfileId: string): Promise<{ previousModel: string; model: string }> {
    const runtime = this.agents.get(actorId);
    const card = this.cards.get(actorId);
    if (!runtime || !card) throw new Error(`PARTICIPANT_NOT_FOUND: '${actorId}' is not an AI participant in this room.`);
    if (this.status !== "paused" && !this.pausedAgents.has(actorId)) {
      throw new Error("ROOM_NOT_PAUSED: Pause the room (or this participant) before switching its model.");
    }
    const modelProfile = this.modelRegistry.modelProfile(modelProfileId);
    if (!modelProfile || modelProfile.enabled === false) {
      throw new Error(`MODEL_PROFILE_MISSING: '${modelProfileId}' is not an enabled model profile.`);
    }
    const binding: AgentModelBinding = {
      ...(this.agentBindings[actorId] ?? {}),
      defaultModelProfileId: modelProfileId
    };
    const config = resolveAgentModelConfig({
      agentId: actorId,
      binding,
      roomDefaults: this.roomDefaults,
      globalDefaults: this.modelRegistry.globalDefaults(),
      forcedCapabilities: explicitlyRequestedCapabilities(binding, this.roomDefaults, this.modelRegistry.globalDefaults()),
      lookup: {
        modelProfile: (id) => this.modelRegistry.modelProfile(id),
        providerProfile: (id) => this.modelRegistry.providerProfile(id),
        contextPolicy: (id) => this.modelRegistry.contextPolicy(id),
        firstModelProfile: () => this.modelRegistry.listModelProfiles().find((profile) => profile.enabled)
      }
    });
    const previousModel = card.profile.model;
    const provider = this.providerClientFor(config.providerProfileId);
    await runtime.switchModel({ provider, resolvedConfig: config });
    this.agentBindings[actorId] = binding;
    card.profile.model = config.modelId;
    return { previousModel, model: config.modelId };
  }

  currentStatus(): RoomStatus {
    return this.status;
  }

  /** In-memory metrics for the smoke gate (zero-disk, docs/agent-design.md). */
  metrics(): Record<string, unknown> {
    const projection = this.world.socialCausalityFor(undefined, true);
    const counts = <K extends string>(keys: K[]): Record<string, number> => {
      const result: Record<string, number> = {};
      for (const key of keys) result[key] = (result[key] ?? 0) + 1;
      return result;
    };
    const notices = this.replayEvents.toArray()
      .filter((entry) => entry.event.type === "runtime.notice")
      .map((entry) => (entry.event as Extract<AgentRuntimeEvent, { type: "runtime.notice" }>).code);
    const pressures = this.replayEvents.toArray()
      .filter((entry) => entry.event.type === "agent.context.pressure")
      .map((entry) => entry.event as Extract<AgentRuntimeEvent, { type: "agent.context.pressure" }>);
    const tools = this.replayEvents.toArray()
      .filter((entry) => entry.event.type === "agent.tool")
      .map((entry) => entry.event as Extract<AgentRuntimeEvent, { type: "agent.tool" }>);
    const durations = [...this.providerTurnDurationsMs].sort((a, b) => a - b);
    const pct = (ratio: number): number | undefined =>
      durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * ratio))] : undefined;
    const worldStats = this.world.runtimeStats();
    return {
      roomId: this.id,
      scenarioId: this.scenarioId,
      status: this.status,
      turns: `${this.world.snapshot().turn}/${this.world.snapshot().totalTurns}`,
      compliance: {
        toolStarted: tools.filter((tool) => tool.phase === "started").length,
        toolSucceeded: tools.filter((tool) => tool.phase === "succeeded").length,
        toolFailed: tools.filter((tool) => tool.phase === "failed").length,
        worldActions: this.replayEvents.toArray().filter((entry) => entry.event.type === "world.action").length,
        idempotencyHits: worldStats.idempotencyHits,
        staleCommandRejections: worldStats.staleCommandRejections,
        invalidActionRejections: worldStats.invalidActionRejections,
        completedActivations: this.completedActivations,
        retriedActivations: this.retriedActivations,
        abandonedTurns: this.abandonedRunningTurns,
        settledAbandonedTurns: this.settledAbandonedTurns,
        noticeCodes: counts(notices)
      },
      pressure: {
        byLevel: counts(pressures.map((event) => event.level)),
        peak: pressures.reduce((max, event) => Math.max(max, event.pressureRatio), 0)
      },
      providerLatencyMs: { samples: durations.length, p50: pct(0.5), p95: pct(0.95) },
      commitments: {
        total: projection.commitments.length,
        states: counts(projection.commitments.map((entry) => entry.state))
      },
      extraction: {
        byMethod: counts(projection.socialActs.map((act) => act.extractionMethod)),
        extractionFailures: this.extractionFailures
      },
      // Agent-quality signals (ground truth included — owner/operator only).
      quality: this.world.qualityMetrics()
    };
  }

  /**
   * Abandoned-but-running: turns the room gave up on locally (timeout or
   * abort) whose provider request is still in flight. Each such request
   * keeps its permit until it truly settles, so the real concurrency never
   * exceeded the pool even when providers ignore aborts.
   */
  abandonedInFlight(): number {
    return this.abandonedRunningTurns;
  }

  /** Abandoned requests that have since truly settled (permit released). */
  settledAbandoned(): number {
    return this.settledAbandonedTurns;
  }

  async submitHumanAction(token: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    const actorId = this.actorForToken(token);
    if (!actorId) throw new Error("PLAYER_TOKEN_INVALID: This token does not control a seat in the room.");
    if (this.status !== "running") throw new Error("ROOM_NOT_RUNNING: The room is not accepting actions.");
    const waiter = this.waitingHuman;
    if (!waiter || waiter.actorId !== actorId) throw new Error("PLAYER_NOT_ACTIVE: Wait until the room asks for your action.");
    if (this.humanActionInFlight) throw new Error("ACTION_IN_PROGRESS: Your previous action is still being committed.");
    this.humanActionInFlight = true;
    this.world.setAgentStatus(actorId, action === "message" || action === "communicate" ? "speaking" : "acting");
    try {
      const commit = await this.world.performAction(actorId, action, payload);
      this.emit({ type: "world.action", roomId: this.id, actorId, action: commit.action, detail: commit.detail, at: now() });
      if (waiter.acceptedActions.has(action)) {
        clearTimeout(waiter.timer);
        this.waitingHuman = undefined;
        waiter.resolve();
      }
      return commit;
    } finally {
      this.humanActionInFlight = false;
      this.world.setAgentStatus(actorId, "idle");
    }
  }

  private async run(): Promise<void> {
    this.createAgents();
    // Agent construction may have paused the room (configuration errors);
    // never start the loop over an aborted controller.
    if (this.abortController.signal.aborted) return;
    this.status = "running";
    this.world.start();
    this.emit({ type: "room.status", roomId: this.id, status: "running", at: now() });

    for (;;) {
      if (this.abortController.signal.aborted) return;
      const activation = this.world.activation();
      if (!activation) {
        if (this.world.snapshot().status === "finished") {
          this.status = "finished";
          this.director.dispose();
          this.emit({ type: "room.status", roomId: this.id, status: "finished", at: now() });
          // Opt-in persistence: the finished game is handed to the sink once.
          // The room stays fs-free — writing (if any) belongs to the server.
          if (this.archiveSink) {
            try {
              this.archiveSink(this.buildArchive());
            } catch (cause) {
              console.warn(`[room ${this.id}] archive sink failed:`, cause instanceof Error ? cause.message : cause);
            }
          }
        }
        return;
      }
      this.world.beginActivation(activation);
      await this.runActivation(activation, activation.actorIds);
      // Command epoch gate: the window stays open for the whole activation —
      // retries and human waits included — and closes before the next one.
      // Tool calls that arrive late from a request the room already gave up
      // on are then rejected by the world.
      let completion = this.world.completeActivation(activation);
      if (!completion.completed && completion.missingActorIds.length) {
        this.retriedActivations += 1;
        await this.runActivation(
          activation,
          completion.missingActorIds,
          completion.retryInstruction ?? "Complete the required domain action now."
        );
        completion = this.world.completeActivation(activation);
      }
      this.world.endActivation();
      if (!completion.completed) {
        this.pause(`行动未完成：${completion.missingActorIds.join(", ")}。房间没有自动代打。`);
        return;
      }
      this.completedActivations += 1;
      await this.settleAfterActivation();
    }
  }

  /**
   * Create one peer agent per AI seat. Each agent resolves its own final model
   * configuration through the registry (agent binding > room defaults > global
   * defaults > model profile), and providers are shared as stateless clients
   * per provider profile. A resolution failure pauses the room with a clear
   * per-agent error instead of silently falling back.
   */
  private createAgents(): void {
    const resolved = new Map<string, ResolvedModelConfig>();
    for (const card of this.cards.values()) {
      if (card.profile.controller === "human" || this.agents.has(card.profile.id)) continue;
      try {
        const config = resolveAgentModelConfig({
          agentId: card.profile.id,
          ...(this.agentBindings[card.profile.id] ? { binding: this.agentBindings[card.profile.id] } : {}),
          roomDefaults: this.roomDefaults,
          globalDefaults: this.modelRegistry.globalDefaults(),
          forcedCapabilities: explicitlyRequestedCapabilities(
            this.agentBindings[card.profile.id],
            this.roomDefaults,
            this.modelRegistry.globalDefaults()
          ),
          lookup: {
            modelProfile: (id) => this.modelRegistry.modelProfile(id),
            providerProfile: (id) => this.modelRegistry.providerProfile(id),
            contextPolicy: (id) => this.modelRegistry.contextPolicy(id),
            firstModelProfile: () => this.modelRegistry.listModelProfiles().find((profile) => profile.enabled)
          }
        });
        resolved.set(card.profile.id, config);
      } catch (error) {
        // createAgents runs before the room is "running", so pause() would
        // no-op here; mark paused + abort directly so the room waits for a
        // configuration fix and an observer resume instead of erroring.
        this.failToPause(`模型配置解析失败（${card.profile.displayName}）：${errorMessage(error)}`);
        return;
      }
    }
    for (const card of this.cards.values()) {
      if (card.profile.controller === "human" || this.agents.has(card.profile.id)) continue;
      const config = resolved.get(card.profile.id);
      if (!config) continue;
      try {
        const runtime = createSocietyAgent({
          profile: { ...card.profile, model: config.modelId },
          roomId: this.id,
          world: this.world,
          provider: this.providerClientFor(config.providerProfileId),
          resolvedConfig: config,
          emit: (event) => this.handleAgentEvent(event)
        });
        this.agents.set(card.profile.id, runtime);
        card.profile.model = config.modelId;
      } catch (error) {
        this.failToPause(`Agent 启动失败（${card.profile.displayName}）：${errorMessage(error)}`);
        return;
      }
    }
  }

  private providerClientFor(providerProfileId: string): OpenAIProvider {
    const existing = this.providerClients.get(providerProfileId);
    if (existing) return existing;
    // A caller-supplied provider wins over the registry for this room (tests
    // inject scripted fakes here; the registry still resolves model/tuning).
    if (this.provider) {
      this.providerClients.set(providerProfileId, this.provider);
      return this.provider;
    }
    // The bundled OpenAI client defaults to a 600s request timeout; slow
    // thinking models exceed it on long turns. Align the client timeout
    // with the room's own wall-clock horizon so the room (not the client)
    // decides when a turn is abandoned. The provider must not carry
    // apiKey/baseURL when a client is injected — the client owns them.
    const fallbackKey = this.apiKey ?? apiKeyFromEnv();
    const fallbackBaseURL = this.baseURL ?? baseUrlFromEnv();
    const fallback = new OpenAIProvider({
      useResponses: false,
      openAIClient: this.makeOpenAIClient(fallbackKey, fallbackBaseURL)
    });
    if (providerProfileId === "") return fallback;
    const profile = this.modelRegistry.providerProfile(providerProfileId);
    if (!profile) {
      this.providerClients.set(providerProfileId, fallback);
      return fallback;
    }
    const client = new OpenAIProvider({
      useResponses: profile.apiMode === "responses",
      openAIClient: this.makeOpenAIClient(apiKeyForRef(profile), profile.baseURL || baseUrlFromEnv())
    });
    this.providerClients.set(providerProfileId, client);
    return client;
  }

  private makeOpenAIClient(apiKey: string, baseURL: string | undefined): OpenAI {
    return new OpenAI({
      apiKey,
      baseURL,
      timeout: this.turnTimeoutMs + this.turnGraceMs + 60_000,
      maxRetries: 1,
      fetch: reasoningFallbackFetch({ onNotice: (notice) => this.emitReasoningNotice(notice) })
    });
  }

  /** Serialize sidecar extractions: one in flight at a time, never blocking sends. */
  private queueActExtraction(message: SocialMessage): void {
    const run = (): Promise<void> => this.performActExtraction(message);
    this.actExtractionChain = this.actExtractionChain.then(run, run);
  }

  private async performActExtraction(message: SocialMessage): Promise<void> {
    try {
      // A paused or finished room has no live conversation to annotate.
      if (this.status !== "running") return;
      const profile = this.extractionModelProfile();
      if (!profile) return;
      const roster: ExtractionRosterEntry[] = [...this.cards.values()]
        .filter((card) => card.profile.controller !== "human")
        .map((card) => ({ id: card.profile.id, name: card.profile.displayName }));
      const request = buildExtractionRequest(message, roster, this.world.extractionHints?.());
      const runOnce = async (): Promise<string> => {
        const provider = this.extractionProviderFor(profile.providerProfileId);
        const model = await provider.getModel(profile.modelId);
        const response = await model.getResponse({
          systemInstructions: request.systemInstructions,
          input: request.input,
          // Low effort + temperature 0: the sidecar must be fast and stable —
          // a thinking-model detour here would stall the serialized queue.
          modelSettings: { temperature: 0, reasoning: { effort: "low" }, parallelToolCalls: false },
          tools: [],
          outputType: "text",
          handoffs: [],
          tracing: false
        });
        return extractText(response.output);
      };
      let raw: string;
      try {
        raw = await runOnce();
      } catch {
        // Transient timeout/429 under provider load gets exactly one retry;
        // a second failure is logged by the caller below.
        raw = await runOnce();
      }
      const declarations = parseExtractedDeclarations(raw, message, roster);
      if (declarations.length) this.world.recordExtractedSocialActs(message.id, declarations);
    } catch (cause) {
      this.extractionFailures += 1;
      console.warn(
        `[room ${this.id}] social-act extraction failed (${this.extractionFailures} total) for message ${message.id}:`,
        cause instanceof Error ? cause.message : cause
      );
    }
  }

  /**
   * Dedicated provider for the sidecar: shares registry credentials but owns a
   * short client timeout, so one slow/hung extraction cannot hold the queue
   * for an activation-length horizon.
   */
  private extractionProviderFor(providerProfileId: string): OpenAIProviderType {
    const existing = this.extractionProviders.get(providerProfileId);
    if (existing) return existing;
    const profile = this.modelRegistry.providerProfile(providerProfileId);
    const client = new OpenAI({
      apiKey: profile ? apiKeyForRef(profile) : (this.apiKey ?? apiKeyFromEnv()),
      baseURL: (profile?.baseURL || undefined) ?? baseUrlFromEnv(),
      timeout: 120_000,
      maxRetries: 0,
      fetch: reasoningFallbackFetch({ onNotice: (notice) => this.emitReasoningNotice(notice) })
    });
    const provider = new OpenAIProvider({
      useResponses: profile?.apiMode === "responses",
      openAIClient: client
    });
    this.extractionProviders.set(providerProfileId, provider);
    return provider;
  }

  /** The extraction sidecar uses the global default model, else any enabled profile. */
  private extractionModelProfile(): ModelProfile | undefined {
    const defaults = this.modelRegistry.globalDefaults();
    const preferred = defaults.modelProfileId ? this.modelRegistry.modelProfile(defaults.modelProfileId) : undefined;
    if (preferred?.enabled) return preferred;
    return this.modelRegistry.listModelProfiles().find((profile) => profile.enabled);
  }

  private async runActivation(activation: WorldActivation, actorIds: string[], overrideInstruction?: string): Promise<void> {
    // Paused agents never get activated. Discussion waves simply continue
    // without them; binding activations wait for the observer to resume the
    // agent — the room never substitutes a decision for it.
    const paused = actorIds.filter((id) => this.pausedAgents.has(id));
    if (paused.length) {
      const names = paused.map((id) => this.cards.get(id)?.profile.displayName ?? id).join("、");
      if (activation.id.includes(":discussion")) {
        actorIds = actorIds.filter((id) => !this.pausedAgents.has(id));
        if (!actorIds.length) return;
      } else {
        this.emit({
          type: "room.status",
          roomId: this.id,
          status: "running",
          detail: `等待已暂停的参与者恢复（${names}）；房间不会代打。`,
          at: now()
        });
        await this.waitForAgentsResumed(paused);
        if (this.abortController.signal.aborted) return;
        actorIds = actorIds.filter((id) => !this.pausedAgents.has(id));
        if (!actorIds.length) return;
      }
    }
    const publicFrame = this.world.snapshotFor();
    publicFrame.messages = publicFrame.messages.filter((message) => message.channel === "public");
    publicFrame.details = {};
    this.emit({
      type: "world.public-frame",
      roomId: this.id,
      activationId: activation.id,
      snapshot: structuredClone(publicFrame),
      at: now()
    });
    this.emit({
      type: "world.operator-frame",
      roomId: this.id,
      activationId: activation.id,
      snapshot: structuredClone(this.world.snapshot()),
      at: now()
    });
    const execute = async (actorId: string): Promise<void> => {
      const card = this.cards.get(actorId);
      if (!card) throw new Error(`PARTICIPANT_NOT_FOUND: '${actorId}' is not in the room.`);
      // In sequential conversations, digest messages and social actions that
      // arrived earlier in this same wave before this participant responds.
      // Parallel sealed-action phases still see only state from prior phases.
      await this.settleActorSocialState(actorId);
      this.emit({
        type: "agent.pov-frame",
        roomId: this.id,
        actorId,
        activationId: activation.id,
        observation: structuredClone(this.world.observe(actorId)),
        socialCausality: structuredClone(this.world.socialCausalityFor(actorId)),
        at: now()
      });
      if (card.profile.controller === "human") {
        await this.waitForHuman(activation, actorId);
        return;
      }
      const runtime = this.agents.get(actorId);
      if (!runtime) throw new Error(`AGENT_RUNTIME_NOT_FOUND: '${actorId}' has no SDK Agent instance.`);
      const turnController = new AbortController();
      this.activeSignals.set(actorId, turnController);
      const signal = AbortSignal.any([this.abortController.signal, AbortSignal.timeout(this.turnTimeoutMs), turnController.signal]);
      const instruction = overrideInstruction ?? activation.instructionFor(actorId);
      const isDiscussion = activation.id.includes(":discussion");
      // Discussion waves run the same peer agent with a lighter tool budget;
      // binding domain actions run the same agent with its full budget.
      const maxTurns = isDiscussion
        ? positiveIntegerFromEnv("SOCIETY_DISCUSSION_MAX_TURNS", 10)
        : undefined;
      let result: AgentTurnResult | undefined;
      let failure: unknown;
      const attemptTurn = async (): Promise<AgentTurnResult> => {
        // Cross-room backpressure: wait for a provider slot before the call.
        // Releasing happens in `lease` so aborted and timed-out turns free
        // their slot only when the underlying request truly settles.
        const release = this.limiter ? await this.limiter.acquire(signal) : undefined;
        // Turn wall-clock duration for provider latency percentiles;
        // only locally successful turns are counted (failures/abandoned skip).
        const startedAt = Date.now();
        // Lease-until-settle: the permit is bound to the
        // real lifetime of the provider request, not to the local race. A
        // local timeout or abort only stops waiting for THIS turn; the
        // request keeps its slot until it truly settles (or a worker
        // terminates it), so a stalled provider can never push real
        // concurrency past the pool.
        const runPromise = runtime.runTurn(`${activation.label}\n${instruction}`, {
          signal,
          turn: this.world.snapshot().turn,
          ...(maxTurns ? { maxTurns } : {}),
          mode: isDiscussion ? "discussion" : "full"
        });
        let abandoned = false;
        // The settle chain is attached for its side effects only: it releases
        // the permit and counts the abandoned turn once the underlying
        // request truly settles, and swallows rejections so a settled-but-
        // failed request never surfaces as an unhandled rejection.
        void runPromise
          .then(() => undefined, () => undefined)
          .finally(() => {
            release?.();
            if (abandoned) {
              // The request the room gave up on has now truly settled.
              this.abandonedRunningTurns -= 1;
              this.settledAbandonedTurns += 1;
            }
          });
        // Hard timeout guard: abort signals can be swallowed by a stalled
        // provider stream, so race the turn against a wall clock as well.
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          graceTimer = setTimeout(
            () => reject(new Error(`TURN_TIMEOUT after ${this.turnTimeoutMs}ms`)),
            this.turnTimeoutMs + this.turnGraceMs
          );
          signal.addEventListener("abort", () => {
            clearTimeout(graceTimer);
            reject(new Error("TURN_ABORTED: The activation was interrupted before the provider settled."));
          }, { once: true });
        });
        try {
          const result = await Promise.race([runPromise, timeoutPromise]);
          this.providerTurnDurationsMs.push(Date.now() - startedAt);
          if (this.providerTurnDurationsMs.length > 500) {
            this.providerTurnDurationsMs.splice(0, this.providerTurnDurationsMs.length - 500);
          }
          return result;
        } catch (error) {
          // The race was lost locally while the request may still be
          // streaming; the lease stays held until the request settles.
          abandoned = /^TURN_(TIMEOUT|ABORTED)/.test(errorMessage(error));
          if (abandoned) this.abandonedRunningTurns += 1;
          throw error;
        } finally {
          // The guard timer dies on every path — success, failure,
          // abort, retry — not just in the abort listener.
          if (graceTimer) clearTimeout(graceTimer);
        }
      };
      // Discussion turns get one immediate retry on provider-side transient
      // failures (5xx / 429 / timeout / connection): the same agent runs the
      // same turn once more before the wave accepts its silence. Binding
      // action turns retry through completeActivation instead, so the room
      // never substitutes a decision for anyone.
      const attempts = isDiscussion ? 2 : 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          result = await attemptTurn();
          failure = undefined;
          break;
        } catch (error) {
          if (this.pausedAgents.has(actorId)) return;
          if (this.abortController.signal.aborted) return; // the room is stopping
          failure = error;
          if (attempt < attempts && !isTransientProviderFailure(error)) break;
        }
      }
      try {
        if (failure !== undefined || result === undefined) {
          const error = failure ?? new Error("AGENT_TURN_EMPTY: The turn produced no result.");
          const safeReason = friendlyFailure(error);
          this.emit({
            type: "runtime.notice",
            roomId: this.id,
            actorId,
            category: "provider",
            severity: "error",
            code: runtimeFailureCode(error),
            message: `${runtime.profile.displayName} 的模型请求失败：${safeReason}`,
            modelId: runtime.profile.model,
            retrying: !isDiscussion,
            at: now()
          });
          // Speaking is optional: an agent that fails to produce a coherent
          // turn simply stays quiet for this wave instead of sinking the room.
          if (isDiscussion) {
            const reason = safeReason;
            // A budget/timeout cut ends a turn that may already have spoken —
            // say what happened instead of claiming the agent stayed silent.
            const cutShort = /行动次数已达上限|思考时间超时/.test(reason);
            const note = cutShort
              ? `${runtime.profile.displayName} 本轮讨论中断（${reason}）`
              : `${runtime.profile.displayName} 本轮未发言（${reason}）`;
            this.world.addWorldLog(note);
            this.emit({ type: "agent.status", roomId: this.id, actorId, status: "idle", at: now() });
            return;
          }
          // Binding actions (votes, night targets, bids) stay mandatory, but a
          // single failed turn must not sink the room: report it, let
          // completeActivation flag the missing action, and the room retries
          // the actor once. Only a repeated failure pauses the room.
          const note = `${runtime.profile.displayName} 行动未完成（${friendlyFailure(error)}），稍后重试`;
          this.world.addWorldLog(note);
          this.emit({ type: "agent.status", roomId: this.id, actorId, status: "error", at: now() });
          return;
        }
      } finally {
        this.activeSignals.delete(actorId);
      }
      card.turnCount += 1;
      this.notify();
    };
    if (activation.mode === "parallel") {
      await Promise.all(actorIds.map(execute));
      return;
    }
    for (const actorId of actorIds) await execute(actorId);
  }

  /** Block until the given agents are resumed (or the room aborts). */
  private async waitForAgentsResumed(agentIds: string[]): Promise<void> {
    while (agentIds.some((id) => this.pausedAgents.has(id)) && !this.abortController.signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref?.();
      });
    }
  }

  private waitForHuman(activation: WorldActivation, actorId: string): Promise<void> {
    if (this.waitingHuman) throw new Error("HUMAN_WAITER_CONFLICT: More than one human turn was opened.");
    const isDiscussion = activation.id.includes(":discussion");
    const domainActions = this.world.playerActions(actorId)
      .map((action) => action.name)
      .filter((name) => name !== "message" && name !== "communicate");
    const acceptedActions = new Set(isDiscussion ? ["message", "communicate"] : domainActions);
    if (!acceptedActions.size) {
      throw new Error(`HUMAN_ACTION_UNAVAILABLE: No valid action is available for '${activation.label}'.`);
    }
    this.world.setAgentStatus(actorId, "idle");
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waitingHuman?.activationId !== activation.id) return;
        this.pause(`等待真人行动超时（${activation.label}）；没有生成或代填任何行动。`);
      }, this.humanTurnTimeoutMs);
      this.waitingHuman = {
        activationId: activation.id,
        activationLabel: activation.label,
        actorId,
        acceptedActions,
        resolve,
        reject,
        timer
      };
      this.emit({
        type: "room.status",
        roomId: this.id,
        status: "running",
        detail: `等待 ${this.cards.get(actorId)?.profile.displayName ?? actorId} 行动`,
        at: now()
      });
    });
  }

  /**
   * After every resolved activation the world settles social accounts: agents
   * appraise what happened to them (emotions, relationships, memories), then
   * store the round's outcome as experience.
   */
  private async settleAfterActivation(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((actorId) => this.settleActorSocialState(actorId)));
  }

  private async settleActorSocialState(actorId: string): Promise<void> {
    const runtime = this.agents.get(actorId);
    if (!runtime) return;
    const events = this.world.eventsFor(actorId);
    if (events.length) await runtime.appraise(events, this.world.snapshot().turn);
    // Surface newly settled outcomes as display notes: the model's session
    // carries real memory; this list is spectator-facing.
    const projection = this.world.socialCausalityFor(actorId);
    const turn = this.world.snapshot().turn;
    const notedThrough = this.notedReconciliationSeq.get(actorId) ?? 0;
    let notedThroughNext = notedThrough;
    for (const reconciliation of projection.outcomeReconciliations) {
      if (reconciliation.logicalTime <= notedThrough) continue;
      runtime.noteOutcome(reconciliation.actualOutcome.summary, turn);
      notedThroughNext = Math.max(notedThroughNext, reconciliation.logicalTime);
    }
    if (notedThroughNext !== notedThrough) this.notedReconciliationSeq.set(actorId, notedThroughNext);
  }

  private handleAgentEvent(event: AgentRuntimeEvent): void {
    if (event.type === "agent.status") {
      const card = this.cards.get(event.actorId);
      if (card) {
        // A paused agent reports its own runtime status; the room keeps it
        // paused until the observer resumes it.
        card.status = this.pausedAgents.has(event.actorId) ? "paused" : event.status;
      }
      this.world.setAgentStatus(event.actorId, this.pausedAgents.has(event.actorId) ? "paused" : event.status);
      this.emit(event);
      return;
    }
    if (event.type === "agent.updated") {
      const card = this.cards.get(event.actorId);
      if (card) {
        card.moodLabel = event.mind.mood.label;
        card.energy = Math.round(event.mind.mood.energy * 100);
        card.turnCount = event.turnCount;
        card.totalTokens += event.totalTokens;
        if (event.lastOutput) card.lastOutput = event.lastOutput;
        card.mind = structuredClone(event.mind);
      }
      this.emit(event);
      return;
    }
    // Streaming text, tool activity and committed world actions are all part of
    // the live interaction feed delivered to observers through SSE.
    if (
      event.type === "world.action" ||
      event.type === "agent.message" ||
      event.type === "agent.delta" ||
      event.type === "agent.reasoning-content" ||
      event.type === "agent.reasoning-summary" ||
      event.type === "agent.reasoning" ||
      event.type === "runtime.notice" ||
      event.type === "agent.tool" ||
      event.type === "agent.thought-beat" ||
      event.type === "agent.compacted" ||
      event.type === "agent.context.pressure"
    ) {
      // Seal the public token stream and tool names during hidden-choice
      // phases: the projection drops sealed deltas and strips sealed
      // tool details, while the owner seat and the acting agent's POV still
      // see everything.
      if ((event.type === "agent.delta" || event.type === "agent.tool") && !this.world.publicStreamingAllowed()) {
        this.emit({ ...event, sealed: true });
        return;
      }
      this.emit(event);
    }
  }

  private onWorldUpdate(snapshot: WorldSnapshot): void {
    for (const worldAgent of snapshot.agents) {
      const card = this.cards.get(worldAgent.id);
      if (card) card.status = worldAgent.status;
    }
    this.updatedAt = now();
    this.emit({ type: "world.updated", roomId: this.id, snapshot: structuredClone(snapshot) });
  }

  private emitReasoningNotice(notice: ReasoningFallbackNotice): void {
    this.emit({
      type: "runtime.notice",
      roomId: this.id,
      category: "reasoning",
      severity: "warning",
      code: notice.errorCode,
      message: `${notice.message} 已自动从 ${notice.requestedEffort} 降级到 ${notice.effectiveEffort} 并重试。`,
      ...(notice.modelId ? { modelId: notice.modelId } : {}),
      requestedEffort: notice.requestedEffort,
      effectiveEffort: notice.effectiveEffort,
      retrying: true,
      at: now()
    });
  }

  private notify(): void {
    this.updatedAt = now();
    this.emit({
      type: "world.updated",
      roomId: this.id,
      snapshot: this.world.snapshotFor(),
    });
  }

  private emit(event: AgentRuntimeEvent): void {
    if (event.type === "runtime.notice") this.world.recordRuntimeNotice(event);
    const envelope: SocietyRoomEventEnvelope = { id: randomUUID(), seq: (this.events.last()?.seq ?? 0) + 1, event };
    this.events.push(envelope);
    if (isReplayEvent(event)) {
      this.replayEvents.push(structuredClone(envelope));
    }
    this.updatedAt = "at" in event && typeof event.at === "string" ? event.at : now();
    for (const listener of this.listeners) listener(structuredClone(envelope));
    // High-priority cinematic cues become endgame highlights (derived facts).
    if (event.type === "cinematic.cue" && event.cue.priority >= 8) {
      this.highlights.push({
        id: event.cue.id,
        at: event.cue.createdAt,
        title: event.cue.title ?? event.cue.camera,
        ...(event.cue.subtitle ? { subtitle: event.cue.subtitle } : {}),
        camera: event.cue.camera,
        priority: event.cue.priority,
        focusAgentIds: event.cue.focusAgentIds
      });
      if (this.highlights.length > 12) this.highlights.splice(0, this.highlights.length - 12);
    }
    // The director sees the same public event stream plus the world snapshot;
    // its own outputs are presentation events and never loop back into rules.
    this.director.ingest(event, this.world.snapshot());
  }

  private fail(error: unknown): void {
    this.status = "error";
    // Operator console keeps the full diagnostic (key-redacted); viewers and
    // snapshots only ever see the friendly text.
    console.error(`[room ${this.id}] ${errorMessage(error)}`);
    this.error = friendlyFailure(error);
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(error instanceof Error ? error : new Error(this.error));
    }
    this.world.pause();
    this.director.dispose();
    this.emit({ type: "room.status", roomId: this.id, status: "error", detail: this.error, at: now() });
  }
}

export class SocietyRoomRegistry {
  private readonly rooms = new Map<string, SocietyRoom>();

  create(options: SocietyRoomCreateOptions): SocietyRoom {
    const room = new SocietyRoom(options);
    this.rooms.set(room.id, room);
    return room;
  }

  get(roomId: string): SocietyRoom | undefined {
    return this.rooms.get(roomId);
  }

  /** Stop the room and release it from memory. */
  remove(roomId: string): SocietyRoom | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    room.dispose();
    this.rooms.delete(roomId);
    return room;
  }

  list(): SocietyRoomSnapshot[] {
    return [...this.rooms.values()]
      .map((room) => room.snapshotFor())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * Model-vs-model standings over finished games in this process: per model,
   * seat-slots played, wins (faction games publish winners) and mean score.
   * Derived from public end-of-game facts only — winners and scores are
   * revealed at finish — so this needs no authority gate.
   */
  modelStandings(): Array<{ model: string; seats: number; wins: number; avgScore: number | null }> {
    return modelStandingsFromRooms(this.rooms.values());
  }

  /** True when the token is the owner token of any live room in the process. */
  hasOwnerToken(token: string): boolean {
    for (const room of this.rooms.values()) {
      if (room.isOwnerToken(token)) return true;
    }
    return false;
  }
}

function waitingHumanLabel(waiter: HumanWaiter | undefined, actorId: string): string | undefined {
  return waiter?.actorId === actorId ? waiter.activationLabel : undefined;
}

function isReplayEvent(event: AgentRuntimeEvent): boolean {
  switch (event.type) {
    case "world.public-frame":
    case "world.operator-frame":
    case "agent.pov-frame":
    case "agent.message":
    case "world.action":
    case "runtime.notice":
    case "agent.tool":
    case "agent.thought-beat":
    case "agent.compacted":
    case "agent.context.pressure":
    case "agent.memory.consolidated":
    case "agent.guardrail":
    case "agent.status":
    case "agent.paused":
    case "agent.resumed":
    case "agent.model.switched":
    case "room.status":
      return true;
    default:
      return false;
  }
}

/** Serialized size of an envelope, for the byte-budgeted event windows. */
function envelopeByteSize(envelope: SocietyRoomEventEnvelope): number {
  return JSON.stringify(envelope).length;
}

/** Resolve a provider profile's apiKeyRef into the actual secret from env. */
function apiKeyForRef(profile: ProviderProfile): string {
  const ref = profile.apiKeyRef;
  if (!ref) return apiKeyFromEnv();
  if (ref.startsWith("env:")) {
    const key = process.env[ref.slice(4)]?.trim();
    if (!key || key.startsWith("replace-with")) {
      throw new Error(`API_KEY_REF_MISSING: Provider '${profile.name}' references ${ref}, which is not set.`);
    }
    return key;
  }
  return apiKeyFromEnv();
}

/**
 * Model-vs-model standings over finished rooms. Public end-of-game facts
 * only (winners and scores are revealed at finish), so it needs no gate.
 */
export function modelStandingsFromRooms(rooms: Iterable<{ currentStatus(): RoomStatus; snapshotFor(): SocietyRoomSnapshot }>): Array<{ model: string; seats: number; wins: number; avgScore: number | null }> {
  const perModel = new Map<string, { seats: number; wins: number; scoreSum: number; scoreCount: number }>();
  for (const room of rooms) {
    if (room.currentStatus() !== "finished") continue;
    const snapshot = room.snapshotFor();
    const winners = new Set((snapshot.world.details as { winners?: string[] }).winners ?? []);
    for (const participant of snapshot.participants) {
      const model = participant.profile.model;
      // Human seats carry no engine to compare.
      if (!model || model === "human") continue;
      const entry = perModel.get(model) ?? { seats: 0, wins: 0, scoreSum: 0, scoreCount: 0 };
      entry.seats += 1;
      if (winners.has(participant.profile.id)) entry.wins += 1;
      const score = snapshot.world.agents.find((agent) => agent.id === participant.profile.id)?.score;
      if (typeof score === "number") {
        entry.scoreSum += score;
        entry.scoreCount += 1;
      }
      perModel.set(model, entry);
    }
  }
  return [...perModel.entries()]
    .map(([model, entry]) => ({
      model,
      seats: entry.seats,
      wins: entry.wins,
      avgScore: entry.scoreCount ? Math.round((entry.scoreSum / entry.scoreCount) * 100) / 100 : null
    }))
    .sort((left, right) => right.wins - left.wins || (right.avgScore ?? 0) - (left.avgScore ?? 0));
}

/** Rooms without a server registry fall back to an env-seeded one. */
function fallbackRegistryFromEnv(): ModelRegistry {
  const registry = new ModelRegistry();
  seedRegistryFromEnv(registry);
  return registry;
}

function now(): string {
  return new Date().toISOString();
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" | ")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .slice(0, 800);
}

/** Turn SDK/provider failures into observer-friendly Chinese. */
/** Provider-side transient failures that are worth one immediate retry. */
export function isTransientProviderFailure(error: unknown): boolean {
  return /429|rate limit|502|503|504|500|Internal server error|ECONN|ETIMEDOUT|socket|network|fetch failed|TURN_TIMEOUT/i.test(errorMessage(error));
}

export function friendlyFailure(error: unknown): string {
  const message = errorMessage(error);
  const maxTurns = /Max turns \((\d+)\) exceeded/i.exec(message);
  if (maxTurns) return `本轮行动次数已达上限（${maxTurns[1]} 次）`;
  if (/TURN_TIMEOUT/i.test(message)) return "思考时间超时";
  if (/aborted|abort/i.test(message)) return "本轮被中断";
  if (/OPENAI_API_KEY_REQUIRED/i.test(message)) return "提供商密钥未配置";
  if (/CONTEXT_HARD_GUARD/i.test(message)) return "上下文压力达到硬上限，正在压缩";
  if (/reused for a different invocation/i.test(message)) return "工具调用标识冲突，本轮重试";
  if (/400\s|openai_error/i.test(message) && /400/i.test(message)) return "提供商拒绝了本次请求（400），稍后重试";
  if (/422/i.test(message)) return "提供商拒绝了本次请求（422），稍后重试";
  if (/429|rate limit/i.test(message)) return "提供商限流，稍后重试";
  if (/502|503|504/i.test(message)) return "提供商暂时不可用";
  // Never echo raw provider error text (bodies can carry internal details);
  // the operator console keeps the full diagnostic.
  return "提供商请求失败，请稍后重试";
}

function explicitlyRequestedCapabilities(
  binding: AgentModelBinding | undefined,
  roomDefaults: SocietyRoomCreateOptions["roomDefaults"],
  globalDefaults: RegistryGlobalDefaults
): ReadonlySet<string> {
  const sources: unknown[] = [
    binding?.tuningOverrides,
    roomDefaults?.tuning,
    globalDefaults.tuning
  ];
  return sources.some((source) => Boolean(source && typeof source === "object" && "reasoningEffort" in source))
    ? new Set(["reasoningEffort"])
    : new Set();
}

function runtimeFailureCode(error: unknown): string {
  const message = errorMessage(error);
  if (/TURN_TIMEOUT/i.test(message)) return "PROVIDER_TIMEOUT";
  if (/aborted|abort/i.test(message)) return "PROVIDER_ABORTED";
  if (/OPENAI_API_KEY_REQUIRED|401|unauthorized|authentication/i.test(message)) return "PROVIDER_AUTH_FAILED";
  if (/429|rate limit/i.test(message)) return "PROVIDER_RATE_LIMITED";
  if (/CONTEXT_HARD_GUARD/i.test(message)) return "CONTEXT_HARD_GUARD";
  if (/400|422|openai_error/i.test(message)) return "PROVIDER_REQUEST_REJECTED";
  if (/5\d\d|ECONN|ETIMEDOUT|socket|network|fetch failed/i.test(message)) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_TURN_FAILED";
}
