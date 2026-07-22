import type {
  AgentBelief,
  GameCommand,
  GameState,
  MatchMetrics,
  PendingAction,
  PlayerView,
  Role,
  Team,
  WerewolfRulesetId
} from "../core/types";
import type { AgentPendingAction } from "../core/pending";
import type { ModelCompletionResult } from "../agents/modelClient";
import type { ProviderFailureKind, ProviderFailureStage, ProviderRetryHistoryEntry, ProviderStreamTelemetry } from "../agents/schema";
import type { SocialChannel, SocialEpisodeArtifact, SocialExecutionLimits, SocialMessage } from "./social";
import type { AgentSocialState, EvidenceRef, MemoryRetrievalRecord, MemoryVisibility } from "./socialState";
import type { GenericForkProvenance } from "./episodeArtifacts";

export type PolicyName = "balanced" | "wolf-deceiver" | "village-analyst" | "seer-information" | "witch-conservative" | "hunter-punisher";

export interface HarnessAgentProfile {
  id: string;
  model: string;
  temperature?: number;
  policyName?: PolicyName;
}

export interface HarnessAgentConfig {
  playerId: string;
  profileId?: string;
  model: string;
  temperature: number;
  policyName?: PolicyName;
}

export interface AgentHarnessState {
  playerId: string;
  profileId?: string;
  model: string;
  temperature: number;
  policyName: PolicyName;
  turns: number;
  observations: number;
  beliefs: Record<string, AgentBelief>;
  privateMemos: string[];
  lastIntent?: string;
  social?: AgentSocialState<PlayerView, AgentPendingAction, GameCommand>;
  socialStateHash?: string;
}

export type WerewolfJointPhaseScheduler = "aec-batched-decision" | "parallel";

/**
 * Production default for simultaneous Werewolf phases (night kill votes and
 * day votes). `parallel` remains an explicit opt-in only; do not change this
 * default without a separate replay/artifact policy decision.
 */
export const DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER: WerewolfJointPhaseScheduler = "aec-batched-decision";

/**
 * Minimum maxTransitions for a Werewolf parallel joint-phase proof path:
 * system.advance + seer.inspect + 2-wolf kill batch.
 * Lower values will refuse to apply the first parallel batch.
 */
export const WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS = 4;

export interface HarnessRunOptions {
  initialState: GameState;
  agents: HarnessAgentConfig[];
  initialAgentStates?: AgentHarnessState[];
  initialSocialChannels?: SocialChannel[];
  initialSocialMessages?: SocialMessage[];
  reasoner: HarnessReasoner;
  maxTransitions?: number;
  /** Generic runner-owned deadline/cancellation boundary. It applies even to
   * non-provider actors, unlike a model-client timeout alone. */
  executionLimits?: SocialExecutionLimits;
  /**
   * Scheduler used for simultaneous Werewolf phases (night kill votes and day
   * votes). Defaults to {@link DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER}.
   * `parallel` requires environment stepBatch joint resolution and is opt-in
   * only.
   */
  jointPhaseScheduler?: WerewolfJointPhaseScheduler;
  forkOf?: HarnessForkProvenance;
  recordAgentSnapshots?: boolean;
}

export type HarnessRunStatus = "completed" | "truncated" | "failed";

export interface HarnessRunResult {
  status: HarnessRunStatus;
  truncationReason?: string;
  failureReason?: string;
  failureStateHash?: string;
  initialState: GameState;
  state: GameState;
  metrics: MatchMetrics;
  evaluation: AdversarialEvaluation;
  evaluationReport: HarnessEvaluationReport;
  /** Legacy Werewolf committed-command projection retained for checkpoint migration. */
  trajectory: HarnessStepRecord[];
  /** Authoritative native scheduler/environment/message-bus execution artifact. */
  socialEpisode: SocialEpisodeArtifact<GameState, WerewolfHarnessObservation, PendingAction, GameCommand>;
  agents: AgentHarnessState[];
  forkOf?: HarnessForkProvenance;
}

export interface ProviderFailureSummary {
  failureKind: ProviderFailureKind;
  providerStage?: ProviderFailureStage;
  status?: number;
  timeoutMs?: number;
  aborted?: boolean;
  retryable?: boolean;
  attempts?: number;
  maxAttempts?: number;
  providerRequestId?: string;
  retryCause?: string;
  abortReason?: string;
  causeName?: string;
}

