import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessEpisodeArtifactEnvelope } from "./episodeArtifacts";
import {
  validateGenericExperimentProvenance,
  type GenericExperimentProvenanceV1
} from "./experimentSpec";
import type {
  GenericTournamentRunSetArtifact,
  GenericTournamentRunSetEpisode
} from "./genericTournamentArtifacts";
import { validateGenericTournamentRunSetArtifact } from "./genericTournamentArtifacts";
import { hashStableJsonValue } from "./hash";
import { GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } from "./tournamentRunner";
import type { HarnessMetricRecord } from "./types";
import type { HarnessEvaluationReport } from "./types";

export const HARNESS_EXPERIMENT_RUN_RECORD_VERSION = "harness.experiment-run-record.v1";
export const HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 = "harness.experiment-run-record.v2";
export const HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 = "harness.experiment-run-record.v3";
export const HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION = "harness.experiment-run-manifest.v1";
export const HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2 = "harness.experiment-run-manifest.v2";
export const HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3 = "harness.experiment-run-manifest.v3";
export const HARNESS_EXPERIMENT_RUN_INDEX_VERSION = "harness.experiment-run-index.v1";

const RUNS_DIRECTORY = "runs";
const LOCKS_DIRECTORY = "locks";
const REVISIONS_DIRECTORY = "revisions";
const RECORD_FILE = "record.json";
const MANIFEST_FILE = "manifest.json";
const INDEX_FILE = "index.json";
const DIRECTORY_KEY_PATTERN = /^[a-f0-9]{64}$/;
// New revisions use one deterministic numeric slot so two processes cannot
// publish different candidates for the same revision. The content-addressed
// suffix remains accepted for stores created before the CAS migration.
const REVISION_DIRECTORY_PATTERN = /^(\d{12})(?:-([a-f0-9]{16}))?$/;
const RUN_LEASE_ACQUIRED_MARKER = "HARNESS_RUN_LEASE_ACQUIRED\n";

class ExperimentRevisionCasConflict extends Error {
  constructor(readonly revision: number) {
    super(`Experiment run revision ${revision} lost its canonical CAS slot.`);
    this.name = "ExperimentRevisionCasConflict";
  }
}

type GenericEpisodeEnvelope = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;

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

/**
 * Restart-safe control-plane membership authority. Episode content remains in
 * HarnessEpisodeArtifactStore; this store persists only experiment provenance,
 * ordered lifecycle membership, reviewed failure state, and content hashes.
 * Recovery never constructs an actor, policy, reasoner, or provider client.
 */
export class HarnessExperimentRunStore<TArtifact extends GenericEpisodeEnvelope> {
  private readonly root: string;
  private readonly runsDirectory: string;
  private readonly locksDirectory: string;
  private readonly episodeStore: GenericExperimentEpisodeAuthority<TArtifact>;
  private readonly now: () => string;
  private readonly entries = new Map<string, HarnessExperimentRunStoreEntry>();
  private readonly mutating = new Set<string>();

