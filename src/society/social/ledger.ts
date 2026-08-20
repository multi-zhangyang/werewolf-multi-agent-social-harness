import { createHash, randomUUID } from "node:crypto";
import type { Commitment, SocialEvent, SocialMessage, WorldActionCommit, WorldLogEntry } from "../contracts";
import type {
  ActorModel,
  ActorModelInput,
  BeliefSelfReportInput,
  BeliefUpdateRecord,
  CandidateIntent,
  CommitmentRecord,
  DeceptionEpisode,
  DeceptionPlanInput,
  EventEnvelope,
  EvidenceRecord,
  InfluenceLink,
  MemoryWritePolicyResult,
  OutcomePrediction,
  OutcomeReconciliation,
  OutcomeReconciliationInput,
  Proposition,
  RelationshipDeltaRecord,
  RelationshipDimensions,
  RelationshipUpdateInput,
  DirectedRelationshipState,
  SocialActDeclaration,
  SocialActRecord,
  SocialCausalityProjection,
  SocialCausalityState,
  SocialDecisionRecord,
  StrategyProfileSnapshot,
  StrategySelection,
  VisibilityPolicy
} from "./contracts";
import { createShadowStrategyRecommendation } from "./strategy-selector";

export const SOCIAL_CAUSALITY_SCHEMA_VERSION = 6;

interface ViewerContext {
  actorId?: string;
  characterId?: string;
  omniscient?: boolean;
}

interface MessageContext {
  message: SocialMessage;
  declarations: SocialActDeclaration[];
  allActorIds: string[];
  characterIdFor(actorId: string): string;
}

/** Single writer for canonical social-causality records owned by one room. */
export class SocialCausalityLedger {
  private sequence = 0;
  private readonly events: EventEnvelope[] = [];
  private readonly propositions = new Map<string, Proposition>();
  private readonly socialActs: SocialActRecord[] = [];
  private readonly evidence: EvidenceRecord[] = [];
  private readonly beliefUpdates: BeliefUpdateRecord[] = [];
  private readonly actorModels = new Map<string, ActorModel>();
  private readonly directedRelationships = new Map<string, DirectedRelationshipState>();
  private readonly relationshipDeltas: RelationshipDeltaRecord[] = [];
  private readonly commitments = new Map<string, CommitmentRecord>();
  private readonly candidateIntents: CandidateIntent[] = [];
  private readonly strategyProfileSnapshots = new Map<string, StrategyProfileSnapshot>();
  private readonly activeStrategyProfileSnapshotIds = new Map<string, string>();
  private readonly strategySelections: StrategySelection[] = [];
  private readonly decisions: SocialDecisionRecord[] = [];
  private readonly influenceLinks: InfluenceLink[] = [];
  private readonly outcomeReconciliations: OutcomeReconciliation[] = [];
  private readonly deceptions = new Map<string, DeceptionEpisode>();

  constructor(private readonly roomId: string) {}

  recordStrategyProfileSnapshot(input: StrategyProfileSnapshot): StrategyProfileSnapshot {
    if (!input.actorId || !input.characterId) throw new Error("STRATEGY_PROFILE_IDENTITY_REQUIRED: actorId and characterId are required.");
    const existing = this.strategyProfileSnapshots.get(input.strategyProfileSnapshotId);
    if (existing) {
      if (existing.configurationHash !== input.configurationHash) {
        throw new Error(`STRATEGY_PROFILE_HASH_COLLISION: '${input.strategyProfileSnapshotId}'.`);
      }
      this.activeStrategyProfileSnapshotIds.set(input.actorId, existing.strategyProfileSnapshotId);
      return structuredClone(existing);
    }
    const envelope = this.append("agent-trace", "strategy-profile.snapshot-created", {
      strategyProfileSnapshotId: input.strategyProfileSnapshotId,
      configurationHash: input.configurationHash,
      modelProfileId: input.modelConfig.modelProfileId,
      strategyVersion: input.strategyVersion
    }, {
      actorId: input.actorId,
      characterId: input.characterId,
      visibility: { kind: "actors", actorIds: [input.actorId] }
    });
    const snapshot = structuredClone(input);
    snapshot.createdAtLogical = envelope.logicalTime;
    snapshot.createdAt = envelope.wallTime;
    this.strategyProfileSnapshots.set(snapshot.strategyProfileSnapshotId, snapshot);
    this.activeStrategyProfileSnapshotIds.set(snapshot.actorId, snapshot.strategyProfileSnapshotId);
    return structuredClone(snapshot);
  }

