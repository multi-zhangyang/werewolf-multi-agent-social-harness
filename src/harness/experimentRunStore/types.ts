import type { HarnessEpisodeArtifactEnvelope } from "../episodeArtifacts";
import type { GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } from "../tournamentRunner";
import type { GenericExperimentProvenanceV1 } from "../experimentSpec";
import type { HarnessMetricRecord } from "../types";
import type { HarnessEvaluationReport } from "../types";

export const HARNESS_EXPERIMENT_RUN_RECORD_VERSION = "harness.experiment-run-record.v1";
export const HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 = "harness.experiment-run-record.v2";
export const HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 = "harness.experiment-run-record.v3";
export const HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION = "harness.experiment-run-manifest.v1";
export const HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2 = "harness.experiment-run-manifest.v2";
export const HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3 = "harness.experiment-run-manifest.v3";
export const HARNESS_EXPERIMENT_RUN_INDEX_VERSION = "harness.experiment-run-index.v1";

export const RUNS_DIRECTORY = "runs";
export const LOCKS_DIRECTORY = "locks";
export const REVISIONS_DIRECTORY = "revisions";
export const RECORD_FILE = "record.json";
export const MANIFEST_FILE = "manifest.json";
export const INDEX_FILE = "index.json";
export const DIRECTORY_KEY_PATTERN = /^[a-f0-9]{64}$/;
// New revisions use one deterministic numeric slot so two processes cannot
// publish different candidates for the same revision. The content-addressed
// suffix remains accepted for stores created before the CAS migration.
export const REVISION_DIRECTORY_PATTERN = /^(\d{12})(?:-([a-f0-9]{16}))?$/;
export const RUN_LEASE_ACQUIRED_MARKER = "HARNESS_RUN_LEASE_ACQUIRED\n";

export type GenericEpisodeEnvelope = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;

export interface GenericExperimentEpisodeAuthority<TArtifact extends GenericEpisodeEnvelope> {
  /** Must be the canonical store read path; it is expected to re-verify on every read. */
  get(runId: string): Promise<TArtifact | undefined>;
  getMetrics(runId: string): Promise<HarnessMetricRecord[] | undefined>;
  getFailures(runId: string): Promise<readonly unknown[] | undefined>;
  getEvaluationReport(runId: string): Promise<HarnessEvaluationReport | undefined>;
}

export interface HarnessExperimentRunEpisodeReferenceV1 {
  index: number;
  seed: string;
  status: "completed" | "truncated" | "failed";
  runId?: string;
  artifactSha256?: string;
  metricCount: number;
  failureCount: number;
  evaluationReportId?: string;
  evaluationReportSha256?: string;
  error?: typeof GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE;
}

/**
 * A domain classifier may persist only this reviewed, content-free vocabulary.
 * It deliberately records no exception text, provider detail, endpoint, or
 * request material.
 */
export type HarnessExperimentEpisodeRetryCode = string;

export interface HarnessExperimentRunRetriedAttemptV3 {
  ordinal: number;
  attemptId: string;
  outcome: "retry-scheduled";
  startedAt: string;
  completedAt: string;
  code: HarnessExperimentEpisodeRetryCode;
}

export interface HarnessExperimentRunTerminalAttemptV3 {
  ordinal: number;
  attemptId: string;
  outcome:
    | "artifact-committed"
    | "pre-artifact-failure"
    | "interrupted-unknown"
    | "staged-artifact-missing";
  startedAt: string;
  completedAt: string;
}

export interface HarnessExperimentRunEpisodeReferenceV3 extends HarnessExperimentRunEpisodeReferenceV1 {
  attempts: [...HarnessExperimentRunRetriedAttemptV3[], HarnessExperimentRunTerminalAttemptV3];
  acceptedAttemptId?: string;
}

export interface HarnessExperimentRunRecordV1 {
  schemaVersion: typeof HARNESS_EXPERIMENT_RUN_RECORD_VERSION;
  kind: "experiment-run-record";
  state: "active" | "finalized";
  runSetId: string;
  createdAt: string;
  updatedAt: string;
  experiment: GenericExperimentProvenanceV1;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  gamesUnstarted: number;
  episodes: HarnessExperimentRunEpisodeReferenceV1[];
}

export interface HarnessExperimentRunStartedEpisodeV2 {
  phase: "started";
  attemptId: string;
  index: number;
  seed: string;
  startedAt: string;
  updatedAt: string;
}

export interface HarnessExperimentRunStagedEpisodeV2 {
  phase: "staged";
  attemptId: string;
  index: number;
  seed: string;
  startedAt: string;
  updatedAt: string;
  status: "completed" | "truncated" | "failed";
  runId: string;
  artifactSha256: string;
  evaluationReportId?: string;
  evaluationReportSha256?: string;
}

export type HarnessExperimentRunCurrentEpisodeV2 =
  | HarnessExperimentRunStartedEpisodeV2
  | HarnessExperimentRunStagedEpisodeV2;

