import type { SocialAction, SocialAgentProfile } from "./social";

export type EvidenceArtifactKind = "observation" | "message" | "event" | "trace" | "state" | "memory" | "action" | "outcome";

export interface EvidenceRef {
  artifact: EvidenceArtifactKind;
  id?: string;
  seq?: number;
  traceId?: string;
  description?: string;
}

export type MemoryVisibility = "private" | "team" | "public" | "postgame";

export const REFLECTION_RECORD_VERSION = "harness.reflection.v1" as const;

export type ReflectionKind = "memory_summary" | "belief_revision" | "strategy_update" | "social_risk" | "goal_revision";
export type ReflectionVisibility = "private" | "team" | "postgame";
export type ReflectionSource = "policy" | "reasoner" | "evaluator" | "human";

/**
 * Durable, evidence-bound reflection artifact. Reflection text is private
 * actor memory by default; it never mutates beliefs, goals, relationships, or
 * environment state merely by being recorded.
 */
export interface ReflectionRecord {
  version: typeof REFLECTION_RECORD_VERSION;
  id: string;
  agentId: string;
  createdAtTurn: number;
  kind: ReflectionKind;
  content: string;
  evidenceRefs: EvidenceRef[];
  confidence: number;
  visibility: ReflectionVisibility;
  source: ReflectionSource;
}

export interface SocialMemoryEntry<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  seq: number;
  kind: "observation" | "message" | "decision" | "memo" | "reflection" | "action" | "outcome" | "commitment";
  source: string;
  visibility: MemoryVisibility;
  observation?: TObservation;
  pendingAction?: TPending;
  action?: SocialAction<TCommand>;
  reflection?: ReflectionRecord;
  content?: string;
  salience: number;
  importance: number;
  evidenceRefs: EvidenceRef[];
  tags: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryStore<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  nextSeq: number;
  maxEntries: number;
  entries: Array<SocialMemoryEntry<TObservation, TPending, TCommand>>;
}

/**
 * Stable evidence for the deterministic recall context exposed to one agent
 * decision.  This deliberately records references and ranking inputs only;
 * raw memory content remains private actor state and is never duplicated into
 * the durable decision evidence.
 */
export const MEMORY_RETRIEVAL_VERSION = "harness.memory-retrieval.v1" as const;

export interface MemoryRetrievalSelection {
  memorySeq: number;
  rank: number;
  score: number;
  scoreReasons: Array<"importance" | "salience" | "recency_tiebreak">;
  kind: SocialMemoryEntry["kind"];
  source: string;
  visibility: MemoryVisibility;
  tags: string[];
  evidenceRefs: EvidenceRef[];
}

export interface MemoryRetrievalRecord {
  version: typeof MEMORY_RETRIEVAL_VERSION;
  actorId: string;
  traceId?: string;
  query: {
    limit: number;
    tags?: string[];
    visibility?: MemoryVisibility;
    source?: string;
    ranking: "importance_then_salience_then_recency";
  };
  selected: MemoryRetrievalSelection[];
}

export interface RetrievedMemoryContext<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  evidence: MemoryRetrievalRecord;
  entries: Array<SocialMemoryEntry<TObservation, TPending, TCommand>>;
}

export interface BeliefContradiction {
  value: unknown;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
}

