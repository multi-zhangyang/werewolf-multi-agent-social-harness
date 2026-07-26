import { cloneJson, deterministicTimestamp, requireEvidence, round3 } from "./recordUtils";
import { createSocialStateMutationJournal } from "./factories";
import { type AgentSocialState, type BeliefClaim, type BetrayalRecord, type CoalitionRecord, type CommitmentRecord, type EvidenceArtifactKind, type EvidenceRef, type GoalRecord, type GossipRecord, type NormRecord, type NormSanctionRecord, type RelationshipEdge, type ReputationRecord, type SocialMemoryEntry, type SocialStateMutationContext, type SocialStateMutationJournal, type SocialStateMutationJournalEntry, type SocialStateMutationKind, type SocialStateMutationRange, type SocialStateMutationStore, type SocialStateMutationSummary, type TheoryOfMindAttribution, type TrustRepairRecord } from "./contracts";
export function ensureSocialStateMutationJournal(state: AgentSocialState, maxEntries = 1000): SocialStateMutationJournal {
  state.journal ??= createSocialStateMutationJournal(maxEntries);
  return state.journal;
}

export function recordSocialStateMutation(
  state: AgentSocialState,
  input: {
    store: SocialStateMutationStore;
    mutationKind: SocialStateMutationKind;
    subjectId?: string;
    beforeSummary?: SocialStateMutationSummary;
    afterSummary?: SocialStateMutationSummary;
    deltaSummary?: SocialStateMutationSummary;
    evidenceRefs: EvidenceRef[];
    context?: SocialStateMutationContext;
    metadata?: Record<string, unknown>;
  }
): SocialStateMutationJournalEntry {
  const evidenceRefs = cloneJson(input.evidenceRefs);
  requireEvidence(evidenceRefs, "social-state journal mutation");
  const journal = ensureSocialStateMutationJournal(state);
  const journalSeq = journal.nextSeq;
  const entry: SocialStateMutationJournalEntry = {
    journalSeq,
    agentId: state.agentId,
    profileId: state.profile.id,
    traceId: input.context?.traceId,
    turnIndex: input.context?.turnIndex,
    phase: input.context?.phase,
    day: input.context?.day,
    store: input.store,
    mutationKind: input.mutationKind,
    subjectId: input.subjectId,
    beforeSummary: cloneJson(input.beforeSummary),
    afterSummary: cloneJson(input.afterSummary),
    deltaSummary: cloneJson(input.deltaSummary),
    evidenceRefs,
    messageSeqRange: cloneJson(input.context?.messageSeqRange),
    eventSeqRange: cloneJson(input.context?.eventSeqRange),
    redactionClass: "agent_private_summary",
    hiddenTruthUsed: false,
    createdAt: deterministicTimestamp(journalSeq),
    metadata: journalMetadata(input.metadata)
  };
  journal.entries.push(entry);
  journal.nextSeq += 1;
  if (journal.entries.length > journal.maxEntries) {
    journal.entries = journal.entries.slice(-journal.maxEntries);
  }
  return cloneJson(entry);
}


export function summarizeMemoryEntry<TObservation, TPending, TCommand>(
  entry: SocialMemoryEntry<TObservation, TPending, TCommand>
): SocialStateMutationSummary {
  return {
    memorySeq: entry.seq,
    kind: entry.kind,
    source: entry.source,
    visibility: entry.visibility,
    salience: entry.salience,
    importance: entry.importance,
    tagCount: entry.tags.length,
    evidenceRefCount: entry.evidenceRefs.length,
    hasContent: entry.content !== undefined,
    contentLength: typeof entry.content === "string" ? entry.content.length : 0,
    hasObservation: entry.observation !== undefined,
    pendingActionKind: kindOfObject(entry.pendingAction),
    actionKind: entry.action?.kind,
    commandType: kindOfObject(entry.action?.command),
    metadataKeys: metadataKeys(entry.metadata),
    reflectionId: entry.reflection?.id,
    reflectionKind: entry.reflection?.kind,
    reflectionSource: entry.reflection?.source,
    reflectionConfidence: entry.reflection?.confidence
  };
}

