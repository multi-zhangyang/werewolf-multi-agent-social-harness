import { randomUUID } from "node:crypto";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  AgentStatus,
  Commitment,
  DecisionRecord,
  OpenCommitmentView,
  PlayerActionSpec,
  ScenarioId,
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
import { SocialCausalityLedger } from "./social/ledger";
import type {
  ActorModel,
  ActorModelInput,
  BeliefSelfReportInput,
  BeliefUpdateRecord,
  DeceptionEpisode,
  DeceptionPlanInput,
  MemoryWritePolicyResult,
  OutcomeReconciliation,
  OutcomeReconciliationInput,
  RelationshipDeltaRecord,
  RelationshipUpdateInput,
  SocialActDeclaration,
  SocialCausalityProjection,
  SocialCausalityState,
  StrategyProfileSnapshot
} from "./social/contracts";

/**
 * Serializable world state for restart recovery (P3). The base class owns the
 * shared stream (messages, log, statuses, queued appraisal events); each
 * scenario owns its private rules state under `world`. Everything here must
 * survive a JSON round-trip — maps travel as entry tuples, never as Maps.
 */
export interface WorldSerializedState {
  scenarioId: ScenarioId;
  shared: {
    status: WorldSnapshot["status"];
    statuses: Array<[string, AgentStatus]>;
    messages: SocialMessage[];
    log: WorldLogEntry[];
    pendingEvents: Array<[string, SocialEvent[]]>;
    socialCausality?: SocialCausalityState;
  };
  world: unknown;
}

export abstract class SocialWorldBase implements SocialWorld {
  readonly roomId: string;
  readonly scenario: ScenarioSummary;

  protected readonly profiles: Map<string, AgentProfile>;
  protected readonly statuses = new Map<string, AgentStatus>();
  protected readonly messages: SocialMessage[] = [];
  protected readonly log: WorldLogEntry[] = [];
  protected readonly pendingEvents = new Map<string, SocialEvent[]>();
  protected readonly socialCausality: SocialCausalityLedger;
  protected status: WorldSnapshot["status"] = "lobby";
  protected listeners = new Set<(snapshot: WorldSnapshot) => void>();