  recordRuntimeNotice(input: {
    actorId?: string;
    characterId?: string;
    category: "reasoning" | "provider" | "persistence";
    severity: "info" | "warning" | "error";
    code: string;
    message: string;
    modelId?: string;
    requestedEffort?: "xhigh" | "high";
    effectiveEffort?: "high" | "provider-default";
    retrying?: boolean;
  }): EventEnvelope {
    return this.append("agent-trace", "runtime.notice", {
      category: input.category,
      severity: input.severity,
      code: input.code,
      message: input.message.trim().slice(0, 500),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.requestedEffort ? { requestedEffort: input.requestedEffort } : {}),
      ...(input.effectiveEffort ? { effectiveEffort: input.effectiveEffort } : {}),
      ...(input.retrying === undefined ? {} : { retrying: input.retrying })
    }, {
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.characterId ? { characterId: input.characterId } : {}),
      visibility: input.actorId ? { kind: "actors", actorIds: [input.actorId] } : { kind: "operator" }
    });
  }

  recordMessage(context: MessageContext): string[] {
    const { message, declarations, allActorIds, characterIdFor } = context;
    const audienceActorIds = message.channel === "public"
      ? [...allActorIds]
      : [...new Set([message.senderId, ...(message.recipientIds ?? [])])];
    const visibility: VisibilityPolicy = message.channel === "public"
      ? { kind: "public" }
      : { kind: "actors", actorIds: audienceActorIds };
    for (const declaration of declarations) {
      const targets = [...new Set(declaration.targetActorIds ?? [])];
      for (const target of targets) {
        if (!allActorIds.includes(target)) throw new Error(`SOCIAL_ACT_TARGET_INVALID: '${target}' is not in this room.`);
        if (message.channel !== "public" && !audienceActorIds.includes(target)) {
          throw new Error(`SOCIAL_ACT_VISIBILITY_INVALID: '${target}' cannot receive this ${message.channel} message.`);
        }
      }
      if (declaration.deceptionId) {
        const episode = this.deceptions.get(declaration.deceptionId);
        if (!episode) throw new Error(`DECEPTION_NOT_FOUND: '${declaration.deceptionId}'.`);
        if (episode.deceiverActorId !== message.senderId) {
          throw new Error("DECEPTION_OWNER_MISMATCH: Only the planner may execute this deception.");
        }
      }
      if (declaration.deceptionId && declaration.repairDeceptionId) {
        throw new Error("DECEPTION_ACT_CONFLICT: A social act cannot execute and repair a deception simultaneously.");
      }
      if (declaration.repairDeceptionId) {
        const episode = this.deceptions.get(declaration.repairDeceptionId);
        if (!episode) throw new Error(`DECEPTION_NOT_FOUND: '${declaration.repairDeceptionId}'.`);
        this.assertDeceptionRepairAllowed(episode, declaration.kind, message.senderId, audienceActorIds);
      }
    }
    const envelope = this.append("domain", "message.sent", {
      messageId: message.id,
      channel: message.channel,
      recipientActorIds: message.recipientIds ?? [],
      replyToMessageId: message.replyTo,
      text: message.text
    }, {
      actorId: message.senderId,
      characterId: characterIdFor(message.senderId),
      visibility
    });

    const actIds: string[] = [];
    for (const declaration of declarations) {
      const targets = [...new Set(declaration.targetActorIds ?? [])];
      const propositionIds: string[] = [];
      if (declaration.proposition) {
        const proposition = this.upsertProposition({
          kind: declaration.proposition.kind ?? propositionKindFor(declaration.kind),
          ...(declaration.proposition.subjectId ? {
            subjectId: allActorIds.includes(declaration.proposition.subjectId)
              ? characterIdFor(declaration.proposition.subjectId)
              : declaration.proposition.subjectId
          } : {}),
          predicate: declaration.proposition.predicate.trim(),
          ...(declaration.proposition.object === undefined ? {} : { object: declaration.proposition.object }),
          truthStatus: declaration.kind === "promise" ? "future-contingent" : "unknown",
          groundTruthVisibility: declaration.kind === "question" || declaration.kind === "apology"
            ? "no-objective-ground-truth"
            : "hidden-until-resolution",
          sourceEventId: envelope.eventId
        });
        propositionIds.push(proposition.propositionId);
      }
      const act: SocialActRecord = {
        socialActId: `social-act-${randomUUID()}`,
        kind: declaration.kind,
        messageId: message.id,
        actorId: message.senderId,
        actorCharacterId: characterIdFor(message.senderId),
        audienceActorIds,
        targetActorIds: targets,
        propositionIds,
        confidence: clamp01(declaration.confidence ?? 1),
        extractionMethod: "explicit-tool",
        logicalTime: envelope.logicalTime,
        sourceEventId: envelope.eventId,
        ...(declaration.deceptionId ? { deceptionId: declaration.deceptionId } : {}),
        ...(declaration.repairDeceptionId ? { repairDeceptionId: declaration.repairDeceptionId } : {})
      };
      this.socialActs.push(act);
      actIds.push(act.socialActId);
      const { deceptionId: _privateDeceptionId, ...audienceSafeAct } = act;
      this.append("social", `social-act.${act.kind}`, audienceSafeAct, {
        actorId: message.senderId,
        characterId: characterIdFor(message.senderId),
        causationId: envelope.eventId,
        visibility
      });

      for (const propositionId of propositionIds) {
        const observerCharacterIds = message.channel === "public"
          ? ["public"]
          : audienceActorIds.map((observerActorId) => characterIdFor(observerActorId));
        for (const observerCharacterId of observerCharacterIds) {
          this.evidence.push({
            evidenceId: `evidence-${randomUUID()}`,
            observerCharacterId,
            propositionId,
            sourceType: message.channel === "public" ? "public-message" : message.channel === "private" ? "private-message" : "team-message",
            sourceActorId: message.senderId,
            sourceEventId: envelope.eventId,
            sourceMessageId: message.id,
            supports: declaration.kind !== "denial",
            strength: clamp01(declaration.confidence ?? 0.7),
            sourceReliability: 0.5,
            visibility: message.channel === "public" ? "public" : "private",
            logicalTime: envelope.logicalTime
          });
        }
      }

      if (declaration.deceptionId) {
        this.markDeceptionExecuted(
          declaration.deceptionId,
          message,
          audienceActorIds,
          propositionIds,
          characterIdFor
        );
      }
      if (declaration.repairDeceptionId) {
        this.recordDeceptionRepair(
          declaration.repairDeceptionId,
          declaration.kind,
          message,
          audienceActorIds,
          visibility,
          characterIdFor
        );
      }
    }
    return actIds;
  }

  recordAction(input: {
    actorId: string;
    characterId: string;
    action: string;
    payload: unknown;
    commit: WorldActionCommit;
    activationId?: string;
    characterIdFor(actorId: string): string;
  }): SocialDecisionRecord {
    const committedMessageId = shortText(asRecord(input.commit.result).messageId, 160);
    const observationRefs = this.recentVisibleEventIds(input.actorId, 12, committedMessageId
      ? (event) => shortText(asRecord(event.payload).messageId, 160) !== committedMessageId
      : undefined);
    const receiptId = input.commit.commandId ?? `receipt-${randomUUID()}`;
    const envelope = this.append("domain", "command.committed", {
      action: input.action,
      receiptId,
      detail: input.commit.detail
    }, {
      actorId: input.actorId,
      characterId: input.characterId,
      correlationId: input.activationId,
      visibility: { kind: "actors", actorIds: [input.actorId] }
    });
    const payload = asRecord(input.payload);
    const evidenceRefs = this.visibleEvidenceRefs(input.characterId, stringArray(payload.referencedEvidenceIds));
    const relevantBeliefIds = this.ownedBeliefRefs(input.characterId, stringArray(payload.referencedBeliefIds));
    const relevantActorModelIds = this.ownedActorModelRefs(input.characterId, stringArray(payload.referencedActorModelIds));
    const relevantRelationshipIds = this.ownedRelationshipRefs(input.characterId, stringArray(payload.referencedRelationshipIds));
    const committedCommitmentId = shortText(asRecord(input.commit.result).commitmentId, 200);
    const openCommitmentIds = this.visibleCommitmentRefs(input.actorId, [
      ...stringArray(payload.referencedCommitmentIds),
      ...(committedCommitmentId ? [committedCommitmentId] : [])
    ]);
    const activeDeceptionIds = this.ownedDeceptionRefs(input.actorId, stringArray(payload.referencedDeceptionIds));
    const predictedConsequences = parseOutcomePredictions(payload.predictedConsequences);
    const candidates = this.buildCandidateIntents({
      actorId: input.actorId,
      characterId: input.characterId,
      action: input.action,
      payload,
      evidenceRefs,
      relevantBeliefIds,
      relevantActorModelIds,
      logicalTime: envelope.logicalTime,
      ...(input.activationId ? { activationId: input.activationId } : {}),
      characterIdFor: input.characterIdFor
    });
    this.candidateIntents.push(...candidates);
    const requestedIndex = integerInRange(payload.selectedIntentIndex, 0, candidates.length - 1);
    const requested = candidates[requestedIndex ?? 0];
    const selected = requested.possibleActions.some((possible) => possible.action === input.action)
      ? requested
      : candidates.find((candidate) => candidate.possibleActions.some((possible) => possible.action === input.action)) ?? requested;
    const activeStrategyProfileSnapshotId = this.activeStrategyProfileSnapshotIds.get(input.actorId);
    const shadowRecommendation = createShadowStrategyRecommendation({
      candidates,
      agentSelectedIntentId: selected.intentId,
      ...(activeStrategyProfileSnapshotId
        ? { strategyProfileSnapshot: this.strategyProfileSnapshots.get(activeStrategyProfileSnapshotId) }
        : {})
    });
    const selection: StrategySelection = {
      selectionId: `strategy-selection-${randomUUID()}`,
      actorId: input.actorId,
      characterId: input.characterId,
      ...(input.activationId ? { activationId: input.activationId } : {}),
      ...(activeStrategyProfileSnapshotId
        ? { strategyProfileSnapshotId: activeStrategyProfileSnapshotId }
        : {}),
      candidateIntentIds: candidates.map((candidate) => candidate.intentId),
      selectedIntentId: selected.intentId,
      selector: Array.isArray(payload.candidateIntents) ? "agent" : "bounded-rule",
      selectorVersion: "bounded-intent-v1",
      evidenceRefs,
      budget: { maxCandidates: 4, consideredCandidates: candidates.length },
      ...(shadowRecommendation ? { shadowRecommendation } : {}),
      logicalTime: envelope.logicalTime,
      schemaVersion: 1
    };
    this.strategySelections.push(selection);
    this.append("social", "strategy.selected", { selection, candidates }, {
      actorId: input.actorId,
      characterId: input.characterId,
      causationId: envelope.eventId,
      visibility: { kind: "actors", actorIds: [input.actorId] }
    });
    const record: SocialDecisionRecord = {
      decisionId: `social-decision-${randomUUID()}`,
      actorId: input.actorId,
      characterId: input.characterId,
      ...(input.activationId ? { activationId: input.activationId } : {}),
      ...(selection.strategyProfileSnapshotId ? { strategyProfileSnapshotId: selection.strategyProfileSnapshotId } : {}),
      logicalTime: envelope.logicalTime,
      observationRefs,
      evidenceRefs,
      relevantBeliefIds,
      relevantActorModelIds,
      relevantRelationshipIds,
      openCommitmentIds,
      activeDeceptionIds,
      candidateIntentIds: candidates.map((candidate) => candidate.intentId),
      strategySelectionId: selection.selectionId,
      selectedIntent: {
        intentId: selected.intentId,
        summary: selected.summary,
        ...(selected.publicStrategy ? { publicStrategy: selected.publicStrategy } : {})
      },
      predictedConsequences,
      action: input.action,
      actionReceiptId: receiptId,
      resultingEventIds: [envelope.eventId],
      provenance: {
        sourceKind: "agent-self-report",
        sourceIds: [envelope.eventId, receiptId],
        confidence: typeof payload.reason === "string" ? 0.9 : 0.5,
        createdAtLogical: envelope.logicalTime,
        schemaVersion: 1
      }
    };
    this.decisions.push(record);
    this.append("social", "decision.recorded", structuredClone(record), {
      actorId: input.actorId,
      characterId: input.characterId,
      causationId: envelope.eventId,
      visibility: { kind: "actors", actorIds: [input.actorId] }
    });
    this.linkCitedSources(record, input.action !== "make_commitment");
    this.reconcileDeceptionDecision(record);
    return structuredClone(record);
  }

  recordWorldLog(log: WorldLogEntry): void {
    this.append("domain", "world.log-recorded", {
      logId: log.id,
      text: log.text,
      beat: log.beat,
      turn: log.turn,
      phase: log.phase
    }, { visibility: { kind: "public" } });
  }

  recordAppraisalObservation(
    observerActorId: string,
    observerCharacterId: string,
    event: SocialEvent
  ): string {
    const existing = this.events.find((entry) =>
      entry.type === "social-experience.observed"
      && asRecord(entry.payload).socialEventId === event.id
      && entry.actorId === observerActorId
    );
    if (existing) return existing.eventId;
    const factValues = new Set(Object.values(event.facts ?? {}).filter((value): value is string => typeof value === "string"));
    const messageId = shortText(event.facts?.messageId, 160);
    const cause = [...this.events].reverse().find((entry) =>
      factValues.has(entry.eventId)
      || Boolean(messageId && asRecord(entry.payload).messageId === messageId)
    );
    const envelope = this.append("social", "social-experience.observed", {
      socialEventId: event.id,
      eventType: event.type,
      sourceActorId: event.actorId,
      targetActorId: event.targetId,
      facts: structuredClone(event.facts),
      detail: event.detail,
      turn: event.turn,
      phase: event.phase
    }, {
      actorId: observerActorId,
      characterId: observerCharacterId,
      ...(cause ? { causationId: cause.eventId } : {}),
      correlationId: event.id,
      visibility: { kind: "actors", actorIds: [observerActorId] }
    });
    return envelope.eventId;
  }

  recordIdentityAssignment(input: {
    subjectActorId: string;
    subjectCharacterId: string;
    roleId: string;
    observerActorIds: string[];
    characterIdFor(actorId: string): string;
  }): Proposition {
    const observers = [...new Set(input.observerActorIds)];
    const existingEvent = this.events.find((event) => {
      if (event.type !== "identity.assigned") return false;
      const payload = asRecord(event.payload);
      return payload.subjectActorId === input.subjectActorId && payload.roleId === input.roleId;
    });
    if (existingEvent) {
      const existingProposition = [...this.propositions.values()].find((proposition) =>
        proposition.kind === "identity"
        && proposition.subjectId === input.subjectCharacterId
        && proposition.predicate === "has-role"
        && proposition.object === input.roleId
      );
      if (existingProposition) return structuredClone(existingProposition);
    }
    const envelope = this.append("domain", "identity.assigned", {
      subjectActorId: input.subjectActorId,
      roleId: input.roleId
    }, {
      actorId: input.subjectActorId,
      characterId: input.subjectCharacterId,
      visibility: { kind: "actors", actorIds: observers }
    });
    const proposition = this.upsertProposition({
      kind: "identity",
      subjectId: input.subjectCharacterId,
      predicate: "has-role",
      object: input.roleId,
      truthStatus: "true",
      groundTruthVisibility: "hidden-until-resolution",
      sourceEventId: envelope.eventId
    });
    for (const observerActorId of observers) {
      this.evidence.push({
        evidenceId: `evidence-${randomUUID()}`,
        observerCharacterId: input.characterIdFor(observerActorId),
        propositionId: proposition.propositionId,
        sourceType: "direct-observation",
        sourceEventId: envelope.eventId,
        supports: true,
        strength: 1,
        sourceReliability: 1,
        visibility: "private",
        logicalTime: envelope.logicalTime
      });
    }
    return structuredClone(proposition);
  }

  recordFactionAssignment(input: {
    subjectActorId: string;
    subjectCharacterId: string;
    factionId: string;
    observerActorIds: string[];
    characterIdFor(actorId: string): string;
  }): Proposition {
    const observers = [...new Set(input.observerActorIds)];
    const existingEvent = this.events.find((event) => {
      if (event.type !== "faction.assigned") return false;
      const payload = asRecord(event.payload);
      return payload.subjectActorId === input.subjectActorId && payload.factionId === input.factionId;
    });
    if (existingEvent) {
      const existingProposition = [...this.propositions.values()].find((proposition) =>
        proposition.kind === "identity"
        && proposition.subjectId === input.subjectCharacterId
        && proposition.predicate === "has-faction"
        && proposition.object === input.factionId
      );
      if (existingProposition) return structuredClone(existingProposition);
    }
    const envelope = this.append("domain", "faction.assigned", {
      subjectActorId: input.subjectActorId,
      factionId: input.factionId
    }, {
      actorId: input.subjectActorId,
      characterId: input.subjectCharacterId,
      visibility: { kind: "actors", actorIds: observers }
    });
    const proposition = this.upsertProposition({
      kind: "identity",
      subjectId: input.subjectCharacterId,
      predicate: "has-faction",
      object: input.factionId,
      truthStatus: "true",
      groundTruthVisibility: "hidden-until-resolution",
      sourceEventId: envelope.eventId
    });
    for (const observerActorId of observers) {
      this.evidence.push({
        evidenceId: `evidence-${randomUUID()}`,
        observerCharacterId: input.characterIdFor(observerActorId),
        propositionId: proposition.propositionId,
        sourceType: "direct-observation",
        sourceEventId: envelope.eventId,
        supports: true,
        strength: 1,
        sourceReliability: 1,
        visibility: "private",
        logicalTime: envelope.logicalTime
      });
    }
    return structuredClone(proposition);
  }

  recordFactionObservation(input: {
    observerActorId: string;
    observerCharacterId: string;
    subjectActorId: string;
    subjectCharacterId: string;
    perceivedFactionId: string;
    sourceCommandId?: string;
  }): EvidenceRecord {
    const envelope = this.append("domain", "faction.observed", {
      subjectActorId: input.subjectActorId,
      perceivedFactionId: input.perceivedFactionId
    }, {
      actorId: input.observerActorId,
      characterId: input.observerCharacterId,
      correlationId: input.sourceCommandId,
      visibility: { kind: "actors", actorIds: [input.observerActorId] }
    });
    const proposition = this.upsertProposition({
      kind: "identity",
      subjectId: input.subjectCharacterId,
      predicate: "has-faction",
      object: input.perceivedFactionId,
      truthStatus: "unknown",
      groundTruthVisibility: "hidden-until-resolution",
      sourceEventId: envelope.eventId
    });
    const evidence: EvidenceRecord = {
      evidenceId: `evidence-${randomUUID()}`,
      observerCharacterId: input.observerCharacterId,
      propositionId: proposition.propositionId,
      sourceType: "direct-observation",
      sourceEventId: envelope.eventId,
      supports: true,
      strength: 1,
      sourceReliability: 1,
      visibility: "private",
      logicalTime: envelope.logicalTime
    };
    this.evidence.push(evidence);
    return structuredClone(evidence);
  }

  recordPrivateObservation(input: {
    observerActorId: string;
    observerCharacterId: string;
    subjectCharacterId?: string;
    eventType: string;
    predicate: string;
    object?: unknown;
    sourceCommandId?: string;
    payload?: Record<string, unknown>;
    kind?: Proposition["kind"];
  }): EvidenceRecord {
    const envelope = this.append("domain", input.eventType, {
      predicate: input.predicate,
      ...(input.object === undefined ? {} : { object: structuredClone(input.object) }),
      ...(input.payload ?? {})
    }, {
      actorId: input.observerActorId,
      characterId: input.observerCharacterId,
      correlationId: input.sourceCommandId,
      visibility: { kind: "actors", actorIds: [input.observerActorId] }
    });
    const proposition = this.upsertProposition({
      kind: input.kind ?? "world-state",
      ...(input.subjectCharacterId ? { subjectId: input.subjectCharacterId } : {}),
      predicate: input.predicate,
      ...(input.object === undefined ? {} : { object: structuredClone(input.object) }),
      truthStatus: "unknown",
      groundTruthVisibility: "hidden-until-resolution",
      sourceEventId: envelope.eventId
    });
    const evidence: EvidenceRecord = {
      evidenceId: `evidence-${randomUUID()}`,
      observerCharacterId: input.observerCharacterId,
      propositionId: proposition.propositionId,
      sourceType: "direct-observation",
      sourceEventId: envelope.eventId,
      supports: true,
      strength: 1,
      sourceReliability: 1,
      visibility: "private",
      logicalTime: envelope.logicalTime
    };
    this.evidence.push(evidence);
    return structuredClone(evidence);
  }

  recordPublicWorldFact(input: {
    factKey: string;
    eventType: string;
    subjectId?: string;
    predicate: string;
    object?: unknown;
    payload?: Record<string, unknown>;
    kind?: Proposition["kind"];
  }): { eventId: string; propositionId: string; evidenceId: string } {
    const existingEvent = this.events.find((event) =>
      event.type === input.eventType && asRecord(event.payload).factKey === input.factKey
    );
    if (existingEvent) {
      const proposition = [...this.propositions.values()].find((entry) => entry.sourceEventIds.includes(existingEvent.eventId));
      const evidence = this.evidence.find((entry) => entry.sourceEventId === existingEvent.eventId && entry.visibility === "public");
      if (proposition && evidence) {
        return { eventId: existingEvent.eventId, propositionId: proposition.propositionId, evidenceId: evidence.evidenceId };
      }
    }
    const envelope = this.append("domain", input.eventType, {
      factKey: input.factKey,
      ...(input.payload ?? {})
    }, { visibility: { kind: "public" } });
    const proposition = this.upsertProposition({
      kind: input.kind ?? "world-state",
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
      predicate: input.predicate,
      ...(input.object === undefined ? {} : { object: structuredClone(input.object) }),
      truthStatus: "true",
      groundTruthVisibility: "public",
      sourceEventId: envelope.eventId
    });
    proposition.truthStatus = "true";
    proposition.groundTruthVisibility = "public";
    if (!proposition.sourceEventIds.includes(envelope.eventId)) proposition.sourceEventIds.push(envelope.eventId);
    const evidence: EvidenceRecord = {
      evidenceId: `evidence-${randomUUID()}`,
      observerCharacterId: "public",
      propositionId: proposition.propositionId,
      sourceType: "domain-result",
      sourceEventId: envelope.eventId,
      supports: true,
      strength: 1,
      sourceReliability: 1,
      visibility: "public",
      logicalTime: envelope.logicalTime
    };
    this.evidence.push(evidence);
    return { eventId: envelope.eventId, propositionId: proposition.propositionId, evidenceId: evidence.evidenceId };
  }

  recordIdentityObservation(input: {
    observerActorId: string;
    observerCharacterId: string;
    subjectActorId: string;
    subjectCharacterId: string;
    perceivedRoleId: string;
    sourceCommandId?: string;
  }): EvidenceRecord {
    const envelope = this.append("domain", "identity.observed", {
      subjectActorId: input.subjectActorId,
      perceivedRoleId: input.perceivedRoleId
    }, {
      actorId: input.observerActorId,
      characterId: input.observerCharacterId,
      correlationId: input.sourceCommandId,
      visibility: { kind: "actors", actorIds: [input.observerActorId] }
    });
    const proposition = this.upsertProposition({
      kind: "identity",
      subjectId: input.subjectCharacterId,
      predicate: "has-role",
      object: input.perceivedRoleId,
      truthStatus: "unknown",
      groundTruthVisibility: "hidden-until-resolution",
      sourceEventId: envelope.eventId
    });
    const evidence: EvidenceRecord = {
      evidenceId: `evidence-${randomUUID()}`,
      observerCharacterId: input.observerCharacterId,
      propositionId: proposition.propositionId,
      sourceType: "direct-observation",
      sourceEventId: envelope.eventId,
      supports: true,
      strength: 1,
      sourceReliability: 1,
      visibility: "private",
      logicalTime: envelope.logicalTime
    };
    this.evidence.push(evidence);
    return structuredClone(evidence);
  }

  revealIdentity(input: {
    subjectActorId: string;
    subjectCharacterId: string;
    actualRoleId: string;
    actorIdForCharacter(characterId: string): string | undefined;
  }): { eventId: string; detectedDeceptionIds: string[] } {
    const existing = this.events.find((event) => {
      if (event.type !== "identity.revealed") return false;
      const payload = asRecord(event.payload);
      return payload.subjectActorId === input.subjectActorId && payload.actualRoleId === input.actualRoleId;
    });
    if (existing) {
      return {
        eventId: existing.eventId,
        detectedDeceptionIds: [...this.deceptions.values()]
          .filter((episode) => episode.detectionEventIds.includes(existing.eventId))
          .map((episode) => episode.deceptionId)
      };
    }
    const envelope = this.append("domain", "identity.revealed", {
      subjectActorId: input.subjectActorId,
      actualRoleId: input.actualRoleId
    }, {
      actorId: input.subjectActorId,
      characterId: input.subjectCharacterId,
      visibility: { kind: "public" }
    });
    const relevant = [...this.propositions.values()].filter((proposition) =>
      proposition.kind === "identity" && proposition.subjectId === input.subjectCharacterId && proposition.predicate === "has-role"
    );
    if (!relevant.some((proposition) => proposition.object === input.actualRoleId)) {
      relevant.push(this.upsertProposition({
        kind: "identity",
        subjectId: input.subjectCharacterId,
        predicate: "has-role",
        object: input.actualRoleId,
        truthStatus: "true",
        groundTruthVisibility: "public",
        sourceEventId: envelope.eventId
      }));
    }
    for (const proposition of relevant) {
      proposition.truthStatus = proposition.object === input.actualRoleId ? "true" : "false";
      proposition.groundTruthVisibility = "public";
      if (!proposition.sourceEventIds.includes(envelope.eventId)) proposition.sourceEventIds.push(envelope.eventId);
      const resolutionEvidence: EvidenceRecord = {
        evidenceId: `evidence-${randomUUID()}`,
        observerCharacterId: "public",
        propositionId: proposition.propositionId,
        sourceType: "domain-result",
        sourceEventId: envelope.eventId,
        supports: proposition.truthStatus === "true",
        strength: 1,
        sourceReliability: 1,
        visibility: "public",
        logicalTime: envelope.logicalTime
      };
      this.evidence.push(resolutionEvidence);
      this.resolveBeliefsFromWorldResult(
        proposition,
        proposition.truthStatus === "true",
        resolutionEvidence.evidenceId,
        envelope.eventId,
        input.actorIdForCharacter
      );
    }
    const detectedDeceptionIds = this.detectIdentityDeceptions(input.subjectCharacterId, input.actualRoleId, envelope.eventId);
    return { eventId: envelope.eventId, detectedDeceptionIds };
  }

  recordCommitment(commitment: Commitment, allActorIds: string[]): CommitmentRecord {
    if (this.commitments.has(commitment.commitmentId)) {
      throw new Error(`COMMITMENT_ALREADY_RECORDED: '${commitment.commitmentId}'.`);
    }
    const audience = [...new Set(commitment.audienceActorIds)];
    const isPublic = allActorIds.every((actorId) => audience.includes(actorId));
    const visibility: VisibilityPolicy = isPublic
      ? { kind: "public" }
      : { kind: "actors", actorIds: [...new Set([commitment.promisorActorId, ...audience])] };
    const envelope = this.append("domain", "commitment.declared", {
      commitmentId: commitment.commitmentId,
      proposition: commitment.proposition,
      promisedAction: commitment.promisedAction,
      audienceActorIds: audience,
      commandId: commitment.createdByCommandId
    }, {
      actorId: commitment.promisorActorId,
      characterId: commitment.promisorCharacterId,
      correlationId: commitment.createdByCommandId,
      visibility
    });
    const proposition = this.upsertProposition({
      kind: "future-action",
      subjectId: commitment.promisorCharacterId,
      predicate: commitment.proposition,
      object: structuredClone(commitment.promisedAction),
      validFromLogicalTime: envelope.logicalTime,
      truthStatus: "future-contingent",
      groundTruthVisibility: isPublic ? "public" : "private",
      sourceEventId: envelope.eventId
    });
    const record: CommitmentRecord = {
      commitmentId: commitment.commitmentId,
      promisorActorId: commitment.promisorActorId,
      promisorCharacterId: commitment.promisorCharacterId,
      audienceActorIds: audience,
      propositionId: proposition.propositionId,
      proposition: commitment.proposition,
      promisedAction: structuredClone(commitment.promisedAction),
      state: commitment.state,
      acceptedByActorIds: [...(commitment.acceptedByActorIds ?? [])],
      acceptedByCommandIds: [...(commitment.acceptedByCommandIds ?? [])],
      ...(commitment.createdByCommandId ? { createdByCommandId: commitment.createdByCommandId } : {}),
      createdAtLogical: envelope.logicalTime,
      sourceEventIds: [envelope.eventId],
      provenance: {
        sourceKind: "world-fact",
        sourceIds: [envelope.eventId, ...(commitment.createdByCommandId ? [commitment.createdByCommandId] : [])],
        confidence: 1,
        createdAtLogical: envelope.logicalTime,
        schemaVersion: 1
      }
    };
    this.commitments.set(record.commitmentId, record);
    const linkedPromiseAct = [...this.socialActs].reverse().find((act) =>
      act.actorId === commitment.promisorActorId
      && act.kind === "promise"
      && Boolean(act.deceptionId)
      && act.propositionIds.some((propositionId) => this.propositions.get(propositionId)?.predicate === commitment.proposition)
    );
    if (linkedPromiseAct?.deceptionId && commitment.createdByCommandId) {
      const episode = this.deceptions.get(linkedPromiseAct.deceptionId);
      if (episode?.mode === "feigned-commitment"
        && !episode.supportingActionReceiptIds.includes(commitment.createdByCommandId)) {
        episode.supportingActionReceiptIds.push(commitment.createdByCommandId);
      }
    }
    this.append("social", "commitment.proposed", structuredClone(record), {
      actorId: commitment.promisorActorId,
      characterId: commitment.promisorCharacterId,
      causationId: envelope.eventId,
      visibility
    });
    return structuredClone(record);
  }

  acceptCommitment(input: {
    commitment: Commitment;
    acceptorActorId: string;
    acceptorCharacterId: string;
    commandId: string;
    allActorIds: string[];
  }): CommitmentRecord {
    const { commitment, acceptorActorId, acceptorCharacterId, commandId, allActorIds } = input;
    const record = this.commitments.get(commitment.commitmentId);
    if (!record) throw new Error(`COMMITMENT_NOT_RECORDED: '${commitment.commitmentId}'.`);
    if (!commitment.audienceActorIds.includes(acceptorActorId) || commitment.promisorActorId === acceptorActorId) {
      throw new Error("COMMITMENT_ACCEPTOR_INVALID: Only a promise recipient may accept it.");
    }
    if (record.state !== "proposed" && record.state !== "accepted") {
      throw new Error(`COMMITMENT_NOT_OPEN: '${commitment.commitmentId}' is already ${record.state}.`);
    }
    const audience = [...new Set(commitment.audienceActorIds)];
    const isPublic = allActorIds.every((actorId) => audience.includes(actorId));
    const visibility: VisibilityPolicy = isPublic
      ? { kind: "public" }
      : { kind: "actors", actorIds: [...new Set([commitment.promisorActorId, ...audience])] };
    const envelope = this.append("domain", "commitment.accepted", {
      commitmentId: commitment.commitmentId,
      acceptorActorId,
      commandId
    }, {
      actorId: acceptorActorId,
      characterId: acceptorCharacterId,
      causationId: record.sourceEventIds[0],
      correlationId: commandId,
      visibility
    });
    record.state = commitment.state;
    record.acceptedByActorIds = [...(commitment.acceptedByActorIds ?? [])];
    record.acceptedByCommandIds = [...(commitment.acceptedByCommandIds ?? [])];
    record.acceptedAtLogical = envelope.logicalTime;
    record.sourceEventIds.push(envelope.eventId);
    record.provenance.sourceIds.push(envelope.eventId, commandId);
    this.append("social", "commitment.accepted", structuredClone(record), {
      actorId: acceptorActorId,
      characterId: acceptorCharacterId,
      causationId: envelope.eventId,
      correlationId: commandId,
      visibility
    });
    return structuredClone(record);
  }

  settleCommitment(commitment: Commitment, allActorIds: string[]): CommitmentRecord {
    const record = this.commitments.get(commitment.commitmentId);
    if (!record) throw new Error(`COMMITMENT_NOT_RECORDED: '${commitment.commitmentId}'.`);
    if (commitment.state === "proposed" || commitment.state === "accepted") {
      throw new Error(`COMMITMENT_NOT_SETTLED: '${commitment.commitmentId}'.`);
    }
    const audience = [...new Set(commitment.audienceActorIds)];
    const isPublic = allActorIds.every((actorId) => audience.includes(actorId));
    const visibility: VisibilityPolicy = isPublic
      ? { kind: "public" }
      : { kind: "actors", actorIds: [...new Set([commitment.promisorActorId, ...audience])] };
    const envelope = this.append("social", `commitment.${commitment.state}`, {
      commitmentId: commitment.commitmentId,
      state: commitment.state,
      settledByCommandId: commitment.settledByCommandId
    }, {
      actorId: commitment.promisorActorId,
      characterId: commitment.promisorCharacterId,
      causationId: record.sourceEventIds[0],
      correlationId: commitment.settledByCommandId,
      visibility
    });
    record.state = commitment.state;
    if (commitment.settledByCommandId) record.settledByCommandId = commitment.settledByCommandId;
    record.settledAtLogical = envelope.logicalTime;
    record.sourceEventIds.push(envelope.eventId);
    record.provenance.sourceIds.push(envelope.eventId, ...(commitment.settledByCommandId ? [commitment.settledByCommandId] : []));
    if (commitment.state === "violated") this.detectFeignedCommitment(record, envelope.eventId, visibility);
    return structuredClone(record);
  }

  openCommitmentsFor(actorId: string): CommitmentRecord[] {
    return [...this.commitments.values()]
      .filter((commitment) =>
        (commitment.state === "proposed" || commitment.state === "accepted")
        && (commitment.promisorActorId === actorId
          || commitment.audienceActorIds.includes(actorId)
          || commitment.acceptedByActorIds.includes(actorId))
      )
      .map((commitment) => structuredClone(commitment));
  }

  recordBeliefUpdate(ownerActorId: string, ownerCharacterId: string, input: BeliefSelfReportInput): BeliefUpdateRecord {
    const messageEvents = this.events.filter((event) => {
      const payload = asRecord(event.payload);
      return input.sourceMessageIds?.includes(String(payload.messageId ?? ""));
    });
    const citedEvidence = [...new Set(input.sourceEvidenceIds ?? [])].slice(0, 24).map((evidenceId) => {
      const evidence = this.evidence.find((entry) => entry.evidenceId === evidenceId);
      if (!evidence || (evidence.visibility !== "public" && evidence.observerCharacterId !== ownerCharacterId)) {
        throw new Error(`BELIEF_EVIDENCE_NOT_VISIBLE: '${evidenceId}' is not available to this actor.`);
      }
      return evidence;
    });
    const citedEventIds = new Set(citedEvidence.flatMap((entry) => entry.sourceEventId ? [entry.sourceEventId] : []));
    const sourceEvents = this.events.filter((event) =>
      messageEvents.some((messageEvent) => messageEvent.eventId === event.eventId) || citedEventIds.has(event.eventId)
    );
    const proposition = this.upsertProposition({
      kind: input.kind ?? "evaluation",
      subjectId: input.subjectId,
      predicate: input.proposition.trim(),
      ...(input.object === undefined ? {} : { object: structuredClone(input.object) }),
      truthStatus: input.kind === "identity" ? "unknown" : "subjective",
      groundTruthVisibility: input.kind === "identity" ? "hidden-until-resolution" : "no-objective-ground-truth",
      sourceEventId: sourceEvents.at(-1)?.eventId ?? `self-report:${ownerActorId}`
    });
    const evidenceIds: string[] = citedEvidence.map((entry) => entry.evidenceId);
    for (const event of messageEvents) {
      const payload = asRecord(event.payload);
      const evidence: EvidenceRecord = {
        evidenceId: `evidence-${randomUUID()}`,
        observerCharacterId: ownerCharacterId,
        propositionId: proposition.propositionId,
        sourceType: "inference",
        sourceEventId: event.eventId,
        sourceMessageId: typeof payload.messageId === "string" ? payload.messageId : undefined,
        supports: input.supports ?? true,
        strength: clamp01(input.confidence),
        sourceReliability: 0.5,
        visibility: "private",
        logicalTime: this.sequence + 1
      };
      this.evidence.push(evidence);
      evidenceIds.push(evidence.evidenceId);
    }
    const previous = [...this.beliefUpdates].reverse().find((entry) =>
      entry.ownerCharacterId === ownerCharacterId && entry.propositionId === proposition.propositionId
    );
    const logicalTime = this.sequence + 1;
    const record: BeliefUpdateRecord = {
      beliefUpdateId: `belief-update-${randomUUID()}`,
      beliefId: previous?.beliefId ?? `belief-${ownerCharacterId}-${proposition.propositionId}`,
      ownerCharacterId,
      propositionId: proposition.propositionId,
      beforeProbability: previous?.afterProbability ?? 0.5,
      afterProbability: clamp01(input.probability),
      confidence: clamp01(input.confidence),
      addedEvidenceIds: evidenceIds,
      removedEvidenceIds: [],
      reasonCode: sourceEvents.length ? "new-observation" : "reflection",
      logicalTime,
      provenance: {
        sourceKind: "agent-self-report",
        sourceIds: evidenceIds.length ? evidenceIds : [`self-report:${ownerActorId}`],
        confidence: clamp01(input.confidence),
        createdAtLogical: logicalTime,
        schemaVersion: 1
      }
    };
    this.beliefUpdates.push(record);
    this.append("social", "belief.updated", structuredClone(record), {
      actorId: ownerActorId,
      characterId: ownerCharacterId,
      causationId: sourceEvents.at(-1)?.eventId,
      visibility: { kind: "actors", actorIds: [ownerActorId] }
    });
    this.reconcileDeceptionBelief(ownerCharacterId, record, sourceEvents);
    return structuredClone(record);
  }

  recordActorModel(
    ownerActorId: string,
    ownerCharacterId: string,
    targetCharacterId: string,
    input: ActorModelInput
  ): ActorModel {
    const messageEvents = this.events.filter((event) => {
      const payload = asRecord(event.payload);
      return input.sourceMessageIds?.includes(String(payload.messageId ?? ""));
    });
    const requestedEvidenceIds = [...new Set(input.sourceEvidenceIds ?? [])].slice(0, 24);
    const citedEvidence = requestedEvidenceIds.map((evidenceId) => {
      const evidence = this.evidence.find((entry) => entry.evidenceId === evidenceId);
      if (!evidence || (evidence.visibility !== "public" && evidence.observerCharacterId !== ownerCharacterId)) {
        throw new Error(`ACTOR_MODEL_EVIDENCE_NOT_VISIBLE: '${evidenceId}' is not available to this actor.`);
      }
      return evidence;
    });
    const citedEventIds = new Set(citedEvidence.flatMap((entry) => entry.sourceEventId ? [entry.sourceEventId] : []));
    const sourceEvents = this.events.filter((event) =>
      messageEvents.some((messageEvent) => messageEvent.eventId === event.eventId) || citedEventIds.has(event.eventId)
    );
    const logicalTime = this.sequence + 1;
    const evidenceIds: string[] = citedEvidence.map((entry) => entry.evidenceId);
    const inferredKnowledge = input.inferredKnowledge.slice(0, 8).map((entry) => {
      const proposition = this.upsertProposition({
        kind: "evaluation",
        subjectId: targetCharacterId,
        predicate: entry.proposition.trim(),
        truthStatus: "subjective",
        groundTruthVisibility: "no-objective-ground-truth",
        sourceEventId: sourceEvents.at(-1)?.eventId ?? `actor-model:${ownerActorId}:${logicalTime}`
      });
      const evidence: EvidenceRecord = {
        evidenceId: `evidence-${randomUUID()}`,
        observerCharacterId: ownerCharacterId,
        propositionId: proposition.propositionId,
        sourceType: "inference",
        ...(sourceEvents.at(-1) ? { sourceEventId: sourceEvents.at(-1)?.eventId } : {}),
        supports: entry.probability >= 0.5,
        strength: clamp01(Math.abs(entry.probability - 0.5) * 2),
        sourceReliability: clamp01(input.confidence),
        visibility: "private",
        logicalTime
      };
      this.evidence.push(evidence);
      evidenceIds.push(evidence.evidenceId);
      return { propositionId: proposition.propositionId, probability: clamp01(entry.probability) };
    });
    const modelId = `actor-model-${createHash("sha256")
      .update(`${ownerCharacterId}\u0000${targetCharacterId}`)
      .digest("hex")
      .slice(0, 24)}`;
    const model: ActorModel = {
      modelId,
      ownerActorId,
      ownerCharacterId,
      targetActorId: input.targetActorId,
      targetCharacterId,
      inferredGoals: input.inferredGoals.slice(0, 8).map((entry) => ({ goal: entry.goal.trim(), probability: clamp01(entry.probability) })),
      inferredKnowledge,
      predictedActions: input.predictedActions.slice(0, 8).map((entry) => ({ action: entry.action.trim(), probability: clamp01(entry.probability) })),
      perceivedStrategy: input.perceivedStrategy.map((entry) => entry.trim()).filter(Boolean).slice(0, 8),
      perceivedHonesty: clamp01(input.perceivedHonesty),
      perceivedRiskTolerance: clamp01(input.perceivedRiskTolerance),
      evidenceIds,
      lastUpdatedLogicalTime: logicalTime,
      provenance: {
        sourceKind: "agent-self-report",
        sourceIds: evidenceIds.length ? evidenceIds : [`actor-model:${ownerActorId}:${logicalTime}`],
        confidence: clamp01(input.confidence),
        createdAtLogical: logicalTime,
        schemaVersion: 1
      },
      schemaVersion: 1
    };
    this.actorModels.set(model.modelId, model);
    this.append("social", "actor-model.updated", structuredClone(model), {
      actorId: ownerActorId,
      characterId: ownerCharacterId,
      causationId: sourceEvents.at(-1)?.eventId,
      visibility: { kind: "actors", actorIds: [ownerActorId] }
    });
    return structuredClone(model);
  }

  recordRelationshipUpdate(
    ownerActorId: string,
    ownerCharacterId: string,
    targetCharacterId: string,
    input: RelationshipUpdateInput
  ): RelationshipDeltaRecord {
    if (input.targetActorId === ownerActorId || targetCharacterId === ownerCharacterId) {
      throw new Error("RELATIONSHIP_TARGET_INVALID: A directed relationship must target another participant.");
    }
    const messageEvents = this.events.filter((event) => {
      const messageId = shortText(asRecord(event.payload).messageId, 160);
      return Boolean(messageId && input.sourceMessageIds?.includes(messageId));
    });
    const sourceEventIds = [...new Set([
      ...(input.sourceEventIds ?? []),
      ...messageEvents.map((event) => event.eventId)
    ])].slice(0, 24);
    const evidenceIds = [...new Set(input.sourceEvidenceIds ?? [])].filter((evidenceId) =>
      this.evidence.some((entry) =>
        entry.evidenceId === evidenceId
        && (entry.visibility === "public" || entry.observerCharacterId === ownerCharacterId)
      )
    ).slice(0, 24);
    const relationshipId = `relationship-${createHash("sha256")
      .update(`${ownerCharacterId}\u0000${targetCharacterId}`)
      .digest("hex")
      .slice(0, 24)}`;
    const before = relationshipDimensions(input.before);
    const after = relationshipDimensions(input.after);
    const logicalTime = this.sequence + 1;
    const provenance: DirectedRelationshipState["provenance"] = {
      sourceKind: input.sourceKind,
      sourceIds: sourceEventIds.length || evidenceIds.length
        ? [...sourceEventIds, ...evidenceIds]
        : [`relationship-update:${ownerActorId}:${logicalTime}`],
      confidence: sourceEventIds.length || evidenceIds.length ? 0.9 : 0.45,
      createdAtLogical: logicalTime,
      schemaVersion: 1
    };
    const record: RelationshipDeltaRecord = {
      relationshipDeltaId: `relationship-delta-${randomUUID()}`,
      relationshipId,
      ownerActorId,
      ownerCharacterId,
      targetActorId: input.targetActorId,
      targetCharacterId,
      before,
      after,
      delta: {
        trust: after.trust - before.trust,
        affinity: after.affinity - before.affinity,
        respect: after.respect - before.respect,
        tension: after.tension - before.tension,
        familiarity: after.familiarity - before.familiarity
      },
      note: input.note.trim().slice(0, 1_000),
      sourceEventIds,
      evidenceIds,
      logicalTime,
      provenance,
      schemaVersion: 1
    };
    const state: DirectedRelationshipState = {
      relationshipId,
      ownerActorId,
      ownerCharacterId,
      targetActorId: input.targetActorId,
      targetCharacterId,
      ...after,
      note: record.note,
      sourceEventIds,
      evidenceIds,
      lastUpdatedLogicalTime: logicalTime,
      provenance,
      schemaVersion: 1
    };
    this.directedRelationships.set(relationshipId, state);
    this.relationshipDeltas.push(record);
    if (this.relationshipDeltas.length > 2_000) this.relationshipDeltas.splice(0, this.relationshipDeltas.length - 2_000);
    this.append("social", "relationship.updated", structuredClone(record), {
      actorId: ownerActorId,
      characterId: ownerCharacterId,
      causationId: sourceEventIds.at(-1),
      visibility: { kind: "actors", actorIds: [ownerActorId] }
    });
    return structuredClone(record);
  }

  recordDeceptionPlan(
    actorId: string,
    characterId: string,
    input: DeceptionPlanInput,
    characterIdFor: (actorId: string) => string
  ): DeceptionEpisode {
    const logicalTime = this.sequence + 1;
    const intended = this.upsertProposition({
      kind: "evaluation",
      predicate: input.intendedBelief.trim(),
      truthStatus: "subjective",
      groundTruthVisibility: "hidden-until-resolution",
      sourceEventId: `deception-plan:${actorId}:${logicalTime}`
    });
    const truePropositionIds = (input.truePropositions ?? []).map((predicate) => this.upsertProposition({
      kind: "world-state",
      predicate: predicate.trim(),
      truthStatus: "subjective",
      groundTruthVisibility: "private",
      sourceEventId: `deception-plan:${actorId}:${logicalTime}`
    }).propositionId);
    const episode: DeceptionEpisode = {
      deceptionId: `deception-${randomUUID()}`,
      deceiverCharacterId: characterId,
      deceiverActorId: actorId,
      targetAudienceIds: [...new Set(input.targetActorIds)],
      targetAudienceCharacterIds: [...new Set(input.targetActorIds.map(characterIdFor))],
      mode: input.mode,
      truePropositionIds,
      intendedFalseBeliefIds: [intended.propositionId],
      motiveGoalIds: input.motive ? [input.motive] : [],
      ...(input.expectedGain ? { expectedGain: input.expectedGain } : {}),
      ...(input.perceivedDetectionRisk === undefined ? {} : { perceivedDetectionRisk: clamp01(input.perceivedDetectionRisk) }),
      plannedAtLogicalTime: logicalTime,
      sourcePlanRecordId: `deception-plan:${actorId}:${logicalTime}`,
      executionMessageIds: [],
      receivedByCharacterIds: [],
      believedByCharacterIds: [],
      repairMessageIds: [],
      repairAcceptedByCharacterIds: [],
      supportingActionReceiptIds: [],
      maintenanceMessageIds: [],
      contradictionEventIds: [],
      audienceBeliefsBefore: [],
      audienceBeliefsAfter: [],
      inducedDecisionIds: [],
      inducedActionReceiptIds: [],
      status: "planned",
      detectionEventIds: [],
      consequenceEventIds: [],
      schemaVersion: 2
    };
    this.deceptions.set(episode.deceptionId, episode);
    this.append("social", "deception.planned", { deceptionId: episode.deceptionId, mode: episode.mode }, {
      actorId,
      characterId,
      visibility: { kind: "actors", actorIds: [actorId] }
    });
    return structuredClone(episode);
  }

  closeOpenDeceptions(): void {
    for (const episode of this.deceptions.values()) {
      const terminal = episode.status === "detected"
        || episode.status === "repair-attempted"
        || episode.status === "repaired"
        || episode.status === "failed"
        || episode.status === "abandoned";
      if (terminal) continue;
      const next = episode.status === "planned" ? "abandoned" as const : episode.status === "attempted" || episode.status === "received"
        ? "failed" as const
        : undefined;
      if (!next) continue;
      episode.status = next;
      const event = this.append("social", `deception.${next}`, {
        deceptionId: episode.deceptionId,
        executionMessageIds: episode.executionMessageIds
      }, {
        actorId: episode.deceiverActorId,
        characterId: episode.deceiverCharacterId,
        correlationId: episode.deceptionId,
        visibility: { kind: "actors", actorIds: [episode.deceiverActorId] }
      });
      if (!episode.consequenceEventIds.includes(event.eventId)) episode.consequenceEventIds.push(event.eventId);
    }
  }

  recordOutcomeReconciliation(input: OutcomeReconciliationInput): OutcomeReconciliation {
    const existing = this.outcomeReconciliations.find((entry) => entry.actionReceiptId === input.actionReceiptId);
    if (existing) return structuredClone(existing);
    const decision = this.decisions.find((entry) => entry.actionReceiptId === input.actionReceiptId);
    if (!decision) throw new Error(`DECISION_NOT_FOUND_FOR_RECEIPT: '${input.actionReceiptId}'.`);
    const outcomeEvent = this.append("domain", "outcome.observed", structuredClone(input.actualOutcome), {
      actorId: decision.actorId,
      characterId: decision.characterId,
      causationId: decision.resultingEventIds[0],
      correlationId: input.actionReceiptId,
      visibility: { kind: "actors", actorIds: [decision.actorId] }
    });
    const predictionAssessments = decision.predictedConsequences.flatMap((prediction) => {
      const actual = input.actualFacts[prediction.outcomeKey];
      if (actual === undefined) return [];
      return [{
        outcomeKey: prediction.outcomeKey,
        predictedProbability: prediction.probability,
        actual,
        squaredError: (prediction.probability - (actual ? 1 : 0)) ** 2
      }];
    });
    const propositionSettlements = decision.predictedConsequences.flatMap((prediction) => {
      const actual = input.actualFacts[prediction.outcomeKey];
      if (actual === undefined) return [];
      const proposition = this.upsertProposition({
        kind: "world-state",
        subjectId: decision.characterId,
        predicate: prediction.proposition,
        truthStatus: actual ? "true" : "false",
        groundTruthVisibility: "hidden-until-resolution",
        sourceEventId: outcomeEvent.eventId
      });
      proposition.truthStatus = actual ? "true" : "false";
      return [{ propositionId: proposition.propositionId, truthStatus: actual ? "true" as const : "false" as const }];
    });
    const influenceIds = this.influenceLinks
      .filter((entry) => entry.decisionId === decision.decisionId)
      .map((entry) => entry.influenceId);
    const calibrationError = predictionAssessments.length
      ? predictionAssessments.reduce((sum, entry) => sum + entry.squaredError, 0) / predictionAssessments.length
      : undefined;
    const reconciliation: OutcomeReconciliation = {
      reconciliationId: `outcome-reconciliation-${randomUUID()}`,
      decisionId: decision.decisionId,
      actorId: decision.actorId,
      characterId: decision.characterId,
      actionReceiptId: decision.actionReceiptId,
      predictedConsequences: structuredClone(decision.predictedConsequences),
      actualOutcome: structuredClone(input.actualOutcome),
      predictionAssessments,
      propositionSettlements,
      influenceIds,
      memoryWriteSuggestions: (input.memoryWriteSuggestions ?? []).slice(0, 6).map((suggestion) => ({
        suggestionId: `memory-suggestion-${randomUUID()}`,
        summary: suggestion.summary.trim().slice(0, 1_000),
        importance: clamp01(suggestion.importance),
        sourceIds: [...new Set([decision.decisionId, decision.actionReceiptId, outcomeEvent.eventId, ...(suggestion.sourceIds ?? [])])],
        status: "candidate" as const
      })),
      ...(calibrationError === undefined ? {} : { calibrationError }),
      resultingEventIds: [...new Set([outcomeEvent.eventId, ...(input.resultingEventIds ?? [])])],
      logicalTime: this.sequence + 1,
      provenance: {
        sourceKind: "world-fact",
        sourceIds: [decision.decisionId, decision.actionReceiptId, outcomeEvent.eventId, ...(input.resultingEventIds ?? [])],
        confidence: 1,
        createdAtLogical: this.sequence + 1,
        schemaVersion: 1
      },
      schemaVersion: 1
    };
    const reconciliationEvent = this.append("social", "outcome.reconciled", structuredClone(reconciliation), {
      actorId: decision.actorId,
      characterId: decision.characterId,
      causationId: outcomeEvent.eventId,
      correlationId: input.actionReceiptId,
      visibility: { kind: "actors", actorIds: [decision.actorId] }
    });
    reconciliation.resultingEventIds.push(reconciliationEvent.eventId);
    reconciliation.provenance.sourceIds.push(reconciliationEvent.eventId);
    decision.outcomeReconciliationId = reconciliation.reconciliationId;
    decision.resultingEventIds.push(...reconciliation.resultingEventIds);
    this.outcomeReconciliations.push(reconciliation);
    return structuredClone(reconciliation);
  }

  applyMemoryWritePolicy(actorId: string): MemoryWritePolicyResult {
    const reconciliations = this.outcomeReconciliations.filter((entry) => entry.actorId === actorId);
    if (!reconciliations.length) return { evaluated: false, accepted: [] };
    const accepted: MemoryWritePolicyResult["accepted"] = [];
    let evaluated = false;
    for (const reconciliation of reconciliations) {
      for (const suggestion of reconciliation.memoryWriteSuggestions) {
        if (suggestion.status !== "candidate") continue;
        evaluated = true;
        const hasCanonicalSource = suggestion.sourceIds.includes(reconciliation.decisionId)
          && suggestion.sourceIds.includes(reconciliation.actionReceiptId)
          && suggestion.sourceIds.some((id) => reconciliation.resultingEventIds.includes(id));
        const allow = hasCanonicalSource && suggestion.importance >= 0.6 && suggestion.summary.length > 0;
        suggestion.status = allow ? "accepted" : "rejected";
        suggestion.decidedAtLogical = this.sequence + 1;
        this.append("social", `memory-write.${suggestion.status}`, {
          suggestionId: suggestion.suggestionId,
          reconciliationId: reconciliation.reconciliationId,
          importance: suggestion.importance,
          sourceIds: suggestion.sourceIds
        }, {
          actorId: reconciliation.actorId,
          characterId: reconciliation.characterId,
          causationId: reconciliation.reconciliationId,
          correlationId: reconciliation.actionReceiptId,
          visibility: { kind: "actors", actorIds: [reconciliation.actorId] }
        });
        if (allow) accepted.push({
          suggestionId: suggestion.suggestionId,
          summary: suggestion.summary,
          importance: suggestion.importance,
          sourceIds: [...suggestion.sourceIds]
        });
      }
    }
    return { evaluated, accepted: structuredClone(accepted) };
  }

  project(viewer: ViewerContext = {}): SocialCausalityProjection {
    const events = this.events.filter((event) => this.canView(event.visibility, viewer));
    const eventIds = new Set(events.map((event) => event.eventId));
    const actorId = viewer.actorId;
    const characterId = viewer.characterId;
    const omniscient = viewer.omniscient === true;
    const socialActs = this.socialActs
      .filter((act) => eventIds.has(act.sourceEventId))
      .map((act): SocialActRecord => {
        const episode = act.deceptionId ? this.deceptions.get(act.deceptionId) : undefined;
        const exposedLink = episode && (
          episode.status === "detected" || episode.status === "repair-attempted" || episode.status === "repaired"
        ) && (
          episode.exposureVisibility === "public"
          || (episode.exposureVisibility === "targets" && Boolean(actorId && episode.targetAudienceIds.includes(actorId)))
        );
        if (omniscient || act.actorId === actorId || !act.deceptionId || exposedLink) return structuredClone(act);
        const { deceptionId: _privateDeceptionId, ...safe } = act;
        return structuredClone(safe);
      });
    const propositionIds = new Set(socialActs.flatMap((act) => act.propositionIds));
    for (const update of this.beliefUpdates) {
      if (omniscient || update.ownerCharacterId === characterId) propositionIds.add(update.propositionId);
    }
    const evidence = this.evidence.filter((entry) => omniscient || entry.visibility === "public" || entry.observerCharacterId === characterId);
    for (const entry of evidence) propositionIds.add(entry.propositionId);
    const actorModels = [...this.actorModels.values()].filter((entry) => omniscient || entry.ownerCharacterId === characterId);
    for (const model of actorModels) {
      for (const knowledge of model.inferredKnowledge) propositionIds.add(knowledge.propositionId);
    }
    const commitments = [...this.commitments.values()].filter((entry) => entry.sourceEventIds.some((eventId) => eventIds.has(eventId)));
    for (const commitment of commitments) propositionIds.add(commitment.propositionId);
    const decisions = this.decisions.filter((entry) => omniscient || entry.actorId === actorId);
    const decisionIds = new Set(decisions.map((entry) => entry.decisionId));
    const intentIds = new Set(decisions.flatMap((entry) => entry.candidateIntentIds));
    const selectionIds = new Set(decisions.map((entry) => entry.strategySelectionId));
    const strategyProfileSnapshotIds = new Set(decisions.flatMap((entry) => entry.strategyProfileSnapshotId ? [entry.strategyProfileSnapshotId] : []));
    const outcomeReconciliations = this.outcomeReconciliations.filter((entry) => omniscient || decisionIds.has(entry.decisionId));
    for (const reconciliation of outcomeReconciliations) {
      for (const settlement of reconciliation.propositionSettlements) propositionIds.add(settlement.propositionId);
    }
    const projectedPropositions = [...this.propositions.values()]
      .filter((entry) => propositionIds.has(entry.propositionId))
      .map((entry): Proposition => {
        const safe = structuredClone(entry);
        safe.sourceEventIds = safe.sourceEventIds.filter((eventId) => eventIds.has(eventId));
        if (!omniscient && safe.groundTruthVisibility !== "public" && safe.groundTruthVisibility !== "no-objective-ground-truth") {
          safe.truthStatus = "unknown";
        }
        return safe;
      });
    return {
      schemaVersion: SOCIAL_CAUSALITY_SCHEMA_VERSION,
      lastSequence: this.sequence,
      events: structuredClone(events),
      propositions: projectedPropositions,
      socialActs,
      evidence: structuredClone(evidence),
      beliefUpdates: this.beliefUpdates.filter((entry) => omniscient || entry.ownerCharacterId === characterId).map((entry) => structuredClone(entry)),
      actorModels: structuredClone(actorModels),
      directedRelationships: [...this.directedRelationships.values()]
        .filter((entry) => omniscient || entry.ownerCharacterId === characterId)
        .map((entry) => structuredClone(entry)),
      relationshipDeltas: this.relationshipDeltas
        .filter((entry) => omniscient || entry.ownerCharacterId === characterId)
        .map((entry) => structuredClone(entry)),
      commitments: structuredClone(commitments),
      candidateIntents: this.candidateIntents.filter((entry) => omniscient || intentIds.has(entry.intentId)).map((entry) => structuredClone(entry)),
      strategyProfileSnapshots: [...this.strategyProfileSnapshots.values()]
        .filter((entry) => omniscient || strategyProfileSnapshotIds.has(entry.strategyProfileSnapshotId))
        .map((entry) => structuredClone(entry)),
      activeStrategyProfileSnapshotIds: omniscient || actorId
        ? Object.fromEntries([...this.activeStrategyProfileSnapshotIds].filter(([entryActorId]) => omniscient || entryActorId === actorId))
        : {},
      strategySelections: this.strategySelections.filter((entry) => omniscient || selectionIds.has(entry.selectionId)).map((entry) => structuredClone(entry)),
      decisions: structuredClone(decisions),
      influenceLinks: this.influenceLinks.filter((entry) => omniscient || entry.targetCharacterId === characterId).map((entry) => structuredClone(entry)),
      outcomeReconciliations: structuredClone(outcomeReconciliations),
      deceptions: [...this.deceptions.values()].flatMap((entry): DeceptionEpisode[] => {
        if (omniscient || entry.deceiverActorId === actorId) return [structuredClone(entry)];
        const exposed = entry.status === "detected" || entry.status === "repair-attempted" || entry.status === "repaired";
        const visible = entry.exposureVisibility === "public"
          || (entry.exposureVisibility === "targets" && Boolean(actorId && entry.targetAudienceIds.includes(actorId)));
        if (!exposed || !visible) return [];
        const safe = structuredClone(entry);
        safe.truePropositionIds = [];
        safe.intendedFalseBeliefIds = [];
        safe.motiveGoalIds = [];
        safe.audienceBeliefsBefore = [];
        safe.audienceBeliefsAfter = [];
        safe.targetAudienceCharacterIds = [];
        safe.receivedByCharacterIds = [];
        safe.believedByCharacterIds = [];
        safe.repairAcceptedByCharacterIds = [];
        safe.inducedDecisionIds = [];
        safe.inducedActionReceiptIds = [];
        delete safe.expectedGain;
        delete safe.perceivedDetectionRisk;
        delete safe.sourcePlanRecordId;
        return [safe];
      })
    };
  }

  exportState(): SocialCausalityState {
    return { roomId: this.roomId, ...this.project({ omniscient: true }) };
  }

  restoreState(state: SocialCausalityState | undefined): void {
    if (!state) {
      this.sequence = 0;
      this.events.splice(0);
      this.propositions.clear();
      this.socialActs.splice(0);
      this.evidence.splice(0);
      this.beliefUpdates.splice(0);
      this.actorModels.clear();
      this.directedRelationships.clear();
      this.relationshipDeltas.splice(0);
      this.commitments.clear();
      this.candidateIntents.splice(0);
      this.strategyProfileSnapshots.clear();
      this.activeStrategyProfileSnapshotIds.clear();
      this.strategySelections.splice(0);
      this.decisions.splice(0);
      this.influenceLinks.splice(0);
      this.outcomeReconciliations.splice(0);
      this.deceptions.clear();
      return;
    }
    if (state.schemaVersion !== 1 && state.schemaVersion !== 2 && state.schemaVersion !== 3 && state.schemaVersion !== 4 && state.schemaVersion !== 5 && state.schemaVersion !== SOCIAL_CAUSALITY_SCHEMA_VERSION) {
      throw new Error(`SOCIAL_CAUSALITY_SCHEMA_UNSUPPORTED: ${state.schemaVersion}`);
    }
    if (state.roomId !== this.roomId) throw new Error(`SOCIAL_CAUSALITY_ROOM_MISMATCH: ${state.roomId}`);
    this.sequence = state.lastSequence;
    this.events.splice(0, this.events.length, ...structuredClone(state.events));
    this.propositions.clear();
    for (const proposition of state.propositions) this.propositions.set(proposition.propositionId, structuredClone(proposition));
    this.socialActs.splice(0, this.socialActs.length, ...structuredClone(state.socialActs));
    const normalizedEvidence = normalizePublicEvidence(state.evidence);
    const remapEvidenceIds = (ids: string[]): string[] => remapUniqueIds(ids, normalizedEvidence.replacements);
    this.evidence.splice(0, this.evidence.length, ...normalizedEvidence.evidence);
    this.beliefUpdates.splice(0, this.beliefUpdates.length, ...structuredClone(state.beliefUpdates).map((update) => ({
      ...update,
      addedEvidenceIds: remapEvidenceIds(update.addedEvidenceIds),
      removedEvidenceIds: remapEvidenceIds(update.removedEvidenceIds),
      provenance: { ...update.provenance, sourceIds: remapEvidenceIds(update.provenance.sourceIds) }
    })));
    this.actorModels.clear();
    for (const source of state.actorModels ?? []) {
      const model = structuredClone(source);
      model.evidenceIds = remapEvidenceIds(model.evidenceIds);
      model.provenance.sourceIds = remapEvidenceIds(model.provenance.sourceIds);
      this.actorModels.set(model.modelId, model);
    }
    this.directedRelationships.clear();
    for (const source of state.directedRelationships ?? []) {
      const relationship = structuredClone(source);
      relationship.evidenceIds = remapEvidenceIds(relationship.evidenceIds);
      relationship.provenance.sourceIds = remapEvidenceIds(relationship.provenance.sourceIds);
      this.directedRelationships.set(relationship.relationshipId, relationship);
    }
    this.relationshipDeltas.splice(0, this.relationshipDeltas.length, ...structuredClone(state.relationshipDeltas ?? []).map((delta) => ({
      ...delta,
      evidenceIds: remapEvidenceIds(delta.evidenceIds),
      provenance: { ...delta.provenance, sourceIds: remapEvidenceIds(delta.provenance.sourceIds) }
    })));
    this.commitments.clear();
    for (const commitment of state.commitments ?? []) {
      const restored = normalizeCommitmentRecord(commitment);
      this.commitments.set(restored.commitmentId, restored);
    }
    this.candidateIntents.splice(0, this.candidateIntents.length, ...structuredClone(state.candidateIntents ?? []).map((intent) => ({
      ...intent,
      evidenceRefs: remapEvidenceIds(intent.evidenceRefs)
    })));
    this.strategyProfileSnapshots.clear();
    for (const snapshot of state.strategyProfileSnapshots ?? []) {
      this.strategyProfileSnapshots.set(snapshot.strategyProfileSnapshotId, structuredClone(snapshot));
    }
    this.activeStrategyProfileSnapshotIds.clear();
    for (const [actorId, snapshotId] of Object.entries(state.activeStrategyProfileSnapshotIds ?? {})) {
      if (this.strategyProfileSnapshots.has(snapshotId)) this.activeStrategyProfileSnapshotIds.set(actorId, snapshotId);
    }
    this.strategySelections.splice(0, this.strategySelections.length, ...structuredClone(state.strategySelections ?? []).map((selection) => ({
      ...selection,
      evidenceRefs: remapEvidenceIds(selection.evidenceRefs)
    })));
    const restoredDecisions = (state.decisions ?? []).map(normalizeDecisionRecord).map((decision) => ({
      ...decision,
      evidenceRefs: remapEvidenceIds(decision.evidenceRefs)
    }));
    for (const decision of restoredDecisions) {
      if (!this.candidateIntents.some((entry) => entry.intentId === decision.selectedIntent.intentId)) {
        this.candidateIntents.push({
          intentId: decision.selectedIntent.intentId,
          actorId: decision.actorId,
          characterId: decision.characterId,
          ...(decision.activationId ? { activationId: decision.activationId } : {}),
          goal: "Restore a legacy recorded action",
          summary: decision.selectedIntent.summary,
          possibleActions: [{ action: decision.action }],
          predictedResponses: [],
          evidenceRefs: decision.evidenceRefs,
          beliefRefs: decision.relevantBeliefIds,
          actorModelRefs: decision.relevantActorModelIds,
          source: "bounded-rule",
          logicalTime: decision.logicalTime,
          schemaVersion: 1
        });
      }
      if (!this.strategySelections.some((entry) => entry.selectionId === decision.strategySelectionId)) {
        this.strategySelections.push({
          selectionId: decision.strategySelectionId,
          actorId: decision.actorId,
          characterId: decision.characterId,
          ...(decision.activationId ? { activationId: decision.activationId } : {}),
          ...(decision.strategyProfileSnapshotId ? { strategyProfileSnapshotId: decision.strategyProfileSnapshotId } : {}),
          candidateIntentIds: decision.candidateIntentIds,
          selectedIntentId: decision.selectedIntent.intentId,
          selector: "bounded-rule",
          selectorVersion: "legacy-migration-v1",
          evidenceRefs: decision.evidenceRefs,
          budget: { maxCandidates: 1, consideredCandidates: 1 },
          logicalTime: decision.logicalTime,
          schemaVersion: 1
        });
      }
    }
    this.decisions.splice(0, this.decisions.length, ...structuredClone(restoredDecisions));
    this.influenceLinks.splice(0, this.influenceLinks.length, ...structuredClone(state.influenceLinks ?? []));
    this.outcomeReconciliations.splice(0, this.outcomeReconciliations.length, ...structuredClone(state.outcomeReconciliations ?? []).map((reconciliation) => ({
      ...reconciliation,
      memoryWriteSuggestions: reconciliation.memoryWriteSuggestions.map((suggestion) => ({
        ...suggestion,
        sourceIds: remapEvidenceIds(suggestion.sourceIds)
      })),
      provenance: {
        ...reconciliation.provenance,
        sourceIds: remapEvidenceIds(reconciliation.provenance.sourceIds)
      }
    })));
    this.deceptions.clear();
    for (const deception of state.deceptions) {
      const restored = structuredClone(deception);
      restored.targetAudienceCharacterIds = Array.isArray(restored.targetAudienceCharacterIds)
        ? restored.targetAudienceCharacterIds
        : [];
      restored.receivedByCharacterIds = Array.isArray(restored.receivedByCharacterIds)
        ? restored.receivedByCharacterIds
        : [];
      restored.believedByCharacterIds = Array.isArray(restored.believedByCharacterIds)
        ? restored.believedByCharacterIds
        : [];
      restored.repairMessageIds = Array.isArray(restored.repairMessageIds) ? restored.repairMessageIds : [];
      restored.repairAcceptedByCharacterIds = Array.isArray(restored.repairAcceptedByCharacterIds)
        ? restored.repairAcceptedByCharacterIds
        : [];
      restored.schemaVersion = Math.max(2, restored.schemaVersion ?? 1);
      this.deceptions.set(restored.deceptionId, restored);
    }
  }

  private append<T>(stream: EventEnvelope["stream"], type: string, payload: T, options: {
    actorId?: string;
    characterId?: string;
    causationId?: string;
    correlationId?: string;
    visibility: VisibilityPolicy;
  }): EventEnvelope<T> {
    const sequence = ++this.sequence;
    const event: EventEnvelope<T> = {
      eventId: `event-${randomUUID()}`,
      roomId: this.roomId,
      stream,
      type,
      sequence,
      logicalTime: sequence,
      wallTime: new Date().toISOString(),
      ...(options.actorId ? { actorId: options.actorId } : {}),
      ...(options.characterId ? { characterId: options.characterId } : {}),
      ...(options.causationId ? { causationId: options.causationId } : {}),
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      visibility: structuredClone(options.visibility),
      schemaVersion: 1,
      payload: structuredClone(payload)
    };
    this.events.push(event);
    return event;
  }

  private upsertProposition(input: Omit<Proposition, "propositionId" | "sourceEventIds" | "schemaVersion"> & { sourceEventId: string }): Proposition {
    const semantic = {
      kind: input.kind,
      subjectId: input.subjectId,
      predicate: input.predicate,
      object: input.object,
      validFromLogicalTime: input.validFromLogicalTime,
      validUntilLogicalTime: input.validUntilLogicalTime
    };
    const propositionId = `prop-${createHash("sha256").update(stableJson(semantic)).digest("hex").slice(0, 24)}`;
    const existing = this.propositions.get(propositionId);
    if (existing) {
      if (!existing.sourceEventIds.includes(input.sourceEventId)) existing.sourceEventIds.push(input.sourceEventId);
      return existing;
    }
    const proposition: Proposition = {
      ...input,
      propositionId,
      sourceEventIds: [input.sourceEventId],
      schemaVersion: 1
    };
    delete (proposition as Proposition & { sourceEventId?: string }).sourceEventId;
    this.propositions.set(propositionId, proposition);
    return proposition;
  }

  private markDeceptionExecuted(
    deceptionId: string,
    message: SocialMessage,
    audienceActorIds: string[],
    propositionIds: string[],
    characterIdFor: (actorId: string) => string
  ): void {
    const episode = this.deceptions.get(deceptionId);
    if (!episode) throw new Error(`DECEPTION_NOT_FOUND: '${deceptionId}'.`);
    if (episode.deceiverActorId !== message.senderId) throw new Error("DECEPTION_OWNER_MISMATCH: Only the planner may execute this deception.");
    for (const propositionId of propositionIds) {
      if (!episode.intendedFalseBeliefIds.includes(propositionId)) episode.intendedFalseBeliefIds.push(propositionId);
    }
    const firstExecution = episode.executionMessageIds.length === 0;
    if (firstExecution) episode.executionMessageIds.push(message.id);
    else if (!episode.executionMessageIds.includes(message.id) && !episode.maintenanceMessageIds.includes(message.id)) {
      episode.maintenanceMessageIds.push(message.id);
    }
    advanceDeceptionStatus(episode, "attempted");
    const targetsWhoReceived = episode.targetAudienceIds.filter((target) => audienceActorIds.includes(target));
    if (targetsWhoReceived.length) advanceDeceptionStatus(episode, "received");
    for (const target of targetsWhoReceived) {
      const targetCharacterId = characterIdFor(target);
      if (!episode.receivedByCharacterIds.includes(targetCharacterId)) episode.receivedByCharacterIds.push(targetCharacterId);
      for (const propositionId of episode.intendedFalseBeliefIds) {
        const previous = [...this.beliefUpdates].reverse().find((entry) =>
          entry.ownerCharacterId === targetCharacterId && entry.propositionId === propositionId
        );
        const beliefId = previous?.beliefId ?? `belief-${targetCharacterId}-${propositionId}`;
        if (!episode.audienceBeliefsBefore.some((entry) => entry.characterId === targetCharacterId && entry.beliefId === beliefId)) {
          episode.audienceBeliefsBefore.push({
            characterId: targetCharacterId,
            beliefId,
            probability: previous?.afterProbability ?? 0.5
          });
        }
      }
    }
  }

  private reconcileDeceptionBelief(ownerCharacterId: string, belief: BeliefUpdateRecord, sourceEvents: EventEnvelope[]): void {
    const sourceMessageIds = new Set(sourceEvents.map((event) => String(asRecord(event.payload).messageId ?? "")));
    for (const episode of this.deceptions.values()) {
      if (!episode.targetAudienceCharacterIds.includes(ownerCharacterId)) continue;
      if (!episode.intendedFalseBeliefIds.includes(belief.propositionId)) continue;
      if (![...episode.executionMessageIds, ...episode.maintenanceMessageIds].some((messageId) => sourceMessageIds.has(messageId))) continue;
      const previousIndex = episode.audienceBeliefsAfter.findIndex((entry) =>
        entry.characterId === ownerCharacterId && entry.beliefId === belief.beliefId
      );
      const after = { characterId: ownerCharacterId, beliefId: belief.beliefId, probability: belief.afterProbability };
      if (previousIndex >= 0) episode.audienceBeliefsAfter[previousIndex] = after;
      else episode.audienceBeliefsAfter.push(after);
      const before = [...episode.audienceBeliefsBefore].reverse().find((entry) =>
        entry.characterId === ownerCharacterId && entry.beliefId === belief.beliefId
      )?.probability ?? belief.beforeProbability;
      if (belief.afterProbability >= 0.6 && belief.afterProbability - before >= 0.1) {
        if (!episode.believedByCharacterIds.includes(ownerCharacterId)) episode.believedByCharacterIds.push(ownerCharacterId);
        advanceDeceptionStatus(episode, "believed");
      }
    }
  }

  private recordDeceptionRepair(
    deceptionId: string,
    kind: SocialActDeclaration["kind"],
    message: SocialMessage,
    audienceActorIds: string[],
    visibility: VisibilityPolicy,
    characterIdFor: (actorId: string) => string
  ): void {
    const episode = this.deceptions.get(deceptionId);
    if (!episode) throw new Error(`DECEPTION_NOT_FOUND: '${deceptionId}'.`);
    const messageEventId = [...this.events].reverse().find((event) =>
      event.type === "message.sent" && asRecord(event.payload).messageId === message.id
    )?.eventId;
    if (message.senderId === episode.deceiverActorId) {
      if (kind !== "apology" && kind !== "disclosure") {
        throw new Error("DECEPTION_REPAIR_ACT_INVALID: The deceiver must use an apology or disclosure.");
      }
      if (episode.status !== "detected" && episode.status !== "repair-attempted") {
        throw new Error("DECEPTION_REPAIR_NOT_OPEN: A deception can be repaired only after detection.");
      }
      if (!episode.targetAudienceIds.some((target) => audienceActorIds.includes(target))) {
        throw new Error("DECEPTION_REPAIR_AUDIENCE_INVALID: At least one affected target must receive the repair.");
      }
      if (!episode.repairMessageIds.includes(message.id)) episode.repairMessageIds.push(message.id);
      advanceDeceptionStatus(episode, "repair-attempted");
      const event = this.append("social", "deception.repair-attempted", {
        deceptionId,
        messageId: message.id,
        kind
      }, {
        actorId: message.senderId,
        characterId: episode.deceiverCharacterId,
        causationId: messageEventId ?? episode.detectionEventIds.at(-1),
        correlationId: deceptionId,
        visibility
      });
      if (!episode.consequenceEventIds.includes(event.eventId)) episode.consequenceEventIds.push(event.eventId);
      return;
    }

    if (!episode.targetAudienceIds.includes(message.senderId)) {
      throw new Error("DECEPTION_REPAIR_ACCEPTOR_INVALID: Only an affected target may accept repair.");
    }
    if (kind !== "acceptance" && kind !== "endorsement") {
      throw new Error("DECEPTION_REPAIR_ACCEPTANCE_ACT_INVALID: Use acceptance or endorsement to confirm repair.");
    }
    if (episode.status !== "repair-attempted" || !episode.repairMessageIds.length) {
      throw new Error("DECEPTION_REPAIR_NOT_PROPOSED: The deceiver has not made a repair attempt.");
    }
    if (!audienceActorIds.includes(episode.deceiverActorId)) {
      throw new Error("DECEPTION_REPAIR_ACCEPTANCE_AUDIENCE_INVALID: The deceiver must receive the acceptance.");
    }
    const acceptorCharacterId = characterIdFor(message.senderId);
    if (!episode.repairAcceptedByCharacterIds.includes(acceptorCharacterId)) {
      episode.repairAcceptedByCharacterIds.push(acceptorCharacterId);
    }
    const affected = episode.receivedByCharacterIds.length
      ? episode.receivedByCharacterIds
      : episode.targetAudienceCharacterIds;
    const fullyAccepted = affected.length > 0
      && affected.every((characterId) => episode.repairAcceptedByCharacterIds.includes(characterId));
    if (fullyAccepted) advanceDeceptionStatus(episode, "repaired");
    const event = this.append("social", fullyAccepted ? "deception.repaired" : "deception.repair-accepted", {
      deceptionId,
      messageId: message.id,
      acceptorCharacterId,
      fullyAccepted
    }, {
      actorId: message.senderId,
      characterId: acceptorCharacterId,
      causationId: messageEventId ?? episode.consequenceEventIds.at(-1),
      correlationId: deceptionId,
      visibility
    });
    if (!episode.consequenceEventIds.includes(event.eventId)) episode.consequenceEventIds.push(event.eventId);
  }

  private assertDeceptionRepairAllowed(
    episode: DeceptionEpisode,
    kind: SocialActDeclaration["kind"],
    senderActorId: string,
    audienceActorIds: string[]
  ): void {
    if (senderActorId === episode.deceiverActorId) {
      if (kind !== "apology" && kind !== "disclosure") {
        throw new Error("DECEPTION_REPAIR_ACT_INVALID: The deceiver must use an apology or disclosure.");
      }
      if (episode.status !== "detected" && episode.status !== "repair-attempted") {
        throw new Error("DECEPTION_REPAIR_NOT_OPEN: A deception can be repaired only after detection.");
      }
      if (!episode.targetAudienceIds.some((target) => audienceActorIds.includes(target))) {
        throw new Error("DECEPTION_REPAIR_AUDIENCE_INVALID: At least one affected target must receive the repair.");
      }
      return;
    }
    if (!episode.targetAudienceIds.includes(senderActorId)) {
      throw new Error("DECEPTION_REPAIR_ACCEPTOR_INVALID: Only an affected target may accept repair.");
    }
    if (kind !== "acceptance" && kind !== "endorsement") {
      throw new Error("DECEPTION_REPAIR_ACCEPTANCE_ACT_INVALID: Use acceptance or endorsement to confirm repair.");
    }
    if (episode.status !== "repair-attempted" || !episode.repairMessageIds.length) {
      throw new Error("DECEPTION_REPAIR_NOT_PROPOSED: The deceiver has not made a repair attempt.");
    }
    if (!audienceActorIds.includes(episode.deceiverActorId)) {
      throw new Error("DECEPTION_REPAIR_ACCEPTANCE_AUDIENCE_INVALID: The deceiver must receive the acceptance.");
    }
  }

  private detectFeignedCommitment(
    commitment: CommitmentRecord,
    violationEventId: string,
    visibility: VisibilityPolicy
  ): void {
    if (!commitment.createdByCommandId) return;
    for (const episode of this.deceptions.values()) {
      if (episode.mode !== "feigned-commitment" || episode.deceiverActorId !== commitment.promisorActorId) continue;
      if (!episode.supportingActionReceiptIds.includes(commitment.createdByCommandId)) continue;
      if (!episode.contradictionEventIds.includes(violationEventId)) episode.contradictionEventIds.push(violationEventId);
      if (!episode.detectionEventIds.includes(violationEventId)) episode.detectionEventIds.push(violationEventId);
      episode.exposureVisibility = visibility.kind === "public" ? "public" : "targets";
      advanceDeceptionStatus(episode, "detected");
      const detection = this.append("social", "deception.detected", {
        deceptionId: episode.deceptionId,
        mode: episode.mode,
        commitmentId: commitment.commitmentId,
        violationEventId
      }, {
        actorId: episode.deceiverActorId,
        characterId: episode.deceiverCharacterId,
        causationId: violationEventId,
        correlationId: episode.deceptionId,
        visibility
      });
      if (!episode.consequenceEventIds.includes(detection.eventId)) episode.consequenceEventIds.push(detection.eventId);
    }
  }

  private detectIdentityDeceptions(subjectCharacterId: string, actualRoleId: string, revealEventId: string): string[] {
    const detected = new Set<string>();
    for (const act of this.socialActs) {
      if (!act.deceptionId || !act.messageId) continue;
      const falseIdentityClaim = act.propositionIds.some((propositionId) => {
        const proposition = this.propositions.get(propositionId);
        return proposition?.kind === "identity"
          && proposition.subjectId === subjectCharacterId
          && proposition.predicate === "has-role"
          && proposition.object !== actualRoleId;
      });
      if (!falseIdentityClaim) continue;
      const episode = this.deceptions.get(act.deceptionId);
      if (!episode || !episode.executionMessageIds.includes(act.messageId)) continue;
      detected.add(episode.deceptionId);
      if (!episode.detectionEventIds.includes(revealEventId)) episode.detectionEventIds.push(revealEventId);
      if (!episode.contradictionEventIds.includes(revealEventId)) episode.contradictionEventIds.push(revealEventId);
      advanceDeceptionStatus(episode, "detected");
      const messageEvent = this.events.find((event) => {
        const payload = asRecord(event.payload);
        return event.type === "message.sent" && payload.messageId === act.messageId;
      });
      const publicExposure = messageEvent?.visibility.kind === "public";
      episode.exposureVisibility = publicExposure ? "public" : "targets";
      const visibility: VisibilityPolicy = publicExposure
        ? { kind: "public" }
        : { kind: "actors", actorIds: [...new Set([episode.deceiverActorId, ...episode.targetAudienceIds])] };
      const detection = this.append("social", "deception.detected", {
        deceptionId: episode.deceptionId,
        executionMessageId: act.messageId,
        contradictedPropositionIds: act.propositionIds,
        revealEventId
      }, {
        actorId: episode.deceiverActorId,
        characterId: episode.deceiverCharacterId,
        causationId: revealEventId,
        correlationId: episode.deceptionId,
        visibility
      });
      if (!episode.consequenceEventIds.includes(detection.eventId)) episode.consequenceEventIds.push(detection.eventId);
    }
    return [...detected];
  }

  private resolveBeliefsFromWorldResult(
    proposition: Proposition,
    actual: boolean,
    evidenceId: string,
    revealEventId: string,
    actorIdForCharacter: (characterId: string) => string | undefined
  ): void {
    const latestByOwner = new Map<string, BeliefUpdateRecord>();
    for (const update of this.beliefUpdates) {
      if (update.propositionId === proposition.propositionId) latestByOwner.set(update.ownerCharacterId, update);
    }
    for (const previous of latestByOwner.values()) {
      const ownerActorId = actorIdForCharacter(previous.ownerCharacterId);
      if (!ownerActorId || (previous.afterProbability === (actual ? 1 : 0) && previous.confidence === 1)) continue;
      const logicalTime = this.sequence + 1;
      const resolution: BeliefUpdateRecord = {
        beliefUpdateId: `belief-update-${randomUUID()}`,
        beliefId: previous.beliefId,
        ownerCharacterId: previous.ownerCharacterId,
        propositionId: proposition.propositionId,
        beforeProbability: previous.afterProbability,
        afterProbability: actual ? 1 : 0,
        confidence: 1,
        addedEvidenceIds: [evidenceId],
        removedEvidenceIds: [],
        reasonCode: "world-resolution",
        logicalTime,
        provenance: {
          sourceKind: "world-fact",
          sourceIds: [revealEventId, evidenceId],
          confidence: 1,
          createdAtLogical: logicalTime,
          schemaVersion: 1
        }
      };
      this.beliefUpdates.push(resolution);
      this.append("social", "belief.resolved", structuredClone(resolution), {
        actorId: ownerActorId,
        characterId: previous.ownerCharacterId,
        causationId: revealEventId,
        visibility: { kind: "actors", actorIds: [ownerActorId] }
      });
    }
  }

  private buildCandidateIntents(input: {
    actorId: string;
    characterId: string;
    action: string;
    payload: Record<string, unknown>;
    evidenceRefs: string[];
    relevantBeliefIds: string[];
    relevantActorModelIds: string[];
    logicalTime: number;
    activationId?: string;
    characterIdFor(actorId: string): string;
  }): CandidateIntent[] {
    const rawCandidates = Array.isArray(input.payload.candidateIntents)
      ? input.payload.candidateIntents.map(asRecord).slice(0, 4)
      : [];
    const candidates = rawCandidates.flatMap((raw): CandidateIntent[] => {
      const summary = shortText(raw.summary, 600);
      const goal = shortText(raw.goal, 400);
      const action = shortText(raw.action, 120);
      if (!summary || !goal || !action) return [];
      const predictedResponses = Array.isArray(raw.predictedResponses)
        ? raw.predictedResponses.map(asRecord).flatMap((response) => {
            const targetActorId = shortText(response.targetActorId, 160);
            const description = shortText(response.response, 500);
            if (!targetActorId || !description) return [];
            let targetCharacterId: string;
            try {
              targetCharacterId = input.characterIdFor(targetActorId);
            } catch {
              return [];
            }
            return [{ targetCharacterId, response: description, probability: clamp01(numberOr(response.probability, 0.5)) }];
          }).slice(0, 6)
        : [];
      const expectedUtility = optionalFinite(raw.expectedUtility);
      const exposureRisk = optionalFinite(raw.exposureRisk);
      const relationshipRisk = optionalFinite(raw.relationshipRisk);
      return [{
        intentId: `candidate-intent-${randomUUID()}`,
        actorId: input.actorId,
        characterId: input.characterId,
        ...(input.activationId ? { activationId: input.activationId } : {}),
        goal,
        summary,
        ...(shortText(raw.publicStrategy, 500) ? { publicStrategy: shortText(raw.publicStrategy, 500) } : {}),
        possibleActions: [{ action, ...(shortText(raw.payloadSummary, 300) ? { payloadSummary: shortText(raw.payloadSummary, 300) } : {}) }],
        ...(expectedUtility === undefined ? {} : { expectedUtility }),
        ...(exposureRisk === undefined ? {} : { exposureRisk: clamp01(exposureRisk) }),
        ...(relationshipRisk === undefined ? {} : { relationshipRisk: clamp01(relationshipRisk) }),
        predictedResponses,
        evidenceRefs: input.evidenceRefs,
        beliefRefs: input.relevantBeliefIds,
        actorModelRefs: input.relevantActorModelIds,
        source: "agent-self-report",
        logicalTime: input.logicalTime,
        schemaVersion: 1
      }];
    });
    if (!candidates.some((candidate) => candidate.possibleActions.some((action) => action.action === input.action))) {
      const fallback = this.fallbackCandidateIntent(input);
      if (candidates.length >= 4) candidates[candidates.length - 1] = fallback;
      else candidates.push(fallback);
    }
    return candidates.length ? candidates : [this.fallbackCandidateIntent(input)];
  }

  private fallbackCandidateIntent(input: {
    actorId: string;
    characterId: string;
    action: string;
    payload: Record<string, unknown>;
    evidenceRefs: string[];
    relevantBeliefIds: string[];
    relevantActorModelIds: string[];
    logicalTime: number;
    activationId?: string;
  }): CandidateIntent {
    const reason = shortText(input.payload.reason, 600);
    return {
      intentId: `candidate-intent-${randomUUID()}`,
      actorId: input.actorId,
      characterId: input.characterId,
      ...(input.activationId ? { activationId: input.activationId } : {}),
      goal: "Complete the current legal action",
      summary: reason || input.action,
      possibleActions: [{ action: input.action, ...(payloadSummary(input.payload) ? { payloadSummary: payloadSummary(input.payload) } : {}) }],
      predictedResponses: [],
      evidenceRefs: input.evidenceRefs,
      beliefRefs: input.relevantBeliefIds,
      actorModelRefs: input.relevantActorModelIds,
      source: "bounded-rule",
      logicalTime: input.logicalTime,
      schemaVersion: 1
    };
  }

  private visibleEvidenceRefs(ownerCharacterId: string, refs: string[]): string[] {
    return [...new Set(refs)].filter((id) => this.evidence.some((entry) =>
      entry.evidenceId === id && (entry.observerCharacterId === ownerCharacterId || entry.visibility === "public")
    ));
  }

  private ownedBeliefRefs(ownerCharacterId: string, refs: string[]): string[] {
    return [...new Set(refs)].filter((id) => this.beliefUpdates.some((entry) =>
      entry.beliefId === id && entry.ownerCharacterId === ownerCharacterId
    ));
  }

  private ownedActorModelRefs(ownerCharacterId: string, refs: string[]): string[] {
    return [...new Set(refs)].filter((id) => this.actorModels.get(id)?.ownerCharacterId === ownerCharacterId);
  }

  private ownedRelationshipRefs(ownerCharacterId: string, refs: string[]): string[] {
    return [...new Set(refs)].filter((id) => this.directedRelationships.get(id)?.ownerCharacterId === ownerCharacterId);
  }

  private visibleCommitmentRefs(actorId: string, refs: string[]): string[] {
    return [...new Set(refs)].filter((id) => {
      const commitment = this.commitments.get(id);
      return Boolean(commitment && (commitment.promisorActorId === actorId || commitment.audienceActorIds.includes(actorId)));
    });
  }

  private ownedDeceptionRefs(actorId: string, refs: string[]): string[] {
    return [...new Set(refs)].filter((id) => this.deceptions.get(id)?.deceiverActorId === actorId);
  }

  private linkCitedSources(decision: SocialDecisionRecord, includeCommitments: boolean): void {
    if (includeCommitments) {
      for (const commitmentId of decision.openCommitmentIds) {
        const commitment = this.commitments.get(commitmentId);
        const sourceEventId = commitment?.sourceEventIds[0];
        if (!sourceEventId) continue;
        this.appendInfluenceLink({
          sourceEventId,
          targetCharacterId: decision.characterId,
          beliefUpdateIds: [],
          decision,
          confidence: 1,
          basis: "direct-commitment-reference"
        });
      }
    }
    for (const evidenceId of decision.evidenceRefs) {
      const evidence = this.evidence.find((entry) => entry.evidenceId === evidenceId);
      if (!evidence?.sourceEventId) continue;
      this.appendInfluenceLink({
        sourceEventId: evidence.sourceEventId,
        targetCharacterId: decision.characterId,
        beliefUpdateIds: this.beliefUpdates
          .filter((entry) => entry.ownerCharacterId === decision.characterId && entry.addedEvidenceIds.includes(evidenceId))
          .map((entry) => entry.beliefUpdateId),
        decision,
        confidence: 0.9,
        basis: "agent-cited"
      });
    }
  }

  private appendInfluenceLink(input: {
    sourceEventId: string;
    targetCharacterId: string;
    beliefUpdateIds: string[];
    decision: SocialDecisionRecord;
    confidence: number;
    basis: InfluenceLink["basis"];
  }): InfluenceLink {
    const link: InfluenceLink = {
      influenceId: `influence-${randomUUID()}`,
      sourceEventId: input.sourceEventId,
      targetCharacterId: input.targetCharacterId,
      beliefUpdateIds: [...new Set(input.beliefUpdateIds)],
      decisionId: input.decision.decisionId,
      resultingActionReceiptId: input.decision.actionReceiptId,
      confidence: clamp01(input.confidence),
      basis: input.basis,
      logicalTime: this.sequence + 1,
      schemaVersion: 1
    };
    this.influenceLinks.push(link);
    this.append("social", "influence.linked", structuredClone(link), {
      actorId: input.decision.actorId,
      characterId: input.decision.characterId,
      causationId: input.sourceEventId,
      correlationId: input.decision.actionReceiptId,
      visibility: { kind: "actors", actorIds: [input.decision.actorId] }
    });
    return link;
  }

  private reconcileDeceptionDecision(decision: SocialDecisionRecord): void {
    const beliefPropositionIds = new Set(this.beliefUpdates
      .filter((entry) => decision.relevantBeliefIds.includes(entry.beliefId) && entry.ownerCharacterId === decision.characterId)
      .map((entry) => entry.propositionId));
    for (const episode of this.deceptions.values()) {
      if (!episode.targetAudienceIds.includes(decision.actorId)) continue;
      if (!episode.intendedFalseBeliefIds.some((id) => beliefPropositionIds.has(id))) continue;
      if (!episode.inducedDecisionIds.includes(decision.decisionId)) episode.inducedDecisionIds.push(decision.decisionId);
      if (!episode.inducedActionReceiptIds.includes(decision.actionReceiptId)) episode.inducedActionReceiptIds.push(decision.actionReceiptId);
      advanceDeceptionStatus(episode, "behaviorally-effective");
      const consequenceEventId = decision.resultingEventIds[0];
      if (consequenceEventId && !episode.consequenceEventIds.includes(consequenceEventId)) {
        episode.consequenceEventIds.push(consequenceEventId);
      }
    }
  }

  private recentVisibleEventIds(actorId: string, limit: number, predicate?: (event: EventEnvelope) => boolean): string[] {
    return this.events
      .filter((event) => this.canView(event.visibility, { actorId }) && (predicate?.(event) ?? true))
      .slice(-limit)
      .map((event) => event.eventId);
  }

  private canView(visibility: VisibilityPolicy, viewer: ViewerContext): boolean {
    if (viewer.omniscient) return true;
    if (visibility.kind === "public") return true;
    if (visibility.kind === "operator") return false;
    return Boolean(viewer.actorId && visibility.actorIds.includes(viewer.actorId));
  }
}

