import type { PublicGameState } from "../../core/types";
import type { PostgameMatchProjectionDto, PostgameReplayFrameDto, RedactedSocialStepDto } from "../../server/artifactProjection";
import type { HarnessRunStatus, PolicyName } from "../../harness/types";

export type Workspace = "runs" | "timeline" | "domain" | "society" | "lineage" | "evaluation" | "experiments" | "compare" | "packs";

export type ArtifactView = "postgame-redacted" | "truth-redacted";

export type ProjectedMatchArtifact = PostgameMatchProjectionDto;

/**
 * The truth-redacted comparison DTO intentionally has no canonical match ids.
 * Keep the route-owned request pair separately so the cockpit can render it
 * without asking a public response to reveal its private provenance.
 */
export interface ComparisonRequestContext {
  comparisonId: string;
  baselineId: string;
  candidateId: string;
  view: ArtifactView;
}

/**
 * The cockpit graph deliberately accepts only the server projection contract.
 * A canonical MatchArtifact is execution/replay authority, not browser input;
 * accepting it here would make a future caller accidentally rederive scoped
 * exposure evidence from private observations.
 */
export type ProjectedSocialStep = RedactedSocialStepDto;

export interface ConfigResponse {
  models?: string[];
  policyNames?: string[];
  defaultProfiles?: Array<{
    id: string;
    model: string;
    temperature?: number;
    policyName?: PolicyName;
  }>;
  provider?: {
    protocol?: string;
    configured?: boolean;
    models?: string[];
  };
  artifactExport?: {
    tournamentConfigured?: boolean;
    matrixConfigured?: boolean;
    checkpointConfigured?: boolean;
    matchConfigured?: boolean;
  };
  capabilities?: {
    operatorRegistry?: boolean;
    postgameArtifact?: boolean;
    postgameReplay?: boolean;
    checkpointCreate?: boolean;
    checkpointFork?: boolean;
    artifactExport?: {
      match?: boolean;
      tournament?: boolean;
      matrix?: boolean;
    };
  };
}

export interface MatchRecord {
  id: string;
  createdAt: string;
  state: PublicGameState;
  models: string[];
  status: "created" | "running" | "completed" | "truncated" | "failed";
  harnessStatus?: HarnessRunStatus | null;
  truncationReason?: string | null;
  error?: string;
  hasArtifact?: boolean;
  profileCount?: number;
  nativeSteps?: number;
  committedSteps?: number;
  rejectedSteps?: number;
  trajectorySteps?: number;
  legacyProjectionSteps?: number;
  checkpointCount?: number;
  summary?: unknown;
}

export interface ComparisonRegistrySummary {
  comparisonId: string;
  createdAt: string;
  view: string;
  projection?: {
    view?: string;
    privateEvidenceRedacted?: boolean;
    postgameTruthRedacted?: boolean;
  };
  baseline: {
    matchId?: string;
    runId?: string;
    seed?: string;
  };
  candidate: {
    matchId?: string;
    runId?: string;
    seed?: string;
  };
  summary: {
    rowCount: number;
    changedRowCount: number;
    numericDeltaCount?: number;
    promotionChangedMetricCount?: number;
    promotionProvenanceChangedMetricCount?: number;
    scorecardMetricDelta?: number;
    diagnosticMetricDelta?: number;
    benchmarkOnlyMetricDelta?: number;
    evidenceIdentityChangedMetricCount?: number;
    evidenceIdentityOnlyBaselineRefCount?: number;
    evidenceIdentityOnlyCandidateRefCount?: number;
    metricKeysCompared?: number;
    metricKeysEmitted?: number;
    metricKeysTruncated?: number;
    scorecardMetricKeysCompared?: number;
    scorecardMetricKeysEmitted?: number;
    scorecardMetricKeysTruncated?: number;
    diagnosticMetricKeysCompared?: number;
    diagnosticMetricKeysEmitted?: number;
    diagnosticMetricKeysTruncated?: number;
    benchmarkOnlyMetricKeysCompared?: number;
    benchmarkOnlyMetricKeysEmitted?: number;
    benchmarkOnlyMetricKeysTruncated?: number;
    metricRowsMax?: number;
    baselineSocialSteps?: number;
    candidateSocialSteps?: number;
    baselineCommittedSteps?: number;
    candidateCommittedSteps?: number;
    baselineRejectedSteps?: number;
    candidateRejectedSteps?: number;
    socialStepsDelta?: number;
    committedStepsDelta?: number;
    rejectedStepsDelta?: number;
    baselineHash: string;
    candidateHash: string;
  };
}


