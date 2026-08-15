import { randomUUID } from "node:crypto";
import { OpenAIProvider, type OpenAIProvider as OpenAIProviderType } from "@openai/agents";
import type {
  AgentMindState,
  AgentProfile,
  AgentRuntimeEvent,
  AgentStatus,
  AgentTurnResult,
  RoomStatus,
  ScenarioId,
  SocialWorld,
  WorldActivation
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
}

export interface SocietyRoomEventEnvelope {
  seq: number;
  event: AgentRuntimeEvent;
}

export interface SocietyAgentCard {
  profile: AgentProfile;
  status: AgentStatus;
  observerRole?: string;
  mind?: AgentMindState;
  latestNote?: Extract<AgentRuntimeEvent, { type: "agent.note" }>;
  latestTool?: Extract<AgentRuntimeEvent, { type: "agent.tool" }>;
  turnCount: number;
  totalTokens: number;
  lastOutput?: string;
}

export interface SocietyRoomSnapshot {
  id: string;
  scenarioId: ScenarioId;
  title: string;
  status: RoomStatus;
  createdAt: string;
  updatedAt: string;
  world: ReturnType<SocialWorld["snapshot"]>;
  agents: SocietyAgentCard[];
  recentEvents: SocietyRoomEventEnvelope[];
  error?: string;
}

type RoomListener = (event: SocietyRoomEventEnvelope) => void;

export class SocietyRoom {
  readonly id: string;
  readonly scenarioId: ScenarioId;
  readonly createdAt: string;

  private readonly world: SocialWorld;
  private readonly cards = new Map<string, SocietyAgentCard>();
  private readonly agents = new Map<string, OpenAISocietyAgent>();
  private readonly events: SocietyRoomEventEnvelope[] = [];
  private readonly listeners = new Set<RoomListener>();
  private readonly abortController = new AbortController();
  private readonly provider?: OpenAIProviderType;
  private readonly apiKey?: string;
  private readonly baseURL?: string;
  private readonly turnTimeoutMs: number;
  private readonly rememberedExperiences = new Map<string, string>();
  private runningPromise?: Promise<void>;
  private status: RoomStatus = "lobby";
  private updatedAt: string;
  private error?: string;

  constructor(options: SocietyRoomCreateOptions) {
    this.id = options.id ?? `room_${randomUUID()}`;
    this.scenarioId = options.scenarioId;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.provider = options.provider;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.turnTimeoutMs = positiveIntegerFromEnv("SOCIETY_AGENT_TURN_TIMEOUT_MS", 300_000);
    this.world = createWorld({ roomId: this.id, scenarioId: options.scenarioId, profiles: options.profiles, rounds: options.rounds });
    this.world.onUpdate((snapshot) => this.onWorldUpdate(snapshot));
    for (const profile of options.profiles) {
      const role = this.world.snapshot().agents.find((agent) => agent.id === profile.id)?.observerRole;
      this.cards.set(profile.id, {
        profile: structuredClone(profile),
        status: "lobby",
        ...(role ? { observerRole: role } : {}),
        turnCount: 0,
        totalTokens: 0
      });
    }
    this.onWorldUpdate(this.world.snapshot());
  }

  snapshot(): SocietyRoomSnapshot {
    const world = this.world.snapshot();
    return {
      id: this.id,
      scenarioId: this.scenarioId,
      title: world.title,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      world,
      agents: [...this.cards.values()].map((card) => {
        const runtime = this.agents.get(card.profile.id);
        const role = world.agents.find((agent) => agent.id === card.profile.id)?.observerRole;
        return {
          ...structuredClone(card),
          ...(role ? { observerRole: role } : {}),
          ...(runtime ? { mind: structuredClone(runtime.mind) } : {})
        };
      }),
      recentEvents: this.events.slice(-240).map((event) => structuredClone(event)),
      ...(this.error ? { error: this.error } : {})
    };
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

  pause(reason = "Room paused by observer"): void {
    if (this.status !== "running") return;
    this.abortController.abort(new Error(reason));
    this.status = "paused";
    this.world.pause();
    this.emit({ type: "room.status", roomId: this.id, status: "paused", detail: reason, at: now() });
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
        const worldStatus = this.world.snapshot().status;
        if (worldStatus === "finished") {
          this.status = "finished";
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
        this.status = "paused";
        this.world.pause();
        this.emit({
          type: "room.status",
          roomId: this.id,
          status: "paused",
          detail: `Required action missing from: ${completion.missingActorIds.join(", ")}`,
          at: now()
        });
        return;
      }
      await this.rememberNewExperiences();
    }
  }