export interface HarnessExperimentRunRecordV2 {
  schemaVersion: typeof HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2;
  kind: "experiment-run-record";
  state: "active" | "finalized";
  runSetId: string;
  createdAt: string;
  updatedAt: string;
  experiment: GenericExperimentProvenanceV1;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  gamesInFlight: 0 | 1;
  gamesUnstarted: number;
  episodes: HarnessExperimentRunEpisodeReferenceV1[];
  currentEpisode?: HarnessExperimentRunCurrentEpisodeV2;
}

interface HarnessExperimentRunAttemptBaseV3 {
  index: number;
  seed: string;
  ordinal: number;
  attemptId: string;
  startedAt: string;
  updatedAt: string;
  priorAttempts: HarnessExperimentRunRetriedAttemptV3[];
}

export interface HarnessExperimentRunStartedEpisodeV3 extends HarnessExperimentRunAttemptBaseV3 {
  phase: "started";
}

export interface HarnessExperimentRunRetryWaitEpisodeV3 extends HarnessExperimentRunAttemptBaseV3 {
  phase: "retry-wait";
  code: HarnessExperimentEpisodeRetryCode;
  scheduledAt: string;
  eligibleAt: string;
  backoffMs: number;
}

export interface HarnessExperimentRunStagedEpisodeV3 extends HarnessExperimentRunAttemptBaseV3 {
  phase: "staged";
  status: "completed" | "truncated" | "failed";
  runId: string;
  artifactSha256: string;
  evaluationReportId?: string;
  evaluationReportSha256?: string;
}

export type HarnessExperimentRunCurrentEpisodeV3 =
  | HarnessExperimentRunStartedEpisodeV3
  | HarnessExperimentRunRetryWaitEpisodeV3
  | HarnessExperimentRunStagedEpisodeV3;

export interface HarnessExperimentRunRecordV3 {
  schemaVersion: typeof HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3;
  kind: "experiment-run-record";
  state: "active" | "finalized";
  runSetId: string;
  createdAt: string;
  updatedAt: string;
  experiment: GenericExperimentProvenanceV1;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  gamesInFlight: 0 | 1;
  gamesUnstarted: number;
  episodes: HarnessExperimentRunEpisodeReferenceV3[];
  currentEpisode?: HarnessExperimentRunCurrentEpisodeV3;
}

export type HarnessExperimentRunRecord =
  | HarnessExperimentRunRecordV1
  | HarnessExperimentRunRecordV2
  | HarnessExperimentRunRecordV3;

export interface HarnessExperimentRunResume {
  disposition: "created" | "active" | "finalized";
  record: HarnessExperimentRunRecord;
  revision: number;
}

export interface HarnessExperimentRunRecovery {
  disposition:
    | "none"
    | "retry-wait"
    | "committed-staged-artifact"
    | "failed-interrupted-start"
    | "failed-staged-without-artifact";
  record: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3;
}

export interface HarnessExperimentRunManifestV1 {
  schemaVersion: typeof HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION;
  kind: "experiment-run-manifest";
  runSetId: string;
  directoryKey: string;
  revision: number;
  state: HarnessExperimentRunRecord["state"];
  recordSha256: string;
  files: {
    record: typeof RECORD_FILE;
    manifest: typeof MANIFEST_FILE;
  };
}

export interface HarnessExperimentRunManifestV2 extends Omit<HarnessExperimentRunManifestV1, "schemaVersion"> {
  schemaVersion: typeof HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2;
  recordSchemaVersion: typeof HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2;
}

export interface HarnessExperimentRunManifestV3 extends Omit<HarnessExperimentRunManifestV1, "schemaVersion"> {
  schemaVersion: typeof HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3;
  recordSchemaVersion: typeof HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3;
}

export type HarnessExperimentRunManifest =
  | HarnessExperimentRunManifestV1
  | HarnessExperimentRunManifestV2
  | HarnessExperimentRunManifestV3;

export interface HarnessExperimentRunStoreEntry {
  runSetId: string;
  specId: string;
  specHash: string;
  domainId: string;
  createdAt: string;
  updatedAt: string;
  directoryKey: string;
  revision: number;
  state: HarnessExperimentRunRecord["state"];
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  gamesInFlight?: 0 | 1;
  gamesUnstarted: number;
}

export interface HarnessExperimentRunStoreIndexV1 {
  schemaVersion: typeof HARNESS_EXPERIMENT_RUN_INDEX_VERSION;
  kind: "experiment-run-index";
  updatedAt: string;
  entries: HarnessExperimentRunStoreEntry[];
}

export interface HarnessExperimentRunStoreOptions<TArtifact extends GenericEpisodeEnvelope> {
  /** Trusted server-owned root. Run ids and run-set ids never become paths. */
  baseDirectory: string;
  episodeStore: GenericExperimentEpisodeAuthority<TArtifact>;
  now?: () => string;
}