export interface TournamentArtifactSetSummary {
  artifactSetId: string;
  id: string;
  createdAt: string;
  experimentId: string;
  seed: string;
  files: Record<string, unknown>;
  downloads: Record<string, unknown>;
  nativeSteps?: number | null;
  committedSteps?: number | null;
  rejectedSteps?: number | null;
  metricCount?: number | null;
  scorecardEligibleMetricCount?: number | null;
  metricPromotionClassCounts?: {
    scorecard?: number;
    diagnostic?: number;
    benchmark_only?: number;
  } | null;
  scorecardEligibleMetricClassCounts?: {
    scorecard?: number;
    diagnostic?: number;
    benchmark_only?: number;
  } | null;
  projection?: {
    matchArtifactView?: "full" | "postgame-redacted" | "truth-redacted";
    assignmentTruthRedacted?: boolean;
    publicShareSafe?: boolean;
  } | null;
}

export interface TournamentComparisonAggregateView {
  artifactVersion: string;
  kind: "tournament-comparison";
  comparisonSetId: string;
  createdAt: string;
  view: string;
  tournamentSeed: string;
  experimentId?: string | null;
  gamesRequested: number;
  artifactMatchCount: number;
  pairCount: number;
  pairs: Array<{
    comparisonId: string;
    baseline: { episodeIndex: number; seed: string; runId: string; matchId?: string };
    candidate: { episodeIndex: number; seed: string; runId: string; matchId?: string };
    changedRowCount: number;
    numericDeltaCount: number;
    scorecardMetricDelta: number;
    diagnosticMetricDelta: number;
    benchmarkOnlyMetricDelta: number;
    promotionProvenanceChangedMetricCount: number;
    evidenceIdentityChangedMetricCount: number;
    baselineSocialSteps?: number;
    candidateSocialSteps?: number;
    baselineCommittedSteps?: number;
    candidateCommittedSteps?: number;
    baselineRejectedSteps?: number;
    candidateRejectedSteps?: number;
    socialStepsDelta?: number;
    committedStepsDelta?: number;
    rejectedStepsDelta?: number;
  }>;
  metricChangeFrequency: Array<{
    metricKey: string;
    label: string;
    pairCount: number;
    changedPairCount: number;
    averageAbsoluteDelta: number | null;
  }>;
  summary: {
    changedPairCount: number;
    totalChangedRows: number;
    averageChangedRows: number;
    totalScorecardMetricDelta: number;
    totalDiagnosticMetricDelta: number;
    totalBenchmarkOnlyMetricDelta: number;
    totalPromotionProvenanceChangedMetrics: number;
    totalEvidenceIdentityChangedMetrics: number;
    totalSocialStepsDelta?: number;
    totalCommittedStepsDelta?: number;
    totalRejectedStepsDelta?: number;
    pairIdentityHash: string;
  };
  projection?: {
    view: string;
    privateEvidenceRedacted: boolean;
    postgameTruthRedacted: boolean;
    generatedAt: string;
  };
}


export interface TournamentPublicShareSummary {
  shareId: string;
  id: string;
  artifactSetId: string;
  createdAt: string;
  expiresAt: string | null;
  label?: string | null;
  relativeFiles?: string[] | null;
  projection?: TournamentArtifactSetSummary["projection"];
  expired?: boolean;
  urls?: {
    detail?: string;
    filesBase?: string;
  };
  analytics?: {
    detailViewCount?: number;
    downloadCount?: number;
    downloadsByFile?: Record<string, number>;
    downloadEvents?: Array<{ at: string; file: string }>;
    detailViewEvents?: string[];
    downloadsByMinute?: Array<{ minute: string; count: number }>;
    detailViewsByMinute?: Array<{ minute: string; count: number }>;
    lastDetailViewedAt?: string | null;
    lastDownloadedAt?: string | null;
    lastDownloadedFile?: string | null;
  };
  packFound?: boolean;
  packSeed?: string | null;
  packExperimentId?: string | null;
  packCreatedAt?: string | null;
  packProjection?: TournamentArtifactSetSummary["projection"];
  packDensity?: {
    nativeSteps?: number | null;
    committedSteps?: number | null;
    rejectedSteps?: number | null;
  } | null;
}

