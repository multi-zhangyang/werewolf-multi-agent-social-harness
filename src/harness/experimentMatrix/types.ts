import type {
  NormalizedTournamentExperiment,
  TournamentExperimentSpecV1
} from "../experiment";
import type { HarnessAssignmentConfig } from "../profiles";
import type { SocialExecutionLimits } from "../social";
import type { TournamentResult } from "../tournament";
import type { HarnessAgentProfile, HarnessReasoner, WerewolfJointPhaseScheduler } from "../types";

export const MATRIX_EXPERIMENT_VERSION = "harness.experiment-matrix.v1";
export const MATRIX_ARTIFACT_VERSION = "harness.experiment-matrix-artifact.v1";

export interface MatrixExperimentCellSpecV1 extends Partial<TournamentExperimentSpecV1> {
  id?: string;
  label?: string;
  group?: string;
  spec?: TournamentExperimentSpecV1;
}

export interface MatrixExperimentDimensionsV1 {
  models?: Array<string | string[]>;
  profiles?: Array<string | HarnessAgentProfile[]>;
  assignments?: Array<string | HarnessAssignmentConfig>;
  seeds?: string[];
  games?: Array<string | number>;
  maxTransitions?: Array<string | number>;
  jointPhaseSchedulers?: WerewolfJointPhaseScheduler[];
  temperatures?: Array<string | number>;
}

export interface MatrixExperimentSpecV1 {
  version?: typeof MATRIX_EXPERIMENT_VERSION;
  id?: string;
  kind?: "matrix";
  base?: TournamentExperimentSpecV1;
  cells?: MatrixExperimentCellSpecV1[];
  dimensions?: MatrixExperimentDimensionsV1;
  continueOnError?: boolean;
}

export interface NormalizedMatrixExperimentCell {
  id: string;
  label: string;
  group: string;
  tournament: NormalizedTournamentExperiment;
}

export interface NormalizedMatrixExperiment {
  version: typeof MATRIX_EXPERIMENT_VERSION;
  id: string;
  kind: "matrix";
  continueOnError: boolean;
  cells: NormalizedMatrixExperimentCell[];
}

export interface ExperimentMatrixRunOptions {
  experiment: NormalizedMatrixExperiment;
  reasoner: HarnessReasoner;
  executionLimits?: SocialExecutionLimits;
  includeArtifacts?: boolean;
  /** Shared server-owned V2 control-plane root. Each cell receives a stable
   * runSetId while canonical episode content remains in the generic store. */
  orchestrationBaseDirectory?: string;
}

export interface ExperimentMatrixCellResult {
  index: number;
  id: string;
  label: string;
  group: string;
  /** Aggregate lifecycle of the cell's tournament episodes. */
  status: "completed" | "truncated" | "failed";
  elapsedMs: number;
  tournament?: TournamentResult;
  error?: string;
}

export interface ExperimentMatrixResult {
  artifactVersion: typeof MATRIX_ARTIFACT_VERSION;
  kind: "experiment-matrix-result";
  experiment: NormalizedMatrixExperiment;
  createdAt: string;
  completedAt: string;
  status: "completed" | "partial" | "failed";
  cellsRequested: number;
  cellsUnstarted: number;
  cellsCompleted: number;
  cellsTruncated: number;
  cellsFailed: number;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  gamesUnstarted: number;
  cells: ExperimentMatrixCellResult[];
  statistics: ExperimentMatrixStatistics;
}

export interface ExperimentMatrixStatistics {
  artifactVersion: typeof MATRIX_ARTIFACT_VERSION;
  kind: "experiment-matrix-statistics";
  matrixId: string;
  experimentHash: string;
  denominatorPolicy: {
    seatLevelRows: string;
    completedEpisodeRows: string;
    truncatedEpisodes: string;
    failedEpisodes: string;
    significance: string;
    superiorityClaims: false;
  };
  status: {
    cellsRequested: number;
    cellsUnstarted: number;
    cellsCompleted: number;
    cellsTruncated: number;
    cellsFailed: number;
    gamesRequested: number;
    gamesCompleted: number;
    gamesTruncated: number;
    gamesFailed: number;
    gamesUnstarted: number;
    completedSeatRows: number;
  };
  modelStats: MatrixSubjectStats[];
  profileStats: MatrixSubjectStats[];
  pairwiseModelComparisons: PairwiseModelComparison[];
}

export interface MatrixSubjectStats {
  subjectType: "model" | "profile";
  subjectId: string;
  model?: string;
  profileId?: string;
  policyName?: string;
  seatGames: number;
  wins: number;
  losses: number;
  winRate: number;
  winRateWilson95: [number, number] | null;
  rewardCount: number;
  rewardMean: number;
  rewardStdDev: number | null;
  rewardStdError: number | null;
}

export interface PairwiseModelComparison {
  leftModel: string;
  rightModel: string;
  leftSeatGames: number;
  rightSeatGames: number;
  leftWinRate: number;
  rightWinRate: number;
  winRateDiff: number;
  z: number | null;
  pValueTwoSided: number | null;
  pValueHolm: number | null;
  diffNormalApprox95: [number, number] | null;
  method: "two_proportion_z_test_unpaired_seat_level";
  warning: string;
}

export interface SeatOutcomeRow {
  cellId: string;
  episodeIndex: number;
  model: string;
  profileId?: string;
  policyName?: string;
  won?: boolean;
  reward?: number;
}

export interface ExperimentMatrixArtifactWriteOptions {
  outputDir: string;
  createdAt?: string;
  overwrite?: boolean;
}

export interface ExperimentMatrixArtifactWriteResult {
  outputDir: string;
  files: {
    manifest: string;
    specNormalized: string;
    cells: string;
    statistics: string;
    summaryMarkdown: string;
    modelStatsCsv: string;
    profileStatsCsv: string;
    pairwiseModelComparisonsCsv: string;
    tournamentsDir: string;
    tournaments: Array<{
      cellId: string;
      manifest: string;
    }>;
  };
}