  /**
   * Command epoch gate (§16.6 / §17.1). The room opens one window per
   * activation and closes it when the activation fully settles; every
   * command entry point checks the gate first, so a tool call that arrives
   * late from a request the room already gave up on is rejected instead of
   * mutating a later phase. Idempotency receipts live inside one epoch:
   * retrying the same command returns the original receipt, while the same
   * payload in a later epoch is a brand-new command.
   */
  private commandEpoch = 0;
  private activationWindowOpen = false;
  private activeActivationId?: string;
  private readonly recentReceipts = new Map<string, WorldActionCommit>();
  private static readonly RECENT_RECEIPT_LIMIT = 64;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[]) {
    this.roomId = roomId;
    this.scenario = scenario;
    this.socialCausality = new SocialCausalityLedger(roomId);
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

  /** Serialize the whole world for a room checkpoint (restart recovery, P3). */
  exportState(): WorldSerializedState {
    return {
      scenarioId: this.scenario.id,
      shared: {
        status: this.status,
        statuses: [...this.statuses.entries()],
        messages: structuredClone(this.messages),
        log: structuredClone(this.log),
        pendingEvents: [...this.pendingEvents.entries()].map(([id, events]) => [id, structuredClone(events)] as [string, SocialEvent[]]),
        socialCausality: this.socialCausality.exportState()
      },
      world: this.exportWorldState()
    };
  }

  /** Rehydrate this world from a checkpoint; the scenario must be the same. */
  restoreState(state: WorldSerializedState): void {
    if (state.scenarioId !== this.scenario.id) {
      throw new Error(`SCENARIO_STATE_MISMATCH: checkpoint is ${state.scenarioId}, world is ${this.scenario.id}.`);
    }
    this.status = state.shared.status;
    this.statuses.clear();
    for (const [id, status] of state.shared.statuses) this.statuses.set(id, status);
    this.messages.length = 0;
    this.messages.push(...structuredClone(state.shared.messages));
    this.log.length = 0;
    this.log.push(...structuredClone(state.shared.log));
    this.pendingEvents.clear();
    for (const [id, events] of state.shared.pendingEvents) this.pendingEvents.set(id, structuredClone(events));
    this.socialCausality.restoreState(state.shared.socialCausality);
    for (const [actorId, events] of this.pendingEvents) {
      const characterId = this.requireProfile(actorId).characterId;
      for (const event of events) {
        if (event.sourceEventIds?.length) continue;
        event.sourceEventIds = [this.socialCausality.recordAppraisalObservation(actorId, characterId, event)];
      }
    }
    this.restoreWorldState(state.world);
  }

  protected abstract exportWorldState(): unknown;
  protected abstract restoreWorldState(state: unknown): void;

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
    const details = {
      ...this.redactDetails(raw.details, actorId),
      socialCausality: this.socialCausalityFor(actorId)
    };
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
    // A late tool call must not mutate the world once the room has closed
    // this activation's window (§16.6 / §28.7: 旧请求迟到并尝试调用工具,
    // command gateway 依据 activation epoch 拒绝).
    this.assertCommandGateOpen();
    this.requireProfile(actorId);
    const receiptKey = this.idempotencyKey(actorId, action, payload);
    const existing = this.recentReceipts.get(receiptKey);
    if (existing) return structuredClone(existing);
    let commit: WorldActionCommit;
    if (action === "message" || action === "communicate") {
      const input = parseMessagePayload(payload);
      const message = await this.sendMessage({ senderId: actorId, ...input });
      commit = { action, detail: input.text, result: { messageId: message.id }, commandId: `msg:${message.id}` };
    } else {
      const raw = await this.performDomainAction(actorId, action, payload);
      // A scenario may mint its own stable receipt (e.g. for a DecisionRecord);
      // otherwise the gate assigns one.
      commit = { ...raw, commandId: raw.commandId ?? randomUUID() };
    }
    this.socialCausality.recordAction({
      actorId,
      characterId: this.requireProfile(actorId).characterId,
      action,
      payload,
      commit,
      characterIdFor: (targetActorId) => this.requireProfile(targetActorId).characterId,
      ...(this.activeActivationId ? { activationId: this.activeActivationId } : {})
    });
    this.recentReceipts.set(receiptKey, structuredClone(commit));
    if (this.recentReceipts.size > SocialWorldBase.RECENT_RECEIPT_LIMIT) {
      const oldest = this.recentReceipts.keys().next().value;
      if (oldest !== undefined) this.recentReceipts.delete(oldest);
    }
    return structuredClone(commit);
  }

  beginActivation(activation: WorldActivation): void {
    this.commandEpoch += 1;
    this.activationWindowOpen = true;
    this.activeActivationId = activation.id;
    this.recentReceipts.clear();
  }

  endActivation(): void {
    this.activationWindowOpen = false;
    this.activeActivationId = undefined;
    this.recentReceipts.clear();
  }

  /** Current command gate state (observability / tests). */
  commandGate(): { open: boolean; epoch: number; activationId?: string } {
    return {
      open: this.activationWindowOpen,
      epoch: this.commandEpoch,
      ...(this.activeActivationId ? { activationId: this.activeActivationId } : {})
    };
  }

  private assertCommandGateOpen(): void {
    if (this.activationWindowOpen) return;
    const error = new Error(
      "STALE_ACTIVATION_COMMAND: The activation window is closed; this command arrived after the activation ended."
    );
    (error as Error & { code?: string }).code = "STALE_ACTIVATION_COMMAND";
    throw error;
  }

  /** Epoch-scoped idempotency key: same actor+action+payload, same receipt. */
  private idempotencyKey(actorId: string, action: string, payload: unknown): string {
    return `${this.commandEpoch}\u0000${actorId}\u0000${action}\u0000${stableJson(payload)}`;
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

  openCommitmentsFor(actorId: string): OpenCommitmentView[] {
    this.requireProfile(actorId);
    return this.socialCausality.openCommitmentsFor(actorId).map((commitment) => ({
      commitmentId: commitment.commitmentId,
      promisorActorId: commitment.promisorActorId,
      promisorCharacterId: commitment.promisorCharacterId,
      audienceActorIds: [...commitment.audienceActorIds],
      proposition: commitment.proposition,
      promisedAction: structuredClone(commitment.promisedAction),
      state: commitment.state,
      acceptedByActorIds: [...commitment.acceptedByActorIds],
      acceptedByCommandIds: [...commitment.acceptedByCommandIds]
    }));
  }

  protected recordSocialCommitment(commitment: Commitment): void {
    this.socialCausality.recordCommitment(commitment, [...this.profiles.keys()]);
  }

  protected acceptSocialCommitment(commitment: Commitment, acceptorActorId: string, commandId: string): void {
    this.socialCausality.acceptCommitment({
      commitment,
      acceptorActorId,
      acceptorCharacterId: this.requireProfile(acceptorActorId).characterId,
      commandId,
      allActorIds: [...this.profiles.keys()]
    });
  }

  protected settleSocialCommitment(commitment: Commitment): void {
    this.socialCausality.settleCommitment(commitment, [...this.profiles.keys()]);
  }

  protected recordIdentityAssignment(subjectActorId: string, roleId: string, observerActorIds: string[]): void {
    const subject = this.requireProfile(subjectActorId);
    for (const observerActorId of observerActorIds) this.requireProfile(observerActorId);
    this.socialCausality.recordIdentityAssignment({
      subjectActorId,
      subjectCharacterId: subject.characterId,
      roleId,
      observerActorIds,
      characterIdFor: (actorId) => this.requireProfile(actorId).characterId
    });
  }

  recordStrategyProfileSnapshot(input: StrategyProfileSnapshot): StrategyProfileSnapshot {
    const profile = this.requireProfile(input.actorId);
    if (profile.characterId !== input.characterId) {
      throw new Error("STRATEGY_PROFILE_IDENTITY_MISMATCH: Snapshot character does not own this actor.");
    }
    return this.socialCausality.recordStrategyProfileSnapshot(input);
  }

  recordRuntimeNotice(input: Extract<import("./contracts").AgentRuntimeEvent, { type: "runtime.notice" }>): void {
    const characterId = input.actorId ? this.requireProfile(input.actorId).characterId : undefined;
    this.socialCausality.recordRuntimeNotice({
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(characterId ? { characterId } : {}),
      category: input.category,
      severity: input.severity,
      code: input.code,
      message: input.message,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.requestedEffort ? { requestedEffort: input.requestedEffort } : {}),
      ...(input.effectiveEffort ? { effectiveEffort: input.effectiveEffort } : {}),
      ...(input.retrying === undefined ? {} : { retrying: input.retrying })
    });
  }

  protected recordFactionAssignment(subjectActorId: string, factionId: string, observerActorIds: string[]): void {
    const subject = this.requireProfile(subjectActorId);
    for (const observerActorId of observerActorIds) this.requireProfile(observerActorId);
    this.socialCausality.recordFactionAssignment({
      subjectActorId,
      subjectCharacterId: subject.characterId,
      factionId,
      observerActorIds,
      characterIdFor: (actorId) => this.requireProfile(actorId).characterId
    });
  }

  protected recordFactionObservation(
    observerActorId: string,
    subjectActorId: string,
    perceivedFactionId: string,
    sourceCommandId?: string
  ): void {
    this.socialCausality.recordFactionObservation({
      observerActorId,
      observerCharacterId: this.requireProfile(observerActorId).characterId,
      subjectActorId,
      subjectCharacterId: this.requireProfile(subjectActorId).characterId,
      perceivedFactionId,
      ...(sourceCommandId ? { sourceCommandId } : {})
    });
  }

  protected recordPrivateObservation(input: {
    observerActorId: string;
    subjectActorId?: string;
    eventType: string;
    predicate: string;
    object?: unknown;
    sourceCommandId?: string;
    payload?: Record<string, unknown>;
    kind?: import("./social/contracts").Proposition["kind"];
  }): void {
    this.socialCausality.recordPrivateObservation({
      observerActorId: input.observerActorId,
      observerCharacterId: this.requireProfile(input.observerActorId).characterId,
      ...(input.subjectActorId ? { subjectCharacterId: this.requireProfile(input.subjectActorId).characterId } : {}),
      eventType: input.eventType,
      predicate: input.predicate,
      ...(input.object === undefined ? {} : { object: input.object }),
      ...(input.sourceCommandId ? { sourceCommandId: input.sourceCommandId } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
      ...(input.kind ? { kind: input.kind } : {})
    });
  }

  protected recordPublicWorldFact(input: {
    factKey: string;
    eventType: string;
    subjectActorId?: string;
    subjectId?: string;
    predicate: string;
    object?: unknown;
    payload?: Record<string, unknown>;
    kind?: import("./social/contracts").Proposition["kind"];
  }): { eventId: string; propositionId: string; evidenceId: string } {
    const subjectId = input.subjectActorId
      ? this.requireProfile(input.subjectActorId).characterId
      : input.subjectId;
    return this.socialCausality.recordPublicWorldFact({
      factKey: input.factKey,
      eventType: input.eventType,
      ...(subjectId ? { subjectId } : {}),
      predicate: input.predicate,
      ...(input.object === undefined ? {} : { object: input.object }),
      ...(input.payload ? { payload: input.payload } : {}),
      ...(input.kind ? { kind: input.kind } : {})
    });
  }

  protected recordIdentityObservation(
    observerActorId: string,
    subjectActorId: string,
    perceivedRoleId: string,
    sourceCommandId?: string
  ): void {
    this.socialCausality.recordIdentityObservation({
      observerActorId,
      observerCharacterId: this.requireProfile(observerActorId).characterId,
      subjectActorId,
      subjectCharacterId: this.requireProfile(subjectActorId).characterId,
      perceivedRoleId,
      ...(sourceCommandId ? { sourceCommandId } : {})
    });
  }

  protected revealIdentity(subjectActorId: string, actualRoleId: string): string[] {
    return this.socialCausality.revealIdentity({
      subjectActorId,
      subjectCharacterId: this.requireProfile(subjectActorId).characterId,
      actualRoleId,
      actorIdForCharacter: (characterId) => [...this.profiles.values()].find((profile) => profile.characterId === characterId)?.id
    }).detectedDeceptionIds;
  }

  /** Scenarios with decision records override this (§5.4 / Phase 1). */
  decisionRecords(): DecisionRecord[] {
    return [];
  }

  socialCausalityFor(actorId?: string, omniscient = false): SocialCausalityProjection {
    const characterId = actorId ? this.requireProfile(actorId).characterId : undefined;
    return this.socialCausality.project({
      ...(actorId ? { actorId } : {}),
      ...(characterId ? { characterId } : {}),
      ...(omniscient ? { omniscient: true } : {})
    });
  }

  recordBeliefUpdate(actorId: string, input: BeliefSelfReportInput): BeliefUpdateRecord {
    const profile = this.requireProfile(actorId);
    const visibleMessageIds = new Set(this.visibleMessages(actorId).map((message) => message.id));
    for (const messageId of input.sourceMessageIds ?? []) {
      if (!visibleMessageIds.has(messageId)) {
        throw new Error(`BELIEF_SOURCE_NOT_VISIBLE: '${messageId}' is not visible to '${actorId}'.`);
      }
    }
    const visibleEvidenceIds = new Set(this.socialCausalityFor(actorId).evidence.map((entry) => entry.evidenceId));
    for (const evidenceId of input.sourceEvidenceIds ?? []) {
      if (!visibleEvidenceIds.has(evidenceId)) {
        throw new Error(`BELIEF_EVIDENCE_NOT_VISIBLE: '${evidenceId}' is not visible to '${actorId}'.`);
      }
    }
    const subjectCharacterId = this.profiles.get(input.subjectId)?.characterId ?? input.subjectId;
    return this.socialCausality.recordBeliefUpdate(actorId, profile.characterId, {
      ...input,
      subjectId: subjectCharacterId
    });
  }

  recordActorModel(actorId: string, input: ActorModelInput): ActorModel {
    const profile = this.requireProfile(actorId);
    const target = this.requireProfile(input.targetActorId);
    if (target.id === actorId) throw new Error("ACTOR_MODEL_TARGET_INVALID: An actor model must describe another participant.");
    const visibleMessageIds = new Set(this.visibleMessages(actorId).map((message) => message.id));
    for (const messageId of input.sourceMessageIds ?? []) {
      if (!visibleMessageIds.has(messageId)) {
        throw new Error(`ACTOR_MODEL_SOURCE_NOT_VISIBLE: '${messageId}' is not visible to '${actorId}'.`);
      }
    }
    const visibleEvidenceIds = new Set(this.socialCausalityFor(actorId).evidence.map((entry) => entry.evidenceId));
    for (const evidenceId of input.sourceEvidenceIds ?? []) {
      if (!visibleEvidenceIds.has(evidenceId)) {
        throw new Error(`ACTOR_MODEL_EVIDENCE_NOT_VISIBLE: '${evidenceId}' is not visible to '${actorId}'.`);
      }
    }
    return this.socialCausality.recordActorModel(actorId, profile.characterId, target.characterId, input);
  }

  recordRelationshipUpdate(actorId: string, input: RelationshipUpdateInput): RelationshipDeltaRecord {
    const profile = this.requireProfile(actorId);
    const target = this.requireProfile(input.targetActorId);
    if (target.id === actorId) throw new Error("RELATIONSHIP_TARGET_INVALID: A relationship must point to another participant.");
    const visibleMessageIds = new Set(this.visibleMessages(actorId).map((message) => message.id));
    for (const messageId of input.sourceMessageIds ?? []) {
      if (!visibleMessageIds.has(messageId)) {
        throw new Error(`RELATIONSHIP_SOURCE_NOT_VISIBLE: '${messageId}' is not visible to '${actorId}'.`);
      }
    }
    const visibleEvidenceIds = new Set(this.socialCausalityFor(actorId).evidence.map((entry) => entry.evidenceId));
    for (const evidenceId of input.sourceEvidenceIds ?? []) {
      if (!visibleEvidenceIds.has(evidenceId)) {
        throw new Error(`RELATIONSHIP_EVIDENCE_NOT_VISIBLE: '${evidenceId}' is not visible to '${actorId}'.`);
      }
    }
    const visibleEventIds = new Set(this.socialCausalityFor(actorId).events.map((event) => event.eventId));
    for (const eventId of input.sourceEventIds ?? []) {
      if (!visibleEventIds.has(eventId)) {
        throw new Error(`RELATIONSHIP_EVENT_NOT_VISIBLE: '${eventId}' is not visible to '${actorId}'.`);
      }
    }
    return this.socialCausality.recordRelationshipUpdate(actorId, profile.characterId, target.characterId, input);
  }

  recordDeceptionPlan(actorId: string, input: DeceptionPlanInput): DeceptionEpisode {
    const profile = this.requireProfile(actorId);
    const targets = [...new Set(input.targetActorIds)];
    for (const target of targets) {
      this.requireProfile(target);
      if (target === actorId) throw new Error("DECEPTION_TARGET_INVALID: An actor cannot target itself.");
    }
    return this.socialCausality.recordDeceptionPlan(
      actorId,
      profile.characterId,
      { ...input, targetActorIds: targets },
      (targetActorId) => this.requireProfile(targetActorId).characterId
    );
  }

  /** Connect a committed action to the deterministic result without writing memory directly. */
  protected reconcileSocialOutcome(input: OutcomeReconciliationInput): OutcomeReconciliation {
    return this.socialCausality.recordOutcomeReconciliation(input);
  }

  applyMemoryWritePolicy(actorId: string): MemoryWritePolicyResult {
    this.requireProfile(actorId);
    return this.socialCausality.applyMemoryWritePolicy(actorId);
  }

  reconciliationOwnsOutcomeMemory(): boolean {
    return false;
  }

  /** Queue a structured social event for one participant's appraisal engine. */
  protected pushEvent(actorId: string, input: Omit<SocialEvent, "id" | "turn" | "phase">): void {
    const event: SocialEvent = {
      ...input,
      id: randomUUID(),
      turn: this.currentTurn(),
      phase: this.currentPhase()
    };
    event.sourceEventIds = [this.socialCausality.recordAppraisalObservation(
      actorId,
      this.requireProfile(actorId).characterId,
      event
    )];
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
    socialActs?: SocialActDeclaration[];
  }): Promise<SocialMessage> {
    const sender = this.requireProfile(input.senderId);
    const text = input.text.trim();
    if (!text) throw new Error("MESSAGE_EMPTY: Provide a non-empty message before retrying.");
    const recipientIds = [...new Set(input.recipientIds ?? [])];
    this.validateMessage(input.senderId, input.channel, recipientIds);
    if (input.replyTo) this.validateReply(input.senderId, input.channel, recipientIds, input.replyTo);
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
    this.socialCausality.recordMessage({
      message,
      declarations: input.socialActs ?? [],
      allActorIds: [...this.profiles.keys()],
      characterIdFor: (actorId) => this.requireProfile(actorId).characterId
    });
    this.messages.push(message);
    this.queueMessageAppraisals(message, input.socialActs ?? []);
    if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500);
    this.emitUpdate();
    return structuredClone(message);
  }

  private queueMessageAppraisals(message: SocialMessage, declarations: SocialActDeclaration[]): void {
    const eventTypeFor = (kind: SocialActDeclaration["kind"]): SocialEvent["type"] | undefined => {
      switch (kind) {
        case "accusation": return "accused";
        case "defense": return "defended";
        case "threat": return "threatened";
        case "endorsement": return "endorsed";
        case "apology": return "apologized-to";
        case "warning": return "warning-received";
        case "acceptance": return "socially-accepted";
        case "rejection": return "socially-rejected";
        case "alliance-proposal": return "alliance-proposed";
        case "offer": return "offer-proposed";
        case "promise": return "commitment-proposed";
        default: return undefined;
      }
    };
    for (const declaration of declarations) {
      const type = eventTypeFor(declaration.kind);
      if (!type) continue;
      for (const targetId of new Set(declaration.targetActorIds ?? [])) {
        if (targetId === message.senderId) continue;
        const duplicateThisPhase = (this.pendingEvents.get(targetId) ?? []).some((event) =>
          event.type === type
          && event.actorId === message.senderId
          && event.turn === message.turn
          && event.phase === message.phase
        );
        if (duplicateThisPhase) continue;
        this.pushEvent(targetId, {
          type,
          actorId: message.senderId,
          targetId,
          facts: { messageId: message.id, socialActKind: declaration.kind },
          detail: `${message.senderName}: ${message.text.slice(0, 500)}`
        });
      }
    }
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
    for (const key of ["pendingChoices", "pendingContributions", "pendingVotes", "pendingNightTargets", "pendingDemands", "pendingTeamVotes", "pendingQuestVotes", "hiddenDice", "decisionRecords", "roles"]) {
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

  private validateReply(senderId: string, channel: SocialChannel, recipientIds: string[], replyTo: string): void {
    const original = this.messages.find((message) => message.id === replyTo);
    if (!original || !this.visibleMessages(senderId).some((message) => message.id === replyTo)) {
      throw new Error(`MESSAGE_REPLY_NOT_VISIBLE: '${replyTo}' is not a message visible to '${senderId}'.`);
    }
    if (original.channel === "public") return;
    if (channel === "public") {
      throw new Error("MESSAGE_REPLY_VISIBILITY_INVALID: A public message cannot expose a private or team reply link.");
    }
    const originalAudience = new Set([original.senderId, ...(original.recipientIds ?? [])]);
    const replyAudience = new Set([senderId, ...recipientIds]);
    for (const actorId of replyAudience) {
      if (!originalAudience.has(actorId)) {
        throw new Error(`MESSAGE_REPLY_AUDIENCE_INVALID: '${actorId}' could not see the original message.`);
      }
    }
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
      characterId: profile.characterId,
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

  protected addLog(text: string, turn = this.currentTurn(), beat?: WorldLogEntry["beat"]): void {
    // Consecutive identical entries (retry notes, repeated system errors) are
    // noise for observers — collapse them into one timeline line per turn.
    const previous = this.log.at(-1);
    if (previous && previous.text === text && previous.turn === turn) {
      previous.at = new Date().toISOString();
      return;
    }
    const entry: WorldLogEntry = {
      id: randomUUID(),
      text,
      turn,
      phase: this.currentPhase(),
      at: new Date().toISOString(),
      ...(beat ? { beat } : {})
    };
    this.log.push(entry);
    this.socialCausality.recordWorldLog(entry);
    this.emitUpdate();
  }

  protected finish(): void {
    this.socialCausality.closeOpenDeceptions();
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

  /** JSON-safe serialization helpers for scenario state maps. */
  protected mapEntries<K, V>(map: Map<K, V>): Array<[K, V]> {
    return [...map.entries()];
  }

  protected fillMap<K, V>(target: Map<K, V>, entries: unknown): void {
    target.clear();
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (Array.isArray(entry) && entry.length >= 2) target.set(entry[0] as K, entry[1] as V);
    }
  }
}

/**
 * Key-order-independent JSON for command idempotency: tool payloads built by
 * different callers with the same semantics hash identically, so a network
 * retry of the exact same command resolves to the original receipt.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseMessagePayload(payload: unknown): {
  text: string;
  channel: SocialChannel;
  recipientIds?: string[];
  replyTo?: string;
  socialActs?: SocialActDeclaration[];
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
  const socialActs = parseSocialActDeclarations(value.socialActs);
  return {
    text: value.text,
    channel,
    ...(recipients.length ? { recipientIds: recipients } : {}),
    ...(typeof value.replyTo === "string" ? { replyTo: value.replyTo } : {}),
    ...(socialActs.length ? { socialActs } : {})
  };
}

const SOCIAL_ACT_KINDS = new Set<SocialActDeclaration["kind"]>([
  "assertion", "denial", "question", "answer", "promise", "offer", "acceptance", "rejection",
  "request", "threat", "accusation", "defense", "apology", "alliance-proposal", "disclosure",
  "endorsement", "warning", "silence"
]);

const PROPOSITION_KINDS = new Set([
  "world-state", "identity", "past-action", "future-action", "preference", "intention",
  "relationship", "norm", "evaluation"
]);

function parseSocialActDeclarations(value: unknown): SocialActDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 6) {
    throw new Error("SOCIAL_ACTS_INVALID: socialActs must be an array with at most 6 declarations.");
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`SOCIAL_ACT_INVALID: socialActs[${index}] must be an object.`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.kind !== "string" || !SOCIAL_ACT_KINDS.has(entry.kind as SocialActDeclaration["kind"])) {
      throw new Error(`SOCIAL_ACT_KIND_INVALID: socialActs[${index}].kind is not supported.`);
    }
    const targets = entry.targetActorIds ?? [];
    if (!Array.isArray(targets) || targets.length > 20 || targets.some((target) => typeof target !== "string")) {
      throw new Error(`SOCIAL_ACT_TARGETS_INVALID: socialActs[${index}].targetActorIds must contain participant ids.`);
    }
    let proposition: SocialActDeclaration["proposition"];
    if (entry.proposition !== undefined) {
      if (!entry.proposition || typeof entry.proposition !== "object" || Array.isArray(entry.proposition)) {
        throw new Error(`SOCIAL_ACT_PROPOSITION_INVALID: socialActs[${index}].proposition must be an object.`);
      }
      const candidate = entry.proposition as Record<string, unknown>;
      if (typeof candidate.predicate !== "string" || !candidate.predicate.trim() || candidate.predicate.length > 500) {
        throw new Error(`SOCIAL_ACT_PREDICATE_INVALID: socialActs[${index}].proposition.predicate is required.`);
      }
      if (candidate.kind !== undefined && (typeof candidate.kind !== "string" || !PROPOSITION_KINDS.has(candidate.kind))) {
        throw new Error(`SOCIAL_ACT_PROPOSITION_KIND_INVALID: socialActs[${index}].proposition.kind is not supported.`);
      }
      if (candidate.subjectId !== undefined && typeof candidate.subjectId !== "string") {
        throw new Error(`SOCIAL_ACT_SUBJECT_INVALID: socialActs[${index}].proposition.subjectId must be a string.`);
      }
      proposition = {
        ...(typeof candidate.kind === "string" ? { kind: candidate.kind as NonNullable<SocialActDeclaration["proposition"]>["kind"] } : {}),
        ...(typeof candidate.subjectId === "string" ? { subjectId: candidate.subjectId } : {}),
        predicate: candidate.predicate.trim(),
        ...(candidate.object === undefined ? {} : { object: structuredClone(candidate.object) })
      };
    }
    if (entry.confidence !== undefined && (typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1)) {
      throw new Error(`SOCIAL_ACT_CONFIDENCE_INVALID: socialActs[${index}].confidence must be between 0 and 1.`);
    }
    if (entry.deceptionId !== undefined && typeof entry.deceptionId !== "string") {
      throw new Error(`SOCIAL_ACT_DECEPTION_INVALID: socialActs[${index}].deceptionId must be a deception id.`);
    }
    if (entry.repairDeceptionId !== undefined && typeof entry.repairDeceptionId !== "string") {
      throw new Error(`SOCIAL_ACT_REPAIR_DECEPTION_INVALID: socialActs[${index}].repairDeceptionId must be a deception id.`);
    }
    return {
      kind: entry.kind as SocialActDeclaration["kind"],
      ...(targets.length ? { targetActorIds: [...new Set(targets as string[])] } : {}),
      ...(proposition ? { proposition } : {}),
      ...(typeof entry.confidence === "number" ? { confidence: entry.confidence } : {}),
      ...(typeof entry.deceptionId === "string" ? { deceptionId: entry.deceptionId } : {}),
      ...(typeof entry.repairDeceptionId === "string" ? { repairDeceptionId: entry.repairDeceptionId } : {})
    };
  });
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
