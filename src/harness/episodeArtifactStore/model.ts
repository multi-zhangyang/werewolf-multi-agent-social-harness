import { HarnessCheckpointEnvelope, HarnessEpisodeArtifactEnvelope, HarnessEpisodeProjectionEnvelope, HarnessEpisodeProjectionVisibility } from "../episodeArtifacts";
import { HarnessEvaluationReport, HarnessEvaluatorFailure, HarnessMetricRecord } from "../types";
export const HARNESS_EPISODE_STORE_INDEX_VERSION = "harness.episode-store-index.v2";
export const HARNESS_EPISODE_STORE_MANIFEST_VERSION = "harness.episode-store-manifest.v4";
export const HARNESS_EPISODE_EVALUATION_RECORD_VERSION = "harness.episode-evaluation.v1";
export const HARNESS_EPISODE_TRAJECTORY_HEADER_VERSION = "harness.episode-trajectory.header.v1";
export const HARNESS_EPISODE_TRAJECTORY_STEP_VERSION = "harness.episode-trajectory.step.v1";
export const HARNESS_EPISODE_TRAJECTORY_MESSAGE_VERSION = "harness.episode-trajectory.message.v1";
export const HARNESS_EPISODE_METRIC_ROW_VERSION = "harness.episode-metric.v1";
export const HARNESS_EPISODE_FAILURE_ROW_VERSION = "harness.episode-failure.v1";
export const HARNESS_EPISODE_CHECKPOINT_INDEX_VERSION = "harness.episode-checkpoint-index.v1";
export const HARNESS_EPISODE_CHECKPOINT_MANIFEST_VERSION = "harness.episode-checkpoint-manifest.v1";

export const EPISODES_DIRECTORY = "episodes";
export const LOCKS_DIRECTORY = "locks";
export const INDEX_FILE = "index.json";
export const ARTIFACT_FILE = "artifact.json";
export const MANIFEST_FILE = "manifest.json";
export const TRAJECTORY_FILE = "trajectory.jsonl";
export const METRICS_FILE = "metrics.jsonl";
export const FAILURES_FILE = "failures.jsonl";
export const EVALUATION_FILE = "evaluation-report.json";
export const PROJECTION_FILE = "projection.json";
export const CHECKPOINTS_DIRECTORY = "checkpoints";
export const CHECKPOINT_INDEX_FILE = "checkpoints.index.json";
export const CHECKPOINT_FILE = "checkpoint.json";
export const DIRECTORY_KEY_PATTERN = /^[a-f0-9]{64}$/;
export const LEGACY_EPISODE_STORE_MANIFEST_V1_VERSION = "harness.episode-store-manifest.v1";
export const LEGACY_EPISODE_STORE_MANIFEST_V2_VERSION = "harness.episode-store-manifest.v2";
export const LEGACY_EPISODE_STORE_MANIFEST_V3_VERSION = "harness.episode-store-manifest.v3";
export const STORE_LEASE_ACQUIRED_MARKER = "HARNESS_EPISODE_STORE_LEASE_ACQUIRED\n";
export const INVALID_PROJECTION = Symbol("invalid-episode-projection");

export type GenericEpisodeEnvelope = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;
export type GenericCheckpointEnvelope = HarnessCheckpointEnvelope<unknown, unknown, unknown, unknown, unknown>;

export interface CanonicalEpisodeArtifactVerification {
  ok: boolean;
  mismatches: readonly string[];
}

export type CanonicalEpisodeArtifactVerifier<TArtifact extends GenericEpisodeEnvelope> = (
  artifact: TArtifact
) => CanonicalEpisodeArtifactVerification | Promise<CanonicalEpisodeArtifactVerification>;

export type CanonicalHarnessCheckpointVerifier<TCheckpoint extends GenericCheckpointEnvelope> = (
  checkpoint: TCheckpoint
) => CanonicalEpisodeArtifactVerification | Promise<CanonicalEpisodeArtifactVerification>;

export type HarnessEpisodeMetricRow = HarnessMetricRecord & {
  schemaVersion: typeof HARNESS_EPISODE_METRIC_ROW_VERSION;
  kind: "episode-metric";
  runId: string;
  evaluationReportId: string;
};

