import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { OpenAIProvider, type OpenAIProvider as OpenAIProviderType } from "@openai/agents";
import type {
  AgentMindState,
  AgentProfile,
  AgentRuntimeEvent,
  AgentStatus,
  AgentTurnResult,
  CharacterDossier,
  ParticipantController,
  PlayerActionSpec,
  RoomStatus,
  ScenarioId,
  SeasonStore,
  SocialWorld,
  WorldActionCommit,
  WorldActivation,
  WorldSnapshot
} from "./contracts";
import { apiKeyFromEnv, baseUrlFromEnv, createSocietyAgent, type OpenAISocietyAgent } from "./participant";
import { createWorld } from "./scenarios";

export interface SocietyRoomCreateOptions {
  id?: string;
  scenarioId: ScenarioId;
  profiles: AgentProfile[];
  rounds?: number;
  provider?: OpenAIProviderType;
  apiKey?: string;
  baseURL?: string;
  /** Cross-game memory: dossiers are loaded for returning characters and
   *  saved when the room finishes. */
  season?: SeasonStore;
}

export interface SocietyRoomEventEnvelope {
  seq: number;
  event: AgentRuntimeEvent;
}

export interface SocietyParticipantProfile {
  id: string;
  displayName: string;
  model: string;
  controller: ParticipantController;
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
}

export interface SocietyPlayerState {
  actorId: string;
  displayName: string;
  waiting: boolean;
  activationLabel?: string;
  actions: PlayerActionSpec[];
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
  error?: string;
}

export interface SocietyRoomCreateResult {
  room: SocietyRoomSnapshot;
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
  private readonly agents = new Map<string, OpenAISocietyAgent>();
  private readonly events: SocietyRoomEventEnvelope[] = [];
  private readonly listeners = new Set<RoomListener>();
  private readonly abortController = new AbortController();
  private readonly provider?: OpenAIProviderType;
  private readonly apiKey?: string;
  private readonly baseURL?: string;
  private readonly season?: SeasonStore;
  private readonly turnTimeoutMs: number;
  private readonly humanTurnTimeoutMs: number;
  private readonly humanToken?: string;
  private readonly rememberedExperiences = new Map<string, string>();
  private runningPromise?: Promise<void>;
  private waitingHuman?: HumanWaiter;
  private humanActionInFlight = false;
  private status: RoomStatus = "lobby";
  private updatedAt: string;
  private error?: string;