export function summarizeBeliefClaim(claim: BeliefClaim): SocialStateMutationSummary {
  return {
    id: claim.id,
    subject: claim.subject,
    predicate: claim.predicate,
    value: summarizeValue(claim.value),
    confidence: claim.confidence,
    evidenceRefCount: claim.evidenceRefs.length,
    contradictionCount: claim.contradictions.length,
    metadataKeys: metadataKeys(claim.metadata)
  };
}

export function summarizeRelationshipEdge(edge: RelationshipEdge): SocialStateMutationSummary {
  return {
    targetId: edge.targetId,
    trust: edge.trust,
    suspicion: edge.suspicion,
    affinity: edge.affinity,
    influence: edge.influence,
    debt: edge.debt,
    respect: edge.respect,
    threat: edge.threat,
    evidenceRefCount: edge.evidenceRefs.length,
    metadataKeys: metadataKeys(edge.metadata)
  };
}

export function summarizeReputationRecord(record: ReputationRecord): SocialStateMutationSummary {
  return {
    subjectId: record.subjectId,
    honesty: record.honesty,
    competence: record.competence,
    cooperation: record.cooperation,
    threat: record.threat,
    normCompliance: record.normCompliance,
    evidenceRefCount: record.evidenceRefs.length,
    metadataKeys: metadataKeys(record.metadata)
  };
}

export function summarizeNormRecord(record: NormRecord): SocialStateMutationSummary {
  return {
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    confidence: record.confidence,
    status: record.status,
    hasCondition: record.condition !== undefined,
    expectedBehaviorLength: record.expectedBehavior.length,
    hasSanction: record.sanction !== undefined,
    source: record.source,
    evidenceRefCount: record.evidenceRefs.length,
    metadataKeys: metadataKeys(record.metadata)
  };
}

export function summarizeGoalRecord(record: GoalRecord): SocialStateMutationSummary {
  return {
    id: record.id,
    kind: record.kind,
    priority: record.priority,
    status: record.status,
    descriptionLength: record.description.length,
    evidenceRefCount: record.evidenceRefs.length,
    metadataKeys: metadataKeys(record.metadata)
  };
}

export function summarizeCommitmentRecord(record: CommitmentRecord): SocialStateMutationSummary {
  return {
    id: record.id,
    actorId: record.actorId,
    audienceCount: record.audienceIds.length,
    visibility: record.visibility,
    hasPromisedAction: record.promisedAction !== undefined,
    promisedActionLength: typeof record.promisedAction === "string" ? record.promisedAction.length : undefined,
    hasStance: record.stance !== undefined,
    stanceLength: typeof record.stance === "string" ? record.stance.length : undefined,
    targetId: record.targetId,
    deadlinePhase: record.deadlinePhase,
    deadlineDay: record.deadlineDay,
    status: record.status,
    confidence: record.confidence,
    evidenceRefCount: record.evidenceRefs.length,
    metadataKeys: metadataKeys(record.metadata)
  };
}

export function summarizeCoalitionRecord(record: CoalitionRecord): SocialStateMutationSummary {
  return {
    id: record.id,
    memberCount: record.memberIds.length,
    visibility: record.visibility,
    hasSharedGoal: record.sharedGoal !== undefined,
    sharedGoalLength: typeof record.sharedGoal === "string" ? record.sharedGoal.length : undefined,
    targetId: record.targetId,
    status: record.status,
    confidence: record.confidence,
    formationEvidenceRefCount: record.formationEvidenceRefs.length,
    coordinationEvidenceRefCount: record.coordinationEvidenceRefs.length,
    betrayalEvidenceRefCount: record.betrayalEvidenceRefs.length,
    dissolutionEvidenceRefCount: record.dissolutionEvidenceRefs.length,
    evidenceRefCount: record.evidenceRefs.length,
    metadataKeys: metadataKeys(record.metadata)
  };
}

export function summarizeGossipRecord(record: GossipRecord): SocialStateMutationSummary {
  return {
    id: record.id,
    speakerId: record.speakerId,
    subjectId: record.subjectId,
    audienceCount: record.audienceIds.length,
    visibility: record.visibility,
    hasTopic: record.topic !== undefined,
    topicLength: typeof record.topic === "string" ? record.topic.length : undefined,
    hasClaim: record.claim !== undefined,
    claimLength: typeof record.claim === "string" ? record.claim.length : undefined,
    sourceId: record.sourceId,
    valence: record.valence,
    confidence: record.confidence,
    evidenceRefCount: record.evidenceRefs.length,
    metadataKeys: metadataKeys(record.metadata)
  };
}

