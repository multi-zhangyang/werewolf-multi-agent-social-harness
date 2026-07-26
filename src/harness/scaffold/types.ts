import type {
  SocialAction,
  SocialActorObservationContext,
  SocialActorStepReceipt,
  SocialAgentProfile
} from "../social";
import type {
  AgentSocialState,
  BetrayalKind,
  BetrayalStatus,
  CoalitionStatus,
  CommitmentStatus,
  EvidenceRef,
  GossipValence,
  MemoryRetrievalRecord,
  ReflectionKind,
  SocialMemoryEntry,
  MemoryVisibility,
  NormSanctionKind,
  NormSanctionStatus,
  TrustRepairKind,
  TrustRepairStatus
} from "../socialState";

export interface ScaffoldMemoryEntry<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  seq: number;
  kind: "observation" | "decision" | "memo" | "outcome";
  observation?: TObservation;
  pendingAction?: TPending;
  action?: SocialAction<TCommand>;
  content?: string;
  createdAt: string;
  source?: string;
  visibility?: MemoryVisibility;
  evidenceRefs?: EvidenceRef[];
  tags?: string[];
  salience?: number;
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentScaffoldState<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  id: string;
  profile: SocialAgentProfile;
  observations: number;
  decisions: number;
  memory: Array<ScaffoldMemoryEntry<TObservation, TPending, TCommand>>;
  social: AgentSocialState<TObservation, TPending, TCommand>;
  lastObservation?: TObservation;
  lastAction?: SocialAction<TCommand>;
}

export interface AgentReasonerOutput<TAdvice = unknown> {
  /** Private reflection/memo. It is advisory and never an environment command. */
  memo: string;
  /** Optional typed domain advice; policy/arbitration must still validate it. */
  advice?: TAdvice;
}

export interface AgentDecisionInput<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
> {
  /** A cloned, actor-private canonical state projection. */
  agent: TAgentState;
  /** A cloned social-state projection available to generic scorers. */
  social: AgentSocialState<TObservation, TPending, TCommand>;
  observation: TObservation;
  pendingAction: TPending;
  /** Runner-owned transaction/evidence context for this staged decision. */
  observationContext?: SocialActorObservationContext<TPending>;
  /** Content-free deterministic selection record for this actor turn. */
  memoryRetrieval?: MemoryRetrievalRecord;
  /** Cloned actor-private entries corresponding exactly to memoryRetrieval. */
  recalledMemory?: Array<SocialMemoryEntry<TObservation, TPending, TCommand>>;
  /** Present only after the optional reasoner completes. */
  reasoner?: AgentReasonerOutput<TReasonerAdvice>;
}

export type AgentActionCandidateSource =
  | "policy"
  | "reasoner"
  | "memory"
  | "belief"
  | "relationship"
  | "reputation"
  | "norm"
  | "goal"
  | "social_state"
  | "other";

export interface AgentActionCandidate<TCommand = unknown> {
  id: string;
  actorId: string;
  kind: string;
  source: AgentActionCandidateSource | string;
  socialTargetIds?: string[];
  action: SocialAction<TCommand>;
  baseScore?: number;
  utilityScore?: number;
  socialScore?: number;
  riskPenalty?: number;
  legalityScore?: number;
  finalScore?: number;
  scoreContributions?: AgentActionCandidateScoreContribution[];
  reasons: string[];
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}

export interface AgentActionCandidateScoreContribution {
  scorerId: string;
  source: AgentActionCandidateSource | string;
  utilityScoreDelta?: number;
  socialScoreDelta?: number;
  riskPenaltyDelta?: number;
  legalityScoreDelta?: number;
  finalScoreDelta?: number;
  reasons: string[];
  evidenceRefs: EvidenceRef[];
}

export interface AgentActionCandidateSummary {
  id: string;
  actorId: string;
  kind: string;
  source: string;
  socialTargetIds?: string[];
  baseScore?: number;
  utilityScore?: number;
  socialScore?: number;
  riskPenalty?: number;
  legalityScore?: number;
  finalScore?: number;
  scoreContributions?: AgentActionCandidateScoreContribution[];
  reasons: string[];
  evidenceRefs: EvidenceRef[];
  messageCount: number;
}