export interface TournamentPublicShareInventory {
  count: number;
  activeCount: number;
  expiredCount: number;
  packsWithPromotionCount?: number;
  metricCount?: number;
  scorecardEligibleMetricCount?: number;
  metricPromotionClassCounts?: {
    scorecard?: number;
    diagnostic?: number;
    benchmark_only?: number;
  };
  packsWithDensityCount?: number;
  nativeSteps?: number;
  committedSteps?: number;
  rejectedSteps?: number;
  shares: TournamentPublicShareSummary[];
}

export interface TournamentExecutionAttempts {
  count: number;
  sum: number;
  max: number;
  missing: number;
  average: number;
}

export interface TournamentExecutionProviderFailures {
  count: number;
  byKind: Record<string, number>;
  byStage: Record<string, number>;
  byStatus: Record<string, number>;
  retryable: number;
  aborted: number;
  timeouts: number;
  streamAborts: number;
  attempts: TournamentExecutionAttempts;
}

export interface TournamentExecutionStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  averageLatencyMs: number;
  harnessTurns: number;
  harnessErrors: number;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  attempts: TournamentExecutionAttempts;
  providerFailures: TournamentExecutionProviderFailures;
}

export interface TournamentExecutionTelemetry {
  schemaVersion: "harness.tournament-execution-telemetry.v1";
  denominatorPolicy: {
    outcomeAggregates: string;
    executionAggregates: string;
    preparationFailures: string;
    unstartedEpisodes: string;
  };
  lifecycle: {
    episodesWithHarnessResult: number;
    completed: number;
    truncated: number;
    failed: number;
    preparationFailed: number;
    unstarted: number;
  };
  totals: TournamentExecutionStats;
  byModel: Record<string, TournamentExecutionStats>;
}

export interface TournamentRunResponse {
  summary?: {
    ok?: boolean;
    status?: "completed" | "truncated" | "partial" | "failed";
    seed?: string;
    gamesRequested?: number;
    gamesCompleted?: number;
    gamesFailed?: number;
    gamesTruncated?: number;
    gamesUnstarted?: number;
    nativeSteps?: number;
    committedSteps?: number;
    rejectedSteps?: number;
    failureReason?: string;
    executionTelemetry?: TournamentExecutionTelemetry;
    evaluation?: {
      gamesEvaluated?: number;
      gamesWithoutEvaluation?: number;
      nativeSteps?: number;
      committedSteps?: number;
      rejectedSteps?: number;
      metricCount?: number;
      scorecardEligibleMetricCount?: number;
      metricPromotionClassCounts?: {
        scorecard?: number;
        diagnostic?: number;
        benchmark_only?: number;
      };
      scorecardEligibleMetricClassCounts?: {
        scorecard?: number;
        diagnostic?: number;
        benchmark_only?: number;
      };
      modelRewards?: Record<
        string,
        {
          agentGames?: number;
          wins?: number;
          winRate?: number;
          averageReward?: number;
          nativeSteps?: number;
          committedSteps?: number;
          rejectedSteps?: number;
        }
      >;
    };
    evaluationReports?: {
      reports?: number;
      metricCount?: number;
      scorecardEligibleMetricCount?: number;
      metricPromotionClassCounts?: {
        scorecard?: number;
        diagnostic?: number;
        benchmark_only?: number;
      };
      scorecardEligibleMetricClassCounts?: {
        scorecard?: number;
        diagnostic?: number;
        benchmark_only?: number;
      };
      warningCount?: number;
      reportsWithWarnings?: number;
    };
    artifacts?: TournamentArtifactSetSummary | null;
  };
  artifacts?: TournamentArtifactSetSummary | null;
  episodes?: Array<{
    index?: number;
    seed?: string;
    runId?: string;
    matchId?: string;
    status?: string;
    hasArtifact?: boolean;
    nativeSteps?: number;
    committedSteps?: number;
    rejectedSteps?: number;
    metricCount?: number;
    scorecardEligibleMetricCount?: number;
    metricPromotionClassCounts?: {
      scorecard?: number;
      diagnostic?: number;
      benchmark_only?: number;
    };
  }>;
  error?: string;
}

