import { mergeMutationContext, recordSocialStateMutation, summarizeBetrayalRecord, summarizeNormSanctionRecord, summarizeTrustRepairRecord } from "./journal";
import { ensureBetrayalLedger, ensureNormSanctionLedger, ensureTrustRepairLedger } from "./factories";
import { clamp01, cloneJson, deterministicTimestamp, mergeEvidenceRefs, requireEvidence } from "./recordUtils";
import { type AgentSocialState, type BetrayalEvidenceKind, type BetrayalLedger, type BetrayalRecord, type BetrayalStatus, type EvidenceRef, type NormSanctionLedger, type NormSanctionRecord, type NormSanctionStatus, type SocialStateMutationContext, type TrustRepairLedger, type TrustRepairRecord, type TrustRepairStatus } from "./contracts";
export function addNormSanction(ledger: NormSanctionLedger, input: Omit<NormSanctionRecord, "createdAt" | "updatedAt" | "status"> & {
  status?: NormSanctionStatus;
}): NormSanctionRecord {
  requireEvidence(input.evidenceRefs, "norm sanction update");
  const timestamp = deterministicTimestamp(Object.keys(ledger.records).length + 1);
  const record: NormSanctionRecord = {
    ...cloneJson(input),
    audienceIds: [...new Set(input.audienceIds)].sort(),
    status: input.status ?? "proposed",
    confidence: clamp01(input.confidence),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  ledger.records[record.id] = record;
  return cloneJson(record);
}

export function addSocialNormSanction(
  state: AgentSocialState,
  input: Parameters<typeof addNormSanction>[1],
  context?: SocialStateMutationContext
): NormSanctionRecord {
  const ledger = ensureNormSanctionLedger(state);
  const beforeCount = Object.keys(ledger.records).length;
  const record = addNormSanction(ledger, input);
  recordSocialStateMutation(state, {
    store: "normSanctions",
    mutationKind: "norm_sanction.added",
    subjectId: record.id,
    beforeSummary: {
      normSanctionCount: beforeCount
    },
    afterSummary: {
      normSanctionCount: Object.keys(ledger.records).length,
      ...summarizeNormSanctionRecord(record)
    },
    deltaSummary: {
      addedNormSanctionId: record.id,
      normId: record.normId,
      actorId: record.actorId,
      targetId: record.targetId,
      kind: record.kind,
      status: record.status,
      audienceCount: record.audienceIds.length
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

export function updateNormSanctionStatus(ledger: NormSanctionLedger, input: {
  id: string;
  status: NormSanctionStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): NormSanctionRecord {
  requireEvidence(input.evidenceRefs, "norm sanction status update");
  const previous = ledger.records[input.id];
  if (!previous) throw new Error(`Unknown norm sanction ${input.id}.`);
  const updated: NormSanctionRecord = {
    ...previous,
    status: input.status,
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  ledger.records[input.id] = updated;
  return cloneJson(updated);
}

export function updateSocialNormSanctionStatus(
  state: AgentSocialState,
  input: Parameters<typeof updateNormSanctionStatus>[1],
  context?: SocialStateMutationContext
): NormSanctionRecord {
  const ledger = ensureNormSanctionLedger(state);
  const previous = ledger.records[input.id];
  const updated = updateNormSanctionStatus(ledger, input);
  recordSocialStateMutation(state, {
    store: "normSanctions",
    mutationKind: "norm_sanction.status.updated",
    subjectId: input.id,
    beforeSummary: previous ? summarizeNormSanctionRecord(previous) : undefined,
    afterSummary: summarizeNormSanctionRecord(updated),
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

export function addTrustRepair(ledger: TrustRepairLedger, input: Omit<TrustRepairRecord, "createdAt" | "updatedAt" | "status"> & {
  status?: TrustRepairStatus;
}): TrustRepairRecord {
  requireEvidence(input.evidenceRefs, "trust repair update");
  const timestamp = deterministicTimestamp(Object.keys(ledger.records).length + 1);
  const record: TrustRepairRecord = {
    ...cloneJson(input),
    audienceIds: [...new Set(input.audienceIds)].sort(),
    status: input.status ?? "proposed",
    confidence: clamp01(input.confidence),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  ledger.records[record.id] = record;
  return cloneJson(record);
}

export function addSocialTrustRepair(
  state: AgentSocialState,
  input: Parameters<typeof addTrustRepair>[1],
  context?: SocialStateMutationContext
): TrustRepairRecord {
  const ledger = ensureTrustRepairLedger(state);
  const beforeCount = Object.keys(ledger.records).length;
  const record = addTrustRepair(ledger, input);
  recordSocialStateMutation(state, {
    store: "trustRepairs",
    mutationKind: "trust_repair.added",
    subjectId: record.id,
    beforeSummary: {
      trustRepairCount: beforeCount
    },
    afterSummary: {
      trustRepairCount: Object.keys(ledger.records).length,
      ...summarizeTrustRepairRecord(record)
    },
    deltaSummary: {
      addedTrustRepairId: record.id,
      actorId: record.actorId,
      targetId: record.targetId,
      kind: record.kind,
      status: record.status,
      audienceCount: record.audienceIds.length
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

export function updateTrustRepairStatus(ledger: TrustRepairLedger, input: {
  id: string;
  status: TrustRepairStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): TrustRepairRecord {
  requireEvidence(input.evidenceRefs, "trust repair status update");
  const previous = ledger.records[input.id];
  if (!previous) throw new Error(`Unknown trust repair ${input.id}.`);
  const updated: TrustRepairRecord = {
    ...previous,
    status: input.status,
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  ledger.records[input.id] = updated;
  return cloneJson(updated);
}

export function updateSocialTrustRepairStatus(
  state: AgentSocialState,
  input: Parameters<typeof updateTrustRepairStatus>[1],
  context?: SocialStateMutationContext
): TrustRepairRecord {
  const ledger = ensureTrustRepairLedger(state);
  const previous = ledger.records[input.id];
  const updated = updateTrustRepairStatus(ledger, input);
  recordSocialStateMutation(state, {
    store: "trustRepairs",
    mutationKind: "trust_repair.status.updated",
    subjectId: input.id,
    beforeSummary: previous ? summarizeTrustRepairRecord(previous) : undefined,
    afterSummary: summarizeTrustRepairRecord(updated),
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

export function addBetrayal(ledger: BetrayalLedger, input: Omit<
  BetrayalRecord,
  | "createdAt"
  | "updatedAt"
  | "status"
  | "allegationEvidenceRefs"
  | "corroborationEvidenceRefs"
  | "contestEvidenceRefs"
  | "repairEvidenceRefs"
  | "outcomeEvidenceRefs"
> & {
  status?: BetrayalStatus;
}): BetrayalRecord {
  requireEvidence(input.evidenceRefs, "betrayal update");
  const timestamp = deterministicTimestamp(Object.keys(ledger.records).length + 1);
  const evidenceRefs = cloneJson(input.evidenceRefs);
  const record: BetrayalRecord = {
    ...cloneJson(input),
    audienceIds: [...new Set(input.audienceIds)].sort(),
    status: input.status ?? "alleged",
    confidence: clamp01(input.confidence),
    allegationEvidenceRefs: evidenceRefs,
    corroborationEvidenceRefs: [],
    contestEvidenceRefs: [],
    repairEvidenceRefs: [],
    outcomeEvidenceRefs: [],
    evidenceRefs,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  ledger.records[record.id] = record;
  return cloneJson(record);
}

export function addSocialBetrayal(
  state: AgentSocialState,
  input: Parameters<typeof addBetrayal>[1],
  context?: SocialStateMutationContext
): BetrayalRecord {
  const ledger = ensureBetrayalLedger(state);
  const beforeCount = Object.keys(ledger.records).length;
  const record = addBetrayal(ledger, input);
  recordSocialStateMutation(state, {
    store: "betrayals",
    mutationKind: "betrayal.added",
    subjectId: record.id,
    beforeSummary: {
      betrayalCount: beforeCount
    },
    afterSummary: {
      betrayalCount: Object.keys(ledger.records).length,
      ...summarizeBetrayalRecord(record)
    },
    deltaSummary: {
      addedBetrayalId: record.id,
      actorId: record.actorId,
      targetId: record.targetId,
      kind: record.kind,
      status: record.status,
      audienceCount: record.audienceIds.length
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

export function recordBetrayalEvidence(ledger: BetrayalLedger, input: {
  id: string;
  kind: BetrayalEvidenceKind;
  evidenceRefs: EvidenceRef[];
  status?: BetrayalStatus;
  confidence?: number;
  metadata?: Record<string, unknown>;
}): BetrayalRecord {
  requireEvidence(input.evidenceRefs, "betrayal evidence update");
  const previous = ledger.records[input.id];
  if (!previous) throw new Error(`Unknown betrayal ${input.id}.`);
  const evidenceRefs = cloneJson(input.evidenceRefs);
  const updated: BetrayalRecord = {
    ...previous,
    status: input.status ?? previous.status,
    confidence: input.confidence === undefined ? previous.confidence : clamp01(input.confidence),
    allegationEvidenceRefs:
      input.kind === "allegation" ? mergeEvidenceRefs(previous.allegationEvidenceRefs, evidenceRefs) : previous.allegationEvidenceRefs,
    corroborationEvidenceRefs:
      input.kind === "corroboration" ? mergeEvidenceRefs(previous.corroborationEvidenceRefs, evidenceRefs) : previous.corroborationEvidenceRefs,
    contestEvidenceRefs:
      input.kind === "contest" ? mergeEvidenceRefs(previous.contestEvidenceRefs, evidenceRefs) : previous.contestEvidenceRefs,
    repairEvidenceRefs:
      input.kind === "repair" ? mergeEvidenceRefs(previous.repairEvidenceRefs, evidenceRefs) : previous.repairEvidenceRefs,
    outcomeEvidenceRefs:
      input.kind === "outcome" ? mergeEvidenceRefs(previous.outcomeEvidenceRefs, evidenceRefs) : previous.outcomeEvidenceRefs,
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  ledger.records[input.id] = updated;
  return cloneJson(updated);
}

export function recordSocialBetrayalEvidence(
  state: AgentSocialState,
  input: Parameters<typeof recordBetrayalEvidence>[1],
  context?: SocialStateMutationContext
): BetrayalRecord {
  const ledger = ensureBetrayalLedger(state);
  const previous = ledger.records[input.id];
  const updated = recordBetrayalEvidence(ledger, input);
  recordSocialStateMutation(state, {
    store: "betrayals",
    mutationKind: "betrayal.evidence.recorded",
    subjectId: input.id,
    beforeSummary: previous ? summarizeBetrayalRecord(previous) : undefined,
    afterSummary: summarizeBetrayalRecord(updated),
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