export function summarizeTheoryOfMindAttribution(record: TheoryOfMindAttribution): SocialStateMutationSummary {
  return {
    id: record.id,
    observerId: record.observerId,
    subjectId: record.subjectId,
    kind: record.kind,
    predicate: record.proposition.predicate,
    propositionSubjectId: record.proposition.subjectId,
    propositionTargetId: record.proposition.targetId,
    hasValue: record.proposition.value !== undefined,
    valueKind: kindOfObject(record.proposition.value) ?? typeof record.proposition.value,
    source: record.source,
    sourceMessageId: record.sourceMessageId,
    sourceMessageSeq: record.sourceMessageSeq,
    sourceSpeechActId: record.sourceSpeechActId,
    sourceSpeechActKind: record.sourceSpeechActKind,
    hasSourceDeliveryReceipt: record.sourceDeliveryReceiptId !== undefined,
    visibility: record.visibility,
    confidence: record.confidence,
    evidenceRefCount: record.evidenceRefs.length
  };
}

export function summarizeNormSanctionRecord(record: NormSanctionRecord): SocialStateMutationSummary {
  return {
    id: record.id,
    normId: record.normId,
    actorId: record.actorId,
    targetId: record.targetId,
    audienceCount: record.audienceIds.length,
    visibility: record.visibility,
    kind: record.kind,
    status: record.status,
    hasReason: record.reason !== undefined,
    reasonLength: typeof record.reason === "string" ? record.reason.length : undefined,
    hasRequestedRepair: record.requestedRepair !== undefined,
    requestedRepairLength: typeof record.requestedRepair === "string" ? record.requestedRepair.length : undefined,
    confidence: record.confidence,
    evidenceRefCount: record.evidenceRefs.length,
    metadataKeys: metadataKeys(record.metadata)
  };
}

export function summarizeTrustRepairRecord(record: TrustRepairRecord): SocialStateMutationSummary {
  return {
    id: record.id,
    actorId: record.actorId,
    targetId: record.targetId,
    audienceCount: record.audienceIds.length,
    visibility: record.visibility,
    kind: record.kind,
    status: record.status,
    triggerKind: record.triggerKind,
    triggerId: record.triggerId,
    requestedById: record.requestedById,
    relatedCommitmentId: record.relatedCommitmentId,
    relatedCoalitionId: record.relatedCoalitionId,
    relatedNormSanctionId: record.relatedNormSanctionId,
    relatedGossipId: record.relatedGossipId,
    hasReason: record.reason !== undefined,
    reasonLength: typeof record.reason === "string" ? record.reason.length : undefined,
    hasRequestedRepair: record.requestedRepair !== undefined,
    requestedRepairLength: typeof record.requestedRepair === "string" ? record.requestedRepair.length : undefined,
    hasOfferedRepair: record.offeredRepair !== undefined,
    offeredRepairLength: typeof record.offeredRepair === "string" ? record.offeredRepair.length : undefined,
    confidence: record.confidence,
    evidenceRefCount: record.evidenceRefs.length,
    metadataKeys: metadataKeys(record.metadata)
  };
}

export function summarizeBetrayalRecord(record: BetrayalRecord): SocialStateMutationSummary {
  return {
    id: record.id,
    actorId: record.actorId,
    targetId: record.targetId,
    audienceCount: record.audienceIds.length,
    visibility: record.visibility,
    kind: record.kind,
    status: record.status,
    triggerKind: record.triggerKind,
    triggerId: record.triggerId,
    relatedCommitmentId: record.relatedCommitmentId,
    relatedCoalitionId: record.relatedCoalitionId,
    relatedGossipId: record.relatedGossipId,
    relatedNormSanctionId: record.relatedNormSanctionId,
    relatedTrustRepairId: record.relatedTrustRepairId,
    hasClaim: record.claim !== undefined,
    claimLength: typeof record.claim === "string" ? record.claim.length : undefined,
    hasImpact: record.impact !== undefined,
    impactLength: typeof record.impact === "string" ? record.impact.length : undefined,
    confidence: record.confidence,
    allegationEvidenceRefCount: record.allegationEvidenceRefs.length,
    corroborationEvidenceRefCount: record.corroborationEvidenceRefs.length,
    contestEvidenceRefCount: record.contestEvidenceRefs.length,
    repairEvidenceRefCount: record.repairEvidenceRefs.length,
    outcomeEvidenceRefCount: record.outcomeEvidenceRefs.length,
    evidenceRefCount: record.evidenceRefs.length,
    metadataKeys: metadataKeys(record.metadata)
  };
}

