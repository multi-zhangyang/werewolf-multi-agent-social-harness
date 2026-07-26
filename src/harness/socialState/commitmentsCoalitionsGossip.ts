import { mergeMutationContext, recordSocialStateMutation, summarizeCoalitionRecord, summarizeCommitmentRecord, summarizeGossipRecord, summarizeTheoryOfMindAttribution } from "./journal";
import { ensureCoalitionLedger, ensureCommitmentLedger, ensureGossipLedger, ensureTheoryOfMindStore } from "./factories";
import { clamp01, cloneJson, deterministicTimestamp, mergeEvidenceRefs, requireEvidence, requireStableTheoryOfMindAttribution } from "./recordUtils";
import { type AgentSocialState, type CoalitionEvidenceKind, type CoalitionLedger, type CoalitionRecord, type CoalitionStatus, type CommitmentLedger, type CommitmentRecord, type CommitmentStatus, type EvidenceRef, type GossipLedger, type GossipRecord, type GossipValence, type MemoryVisibility, type SocialStateMutationContext, type TheoryOfMindAttribution, type TheoryOfMindStore } from "./contracts";
export function addCommitment(ledger: CommitmentLedger, input: Omit<CommitmentRecord, "createdAt" | "updatedAt" | "status"> & {
  status?: CommitmentStatus;
}): CommitmentRecord {
  requireEvidence(input.evidenceRefs, "commitment update");
  const timestamp = deterministicTimestamp(Object.keys(ledger.records).length + 1);
  const record: CommitmentRecord = {
    ...cloneJson(input),
    audienceIds: [...new Set(input.audienceIds)].sort(),
    confidence: clamp01(input.confidence),
    status: input.status ?? "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  ledger.records[record.id] = record;
  return cloneJson(record);
}

export function addSocialCommitment(
  state: AgentSocialState,
  input: Omit<CommitmentRecord, "createdAt" | "updatedAt" | "status"> & { status?: CommitmentStatus },
  context?: SocialStateMutationContext
): CommitmentRecord {
  const ledger = ensureCommitmentLedger(state);
  const beforeCount = Object.keys(ledger.records).length;
  const record = addCommitment(ledger, input);
  recordSocialStateMutation(state, {
    store: "commitments",
    mutationKind: "commitment.added",
    subjectId: record.id,
    beforeSummary: {
      commitmentCount: beforeCount
    },
    afterSummary: {
      commitmentCount: Object.keys(ledger.records).length,
      ...summarizeCommitmentRecord(record)
    },
    deltaSummary: {
      addedCommitmentId: record.id,
      actorId: record.actorId,
      status: record.status,
      audienceCount: record.audienceIds.length
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

export function updateCommitmentStatus(ledger: CommitmentLedger, input: {
  id: string;
  status: CommitmentStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): CommitmentRecord {
  requireEvidence(input.evidenceRefs, "commitment status update");
  const previous = ledger.records[input.id];
  if (!previous) throw new Error(`Unknown commitment ${input.id}.`);
  const updated: CommitmentRecord = {
    ...previous,
    status: input.status,
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  ledger.records[input.id] = updated;
  return cloneJson(updated);
}

export function updateSocialCommitmentStatus(
  state: AgentSocialState,
  input: {
    id: string;
    status: CommitmentStatus;
    evidenceRefs: EvidenceRef[];
    metadata?: Record<string, unknown>;
  },
  context?: SocialStateMutationContext
): CommitmentRecord {
  const ledger = ensureCommitmentLedger(state);
  const previous = ledger.records[input.id];
  const updated = updateCommitmentStatus(ledger, input);
  recordSocialStateMutation(state, {
    store: "commitments",
    mutationKind: "commitment.status.updated",
    subjectId: input.id,
    beforeSummary: previous ? summarizeCommitmentRecord(previous) : undefined,
    afterSummary: summarizeCommitmentRecord(updated),
    deltaSummary: {
      previousStatus: previous?.status,
      nextStatus: updated.status
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return updated;
}

export function addCoalition(ledger: CoalitionLedger, input: {
  id: string;
  memberIds: string[];
  visibility: MemoryVisibility;
  sharedGoal?: string;
  targetId?: string;
  status?: CoalitionStatus;
  confidence: number;
  formationEvidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): CoalitionRecord {
  requireEvidence(input.formationEvidenceRefs, "coalition update");
  const timestamp = deterministicTimestamp(Object.keys(ledger.records).length + 1);
  const formationEvidenceRefs = cloneJson(input.formationEvidenceRefs);
  const record: CoalitionRecord = {
    id: input.id,
    memberIds: [...new Set(input.memberIds)].sort(),
    visibility: input.visibility,
    sharedGoal: input.sharedGoal,
    targetId: input.targetId,
    status: input.status ?? "forming",
    confidence: clamp01(input.confidence),
    formationEvidenceRefs,
    coordinationEvidenceRefs: [],
    betrayalEvidenceRefs: [],
    dissolutionEvidenceRefs: [],
    evidenceRefs: cloneJson(formationEvidenceRefs),
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: cloneJson(input.metadata)
  };
  ledger.records[record.id] = record;
  return cloneJson(record);
}

export function addSocialCoalition(
  state: AgentSocialState,
  input: Parameters<typeof addCoalition>[1],
  context?: SocialStateMutationContext
): CoalitionRecord {
  const ledger = ensureCoalitionLedger(state);
  const beforeCount = Object.keys(ledger.records).length;
  const record = addCoalition(ledger, input);
  recordSocialStateMutation(state, {
    store: "coalitions",
    mutationKind: "coalition.added",
    subjectId: record.id,
    beforeSummary: {
      coalitionCount: beforeCount
    },
    afterSummary: {
      coalitionCount: Object.keys(ledger.records).length,
      ...summarizeCoalitionRecord(record)
    },
    deltaSummary: {
      addedCoalitionId: record.id,
      status: record.status,
      memberCount: record.memberIds.length
    },
    evidenceRefs: input.formationEvidenceRefs,
    context: mergeMutationContext(context, input.formationEvidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

export function recordCoalitionEvidence(ledger: CoalitionLedger, input: {
  id: string;
  kind: CoalitionEvidenceKind;
  evidenceRefs: EvidenceRef[];
  status?: CoalitionStatus;
  confidence?: number;
  metadata?: Record<string, unknown>;
}): CoalitionRecord {
  requireEvidence(input.evidenceRefs, "coalition evidence update");
  const previous = ledger.records[input.id];
  if (!previous) throw new Error(`Unknown coalition ${input.id}.`);
  const evidenceRefs = cloneJson(input.evidenceRefs);
  const updated: CoalitionRecord = {
    ...previous,
    status: input.status ?? previous.status,
    confidence: input.confidence === undefined ? previous.confidence : clamp01(input.confidence),
    formationEvidenceRefs:
      input.kind === "formation" ? mergeEvidenceRefs(previous.formationEvidenceRefs, evidenceRefs) : previous.formationEvidenceRefs,
    coordinationEvidenceRefs:
      input.kind === "coordination" ? mergeEvidenceRefs(previous.coordinationEvidenceRefs, evidenceRefs) : previous.coordinationEvidenceRefs,
    betrayalEvidenceRefs:
      input.kind === "betrayal" ? mergeEvidenceRefs(previous.betrayalEvidenceRefs, evidenceRefs) : previous.betrayalEvidenceRefs,
    dissolutionEvidenceRefs:
      input.kind === "dissolution" ? mergeEvidenceRefs(previous.dissolutionEvidenceRefs, evidenceRefs) : previous.dissolutionEvidenceRefs,
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  ledger.records[input.id] = updated;
  return cloneJson(updated);
}

export function recordSocialCoalitionEvidence(
  state: AgentSocialState,
  input: Parameters<typeof recordCoalitionEvidence>[1],
  context?: SocialStateMutationContext
): CoalitionRecord {
  const ledger = ensureCoalitionLedger(state);
  const previous = ledger.records[input.id];
  const updated = recordCoalitionEvidence(ledger, input);
  recordSocialStateMutation(state, {
    store: "coalitions",
    mutationKind: "coalition.evidence.recorded",
    subjectId: input.id,
    beforeSummary: previous ? summarizeCoalitionRecord(previous) : undefined,
    afterSummary: summarizeCoalitionRecord(updated),
    deltaSummary: {
      evidenceKind: input.kind,
      previousStatus: previous?.status,
      nextStatus: updated.status,
      evidenceAdded: input.evidenceRefs.length
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return updated;
}

export function addGossip(ledger: GossipLedger, input: Omit<GossipRecord, "createdAt" | "valence"> & {
  valence?: GossipValence;
}): GossipRecord {
  requireEvidence(input.evidenceRefs, "gossip update");
  const record: GossipRecord = {
    ...cloneJson(input),
    audienceIds: [...new Set(input.audienceIds)].sort(),
    valence: input.valence ?? "unknown",
    confidence: clamp01(input.confidence),
    createdAt: deterministicTimestamp(Object.keys(ledger.records).length + 1)
  };
  ledger.records[record.id] = record;
  return cloneJson(record);
}

export function addSocialGossip(
  state: AgentSocialState,
  input: Parameters<typeof addGossip>[1],
  context?: SocialStateMutationContext
): GossipRecord {
  const ledger = ensureGossipLedger(state);
  const beforeCount = Object.keys(ledger.records).length;
  const record = addGossip(ledger, input);
  recordSocialStateMutation(state, {
    store: "gossip",
    mutationKind: "gossip.added",
    subjectId: record.id,
    beforeSummary: {
      gossipCount: beforeCount
    },
    afterSummary: {
      gossipCount: Object.keys(ledger.records).length,
      ...summarizeGossipRecord(record)
    },
    deltaSummary: {
      addedGossipId: record.id,
      speakerId: record.speakerId,
      subjectId: record.subjectId,
      audienceCount: record.audienceIds.length,
      valence: record.valence
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

/**
 * Add one immutable, evidence-backed attribution. This boundary rejects
 * postgame-only material and malformed source coordinates so callers cannot
 * turn arbitrary private state or a later outcome into a theory-of-mind fact.
 */
export function addTheoryOfMindAttribution(
  store: TheoryOfMindStore,
  input: Omit<TheoryOfMindAttribution, "createdAt" | "confidence">
    & { confidence?: number }
): TheoryOfMindAttribution {
  requireStableTheoryOfMindAttribution(input);
  const existing = store.records[input.id];
  if (existing) return cloneJson(existing);
  const record: TheoryOfMindAttribution = {
    ...cloneJson(input),
    confidence: input.confidence === undefined ? undefined : clamp01(input.confidence),
    createdAt: deterministicTimestamp(Object.keys(store.records).length + 1)
  };
  store.records[record.id] = record;
  return cloneJson(record);
}

/**
 * Root-state wrapper that records a redaction-safe mutation journal entry.
 * The journal stores source coordinates and proposition shape only; it never
 * duplicates an arbitrary speech-act value or message content.
 */
export function addSocialTheoryOfMindAttribution(
  state: AgentSocialState,
  input: Parameters<typeof addTheoryOfMindAttribution>[1],
  context?: SocialStateMutationContext
): TheoryOfMindAttribution {
  const store = ensureTheoryOfMindStore(state);
  const previous = store.records[input.id];
  const record = addTheoryOfMindAttribution(store, input);
  if (previous) return record;
  recordSocialStateMutation(state, {
    store: "theoryOfMind",
    mutationKind: "theory_of_mind.attribution.recorded",
    subjectId: record.subjectId,
    beforeSummary: {
      attributionCount: Object.keys(store.records).length - 1
    },
    afterSummary: {
      attributionCount: Object.keys(store.records).length,
      ...summarizeTheoryOfMindAttribution(record)
    },
    deltaSummary: {
      attributionId: record.id,
      source: record.source,
      sourceMessageId: record.sourceMessageId,
      sourceMessageSeq: record.sourceMessageSeq,
      sourceSpeechActId: record.sourceSpeechActId,
      sourceSpeechActKind: record.sourceSpeechActKind,
      kind: record.kind
    },
    evidenceRefs: record.evidenceRefs,
    context: mergeMutationContext(context, record.evidenceRefs, {
      observerId: record.observerId,
      speakerId: record.subjectId,
      targetId: record.proposition.targetId,
      messageId: record.sourceMessageId,
      messageSeq: record.sourceMessageSeq,
      speechActId: record.sourceSpeechActId,
      speechActKind: record.sourceSpeechActKind,
      theoryOfMindKind: record.kind,
      visibility: record.visibility
    }),
    metadata: {
      observerId: record.observerId,
      speakerId: record.subjectId,
      targetId: record.proposition.targetId,
      messageId: record.sourceMessageId,
      messageSeq: record.sourceMessageSeq,
      speechActId: record.sourceSpeechActId,
      speechActKind: record.sourceSpeechActKind,
      theoryOfMindKind: record.kind,
      visibility: record.visibility
    }
  });
  return record;
}