export interface AgentActionArbitrationSummary {
  version: "agent.action-arbitration.v1";
  actorId: string;
  policyId: string;
  arbitratorId: string;
  selectedCandidateId: string;
  candidateCount: number;
  decisionRule: string;
  selectionReason?: string;
  selectionEvidenceRefs?: EvidenceRef[];
  candidates: AgentActionCandidateSummary[];
}

export interface AgentActionArbitrationInput<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
> extends AgentDecisionInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice> {
  policyId: string;
  reasonerMemo?: string;
  reasonerAdvice?: TReasonerAdvice;
  candidates: Array<AgentActionCandidate<TCommand>>;
}

export interface AgentActionArbitrationDecision {
  selectedCandidateId: string;
  decisionRule?: string;
  reason?: string;
  evidenceRefs?: EvidenceRef[];
}

export interface AgentActionArbitrator<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
> {
  id: string;
  arbitrate(
    input: AgentActionArbitrationInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>
  ): AgentActionArbitrationDecision | Promise<AgentActionArbitrationDecision>;
}

export interface AgentActionCandidateScoringInput<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
> extends AgentDecisionInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice> {
  policyId: string;
  reasonerMemo?: string;
  reasonerAdvice?: TReasonerAdvice;
  candidate: AgentActionCandidate<TCommand>;
  candidates: Array<AgentActionCandidate<TCommand>>;
}

export interface AgentActionCandidateScorer<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
> {
  id: string;
  score(
    input: AgentActionCandidateScoringInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>
  ):
    | AgentActionCandidateScoreContribution
    | undefined
    | Promise<AgentActionCandidateScoreContribution | undefined>;
}

export type AgentRelationshipScoreField = "trust" | "suspicion" | "affinity" | "influence" | "debt" | "respect" | "threat";
export type AgentReputationScoreField = "honesty" | "competence" | "cooperation" | "threat" | "normCompliance";

export interface WeightedSocialStateCandidateScorerOptions {
  id?: string;
  relationshipWeights?: Partial<Record<AgentRelationshipScoreField, number>>;
  reputationWeights?: Partial<Record<AgentReputationScoreField, number>>;
  beliefPredicateWeights?: Record<string, number>;
  activeGoalWeight?: number;
  activeNormWeight?: number;
  commitmentStatusWeights?: Partial<Record<CommitmentStatus, number>>;
  coalitionStatusWeights?: Partial<Record<CoalitionStatus, number>>;
  gossipValenceWeights?: Partial<Record<GossipValence, number>>;
  normSanctionKindWeights?: Partial<Record<NormSanctionKind, number>>;
  normSanctionStatusWeights?: Partial<Record<NormSanctionStatus, number>>;
  trustRepairKindWeights?: Partial<Record<TrustRepairKind, number>>;
  trustRepairStatusWeights?: Partial<Record<TrustRepairStatus, number>>;
  betrayalKindWeights?: Partial<Record<BetrayalKind, number>>;
  betrayalStatusWeights?: Partial<Record<BetrayalStatus, number>>;
}

export const WEIGHTED_SOCIAL_STATE_CANDIDATE_SCORER_KIND = "weighted-social-state";

export interface AgentActionCandidateScorerConfig {
  kind: string;
  options?: unknown;
}

export type AgentActionCandidateScorerFactory<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
> = (
  config: AgentActionCandidateScorerConfig
) => AgentActionCandidateScorer<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>;

export type AgentActionCandidateScorerRegistry<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
> = Record<
  string,
  AgentActionCandidateScorerFactory<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>
>;

export interface AgentPolicy<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
> {
  id: string;
  decide(input: AgentDecisionInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>): SocialAction<TCommand>;
  generateCandidates?(
    input: AgentDecisionInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>
  ): Array<AgentActionCandidate<TCommand>>;
}

export interface AgentReasoner<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
> {
  id: string;
  reflect(
    input: AgentDecisionInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>
  ): Promise<string | AgentReasonerOutput<TReasonerAdvice>> | string | AgentReasonerOutput<TReasonerAdvice>;
}