export interface HarnessErrorPayload {
  [key: string]: unknown;
  model: string;
  actionKind: string;
  message: string;
  traceId: string;
  providerFailure?: ProviderFailureSummary;
  providerRequestId?: string;
  attempts?: number;
}

/**
 * Werewolf compatibility provenance. The reusable parent/checkpoint/hash
 * contract lives in episodeArtifacts; matchId remains an adapter-level alias
 * for server and legacy artifact consumers.
 */
export interface HarnessForkProvenance extends GenericForkProvenance<"harness.checkpoint.v2"> {
  parentMatchId?: string;
  /** Domain-owned semantic identity verified against the restored checkpoint. */
  parentRulesetId: WerewolfRulesetId;
}

export interface HarnessReasoner {
  think(input: ReasonerInput): Promise<ReasonerOutput>;
}

export interface ReasonerInput {
  traceId: string;
  view: HarnessPlayerView;
  action: AgentPendingAction;
  agent: ReasonerAgentContext;
  policyPlan: PolicyPlan;
  /**
   * Content-free deterministic selection evidence retained with the decision.
   * It proves the bounded context offered to the optional reasoner; it is not
   * a claim about hidden model reasoning or environment authority.
   */
  memoryRetrieval?: MemoryRetrievalRecord;
  /** Actor-private cloned excerpts corresponding exactly to memoryRetrieval. */
  recalledMemory?: ReasonerMemoryEntry[];
}

export type HarnessPlayerView = PlayerView & {
  social: {
    channels: SocialChannel[];
    messages: SocialMessage[];
  };
};

export type WerewolfHarnessObservation =
  | {
      kind: "player";
      agentId: string;
      view: HarnessPlayerView;
    }
  | {
      kind: "system";
      agentId: "system";
      gameId: string;
      phase: GameState["phase"];
      day: number;
      pendingAction: Extract<PendingAction, { kind: "advance" }>;
      social: {
        channels: SocialChannel[];
        messages: SocialMessage[];
      };
    };

export interface ReasonerAgentContext {
  playerId: string;
  profileId?: string;
  model: string;
  temperature: number;
  policyName: PolicyName;
  turns: number;
  observations: number;
  beliefs: Record<string, AgentBelief>;
  lastIntent?: string;
  socialStateHash?: string;
}

/**
 * The small read-only memory payload an actor may offer its own reasoner.
 * Full observations, action payloads, and arbitrary social-state metadata are
 * intentionally excluded; those remain in the actor's private snapshot.
 */
export interface ReasonerMemoryEntry {
  memorySeq: number;
  kind: string;
  source: string;
  visibility: MemoryVisibility;
  tags: string[];
  content?: string;
}

export interface ReasonerOutput {
  content: string;
  completion: ModelCompletionResult;
  actionProposal?: ReasonerActionProposal;
}

/**
 * A typed, provider-neutral suggestion from a reasoner. This is deliberately
 * smaller than GameCommand: it cannot mutate the environment and may be
 * rejected or ignored by the actor policy.
 */
export interface ReasonerActionProposal {
  commandType?: string;
  targetId?: string;
  saveTargetId?: string;
  poisonTargetId?: string;
  abstain?: boolean;
  confidence?: number;
  rationale?: string;
}

export type PolicyArbitrationObjective = "suspect-werewolf" | "target-village";

export interface PolicyArbitrationCandidate {
  targetId: string;
  baseScore: number;
  socialDelta: number;
  finalScore: number;
  reasons: string[];
  evidenceRefs: EvidenceRef[];
}

export interface PolicyArbitrationSummary {
  version: "policy.social-target-arbitration.v1";
  objective: PolicyArbitrationObjective;
  selectedTargetId?: string;
  candidates: PolicyArbitrationCandidate[];
}

export interface PolicyPlan {
  policyName: PolicyName;
  command: GameCommand;
  intent: string;
  confidence: number;
  strategyTags: string[];
  targetId?: string;
  claimedRole?: Role;
  pressureTargetId?: string;
  arbitration?: PolicyArbitrationSummary;
  reasonerProposal?: ReasonerActionProposal;
  /** Deterministic actor-memory selection available to policy/reasoner before arbitration. */
  memoryRetrieval?: MemoryRetrievalRecord;
}

