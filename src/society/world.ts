import { randomUUID } from "node:crypto";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  AgentStatus,
  PlayerActionSpec,
  ScenarioSummary,
  SocialChannel,
  SocialEvent,
  SocialMessage,
  SocialWorld,
  SocietyAgentContext,
  WorldActionCommit,
  WorldActivation,
  WorldAgentSnapshot,
  WorldLogEntry,
  WorldSnapshot
} from "./contracts";
import type { Tool } from "@openai/agents";

export abstract class SocialWorldBase implements SocialWorld {
  readonly roomId: string;
  readonly scenario: ScenarioSummary;

  protected readonly profiles: Map<string, AgentProfile>;
  protected readonly statuses = new Map<string, AgentStatus>();
  protected readonly messages: SocialMessage[] = [];
  protected readonly log: WorldLogEntry[] = [];
  protected readonly pendingEvents = new Map<string, SocialEvent[]>();
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
  /**
   * Return the view that may be sent to a browser. `snapshot()` is retained as
   * an internal state view for the rules engine; callers at the HTTP boundary
   * must always use this scoped method.
   */
  snapshotFor(actorId?: string): WorldSnapshot {
    const raw = this.snapshot();
    const visibleAgents = raw.agents.map((agent) => {
      const { observerRole, ...publicAgent } = agent;
      const roleVisible = this.roleVisibleTo(actorId, agent.id, agent.alive);
      return {
        ...publicAgent,
        ...(roleVisible && observerRole ? { observerRole } : {})
      };
    });
    const details = this.redactDetails(raw.details, actorId);
    const messages = actorId
      ? this.visibleMessages(actorId).slice(-120)
      : this.messages.slice(-120);
    return {
      ...raw,
      agents: visibleAgents,
      messages: structuredClone(messages),
      details
    };
  }

  abstract observe(actorId: string): AgentObservation;
  abstract toolsFor(actorId: string): Tool<SocietyAgentContext>[];
  abstract domainActionsFor(actorId: string): PlayerActionSpec[];
  abstract performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit>;
  playerActions(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    const actions: PlayerActionSpec[] = [];
    if (this.isAlive(actorId)) {
      actions.push({
        name: "message",
        label: "发言",
        description: "发送一条真实消息；消息会进入当前可见频道。",
        kind: "message",
        field: "text",
        channels: this.messageChannelsFor(actorId)
      });
    }
    actions.push(...this.domainActionsFor(actorId));
    return actions;
  }

