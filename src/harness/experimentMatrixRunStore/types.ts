import type {
  GenericExperimentMatrixAuthoritySpecV1,
  GenericExperimentMatrixCellLifecycle
} from "../experimentMatrixRunner";

export const HARNESS_EXPERIMENT_MATRIX_RUN_RECORD_VERSION = "harness.experiment-matrix-run-record.v1";
export const HARNESS_EXPERIMENT_MATRIX_RUN_MANIFEST_VERSION = "harness.experiment-matrix-run-manifest.v1";

export const MATRICES_DIRECTORY = "matrices";
export const LOCKS_DIRECTORY = "locks";
export const REVISIONS_DIRECTORY = "revisions";
export const RECORD_FILE = "record.json";
export const MANIFEST_FILE = "manifest.json";
export const DIRECTORY_KEY_PATTERN = /^[a-f0-9]{64}$/;
export const REVISION_DIRECTORY_PATTERN = /^\d{12}$/;
export const MATRIX_LEASE_ACQUIRED_MARKER = "HARNESS_MATRIX_LEASE_ACQUIRED\n";

export interface HarnessExperimentMatrixCurrentCellV1 {
  phase: "started";
  index: number;
  id: string;
  label: string;
  group: string;
  executionId: string;
  childRunSetId: string;
  startedAt: string;
  updatedAt: string;
}

export interface HarnessExperimentMatrixCellReferenceV1 {
  index: number;
  id: string;
  label: string;
  group: string;
  executionId: string;
  status: GenericExperimentMatrixCellLifecycle;
  childRunSetId: string;
  childRunSetSha256: string;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
}

export interface HarnessExperimentMatrixRunRecordV1 {
  schemaVersion: typeof HARNESS_EXPERIMENT_MATRIX_RUN_RECORD_VERSION;
  kind: "experiment-matrix-run-record";
  state: "active" | "finalized";
  matrixId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  authorityHash: string;
  authority: GenericExperimentMatrixAuthoritySpecV1;
  cellsRequested: number;
  cellsCompleted: number;
  cellsTruncated: number;
  cellsFailed: number;
  cellsInFlight: 0 | 1;
  cellsUnstarted: number;
  cells: HarnessExperimentMatrixCellReferenceV1[];
  currentCell?: HarnessExperimentMatrixCurrentCellV1;
}

export interface HarnessExperimentMatrixRunManifestV1 {
  schemaVersion: typeof HARNESS_EXPERIMENT_MATRIX_RUN_MANIFEST_VERSION;
  kind: "experiment-matrix-run-manifest";
  matrixId: string;
  directoryKey: string;
  revision: number;
  state: HarnessExperimentMatrixRunRecordV1["state"];
  recordSha256: string;
  files: { record: typeof RECORD_FILE; manifest: typeof MANIFEST_FILE };
}

export interface HarnessExperimentMatrixRunResume {
  disposition: "created" | "active" | "finalized";
  revision: number;
  record: HarnessExperimentMatrixRunRecordV1;
}

export interface GenericExperimentMatrixFinalizedChildV1 {
  runSetId: string;
  status: GenericExperimentMatrixCellLifecycle;
  completedAt: string;
  canonicalHash: string;
}

export interface ExperimentMatrixChildRunAuthority {
  /** Returns only reviewed finalized identity; active/missing children are not adoptable. */
  getFinalized(runSetId: string): Promise<GenericExperimentMatrixFinalizedChildV1 | undefined>;
}

export interface HarnessExperimentMatrixRunStoreOptions {
  baseDirectory: string;
  childRunStore: ExperimentMatrixChildRunAuthority;
  now?: () => string;
}