export interface HarnessTurnTrace {
  traceId: string;
  playerId: string;
  profileId?: string;
  model: string;
  actionKind: PendingAction["kind"];
  policyName: PolicyName;
  commandType: GameCommand["type"];
  intent: string;
  targetId?: string;
  confidence: number;
  strategyTags: string[];
  arbitration?: PolicyArbitrationSummary;
  /** Content-free record of the bounded actor memory made available this turn. */
  memoryRetrieval?: MemoryRetrievalRecord;
  beliefs: Record<string, AgentBelief>;
  privateMemo: string;
  publicSpeech?: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  providerRequestId?: string;
  attempts?: number;
  retryHistory?: ProviderRetryHistoryEntry[];
  stream?: ProviderStreamTelemetry;
  agentStateHash?: string;
}

export interface ReasonerOutputSummary {
  content: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  providerRequestId?: string;
  attempts?: number;
  retryHistory?: ProviderRetryHistoryEntry[];
  stream?: ProviderStreamTelemetry;
  actionProposal?: ReasonerActionProposal;
  actionProposalError?: string;
}

export interface HarnessStepRecord {
  traceId: string;
  turnIndex: number;
  actorId: string;
  profileId?: string;
  model: string;
  pendingAction: AgentPendingAction;
  observation: HarnessPlayerView;
  decisionStateHash?: string;
  preStateHash: string;
  policyPlan: PolicyPlan;
  reasonerOutput: ReasonerOutputSummary;
  command: GameCommand;
  turnTrace: HarnessTurnTrace;
  agentStateHash?: string;
  agentSnapshotsAfterStep?: AgentHarnessState[];
  agentSnapshotsHashAfterStep?: string;
  agentSnapshotFrameIdAfterStep?: string;
  postStateHash: string;
  eventSeqRange: [number, number];
  messageSeqRange?: [number, number];
}

export interface AgentReward {
  playerId: string;
  profileId?: string;
  model: string;
  role: Role;
  team: Team;
  won: boolean;
  reward: number;
  components: {
    win: number;
    voteAccuracy: number;
    survival: number;
    influence: number;
    deception: number;
    illegalActionPenalty: number;
  };
}

export interface AgentTrajectoryStep {
  seq: number;
  day: number;
  phase: string;
  playerId: string;
  profileId?: string;
  model: string;
  actionKind: string;
  policyName: string;
  commandType: string;
  intent: string;
  confidence: number;
  targetId?: string;
}

export interface AdversarialEvaluation {
  winner?: Team;
  teamRewards: Record<Team, number>;
  agentRewards: AgentReward[];
  voteAccuracyByAgent: Record<string, { votes: number; correct: number; accuracy: number }>;
  influenceByAgent: Record<string, { pressureCount: number; voteFollowCount: number; influenceRate: number }>;
  deceptionByAgent: Record<string, { wolfSurvivalDays: number; misdirectVotes: number; score: number }>;
  trajectory: AgentTrajectoryStep[];
}

export type HarnessMetricScope = "episode" | "team" | "agent" | "profile" | "model" | "role" | "seat";
export type HarnessMetricValue = number | string | boolean | null;
export type HarnessMetricPromotionClass = "diagnostic" | "scorecard" | "benchmark_only";

/**
 * Immutable promotion resolution recorded when an evaluation report is built.
 * Readers must prefer this over applying the currently installed catalog to an
 * historical metric. `legacy_recomputed` is reserved for old artifacts that
 * predate the stored decision contract.
 */
export interface HarnessMetricPromotionDecision {
  policyId: string;
  policyVersion: string;
  policyHash: string;
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  catalogDomainId: string;
  promotionClass: HarnessMetricPromotionClass;
  eligibleForScorecard: boolean;
  reasons: string[];
  catalogDecisionId?: string;
  resolution: "recorded" | "legacy_recomputed";
}

export interface HarnessMetricEvidenceRef {
  artifact: "trajectory" | "message" | "event" | "trace" | "observation" | "state" | "agent_state" | "metric";
  id?: string;
  seq?: number;
  traceId?: string;
  description?: string;
}