  private constructor(options: HarnessExperimentRunStoreOptions<TArtifact>) {
    if (!options.baseDirectory.trim()) throw new Error("Experiment run store baseDirectory is required.");
    if (!options.episodeStore || typeof options.episodeStore.get !== "function") {
      throw new Error("Experiment run store requires a canonical episode store.");
    }
    this.root = path.resolve(options.baseDirectory);
    this.runsDirectory = path.join(this.root, RUNS_DIRECTORY);
    this.locksDirectory = path.join(this.root, LOCKS_DIRECTORY);
    this.episodeStore = options.episodeStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  static async open<TArtifact extends GenericEpisodeEnvelope>(
    options: HarnessExperimentRunStoreOptions<TArtifact>
  ): Promise<HarnessExperimentRunStore<TArtifact>> {
    const store = new HarnessExperimentRunStore(options);
    await store.initialize();
    return store;
  }

  /**
   * Hold a kernel-released, run-scoped lease for the complete orchestration
   * lifecycle. A second live process fails closed instead of recovering work
   * that is merely slow. Linux flock releases the lease automatically after a
   * process crash; revision CAS remains the lower-level fencing boundary.
   */
  async withRunLease<TResult>(runSetId: string, operation: () => Promise<TResult>): Promise<TResult> {
    assertIdentifier(runSetId, "runSetId");
    if (typeof operation !== "function") throw new Error("Experiment run lease operation is required.");
    const lease = await this.acquireRunLease(runSetId);
    try {
      return await operation();
    } finally {
      await releaseRunLease(lease);
    }
  }

  async begin(input: {
    runSetId: string;
    experiment: GenericExperimentProvenanceV1;
    createdAt?: string;
  }): Promise<HarnessExperimentRunStoreEntry> {
    assertIdentifier(input.runSetId, "runSetId");
    const experiment = structuredClone(input.experiment);
    const provenanceErrors = validateGenericExperimentProvenance(experiment);
    if (provenanceErrors.length) throw new Error(`Experiment run provenance is invalid: ${provenanceErrors.join(" ")}`);
    if (this.entries.has(input.runSetId)) throw new Error("Experiment run already exists for this runSetId.");

    const createdAt = input.createdAt ?? this.now();
    const record: HarnessExperimentRunRecordV1 = {
      schemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION,
      kind: "experiment-run-record",
      state: "active",
      runSetId: input.runSetId,
      createdAt,
      updatedAt: createdAt,
      experiment,
      gamesRequested: experiment.spec.episodeCount,
      gamesCompleted: 0,
      gamesTruncated: 0,
      gamesFailed: 0,
      gamesUnstarted: experiment.spec.episodeCount,
      episodes: []
    };
    assertRunRecord(record);

    const directoryKey = directoryKeyForRunSetId(record.runSetId);
    const finalDirectory = path.join(this.runsDirectory, directoryKey);
    await assertPathMissing(finalDirectory, "Experiment run already exists for this runSetId.");
    const temporaryDirectory = path.join(this.runsDirectory, `.tmp-${randomUUID()}`);
    const revisionsDirectory = path.join(temporaryDirectory, REVISIONS_DIRECTORY);
    await mkdir(revisionsDirectory, { recursive: true });
    try {
      await this.writeRevision(revisionsDirectory, directoryKey, 1, record);
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
    const entry = entryFromRecord(record, directoryKey, 1);
    this.entries.set(entry.runSetId, entry);
    await this.writeIndex();
    return structuredClone(entry);
  }

  /**
   * Production experiment entrypoint. New runs use the staged v2 lifecycle;
   * exact v2/finalized retries return durable authority without creating a
   * revision. Active v1 runs are intentionally ambiguous and never resume.
   */
  async beginOrResume(input: {
    runSetId: string;
    experiment: GenericExperimentProvenanceV1;
    createdAt?: string;
  }): Promise<HarnessExperimentRunResume> {
    assertIdentifier(input.runSetId, "runSetId");
    const experiment = structuredClone(input.experiment);
    const provenanceErrors = validateGenericExperimentProvenance(experiment);
    if (provenanceErrors.length) throw new Error(`Experiment run provenance is invalid: ${provenanceErrors.join(" ")}`);
    const loaded = await this.loadKnownRun(input.runSetId);
    if (loaded) {
      if (hashStableJsonValue(loaded.record.experiment) !== hashStableJsonValue(experiment)) {
        throw new Error("Experiment run resume provenance conflicts with durable authority.");
      }
      if (input.createdAt !== undefined && input.createdAt !== loaded.record.createdAt) {
        throw new Error("Experiment run resume createdAt conflicts with durable authority.");
      }
      if (loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION && loaded.record.state === "active") {
        throw new Error("Active v1 experiment run is ambiguous and cannot be resumed automatically.");
      }
      return {
        disposition: loaded.record.state === "finalized" ? "finalized" : "active",
        record: structuredClone(loaded.record),
        revision: loaded.entry.revision
      };
    }

    const createdAt = input.createdAt ?? this.now();
    const record: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 = {
      schemaVersion: experiment.spec.retryPolicy.maxAttempts > 1
        ? HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        : HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
      kind: "experiment-run-record",
      state: "active",
      runSetId: input.runSetId,
      createdAt,
      updatedAt: createdAt,
      experiment,
      gamesRequested: experiment.spec.episodeCount,
      gamesCompleted: 0,
      gamesTruncated: 0,
      gamesFailed: 0,
      gamesInFlight: 0,
      gamesUnstarted: experiment.spec.episodeCount,
      episodes: []
    };
    assertRunRecord(record);
    const directoryKey = directoryKeyForRunSetId(record.runSetId);
    const finalDirectory = path.join(this.runsDirectory, directoryKey);
    const temporaryDirectory = path.join(this.runsDirectory, `.tmp-${randomUUID()}`);
    const revisionsDirectory = path.join(temporaryDirectory, REVISIONS_DIRECTORY);
    await mkdir(revisionsDirectory, { recursive: true });
    try {
      await this.writeRevision(revisionsDirectory, directoryKey, 1, record);
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      const winner = await this.loadKnownRun(input.runSetId);
      if (!winner) throw error;
      if (hashStableJsonValue(winner.record.experiment) !== hashStableJsonValue(experiment)) {
        throw new Error("Experiment run resume provenance conflicts with concurrently published authority.");
      }
      if (input.createdAt !== undefined && input.createdAt !== winner.record.createdAt) {
        throw new Error("Experiment run resume createdAt conflicts with concurrently published authority.");
      }
      return {
        disposition: winner.record.state === "finalized" ? "finalized" : "active",
        record: structuredClone(winner.record),
        revision: winner.entry.revision
      };
    }
    const entry = entryFromRecord(record, directoryKey, 1);
    this.entries.set(entry.runSetId, entry);
    await this.writeIndex();
    return { disposition: "created", record: structuredClone(record), revision: 1 };
  }

  async startEpisode(input: {
    runSetId: string;
    index: number;
    seed: string;
    startedAt?: string;
  }): Promise<HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3> {
    return this.mutateAttemptRecord(input.runSetId, async (loaded) => {
      const record = requireAttemptActive(loaded.record);
      const expectedIndex = record.episodes.length;
      const expectedSeed = `${record.experiment.spec.seed}:g${expectedIndex + 1}`;
      if (input.index !== expectedIndex || input.seed !== expectedSeed) {
        throw new Error("Experiment episode start does not match the next durable schedule slot.");
      }
      if (record.currentEpisode) {
        if (record.currentEpisode.index !== input.index || record.currentEpisode.seed !== input.seed) {
          throw new Error("Experiment run already has a different episode in flight.");
        }
        if (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 || record.currentEpisode.phase !== "retry-wait") {
          if (
            record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 &&
            input.startedAt !== undefined && input.startedAt !== record.currentEpisode.startedAt
          ) throw new Error("Experiment episode start retry conflicts with durable attempt time.");
          return { record, write: false };
        }
        const current = record.currentEpisode;
        const startedAt = input.startedAt ?? this.now();
        assertTimestamp(startedAt, "startedAt");
        if (Date.parse(startedAt) < Date.parse(current.eligibleAt)) {
          throw new Error("Experiment episode retry is not eligible to start yet.");
        }
        const next: HarnessExperimentRunRecordV3 = {
          ...structuredClone(record),
          updatedAt: monotonicTimestamp(startedAt, record.updatedAt),
          currentEpisode: {
            phase: "started",
            index: current.index,
            seed: current.seed,
            ordinal: current.ordinal + 1,
            attemptId: randomUUID(),
            startedAt,
            updatedAt: startedAt,
            priorAttempts: [...current.priorAttempts, {
              ordinal: current.ordinal,
              attemptId: current.attemptId,
              outcome: "retry-scheduled",
              startedAt: current.startedAt,
              completedAt: current.scheduledAt,
              code: current.code
            }]
          }
        };
        return { record: next, write: true };
      }
      if (record.gamesUnstarted <= 0) throw new Error("Experiment run has no unstarted episode slot.");
      const startedAt = input.startedAt ?? this.now();
      assertTimestamp(startedAt, "startedAt");
      const next: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 = record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? {
            ...structuredClone(record),
            updatedAt: monotonicTimestamp(startedAt, record.updatedAt),
            gamesInFlight: 1,
            gamesUnstarted: record.gamesUnstarted - 1,
            currentEpisode: {
              phase: "started",
              attemptId: randomUUID(),
              ordinal: 1,
              index: input.index,
              seed: input.seed,
              startedAt,
              updatedAt: startedAt,
              priorAttempts: []
            }
          }
        : {
        ...structuredClone(record),
        updatedAt: monotonicTimestamp(startedAt, record.updatedAt),
        gamesInFlight: 1,
        gamesUnstarted: record.gamesUnstarted - 1,
        currentEpisode: {
          phase: "started",
          attemptId: randomUUID(),
          index: input.index,
          seed: input.seed,
          startedAt,
          updatedAt: startedAt
        }
          };
      return { record: next, write: true };
    });
  }

  async scheduleEpisodeRetry(input: {
    runSetId: string;
    code: HarnessExperimentEpisodeRetryCode;
    scheduledAt?: string;
    backoffMs: number;
  }): Promise<HarnessExperimentRunRecordV3> {
    return this.mutateAttemptRecord(input.runSetId, async (loaded) => {
      const record = requireV3Active(loaded.record);
      const current = record.currentEpisode;
      if (!current) throw new Error("Experiment retry requires a durably started attempt.");
      if (current.phase === "retry-wait") {
        if (
          current.code !== input.code || current.backoffMs !== input.backoffMs ||
          (input.scheduledAt !== undefined && input.scheduledAt !== current.scheduledAt)
        ) {
          throw new Error("Experiment retry scheduling conflicts with durable authority.");
        }
        return { record, write: false };
      }
      if (current.phase !== "started") throw new Error("Only a started episode attempt may schedule a retry.");
      assertRetryCode(input.code);
      if (!Number.isSafeInteger(input.backoffMs) || input.backoffMs < 0) {
        throw new Error("Experiment retry backoffMs must be a non-negative safe integer.");
      }
      if (current.ordinal >= record.experiment.spec.retryPolicy.maxAttempts) {
        throw new Error("Experiment episode retry would exceed maxAttempts.");
      }
      const scheduledAt = input.scheduledAt ?? this.now();
      assertTimestamp(scheduledAt, "scheduledAt");
      const eligibleAt = new Date(Date.parse(scheduledAt) + input.backoffMs).toISOString();
      const next: HarnessExperimentRunRecordV3 = {
        ...structuredClone(record),
        updatedAt: monotonicTimestamp(scheduledAt, record.updatedAt),
        currentEpisode: {
          ...structuredClone(current),
          phase: "retry-wait",
          updatedAt: scheduledAt,
          code: input.code,
          scheduledAt,
          eligibleAt,
          backoffMs: input.backoffMs
        }
      };
      return { record: next, write: true };
    }) as Promise<HarnessExperimentRunRecordV3>;
  }

  async stageEpisode(input: {
    runSetId: string;
    episode: GenericTournamentRunSetEpisode<TArtifact> & { runId: string; artifact: TArtifact };
    stagedAt?: string;
  }): Promise<HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3> {
    return this.mutateAttemptRecord(input.runSetId, async (loaded) => {
      const record = requireAttemptActive(loaded.record);
      const current = record.currentEpisode;
      if (!current) throw new Error("Experiment episode must be durably started before staging publication.");
      const episode = input.episode;
      if (episode.index !== current.index || episode.seed !== current.seed || episode.runId !== episode.artifact.runId) {
        throw new Error("Experiment staged episode identity does not match the durable attempt.");
      }
      if (!episode.artifact.experiment || hashStableJsonValue(episode.artifact.experiment) !== hashStableJsonValue(record.experiment)) {
        throw new Error("Experiment staged episode provenance does not match durable authority.");
      }
      if (episode.artifact.status !== episode.status) {
        throw new Error("Experiment staged episode lifecycle does not match its artifact.");
      }
      const candidate = {
        status: episode.status,
        runId: episode.runId,
        artifactSha256: hashStableJsonValue(episode.artifact),
        ...(episode.evaluationReport ? {
          evaluationReportId: episode.evaluationReport.id,
          evaluationReportSha256: hashStableJsonValue(episode.evaluationReport)
        } : {})
      };
      if (current.phase === "staged") {
        const existing = {
          status: current.status,
          runId: current.runId,
          artifactSha256: current.artifactSha256,
          ...(current.evaluationReportId ? {
            evaluationReportId: current.evaluationReportId,
            evaluationReportSha256: current.evaluationReportSha256
          } : {})
        };
        if (hashStableJsonValue(existing) !== hashStableJsonValue(candidate)) {
          throw new Error("Experiment staged episode retry conflicts with durable candidate identity.");
        }
        return { record, write: false };
      }
      if (current.phase !== "started") {
        throw new Error("Experiment episode must be in started phase before staging publication.");
      }
      const stagedAt = input.stagedAt ?? this.now();
      assertTimestamp(stagedAt, "stagedAt");
      const commonCurrent = {
        phase: "staged" as const,
        attemptId: current.attemptId,
        index: current.index,
        seed: current.seed,
        startedAt: current.startedAt,
        updatedAt: stagedAt,
        ...candidate
      };
      const next: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 = record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? {
            ...structuredClone(record),
            updatedAt: monotonicTimestamp(stagedAt, record.updatedAt),
            currentEpisode: {
              ...commonCurrent,
              ordinal: (current as HarnessExperimentRunStartedEpisodeV3).ordinal,
              priorAttempts: structuredClone((current as HarnessExperimentRunStartedEpisodeV3).priorAttempts)
            }
          }
        : {
            ...structuredClone(record),
            updatedAt: monotonicTimestamp(stagedAt, record.updatedAt),
            currentEpisode: commonCurrent
          };
      return { record: next, write: true };
    });
  }

  async recoverCurrentEpisode(runSetId: string): Promise<HarnessExperimentRunRecovery> {
    let disposition: HarnessExperimentRunRecovery["disposition"] = "none";
    const record = await this.mutateAttemptRecord(runSetId, async (loaded) => {
      const currentRecord = requireAttemptActive(loaded.record);
      const current = currentRecord.currentEpisode;
      if (!current) return { record: currentRecord, write: false };
      if (currentRecord.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 && current.phase === "retry-wait") {
        disposition = "retry-wait";
        return { record: currentRecord, write: false };
      }
      let reference: HarnessExperimentRunEpisodeReferenceV1;
      if (current.phase === "staged") {
        const artifact = await this.episodeStore.get(current.runId);
        if (artifact) {
          const evaluationReport = await this.episodeStore.getEvaluationReport(current.runId);
          reference = await this.referenceForEpisode({
            index: current.index,
            seed: current.seed,
            status: current.status,
            runId: current.runId,
            artifact,
            ...(evaluationReport ? { evaluationReport } : {})
          }, currentRecord, new Set(currentRecord.episodes.flatMap((episode) => episode.runId ? [episode.runId] : [])));
          if (
            reference.artifactSha256 !== current.artifactSha256 ||
            reference.evaluationReportId !== current.evaluationReportId ||
            reference.evaluationReportSha256 !== current.evaluationReportSha256
          ) throw new Error("Canonical staged episode does not match durable publication identity.");
          disposition = "committed-staged-artifact";
        } else {
          reference = reviewedFailureReference(current.index, current.seed);
          disposition = "failed-staged-without-artifact";
        }
      } else {
        reference = reviewedFailureReference(current.index, current.seed);
        disposition = "failed-interrupted-start";
      }
      const durableReference = currentRecord.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? terminalReferenceV3(reference, current as HarnessExperimentRunCurrentEpisodeV3, disposition, this.now())
        : reference;
      const episodes = [...currentRecord.episodes, durableReference];
      const counts = lifecycleCountsForReferences(episodes);
      const common = {
        updatedAt: monotonicTimestamp(this.now(), currentRecord.updatedAt),
        gamesCompleted: counts.completed,
        gamesTruncated: counts.truncated,
        gamesFailed: counts.failed,
        gamesInFlight: 0 as const
      };
      const next: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 = currentRecord.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? { ...structuredClone(currentRecord), ...common, episodes: episodes as HarnessExperimentRunEpisodeReferenceV3[] }
        : { ...structuredClone(currentRecord), ...common, episodes: episodes as HarnessExperimentRunEpisodeReferenceV1[] };
      delete next.currentEpisode;
      return { record: next, write: true };
    });
    return { disposition, record };
  }

  /**
   * Append one terminal episode membership revision after its canonical
   * artifact/sidecars have been published (or after a reviewed pre-artifact
   * failure). The ordered prefix survives process restart independently of
   * final run-set materialization.
   */
  async recordEpisode(input: {
    runSetId: string;
    episode: GenericTournamentRunSetEpisode<TArtifact>;
  }): Promise<HarnessExperimentRunStoreEntry> {
    if (this.mutating.has(input.runSetId)) throw new Error("Experiment run mutation is already in progress.");
    this.mutating.add(input.runSetId);
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
      const loaded = await this.loadKnownRun(input.runSetId);
      if (!loaded) throw new Error("Experiment run must begin before an episode can be recorded.");
      const expectedIndex = loaded.record.episodes.length;
      const existingRunIds = new Set(
        loaded.record.episodes.flatMap((episode, index) =>
          index === input.episode.index || !episode.runId ? [] : [episode.runId]
        )
      );
      const baseReference = await this.referenceForEpisode(input.episode, loaded.record, existingRunIds);
      const reference = loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? loaded.record.currentEpisode
          ? terminalReferenceV3(
              baseReference,
              loaded.record.currentEpisode as HarnessExperimentRunCurrentEpisodeV3,
              input.episode.artifact ? "committed-staged-artifact" : "none",
              this.now()
            )
          : loaded.record.episodes[input.episode.index]
            ? {
                ...baseReference,
                attempts: structuredClone(loaded.record.episodes[input.episode.index]!.attempts),
                ...(loaded.record.episodes[input.episode.index]!.acceptedAttemptId
                  ? { acceptedAttemptId: loaded.record.episodes[input.episode.index]!.acceptedAttemptId }
                  : {})
              }
            : baseReference
        : baseReference;
      if (input.episode.index < expectedIndex) {
        const existing = loaded.record.episodes[input.episode.index];
        if (!existing || hashStableJsonValue(existing) !== hashStableJsonValue(reference)) {
          throw new Error("Experiment run episode retry does not match durable progress.");
        }
        return structuredClone(loaded.entry);
      }
      if (loaded.record.state !== "active") throw new Error("Finalized experiment run cannot record another episode.");
      if (input.episode.index > expectedIndex) throw new Error("Experiment run episode progress must be contiguous and ordered.");
      const episodes = [...loaded.record.episodes, reference];
      const counts = lifecycleCountsForReferences(episodes);
      let record: HarnessExperimentRunRecord;
      if (
        loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 ||
        loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
      ) {
        const current = loaded.record.currentEpisode;
        if (!current || current.index !== input.episode.index || current.seed !== input.episode.seed) {
          throw new Error("Experiment terminal episode does not match the durable in-flight attempt.");
        }
        if (input.episode.artifact) {
          if (
            current.phase !== "staged" ||
            current.runId !== reference.runId ||
            current.status !== reference.status ||
            current.artifactSha256 !== reference.artifactSha256 ||
            current.evaluationReportId !== reference.evaluationReportId ||
            current.evaluationReportSha256 !== reference.evaluationReportSha256
          ) {
            throw new Error("Experiment terminal episode does not match the staged candidate.");
          }
        } else if (current.phase !== "started") {
          throw new Error("Only a started episode may commit a pre-artifact failure.");
        }
        if (loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) {
          const next: HarnessExperimentRunRecordV3 = {
            ...structuredClone(loaded.record),
            updatedAt: monotonicTimestamp(this.now(), loaded.record.updatedAt),
            gamesCompleted: counts.completed,
            gamesTruncated: counts.truncated,
            gamesFailed: counts.failed,
            gamesInFlight: 0,
            episodes: episodes as HarnessExperimentRunEpisodeReferenceV3[]
          };
          delete next.currentEpisode;
          record = next;
        } else {
          const next: HarnessExperimentRunRecordV2 = {
            ...structuredClone(loaded.record),
            updatedAt: monotonicTimestamp(this.now(), loaded.record.updatedAt),
            gamesCompleted: counts.completed,
            gamesTruncated: counts.truncated,
            gamesFailed: counts.failed,
            gamesInFlight: 0,
            episodes: episodes as HarnessExperimentRunEpisodeReferenceV1[]
          };
          delete next.currentEpisode;
          record = next;
        }
      } else {
        record = {
          ...structuredClone(loaded.record),
          updatedAt: monotonicTimestamp(this.now(), loaded.record.updatedAt),
          gamesCompleted: counts.completed,
          gamesTruncated: counts.truncated,
          gamesFailed: counts.failed,
          gamesUnstarted: loaded.record.gamesRequested - episodes.length,
          episodes
        };
      }
      assertRunRecord(record);
      const revisionsDirectory = path.join(this.runsDirectory, loaded.entry.directoryKey, REVISIONS_DIRECTORY);
      await assertDirectoryInside(
        path.join(this.runsDirectory, loaded.entry.directoryKey),
        revisionsDirectory,
        "Experiment run revisions directory is not safe."
      );
      try {
        await this.writeRevision(revisionsDirectory, loaded.entry.directoryKey, loaded.entry.revision + 1, record);
      } catch (error) {
        if (error instanceof ExperimentRevisionCasConflict) continue;
        throw error;
      }
      const entry = entryFromRecord(record, loaded.entry.directoryKey, loaded.entry.revision + 1);
      this.entries.set(entry.runSetId, entry);
      await this.writeIndex();
      return structuredClone(entry);
      }
      throw new Error("Experiment run episode commit exceeded the revision CAS retry limit.");
    } finally {
      this.mutating.delete(input.runSetId);
    }
  }

