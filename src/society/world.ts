import { randomUUID } from "node:crypto";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  AgentStatus,
  ScenarioSummary,
  SocialChannel,
  SocialMessage,
  SocialWorld,
  SocietyAgentContext,
  StoryBeat,
  WorldActivation,
  WorldAgentSnapshot,
  WorldSnapshot
} from "./contracts";
import type { Tool } from "@openai/agents";

export abstract class SocialWorldBase implements SocialWorld {
  readonly roomId: string;
  readonly scenario: ScenarioSummary;

  protected readonly profiles: Map<string, AgentProfile>;
  protected readonly statuses = new Map<string, AgentStatus>();
  protected readonly messages: SocialMessage[] = [];
  protected readonly story: StoryBeat[] = [];
  protected status: WorldSnapshot["status"] = "lobby";
  protected listeners = new Set<(snapshot: WorldSnapshot) => void>();

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[]) {
    this.roomId = roomId;
    this.scenario = scenario;
    this.profiles = new Map(profiles.map((profile) => [profile.id, structuredClone(profile)]));
    for (const profile of profiles) this.statuses.set(profile.id, "lobby");
  }

  start(): void {
    this.status = "running";
    for (const id of this.profiles.keys()) this.statuses.set(id, "idle");
    this.emitUpdate();
  }

  pause(): void {
    if (this.status === "finished") return;
    this.status = "paused";
    this.emitUpdate();
  }

  abstract snapshot(): WorldSnapshot;
  abstract observe(actorId: string): AgentObservation;
  abstract toolsFor(actorId: string): Tool<SocietyAgentContext>[];
  abstract activation(): WorldActivation | null;
  abstract completeActivation(activation: WorldActivation): ActivationCompletion;
  abstract experienceFor(actorId: string): string | undefined;

  async sendMessage(input: {
    senderId: string;
    channel: SocialChannel;
    text: string;
    recipientIds?: string[];
    replyTo?: string;
  }): Promise<SocialMessage> {
    const sender = this.requireProfile(input.senderId);
    const text = input.text.trim();
    if (!text) throw new Error("MESSAGE_EMPTY: Provide a non-empty message before retrying.");
    const recipientIds = [...new Set(input.recipientIds ?? [])];
    this.validateMessage(input.senderId, input.channel, recipientIds);
    const message: SocialMessage = {
      id: randomUUID(),
      roomId: this.roomId,
      senderId: input.senderId,
      senderName: sender.displayName,
      channel: input.channel,
      text: text.slice(0, 800),
      turn: this.currentTurn(),
      phase: this.currentPhase(),
      createdAt: new Date().toISOString(),
      ...(recipientIds.length ? { recipientIds } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {})
    };
    this.messages.push(message);
    if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500);
    this.emitUpdate();
    return structuredClone(message);
  }

  setAgentStatus(actorId: string, status: AgentStatus): void {
    if (!this.profiles.has(actorId)) return;
    this.statuses.set(actorId, status);
    this.emitUpdate();
  }

  onUpdate(listener: (snapshot: WorldSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected abstract currentTurn(): number;
  protected abstract currentPhase(): string;
  protected abstract isAlive(actorId: string): boolean;

  protected observerRole(_actorId: string): string | undefined {
    return undefined;
  }

  protected score(_actorId: string): number | undefined {
    return undefined;
  }

  protected validateMessage(senderId: string, channel: SocialChannel, recipientIds: string[]): void {
    if (!this.isAlive(senderId)) throw new Error("ACTOR_INACTIVE: This participant cannot send messages now.");
    if (channel === "private" && recipientIds.length === 0) {
      throw new Error("RECIPIENT_REQUIRED: Private messages require at least one recipientIds entry.");
    }
    for (const recipientId of recipientIds) this.requireProfile(recipientId);
    if (channel === "team") throw new Error("TEAM_CHANNEL_UNAVAILABLE: Use public or private in this scenario.");
  }

  protected visibleMessages(actorId: string): SocialMessage[] {
    return this.messages.filter((message) => {
      if (message.channel === "public") return true;
      if (message.senderId === actorId) return true;
      return message.recipientIds?.includes(actorId) ?? false;
    });
  }

  protected agentSnapshots(): WorldAgentSnapshot[] {
    return [...this.profiles.values()].map((profile) => ({
      id: profile.id,
      displayName: profile.displayName,
      status: this.statuses.get(profile.id) ?? "idle",
      alive: this.isAlive(profile.id),
      ...(this.score(profile.id) === undefined ? {} : { score: this.score(profile.id) }),
      ...(this.observerRole(profile.id) ? { observerRole: this.observerRole(profile.id) } : {})
    }));
  }

  protected worldSnapshot(input: {
    title: string;
    turn: number;
    totalTurns: number;
    phase: string;
    summary: string;
    details: Record<string, unknown>;
  }): WorldSnapshot {
    const finished = this.status === "finished";
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      title: input.title,
      status: this.status,
      turn: finished ? Math.min(input.turn, input.totalTurns) : input.turn,
      totalTurns: input.totalTurns,
      phase: finished ? "已结束" : input.phase,
      summary: input.summary,
      agents: this.agentSnapshots(),
      messages: structuredClone(this.messages.slice(-120)),
      story: structuredClone(this.story.slice(-80)),
      details: structuredClone(input.details)
    };
  }

  protected addStory(title: string, text: string, tone: StoryBeat["tone"] = "neutral", turn = this.currentTurn()): void {
    this.story.push({ id: randomUUID(), title, text, tone, turn, at: new Date().toISOString() });
    this.emitUpdate();
  }

  protected finish(): void {
    this.status = "finished";
    for (const id of this.profiles.keys()) this.statuses.set(id, "finished");
    this.emitUpdate();
  }

  protected emitUpdate(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(structuredClone(snapshot));
  }

  protected requireProfile(actorId: string): AgentProfile {
    const profile = this.profiles.get(actorId);
    if (!profile) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    return profile;
  }

  protected otherProfiles(actorId: string): AgentProfile[] {
    return [...this.profiles.values()].filter((profile) => profile.id !== actorId);
  }
}

export function contextFromRunContext(
  runContext: { context?: unknown } | undefined,
  fallback?: SocietyAgentContext
): SocietyAgentContext {
  const value = runContext?.context ?? fallback;
  if (!value || typeof value !== "object" || !("actorId" in value) || !("world" in value)) {
    throw new Error("RUN_CONTEXT_MISSING: Retry this tool inside an active agent run.");
  }
  return value as SocietyAgentContext;
}