export interface HarnessMetricRecord {
  id: string;
  label: string;
  scope: HarnessMetricScope;
  subjectId?: string;
  subject?: Record<string, unknown>;
  value: HarnessMetricValue;
  unit?: string;
  higherIsBetter?: boolean;
  weight?: number;
  source: string;
  evaluatorId?: string;
  evaluatorVersion?: string;
  denominator?: number;
  confidence?: number;
  aggregation?: string;
  evidenceRefs?: HarnessMetricEvidenceRef[];
  scenario?: string;
  split?: string;
  /**
   * Compatibility projection of the final promotion class. Evaluators may set
   * this before registry normalization; normalized reports preserve that input
   * in declaredPromotionClass and materialize the final class here.
   */
  promotionClass?: HarnessMetricPromotionClass;
  /**
   * Original evaluator-declared class, retained when registry normalization
   * materializes a catalog or implicit final class into promotionClass.
   */
  declaredPromotionClass?: HarnessMetricPromotionClass;
  /**
   * Harness-materialized decision provenance. This is additive so older
   * artifacts can remain readable while new artifacts are not reclassified by
   * a future catalog implementation.
   */
  promotionDecision?: HarnessMetricPromotionDecision;
  metadata?: Record<string, unknown>;
}

export type HarnessEvaluatorMode = "deterministic" | "model_graded";
export type HarnessEvaluatorVisibility = "public" | "private" | "postgame";

export interface HarnessEvaluatorDependencies {
  judgeModel?: string;
  promptVersion?: string;
  [key: string]: unknown;
}

export interface HarnessEvaluatorManifestEntry {
  id: string;
  label: string;
  version: string;
  inputSchema: string;
  outputSchema: string;
  mode: HarnessEvaluatorMode;
  metricIds: string[];
  rubric?: string;
  dependencies: HarnessEvaluatorDependencies;
  aggregation: string;
  visibility: HarnessEvaluatorVisibility;
}

export type HarnessEvaluatorManifestConfig = Partial<Omit<HarnessEvaluatorManifestEntry, "id" | "label" | "version">>;

export interface HarnessEvaluationModuleResult<TOutput = unknown> {
  evaluatorId: string;
  label: string;
  version: string;
  manifest?: HarnessEvaluatorManifestConfig;
  metrics: HarnessMetricRecord[];
  output?: TOutput;
}

export interface HarnessEvaluationWarning {
  code: string;
  severity: "info" | "warning";
  evaluatorId?: string;
  evaluatorVersion?: string;
  metricId?: string;
  subjectId?: string;
  message: string;
  evidenceRefs?: HarnessMetricEvidenceRef[];
  metadata?: Record<string, unknown>;
}

/**
 * A controlled evaluator-module failure. This is deliberately not an Error
 * serialization: evaluator/provider exception text and stacks may contain
 * prompts, private inputs, or implementation details and must not enter a
 * replayable artifact.
 */
export interface HarnessEvaluatorFailure {
  evaluatorId: string;
  label: string;
  version: string;
  stage: "evaluate" | "result_normalization";
  code: "evaluator_exception" | "invalid_module_result";
  message: string;
}

export interface HarnessEvaluationReport {
  id: string;
  createdAt: string;
  /**
   * Evaluator coverage is independent of the environment lifecycle. Absent
   * values are interpreted as a completed legacy report with no failures.
   * Newly generated reports always materialize both fields.
   */
  status?: "completed" | "incomplete";
  failures?: HarnessEvaluatorFailure[];
  evaluatorIds: string[];
  evaluatorRegistry?: HarnessEvaluatorManifestEntry[];
  metricCount: number;
  metrics: HarnessMetricRecord[];
  outputs: Record<string, unknown>;
  warnings?: HarnessEvaluationWarning[];
  summary: {
    episodeScore?: number;
    teamScores: Record<string, number>;
    agentScores: Record<string, number>;
    profileScores: Record<string, number>;
    modelScores: Record<string, number>;
    promotion: {
      policyId: string;
      policyVersion: string;
      policyHash: string;
      catalogId: string;
      catalogVersion: string;
      catalogHash: string;
      catalogDomainId: string;
      catalogEntryCount: number;
      catalogRuleCount: number;
      catalogRuleIds: string[];
      catalogScorecardMetricIds: string[];
      catalogDiagnosticMetricIds: string[];
      catalogBenchmarkOnlyMetricIds: string[];
      scorecardMetricCount: number;
      diagnosticMetricCount: number;
      weightedMetricCount: number;
      excludedWeightedMetricCount: number;
      excludedWeightedMetricIds: string[];
      scorecardRequiresEvidence: true;
      scorecardRequiresPositiveWeight: true;
      uncatalogedMetricPolicy: "implicit_positive_weight_with_evidence" | "legacy_conservative_diagnostic";
      decisionStorage: "per_metric_recorded";
    };
  };
}
