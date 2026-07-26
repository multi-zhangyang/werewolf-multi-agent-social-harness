import { sampleIds } from "./episodeData";
import { type SocialExposureRecord } from "../social";
import { agentStateEvidence, evidenceFromSocialRefs, uniqueEvidenceRefs } from "./evidence";
import { type HarnessMetricEvidenceRef } from "../types";
import { type SocialAgentSnapshot } from "./manifests";
import { type BetrayalRecord, type CoalitionRecord, type CommitmentRecord, type EvidenceRef, type GossipRecord, type NormRecord, type NormSanctionRecord, type SocialStateMutationJournalEntry, type TrustRepairRecord } from "../socialState";
interface CommitmentCoalitionPair {
  commitment: CommitmentRecord;
  coalition: CoalitionRecord;
  evaluable: boolean;
  associationKinds: string[];
  evidenceRefs: EvidenceRef[];
}

export function commitmentCoalitionPairs(commitments: CommitmentRecord[], coalitions: CoalitionRecord[]): CommitmentCoalitionPair[] {
  const pairs: CommitmentCoalitionPair[] = [];
  for (const commitment of commitments) {
    for (const coalition of coalitions) {
      const associationKinds = commitmentCoalitionAssociationKinds(commitment, coalition);
      pairs.push({
        commitment,
        coalition,
        evaluable: commitment.evidenceRefs.length > 0 && coalition.evidenceRefs.length > 0,
        associationKinds,
        evidenceRefs: uniqueSocialEvidenceRefs([...commitment.evidenceRefs, ...coalition.evidenceRefs])
      });
    }
  }
  return pairs;
}

function commitmentCoalitionAssociationKinds(commitment: CommitmentRecord, coalition: CoalitionRecord): string[] {
  const kinds: string[] = [];
  if (hasSharedEvidence(commitment.evidenceRefs, coalition.evidenceRefs)) kinds.push("shared-evidence");
  if (hasExplicitCommitmentCoalitionMetadataLink(commitment, coalition)) kinds.push("metadata-link");
  return kinds;
}

function hasSharedEvidence(left: EvidenceRef[], right: EvidenceRef[]): boolean {
  const leftKeys = new Set(left.flatMap((ref) => evidenceKeys(ref)));
  return right.some((ref) => evidenceKeys(ref).some((key) => leftKeys.has(key)));
}

function hasExplicitCommitmentCoalitionMetadataLink(commitment: CommitmentRecord, coalition: CoalitionRecord): boolean {
  return (
    metadataReferencesId(commitment.metadata, "coalitionId", coalition.id) ||
    metadataReferencesId(commitment.metadata, "coalitionIds", coalition.id) ||
    metadataReferencesId(coalition.metadata, "commitmentId", commitment.id) ||
    metadataReferencesId(coalition.metadata, "commitmentIds", commitment.id)
  );
}

function metadataReferencesId(metadata: Record<string, unknown> | undefined, key: string, id: string): boolean {
  const value = metadata?.[key];
  if (typeof value === "string") return value === id;
  if (Array.isArray(value)) return value.some((item) => item === id);
  return false;
}

function evidenceKeys(ref: EvidenceRef): string[] {
  const keys: string[] = [];
  if (ref.id) keys.push(`${ref.artifact}:id:${ref.id}`);
  if (ref.traceId) keys.push(`${ref.artifact}:trace:${ref.traceId}`);
  if (ref.seq !== undefined) keys.push(`${ref.artifact}:seq:${ref.seq}`);
  return keys;
}

export function evidenceFromCommitmentCoalitionPairs(agent: SocialAgentSnapshot, pairs: CommitmentCoalitionPair[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, pairs.flatMap((pair) => pair.evidenceRefs));
}

function uniqueSocialEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const unique: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

export function sampleAssociationPairs(pairs: CommitmentCoalitionPair[]): Array<{
  commitmentId: string;
  coalitionId: string;
  associationKinds: string[];
}> {
  return pairs.slice(0, 20).map((pair) => ({
    commitmentId: pair.commitment.id,
    coalitionId: pair.coalition.id,
    associationKinds: pair.associationKinds
  }));
}