function propositionKindFor(kind: SocialActDeclaration["kind"]): Proposition["kind"] {
  if (kind === "promise" || kind === "offer" || kind === "threat") return "future-action";
  if (kind === "alliance-proposal") return "relationship";
  if (kind === "accusation" || kind === "defense" || kind === "endorsement") return "evaluation";
  return "evaluation";
}

function advanceDeceptionStatus(episode: DeceptionEpisode, next: DeceptionEpisode["status"]): void {
  if (episode.status === "repaired") return;
  if (next === "detected") {
    episode.status = "detected";
    return;
  }
  if (next === "repaired") {
    if (episode.status === "detected" || episode.status === "repair-attempted") episode.status = "repaired";
    return;
  }
  if (next === "repair-attempted") {
    if (episode.status === "detected" || episode.status === "repair-attempted") episode.status = "repair-attempted";
    return;
  }
  if (episode.status === "detected" || episode.status === "repair-attempted" || episode.status === "failed" || episode.status === "abandoned") return;
  const rank: Record<Exclude<DeceptionEpisode["status"], "failed" | "abandoned" | "detected" | "repair-attempted" | "repaired">, number> = {
    planned: 0,
    attempted: 1,
    received: 2,
    believed: 3,
    "behaviorally-effective": 4
  };
  if (next in rank && rank[next as keyof typeof rank] > rank[episode.status as keyof typeof rank]) {
    episode.status = next;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function relationshipDimensions(value: RelationshipDimensions): RelationshipDimensions {
  return {
    trust: clamp01(value.trust),
    affinity: clamp01(value.affinity),
    respect: clamp01(value.respect),
    tension: clamp01(value.tension),
    familiarity: clamp01(value.familiarity)
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 20) : [];
}

function shortText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function optionalFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return optionalFinite(value) ?? fallback;
}

function integerInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function payloadSummary(payload: Record<string, unknown>): string {
  const safeKeys = ["amount", "choice", "targetId", "actionType"];
  const values = safeKeys.flatMap((key) => {
    const value = payload[key];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [`${key}=${String(value)}`]
      : [];
  });
  return values.join(", ").slice(0, 300);
}

function parseOutcomePredictions(value: unknown): OutcomePrediction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.map(asRecord).flatMap((entry): OutcomePrediction[] => {
    const outcomeKey = shortText(entry.outcomeKey, 120);
    const proposition = shortText(entry.proposition, 500);
    const probability = optionalFinite(entry.probability);
    const horizon = entry.horizon;
    if (
      !outcomeKey || !proposition || probability === undefined || seen.has(outcomeKey) ||
      (horizon !== "immediate" && horizon !== "round" && horizon !== "game" && horizon !== "future-game")
    ) return [];
    seen.add(outcomeKey);
    return [{ outcomeKey, proposition, probability: clamp01(probability), horizon }];
  }).slice(0, 8);
}

