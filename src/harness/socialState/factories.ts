import { requirePositiveCapacity } from "./snapshotValidation";
import { cloneJson } from "./recordUtils";
import { type AgentNormState, type AgentSocialState, type BeliefStore, type BetrayalLedger, type CoalitionLedger, type CommitmentLedger, type GoalStack, type GossipLedger, type MemoryStore, type NormSanctionLedger, type RelationshipGraph, type ReputationLedger, type SocialMessageIngestionState, type SocialStateMutationJournal, type SocialStateRetentionWindow, type TheoryOfMindStore, type TrustRepairLedger } from "./contracts";
import { type SocialAgentProfile } from "../social";
export function createAgentSocialState<TObservation, TPending, TCommand>(options: {
  agentId: string;
  profile: SocialAgentProfile;
  maxMemoryEntries?: number;
  maxJournalEntries?: number;
}): AgentSocialState<TObservation, TPending, TCommand> {
  return {
    agentId: options.agentId,
    profile: cloneJson(options.profile),
    messageIngestion: createSocialMessageIngestionState(),
    memory: createMemoryStore<TObservation, TPending, TCommand>(options.maxMemoryEntries),
    beliefs: createBeliefStore(),
    relationships: createRelationshipGraph(),
    norms: createNormState(),
    reputation: createReputationLedger(),
    goals: createGoalStack(),
    ...(options.maxJournalEntries === undefined
      ? {}
      : { journal: createSocialStateMutationJournal(options.maxJournalEntries) })
  };
}

export function createSocialMessageIngestionState(): SocialMessageIngestionState {
  return {
    schemaVersion: "harness.social-message-ingestion.v1",
    seenMessageIds: []
  };
}

export function ensureSocialMessageIngestionState(state: AgentSocialState): SocialMessageIngestionState {
  state.messageIngestion ??= createSocialMessageIngestionState();
  return state.messageIngestion;
}

export function createMemoryStore<TObservation = unknown, TPending = unknown, TCommand = unknown>(
  maxEntries = 200
): MemoryStore<TObservation, TPending, TCommand> {
  requirePositiveCapacity(maxEntries, "memory maxEntries");
  return {
    nextSeq: 1,
    maxEntries,
    entries: []
  };
}

export function createBeliefStore(): BeliefStore {
  return { claims: {} };
}

export function createRelationshipGraph(): RelationshipGraph {
  return { edges: {} };
}

export function createReputationLedger(): ReputationLedger {
  return { records: {} };
}

export function createNormState(): AgentNormState {
  return { norms: {} };
}

export function createGoalStack(): GoalStack {
  return { goals: [] };
}

export function createCommitmentLedger(): CommitmentLedger {
  return { records: {} };
}

export function createCoalitionLedger(): CoalitionLedger {
  return { records: {} };
}

export function createGossipLedger(): GossipLedger {
  return { records: {} };
}

export function createTheoryOfMindStore(): TheoryOfMindStore {
  return { records: {} };
}

export function createNormSanctionLedger(): NormSanctionLedger {
  return { records: {} };
}

export function createTrustRepairLedger(): TrustRepairLedger {
  return { records: {} };
}

export function createBetrayalLedger(): BetrayalLedger {
  return { records: {} };
}

export function ensureCommitmentLedger(state: AgentSocialState): CommitmentLedger {
  state.commitments ??= createCommitmentLedger();
  return state.commitments;
}

export function ensureCoalitionLedger(state: AgentSocialState): CoalitionLedger {
  state.coalitions ??= createCoalitionLedger();
  return state.coalitions;
}

export function ensureGossipLedger(state: AgentSocialState): GossipLedger {
  state.gossip ??= createGossipLedger();
  return state.gossip;
}

export function ensureTheoryOfMindStore(state: AgentSocialState): TheoryOfMindStore {
  state.theoryOfMind ??= createTheoryOfMindStore();
  return state.theoryOfMind;
}

export function ensureNormSanctionLedger(state: AgentSocialState): NormSanctionLedger {
  state.normSanctions ??= createNormSanctionLedger();
  return state.normSanctions;
}

export function ensureTrustRepairLedger(state: AgentSocialState): TrustRepairLedger {
  state.trustRepairs ??= createTrustRepairLedger();
  return state.trustRepairs;
}

export function ensureBetrayalLedger(state: AgentSocialState): BetrayalLedger {
  state.betrayals ??= createBetrayalLedger();
  return state.betrayals;
}

export function createSocialStateMutationJournal(maxEntries = 1000): SocialStateMutationJournal {
  requirePositiveCapacity(maxEntries, "journal maxEntries");
  return {
    schemaVersion: "harness.social-state-journal.v1",
    nextSeq: 1,
    maxEntries,
    entries: []
  };
}

/**
 * Describe the persisted rolling window without presenting it as an
 * episode-complete history. `nextSeq` is the durable high-water mark, so the
 * number of entries ever appended is derivable even after old entries have
 * been trimmed.
 */
export function socialStateRetentionWindow(
  store: Pick<MemoryStore, "nextSeq" | "entries"> | Pick<SocialStateMutationJournal, "nextSeq" | "entries">
): SocialStateRetentionWindow {
  const retainedSeqs = store.entries.map((entry) => "journalSeq" in entry ? entry.journalSeq : entry.seq);
  const retainedEntryCount = retainedSeqs.length;
  const totalEntryCount = Math.max(0, store.nextSeq - 1);
  const droppedEntryCount = Math.max(0, totalEntryCount - retainedEntryCount);
  return {
    retainedEntryCount,
    totalEntryCount,
    droppedEntryCount,
    firstRetainedSeq: retainedSeqs.at(0) ?? null,
    lastRetainedSeq: retainedSeqs.at(-1) ?? null,
    windowComplete: droppedEntryCount === 0
  };
}