interface LifecycleRecordEvaluation {
  recordId: string;
  evaluable: boolean;
  associated: boolean;
  missingCreation: boolean;
  outsideRetainedJournalWindow: boolean;
  ambiguousOrdering: boolean;
  noLaterLifecycle: boolean;
  creationEntry?: SocialStateMutationJournalEntry;
  lifecycleEntries: SocialStateMutationJournalEntry[];
  associatedLifecycleEntries: SocialStateMutationJournalEntry[];
  lifecycleKinds: string[];
}

export interface GossipExposureRecordEvaluation {
  recordId: string;
  evaluable: boolean;
  associated: boolean;
  missingCreation: boolean;
  outsideRetainedJournalWindow: boolean;
  missingMessageEvidence: boolean;
  missingScopedExposure: boolean;
  ambiguousOrdering: boolean;
  sameTurnIngestion: boolean;
  noLaterCreation: boolean;
  creationEntry?: SocialStateMutationJournalEntry;
  messageEvidenceRefs: EvidenceRef[];
  matchingExposureRecords: SocialExposureRecord[];
  associatedExposureRecords: SocialExposureRecord[];
}

interface TrustRepairJournalMutationRecordEvaluation {
  recordId: string;
  evaluable: boolean;
  associated: boolean;
  missingCreation: boolean;
  outsideRetainedJournalWindow: boolean;
  ambiguousOrdering: boolean;
  sameTurnMutation: boolean;
  noLaterMutation: boolean;
  creationEntry?: SocialStateMutationJournalEntry;
  mutationEntries: SocialStateMutationJournalEntry[];
  associatedMutationEntries: SocialStateMutationJournalEntry[];
  mutationDimensions: string[];
}

export function orderedJournalEntries(entries: SocialStateMutationJournalEntry[]): SocialStateMutationJournalEntry[] {
  return [...entries].sort((left, right) => left.journalSeq - right.journalSeq);
}

export function evaluateCommitmentLifecycleRecord(
  record: CommitmentRecord,
  entries: SocialStateMutationJournalEntry[]
): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "commitments" &&
      entry.mutationKind === "commitment.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "commitments" &&
      entry.mutationKind === "commitment.status.updated" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    windowComplete: journalEntriesCoverFullHistory(entries),
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.nextStatus))
  });
}

export function evaluateCoalitionLifecycleRecord(record: CoalitionRecord, entries: SocialStateMutationJournalEntry[]): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "coalitions" &&
      entry.mutationKind === "coalition.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "coalitions" &&
      entry.mutationKind === "coalition.evidence.recorded" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false &&
      isCoalitionLifecycleEvidenceKind(entry.deltaSummary?.evidenceKind)
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    windowComplete: journalEntriesCoverFullHistory(entries),
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.evidenceKind))
  });
}

export function evaluateNormLifecycleRecord(record: NormRecord, entries: SocialStateMutationJournalEntry[]): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "norms" &&
      entry.mutationKind === "norm.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "norms" &&
      entry.mutationKind === "norm.status.updated" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    windowComplete: journalEntriesCoverFullHistory(entries),
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.nextStatus))
  });
}

export function evaluateNormSanctionLifecycleRecord(record: NormSanctionRecord, entries: SocialStateMutationJournalEntry[]): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "normSanctions" &&
      entry.mutationKind === "norm_sanction.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "normSanctions" &&
      entry.mutationKind === "norm_sanction.status.updated" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    windowComplete: journalEntriesCoverFullHistory(entries),
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.nextStatus))
  });
}

export function evaluateTrustRepairLifecycleRecord(record: TrustRepairRecord, entries: SocialStateMutationJournalEntry[]): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "trustRepairs" &&
      entry.mutationKind === "trust_repair.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "trustRepairs" &&
      entry.mutationKind === "trust_repair.status.updated" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    windowComplete: journalEntriesCoverFullHistory(entries),
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.nextStatus))
  });
}