export interface BeliefClaim {
  id: string;
  subject: string;
  predicate: string;
  value: unknown;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  contradictions: BeliefContradiction[];
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface BeliefStore {
  claims: Record<string, BeliefClaim>;
}

export interface RelationshipEdge {
  targetId: string;
  trust: number;
  suspicion: number;
  affinity: number;
  influence: number;
  debt: number;
  respect: number;
  threat: number;
  evidenceRefs: EvidenceRef[];
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface RelationshipGraph {
  edges: Record<string, RelationshipEdge>;
}

export interface ReputationRecord {
  subjectId: string;
  honesty: number;
  competence: number;
  cooperation: number;
  threat: number;
  normCompliance: number;
  evidenceRefs: EvidenceRef[];
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ReputationLedger {
  records: Record<string, ReputationRecord>;
}

export type NormKind = "obligation" | "prohibition" | "permission" | "convention";
export type NormStatus = "active" | "fulfilled" | "violated" | "expired" | "withdrawn";

export interface NormRecord {
  id: string;
  kind: NormKind;
  scope: string;
  condition?: string;
  expectedBehavior: string;
  sanction?: string;
  source: string;
  confidence: number;
  status: NormStatus;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface AgentNormState {
  norms: Record<string, NormRecord>;
}

export type GoalKind = "identity" | "episode" | "tactical" | "commitment";
export type GoalStatus = "active" | "completed" | "cancelled" | "failed";

export interface GoalRecord {
  id: string;
  kind: GoalKind;
  description: string;
  priority: number;
  status: GoalStatus;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface GoalStack {
  goals: GoalRecord[];
}

export type CommitmentStatus = "active" | "fulfilled" | "broken" | "unknown" | "expired" | "withdrawn";

export interface CommitmentRecord {
  id: string;
  actorId: string;
  audienceIds: string[];
  visibility: MemoryVisibility;
  promisedAction?: string;
  stance?: string;
  targetId?: string;
  deadlinePhase?: string;
  deadlineDay?: number;
  status: CommitmentStatus;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface CommitmentLedger {
  records: Record<string, CommitmentRecord>;
}

export type CoalitionStatus = "forming" | "active" | "fulfilled" | "dissolved" | "betrayed" | "unknown";
export type CoalitionEvidenceKind = "formation" | "coordination" | "betrayal" | "dissolution";

export interface CoalitionRecord {
  id: string;
  memberIds: string[];
  visibility: MemoryVisibility;
  sharedGoal?: string;
  targetId?: string;
  status: CoalitionStatus;
  confidence: number;
  formationEvidenceRefs: EvidenceRef[];
  coordinationEvidenceRefs: EvidenceRef[];
  betrayalEvidenceRefs: EvidenceRef[];
  dissolutionEvidenceRefs: EvidenceRef[];
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface CoalitionLedger {
  records: Record<string, CoalitionRecord>;
}

export type GossipValence = "positive" | "negative" | "neutral" | "mixed" | "unknown";

export interface GossipRecord {
  id: string;
  speakerId: string;
  subjectId: string;
  audienceIds: string[];
  visibility: MemoryVisibility;
  topic?: string;
  claim?: string;
  sourceId?: string;
  valence: GossipValence;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface GossipLedger {
  records: Record<string, GossipRecord>;
}

/**
 * A theory-of-mind record is deliberately an attribution of an *observed
 * statement*, not a claim that the subject actually believes, knows, intends,
 * or will do the thing described.  This keeps first-order beliefs owned by
 * {@link BeliefStore} semantically separate from second-order social evidence.
 */
export type TheoryOfMindAttributionKind =
  | "stated_assertion"
  | "stated_intent"
  | "stated_commitment"
  | "stated_request"
  | "stated_agreement"
  | "stated_disagreement";

export interface TheoryOfMindProposition {
  /** A domain-neutral predicate derived from the explicit speech-act kind. */
  predicate: string;
  /** The entity named by the statement, when the typed act supplied one. */
  subjectId?: string;
  /** The target named by the statement, when the typed act supplied one. */
  targetId?: string;
  /**
   * Exact structured speech-act payload. It is copied, never interpreted from
   * message text, and is redacted from non-private projections.
   */
  value?: unknown;
}

export interface TheoryOfMindAttribution {
  id: string;
  /** The private social-state owner: observer A. */
  observerId: string;
  /** The speaker whose explicit statement A observed: subject B. */
  subjectId: string;
  kind: TheoryOfMindAttributionKind;
  proposition: TheoryOfMindProposition;
  source: "speech_act";
  sourceMessageId: string;
  sourceMessageSeq: number;
  sourceSpeechActId: string;
  sourceSpeechActKind: string;
  /** Present when the scoped message carried a runtime delivery receipt. */
  sourceDeliveryReceiptId?: string;
  visibility: MemoryVisibility;
  /** Confidence stated by the source act, not an inferred confidence. */
  confidence?: number;
  evidenceRefs: EvidenceRef[];
  observedAtTraceId?: string;
  observedAtTurnIndex?: number;
  createdAt: string;
}

export interface TheoryOfMindStore {
  records: Record<string, TheoryOfMindAttribution>;
}

export type NormSanctionKind = "warning" | "pressure" | "reputation" | "exclusion" | "punishment" | "repair_request" | "reward";
export type NormSanctionStatus = "proposed" | "applied" | "repaired" | "withdrawn" | "expired" | "unknown";

export interface NormSanctionRecord {
  id: string;
  normId: string;
  actorId: string;
  targetId: string;
  audienceIds: string[];
  visibility: MemoryVisibility;
  kind: NormSanctionKind;
  status: NormSanctionStatus;
  reason?: string;
  requestedRepair?: string;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface NormSanctionLedger {
  records: Record<string, NormSanctionRecord>;
}

export type TrustRepairKind =
  | "apology"
  | "explanation"
  | "evidence_provided"
  | "correction"
  | "commitment_made"
  | "compensation"
  | "public_clarification"
  | "coalition_repair"
  | "norm_repair"
  | "reputation_repair"
  | "other";
export type TrustRepairStatus =
  | "proposed"
  | "attempted"
  | "accepted"
  | "rejected"
  | "in_progress"
  | "completed"
  | "failed"
  | "withdrawn"
  | "expired"
  | "unknown";
export type TrustRepairTriggerKind =
  | "commitment"
  | "coalition"
  | "gossip"
  | "norm_sanction"
  | "relationship"
  | "reputation"
  | "other";

export interface TrustRepairRecord {
  id: string;
  actorId: string;
  targetId: string;
  audienceIds: string[];
  visibility: MemoryVisibility;
  kind: TrustRepairKind;
  status: TrustRepairStatus;
  triggerKind?: TrustRepairTriggerKind;
  triggerId?: string;
  requestedById?: string;
  relatedCommitmentId?: string;
  relatedCoalitionId?: string;
  relatedNormSanctionId?: string;
  relatedGossipId?: string;
  reason?: string;
  requestedRepair?: string;
  offeredRepair?: string;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface TrustRepairLedger {
  records: Record<string, TrustRepairRecord>;
}

export type BetrayalKind =
  | "commitment_broken"
  | "coalition_betrayal"
  | "information_leak"
  | "vote_flip"
  | "attack"
  | "abandonment"
  | "deception"
  | "other";
export type BetrayalStatus = "alleged" | "acknowledged" | "contested" | "confirmed" | "repaired" | "withdrawn" | "unknown";
export type BetrayalEvidenceKind = "allegation" | "corroboration" | "contest" | "repair" | "outcome";
export type BetrayalTriggerKind =
  | "commitment"
  | "coalition"
  | "gossip"
  | "norm_sanction"
  | "trust_repair"
  | "relationship"
  | "reputation"
  | "other";

export interface BetrayalRecord {
  id: string;
  actorId: string;
  targetId: string;
  audienceIds: string[];
  visibility: MemoryVisibility;
  kind: BetrayalKind;
  status: BetrayalStatus;
  triggerKind?: BetrayalTriggerKind;
  triggerId?: string;
  relatedCommitmentId?: string;
  relatedCoalitionId?: string;
  relatedGossipId?: string;
  relatedNormSanctionId?: string;
  relatedTrustRepairId?: string;
  claim?: string;
  impact?: string;
  confidence: number;
  allegationEvidenceRefs: EvidenceRef[];
  corroborationEvidenceRefs: EvidenceRef[];
  contestEvidenceRefs: EvidenceRef[];
  repairEvidenceRefs: EvidenceRef[];
  outcomeEvidenceRefs: EvidenceRef[];
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface BetrayalLedger {
  records: Record<string, BetrayalRecord>;
}

export type SocialStateMutationStore =
  | "memory"
  | "beliefs"
  | "relationships"
  | "reputation"
  | "norms"
  | "goals"
  | "commitments"
  | "coalitions"
  | "gossip"
  | "theoryOfMind"
  | "normSanctions"
  | "trustRepairs"
  | "betrayals"
  | "plan";

export type SocialStateMutationKind =
  | "memory.appended"
  | "belief.upserted"
  | "relationship.updated"
  | "reputation.updated"
  | "norm.added"
  | "norm.status.updated"
  | "goal.pushed"
  | "goal.status.updated"
  | "commitment.added"
  | "commitment.status.updated"
  | "coalition.added"
  | "coalition.evidence.recorded"
  | "gossip.added"
  | "theory_of_mind.attribution.recorded"
  | "norm_sanction.added"
  | "norm_sanction.status.updated"
  | "trust_repair.added"
  | "trust_repair.status.updated"
  | "betrayal.added"
  | "betrayal.evidence.recorded"
  | "plan.updated";

export interface SocialStateMutationRange {
  start: number;
  end: number;
}

export interface SocialStateMutationSummary {
  [key: string]: unknown;
}

export interface SocialStateMutationJournalEntry {
  journalSeq: number;
  agentId: string;
  profileId?: string;
  traceId?: string;
  turnIndex?: number;
  phase?: string;
  day?: number;
  store: SocialStateMutationStore;
  mutationKind: SocialStateMutationKind;
  subjectId?: string;
  beforeSummary?: SocialStateMutationSummary;
  afterSummary?: SocialStateMutationSummary;
  deltaSummary?: SocialStateMutationSummary;
  evidenceRefs: EvidenceRef[];
  messageSeqRange?: SocialStateMutationRange;
  eventSeqRange?: SocialStateMutationRange;
  redactionClass: "agent_private_summary";
  hiddenTruthUsed: false;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SocialStateMutationJournal {
  schemaVersion: "harness.social-state-journal.v1";
  nextSeq: number;
  maxEntries: number;
  entries: SocialStateMutationJournalEntry[];
}

export interface SocialStateMutationContext {
  traceId?: string;
  turnIndex?: number;
  phase?: string;
  day?: number;
  messageSeqRange?: SocialStateMutationRange;
  eventSeqRange?: SocialStateMutationRange;
}

export interface SocialMessageIngestionState {
  schemaVersion: "harness.social-message-ingestion.v1";
  seenMessageIds: string[];
}

export interface AgentSocialState<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  agentId: string;
  profile: SocialAgentProfile;
  messageIngestion?: SocialMessageIngestionState;
  memory: MemoryStore<TObservation, TPending, TCommand>;
  beliefs: BeliefStore;
  relationships: RelationshipGraph;
  norms: AgentNormState;
  reputation: ReputationLedger;
  goals: GoalStack;
  commitments?: CommitmentLedger;
  coalitions?: CoalitionLedger;
  gossip?: GossipLedger;
  theoryOfMind?: TheoryOfMindStore;
  normSanctions?: NormSanctionLedger;
  trustRepairs?: TrustRepairLedger;
  betrayals?: BetrayalLedger;
  lastPlan?: unknown;
  journal?: SocialStateMutationJournal;
}

export function createAgentSocialState<TObservation, TPending, TCommand>(options: {
  agentId: string;
  profile: SocialAgentProfile;
  maxMemoryEntries?: number;
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
    goals: createGoalStack()
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
  return {
    schemaVersion: "harness.social-state-journal.v1",
    nextSeq: 1,
    maxEntries,
    entries: []
  };
}

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

export function appendMemory<TObservation, TPending, TCommand>(
  store: MemoryStore<TObservation, TPending, TCommand>,
  entry: Omit<Partial<SocialMemoryEntry<TObservation, TPending, TCommand>>, "seq" | "createdAt">
): SocialMemoryEntry<TObservation, TPending, TCommand> {
  const seq = store.nextSeq;
  const evidenceRefs = cloneJson(entry.evidenceRefs ?? []);
  requireEvidence(evidenceRefs, "memory append");
  const record: SocialMemoryEntry<TObservation, TPending, TCommand> = {
    kind: entry.kind ?? "memo",
    source: entry.source ?? "agent",
    visibility: entry.visibility ?? "private",
    observation: cloneJson(entry.observation),
    pendingAction: cloneJson(entry.pendingAction),
    action: cloneJson(entry.action),
    reflection: cloneJson(entry.reflection),
    content: entry.content,
    salience: clamp01(entry.salience ?? 0.5),
    importance: clamp01(entry.importance ?? 0.5),
    evidenceRefs,
    tags: [...(entry.tags ?? [])],
    metadata: cloneJson(entry.metadata),
    seq,
    createdAt: deterministicTimestamp(seq)
  };
  store.entries.push(record);
  store.nextSeq += 1;
  if (store.entries.length > store.maxEntries) {
    store.entries = store.entries.slice(-store.maxEntries);
  }
  return cloneJson(record);
}

export function appendSocialMemory<TObservation, TPending, TCommand>(
  state: AgentSocialState<TObservation, TPending, TCommand>,
  entry: Omit<Partial<SocialMemoryEntry<TObservation, TPending, TCommand>>, "seq" | "createdAt">,
  context?: SocialStateMutationContext
): SocialMemoryEntry<TObservation, TPending, TCommand> {
  validateReflectionMemoryBinding(state, entry);
  const beforeCount = state.memory.entries.length;
  const beforeNextSeq = state.memory.nextSeq;
  const record = appendMemory(state.memory, entry);
  recordSocialStateMutation(state, {
    store: "memory",
    mutationKind: "memory.appended",
    subjectId: record.source,
    beforeSummary: {
      entryCount: beforeCount,
      nextSeq: beforeNextSeq
    },
    afterSummary: {
      entryCount: state.memory.entries.length,
      nextSeq: state.memory.nextSeq,
      ...summarizeMemoryEntry(record)
    },
    deltaSummary: {
      appendedSeq: record.seq,
      trimmedEntries: Math.max(0, beforeCount + 1 - state.memory.entries.length)
    },
    evidenceRefs: record.evidenceRefs,
    context: mergeMutationContext(context, record.evidenceRefs, record.metadata),
    metadata: {
      tags: record.tags.slice(0, 12)
    }
  });
  return record;
}

function validateReflectionMemoryBinding<TObservation, TPending, TCommand>(
  state: AgentSocialState<TObservation, TPending, TCommand>,
  entry: Omit<Partial<SocialMemoryEntry<TObservation, TPending, TCommand>>, "seq" | "createdAt">
): void {
  if (entry.kind !== "reflection") {
    if (entry.reflection !== undefined) throw new Error("Only reflection memory may carry a ReflectionRecord.");
    return;
  }
  const reflection = entry.reflection;
  if (!reflection) throw new Error("Reflection memory requires a typed ReflectionRecord.");
  if (reflection.version !== REFLECTION_RECORD_VERSION) throw new Error(`ReflectionRecord.version must be ${REFLECTION_RECORD_VERSION}.`);
  if (!reflection.id) throw new Error("ReflectionRecord.id must be non-empty.");
  if (reflection.agentId !== state.agentId) throw new Error(`ReflectionRecord.agentId must match ${state.agentId}.`);
  if (!Number.isInteger(reflection.createdAtTurn) || reflection.createdAtTurn < 0) {
    throw new Error("ReflectionRecord.createdAtTurn must be a non-negative integer.");
  }
  if (!["memory_summary", "belief_revision", "strategy_update", "social_risk", "goal_revision"].includes(reflection.kind)) {
    throw new Error("ReflectionRecord.kind is invalid.");
  }
  if (typeof reflection.content !== "string" || !reflection.content.trim()) throw new Error("ReflectionRecord.content must be non-empty.");
  if (!Number.isFinite(reflection.confidence) || reflection.confidence < 0 || reflection.confidence > 1) {
    throw new Error("ReflectionRecord.confidence must be finite and within [0, 1].");
  }
  if (!["private", "team", "postgame"].includes(reflection.visibility)) throw new Error("ReflectionRecord.visibility is invalid.");
  if (!["policy", "reasoner", "evaluator", "human"].includes(reflection.source)) throw new Error("ReflectionRecord.source is invalid.");
  if (!reflection.evidenceRefs.length || !reflection.evidenceRefs.some((ref) => ref.artifact === "outcome" && ref.traceId)) {
    throw new Error("ReflectionRecord requires committed outcome evidence.");
  }
  if (entry.content !== reflection.content) throw new Error("Reflection memory content must match its ReflectionRecord.");
  if ((entry.visibility ?? "private") !== reflection.visibility) throw new Error("Reflection memory visibility must match its ReflectionRecord.");
  if ((entry.source ?? "agent") !== reflection.source) throw new Error("Reflection memory source must match its ReflectionRecord.");
  if (JSON.stringify(entry.evidenceRefs ?? []) !== JSON.stringify(reflection.evidenceRefs)) {
    throw new Error("Reflection memory evidenceRefs must match its ReflectionRecord.");
  }
  if (state.memory.entries.some((candidate) => candidate.reflection?.id === reflection.id)) {
    throw new Error(`Duplicate ReflectionRecord.id ${reflection.id}.`);
  }
}

export function retrieveMemory<TObservation, TPending, TCommand>(
  store: MemoryStore<TObservation, TPending, TCommand>,
  options: {
    limit?: number;
    tags?: string[];
    visibility?: MemoryVisibility;
    source?: string;
    text?: string;
  } = {}
): Array<SocialMemoryEntry<TObservation, TPending, TCommand>> {
  const tags = new Set(options.tags ?? []);
  const text = options.text?.toLowerCase();
  const matches = store.entries.filter((entry) => {
    if (options.visibility && entry.visibility !== options.visibility) return false;
    if (options.source && entry.source !== options.source) return false;
    if (tags.size && !entry.tags.some((tag) => tags.has(tag))) return false;
    if (text && !entry.content?.toLowerCase().includes(text)) return false;
    return true;
  });
  return matches
    .sort((a, b) => memoryScore(b) - memoryScore(a) || b.seq - a.seq)
    .slice(0, options.limit ?? matches.length)
    .map(cloneJson);
}

/**
 * Read a bounded, deterministic selection from one actor's memory without
 * changing the store or journal.  Consumers receive cloned entries for
 * private policy/reasoner context and a content-free evidence record suitable
 * for plans, receipts, snapshots, and artifacts.
 */
export function retrieveMemoryContext<TObservation, TPending, TCommand>(
  store: MemoryStore<TObservation, TPending, TCommand>,
  options: {
    actorId: string;
    traceId?: string;
    limit?: number;
    tags?: string[];
    visibility?: MemoryVisibility;
    source?: string;
  }
): RetrievedMemoryContext<TObservation, TPending, TCommand> {
  const limit = Math.max(0, Math.floor(options.limit ?? store.entries.length));
  const entries = retrieveMemory(store, {
    limit,
    tags: options.tags,
    visibility: options.visibility,
    source: options.source
  });
  return {
    evidence: {
      version: MEMORY_RETRIEVAL_VERSION,
      actorId: options.actorId,
      traceId: options.traceId,
      query: {
        limit,
        tags: options.tags ? [...options.tags] : undefined,
        visibility: options.visibility,
        source: options.source,
        ranking: "importance_then_salience_then_recency"
      },
      selected: entries.map((entry, index) => ({
        memorySeq: entry.seq,
        rank: index + 1,
        score: roundMemoryScore(memoryScore(entry)),
        scoreReasons: ["importance", "salience", "recency_tiebreak"],
        kind: entry.kind,
        source: entry.source,
        visibility: entry.visibility,
        tags: [...entry.tags],
        evidenceRefs: cloneJson(entry.evidenceRefs)
      }))
    },
    entries: cloneJson(entries)
  };
}

export function upsertBelief(store: BeliefStore, input: {
  subject: string;
  predicate: string;
  value: unknown;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): BeliefClaim {
  requireEvidence(input.evidenceRefs, "belief update");
  const id = beliefId(input.subject, input.predicate);
  const previous = store.claims[id];
  const contradictions = [...(previous?.contradictions ?? [])];
  if (previous && JSON.stringify(previous.value) !== JSON.stringify(input.value)) {
    contradictions.push({
      value: cloneJson(previous.value),
      confidence: previous.confidence,
      evidenceRefs: cloneJson(previous.evidenceRefs),
      createdAt: deterministicTimestamp(contradictions.length + 1)
    });
  }
  const record: BeliefClaim = {
    id,
    subject: input.subject,
    predicate: input.predicate,
    value: cloneJson(input.value),
    confidence: clamp01(input.confidence),
    evidenceRefs: mergeEvidenceRefs(previous?.evidenceRefs ?? [], input.evidenceRefs),
    contradictions,
    updatedAt: deterministicTimestamp((previous?.evidenceRefs.length ?? 0) + input.evidenceRefs.length + contradictions.length + 1),
    metadata: cloneJson(input.metadata)
  };
  store.claims[id] = record;
  return cloneJson(record);
}

export function upsertSocialBelief(state: AgentSocialState, input: {
  subject: string;
  predicate: string;
  value: unknown;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}, context?: SocialStateMutationContext): BeliefClaim {
  const id = beliefId(input.subject, input.predicate);
  const previous = state.beliefs.claims[id];
  const record = upsertBelief(state.beliefs, input);
  recordSocialStateMutation(state, {
    store: "beliefs",
    mutationKind: "belief.upserted",
    subjectId: input.subject,
    beforeSummary: previous ? summarizeBeliefClaim(previous) : undefined,
    afterSummary: summarizeBeliefClaim(record),
    deltaSummary: {
      claimId: id,
      predicate: input.predicate,
      valueChanged: previous ? JSON.stringify(previous.value) !== JSON.stringify(input.value) : true,
      confidenceDelta: round3(record.confidence - (previous?.confidence ?? 0)),
      contradictionCountDelta: record.contradictions.length - (previous?.contradictions.length ?? 0)
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

export function updateRelationship(graph: RelationshipGraph, input: {
  targetId: string;
  deltas: Partial<Pick<RelationshipEdge, "trust" | "suspicion" | "affinity" | "influence" | "debt" | "respect" | "threat">>;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): RelationshipEdge {
  requireEvidence(input.evidenceRefs, "relationship update");
  const previous = graph.edges[input.targetId] ?? createRelationshipEdge(input.targetId);
  const updated: RelationshipEdge = {
    ...previous,
    trust: clampSigned(previous.trust + (input.deltas.trust ?? 0)),
    suspicion: clampSigned(previous.suspicion + (input.deltas.suspicion ?? 0)),
    affinity: clampSigned(previous.affinity + (input.deltas.affinity ?? 0)),
    influence: clampSigned(previous.influence + (input.deltas.influence ?? 0)),
    debt: clampSigned(previous.debt + (input.deltas.debt ?? 0)),
    respect: clampSigned(previous.respect + (input.deltas.respect ?? 0)),
    threat: clampSigned(previous.threat + (input.deltas.threat ?? 0)),
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  graph.edges[input.targetId] = updated;
  return cloneJson(updated);
}

export function updateSocialRelationship(state: AgentSocialState, input: {
  targetId: string;
  deltas: Partial<Pick<RelationshipEdge, "trust" | "suspicion" | "affinity" | "influence" | "debt" | "respect" | "threat">>;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}, context?: SocialStateMutationContext): RelationshipEdge {
  const previous = state.relationships.edges[input.targetId];
  const updated = updateRelationship(state.relationships, input);
  recordSocialStateMutation(state, {
    store: "relationships",
    mutationKind: "relationship.updated",
    subjectId: input.targetId,
    beforeSummary: previous ? summarizeRelationshipEdge(previous) : undefined,
    afterSummary: summarizeRelationshipEdge(updated),
    deltaSummary: summarizeNumericDeltas(input.deltas),
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return updated;
}

export function updateReputation(ledger: ReputationLedger, input: {
  subjectId: string;
  deltas: Partial<Pick<ReputationRecord, "honesty" | "competence" | "cooperation" | "threat" | "normCompliance">>;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): ReputationRecord {
  requireEvidence(input.evidenceRefs, "reputation update");
  const previous = ledger.records[input.subjectId] ?? createReputationRecord(input.subjectId);
  const updated: ReputationRecord = {
    ...previous,
    honesty: clampSigned(previous.honesty + (input.deltas.honesty ?? 0)),
    competence: clampSigned(previous.competence + (input.deltas.competence ?? 0)),
    cooperation: clampSigned(previous.cooperation + (input.deltas.cooperation ?? 0)),
    threat: clampSigned(previous.threat + (input.deltas.threat ?? 0)),
    normCompliance: clampSigned(previous.normCompliance + (input.deltas.normCompliance ?? 0)),
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  ledger.records[input.subjectId] = updated;
  return cloneJson(updated);
}

export function updateSocialReputation(state: AgentSocialState, input: {
  subjectId: string;
  deltas: Partial<Pick<ReputationRecord, "honesty" | "competence" | "cooperation" | "threat" | "normCompliance">>;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}, context?: SocialStateMutationContext): ReputationRecord {
  const previous = state.reputation.records[input.subjectId];
  const updated = updateReputation(state.reputation, input);
  recordSocialStateMutation(state, {
    store: "reputation",
    mutationKind: "reputation.updated",
    subjectId: input.subjectId,
    beforeSummary: previous ? summarizeReputationRecord(previous) : undefined,
    afterSummary: summarizeReputationRecord(updated),
    deltaSummary: summarizeNumericDeltas(input.deltas),
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return updated;
}

export function addNorm(state: AgentNormState, input: Omit<NormRecord, "createdAt" | "updatedAt">): NormRecord {
  requireEvidence(input.evidenceRefs, "norm update");
  const record: NormRecord = {
    ...cloneJson(input),
    confidence: clamp01(input.confidence),
    createdAt: deterministicTimestamp(Object.keys(state.norms).length + 1),
    updatedAt: deterministicTimestamp(Object.keys(state.norms).length + 1)
  };
  state.norms[record.id] = record;
  return cloneJson(record);
}

export function addSocialNorm(
  state: AgentSocialState,
  input: Omit<NormRecord, "createdAt" | "updatedAt">,
  context?: SocialStateMutationContext
): NormRecord {
  const record = addNorm(state.norms, input);
  recordSocialStateMutation(state, {
    store: "norms",
    mutationKind: "norm.added",
    subjectId: record.id,
    afterSummary: summarizeNormRecord(record),
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

export function updateNormStatus(state: AgentNormState, input: {
  id: string;
  status: NormStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): NormRecord {
  requireEvidence(input.evidenceRefs, "norm status update");
  const previous = state.norms[input.id];
  if (!previous) throw new Error(`Unknown norm ${input.id}.`);
  const updated: NormRecord = {
    ...previous,
    status: input.status,
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  state.norms[input.id] = updated;
  return cloneJson(updated);
}

export function updateSocialNormStatus(state: AgentSocialState, input: {
  id: string;
  status: NormStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}, context?: SocialStateMutationContext): NormRecord {
  const previous = state.norms.norms[input.id];
  const updated = updateNormStatus(state.norms, input);
  recordSocialStateMutation(state, {
    store: "norms",
    mutationKind: "norm.status.updated",
    subjectId: input.id,
    beforeSummary: previous ? summarizeNormRecord(previous) : undefined,
    afterSummary: summarizeNormRecord(updated),
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

export function pushGoal(stack: GoalStack, input: Omit<GoalRecord, "createdAt" | "updatedAt" | "status"> & { status?: GoalStatus }): GoalRecord {
  requireEvidence(input.evidenceRefs, "goal update");
  const record: GoalRecord = {
    ...cloneJson(input),
    priority: clamp01(input.priority),
    status: input.status ?? "active",
    createdAt: deterministicTimestamp(stack.goals.length + 1),
    updatedAt: deterministicTimestamp(stack.goals.length + 1)
  };
  stack.goals.push(record);
  stack.goals.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  return cloneJson(record);
}

export function pushSocialGoal(
  state: AgentSocialState,
  input: Omit<GoalRecord, "createdAt" | "updatedAt" | "status"> & { status?: GoalStatus },
  context?: SocialStateMutationContext
): GoalRecord {
  const beforeCount = state.goals.goals.length;
  const record = pushGoal(state.goals, input);
  recordSocialStateMutation(state, {
    store: "goals",
    mutationKind: "goal.pushed",
    subjectId: record.id,
    beforeSummary: {
      goalCount: beforeCount
    },
    afterSummary: {
      goalCount: state.goals.goals.length,
      ...summarizeGoalRecord(record)
    },
    deltaSummary: {
      addedGoalId: record.id,
      priority: record.priority,
      status: record.status
    },
    evidenceRefs: input.evidenceRefs,
    context: mergeMutationContext(context, input.evidenceRefs, input.metadata),
    metadata: input.metadata
  });
  return record;
}

export function updateGoalStatus(stack: GoalStack, input: {
  id: string;
  status: GoalStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}): GoalRecord {
  requireEvidence(input.evidenceRefs, "goal status update");
  const index = stack.goals.findIndex((goal) => goal.id === input.id);
  if (index < 0) throw new Error(`Unknown goal ${input.id}.`);
  const previous = stack.goals[index];
  const updated: GoalRecord = {
    ...previous,
    status: input.status,
    evidenceRefs: mergeEvidenceRefs(previous.evidenceRefs, input.evidenceRefs),
    updatedAt: deterministicTimestamp(previous.evidenceRefs.length + input.evidenceRefs.length + 1),
    metadata: cloneJson({ ...(previous.metadata ?? {}), ...(input.metadata ?? {}) })
  };
  stack.goals[index] = updated;
  return cloneJson(updated);
}

export function updateSocialGoalStatus(state: AgentSocialState, input: {
  id: string;
  status: GoalStatus;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}, context?: SocialStateMutationContext): GoalRecord {
  const previous = state.goals.goals.find((goal) => goal.id === input.id);
  const updated = updateGoalStatus(state.goals, input);
  recordSocialStateMutation(state, {
    store: "goals",
    mutationKind: "goal.status.updated",
    subjectId: input.id,
    beforeSummary: previous ? summarizeGoalRecord(previous) : undefined,
    afterSummary: summarizeGoalRecord(updated),
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

export function setSocialLastPlan(
  state: AgentSocialState,
  plan: unknown,
  evidenceRefs: EvidenceRef[],
  context?: SocialStateMutationContext,
  metadata?: Record<string, unknown>
): unknown {
  const previous = state.lastPlan;
  state.lastPlan = cloneJson(plan);
  recordSocialStateMutation(state, {
    store: "plan",
    mutationKind: "plan.updated",
    beforeSummary: previous === undefined ? undefined : summarizePlan(previous),
    afterSummary: summarizePlan(plan),
    evidenceRefs,
    context: mergeMutationContext(context, evidenceRefs, metadata),
    metadata: {
      metadataKeys: metadataKeys(metadata)
    }
  });
  return cloneJson(state.lastPlan);
}

export function activeGoals(stack: GoalStack): GoalRecord[] {
  return stack.goals.filter((goal) => goal.status === "active").map(cloneJson);
}

function summarizeMemoryEntry<TObservation, TPending, TCommand>(
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

function summarizeBeliefClaim(claim: BeliefClaim): SocialStateMutationSummary {
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

function summarizeRelationshipEdge(edge: RelationshipEdge): SocialStateMutationSummary {
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

function summarizeReputationRecord(record: ReputationRecord): SocialStateMutationSummary {
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

function summarizeNormRecord(record: NormRecord): SocialStateMutationSummary {
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

function summarizeGoalRecord(record: GoalRecord): SocialStateMutationSummary {
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

function summarizeCommitmentRecord(record: CommitmentRecord): SocialStateMutationSummary {
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

function summarizeCoalitionRecord(record: CoalitionRecord): SocialStateMutationSummary {
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

function summarizeGossipRecord(record: GossipRecord): SocialStateMutationSummary {
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

function summarizeTheoryOfMindAttribution(record: TheoryOfMindAttribution): SocialStateMutationSummary {
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

function summarizeNormSanctionRecord(record: NormSanctionRecord): SocialStateMutationSummary {
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

function summarizeTrustRepairRecord(record: TrustRepairRecord): SocialStateMutationSummary {
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

function summarizeBetrayalRecord(record: BetrayalRecord): SocialStateMutationSummary {
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

function summarizePlan(plan: unknown): SocialStateMutationSummary {
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

function summarizeNumericDeltas(input: Record<string, unknown>): SocialStateMutationSummary {
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

function mergeMutationContext(
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

function metadataKeys(metadata: Record<string, unknown> | undefined): string[] {
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

function createRelationshipEdge(targetId: string): RelationshipEdge {
  return {
    targetId,
    trust: 0,
    suspicion: 0,
    affinity: 0,
    influence: 0,
    debt: 0,
    respect: 0,
    threat: 0,
    evidenceRefs: [],
    updatedAt: deterministicTimestamp(0)
  };
}

function createReputationRecord(subjectId: string): ReputationRecord {
  return {
    subjectId,
    honesty: 0,
    competence: 0,
    cooperation: 0,
    threat: 0,
    normCompliance: 0,
    evidenceRefs: [],
    updatedAt: deterministicTimestamp(0)
  };
}

function beliefId(subject: string, predicate: string): string {
  return `${subject}:${predicate}`;
}

function memoryScore(entry: SocialMemoryEntry): number {
  return entry.importance * 2 + entry.salience + entry.seq / 1_000_000;
}

function roundMemoryScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function mergeEvidenceRefs(existing: EvidenceRef[], incoming: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const merged: EvidenceRef[] = [];
  for (const ref of [...existing, ...incoming]) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cloneJson(ref));
  }
  return merged;
}

function requireStableTheoryOfMindAttribution(
  input: Omit<TheoryOfMindAttribution, "createdAt" | "confidence"> & { confidence?: number }
): void {
  if (!input.id.trim()) throw new Error("theory-of-mind attribution requires an id.");
  if (!input.observerId.trim()) throw new Error("theory-of-mind attribution requires an observerId.");
  if (!input.subjectId.trim()) throw new Error("theory-of-mind attribution requires a subjectId.");
  if (!input.proposition?.predicate?.trim()) throw new Error("theory-of-mind attribution requires a proposition predicate.");
  if (input.source !== "speech_act") throw new Error("theory-of-mind attribution source must be speech_act.");
  if (!input.sourceMessageId.trim()) throw new Error("theory-of-mind attribution requires a sourceMessageId.");
  if (!Number.isInteger(input.sourceMessageSeq) || input.sourceMessageSeq < 1) {
    throw new Error("theory-of-mind attribution requires a positive sourceMessageSeq.");
  }
  if (!input.sourceSpeechActId.trim()) throw new Error("theory-of-mind attribution requires a sourceSpeechActId.");
  if (!input.sourceSpeechActKind.trim()) throw new Error("theory-of-mind attribution requires a sourceSpeechActKind.");
  if (input.visibility === "postgame") throw new Error("theory-of-mind attribution cannot use postgame-only evidence.");
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error("theory-of-mind attribution confidence must be between 0 and 1.");
  }
  requireEvidence(input.evidenceRefs, "theory-of-mind attribution");
  if (!input.evidenceRefs.some((ref) => ref.artifact === "message" && ref.id === input.sourceMessageId && ref.seq === input.sourceMessageSeq)) {
    throw new Error("theory-of-mind attribution requires matching message evidence.");
  }
}

function requireEvidence(evidenceRefs: EvidenceRef[], operation: string): void {
  if (!evidenceRefs.length) throw new Error(`${operation} requires at least one evidence ref.`);
}

function deterministicTimestamp(seq: number): string {
  return new Date(seq * 1000).toISOString();
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, round3(value)));
}

function clampSigned(value: number): number {
  return Math.min(1, Math.max(-1, round3(value)));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