export interface HarnessEpisodeFailureRow {
  schemaVersion: typeof HARNESS_EPISODE_FAILURE_ROW_VERSION;
  kind: "episode-failure";
  runId: string;
  source: "episode_lifecycle" | "evaluator";
  stage: "execution" | HarnessEvaluatorFailure["stage"];
  code: "episode_failed" | HarnessEvaluatorFailure["code"];
  message: string;
  evaluatorId?: string;
  evaluatorVersion?: string;
}

export interface HarnessEpisodeStorePutOptions {
  /** Optional already-normalized evaluator output; arbitrary exception text is never copied. */
  evaluationReport?: HarnessEvaluationReport;
  /** Optional derived visibility projection; never replay/checkpoint/evaluator authority. */
  projection?: HarnessEpisodeProjectionEnvelope;
}

export interface HarnessEpisodeStoreEntry {
  runId: string;
  artifactVersion: string;
  kind: string;
  createdAt: string;
  status: GenericEpisodeEnvelope["status"];
  directoryKey: string;
  nativeStepCount: number;
  messageCount: number;
  metricCount: number;
  failureCount: number;
  checkpointCount: number;
  evaluationReportId?: string;
}

export interface HarnessEpisodeEvaluationRecordV1 {
  schemaVersion: typeof HARNESS_EPISODE_EVALUATION_RECORD_VERSION;
  kind: "episode-evaluation";
  runId: string;
  artifactSha256: string;
  evaluatorSetHash: string;
  report: HarnessEvaluationReport;
}

export interface HarnessEpisodeStoreManifest extends HarnessEpisodeStoreEntry {
  schemaVersion: typeof HARNESS_EPISODE_STORE_MANIFEST_VERSION;
  manifestKind: "episode-store-manifest";
  artifactSha256: string;
  trajectorySha256: string;
  metricsSha256: string;
  failuresSha256: string;
  evaluationSha256: string;
  evaluationReportId?: string;
  projectionSha256?: string;
  projectionVisibility?: HarnessEpisodeProjectionVisibility;
  projectionPolicyId?: string;
  projectionPolicyVersion?: string;
  files: {
    artifact: typeof ARTIFACT_FILE;
    trajectory: typeof TRAJECTORY_FILE;
    metrics: typeof METRICS_FILE;
    failures: typeof FAILURES_FILE;
    evaluation: typeof EVALUATION_FILE;
    projection?: typeof PROJECTION_FILE;
    manifest: typeof MANIFEST_FILE;
    checkpointIndex: typeof CHECKPOINT_INDEX_FILE;
    checkpoints: typeof CHECKPOINTS_DIRECTORY;
  };
}

export interface HarnessEpisodeCheckpointStoreEntry {
  checkpointId: string;
  runId: string;
  artifactVersion: string;
  kind: string;
  createdAt: string;
  directoryKey: string;
  sourceArtifactVersion: string;
  nativeStepCount: number;
  messageCount: number;
}

export interface HarnessEpisodeCheckpointStoreManifest extends HarnessEpisodeCheckpointStoreEntry {
  schemaVersion: typeof HARNESS_EPISODE_CHECKPOINT_MANIFEST_VERSION;
  manifestKind: "episode-checkpoint-manifest";
  checkpointSha256: string;
  files: {
    checkpoint: typeof CHECKPOINT_FILE;
    manifest: typeof MANIFEST_FILE;
  };
}

export interface HarnessEpisodeCheckpointStoreIndex {
  schemaVersion: typeof HARNESS_EPISODE_CHECKPOINT_INDEX_VERSION;
  kind: "episode-checkpoint-index";
  runId: string;
  updatedAt: string;
  entries: HarnessEpisodeCheckpointStoreEntry[];
}

export interface HarnessEpisodeStoreIndex {
  schemaVersion: typeof HARNESS_EPISODE_STORE_INDEX_VERSION;
  kind: "episode-store-index";
  updatedAt: string;
  entries: HarnessEpisodeStoreEntry[];
}

export interface HarnessEpisodeArtifactStoreOptions<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope = GenericCheckpointEnvelope
> {
  /** Trusted server-owned root. Callers never provide child artifact paths. */
  baseDirectory: string;
  /** Canonical, model-free strong verifier supplied by the owning domain. */
  verifyArtifact: CanonicalEpisodeArtifactVerifier<TArtifact>;
  /** Required before any checkpoint can be persisted, read, listed, or recovered. */
  verifyCheckpoint?: CanonicalHarnessCheckpointVerifier<TCheckpoint>;
  now?: () => string;
}