export function evaluateBetrayalLifecycleRecord(record: BetrayalRecord, entries: SocialStateMutationJournalEntry[]): LifecycleRecordEvaluation {
  const creationEntry = entries.find(
    (entry) =>
      entry.store === "betrayals" &&
      entry.mutationKind === "betrayal.added" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  const lifecycleEntries = entries.filter(
    (entry) =>
      entry.store === "betrayals" &&
      entry.mutationKind === "betrayal.evidence.recorded" &&
      entry.subjectId === record.id &&
      entry.hiddenTruthUsed === false
  );
  return evaluateLifecycleRecord({
    recordId: record.id,
    windowComplete: journalEntriesCoverFullHistory(entries),
    creationEntry,
    lifecycleEntries,
    lifecycleKinds: lifecycleEntries.flatMap((entry) => stringValue(entry.deltaSummary?.evidenceKind))
  });
}

export const RELATIONSHIP_TEMPORAL_ASSOCIATION_DIMENSIONS = ["trust", "suspicion", "affinity", "influence", "debt", "respect", "threat"];
export const REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS = ["honesty", "competence", "cooperation", "threat", "normCompliance"];

export function evaluateTrustRepairRelationshipRecord(
  record: TrustRepairRecord,
  entries: SocialStateMutationJournalEntry[]
): TrustRepairJournalMutationRecordEvaluation {
  return evaluateTrustRepairJournalMutationRecord({
    record,
    entries,
    store: "relationships",
    mutationKind: "relationship.updated",
    dimensions: RELATIONSHIP_TEMPORAL_ASSOCIATION_DIMENSIONS
  });
}

export function evaluateTrustRepairReputationRecord(
  record: TrustRepairRecord,
  entries: SocialStateMutationJournalEntry[]
): TrustRepairJournalMutationRecordEvaluation {
  return evaluateTrustRepairJournalMutationRecord({
    record,
    entries,
    store: "reputation",
    mutationKind: "reputation.updated",
    dimensions: REPUTATION_TEMPORAL_ASSOCIATION_DIMENSIONS
  });
}

function evaluateTrustRepairJournalMutationRecord(input: {
  record: TrustRepairRecord;
  entries: SocialStateMutationJournalEntry[];
  store: "relationships" | "reputation";
  mutationKind: "relationship.updated" | "reputation.updated";
  dimensions: string[];
}): TrustRepairJournalMutationRecordEvaluation {
  const creationEntry = input.entries.find(
    (entry) =>
      entry.store === "trustRepairs" &&
      entry.mutationKind === "trust_repair.added" &&
      entry.subjectId === input.record.id &&
      entry.hiddenTruthUsed === false
  );
  const mutationEntries = input.entries.filter(
    (entry) =>
      entry.store === input.store &&
      entry.mutationKind === input.mutationKind &&
      entry.subjectId === input.record.actorId &&
      entry.hiddenTruthUsed === false &&
      journalEntryHasDimensionDelta(entry, input.dimensions)
  );
  const mutationDimensions = mutationEntries.flatMap((entry) => journalEntryDimensions(entry, input.dimensions));

  if (!creationEntry) {
    return trustRepairJournalMutationRecordResult(input.record.id, {
      missingCreation: journalEntriesCoverFullHistory(input.entries),
      outsideRetainedJournalWindow: !journalEntriesCoverFullHistory(input.entries),
      mutationEntries,
      mutationDimensions
    });
  }

  const relevantEntries = [creationEntry, ...mutationEntries];
  if (relevantEntries.some((entry) => typeof entry.turnIndex !== "number")) {
    return trustRepairJournalMutationRecordResult(input.record.id, {
      creationEntry,
      mutationEntries,
      mutationDimensions,
      ambiguousOrdering: true
    });
  }

  const creationTurnIndex = creationEntry.turnIndex as number;
  const associatedMutationEntries = mutationEntries.filter((entry) => (entry.turnIndex as number) > creationTurnIndex);
  const sameTurnMutation = associatedMutationEntries.length === 0 && mutationEntries.some((entry) => entry.turnIndex === creationTurnIndex);
  return trustRepairJournalMutationRecordResult(input.record.id, {
    evaluable: true,
    associated: associatedMutationEntries.length > 0,
    creationEntry,
    mutationEntries,
    associatedMutationEntries,
    mutationDimensions,
    sameTurnMutation,
    noLaterMutation: associatedMutationEntries.length === 0 && !sameTurnMutation
  });
}

export function evaluateGossipExposureRecord(
  record: GossipRecord,
  entries: SocialStateMutationJournalEntry[],
  exposureRecords: SocialExposureRecord[],
  totalExposureRecords: number
): GossipExposureRecordEvaluation {
  const creationEntry = entries.find(
    (entry) => entry.store === "gossip" && entry.mutationKind === "gossip.added" && entry.subjectId === record.id && entry.hiddenTruthUsed === false
  );
  const messageEvidenceRefs = messageEvidenceFromGossip(record, creationEntry);
  const matchingExposureRecords = orderedExposureRecords(exposureRecords.filter((exposure) => messageEvidenceRefs.some((ref) => exposureMatchesMessageRef(exposure, ref))));

  if (!creationEntry) {
    return gossipExposureRecordResult(record.id, {
      missingCreation: journalEntriesCoverFullHistory(entries),
      outsideRetainedJournalWindow: !journalEntriesCoverFullHistory(entries),
      messageEvidenceRefs,
      matchingExposureRecords
    });
  }
  if (!messageEvidenceRefs.length) {
    return gossipExposureRecordResult(record.id, {
      creationEntry,
      missingMessageEvidence: true
    });
  }
  if (!matchingExposureRecords.length) {
    return gossipExposureRecordResult(record.id, {
      creationEntry,
      messageEvidenceRefs,
      missingScopedExposure: true,
      missingScopedExposureSource: totalExposureRecords === 0
    });
  }
  if (typeof creationEntry.turnIndex !== "number") {
    return gossipExposureRecordResult(record.id, {
      creationEntry,
      messageEvidenceRefs,
      matchingExposureRecords,
      ambiguousOrdering: true
    });
  }

  const creationTurnIndex = creationEntry.turnIndex;
  const associatedExposureRecords = matchingExposureRecords.filter((exposure) => exposure.observedAtTurnIndex < creationTurnIndex);
  const associated = associatedExposureRecords.length > 0;
  const sameTurnIngestion = !associated && matchingExposureRecords.some((exposure) => exposure.observedAtTurnIndex === creationTurnIndex);
  return gossipExposureRecordResult(record.id, {
    evaluable: true,
    associated,
    creationEntry,
    messageEvidenceRefs,
    matchingExposureRecords,
    associatedExposureRecords,
    sameTurnIngestion,
    noLaterCreation: !associated
  });
}

function evaluateLifecycleRecord(input: {
  recordId: string;
  windowComplete: boolean;
  creationEntry?: SocialStateMutationJournalEntry;
  lifecycleEntries: SocialStateMutationJournalEntry[];
  lifecycleKinds: string[];
}): LifecycleRecordEvaluation {
  if (!input.creationEntry) {
    return {
      recordId: input.recordId,
      evaluable: false,
      associated: false,
      missingCreation: input.windowComplete,
      outsideRetainedJournalWindow: !input.windowComplete,
      ambiguousOrdering: false,
      noLaterLifecycle: false,
      lifecycleEntries: input.lifecycleEntries,
      associatedLifecycleEntries: [],
      lifecycleKinds: input.lifecycleKinds
    };
  }
  const relevantEntries = [input.creationEntry, ...input.lifecycleEntries];
  const ambiguousOrdering = relevantEntries.some((entry) => typeof entry.turnIndex !== "number");
  if (ambiguousOrdering) {
    return {
      recordId: input.recordId,
      evaluable: false,
      associated: false,
      missingCreation: false,
      outsideRetainedJournalWindow: false,
      ambiguousOrdering: true,
      noLaterLifecycle: false,
      creationEntry: input.creationEntry,
      lifecycleEntries: input.lifecycleEntries,
      associatedLifecycleEntries: [],
      lifecycleKinds: input.lifecycleKinds
    };
  }
  const creationTurnIndex = input.creationEntry.turnIndex as number;
  const associatedLifecycleEntries = input.lifecycleEntries.filter((entry) => (entry.turnIndex as number) > creationTurnIndex);
  return {
    recordId: input.recordId,
    evaluable: true,
    associated: associatedLifecycleEntries.length > 0,
    missingCreation: false,
    outsideRetainedJournalWindow: false,
    ambiguousOrdering: false,
    noLaterLifecycle: associatedLifecycleEntries.length === 0,
    creationEntry: input.creationEntry,
    lifecycleEntries: input.lifecycleEntries,
    associatedLifecycleEntries,
    lifecycleKinds: input.lifecycleKinds
  };
}

function isCoalitionLifecycleEvidenceKind(value: unknown): boolean {
  return value === "coordination" || value === "betrayal" || value === "dissolution";
}

function stringValue(value: unknown): string[] {
  return typeof value === "string" ? [value] : [];
}

function gossipExposureRecordResult(
  recordId: string,
  options: Partial<Omit<GossipExposureRecordEvaluation, "recordId">> & { missingScopedExposureSource?: boolean }
): GossipExposureRecordEvaluation {
  void options.missingScopedExposureSource;
  return {
    recordId,
    evaluable: options.evaluable ?? false,
    associated: options.associated ?? false,
    missingCreation: options.missingCreation ?? false,
    outsideRetainedJournalWindow: options.outsideRetainedJournalWindow ?? false,
    missingMessageEvidence: options.missingMessageEvidence ?? false,
    missingScopedExposure: options.missingScopedExposure ?? false,
    ambiguousOrdering: options.ambiguousOrdering ?? false,
    sameTurnIngestion: options.sameTurnIngestion ?? false,
    noLaterCreation: options.noLaterCreation ?? false,
    creationEntry: options.creationEntry,
    messageEvidenceRefs: options.messageEvidenceRefs ?? [],
    matchingExposureRecords: options.matchingExposureRecords ?? [],
    associatedExposureRecords: options.associatedExposureRecords ?? []
  };
}

function trustRepairJournalMutationRecordResult(
  recordId: string,
  options: Partial<Omit<TrustRepairJournalMutationRecordEvaluation, "recordId">>
): TrustRepairJournalMutationRecordEvaluation {
  return {
    recordId,
    evaluable: options.evaluable ?? false,
    associated: options.associated ?? false,
    missingCreation: options.missingCreation ?? false,
    outsideRetainedJournalWindow: options.outsideRetainedJournalWindow ?? false,
    ambiguousOrdering: options.ambiguousOrdering ?? false,
    sameTurnMutation: options.sameTurnMutation ?? false,
    noLaterMutation: options.noLaterMutation ?? false,
    creationEntry: options.creationEntry,
    mutationEntries: options.mutationEntries ?? [],
    associatedMutationEntries: options.associatedMutationEntries ?? [],
    mutationDimensions: sampleIds(options.mutationDimensions ?? [])
  };
}

/** Journal entries are a retained suffix. A first sequence greater than one
 * proves that earlier mutations were intentionally evicted and absence is
 * therefore unknown rather than negative evidence. */
function journalEntriesCoverFullHistory(entries: SocialStateMutationJournalEntry[]): boolean {
  return entries.length === 0 || Math.min(...entries.map((entry) => entry.journalSeq)) === 1;
}

function journalEntryHasDimensionDelta(entry: SocialStateMutationJournalEntry, dimensions: string[]): boolean {
  return journalEntryDimensions(entry, dimensions).length > 0;
}

function journalEntryDimensions(entry: SocialStateMutationJournalEntry, dimensions: string[]): string[] {
  return dimensions.filter((dimension) => typeof entry.deltaSummary?.[dimension] === "number" && entry.deltaSummary[dimension] !== 0);
}

function messageEvidenceFromGossip(record: GossipRecord, creationEntry?: SocialStateMutationJournalEntry): EvidenceRef[] {
  return uniqueSocialEvidenceRefs([...record.evidenceRefs, ...(creationEntry?.evidenceRefs ?? [])].filter(isMessageEvidenceRef));
}

function isMessageEvidenceRef(ref: EvidenceRef): boolean {
  return ref.artifact === "message" && (typeof ref.id === "string" || typeof ref.seq === "number");
}

function exposureMatchesMessageRef(exposure: SocialExposureRecord, ref: EvidenceRef): boolean {
  if (typeof ref.id === "string" && exposure.messageId === ref.id) return true;
  return typeof ref.seq === "number" && exposure.messageSeq === ref.seq;
}

function orderedExposureRecords(records: SocialExposureRecord[]): SocialExposureRecord[] {
  return [...records].sort((left, right) => {
    if (left.observedAtTurnIndex !== right.observedAtTurnIndex) return left.observedAtTurnIndex - right.observedAtTurnIndex;
    if (left.messageSeq !== right.messageSeq) return left.messageSeq - right.messageSeq;
    return left.observedAtTraceId.localeCompare(right.observedAtTraceId);
  });
}

export function evidenceFromLifecycleRecords(agent: SocialAgentSnapshot, records: LifecycleRecordEvaluation[]): HarnessMetricEvidenceRef[] {
  const socialEvidenceRefs = records.flatMap((record) => [
    ...(record.creationEntry?.evidenceRefs ?? []),
    ...record.lifecycleEntries.flatMap((entry) => entry.evidenceRefs)
  ]);
  const mapped = evidenceFromSocialRefs(agent, socialEvidenceRefs);
  return uniqueEvidenceRefs([...mapped, ...agentStateEvidence(agent)]);
}

export function evidenceFromJournalMutationRecords(agent: SocialAgentSnapshot, records: TrustRepairJournalMutationRecordEvaluation[]): HarnessMetricEvidenceRef[] {
  const socialEvidenceRefs = records.flatMap((record) => [
    ...(record.creationEntry?.evidenceRefs ?? []),
    ...record.mutationEntries.flatMap((entry) => entry.evidenceRefs)
  ]);
  const mapped = evidenceFromSocialRefs(agent, socialEvidenceRefs);
  return uniqueEvidenceRefs([...mapped, ...agentStateEvidence(agent)]);
}

export function sampleLifecycleRecords(records: LifecycleRecordEvaluation[]): Array<{
  recordId: string;
  creationTurnIndex: number | null;
  lifecycleTurnIndexes: number[];
  lifecycleKinds: string[];
}> {
  return records.slice(0, 20).map((record) => ({
    recordId: record.recordId,
    creationTurnIndex: typeof record.creationEntry?.turnIndex === "number" ? record.creationEntry.turnIndex : null,
    lifecycleTurnIndexes: record.associatedLifecycleEntries.flatMap((entry) => (typeof entry.turnIndex === "number" ? [entry.turnIndex] : [])),
    lifecycleKinds: sampleIds(record.lifecycleKinds)
  }));
}

export function sampleJournalMutationRecords(records: TrustRepairJournalMutationRecordEvaluation[]): Array<{
  recordId: string;
  creationTurnIndex: number | null;
  mutationTurnIndexes: number[];
  mutationKinds: string[];
  mutationDimensions: string[];
}> {
  return records.slice(0, 20).map((record) => ({
    recordId: record.recordId,
    creationTurnIndex: typeof record.creationEntry?.turnIndex === "number" ? record.creationEntry.turnIndex : null,
    mutationTurnIndexes: record.associatedMutationEntries.flatMap((entry) => (typeof entry.turnIndex === "number" ? [entry.turnIndex] : [])),
    mutationKinds: sampleIds(record.associatedMutationEntries.map((entry) => entry.mutationKind)),
    mutationDimensions: sampleIds(record.associatedMutationEntries.flatMap((entry) => journalEntryDimensions(entry, record.mutationDimensions)))
  }));
}

export function mutationDimensions(records: TrustRepairJournalMutationRecordEvaluation[]): string[] {
  return sampleIds([...new Set(records.flatMap((record) => record.mutationDimensions))].sort());
}

export function sampleGossipExposureRecords(records: GossipExposureRecordEvaluation[]): Array<{
  recordId: string;
  creationTurnIndex: number | null;
  exposureTurnIndexes: number[];
  messageIds: string[];
  messageSeqs: number[];
}> {
  return records.slice(0, 20).map((record) => ({
    recordId: record.recordId,
    creationTurnIndex: typeof record.creationEntry?.turnIndex === "number" ? record.creationEntry.turnIndex : null,
    exposureTurnIndexes: record.associatedExposureRecords.map((exposure) => exposure.observedAtTurnIndex),
    messageIds: sampleIds(record.associatedExposureRecords.map((exposure) => exposure.messageId)),
    messageSeqs: record.associatedExposureRecords.map((exposure) => exposure.messageSeq).slice(0, 20)
  }));
}