function normalizeDecisionRecord(value: SocialDecisionRecord): SocialDecisionRecord {
  const legacy = value as SocialDecisionRecord & {
    selectedIntent?: { intentId?: string; summary?: string; publicStrategy?: string };
    candidateIntentIds?: string[];
    strategySelectionId?: string;
    relevantActorModelIds?: string[];
    predictedConsequences?: OutcomePrediction[];
    resultingEventIds?: string[];
    strategyProfileSnapshotId?: string;
  };
  const intentId = legacy.selectedIntent?.intentId ?? `legacy-intent:${legacy.decisionId}`;
  const summary = legacy.selectedIntent?.summary?.trim() || legacy.action;
  return {
    ...structuredClone(value),
    observationRefs: [...(legacy.observationRefs ?? [])],
    evidenceRefs: [...(legacy.evidenceRefs ?? [])],
    relevantBeliefIds: [...(legacy.relevantBeliefIds ?? [])],
    relevantActorModelIds: [...(legacy.relevantActorModelIds ?? [])],
    relevantRelationshipIds: [...(legacy.relevantRelationshipIds ?? [])],
    openCommitmentIds: [...(legacy.openCommitmentIds ?? [])],
    activeDeceptionIds: [...(legacy.activeDeceptionIds ?? [])],
    candidateIntentIds: legacy.candidateIntentIds?.length ? [...legacy.candidateIntentIds] : [intentId],
    strategySelectionId: legacy.strategySelectionId ?? `legacy-selection:${legacy.decisionId}`,
    ...(legacy.strategyProfileSnapshotId ? { strategyProfileSnapshotId: legacy.strategyProfileSnapshotId } : {}),
    selectedIntent: {
      intentId,
      summary,
      ...(legacy.selectedIntent?.publicStrategy ? { publicStrategy: legacy.selectedIntent.publicStrategy } : {})
    },
    predictedConsequences: structuredClone(legacy.predictedConsequences ?? []),
    resultingEventIds: [...(legacy.resultingEventIds ?? [])]
  };
}

