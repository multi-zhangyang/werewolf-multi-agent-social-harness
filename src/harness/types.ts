import type { AgentBelief, GameCommand, GameState, MatchMetrics, PendingAction, PlayerView, Role, Team } from "../core/types";
import type { AgentPendingAction } from "../core/pending";
import type { ModelCompletionResult } from "../agents/modelClient";
import type { ProviderFailureKind, ProviderFailureStage, ProviderRetryHistoryEntry, ProviderStreamTelemetry } from "../agents/schema";
import type { SocialChannel, SocialEpisodeArtifact, SocialMessage } from "./social";
import type { AgentSocialState, EvidenceRef } from "./socialState";

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

export interface HarnessRunOptions {
  initialState: GameState;
  agents: HarnessAgentConfig[];
  initialAgentStates?: AgentHarnessState[];
  initialSocialMessages?: SocialMessage[];
  reasoner: HarnessReasoner;
  maxTransitions?: number;
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
  trajectory: HarnessStepRecord[];
  socialEpisode: SocialEpisodeArtifact<GameState, HarnessPlayerView, AgentPendingAction, GameCommand>;
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

export interface HarnessForkProvenance {
  checkpointId: string;
  parentRunId?: string;
  parentMatchId?: string;
  parentTraceId?: string;
  parentEvidenceTraceIds?: string[];
  parentTurnIndex?: number;
  parentStateHash: string;
  parentTrajectoryHash?: string;
  parentAgentsHash?: string;
  parentSocialMessagesHash?: string;
  parentTrajectoryLength: number;
  createdAt: string;
  reason?: string;
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
}

export type HarnessPlayerView = PlayerView & {
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

export interface ReasonerOutput {
  content: string;
  completion: ModelCompletionResult;
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

export interface HarnessMetricEvidenceRef {
  artifact: "trajectory" | "message" | "event" | "trace" | "state" | "agent_state" | "metric";
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

export interface HarnessEvaluationReport {
  id: string;
  createdAt: string;
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
  };
}
