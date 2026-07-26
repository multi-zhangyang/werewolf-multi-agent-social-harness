import { type SocialAction, type SocialAgentProfile } from "../social";
export type EvidenceArtifactKind =
  | "observation"
  | "message"
  | "delivery_receipt"
  | "event"
  | "trace"
  | "state"
  | "memory"
  | "action"
  | "outcome";

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

export interface SocialStateRetentionWindow {
  retainedEntryCount: number;
  totalEntryCount: number;
  droppedEntryCount: number;
  firstRetainedSeq: number | null;
  lastRetainedSeq: number | null;
  windowComplete: boolean;
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