  private createAgents(provider: OpenAIProviderType): void {
    for (const card of this.cards.values()) {
      if (this.agents.has(card.profile.id)) continue;
      const runtime = createSocietyAgent({
        profile: card.profile,
        roomId: this.id,
        world: this.world,
        provider,
        emit: (event) => this.handleAgentEvent(event)
      });
      this.agents.set(card.profile.id, runtime);
    }
  }

  private async runActivation(activation: WorldActivation, actorIds: string[], overrideInstruction?: string): Promise<void> {
    const execute = async (actorId: string): Promise<void> => {
      const runtime = this.agents.get(actorId);
      if (!runtime) throw new Error(`AGENT_RUNTIME_NOT_FOUND: '${actorId}' has no SDK Agent instance.`);
      const signal = AbortSignal.any([this.abortController.signal, AbortSignal.timeout(this.turnTimeoutMs)]);
      const instruction = overrideInstruction ?? activation.instructionFor(actorId);
      let result: AgentTurnResult;
      try {
        result = await runtime.runTurn(`${activation.label}\n${instruction}`, { signal, turn: this.world.snapshot().turn });
      } catch (error) {
        throw new Error(`${runtime.profile.displayName} (${runtime.profile.model}) failed: ${errorMessage(error)}`, { cause: error });
      }
      const card = this.cards.get(actorId);
      if (!card) return;
      card.turnCount += 1;
      card.totalTokens += result.usage?.totalTokens ?? 0;
      card.lastOutput = result.finalOutput;
      this.emitAgentUpdate(actorId);
    };
    if (activation.mode === "parallel") {
      await Promise.all(actorIds.map(execute));
      return;
    }
    for (const actorId of actorIds) await execute(actorId);
  }

  private async rememberNewExperiences(): Promise<void> {
    await Promise.all([...this.agents].map(async ([actorId, runtime]) => {
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
    } else if (event.type === "agent.note") {
      const card = this.cards.get(event.actorId);
      if (card) card.latestNote = event;
    } else if (event.type === "agent.tool") {
      const card = this.cards.get(event.actorId);
      if (card) card.latestTool = event;
    }
    this.emit(event);
    if (event.type === "agent.note" || event.type === "agent.tool") {
      this.emitAgentUpdate(event.actorId);
    }
  }

  private emitAgentUpdate(actorId: string): void {
    const card = this.cards.get(actorId);
    const runtime = this.agents.get(actorId);
    if (!card || !runtime) return;
    this.emit({
      type: "agent.updated",
      roomId: this.id,
      actorId,
      status: card.status,
      mind: structuredClone(runtime.mind),
      turnCount: card.turnCount,
      totalTokens: card.totalTokens,
      ...(card.lastOutput ? { lastOutput: card.lastOutput } : {}),
      at: now()
    });
  }

  private onWorldUpdate(snapshot: ReturnType<SocialWorld["snapshot"]>): void {
    this.updatedAt = now();
    this.emit({ type: "world.updated", roomId: this.id, snapshot: structuredClone(snapshot) });
  }

  private emit(event: AgentRuntimeEvent): void {
    const envelope: SocietyRoomEventEnvelope = { seq: (this.events.at(-1)?.seq ?? 0) + 1, event };
    this.events.push(envelope);
    if (this.events.length > 1_000) this.events.splice(0, this.events.length - 1_000);
    this.updatedAt = "at" in event && typeof event.at === "string" ? event.at : now();
    for (const listener of this.listeners) listener(structuredClone(envelope));
  }

  private fail(error: unknown): void {
    this.status = "error";
    this.error = errorMessage(error);
    if (!this.abortController.signal.aborted) this.abortController.abort(error instanceof Error ? error : new Error(this.error));
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
      .map((room) => room.snapshot())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

function now(): string {
  return new Date().toISOString();
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .slice(0, 800);
}