  constructor(options: SocietyRoomCreateOptions) {
    this.id = options.id ?? `room_${randomUUID()}`;
    this.scenarioId = options.scenarioId;
    this.createdAt = now();
    this.updatedAt = this.createdAt;
    this.provider = options.provider;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.season = options.season;
    this.turnTimeoutMs = positiveIntegerFromEnv("SOCIETY_AGENT_TURN_TIMEOUT_MS", 300_000);
    this.humanTurnTimeoutMs = positiveIntegerFromEnv("SOCIETY_HUMAN_TURN_TIMEOUT_MS", 1_800_000);
    const humans = options.profiles.filter((profile) => profile.controller === "human");
    if (humans.length > 1) throw new Error("HUMAN_LIMIT_EXCEEDED: A room supports at most one human participant.");
    this.humanActorId = humans[0]?.id;
    this.humanToken = this.humanActorId ? randomBytes(32).toString("base64url") : undefined;
    this.world = createWorld({
      roomId: this.id,
      scenarioId: options.scenarioId,
      profiles: options.profiles,
      rounds: options.rounds
    });
    this.world.onUpdate((snapshot) => this.onWorldUpdate(snapshot));
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
      ...(this.humanActorId && this.humanToken
        ? { playerActorId: this.humanActorId, playerToken: this.humanToken }
        : {})
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
      participants: [...this.cards.values()].map((card) => {
        const state = world.agents.find((agent) => agent.id === card.profile.id);
        return {
          profile: {
            id: card.profile.id,
            displayName: card.profile.displayName,
            model: card.profile.model,
            controller: card.profile.controller ?? "agent"
          },
          status: card.status,
          alive: state?.alive ?? true,
          ...(state?.score === undefined ? {} : { score: state.score }),
          ...(state?.observerRole ? { role: state.observerRole } : {}),
          ...(card.moodLabel ? { mood: card.moodLabel, energy: card.energy } : {}),
          // Private minds belong to the observer seat only; a human player's
          // snapshot must never expose another participant's inner state.
          ...(actorId === undefined && card.mind ? { mind: card.mind } : {})
        };
      }),
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
      ...(this.error ? { error: this.error } : {})
    };
  }

  actorForToken(token: string | undefined): string | undefined {
    if (!token || !this.humanToken || !this.humanActorId) return undefined;
    const supplied = Buffer.from(token);
    const expected = Buffer.from(this.humanToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
    return this.humanActorId;
  }

  eventsSince(seq = 0): SocietyRoomEventEnvelope[] {
    return this.events.filter((entry) => entry.seq > seq).map((entry) => structuredClone(entry));
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
    this.emit({ type: "room.status", roomId: this.id, status: "paused", detail: reason, at: now() });
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

  /** Distill every character's mind into the season when the room ends. */
  private saveSeasonDossiers(): void {
    if (!this.season) return;
    const details = this.world.snapshot().details ?? {};
    const winners = Array.isArray(details.winners) ? (details.winners as string[]) : [];
    const roles = (details.roles ?? {}) as Record<string, string | undefined>;
    for (const [actorId, runtime] of this.agents) {
      const card = this.cards.get(actorId);
      if (!card) continue;
      const role = roles[actorId] ? String(roles[actorId]) : undefined;
      // Some worlds (negotiation games) do not declare winners; only record an
      // outcome when the world actually settled one.
      const outcome = winners.length > 0 ? (winners.includes(actorId) ? "win" : "lose") : undefined;
      const previous = this.season.get(card.profile.displayName);
      const current = runtime.exportDossier(role, outcome);
      this.season.save({
        ...current,
        games: [...(previous?.games ?? []), ...current.games].slice(-20)
      });
    }
  }

  private async run(): Promise<void> {
    const provider = this.provider ?? new OpenAIProvider({
      apiKey: this.apiKey ?? apiKeyFromEnv(),
      baseURL: this.baseURL ?? baseUrlFromEnv(),
      useResponses: false
    });
    this.createAgents(provider);
    this.status = "running";
    this.world.start();
    this.emit({ type: "room.status", roomId: this.id, status: "running", at: now() });

    for (;;) {
      if (this.abortController.signal.aborted) return;
      const activation = this.world.activation();
      if (!activation) {
        if (this.world.snapshot().status === "finished") {
          this.status = "finished";
          this.saveSeasonDossiers();
          this.emit({ type: "room.status", roomId: this.id, status: "finished", at: now() });
        }
        return;
      }
      await this.runActivation(activation, activation.actorIds);
      let completion = this.world.completeActivation(activation);
      if (!completion.completed && completion.missingActorIds.length) {
        await this.runActivation(
          activation,
          completion.missingActorIds,
          completion.retryInstruction ?? "Complete the required domain action now."
        );
        completion = this.world.completeActivation(activation);
      }
      if (!completion.completed) {
        this.pause(`行动未完成：${completion.missingActorIds.join(", ")}。房间没有自动代打。`);
        return;
      }
      await this.settleAfterActivation();
    }
  }

  private createAgents(provider: OpenAIProviderType): void {
    for (const card of this.cards.values()) {
      if (card.profile.controller === "human" || this.agents.has(card.profile.id)) continue;
      const dossier = this.season?.get(card.profile.displayName);
      const runtime = createSocietyAgent({
        profile: card.profile,
        roomId: this.id,
        world: this.world,
        provider,
        emit: (event) => this.handleAgentEvent(event),
        ...(dossier ? { dossier } : {})
      });
      this.agents.set(card.profile.id, runtime);
    }
  }

  private async runActivation(activation: WorldActivation, actorIds: string[], overrideInstruction?: string): Promise<void> {
    const execute = async (actorId: string): Promise<void> => {
      const card = this.cards.get(actorId);
      if (!card) throw new Error(`PARTICIPANT_NOT_FOUND: '${actorId}' is not in the room.`);
      if (card.profile.controller === "human") {
        await this.waitForHuman(activation, actorId);
        return;
      }
      const runtime = this.agents.get(actorId);
      if (!runtime) throw new Error(`AGENT_RUNTIME_NOT_FOUND: '${actorId}' has no SDK Agent instance.`);
      const signal = AbortSignal.any([this.abortController.signal, AbortSignal.timeout(this.turnTimeoutMs)]);
      const instruction = overrideInstruction ?? activation.instructionFor(actorId);
      const isDiscussion = activation.id.includes(":discussion");
      // Speaking waves run the discussion variant of the agent (no council,
      // light budget); binding domain actions get the full agent and budget.
      const maxTurns = isDiscussion
        ? positiveIntegerFromEnv("SOCIETY_DISCUSSION_MAX_TURNS", 8)
        : undefined;
      let result: AgentTurnResult;
      try {
        // Hard timeout guard: abort signals can be swallowed by a stalled
        // provider stream, so race the turn against a wall clock as well.
        result = await Promise.race([
          runtime.runTurn(`${activation.label}\n${instruction}`, {
            signal,
            turn: this.world.snapshot().turn,
            ...(maxTurns ? { maxTurns } : {}),
            mode: isDiscussion ? "discussion" : "full"
          }),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`TURN_TIMEOUT after ${this.turnTimeoutMs}ms`)), this.turnTimeoutMs + 15_000);
            signal.addEventListener("abort", () => { clearTimeout(timer); }, { once: true });
          })
        ]);
      } catch (error) {
        // Speaking is optional: an agent that fails to produce a coherent turn
        // simply stays quiet for this wave instead of sinking the whole room.
        if (isDiscussion) {
          const note = `${runtime.profile.displayName} 本轮未能发言（${errorMessage(error)}）`;
          this.world.addWorldLog(note);
          this.emit({ type: "agent.status", roomId: this.id, actorId, status: "idle", at: now() });
          return;
        }
        // Binding actions (votes, night targets, bids) stay mandatory, but a
        // single failed turn must not sink the room: report it, let
        // completeActivation flag the missing action, and the room retries the
        // actor once. Only a repeated failure pauses the room.
        const note = `${runtime.profile.displayName} 行动失败（${errorMessage(error)}），稍后重试`;
        this.world.addWorldLog(note);
        this.emit({ type: "agent.status", roomId: this.id, actorId, status: "error", at: now() });
        return;
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
    await Promise.all([...this.agents].map(async ([actorId, runtime]) => {
      const events = this.world.eventsFor(actorId);
      if (events.length) await runtime.appraise(events, this.world.snapshot().turn);
      const experience = this.world.experienceFor(actorId);
      if (!experience || this.rememberedExperiences.get(actorId) === experience) return;
      this.rememberedExperiences.set(actorId, experience);
      await runtime.rememberOutcome(experience, this.world.snapshot().turn);
    }));
  }

  private handleAgentEvent(event: AgentRuntimeEvent): void {
    if (event.type === "agent.status") {
      const card = this.cards.get(event.actorId);
      if (card) card.status = event.status;
      this.world.setAgentStatus(event.actorId, event.status);
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
      event.type === "agent.reasoning" ||
      event.type === "agent.tool" ||
      event.type === "agent.thought" ||
      event.type === "agent.compacted"
    ) {
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

  private notify(): void {
    this.updatedAt = now();
    this.emit({
      type: "world.updated",
      roomId: this.id,
      snapshot: this.world.snapshotFor(),
    });
  }

  private emit(event: AgentRuntimeEvent): void {
    const envelope: SocietyRoomEventEnvelope = { seq: (this.events.at(-1)?.seq ?? 0) + 1, event };
    this.events.push(envelope);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    this.updatedAt = "at" in event && typeof event.at === "string" ? event.at : now();
    for (const listener of this.listeners) listener(structuredClone(envelope));
  }

  private fail(error: unknown): void {
    this.status = "error";
    this.error = errorMessage(error);
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(error instanceof Error ? error : new Error(this.error));
    }
    this.world.pause();
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

  list(): SocietyRoomSnapshot[] {
    return [...this.rooms.values()]
      .map((room) => room.snapshotFor())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

function waitingHumanLabel(waiter: HumanWaiter | undefined, actorId: string): string | undefined {
  return waiter?.actorId === actorId ? waiter.activationLabel : undefined;
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