export function summarizePlan(plan: unknown): SocialStateMutationSummary {
  if (!plan || typeof plan !== "object") {
    return {
      value: summarizeValue(plan)
    };
  }
  const record = plan as Record<string, unknown>;
  const command = record.command && typeof record.command === "object" ? (record.command as Record<string, unknown>) : undefined;
  const strategyTags = Array.isArray(record.strategyTags) ? record.strategyTags : [];
  return {
    objectKeys: metadataKeys(record),
    commandType: typeof command?.type === "string" ? command.type : undefined,
    policyName: typeof record.policyName === "string" ? record.policyName : undefined,
    confidence: typeof record.confidence === "number" ? round3(record.confidence) : undefined,
    targetId: typeof record.targetId === "string" ? record.targetId : undefined,
    claimedRole: typeof record.claimedRole === "string" ? record.claimedRole : undefined,
    pressureTargetId: typeof record.pressureTargetId === "string" ? record.pressureTargetId : undefined,
    intentLength: typeof record.intent === "string" ? record.intent.length : undefined,
    strategyTagCount: strategyTags.length
  };
}

export function summarizeNumericDeltas(input: Record<string, unknown>): SocialStateMutationSummary {
  const deltas: SocialStateMutationSummary = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "number" && value !== 0) {
      deltas[key] = round3(value);
    }
  }
  return deltas;
}

function summarizeValue(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length <= 64 ? value : { type: "string", length: value.length };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (value && typeof value === "object") {
    return { type: "object", keys: metadataKeys(value as Record<string, unknown>) };
  }
  return value;
}

export function mergeMutationContext(
  context: SocialStateMutationContext | undefined,
  evidenceRefs: EvidenceRef[],
  metadata?: Record<string, unknown>
): SocialStateMutationContext {
  return {
    traceId: context?.traceId ?? stringValue(metadata?.traceId) ?? evidenceRefs.find((ref) => typeof ref.traceId === "string")?.traceId,
    turnIndex: context?.turnIndex ?? numberValue(metadata?.turnIndex),
    phase: context?.phase ?? stringValue(metadata?.phase),
    day: context?.day ?? numberValue(metadata?.day),
    messageSeqRange: context?.messageSeqRange ?? evidenceSeqRange(evidenceRefs, "message"),
    eventSeqRange: context?.eventSeqRange ?? evidenceSeqRange(evidenceRefs, "event")
  };
}

function evidenceSeqRange(evidenceRefs: EvidenceRef[], artifact: EvidenceArtifactKind): SocialStateMutationRange | undefined {
  const seqs = evidenceRefs
    .filter((ref) => ref.artifact === artifact && typeof ref.seq === "number")
    .map((ref) => ref.seq as number);
  if (!seqs.length) return undefined;
  return {
    start: Math.min(...seqs),
    end: Math.max(...seqs)
  };
}

export function metadataKeys(metadata: Record<string, unknown> | undefined): string[] {
  return metadata ? Object.keys(metadata).sort().slice(0, 20) : [];
}

const JOURNAL_METADATA_KEYS = [
  "factSource",
  "factKind",
  "factIndex",
  "factSemantic",
  "observerId",
  "speakerId",
  "targetId",
  "subjectId",
  "messageId",
  "messageSeq",
  "speechActId",
  "speechActKind",
  "speechActIndex",
  "triggerKind",
  "triggerId",
  "commitmentId",
  "coalitionId",
  "commitmentIds",
  "coalitionIds",
  "claimSource",
  "claimKind",
  "theoryOfMindKind",
  "channelId",
  "visibility"
];

function journalMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const whitelistedKeys = metadata ? JOURNAL_METADATA_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(metadata, key)) : [];
  const output: Record<string, unknown> = {
    metadataKeys: whitelistedKeys
  };
  if (!metadata) return output;
  for (const key of JOURNAL_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      output[key] = [...value];
    }
  }
  return output;
}

function kindOfObject(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown; type?: unknown }).kind ?? (value as { type?: unknown }).type;
  return typeof kind === "string" ? kind : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
