export { MATRIX_EXPERIMENT_VERSION, MATRIX_ARTIFACT_VERSION } from "./experimentMatrix/types";
export type {
  MatrixExperimentCellSpecV1,
  MatrixExperimentDimensionsV1,
  MatrixExperimentSpecV1,
  NormalizedMatrixExperimentCell,
  NormalizedMatrixExperiment,
  ExperimentMatrixRunOptions,
  ExperimentMatrixCellResult,
  ExperimentMatrixResult,
  ExperimentMatrixStatistics,
  MatrixSubjectStats,
  PairwiseModelComparison,
  ExperimentMatrixArtifactWriteOptions,
  ExperimentMatrixArtifactWriteResult
} from "./experimentMatrix/types";

export {
  normalizeMatrixExperimentSpec,
  mergeMatrixExperimentOverrides
} from "./experimentMatrix/spec";

export { runExperimentMatrix } from "./experimentMatrix/runner";

export { buildExperimentMatrixStatistics } from "./experimentMatrix/statistics";

export { writeExperimentMatrixArtifactDirectory } from "./experimentMatrix/artifacts";