export interface ExperimentMatrixSubjectStat {
  subjectType: "model" | "profile";
  subjectId: string;
  model?: string;
  profileId?: string;
  policyName?: string;
  seatGames: number;
  wins: number;
  losses: number;
  winRate: number;
  rewardCount: number;
  rewardMean: number;
}

export interface ExperimentMatrixPairwiseComparison {
  leftModel: string;
  rightModel: string;
  leftSeatGames: number;
  rightSeatGames: number;
  winRateDiff: number;
  pValueTwoSided: number | null;
  pValueHolm: number | null;
  warning: string;
}

export interface ExperimentMatrixStatisticsView {
  kind?: string;
  matrixId?: string;
  denominatorPolicy?: {
    seatLevelRows?: string;
    completedEpisodeRows?: string;
    truncatedEpisodes?: string;
    failedEpisodes?: string;
    significance?: string;
    superiorityClaims?: false;
  };
  status?: {
    cellsRequested?: number;
    cellsUnstarted?: number;
    cellsCompleted?: number;
    cellsTruncated?: number;
    cellsFailed?: number;
    gamesRequested?: number;
    gamesCompleted?: number;
    gamesTruncated?: number;
    gamesFailed?: number;
    gamesUnstarted?: number;
    completedSeatRows?: number;
  };
  modelStats?: ExperimentMatrixSubjectStat[];
  profileStats?: ExperimentMatrixSubjectStat[];
  pairwiseModelComparisons?: ExperimentMatrixPairwiseComparison[];
}

export interface ExperimentMatrixCellSummary {
  index: number;
  id: string;
  label: string;
  group: string;
  status: "completed" | "truncated" | "failed";
  elapsedMs: number;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  gamesUnstarted?: number;
  models: string[];
  profileCount?: number;
  hasArtifacts?: boolean;
  error?: string | null;
}

export interface ExperimentMatrixArtifactSetSummary {
  artifactSetId: string;
  id: string;
  createdAt: string;
  matrixId: string;
  files: Record<string, unknown>;
  downloads: Record<string, unknown>;
}

export interface ExperimentMatrixRunResponse {
  summary?: {
    ok?: boolean;
    matrixId?: string;
    status?: "completed" | "partial" | "failed";
    cellsRequested?: number;
    cellsUnstarted?: number;
    cellsCompleted?: number;
    cellsTruncated?: number;
    cellsFailed?: number;
    gamesRequested?: number;
    gamesCompleted?: number;
    gamesTruncated?: number;
    gamesFailed?: number;
    gamesUnstarted?: number;
    failureReason?: string | null;
    artifacts?: ExperimentMatrixArtifactSetSummary | null;
  };
  artifacts?: ExperimentMatrixArtifactSetSummary | null;
  cells?: ExperimentMatrixCellSummary[];
  statistics?: ExperimentMatrixStatisticsView;
  error?: string;
}

export interface ReplayResponse {
  summary?: {
    kind?: "replay";
    authority?: "native-social-episode";
    ok?: boolean;
    replayedSteps?: number;
    replayedBatches?: number;
    rejectedSteps?: number;
    nativeSteps?: number;
    committedSteps?: number;
    finalHash?: string;
    expectedFinalHash?: string;
    finalHashMatchesArtifact?: boolean;
    finalHashMatchesExpected?: boolean;
    messagesHashMatchesExpected?: boolean;
    mismatchCount?: number;
  };
  replay?: unknown;
  error?: string;
}

export interface ReplayFrameResponse {
  frame: PostgameReplayFrameDto;
}

export type ReplayFrameLoadState = "idle" | "loading" | "error";

export interface CheckpointSummary {
  kind?: "checkpoint";
  ok?: boolean;
  checkpointId: string;
  createdAt: string;
  reason?: string | null;
  source: {
    runId: string;
    matchId?: string | null;
    seed?: string;
    status?: string;
    boundaryTraceRef?: string | null;
    boundaryTurnIndex?: number | null;
    boundaryBatchId?: string | null;
    boundaryBatchIndex?: number | null;
    boundarySchedulerMode?: string | null;
    nativeStepCount: number;
    messageCount: number;
    lastMessageSeq?: number | null;
    stateHash: string;
    executionPrefixHash?: string | null;
    agentsHash?: string | null;
    channelsHash?: string | null;
    messagesHash?: string | null;
    failureReason?: string | null;
    truncationReason?: string | null;
  };
  counts: {
    agents: number;
    nativeSteps: number;
    committedSteps?: number;
    rejectedSteps?: number;
    socialMessages: number;
    channels: number;
  };
}

