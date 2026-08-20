import { createHash, randomUUID } from "node:crypto";
import type { Commitment, SocialMessage, WorldActionCommit, WorldLogEntry } from "../contracts";
import type {
  BeliefSelfReportInput,
  BeliefUpdateRecord,
  CommitmentRecord,
  DeceptionEpisode,
  DeceptionPlanInput,
  EventEnvelope,
  EvidenceRecord,
  Proposition,
  SocialActDeclaration,
  SocialActRecord,
  SocialCausalityProjection,
  SocialCausalityState,
  SocialDecisionRecord,
  VisibilityPolicy
} from "./contracts";

export const SOCIAL_CAUSALITY_SCHEMA_VERSION = 2;

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
  private readonly commitments = new Map<string, CommitmentRecord>();
  private readonly decisions: SocialDecisionRecord[] = [];
  private readonly deceptions = new Map<string, DeceptionEpisode>();

  constructor(private readonly roomId: string) {}

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
          ...(declaration.proposition.subjectId ? { subjectId: declaration.proposition.subjectId } : {}),
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
        ...(declaration.deceptionId ? { deceptionId: declaration.deceptionId } : {})
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
        for (const observerActorId of audienceActorIds) {
          this.evidence.push({
            evidenceId: `evidence-${randomUUID()}`,
            observerCharacterId: characterIdFor(observerActorId),
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

      if (declaration.deceptionId) this.markDeceptionExecuted(declaration.deceptionId, message, audienceActorIds, characterIdFor);
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
  }): SocialDecisionRecord {
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
    const record: SocialDecisionRecord = {
      decisionId: `social-decision-${randomUUID()}`,
      actorId: input.actorId,
      characterId: input.characterId,
      ...(input.activationId ? { activationId: input.activationId } : {}),
      logicalTime: envelope.logicalTime,
      observationRefs: this.recentVisibleEventIds(input.actorId, 12),
      evidenceRefs: stringArray(payload.referencedEvidenceIds),
      relevantBeliefIds: stringArray(payload.referencedBeliefIds),
      openCommitmentIds: stringArray(payload.referencedCommitmentIds),
      activeDeceptionIds: stringArray(payload.referencedDeceptionIds),
      selectedIntent: { summary: typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : input.action },
      action: input.action,
      actionReceiptId: receiptId,
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
    this.append("social", "commitment.proposed", structuredClone(record), {
      actorId: commitment.promisorActorId,
      characterId: commitment.promisorCharacterId,
      causationId: envelope.eventId,
      visibility
    });
    return structuredClone(record);
  }

  settleCommitment(commitment: Commitment, allActorIds: string[]): CommitmentRecord {
    const record = this.commitments.get(commitment.commitmentId);
    if (!record) throw new Error(`COMMITMENT_NOT_RECORDED: '${commitment.commitmentId}'.`);
    if (commitment.state === "proposed") throw new Error(`COMMITMENT_NOT_SETTLED: '${commitment.commitmentId}'.`);
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
    return structuredClone(record);
  }

  recordBeliefUpdate(ownerActorId: string, ownerCharacterId: string, input: BeliefSelfReportInput): BeliefUpdateRecord {
    const sourceEvents = this.events.filter((event) => {
      const payload = asRecord(event.payload);
      return input.sourceMessageIds?.includes(String(payload.messageId ?? ""));
    });
    const proposition = this.upsertProposition({
      kind: "evaluation",
      subjectId: input.subjectId,
      predicate: input.proposition.trim(),
      truthStatus: "subjective",
      groundTruthVisibility: "no-objective-ground-truth",
      sourceEventId: sourceEvents.at(-1)?.eventId ?? `self-report:${ownerActorId}`
    });
    const evidenceIds: string[] = [];
    for (const event of sourceEvents) {
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

  recordDeceptionPlan(actorId: string, characterId: string, input: DeceptionPlanInput): DeceptionEpisode {
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
      mode: input.mode,
      truePropositionIds,
      intendedFalseBeliefIds: [intended.propositionId],
      motiveGoalIds: input.motive ? [input.motive] : [],
      ...(input.expectedGain ? { expectedGain: input.expectedGain } : {}),
      ...(input.perceivedDetectionRisk === undefined ? {} : { perceivedDetectionRisk: clamp01(input.perceivedDetectionRisk) }),
      plannedAtLogicalTime: logicalTime,
      sourcePlanRecordId: `deception-plan:${actorId}:${logicalTime}`,
      executionMessageIds: [],
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
      schemaVersion: 1
    };
    this.deceptions.set(episode.deceptionId, episode);
    this.append("social", "deception.planned", { deceptionId: episode.deceptionId, mode: episode.mode }, {
      actorId,
      characterId,
      visibility: { kind: "actors", actorIds: [actorId] }
    });
    return structuredClone(episode);
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
        if (omniscient || act.actorId === actorId || !act.deceptionId) return structuredClone(act);
        const { deceptionId: _privateDeceptionId, ...safe } = act;
        return structuredClone(safe);
      });
    const propositionIds = new Set(socialActs.flatMap((act) => act.propositionIds));
    for (const update of this.beliefUpdates) {
      if (omniscient || update.ownerCharacterId === characterId) propositionIds.add(update.propositionId);
    }
    const evidence = this.evidence.filter((entry) => omniscient || entry.observerCharacterId === characterId);
    for (const entry of evidence) propositionIds.add(entry.propositionId);
    const commitments = [...this.commitments.values()].filter((entry) => entry.sourceEventIds.some((eventId) => eventIds.has(eventId)));
    for (const commitment of commitments) propositionIds.add(commitment.propositionId);
    return {
      schemaVersion: SOCIAL_CAUSALITY_SCHEMA_VERSION,
      lastSequence: this.sequence,
      events: structuredClone(events),
      propositions: [...this.propositions.values()].filter((entry) => propositionIds.has(entry.propositionId)).map((entry) => structuredClone(entry)),
      socialActs,
      evidence: structuredClone(evidence),
      beliefUpdates: this.beliefUpdates.filter((entry) => omniscient || entry.ownerCharacterId === characterId).map((entry) => structuredClone(entry)),
      commitments: structuredClone(commitments),
      decisions: this.decisions.filter((entry) => omniscient || entry.actorId === actorId).map((entry) => structuredClone(entry)),
      deceptions: [...this.deceptions.values()].filter((entry) => omniscient || entry.deceiverActorId === actorId).map((entry) => structuredClone(entry))
    };
  }

  exportState(): SocialCausalityState {
    return { roomId: this.roomId, ...this.project({ omniscient: true }) };
  }

  restoreState(state: SocialCausalityState | undefined): void {
    if (!state) return;
    if (state.schemaVersion !== 1 && state.schemaVersion !== SOCIAL_CAUSALITY_SCHEMA_VERSION) {
      throw new Error(`SOCIAL_CAUSALITY_SCHEMA_UNSUPPORTED: ${state.schemaVersion}`);
    }
    if (state.roomId !== this.roomId) throw new Error(`SOCIAL_CAUSALITY_ROOM_MISMATCH: ${state.roomId}`);
    this.sequence = state.lastSequence;
    this.events.splice(0, this.events.length, ...structuredClone(state.events));
    this.propositions.clear();
    for (const proposition of state.propositions) this.propositions.set(proposition.propositionId, structuredClone(proposition));
    this.socialActs.splice(0, this.socialActs.length, ...structuredClone(state.socialActs));
    this.evidence.splice(0, this.evidence.length, ...structuredClone(state.evidence));
    this.beliefUpdates.splice(0, this.beliefUpdates.length, ...structuredClone(state.beliefUpdates));
    this.commitments.clear();
    for (const commitment of state.commitments ?? []) this.commitments.set(commitment.commitmentId, structuredClone(commitment));
    this.decisions.splice(0, this.decisions.length, ...structuredClone(state.decisions));
    this.deceptions.clear();
    for (const deception of state.deceptions) this.deceptions.set(deception.deceptionId, structuredClone(deception));
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
    characterIdFor: (actorId: string) => string
  ): void {
    const episode = this.deceptions.get(deceptionId);
    if (!episode) throw new Error(`DECEPTION_NOT_FOUND: '${deceptionId}'.`);
    if (episode.deceiverActorId !== message.senderId) throw new Error("DECEPTION_OWNER_MISMATCH: Only the planner may execute this deception.");
    episode.executionMessageIds.push(message.id);
    episode.status = "attempted";
    const targetsWhoReceived = episode.targetAudienceIds.filter((target) => audienceActorIds.includes(target));
    if (targetsWhoReceived.length) episode.status = "received";
    for (const target of targetsWhoReceived) {
      for (const propositionId of episode.intendedFalseBeliefIds) {
        const previous = [...this.beliefUpdates].reverse().find((entry) =>
          entry.ownerCharacterId === characterIdFor(target) && entry.propositionId === propositionId
        );
        episode.audienceBeliefsBefore.push({
          characterId: characterIdFor(target),
          beliefId: previous?.beliefId ?? `belief-${characterIdFor(target)}-${propositionId}`,
          probability: previous?.afterProbability ?? 0.5
        });
      }
    }
  }

  private reconcileDeceptionBelief(ownerCharacterId: string, belief: BeliefUpdateRecord, sourceEvents: EventEnvelope[]): void {
    const sourceMessageIds = new Set(sourceEvents.map((event) => String(asRecord(event.payload).messageId ?? "")));
    for (const episode of this.deceptions.values()) {
      if (!episode.intendedFalseBeliefIds.includes(belief.propositionId)) continue;
      if (!episode.executionMessageIds.some((messageId) => sourceMessageIds.has(messageId))) continue;
      episode.audienceBeliefsAfter.push({ characterId: ownerCharacterId, beliefId: belief.beliefId, probability: belief.afterProbability });
      if (belief.afterProbability >= 0.6) episode.status = "believed";
    }
  }

  private recentVisibleEventIds(actorId: string, limit: number): string[] {
    return this.events
      .filter((event) => this.canView(event.visibility, { actorId }))
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 20) : [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