  async finalize<TEmbeddedArtifact extends TArtifact>(
    runSet: GenericTournamentRunSetArtifact<TEmbeddedArtifact>
  ): Promise<HarnessExperimentRunStoreEntry> {
    if (this.mutating.has(runSet.runSetId)) throw new Error("Experiment run mutation is already in progress.");
    this.mutating.add(runSet.runSetId);
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
      const loaded = await this.loadKnownRun(runSet.runSetId);
      if (!loaded) throw new Error("Experiment run must begin before it can be finalized.");
      const projectedRefs = await this.referencesForRunSet(runSet, loaded.record);
      const durableV3 = loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 ? loaded.record : undefined;
      const refs: HarnessExperimentRunEpisodeReferenceV1[] = durableV3
        ? projectedRefs.map((reference, index) => ({
            ...reference,
            attempts: structuredClone(durableV3.episodes[index]!.attempts),
            ...(durableV3.episodes[index]!.acceptedAttemptId
              ? { acceptedAttemptId: durableV3.episodes[index]!.acceptedAttemptId }
              : {})
          }))
        : projectedRefs;
      assertEpisodeReferencesEqual(loaded.record.episodes, refs);
      assertFinalRunSetMatchesRecord(runSet, loaded.record);
      if (loaded.record.state === "finalized") return structuredClone(loaded.entry);
      if (
        (loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 ||
          loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) &&
        loaded.record.currentEpisode
      ) {
        throw new Error("Experiment run cannot finalize while an episode is in flight.");
      }
      const commonFinal = {
        kind: "experiment-run-record" as const,
        state: "finalized" as const,
        runSetId: loaded.record.runSetId,
        createdAt: loaded.record.createdAt,
        updatedAt: monotonicTimestamp(this.now(), loaded.record.updatedAt),
        experiment: structuredClone(loaded.record.experiment),
        gamesRequested: runSet.gamesRequested,
        gamesCompleted: runSet.gamesCompleted,
        gamesTruncated: runSet.gamesTruncated,
        gamesFailed: runSet.gamesFailed,
        gamesUnstarted: runSet.gamesUnstarted ?? runSet.gamesRequested - runSet.episodes.length,
        episodes: refs
      };
      const record: HarnessExperimentRunRecord = loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
        ? {
            schemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3,
            gamesInFlight: 0,
            ...commonFinal,
            episodes: structuredClone(loaded.record.episodes)
          }
        : loaded.record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2
          ? { schemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2, gamesInFlight: 0, ...commonFinal }
          : { schemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION, ...commonFinal };
      assertRunRecord(record);
      const revisionsDirectory = path.join(this.runsDirectory, loaded.entry.directoryKey, REVISIONS_DIRECTORY);
      await assertDirectoryInside(
        path.join(this.runsDirectory, loaded.entry.directoryKey),
        revisionsDirectory,
        "Experiment run revisions directory is not safe."
      );
      try {
        await this.writeRevision(revisionsDirectory, loaded.entry.directoryKey, loaded.entry.revision + 1, record);
      } catch (error) {
        if (error instanceof ExperimentRevisionCasConflict) continue;
        throw error;
      }
      const entry = entryFromRecord(record, loaded.entry.directoryKey, loaded.entry.revision + 1);
      this.entries.set(entry.runSetId, entry);
      await this.writeIndex();
      return structuredClone(entry);
      }
      throw new Error("Experiment run finalization exceeded the revision CAS retry limit.");
    } finally {
      this.mutating.delete(runSet.runSetId);
    }
  }

  async get(runSetId: string): Promise<HarnessExperimentRunRecord | undefined> {
    const loaded = await this.loadKnownRun(runSetId);
    return loaded ? structuredClone(loaded.record) : undefined;
  }

  async list(): Promise<HarnessExperimentRunStoreEntry[]> {
    await this.refreshEntriesFromCanonicalRuns();
    const verified: HarnessExperimentRunStoreEntry[] = [];
    for (const entry of [...this.entries.values()].sort(compareEntries)) {
      const loaded = await this.loadDirectory(entry.directoryKey, entry.runSetId);
      if (!loaded) throw new Error("Stored experiment run failed canonical recovery validation.");
      verified.push(structuredClone(loaded.entry));
    }
    return verified;
  }

  private async mutateAttemptRecord(
    runSetId: string,
    mutation: (loaded: { record: HarnessExperimentRunRecord; entry: HarnessExperimentRunStoreEntry }) =>
      Promise<{ record: HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3; write: boolean }>
  ): Promise<HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3> {
    if (this.mutating.has(runSetId)) throw new Error("Experiment run mutation is already in progress.");
    this.mutating.add(runSetId);
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const loaded = await this.loadKnownRun(runSetId);
        if (!loaded) throw new Error("Experiment run must begin before it can mutate an episode attempt.");
        const result = await mutation(loaded);
        assertRunRecord(result.record);
        if (!result.write) return structuredClone(result.record);
        const revisionsDirectory = path.join(this.runsDirectory, loaded.entry.directoryKey, REVISIONS_DIRECTORY);
        await assertDirectoryInside(
          path.join(this.runsDirectory, loaded.entry.directoryKey),
          revisionsDirectory,
          "Experiment run revisions directory is not safe."
        );
        try {
          await this.writeRevision(revisionsDirectory, loaded.entry.directoryKey, loaded.entry.revision + 1, result.record);
        } catch (error) {
          if (error instanceof ExperimentRevisionCasConflict) continue;
          throw error;
        }
        const entry = entryFromRecord(result.record, loaded.entry.directoryKey, loaded.entry.revision + 1);
        this.entries.set(entry.runSetId, entry);
        await this.writeIndex();
        return structuredClone(result.record);
      }
      throw new Error("Experiment run mutation exceeded the revision CAS retry limit.");
    } finally {
      this.mutating.delete(runSetId);
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await assertDirectory(this.root, "Experiment run store root is not a safe directory.");
    await mkdir(this.runsDirectory, { recursive: true });
    await assertDirectoryInside(this.root, this.runsDirectory, "Experiment runs directory is not safe.");
    await mkdir(this.locksDirectory, { recursive: true });
    await assertDirectoryInside(this.root, this.locksDirectory, "Experiment run locks directory is not safe.");
    await assertWritableFileTarget(path.join(this.root, INDEX_FILE), "Experiment run index is not a safe regular file.");

    await this.refreshEntriesFromCanonicalRuns();
    await this.writeIndex();
  }

  private async refreshEntriesFromCanonicalRuns(): Promise<void> {
    const recovered = new Map<string, HarnessExperimentRunStoreEntry>();
    for (const child of await readdir(this.runsDirectory, { withFileTypes: true })) {
      if (!DIRECTORY_KEY_PATTERN.test(child.name)) continue;
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new Error("Stored experiment run identity path is not a safe directory.");
      }
      const loaded = await this.loadDirectory(child.name);
      if (!loaded) throw new Error("Stored experiment run failed canonical recovery validation.");
      if (recovered.has(loaded.entry.runSetId)) throw new Error("Experiment run store contains duplicate runSetId authority.");
      recovered.set(loaded.entry.runSetId, loaded.entry);
    }
    this.entries.clear();
    for (const [runSetId, entry] of recovered) this.entries.set(runSetId, entry);
  }

  /**
   * Rebuild only the derived index projection from each canonical head. Full
   * revision-transition and episode-sidecar verification remains on open/get/
   * list. Replaying every historical revision after every mutation made the
   * write path quadratic as a long-lived server accumulated runs.
   */
  private async refreshIndexEntriesFromCanonicalHeads(): Promise<void> {
    const recovered = new Map<string, HarnessExperimentRunStoreEntry>();
    for (const child of await readdir(this.runsDirectory, { withFileTypes: true })) {
      if (!DIRECTORY_KEY_PATTERN.test(child.name)) continue;
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new Error("Stored experiment run identity path is not a safe directory.");
      }
      const runDirectory = path.join(this.runsDirectory, child.name);
      const revisionsDirectory = path.join(runDirectory, REVISIONS_DIRECTORY);
      await assertDirectoryInside(this.runsDirectory, runDirectory, "Stored experiment run directory is not safe.");
      await assertDirectoryInside(runDirectory, revisionsDirectory, "Stored experiment revisions directory is not safe.");
      const revisionEntries = (await readdir(revisionsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && REVISION_DIRECTORY_PATTERN.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      if (!revisionEntries.length) throw new Error("Stored experiment run has no canonical revision.");
      for (const [position, entry] of revisionEntries.entries()) {
        const revision = Number(REVISION_DIRECTORY_PATTERN.exec(entry.name)![1]);
        if (revision !== position + 1) throw new Error("Experiment run revisions must be contiguous and ordered.");
      }
      const latest = revisionEntries.at(-1)!;
      const revision = revisionEntries.length;
      const revisionDirectory = path.join(revisionsDirectory, latest.name);
      await assertDirectoryInside(revisionsDirectory, revisionDirectory, "Stored experiment revision directory is not safe.");
      const recordText = await readSafeFile(revisionDirectory, RECORD_FILE);
      const manifestText = await readSafeFile(revisionDirectory, MANIFEST_FILE);
      const record = JSON.parse(recordText) as HarnessExperimentRunRecord;
      const manifest = JSON.parse(manifestText) as HarnessExperimentRunManifest;
      assertRunRecord(record);
      assertManifest(manifest, record, child.name, revision, recordText, latest.name);
      if (directoryKeyForRunSetId(record.runSetId) !== child.name) {
        throw new Error("Stored experiment run directory key does not match runSetId.");
      }
      if (recovered.has(record.runSetId)) throw new Error("Experiment run store contains duplicate runSetId authority.");
      recovered.set(record.runSetId, entryFromRecord(record, child.name, revision));
    }
    this.entries.clear();
    for (const [runSetId, entry] of recovered) this.entries.set(runSetId, entry);
  }

  private async acquireRunLease(runSetId: string, nonblocking = true): Promise<ChildProcessWithoutNullStreams> {
    const directoryKey = directoryKeyForRunSetId(runSetId);
    const lockDirectory = path.join(this.locksDirectory, `${directoryKey}.lock`);
    try {
      await mkdir(lockDirectory, { recursive: false });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertDirectoryInside(this.locksDirectory, lockDirectory, "Experiment run lease path is not safe.");

    const child = spawn(
      "/usr/bin/flock",
      ["--exclusive", ...(nonblocking ? ["--nonblock"] : []), lockDirectory, "/bin/sh", "-c", `printf '${RUN_LEASE_ACQUIRED_MARKER}'; cat >/dev/null`],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    try {
      await waitForRunLease(child, runSetId);
      return child;
    } catch (error) {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      throw error;
    }
  }

  private async referencesForRunSet<TEmbeddedArtifact extends TArtifact>(
    runSet: GenericTournamentRunSetArtifact<TEmbeddedArtifact>,
    header: HarnessExperimentRunRecord
  ): Promise<HarnessExperimentRunEpisodeReferenceV1[]> {
    const errors = validateGenericTournamentRunSetArtifact(runSet);
    if (errors.length) throw new Error(`Experiment run-set is invalid: ${errors.join(" ")}`);
    if (!runSet.experiment || hashStableJsonValue(runSet.experiment) !== hashStableJsonValue(header.experiment)) {
      throw new Error("Experiment run-set provenance does not match its durable header.");
    }
    if (runSet.runSetId !== header.runSetId) throw new Error("Experiment run-set id does not match its durable header.");
    const runIds = new Set<string>();
    const refs: HarnessExperimentRunEpisodeReferenceV1[] = [];
    for (const episode of runSet.episodes) {
      refs.push(await this.referenceForEpisode(episode, header, runIds));
    }
    return refs;
  }

  private async referenceForEpisode<TEmbeddedArtifact extends TArtifact>(
    episode: GenericTournamentRunSetEpisode<TEmbeddedArtifact>,
    header: HarnessExperimentRunRecord,
    runIds: Set<string>
  ): Promise<HarnessExperimentRunEpisodeReferenceV1> {
    const expectedSeed = `${header.experiment.spec.seed}:g${episode.index + 1}`;
    if (episode.index < 0 || !Number.isInteger(episode.index) || episode.seed !== expectedSeed) {
      throw new Error("Experiment run episode ordering or seed does not match its durable schedule.");
    }
    if (!episode.artifact) {
      if (episode.status !== "failed" || episode.runId || episode.evaluationReport) {
        throw new Error("Only a reviewed pre-artifact failure may omit canonical episode content.");
      }
      return {
        index: episode.index,
        seed: episode.seed,
        status: "failed",
        metricCount: 0,
        failureCount: 0,
        error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
      };
    }
    if (!episode.runId || runIds.has(episode.runId)) {
      throw new Error("Experiment run-set episode runId must be present and unique when an artifact exists.");
    }
    runIds.add(episode.runId);
    const canonical = await this.episodeStore.get(episode.runId);
    if (!canonical) throw new Error(`Canonical episode ${episode.runId} is missing from the episode store.`);
    if (hashStableJsonValue(canonical) !== hashStableJsonValue(episode.artifact)) {
      throw new Error(`Canonical episode ${episode.runId} does not match the run-set artifact.`);
    }
    if (canonical.status !== episode.status) throw new Error(`Canonical episode ${episode.runId} lifecycle does not match the run-set.`);
    if (!canonical.experiment || hashStableJsonValue(canonical.experiment) !== hashStableJsonValue(header.experiment)) {
      throw new Error(`Canonical episode ${episode.runId} experiment does not match the run header.`);
    }
    const metrics = await this.episodeStore.getMetrics(episode.runId);
    const failures = await this.episodeStore.getFailures(episode.runId);
    const evaluationReport = await this.episodeStore.getEvaluationReport(episode.runId);
    if (!metrics || !failures) throw new Error(`Canonical episode ${episode.runId} sidecars are missing.`);
    if (
      (evaluationReport === undefined) !== (episode.evaluationReport === undefined) ||
      (evaluationReport && episode.evaluationReport &&
        hashStableJsonValue(evaluationReport) !== hashStableJsonValue(episode.evaluationReport))
    ) {
      throw new Error(`Canonical episode ${episode.runId} evaluation report does not match the run-set.`);
    }
    return {
      index: episode.index,
      seed: episode.seed,
      status: episode.status,
      runId: episode.runId,
      artifactSha256: hashStableJsonValue(canonical),
      metricCount: metrics.length,
      failureCount: failures.length,
      ...(evaluationReport ? {
        evaluationReportId: evaluationReport.id,
        evaluationReportSha256: hashStableJsonValue(evaluationReport)
      } : {}),
      ...(episode.status === "failed" ? { error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } : {})
    };
  }

  private async loadKnownRun(runSetId: string): Promise<{ record: HarnessExperimentRunRecord; entry: HarnessExperimentRunStoreEntry } | undefined> {
    assertIdentifier(runSetId, "runSetId");
    const directoryKey = directoryKeyForRunSetId(runSetId);
    try {
      const stat = await lstat(path.join(this.runsDirectory, directoryKey));
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Stored experiment run identity path is not a safe directory.");
      }
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const loaded = await this.loadDirectory(directoryKey, runSetId);
    if (!loaded) throw new Error("Stored experiment run failed canonical recovery validation.");
    this.entries.set(runSetId, loaded.entry);
    return loaded;
  }

  private async loadDirectory(
    directoryKey: string,
    expectedRunSetId?: string
  ): Promise<{ record: HarnessExperimentRunRecord; entry: HarnessExperimentRunStoreEntry } | undefined> {
    if (!DIRECTORY_KEY_PATTERN.test(directoryKey)) return undefined;
    const runDirectory = path.join(this.runsDirectory, directoryKey);
    const revisionsDirectory = path.join(runDirectory, REVISIONS_DIRECTORY);
    await assertDirectoryInside(this.runsDirectory, runDirectory, "Stored experiment run directory is not safe.");
    await assertDirectoryInside(runDirectory, revisionsDirectory, "Stored experiment revisions directory is not safe.");
    const revisionEntries = await readdir(revisionsDirectory, { withFileTypes: true });
    for (const child of revisionEntries) {
      if (REVISION_DIRECTORY_PATTERN.test(child.name) && (!child.isDirectory() || child.isSymbolicLink())) {
        throw new Error("Stored experiment revision path is not a safe directory.");
      }
    }
    const children = revisionEntries
      .filter((child) => child.isDirectory() && REVISION_DIRECTORY_PATTERN.test(child.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!children.length) throw new Error("Stored experiment run has no canonical revision.");
    let latest: { record: HarnessExperimentRunRecord; entry: HarnessExperimentRunStoreEntry } | undefined;
    let header: HarnessExperimentRunRecord | undefined;
    let previous: HarnessExperimentRunRecord | undefined;
    for (const [position, child] of children.entries()) {
      const match = REVISION_DIRECTORY_PATTERN.exec(child.name)!;
      const revision = Number(match[1]);
      if (revision !== position + 1) throw new Error("Experiment run revisions must be contiguous and ordered.");
      const revisionDirectory = path.join(revisionsDirectory, child.name);
      await assertDirectoryInside(revisionsDirectory, revisionDirectory, "Stored experiment revision directory is not safe.");
      const recordText = await readSafeFile(revisionDirectory, RECORD_FILE);
      const manifestText = await readSafeFile(revisionDirectory, MANIFEST_FILE);
      const record = JSON.parse(recordText) as HarnessExperimentRunRecord;
      const manifest = JSON.parse(manifestText) as HarnessExperimentRunManifest;
      assertRunRecord(record);
      assertManifest(manifest, record, directoryKey, revision, recordText, child.name);
      if (revision === 1) {
        if (record.state !== "active" || record.episodes.length !== 0) {
          throw new Error("First experiment run revision must be an empty active header.");
        }
        header = record;
      } else {
        if (!header || !previous) throw new Error("Experiment run revision is missing its active header.");
        if (
          record.runSetId !== header.runSetId ||
          record.createdAt !== header.createdAt ||
          record.gamesRequested !== header.gamesRequested ||
          hashStableJsonValue(record.experiment) !== hashStableJsonValue(header.experiment)
        ) {
          throw new Error("Experiment run revision changed immutable header authority.");
        }
        if (previous.state === "finalized") throw new Error("Finalized experiment run cannot have a later revision.");
        if (Date.parse(record.updatedAt) < Date.parse(previous.updatedAt)) {
          throw new Error("Experiment run revision updatedAt moved backwards.");
        }
        if (record.state === "active") assertActiveProgressTransition(previous, record);
        else {
          if (previous.schemaVersion !== record.schemaVersion) throw new Error("Experiment run finalization changed record schema version.");
          assertEpisodeReferencesEqual(previous.episodes, record.episodes);
        }
      }
      if (expectedRunSetId && record.runSetId !== expectedRunSetId) throw new Error("Stored experiment run id does not match the registry.");
      await this.assertEpisodeReferences(record);
      latest = { record, entry: entryFromRecord(record, directoryKey, revision) };
      previous = record;
    }
    if (!latest) throw new Error("Stored experiment run has no recoverable canonical revision.");
    if (directoryKeyForRunSetId(latest.record.runSetId) !== directoryKey) {
      throw new Error("Stored experiment run directory key does not match runSetId.");
    }
    return latest;
  }

  private async assertEpisodeReferences(record: HarnessExperimentRunRecord): Promise<void> {
    for (const episode of record.episodes) {
      if (!episode.runId) continue;
      const canonical = await this.episodeStore.get(episode.runId);
      const metrics = await this.episodeStore.getMetrics(episode.runId);
      const failures = await this.episodeStore.getFailures(episode.runId);
      const evaluationReport = await this.episodeStore.getEvaluationReport(episode.runId);
      if (!canonical || !metrics || !failures) throw new Error(`Stored experiment episode reference ${episode.runId} is unresolved.`);
      if (hashStableJsonValue(canonical) !== episode.artifactSha256) throw new Error(`Stored experiment episode ${episode.runId} digest mismatch.`);
      if (canonical.status !== episode.status) throw new Error(`Stored experiment episode ${episode.runId} lifecycle mismatch.`);
      if (
        !canonical.experiment ||
        hashStableJsonValue(canonical.experiment) !== hashStableJsonValue(record.experiment)
      ) {
        throw new Error(`Stored experiment episode ${episode.runId} provenance mismatch.`);
      }
      if (metrics.length !== episode.metricCount || failures.length !== episode.failureCount) {
        throw new Error(`Stored experiment episode ${episode.runId} sidecar count mismatch.`);
      }
      if (episode.evaluationReportId === undefined || episode.evaluationReportSha256 === undefined) {
        if (evaluationReport !== undefined) throw new Error(`Stored experiment episode ${episode.runId} has an unbound evaluation report.`);
      } else if (
        !evaluationReport ||
        evaluationReport.id !== episode.evaluationReportId ||
        hashStableJsonValue(evaluationReport) !== episode.evaluationReportSha256
      ) {
        throw new Error(`Stored experiment episode ${episode.runId} evaluation report mismatch.`);
      }
    }
  }

  private async writeRevision(
    revisionsDirectory: string,
    directoryKey: string,
    revision: number,
    record: HarnessExperimentRunRecord
  ): Promise<void> {
    const recordText = jsonDocument(record);
    const recordSha256 = sha256(recordText);
    const revisionName = revisionSlotDirectoryName(revision);
    const finalDirectory = path.join(revisionsDirectory, revisionName);
    const temporaryDirectory = path.join(revisionsDirectory, `.tmp-${randomUUID()}`);
    try {
      await assertPathMissing(finalDirectory, "Experiment run revision CAS slot already exists.");
      await mkdir(temporaryDirectory, { recursive: false });
      const commonManifest = {
        kind: "experiment-run-manifest" as const,
        runSetId: record.runSetId,
        directoryKey,
        revision,
        state: record.state,
        recordSha256,
        files: { record: RECORD_FILE, manifest: MANIFEST_FILE } as const
      };
      const manifest: HarnessExperimentRunManifest = record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2
        ? {
            schemaVersion: HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2,
            recordSchemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
            ...commonManifest
          }
        : record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
          ? {
              schemaVersion: HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3,
              recordSchemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3,
              ...commonManifest
            }
          : { schemaVersion: HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION, ...commonManifest };
      await writeFile(path.join(temporaryDirectory, RECORD_FILE), recordText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, MANIFEST_FILE), jsonDocument(manifest), { encoding: "utf8", flag: "wx" });
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      try {
        await lstat(finalDirectory);
        throw new ExperimentRevisionCasConflict(revision);
      } catch (publishedError) {
        if (publishedError instanceof ExperimentRevisionCasConflict) throw publishedError;
        if (!isMissing(publishedError)) throw publishedError;
      }
      throw error;
    }
  }

  private async writeIndex(): Promise<void> {
    const lease = await this.acquireRunLease("__experiment_run_index__", false);
    try {
      // index.json is a rebuildable projection. Refresh while holding one
      // global index lease so concurrent writers for different run ids cannot
      // erase one another through last-writer-wins rename.
      await this.refreshIndexEntriesFromCanonicalHeads();
      const index: HarnessExperimentRunStoreIndexV1 = {
        schemaVersion: HARNESS_EXPERIMENT_RUN_INDEX_VERSION,
        kind: "experiment-run-index",
        updatedAt: this.now(),
        entries: [...this.entries.values()].sort(compareEntries).map((entry) => structuredClone(entry))
      };
      const target = path.join(this.root, INDEX_FILE);
      await assertWritableFileTarget(target, "Experiment run index is not a safe regular file.");
      const temporary = path.join(this.root, `.index-${randomUUID()}.tmp`);
      await writeFile(temporary, jsonDocument(index), { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    } finally {
      await releaseRunLease(lease);
    }
  }
}

function assertRunRecord(record: HarnessExperimentRunRecord): void {
  assertExactKeys(record, [
    "schemaVersion", "kind", "state", "runSetId", "createdAt", "updatedAt", "experiment",
    "gamesRequested", "gamesCompleted", "gamesTruncated", "gamesFailed", "gamesInFlight", "gamesUnstarted", "episodes",
    "currentEpisode"
  ], "Experiment run record");
  if (
    (record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION &&
      record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 &&
      record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) ||
    record.kind !== "experiment-run-record"
  ) {
    throw new Error("Experiment run record version or kind is invalid.");
  }
  if (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION && ("gamesInFlight" in record || "currentEpisode" in record)) {
    throw new Error("Experiment run v1 record contains v2 lifecycle fields.");
  }
  assertIdentifier(record.runSetId, "runSetId");
  assertTimestamp(record.createdAt, "createdAt");
  assertTimestamp(record.updatedAt, "updatedAt");
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    throw new Error("Experiment run updatedAt cannot precede createdAt.");
  }
  if (record.state !== "active" && record.state !== "finalized") throw new Error("Experiment run state is invalid.");
  const provenanceErrors = validateGenericExperimentProvenance(record.experiment);
  if (provenanceErrors.length) throw new Error(`Experiment run provenance is invalid: ${provenanceErrors.join(" ")}`);
  if (
    (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 && record.experiment.spec.retryPolicy.maxAttempts !== 1) ||
    (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 && record.experiment.spec.retryPolicy.maxAttempts <= 1)
  ) throw new Error("Experiment run record schema does not match retryPolicy.maxAttempts.");
  if (!Array.isArray(record.episodes)) throw new Error("Experiment run episodes must be an array.");
  if (record.gamesRequested !== record.experiment.spec.episodeCount) throw new Error("Experiment run gamesRequested does not match provenance.");
  const counts = [record.gamesRequested, record.gamesCompleted, record.gamesTruncated, record.gamesFailed, record.gamesUnstarted];
  if (counts.some((count) => !Number.isInteger(count) || count < 0)) throw new Error("Experiment run lifecycle counts must be non-negative integers.");
  const gamesInFlight = isAttemptRecord(record) ? record.gamesInFlight : 0;
  if (record.gamesCompleted + record.gamesTruncated + record.gamesFailed + gamesInFlight + record.gamesUnstarted !== record.gamesRequested) {
    throw new Error("Experiment run lifecycle counts do not cover the requested schedule.");
  }
  if (record.episodes.length !== record.gamesRequested - record.gamesUnstarted - gamesInFlight) throw new Error("Experiment run episode count mismatch.");
  if (isAttemptRecord(record)) {
    if (!("gamesInFlight" in record)) throw new Error("Experiment run attempt record is missing gamesInFlight.");
    if (record.gamesInFlight !== 0 && record.gamesInFlight !== 1) throw new Error("Experiment run gamesInFlight is invalid.");
    if ((record.currentEpisode === undefined) !== (record.gamesInFlight === 0)) throw new Error("Experiment run in-flight count does not match currentEpisode.");
    if (record.state === "finalized" && record.currentEpisode) throw new Error("Finalized experiment run cannot retain an in-flight episode.");
    if (record.currentEpisode) {
      if (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) assertCurrentEpisodeV3(record.currentEpisode, record);
      else assertCurrentEpisodeV2(record.currentEpisode, record);
    }
  }
  const lifecycleCounts = { completed: 0, truncated: 0, failed: 0 };
  const runIds = new Set<string>();
  for (const [position, episode] of record.episodes.entries()) {
    assertExactKeys(episode, [
      "index", "seed", "status", "runId", "artifactSha256", "metricCount", "failureCount", "error"
      , "evaluationReportId", "evaluationReportSha256", "attempts", "acceptedAttemptId"
    ], `Experiment run episode ${position}`);
    if (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) {
      assertTerminalEpisodeAttemptsV3(episode as HarnessExperimentRunEpisodeReferenceV3, record, position);
    } else if ("attempts" in episode || "acceptedAttemptId" in episode) {
      throw new Error("Only an experiment run v3 episode may retain an attempt ledger.");
    }
    if (episode.index !== position || episode.seed !== `${record.experiment.spec.seed}:g${position + 1}`) {
      throw new Error("Experiment run episode ordering or seed is invalid.");
    }
    if (episode.status !== "completed" && episode.status !== "truncated" && episode.status !== "failed") {
      throw new Error("Experiment run episode lifecycle is invalid.");
    }
    if (
      !Number.isInteger(episode.metricCount) || episode.metricCount < 0 ||
      !Number.isInteger(episode.failureCount) || episode.failureCount < 0
    ) {
      throw new Error("Experiment episode sidecar counts must be non-negative integers.");
    }
    if (episode.runId) {
      assertIdentifier(episode.runId, `episodes[${position}].runId`);
      if (runIds.has(episode.runId)) throw new Error("Experiment episode runId references must be unique.");
      runIds.add(episode.runId);
      if (!episode.artifactSha256 || !DIRECTORY_KEY_PATTERN.test(episode.artifactSha256)) {
        throw new Error("Experiment episode reference is missing a valid artifact digest.");
      }
      if ((episode.evaluationReportId === undefined) !== (episode.evaluationReportSha256 === undefined)) {
        throw new Error("Experiment episode evaluation report reference is incomplete.");
      }
      if (episode.evaluationReportId !== undefined) {
        assertIdentifier(episode.evaluationReportId, `episodes[${position}].evaluationReportId`);
        if (!DIRECTORY_KEY_PATTERN.test(episode.evaluationReportSha256!)) {
          throw new Error("Experiment episode evaluation report digest is invalid.");
        }
      }
    } else {
      if (episode.status !== "failed") throw new Error("Only a failed episode may lack a canonical artifact reference.");
      if (
        episode.artifactSha256 || episode.metricCount || episode.failureCount ||
        episode.evaluationReportId || episode.evaluationReportSha256
      ) {
        throw new Error("Pre-artifact experiment failure cannot claim canonical episode sidecars.");
      }
    }
    if (episode.status === "failed") {
      if (episode.error !== GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE) {
        throw new Error("Failed experiment episode must use the reviewed failure message.");
      }
    } else if (episode.error !== undefined) {
      throw new Error("Successful experiment episode cannot carry a failure message.");
    }
    lifecycleCounts[episode.status] += 1;
  }
  if (
    lifecycleCounts.completed !== record.gamesCompleted ||
    lifecycleCounts.truncated !== record.gamesTruncated ||
    lifecycleCounts.failed !== record.gamesFailed
  ) {
    throw new Error("Experiment run lifecycle counts do not match episode references.");
  }
}

function lifecycleCountsForReferences(episodes: HarnessExperimentRunEpisodeReferenceV1[]): {
  completed: number;
  truncated: number;
  failed: number;
} {
  return {
    completed: episodes.filter((episode) => episode.status === "completed").length,
    truncated: episodes.filter((episode) => episode.status === "truncated").length,
    failed: episodes.filter((episode) => episode.status === "failed").length
  };
}

function reviewedFailureReference(index: number, seed: string): HarnessExperimentRunEpisodeReferenceV1 {
  return {
    index,
    seed,
    status: "failed",
    metricCount: 0,
    failureCount: 0,
    error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
  };
}

function terminalReferenceV3(
  reference: HarnessExperimentRunEpisodeReferenceV1,
  current: HarnessExperimentRunCurrentEpisodeV3,
  disposition: HarnessExperimentRunRecovery["disposition"],
  completedAt: string
): HarnessExperimentRunEpisodeReferenceV3 {
  if (current.phase === "retry-wait") throw new Error("A retry-wait attempt cannot become terminal implicitly.");
  const outcome: HarnessExperimentRunTerminalAttemptV3["outcome"] = disposition === "committed-staged-artifact"
    ? "artifact-committed"
    : disposition === "failed-interrupted-start"
      ? "interrupted-unknown"
      : disposition === "failed-staged-without-artifact"
        ? "staged-artifact-missing"
        : "pre-artifact-failure";
  const terminal: HarnessExperimentRunTerminalAttemptV3 = {
    ordinal: current.ordinal,
    attemptId: current.attemptId,
    outcome,
    startedAt: current.startedAt,
    completedAt: monotonicTimestamp(completedAt, current.updatedAt)
  };
  return {
    ...reference,
    attempts: [...structuredClone(current.priorAttempts), terminal],
    ...(outcome === "artifact-committed" ? { acceptedAttemptId: current.attemptId } : {})
  };
}

function isAttemptRecord(
  record: HarnessExperimentRunRecord
): record is HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 {
  return record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 ||
    record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3;
}

function requireAttemptActive(
  record: HarnessExperimentRunRecord
): HarnessExperimentRunRecordV2 | HarnessExperimentRunRecordV3 {
  if (!isAttemptRecord(record)) throw new Error("Experiment episode attempt mutation requires a v2 or v3 run record.");
  if (record.state !== "active") throw new Error("Finalized experiment run cannot mutate an episode attempt.");
  return record;
}

function requireV3Active(record: HarnessExperimentRunRecord): HarnessExperimentRunRecordV3 {
  if (record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) {
    throw new Error("Experiment episode retry mutation requires a v3 run record.");
  }
  if (record.state !== "active") throw new Error("Finalized experiment run cannot mutate an episode retry.");
  return record;
}

function assertCurrentEpisodeV2(
  current: HarnessExperimentRunCurrentEpisodeV2,
  record: HarnessExperimentRunRecordV2
): void {
  assertExactKeys(current, [
    "phase", "attemptId", "index", "seed", "startedAt", "updatedAt", "status", "runId",
    "artifactSha256", "evaluationReportId", "evaluationReportSha256"
  ], "Experiment current episode");
  if (current.phase !== "started" && current.phase !== "staged") throw new Error("Experiment current episode phase is invalid.");
  assertIdentifier(current.attemptId, "currentEpisode.attemptId");
  if (current.index !== record.episodes.length || current.seed !== `${record.experiment.spec.seed}:g${current.index + 1}`) {
    throw new Error("Experiment current episode does not match the next schedule slot.");
  }
  assertTimestamp(current.startedAt, "currentEpisode.startedAt");
  assertTimestamp(current.updatedAt, "currentEpisode.updatedAt");
  if (Date.parse(current.updatedAt) < Date.parse(current.startedAt)) throw new Error("Experiment current episode time moved backwards.");
  if (current.phase === "staged") {
    if (current.status !== "completed" && current.status !== "truncated" && current.status !== "failed") throw new Error("Experiment staged lifecycle is invalid.");
    assertIdentifier(current.runId, "currentEpisode.runId");
    if (!DIRECTORY_KEY_PATTERN.test(current.artifactSha256)) throw new Error("Experiment staged artifact digest is invalid.");
    if ((current.evaluationReportId === undefined) !== (current.evaluationReportSha256 === undefined)) throw new Error("Experiment staged evaluation reference is incomplete.");
  }
}

function assertCurrentEpisodeV3(
  current: HarnessExperimentRunCurrentEpisodeV3,
  record: HarnessExperimentRunRecordV3
): void {
  assertExactKeys(current, [
    "phase", "attemptId", "ordinal", "index", "seed", "startedAt", "updatedAt", "priorAttempts",
    "code", "scheduledAt", "eligibleAt", "backoffMs", "status", "runId", "artifactSha256",
    "evaluationReportId", "evaluationReportSha256"
  ], "Experiment current episode v3");
  if (current.phase !== "started" && current.phase !== "retry-wait" && current.phase !== "staged") {
    throw new Error("Experiment current episode v3 phase is invalid.");
  }
  assertIdentifier(current.attemptId, "currentEpisode.attemptId");
  if (current.index !== record.episodes.length || current.seed !== `${record.experiment.spec.seed}:g${current.index + 1}`) {
    throw new Error("Experiment current episode does not match the next schedule slot.");
  }
  if (!Number.isSafeInteger(current.ordinal) || current.ordinal < 1 || current.ordinal > record.experiment.spec.retryPolicy.maxAttempts) {
    throw new Error("Experiment current episode attempt ordinal is invalid.");
  }
  assertTimestamp(current.startedAt, "currentEpisode.startedAt");
  assertTimestamp(current.updatedAt, "currentEpisode.updatedAt");
  if (Date.parse(current.updatedAt) < Date.parse(current.startedAt)) throw new Error("Experiment current episode time moved backwards.");
  assertRetriedAttemptsV3(current.priorAttempts, current.ordinal - 1);
  const ids = new Set(current.priorAttempts.map((attempt) => attempt.attemptId));
  if (ids.has(current.attemptId)) throw new Error("Experiment current episode attemptId was reused.");
  if (current.phase === "retry-wait") {
    assertRetryCode(current.code);
    assertTimestamp(current.scheduledAt, "currentEpisode.scheduledAt");
    assertTimestamp(current.eligibleAt, "currentEpisode.eligibleAt");
    if (!Number.isSafeInteger(current.backoffMs) || current.backoffMs < 0) throw new Error("Experiment retry backoffMs is invalid.");
    if (current.scheduledAt !== current.updatedAt || Date.parse(current.scheduledAt) < Date.parse(current.startedAt)) {
      throw new Error("Experiment retry scheduling time is invalid.");
    }
    if (new Date(Date.parse(current.scheduledAt) + current.backoffMs).toISOString() !== current.eligibleAt) {
      throw new Error("Experiment retry eligibleAt does not match its durable backoff.");
    }
    if (current.ordinal >= record.experiment.spec.retryPolicy.maxAttempts) {
      throw new Error("Experiment retry-wait cannot exceed maxAttempts.");
    }
  }
  if (current.phase === "staged") {
    if (current.status !== "completed" && current.status !== "truncated" && current.status !== "failed") {
      throw new Error("Experiment staged lifecycle is invalid.");
    }
    assertIdentifier(current.runId, "currentEpisode.runId");
    if (!DIRECTORY_KEY_PATTERN.test(current.artifactSha256)) throw new Error("Experiment staged artifact digest is invalid.");
    if ((current.evaluationReportId === undefined) !== (current.evaluationReportSha256 === undefined)) {
      throw new Error("Experiment staged evaluation reference is incomplete.");
    }
  }
}

function assertRetriedAttemptsV3(attempts: HarnessExperimentRunRetriedAttemptV3[], expectedLength: number): void {
  if (!Array.isArray(attempts) || attempts.length !== expectedLength) {
    throw new Error("Experiment v3 retry attempt ledger length is invalid.");
  }
  const ids = new Set<string>();
  for (const [position, attempt] of attempts.entries()) {
    assertExactKeys(attempt, ["ordinal", "attemptId", "outcome", "startedAt", "completedAt", "code"], "Experiment v3 retry attempt");
    if (attempt.ordinal !== position + 1 || attempt.outcome !== "retry-scheduled") {
      throw new Error("Experiment v3 retry attempt ledger is not contiguous.");
    }
    assertIdentifier(attempt.attemptId, "attempts.attemptId");
    if (ids.has(attempt.attemptId)) throw new Error("Experiment v3 attemptId was reused.");
    ids.add(attempt.attemptId);
    assertTimestamp(attempt.startedAt, "attempts.startedAt");
    assertTimestamp(attempt.completedAt, "attempts.completedAt");
    if (Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)) throw new Error("Experiment v3 retry attempt time moved backwards.");
    assertRetryCode(attempt.code);
  }
}

function assertTerminalEpisodeAttemptsV3(
  episode: HarnessExperimentRunEpisodeReferenceV3,
  record: HarnessExperimentRunRecordV3,
  index: number
): void {
  if (!Array.isArray(episode.attempts) || episode.attempts.length < 1 || episode.attempts.length > record.experiment.spec.retryPolicy.maxAttempts) {
    throw new Error("Experiment v3 terminal attempt ledger length is invalid.");
  }
  const retried = episode.attempts.slice(0, -1) as HarnessExperimentRunRetriedAttemptV3[];
  assertRetriedAttemptsV3(retried, retried.length);
  const terminal = episode.attempts.at(-1)!;
  assertExactKeys(terminal, ["ordinal", "attemptId", "outcome", "startedAt", "completedAt"], "Experiment v3 terminal attempt");
  if (terminal.ordinal !== episode.attempts.length) throw new Error("Experiment v3 terminal attempt ordinal is not contiguous.");
  assertIdentifier(terminal.attemptId, "attempts.terminal.attemptId");
  if (retried.some((attempt) => attempt.attemptId === terminal.attemptId)) throw new Error("Experiment v3 terminal attemptId was reused.");
  if (
    terminal.outcome !== "artifact-committed" && terminal.outcome !== "pre-artifact-failure" &&
    terminal.outcome !== "interrupted-unknown" && terminal.outcome !== "staged-artifact-missing"
  ) throw new Error("Experiment v3 terminal attempt outcome is invalid.");
  assertTimestamp(terminal.startedAt, "attempts.terminal.startedAt");
  assertTimestamp(terminal.completedAt, "attempts.terminal.completedAt");
  if (Date.parse(terminal.completedAt) < Date.parse(terminal.startedAt)) throw new Error("Experiment v3 terminal attempt time moved backwards.");
  if (terminal.outcome === "artifact-committed") {
    if (!episode.runId || episode.acceptedAttemptId !== terminal.attemptId) {
      throw new Error("Experiment v3 accepted attempt does not match its canonical artifact.");
    }
  } else if (episode.acceptedAttemptId !== undefined) {
    throw new Error("Experiment v3 failed terminal attempt cannot be accepted.");
  }
  if (episode.index !== index) throw new Error("Experiment v3 terminal attempt ledger index is invalid.");
}

function assertRetryCode(code: HarnessExperimentEpisodeRetryCode): void {
  // The owning domain adapter/retry-policy version defines the closed
  // vocabulary. The generic store accepts only a bounded machine code shape,
  // never exception/provider text.
  if (typeof code !== "string" || code.length > 96 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(code)) {
    throw new Error("Experiment retry code is not a safe reviewed classifier code.");
  }
}

function assertV2Transition(previous: HarnessExperimentRunRecordV2, current: HarnessExperimentRunRecordV2): void {
  assertEpisodeReferencePrefix(previous.episodes, current.episodes);
  const previousStage = previous.currentEpisode;
  const currentStage = current.currentEpisode;
  if (!previousStage && currentStage?.phase === "started" && current.episodes.length === previous.episodes.length) return;
  if (previousStage?.phase === "started" && currentStage?.phase === "staged" && current.episodes.length === previous.episodes.length) {
    if (
      previousStage.attemptId !== currentStage.attemptId || previousStage.index !== currentStage.index ||
      previousStage.seed !== currentStage.seed || previousStage.startedAt !== currentStage.startedAt
    ) throw new Error("Experiment staged transition changed durable attempt identity.");
    return;
  }
  if (previousStage && !currentStage && current.episodes.length === previous.episodes.length + 1) return;
  throw new Error("Experiment v2 revision transition is invalid.");
}

function assertV3Transition(previous: HarnessExperimentRunRecordV3, current: HarnessExperimentRunRecordV3): void {
  assertEpisodeReferencePrefix(previous.episodes, current.episodes);
  const before = previous.currentEpisode;
  const after = current.currentEpisode;
  if (!before && after?.phase === "started" && after.ordinal === 1 && current.episodes.length === previous.episodes.length) return;
  if (before?.phase === "started" && after?.phase === "retry-wait" && current.episodes.length === previous.episodes.length) {
    assertV3CurrentIdentityStable(before, after);
    if (hashStableJsonValue(before.priorAttempts) !== hashStableJsonValue(after.priorAttempts)) {
      throw new Error("Experiment v3 retry scheduling changed prior attempt history.");
    }
    return;
  }
  if (before?.phase === "retry-wait" && after?.phase === "started" && current.episodes.length === previous.episodes.length) {
    if (before.index !== after.index || before.seed !== after.seed || after.ordinal !== before.ordinal + 1) {
      throw new Error("Experiment v3 retry start changed schedule identity or attempt ordinal.");
    }
    if (after.attemptId === before.attemptId) throw new Error("Experiment v3 retry start reused attemptId.");
    const expectedPrior: HarnessExperimentRunRetriedAttemptV3[] = [...before.priorAttempts, {
      ordinal: before.ordinal,
      attemptId: before.attemptId,
      outcome: "retry-scheduled",
      startedAt: before.startedAt,
      completedAt: before.scheduledAt,
      code: before.code
    }];
    if (hashStableJsonValue(expectedPrior) !== hashStableJsonValue(after.priorAttempts)) {
      throw new Error("Experiment v3 retry start did not append the durable prior attempt.");
    }
    return;
  }
  if (before?.phase === "started" && after?.phase === "staged" && current.episodes.length === previous.episodes.length) {
    assertV3CurrentIdentityStable(before, after);
    if (hashStableJsonValue(before.priorAttempts) !== hashStableJsonValue(after.priorAttempts)) {
      throw new Error("Experiment v3 staging changed prior attempt history.");
    }
    return;
  }
  if (before && !after && current.episodes.length === previous.episodes.length + 1) {
    if (before.phase === "retry-wait") throw new Error("Experiment v3 retry-wait cannot become terminal implicitly.");
    const terminal = current.episodes.at(-1)!;
    const expectedAttempts = [...before.priorAttempts, terminal.attempts.at(-1)!];
    if (hashStableJsonValue(expectedAttempts) !== hashStableJsonValue(terminal.attempts)) {
      throw new Error("Experiment v3 terminal commit changed attempt history.");
    }
    return;
  }
  throw new Error("Experiment v3 revision transition is invalid.");
}

function assertV3CurrentIdentityStable(
  previous: HarnessExperimentRunStartedEpisodeV3,
  current: HarnessExperimentRunRetryWaitEpisodeV3 | HarnessExperimentRunStagedEpisodeV3
): void {
  if (
    previous.attemptId !== current.attemptId || previous.ordinal !== current.ordinal ||
    previous.index !== current.index || previous.seed !== current.seed || previous.startedAt !== current.startedAt
  ) throw new Error("Experiment v3 transition changed durable attempt identity.");
}

function assertEpisodeReferencePrefix(
  prefix: HarnessExperimentRunEpisodeReferenceV1[],
  episodes: HarnessExperimentRunEpisodeReferenceV1[]
): void {
  if (prefix.length > episodes.length) throw new Error("Experiment run revision removed durable episode progress.");
  for (const [index, episode] of prefix.entries()) {
    if (hashStableJsonValue(episode) !== hashStableJsonValue(episodes[index])) {
      throw new Error("Experiment run revision changed durable episode history.");
    }
  }
}

function assertEpisodeReferencesEqual(
  expected: HarnessExperimentRunEpisodeReferenceV1[],
  actual: HarnessExperimentRunEpisodeReferenceV1[]
): void {
  if (expected.length !== actual.length) {
    throw new Error("Experiment run finalization does not match durable episode progress.");
  }
  for (const [index, episode] of expected.entries()) {
    if (hashStableJsonValue(episode) !== hashStableJsonValue(actual[index])) {
      throw new Error("Experiment run finalization changed durable episode history.");
    }
  }
}

function assertFinalRunSetMatchesRecord<TArtifact extends GenericEpisodeEnvelope>(
  runSet: GenericTournamentRunSetArtifact<TArtifact>,
  record: HarnessExperimentRunRecord
): void {
  const expectedUnstarted = runSet.gamesUnstarted ?? runSet.gamesRequested - runSet.episodes.length;
  if (
    runSet.createdAt !== record.createdAt ||
    runSet.gamesRequested !== record.gamesRequested ||
    runSet.gamesCompleted !== record.gamesCompleted ||
    runSet.gamesTruncated !== record.gamesTruncated ||
    runSet.gamesFailed !== record.gamesFailed ||
    expectedUnstarted !== record.gamesUnstarted
  ) {
    throw new Error("Experiment run finalization lifecycle does not match durable progress.");
  }
}

function monotonicTimestamp(candidate: string, previous: string): string {
  assertTimestamp(candidate, "updatedAt");
  return Date.parse(candidate) < Date.parse(previous) ? previous : candidate;
}

function assertActiveProgressTransition(
  previous: HarnessExperimentRunRecord,
  current: HarnessExperimentRunRecord
): void {
  if (previous.schemaVersion !== current.schemaVersion) throw new Error("Experiment run revision changed record schema version.");
  if (previous.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 && current.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2) {
    assertV2Transition(previous, current);
    return;
  }
  if (previous.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 && current.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) {
    assertV3Transition(previous, current);
    return;
  }
  assertEpisodeReferencePrefix(previous.episodes, current.episodes);
  if (current.episodes.length !== previous.episodes.length + 1) {
    throw new Error("Active experiment run revision must append exactly one terminal episode.");
  }
}

function assertManifest(
  manifest: HarnessExperimentRunManifest,
  record: HarnessExperimentRunRecord,
  directoryKey: string,
  revision: number,
  recordText: string,
  revisionDirectory: string
): void {
  assertExactKeys(manifest, [
    "schemaVersion", "recordSchemaVersion", "kind", "runSetId", "directoryKey", "revision", "state", "recordSha256", "files"
  ], "Experiment run manifest");
  assertExactKeys(manifest.files, ["record", "manifest"], "Experiment run manifest files");
  if (
    (manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION &&
      manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2 &&
      manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3) ||
    manifest.kind !== "experiment-run-manifest"
  ) {
    throw new Error("Experiment run manifest version or kind is invalid.");
  }
  if (
    (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 &&
      (manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V2 ||
        manifest.recordSchemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2)) ||
    (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 &&
      (manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION_V3 ||
        manifest.recordSchemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3)) ||
    (record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION &&
      (manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION || "recordSchemaVersion" in manifest))
  ) throw new Error("Experiment run manifest does not match the record schema version.");
  if (
    manifest.runSetId !== record.runSetId ||
    manifest.directoryKey !== directoryKey ||
    manifest.revision !== revision ||
    manifest.state !== record.state ||
    manifest.recordSha256 !== sha256(recordText) ||
    manifest.files.record !== RECORD_FILE ||
    manifest.files.manifest !== MANIFEST_FILE
  ) throw new Error("Experiment run manifest does not match its canonical record.");
  if (
    revisionDirectory !== revisionSlotDirectoryName(revision) &&
    revisionDirectory !== revisionDirectoryName(revision, manifest.recordSha256)
  ) {
    throw new Error("Experiment run revision directory does not match its canonical slot or content hash.");
  }
}

function entryFromRecord(record: HarnessExperimentRunRecord, directoryKey: string, revision: number): HarnessExperimentRunStoreEntry {
  return {
    runSetId: record.runSetId,
    specId: record.experiment.spec.id,
    specHash: record.experiment.specHash,
    domainId: record.experiment.spec.domainId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    directoryKey,
    revision,
    state: record.state,
    gamesRequested: record.gamesRequested,
    gamesCompleted: record.gamesCompleted,
    gamesTruncated: record.gamesTruncated,
    gamesFailed: record.gamesFailed,
    ...(isAttemptRecord(record) ? { gamesInFlight: record.gamesInFlight } : {}),
    gamesUnstarted: record.gamesUnstarted
  };
}

function revisionDirectoryName(revision: number, recordSha256: string): string {
  return `${String(revision).padStart(12, "0")}-${recordSha256.slice(0, 16)}`;
}

function revisionSlotDirectoryName(revision: number): string {
  return String(revision).padStart(12, "0");
}

function directoryKeyForRunSetId(runSetId: string): string {
  return createHash("sha256").update(runSetId).digest("hex");
}

function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} contains unsupported field ${key}.`);
  }
}

function compareEntries(a: HarnessExperimentRunStoreEntry, b: HarnessExperimentRunStoreEntry): number {
  return a.createdAt.localeCompare(b.createdAt) || a.runSetId.localeCompare(b.runSetId);
}

async function readSafeFile(directory: string, fileName: string): Promise<string> {
  const candidate = path.join(directory, fileName);
  await assertDirectory(directory, "Experiment run revision is not a safe directory.");
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Experiment run record is not a regular file.");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function assertDirectory(directory: string, message: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
}

async function assertDirectoryInside(parent: string, directory: string, message: string): Promise<void> {
  await assertDirectory(parent, message);
  await assertDirectory(directory, message);
  const parentReal = await realpath(parent);
  const directoryReal = await realpath(directory);
  if (directoryReal !== parentReal && !directoryReal.startsWith(`${parentReal}${path.sep}`)) throw new Error(message);
}

async function assertWritableFileTarget(target: string, message: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(message);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function assertPathMissing(target: string, message: string): Promise<void> {
  try {
    await lstat(target);
    throw new Error(message);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: string }).code === "EEXIST" || (error as { code?: string }).code === "ENOTEMPTY")
  );
}

async function waitForRunLease(child: ChildProcessWithoutNullStreams, runSetId: string): Promise<void> {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(RUN_LEASE_ACQUIRED_MARKER)) finish(resolve);
    };
    const onStderr = (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_024); };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(() => reject(new Error(
      code === 1
        ? `Experiment run ${runSetId} is already active in another process.`
        : `Experiment run lease failed before acquisition (code=${code}, signal=${signal}${stderr ? `, detail=${stderr.trim()}` : ""}).`
    )));
    const finish = (callback: () => void) => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function releaseRunLease(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.stdin.end();
  await exited;
}