export interface CheckpointsResponse {
  checkpoints: CheckpointSummary[];
}

export interface CheckpointCreateResponse {
  summary: CheckpointSummary;
  artifactUrl?: string;
}

export interface CheckpointForkResponse {
  id: string;
  hasArtifact?: boolean;
  harnessStatus?: string | null;
  summary?: {
    kind?: "fork";
    ok?: boolean;
    failureReason?: string | null;
    checkpointId?: string;
    forkOf?: Record<string, unknown>;
  };
}

export interface ForkLineageSummary {
  kind?: "fork-lineage";
  schemaVersion?: string;
  ok?: boolean;
  isFork?: boolean;
  runId?: string;
  matchId?: string | null;
  forkOf?: Record<string, unknown> | null;
  parent?: Record<string, unknown> | null;
  child?: {
    runId?: string;
    matchId?: string | null;
    status?: string;
    nativeStepCount?: number;
    committedSteps?: number;
    rejectedSteps?: number;
    legacyProjectionSteps?: number;
    socialMessages?: number;
    firstStepPreStateHash?: string | null;
    finalStepPostStateHash?: string | null;
    finalStateHash?: string;
  };
  boundary?: {
    status?: string;
    checkpointFound?: boolean;
    stateHashMatches?: boolean | null;
    checkpointSourceMatchesForkOf?: boolean | null;
    messagePrefixMatchesCheckpoint?: boolean | null;
    newNativeSteps?: number;
    newCommittedSteps?: number;
    newRejectedSteps?: number;
    newSocialMessages?: number | null;
  };
}

export interface ForkLineageResponse {
  summary: ForkLineageSummary;
}

export interface BranchTreeSummary {
  kind?: "checkpoint-branch-tree";
  schemaVersion?: string;
  ok?: boolean;
  okScope?: string;
  rootCheckpointId?: string;
  counts?: {
    checkpoints?: number;
    matches?: number;
    attempts?: number;
    failedAttempts?: number;
    runningAttempts?: number;
    edges?: number;
    maxDepth?: number;
  };
  truncation?: {
    isTruncated?: boolean;
    reasons?: string[];
    omittedCheckpoints?: number;
    omittedMatches?: number;
    omittedAttempts?: number;
    omittedEdges?: number;
  };
  checkpoints?: Array<{
    depth?: number;
    checkpointId?: string;
    createdAt?: string;
    childForkCount?: number;
    artifactChildCount?: number;
    childAttemptCount?: number;
    summary?: CheckpointSummary;
  }>;
  matches?: Array<{
    depth?: number;
    parentCheckpointId?: string;
    runId?: string;
    matchId?: string | null;
    createdAt?: string;
    status?: string;
    nativeStepCount?: number;
    legacyProjectionSteps?: number;
    socialMessages?: number;
    lineage?: ForkLineageSummary;
  }>;
  attempts?: Array<{
    depth?: number;
    parentCheckpointId?: string;
    runId?: string;
    createdAt?: string;
    updatedAt?: string;
    status?: "running" | "failed";
    hasArtifact?: false;
    elapsedMs?: number | null;
    timedOut?: boolean | null;
    failureCode?: string | null;
    failureReason?: string | null;
    boundary?: {
      status?: string;
      ok?: boolean;
      checkpointFound?: boolean;
      checkpointSourceMatchesForkOf?: boolean | null;
    };
  }>;
  edges?: Array<{
    id?: string;
    kind?: string;
    fromCheckpointId?: string;
    toRunId?: string;
    fromRunId?: string;
    toCheckpointId?: string;
    ok?: boolean;
    boundaryStatus?: string;
  }>;
}

export interface BranchTreeResponse {
  summary: BranchTreeSummary;
}

export interface InspectorItem {
  kind: string;
  title: string;
  subtitle?: string;
  fields: Array<[string, unknown]>;
  json?: unknown;
  actions?: Array<{
    key: string;
    label: string;
    disabled?: boolean;
    onClick: () => void;
  }>;
}