  async performAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    if (action === "message" || action === "communicate") {
      const input = parseMessagePayload(payload);
      const message = await this.sendMessage({ senderId: actorId, ...input });
      return { action, detail: input.text, result: { messageId: message.id } };
    }
    return this.performDomainAction(actorId, action, payload);
  }

  abstract activation(): WorldActivation | null;
  abstract completeActivation(activation: WorldActivation): ActivationCompletion;
  abstract experienceFor(actorId: string): string | undefined;

  /** Returns and clears the appraisal events queued for one participant. */
  eventsFor(actorId: string): SocialEvent[] {
    const pending = this.pendingEvents.get(actorId) ?? [];
    this.pendingEvents.delete(actorId);
    return pending;
  }

  /** Queue a structured social event for one participant's appraisal engine. */
  protected pushEvent(actorId: string, input: Omit<SocialEvent, "id" | "turn" | "phase">): void {
    const event: SocialEvent = {
      ...input,
      id: randomUUID(),
      turn: this.currentTurn(),
      phase: this.currentPhase()
    };
    const list = this.pendingEvents.get(actorId) ?? [];
    list.push(event);
    if (list.length > 60) list.splice(0, list.length - 60);
    this.pendingEvents.set(actorId, list);
  }

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
      text,
      turn: this.currentTurn(),
      phase: this.currentPhase(),
      createdAt: new Date().toISOString(),
      ...(recipientIds.length ? { recipientIds } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(this.messageWave() === undefined ? {} : { wave: this.messageWave() })
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

  addWorldLog(text: string): void {
    this.addLog(text);
  }

  onUpdate(listener: (snapshot: WorldSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected abstract currentTurn(): number;
  protected abstract currentPhase(): string;
  protected abstract isAlive(actorId: string): boolean;

  /** Roles are private by default; dead roles are public after a reveal. */
  protected roleVisibleTo(viewerId: string | undefined, subjectId: string, alive: boolean): boolean {
    return !alive || viewerId === subjectId;
  }

  protected messageChannelsFor(_actorId: string): SocialChannel[] {
    return ["public", "private"];
  }

  /** Current discussion wave for message stamping; undefined outside discussions. */
  protected messageWave(): number | undefined {
    return undefined;
  }

  /** Remove pending/private domain state before a snapshot crosses a boundary. */
  protected redactDetails(details: Record<string, unknown>, actorId?: string): Record<string, unknown> {
    const next = structuredClone(details);
    for (const key of ["pendingChoices", "pendingContributions", "pendingVotes", "pendingNightTargets", "roles"]) {
      if (!(key in next)) continue;
      if (key === "roles" && actorId) {
        const roles = next[key];
        if (roles && typeof roles === "object" && !Array.isArray(roles)) {
          const own = (roles as Record<string, unknown>)[actorId];
          next[key] = own === undefined ? undefined : { [actorId]: own };
          continue;
        }
      }
      delete next[key];
    }
    return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
  }

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
      log: structuredClone(this.log.slice(-80)),
      details: structuredClone(input.details)
    };
  }

  protected addLog(text: string, turn = this.currentTurn()): void {
    this.log.push({ id: randomUUID(), text, turn, phase: this.currentPhase(), at: new Date().toISOString() });
    this.emitUpdate();
  }

  protected finish(): void {
    this.status = "finished";
    for (const id of this.profiles.keys()) this.statuses.set(id, "finished");
    this.emitUpdate();
  }

  protected emitUpdate(): void {
    const snapshot = this.snapshotFor();
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

function parseMessagePayload(payload: unknown): {
  text: string;
  channel: SocialChannel;
  recipientIds?: string[];
  replyTo?: string;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("MESSAGE_PAYLOAD_INVALID: Provide text, channel and optional recipientIds.");
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.text !== "string" || !value.text.trim()) {
    throw new Error("MESSAGE_EMPTY: Provide a non-empty message before retrying.");
  }
  if (value.text.length > 4_000) throw new Error("MESSAGE_TOO_LONG: Messages are limited to 4000 characters.");
  const channel = value.channel ?? "public";
  if (channel !== "public" && channel !== "private" && channel !== "team") {
    throw new Error("MESSAGE_CHANNEL_INVALID: Choose public, private or team.");
  }
  const recipients = value.recipientIds ?? [];
  if (!Array.isArray(recipients) || recipients.some((entry) => typeof entry !== "string")) {
    throw new Error("MESSAGE_RECIPIENTS_INVALID: recipientIds must be an array of participant ids.");
  }
  if (value.replyTo !== undefined && typeof value.replyTo !== "string") {
    throw new Error("MESSAGE_REPLY_INVALID: replyTo must be a message id.");
  }
  return {
    text: value.text,
    channel,
    ...(recipients.length ? { recipientIds: recipients } : {}),
    ...(typeof value.replyTo === "string" ? { replyTo: value.replyTo } : {})
  };
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

/**
 * Resolve the tool's execution context and verify it belongs to the agent
 * that owns the tool. Every tool is created bound to one participant; if the
 * SDK ever hands it a run context for a different actor (a cross-agent
 * context mix), the tool must refuse instead of acting as someone else.
 */
export function scopedContext(
  runContext: { context?: unknown } | undefined,
  expectedActorId: string,
  fallback?: SocietyAgentContext
): SocietyAgentContext {
  const value = contextFromRunContext(runContext, fallback);
  if (value.actorId !== expectedActorId) {
    throw new Error(`CROSS_AGENT_CONTEXT_DETECTED: tool bound to '${expectedActorId}' was invoked with context for '${value.actorId}'. Refusing to act.`);
  }
  return value;
}