export interface ReceiptReflectionDraft {
  kind: ReflectionKind;
  content: string;
  confidence: number;
}

export interface ReceiptReflectionInput<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>
> {
  /** Cloned post-outcome private state; mutation cannot affect durability. */
  agent: TAgentState;
  /** Cloned post-outcome social state for domain-neutral policies. */
  social: AgentSocialState<TObservation, TPending, TCommand>;
  /** Closed receipt facts only. Raw info, observation, action, and provider diagnostics are excluded. */
  receipt: {
    id: string;
    traceId: string;
    transactionId?: string;
    turnIndex: number;
    actorId: string;
    pendingAction: TPending;
    reward?: number;
    terminated: boolean;
    truncated: boolean;
    postStateHash?: string;
    eventSeqRange?: [number, number];
    messageSeqRange?: [number, number];
  };
  /** Content-free retrieval evidence suitable for durable artifacts. */
  memoryRetrieval: MemoryRetrievalRecord;
  /** Cloned private entries available only while the pure policy runs. */
  recalledMemory: Array<SocialMemoryEntry<TObservation, TPending, TCommand>>;
}

/** Synchronous and pure by contract; live model work belongs to an explicit scheduled lifecycle. */
export interface ReceiptReflectionPolicy<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>
> {
  id: string;
  reflect(input: ReceiptReflectionInput<TObservation, TPending, TCommand, TAgentState>): ReceiptReflectionDraft | undefined;
}

export interface ScaffoldCanonicalStateAdapter<
  TAgentState,
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TReasonerAdvice = unknown
> {
  clone(state: TAgentState): TAgentState;
  socialState(state: TAgentState): AgentSocialState<TObservation, TPending, TCommand>;
  observe(input: {
    state: TAgentState;
    observation: TObservation;
    context?: SocialActorObservationContext<TPending>;
  }): void;
  afterDecision(input: {
    state: TAgentState;
    observation: TObservation;
    pendingAction: TPending;
    action: SocialAction<TCommand>;
    decisionInput: AgentDecisionInput<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>;
    reasonerOutput?: AgentReasonerOutput<TReasonerAdvice>;
    arbitration?: AgentActionArbitrationSummary;
    context?: SocialActorObservationContext<TPending>;
  }): void;
  /**
   * Receipt-gated outcome feedback. It runs only after the environment has
   * committed the selected command and the generic social memory recorded its
   * closed receipt summary. Domain adapters may update only derived private
   * state here; environment truth remains outside the actor.
   */
  afterStepResult?(input: {
    state: TAgentState;
    receipt: SocialActorStepReceipt<TObservation, TPending, TCommand>;
  }): void;
}

export interface ScaffoldedActorOptions<
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = AgentScaffoldState<TObservation, TPending, TCommand>,
  TReasonerAdvice = unknown
> {
  id: string;
  profile: SocialAgentProfile;
  policy: AgentPolicy<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>;
  reasoner?: AgentReasoner<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>;
  candidateScorers?: Array<AgentActionCandidateScorer<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>>;
  actionArbitrator?: AgentActionArbitrator<TObservation, TPending, TCommand, TAgentState, TReasonerAdvice>;
  receiptReflectionPolicy?: ReceiptReflectionPolicy<TObservation, TPending, TCommand, TAgentState>;
  initialSocialState?: AgentSocialState<TObservation, TPending, TCommand>;
  /** Required together with canonicalStateAdapter; it is the sole durable private state owner. */
  initialCanonicalState?: TAgentState;
  canonicalStateAdapter?: ScaffoldCanonicalStateAdapter<TAgentState, TObservation, TPending, TCommand, TReasonerAdvice>;
  maxMemoryEntries?: number;
}

/**
 * A runner-owned turn is speculative until the environment accepts it. Keep
 * its observation, social ingestion, memo, and action decision isolated from
 * the durable agent state until a committed receipt arrives.
 */
export interface StagedScaffoldTurn<TAgentState, TObservation = unknown, TPending = unknown> {
  traceId: string;
  state: TAgentState;
  seenMessageIds: Set<string>;
  observationContext?: SocialActorObservationContext<TPending>;
  observation?: TObservation;
}