function normalizeCommitmentRecord(value: CommitmentRecord): CommitmentRecord {
  const legacy = value as CommitmentRecord & {
    acceptedByActorIds?: string[];
    acceptedByCommandIds?: string[];
  };
  return {
    ...structuredClone(value),
    acceptedByActorIds: [...(legacy.acceptedByActorIds ?? [])],
    acceptedByCommandIds: [...(legacy.acceptedByCommandIds ?? [])]
  };
}

function normalizePublicEvidence(source: EvidenceRecord[]): {
  evidence: EvidenceRecord[];
  replacements: Map<string, string>;
} {
  const evidence: EvidenceRecord[] = [];
  const replacements = new Map<string, string>();
  const canonicalBySource = new Map<string, EvidenceRecord>();
  for (const sourceRecord of structuredClone(source)) {
    if (sourceRecord.visibility !== "public") {
      evidence.push(sourceRecord);
      continue;
    }
    const key = stableJson({
      propositionId: sourceRecord.propositionId,
      sourceEventId: sourceRecord.sourceEventId,
      sourceMessageId: sourceRecord.sourceMessageId,
      sourceType: sourceRecord.sourceType,
      supports: sourceRecord.supports
    });
    const canonical = canonicalBySource.get(key);
    if (canonical) {
      replacements.set(sourceRecord.evidenceId, canonical.evidenceId);
      continue;
    }
    sourceRecord.observerCharacterId = "public";
    canonicalBySource.set(key, sourceRecord);
    evidence.push(sourceRecord);
  }
  return { evidence, replacements };
}

function remapUniqueIds(ids: string[], replacements: Map<string, string>): string[] {
  return [...new Set(ids.map((id) => replacements.get(id) ?? id))];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
