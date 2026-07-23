import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  validateHarnessEpisodeProjectionEnvelope,
  type HarnessCheckpointEnvelope,
  type HarnessEpisodeArtifactEnvelope,
  type HarnessEpisodeProjectionEnvelope,
  type HarnessEpisodeProjectionVisibility
} from "./episodeArtifacts";
import { hashStableJsonValue, hashStableState } from "./hash";
import type { HarnessEvaluationReport, HarnessEvaluatorFailure, HarnessMetricRecord } from "./types";

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

const EPISODES_DIRECTORY = "episodes";
const LOCKS_DIRECTORY = "locks";
const INDEX_FILE = "index.json";
const ARTIFACT_FILE = "artifact.json";
const MANIFEST_FILE = "manifest.json";
const TRAJECTORY_FILE = "trajectory.jsonl";
const METRICS_FILE = "metrics.jsonl";
const FAILURES_FILE = "failures.jsonl";
const EVALUATION_FILE = "evaluation-report.json";
const PROJECTION_FILE = "projection.json";
const CHECKPOINTS_DIRECTORY = "checkpoints";
const CHECKPOINT_INDEX_FILE = "checkpoints.index.json";
const CHECKPOINT_FILE = "checkpoint.json";
const DIRECTORY_KEY_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_EPISODE_STORE_MANIFEST_V1_VERSION = "harness.episode-store-manifest.v1";
const LEGACY_EPISODE_STORE_MANIFEST_V2_VERSION = "harness.episode-store-manifest.v2";
const LEGACY_EPISODE_STORE_MANIFEST_V3_VERSION = "harness.episode-store-manifest.v3";
const STORE_LEASE_ACQUIRED_MARKER = "HARNESS_EPISODE_STORE_LEASE_ACQUIRED\n";
const INVALID_PROJECTION = Symbol("invalid-episode-projection");

type GenericEpisodeEnvelope = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;
type GenericCheckpointEnvelope = HarnessCheckpointEnvelope<unknown, unknown, unknown, unknown, unknown>;

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

/**
 * Domain-neutral, single-episode persistence with a fixed server-owned layout:
 *
 *   <base>/index.json
 *   <base>/locks/store.lock
 *   <base>/episodes/<sha256(runId)>/{manifest.json,artifact.json,trajectory.jsonl}
 *
 * Neither run ids nor artifact data become paths. Every artifact is strongly
 * verified before publication and again on every read/recovery operation.
 * Canonical episode/checkpoint directories are authority; both indexes are
 * rebuildable projections serialized by a single-host kernel lease.
 */
export class HarnessEpisodeArtifactStore<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope = GenericCheckpointEnvelope
> {
  private readonly root: string;
  private readonly episodesDirectory: string;
  private readonly locksDirectory: string;
  private readonly verifyArtifact: CanonicalEpisodeArtifactVerifier<TArtifact>;
  private readonly verifyCheckpoint?: CanonicalHarnessCheckpointVerifier<TCheckpoint>;
  private readonly now: () => string;
  private readonly entries = new Map<string, HarnessEpisodeStoreEntry>();
  private readonly checkpoints = new Map<string, Map<string, HarnessEpisodeCheckpointStoreEntry>>();

  private constructor(options: HarnessEpisodeArtifactStoreOptions<TArtifact, TCheckpoint>) {
    if (!options.baseDirectory.trim()) throw new Error("Episode artifact store baseDirectory is required.");
    if (typeof options.verifyArtifact !== "function") {
      throw new Error("Episode artifact store requires a canonical artifact verifier.");
    }
    this.root = path.resolve(options.baseDirectory);
    this.episodesDirectory = path.join(this.root, EPISODES_DIRECTORY);
    this.locksDirectory = path.join(this.root, LOCKS_DIRECTORY);
    this.verifyArtifact = options.verifyArtifact;
    this.verifyCheckpoint = options.verifyCheckpoint;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  static async open<
    TArtifact extends GenericEpisodeEnvelope,
    TCheckpoint extends GenericCheckpointEnvelope = GenericCheckpointEnvelope
  >(
    options: HarnessEpisodeArtifactStoreOptions<TArtifact, TCheckpoint>
  ): Promise<HarnessEpisodeArtifactStore<TArtifact, TCheckpoint>> {
    const store = new HarnessEpisodeArtifactStore<TArtifact, TCheckpoint>(options);
    await store.initialize();
    return store;
  }

  async put(artifact: TArtifact, options: HarnessEpisodeStorePutOptions = {}): Promise<HarnessEpisodeStoreEntry> {
    const canonical = jsonClone(artifact, "Episode artifact is not JSON serializable.");
    assertArtifactIdentity(canonical);
    await this.assertCanonical(canonical);
    if (options.evaluationReport !== undefined) {
      assertJsonData(options.evaluationReport, "Episode evaluation report is not strict JSON data.");
      assertEvaluationReport(options.evaluationReport);
    }
    const evaluationReport = options.evaluationReport
      ? jsonClone(options.evaluationReport, "Episode evaluation report is not JSON serializable.")
      : undefined;
    const artifactText = jsonDocument(canonical);
    let projection: HarnessEpisodeProjectionEnvelope | undefined;
    if (options.projection !== undefined) {
      const projectionErrors = validateHarnessEpisodeProjectionEnvelope(options.projection);
      if (projectionErrors.length) throw new Error(`Episode projection is invalid: ${projectionErrors.join(" ")}`);
      projection = jsonClone(options.projection, "Episode projection is not JSON serializable.");
      if (projection.source.runId !== canonical.runId) {
        throw new Error("Episode projection source runId does not match the canonical artifact.");
      }
      if (projection.source.artifactSha256 !== sha256(artifactText)) {
        throw new Error("Episode projection source artifactSha256 does not match the canonical artifact.");
      }
    }
    const metricRows = metricRowsForArtifact(canonical, evaluationReport);
    const failureRows = failureRowsForArtifact(canonical, evaluationReport);
    const directoryKey = directoryKeyForRunId(canonical.runId);
    const trajectoryText = trajectoryJsonl(canonical);
    const metricsText = jsonLines(metricRows);
    const failuresText = jsonLines(failureRows);
    const evaluationText = evaluationRecordJson(artifact, artifactText, evaluationReport);
    const projectionText = projection ? jsonDocument(projection) : undefined;
    const manifest = manifestForArtifact(
      canonical,
      directoryKey,
      artifactText,
      trajectoryText,
      metricsText,
      failuresText,
      evaluationText,
      projection,
      projectionText,
      evaluationReport?.id
    );
    return this.withStoreLease(() => this.putUnderLease({
      canonical,
      evaluationReport,
      projection,
      metricRows,
      failureRows,
      directoryKey,
      artifactText,
      trajectoryText,
      metricsText,
      failuresText,
      evaluationText,
      projectionText,
      manifest
    }));
  }

  private async putUnderLease(prepared: {
    canonical: TArtifact;
    evaluationReport?: HarnessEvaluationReport;
    projection?: HarnessEpisodeProjectionEnvelope;
    metricRows: HarnessEpisodeMetricRow[];
    failureRows: HarnessEpisodeFailureRow[];
    directoryKey: string;
    artifactText: string;
    trajectoryText: string;
    metricsText: string;
    failuresText: string;
    evaluationText: string;
    projectionText?: string;
    manifest: HarnessEpisodeStoreManifest;
  }): Promise<HarnessEpisodeStoreEntry> {
    const {
      canonical,
      evaluationReport,
      projection,
      metricRows,
      failureRows,
      directoryKey,
      artifactText,
      trajectoryText,
      metricsText,
      failuresText,
      evaluationText,
      projectionText,
      manifest
    } = prepared;
    const finalDirectory = path.join(this.episodesDirectory, directoryKey);
    const existing = await this.loadDirectory(directoryKey, canonical.runId, false);
    if (existing) {
      return this.acceptExactEpisodeRetry(existing, canonical, metricRows, failureRows, evaluationReport, projection);
    }
    await assertPathMissing(finalDirectory, "Episode artifact already exists for this run id.");

    const temporaryDirectory = path.join(this.episodesDirectory, `.tmp-${randomUUID()}`);
    await mkdir(temporaryDirectory, { recursive: false });
    try {
      await assertDirectoryInside(this.episodesDirectory, temporaryDirectory, "Episode artifact staging directory is not safe.");
      await writeFile(path.join(temporaryDirectory, ARTIFACT_FILE), artifactText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, TRAJECTORY_FILE), trajectoryText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, METRICS_FILE), metricsText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, FAILURES_FILE), failuresText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, EVALUATION_FILE), evaluationText, { encoding: "utf8", flag: "wx" });
      if (projectionText !== undefined) {
        await writeFile(path.join(temporaryDirectory, PROJECTION_FILE), projectionText, { encoding: "utf8", flag: "wx" });
      }
      await mkdir(path.join(temporaryDirectory, CHECKPOINTS_DIRECTORY), { recursive: false });
      await writeFile(
        path.join(temporaryDirectory, CHECKPOINT_INDEX_FILE),
        jsonDocument(emptyCheckpointIndex(canonical.runId, this.now())),
        { encoding: "utf8", flag: "wx" }
      );
      await writeFile(path.join(temporaryDirectory, MANIFEST_FILE), jsonDocument(manifest), { encoding: "utf8", flag: "wx" });
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      // Another writer may have atomically published the same immutable run
      // id after our preflight. Re-read canonical authority and accept only an
      // exact content match; never overwrite or merge drift.
      const concurrentlyPublished = await this.loadDirectory(directoryKey, canonical.runId, false);
      if (concurrentlyPublished) {
        return this.acceptExactEpisodeRetry(
          concurrentlyPublished,
          canonical,
          metricRows,
          failureRows,
          evaluationReport,
          projection
        );
      }
      throw error;
    }

    const entry = entryFromManifest(manifest);
    this.entries.set(entry.runId, entry);
    this.checkpoints.set(entry.runId, new Map());
    await this.writeIndex(true, [entry.runId]);
    return cloneEntry(entry);
  }

  private async acceptExactEpisodeRetry(
    existing: {
      artifact: TArtifact;
      entry: HarnessEpisodeStoreEntry;
      metrics: HarnessEpisodeMetricRow[];
      failures: HarnessEpisodeFailureRow[];
      evaluationReport?: HarnessEvaluationReport;
      projection?: HarnessEpisodeProjectionEnvelope;
    },
    artifact: TArtifact,
    metrics: HarnessEpisodeMetricRow[],
    failures: HarnessEpisodeFailureRow[],
    evaluationReport?: HarnessEvaluationReport,
    projection?: HarnessEpisodeProjectionEnvelope
  ): Promise<HarnessEpisodeStoreEntry> {
    if (
      hashStableJsonValue(existing.artifact) !== hashStableJsonValue(artifact) ||
      hashStableJsonValue(existing.metrics) !== hashStableJsonValue(metrics) ||
      hashStableJsonValue(existing.failures) !== hashStableJsonValue(failures) ||
      (existing.evaluationReport === undefined) !== (evaluationReport === undefined) ||
      (existing.evaluationReport !== undefined && evaluationReport !== undefined &&
        hashStableJsonValue(existing.evaluationReport) !== hashStableJsonValue(evaluationReport)) ||
      (existing.projection === undefined) !== (projection === undefined) ||
      (existing.projection !== undefined && projection !== undefined &&
        hashStableJsonValue(existing.projection) !== hashStableJsonValue(projection))
    ) {
      throw new Error("Episode artifact run id already exists with different immutable content.");
    }
    const checkpoints = await this.recoverCheckpointRegistry(
      existing.entry.directoryKey,
      existing.artifact,
      false
    );
    const entry = { ...existing.entry, checkpointCount: checkpoints.size };
    this.entries.set(entry.runId, entry);
    this.checkpoints.set(entry.runId, checkpoints);
    await this.writeIndex(true, [entry.runId]);
    return cloneEntry(entry);
  }

  async get(runId: string): Promise<TArtifact | undefined> {
    const loaded = await this.loadKnownEpisode(runId);
    if (!loaded) return undefined;
    return jsonClone(loaded.artifact, "Stored episode artifact could not be cloned.");
  }

  async getProjection(runId: string): Promise<HarnessEpisodeProjectionEnvelope | undefined> {
    const loaded = await this.loadKnownEpisode(runId);
    return loaded?.projection
      ? jsonClone(loaded.projection, "Stored episode projection could not be cloned.")
      : undefined;
  }

  async list(): Promise<HarnessEpisodeStoreEntry[]> {
    await this.refreshEntriesFromCanonicalEpisodes();
    const verified: HarnessEpisodeStoreEntry[] = [];
    for (const entry of [...this.entries.values()].sort(compareEntries)) {
      const loaded = await this.loadDirectory(entry.directoryKey, entry.runId);
      if (!loaded) throw new Error("Stored episode artifact failed canonical recovery validation.");
      verified.push(cloneEntry({
        ...loaded.entry,
        checkpointCount: this.checkpoints.get(entry.runId)?.size ?? 0
      }));
    }
    return verified;
  }

  async getMetrics(runId: string): Promise<HarnessMetricRecord[] | undefined> {
    const loaded = await this.loadKnownEpisode(runId);
    return loaded?.metrics.map(metricFromRow);
  }

  async getFailures(runId: string): Promise<HarnessEpisodeFailureRow[] | undefined> {
    const loaded = await this.loadKnownEpisode(runId);
    return loaded?.failures.map((row) => jsonClone(row, "Stored episode failure could not be cloned."));
  }

  async getEvaluationReport(runId: string): Promise<HarnessEvaluationReport | undefined> {
    const loaded = await this.loadKnownEpisode(runId);
    return loaded?.evaluationReport
      ? jsonClone(loaded.evaluationReport, "Stored evaluation report could not be cloned.")
      : undefined;
  }

  async putCheckpoint(runId: string, checkpoint: TCheckpoint): Promise<HarnessEpisodeCheckpointStoreEntry> {
    const loadedEpisode = await this.loadKnownEpisode(runId);
    if (!loadedEpisode) throw new Error("Episode artifact does not exist for this run id.");
    const canonical = jsonClone(checkpoint, "Harness checkpoint is not JSON serializable.");
    assertCheckpointIdentity(canonical, loadedEpisode.artifact);
    await this.assertCanonicalCheckpoint(canonical);
    const directoryKey = directoryKeyForCheckpointId(canonical.checkpointId);
    const checkpointText = jsonDocument(canonical);
    const manifest = checkpointManifestFor(canonical, directoryKey, checkpointText);
    return this.withStoreLease(() => this.putCheckpointUnderLease({
      runId,
      canonical,
      episode: loadedEpisode,
      directoryKey,
      checkpointText,
      manifest
    }));
  }

  private async putCheckpointUnderLease(prepared: {
    runId: string;
    canonical: TCheckpoint;
    episode: {
      artifact: TArtifact;
      entry: HarnessEpisodeStoreEntry;
    };
    directoryKey: string;
    checkpointText: string;
    manifest: HarnessEpisodeCheckpointStoreManifest;
  }): Promise<HarnessEpisodeCheckpointStoreEntry> {
    const { runId, canonical, episode: loadedEpisode, directoryKey, checkpointText, manifest } = prepared;
    assertCheckpointIdentity(canonical, loadedEpisode.artifact);
    const checkpointEntries = await this.scanCanonicalCheckpointHeads(
      loadedEpisode.entry.directoryKey,
      loadedEpisode.artifact
    );
    if (checkpointEntries.has(canonical.checkpointId)) {
      throw new Error("Harness checkpoint already exists for this checkpoint id.");
    }
    const checkpointsDirectory = path.join(this.episodesDirectory, loadedEpisode.entry.directoryKey, CHECKPOINTS_DIRECTORY);
    await assertDirectoryInside(
      path.join(this.episodesDirectory, loadedEpisode.entry.directoryKey),
      checkpointsDirectory,
      "Episode checkpoint directory is not safe."
    );
    const finalDirectory = path.join(checkpointsDirectory, directoryKey);
    await assertPathMissing(finalDirectory, "Harness checkpoint already exists for this checkpoint id.");
    const temporaryDirectory = path.join(checkpointsDirectory, `.tmp-${randomUUID()}`);
    await mkdir(temporaryDirectory, { recursive: false });
    try {
      await assertDirectoryInside(checkpointsDirectory, temporaryDirectory, "Harness checkpoint staging directory is not safe.");
      await writeFile(path.join(temporaryDirectory, CHECKPOINT_FILE), checkpointText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, MANIFEST_FILE), jsonDocument(manifest), { encoding: "utf8", flag: "wx" });
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }

    const entry = checkpointEntryFromManifest(manifest);
    checkpointEntries.set(entry.checkpointId, entry);
    this.checkpoints.set(runId, checkpointEntries);
    this.updateCheckpointCount(runId, checkpointEntries.size);
    await this.writeCheckpointIndex(runId, loadedEpisode.entry.directoryKey, checkpointEntries);
    await this.writeIndex(true, [entry.runId]);
    return cloneCheckpointEntry(entry);
  }

  async getCheckpoint(runId: string, checkpointId: string): Promise<TCheckpoint | undefined> {
    assertRunId(runId);
    assertCheckpointId(checkpointId);
    const loadedEpisode = await this.loadKnownEpisode(runId);
    if (!loadedEpisode) return undefined;
    const directoryKey = directoryKeyForCheckpointId(checkpointId);
    const checkpointDirectory = path.join(
      this.episodesDirectory,
      loadedEpisode.entry.directoryKey,
      CHECKPOINTS_DIRECTORY,
      directoryKey
    );
    try {
      const stat = await lstat(checkpointDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Stored harness checkpoint identity path is not a safe directory.");
      }
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const loaded = await this.loadCheckpointDirectory(
      loadedEpisode.entry.directoryKey,
      loadedEpisode.artifact,
      directoryKey,
      checkpointId
    );
    if (!loaded) throw new Error("Stored harness checkpoint failed canonical recovery validation.");
    return jsonClone(loaded.checkpoint, "Stored harness checkpoint could not be cloned.");
  }

  async listCheckpoints(runId: string): Promise<HarnessEpisodeCheckpointStoreEntry[]> {
    assertRunId(runId);
    const loadedEpisode = await this.loadKnownEpisode(runId);
    if (!loadedEpisode) return [];
    const entries = this.checkpoints.get(runId) ?? new Map<string, HarnessEpisodeCheckpointStoreEntry>();
    const verified: HarnessEpisodeCheckpointStoreEntry[] = [];
    for (const entry of [...entries.values()].sort(compareCheckpointEntries)) {
      const loaded = await this.loadCheckpointDirectory(
        loadedEpisode.entry.directoryKey,
        loadedEpisode.artifact,
        entry.directoryKey,
        entry.checkpointId
      );
      if (!loaded) throw new Error("Stored harness checkpoint failed canonical recovery validation.");
      verified.push(cloneCheckpointEntry(loaded.entry));
    }
    return verified;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await assertDirectory(this.root, "Episode artifact store root is not a safe directory.");
    await mkdir(this.episodesDirectory, { recursive: true });
    await assertDirectoryInside(this.root, this.episodesDirectory, "Episode artifact directory is not safe.");
    await mkdir(this.locksDirectory, { recursive: true });
    await assertDirectoryInside(this.root, this.locksDirectory, "Episode artifact store locks directory is not safe.");
    await assertWritableFileTarget(path.join(this.root, INDEX_FILE), "Episode artifact index is not a safe regular file.");

    await this.withStoreLease(async () => {
      await this.refreshEntriesFromCanonicalEpisodes(true);
      await this.writeIndex(false);
    });
  }

  private async refreshEntriesFromCanonicalEpisodes(publishCheckpointIndexes = false): Promise<void> {
    const recovered = new Map<string, HarnessEpisodeStoreEntry>();
    const recoveredCheckpoints = new Map<string, Map<string, HarnessEpisodeCheckpointStoreEntry>>();
    const children = await readdir(this.episodesDirectory, { withFileTypes: true });
    for (const child of children) {
      if (!DIRECTORY_KEY_PATTERN.test(child.name)) continue;
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new Error("Stored episode identity path is not a safe directory.");
      }
      const loaded = await this.loadDirectory(child.name);
      if (!loaded || recovered.has(loaded.entry.runId)) continue;
      const checkpoints = await this.recoverCheckpointRegistry(
        child.name,
        loaded.artifact,
        publishCheckpointIndexes
      );
      recovered.set(loaded.entry.runId, { ...loaded.entry, checkpointCount: checkpoints.size });
      recoveredCheckpoints.set(loaded.entry.runId, checkpoints);
    }
    this.entries.clear();
    for (const [runId, entry] of recovered) this.entries.set(runId, entry);
    this.checkpoints.clear();
    for (const [runId, entries] of recoveredCheckpoints) this.checkpoints.set(runId, entries);
  }

  /**
   * Merge this instance's freshly verified mutations with the globally locked
   * derived index. The index is never read authority: open/get/list recover
   * from canonical directories and re-run all strong verifiers. Holding the
   * lease while reading and replacing this projection prevents peer writers
   * from erasing one another without replaying every historical episode.
   */
  private async mergeEntriesFromPublishedIndex(dirtyRunIds: readonly string[]): Promise<void> {
    const dirtyRunIdSet = new Set(dirtyRunIds);
    let projected: Map<string, HarnessEpisodeStoreEntry> | undefined;
    try {
      const text = await readSafeFile(this.root, INDEX_FILE);
      projected = parseEpisodeStoreIndexEntries(JSON.parse(text) as unknown);
    } catch (error) {
      if (!isMissing(error)) projected = undefined;
    }
    if (!projected) {
      await this.refreshEntriesFromCanonicalEpisodes(true);
      return;
    }
    for (const entry of projected.values()) {
      const directory = path.join(this.episodesDirectory, entry.directoryKey);
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("Stored episode identity path is not a safe directory.");
        }
      } catch (error) {
        if (isMissing(error)) {
          await this.refreshEntriesFromCanonicalEpisodes(true);
          return;
        }
        throw error;
      }
      if (dirtyRunIdSet.has(entry.runId)) continue;
      const manifest = JSON.parse(await readSafeFile(directory, MANIFEST_FILE)) as unknown;
      const canonicalProjection = projectionEntryFromManifest(manifest, entry.directoryKey);
      if (!canonicalProjection) {
        await this.refreshEntriesFromCanonicalEpisodes(true);
        return;
      }
      const checkpointDirectoryCount = await this.countProjectionCheckpointDirectories(entry.directoryKey);
      canonicalProjection.checkpointCount = checkpointDirectoryCount;
      if (checkpointDirectoryCount > 0 || entry.checkpointCount > 0) {
        const loaded = await this.loadDirectory(entry.directoryKey, entry.runId, false);
        if (!loaded) {
          await this.refreshEntriesFromCanonicalEpisodes(true);
          return;
        }
        const canonicalCheckpoints = await this.scanCanonicalCheckpointHeads(
          entry.directoryKey,
          loaded.artifact
        );
        canonicalProjection.checkpointCount = canonicalCheckpoints.size;
        if (canonicalCheckpoints.size !== checkpointDirectoryCount) {
          await this.refreshEntriesFromCanonicalEpisodes(true);
          return;
        }
      }
      if (hashStableJsonValue(canonicalProjection) !== hashStableJsonValue(entry)) {
        await this.refreshEntriesFromCanonicalEpisodes(true);
        return;
      }
    }
    const knownDirectoryKeys = new Set([
      ...[...projected.values()].map((entry) => entry.directoryKey),
      ...dirtyRunIds.flatMap((runId) => {
        const entry = this.entries.get(runId);
        return entry ? [entry.directoryKey] : [];
      })
    ]);
    for (const child of await readdir(this.episodesDirectory, { withFileTypes: true })) {
      if (!DIRECTORY_KEY_PATTERN.test(child.name)) continue;
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new Error("Stored episode identity path is not a safe directory.");
      }
      if (knownDirectoryKeys.has(child.name)) continue;
      const loaded = await this.loadDirectory(child.name);
      if (!loaded || projected.has(loaded.entry.runId)) continue;
      const checkpoints = await this.recoverCheckpointRegistry(child.name, loaded.artifact, true);
      projected.set(loaded.entry.runId, { ...loaded.entry, checkpointCount: checkpoints.size });
    }
    for (const runId of dirtyRunIds) {
      const entry = this.entries.get(runId);
      if (entry) projected.set(runId, cloneEntry(entry));
    }
    this.entries.clear();
    for (const [runId, entry] of projected) this.entries.set(runId, entry);
  }

  private async countProjectionCheckpointDirectories(episodeDirectoryKey: string): Promise<number> {
    const checkpointsDirectory = path.join(this.episodesDirectory, episodeDirectoryKey, CHECKPOINTS_DIRECTORY);
    let count = 0;
    for (const child of await readdir(checkpointsDirectory, { withFileTypes: true })) {
      if (!DIRECTORY_KEY_PATTERN.test(child.name)) continue;
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new Error("Stored harness checkpoint identity path is not a safe directory.");
      }
      count += 1;
    }
    return count;
  }

  private async scanCanonicalCheckpointHeads(
    episodeDirectoryKey: string,
    artifact: TArtifact
  ): Promise<Map<string, HarnessEpisodeCheckpointStoreEntry>> {
    const episodeDirectory = path.join(this.episodesDirectory, episodeDirectoryKey);
    const checkpointsDirectory = path.join(episodeDirectory, CHECKPOINTS_DIRECTORY);
    const recovered = new Map<string, HarnessEpisodeCheckpointStoreEntry>();
    const children = await readdir(checkpointsDirectory, { withFileTypes: true });
    const checkpointDirectories = children.filter(
      (child) => DIRECTORY_KEY_PATTERN.test(child.name) && child.isDirectory() && !child.isSymbolicLink()
    );
    if (checkpointDirectories.length > 0 && !this.verifyCheckpoint) {
      throw new Error("Stored harness checkpoints require an explicit canonical checkpoint verifier.");
    }
    for (const child of checkpointDirectories) {
      const directory = path.join(checkpointsDirectory, child.name);
      try {
        await assertDirectoryInside(checkpointsDirectory, directory, "Stored harness checkpoint directory is not safe.");
        const manifestText = await readSafeFile(directory, MANIFEST_FILE);
        const checkpointText = await readSafeFile(directory, CHECKPOINT_FILE);
        const manifest = JSON.parse(manifestText) as unknown;
        const checkpoint = JSON.parse(checkpointText) as TCheckpoint;
        if (!isValidCheckpointManifest(manifest, child.name, checkpoint)) continue;
        if (directoryKeyForCheckpointId(checkpoint.checkpointId) !== child.name) continue;
        if (checkpoint.source.runId !== artifact.runId) continue;
        if (sha256(checkpointText) !== manifest.checkpointSha256) continue;
        assertCheckpointIdentity(checkpoint, artifact);
        await this.assertCanonicalCheckpoint(checkpoint);
        const entry = checkpointEntryFromManifest(manifest);
        if (!recovered.has(entry.checkpointId)) recovered.set(entry.checkpointId, entry);
      } catch (error) {
        if (isRecord(error) && typeof error.code === "string" && error.code !== "ENOENT") throw error;
        // A corrupt checkpoint is not canonical index membership.
      }
    }
    return recovered;
  }

  private async loadKnownEpisode(
    runId: string
  ): Promise<{
    artifact: TArtifact;
    entry: HarnessEpisodeStoreEntry;
    metrics: HarnessEpisodeMetricRow[];
    failures: HarnessEpisodeFailureRow[];
    evaluationReport?: HarnessEvaluationReport;
    projection?: HarnessEpisodeProjectionEnvelope;
  } | undefined> {
    assertRunId(runId);
    const directoryKey = directoryKeyForRunId(runId);
    try {
      const stat = await lstat(path.join(this.episodesDirectory, directoryKey));
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Stored episode identity path is not a safe directory.");
      }
    } catch (error) {
      if (isMissing(error)) {
        this.entries.delete(runId);
        this.checkpoints.delete(runId);
        return undefined;
      }
      throw error;
    }
    const loaded = await this.loadDirectory(directoryKey, runId);
    if (!loaded) throw new Error("Stored episode artifact failed canonical recovery validation.");
    const checkpoints = await this.recoverCheckpointRegistry(directoryKey, loaded.artifact, false);
    loaded.entry.checkpointCount = checkpoints.size;
    this.entries.set(runId, cloneEntry(loaded.entry));
    this.checkpoints.set(runId, checkpoints);
    return loaded;
  }

  private async loadDirectory(
    directoryKey: string,
    expectedRunId?: string,
    verifyCanonical = true
  ): Promise<{
    artifact: TArtifact;
    entry: HarnessEpisodeStoreEntry;
    metrics: HarnessEpisodeMetricRow[];
    failures: HarnessEpisodeFailureRow[];
    evaluationReport?: HarnessEvaluationReport;
    projection?: HarnessEpisodeProjectionEnvelope;
  } | undefined> {
    if (!DIRECTORY_KEY_PATTERN.test(directoryKey)) return undefined;
    const directory = path.join(this.episodesDirectory, directoryKey);
    try {
      await assertDirectory(this.root, "Episode artifact store root is not a safe directory.");
      await assertDirectoryInside(this.root, this.episodesDirectory, "Episode artifact directory is not safe.");
      await assertDirectoryInside(this.episodesDirectory, directory, "Stored episode directory is not safe.");
      const manifestText = await readSafeFile(directory, MANIFEST_FILE);
      const artifactText = await readSafeFile(directory, ARTIFACT_FILE);
      const recordedTrajectory = await readSafeFile(directory, TRAJECTORY_FILE);
      const manifest = JSON.parse(manifestText) as unknown;
      const artifact = JSON.parse(artifactText) as TArtifact;
      if (directoryKeyForRunId(artifact.runId) !== directoryKey) return undefined;
      if (expectedRunId !== undefined && artifact.runId !== expectedRunId) return undefined;
      if (trajectoryJsonl(artifact) !== recordedTrajectory) return undefined;
      if (isValidLegacyV1Manifest(manifest, directoryKey, artifact)) {
        if (sha256(artifactText) !== manifest.artifactSha256) return undefined;
        if (sha256(recordedTrajectory) !== manifest.trajectorySha256) return undefined;
        if (verifyCanonical) await this.assertCanonical(artifact);
        return {
          artifact,
          entry: entryForArtifact(artifact, directoryKey),
          metrics: [],
          failures: [],
          evaluationReport: undefined,
          projection: undefined
        };
      }
      if (isValidLegacyV2Manifest(manifest, directoryKey, artifact)) {
        const recordedMetrics = await readSafeFile(directory, METRICS_FILE);
        const recordedFailures = await readSafeFile(directory, FAILURES_FILE);
        if (sha256(artifactText) !== manifest.artifactSha256) return undefined;
        if (sha256(recordedTrajectory) !== manifest.trajectorySha256) return undefined;
        if (sha256(recordedMetrics) !== manifest.metricsSha256) return undefined;
        if (sha256(recordedFailures) !== manifest.failuresSha256) return undefined;
        const metrics = parseMetricRows(recordedMetrics, artifact.runId, manifest.evaluationReportId);
        const failures = parseFailureRows(recordedFailures, artifact.runId);
        if (metrics.length !== manifest.metricCount || failures.length !== manifest.failureCount) return undefined;
        if (verifyCanonical) await this.assertCanonical(artifact);
        return { artifact, entry: entryFromManifest(manifest), metrics, failures, evaluationReport: undefined, projection: undefined };
      }
      if (isValidLegacyV3Manifest(manifest, directoryKey, artifact)) {
        const recordedMetrics = await readSafeFile(directory, METRICS_FILE);
        const recordedFailures = await readSafeFile(directory, FAILURES_FILE);
        const recordedEvaluation = await readSafeFile(directory, EVALUATION_FILE);
        if (sha256(artifactText) !== manifest.artifactSha256) return undefined;
        if (sha256(recordedTrajectory) !== manifest.trajectorySha256) return undefined;
        if (sha256(recordedMetrics) !== manifest.metricsSha256) return undefined;
        if (sha256(recordedFailures) !== manifest.failuresSha256) return undefined;
        if (sha256(recordedEvaluation) !== manifest.evaluationSha256) return undefined;
        const metrics = parseMetricRows(recordedMetrics, artifact.runId, manifest.evaluationReportId);
        const failures = parseFailureRows(recordedFailures, artifact.runId);
        if (metrics.length !== manifest.metricCount || failures.length !== manifest.failureCount) return undefined;
        const evaluationReport = parseEvaluationRecord(recordedEvaluation, artifact, artifactText, manifest.evaluationReportId);
        if (hashStableJsonValue(evaluationReport?.metrics ?? []) !== hashStableJsonValue(metrics.map(metricFromRow))) return undefined;
        if (hashStableJsonValue(failureRowsForArtifact(artifact, evaluationReport)) !== hashStableJsonValue(failures)) return undefined;
        if (verifyCanonical) await this.assertCanonical(artifact);
        return { artifact, entry: entryFromManifest(manifest), metrics, failures, evaluationReport, projection: undefined };
      }
      if (!isValidManifest(manifest, directoryKey, artifact)) return undefined;
      const recordedMetrics = await readSafeFile(directory, METRICS_FILE);
      const recordedFailures = await readSafeFile(directory, FAILURES_FILE);
      const recordedEvaluation = await readSafeFile(directory, EVALUATION_FILE);
      if (sha256(artifactText) !== manifest.artifactSha256) return undefined;
      if (sha256(recordedTrajectory) !== manifest.trajectorySha256) return undefined;
      if (sha256(recordedMetrics) !== manifest.metricsSha256) return undefined;
      if (sha256(recordedFailures) !== manifest.failuresSha256) return undefined;
      if (sha256(recordedEvaluation) !== manifest.evaluationSha256) return undefined;
      const metrics = parseMetricRows(recordedMetrics, artifact.runId, manifest.evaluationReportId);
      const failures = parseFailureRows(recordedFailures, artifact.runId);
      if (metrics.length !== manifest.metricCount || failures.length !== manifest.failureCount) return undefined;
      const evaluationReport = parseEvaluationRecord(recordedEvaluation, artifact, artifactText, manifest.evaluationReportId);
      if (hashStableJsonValue(evaluationReport?.metrics ?? []) !== hashStableJsonValue(metrics.map(metricFromRow))) return undefined;
      if (hashStableJsonValue(failureRowsForArtifact(artifact, evaluationReport)) !== hashStableJsonValue(failures)) return undefined;
      const projection = await readProjection(directory, manifest, artifact, artifactText);
      if (projection === INVALID_PROJECTION) return undefined;
      if (verifyCanonical) await this.assertCanonical(artifact);
      return {
        artifact,
        entry: entryFromManifest(manifest),
        metrics,
        failures,
        evaluationReport,
        ...(projection ? { projection } : {})
      };
    } catch (error) {
      if (isRecord(error) && typeof error.code === "string" && error.code !== "ENOENT") throw error;
      return undefined;
    }
  }

  private async assertCanonical(artifact: TArtifact): Promise<void> {
    let result: CanonicalEpisodeArtifactVerification;
    try {
      result = await this.verifyArtifact(jsonClone(artifact, "Episode artifact could not be cloned for verification."));
    } catch {
      throw new Error("Canonical episode artifact verifier failed.");
    }
    if (
      !result ||
      result.ok !== true ||
      !Array.isArray(result.mismatches) ||
      result.mismatches.length > 0 ||
      result.mismatches.some((mismatch) => typeof mismatch !== "string")
    ) {
      throw new Error("Canonical episode artifact verification rejected the artifact.");
    }
  }

  private async assertCanonicalCheckpoint(checkpoint: TCheckpoint): Promise<void> {
    if (!this.verifyCheckpoint) {
      throw new Error("Harness checkpoint persistence requires an explicit canonical checkpoint verifier.");
    }
    let result: CanonicalEpisodeArtifactVerification;
    try {
      result = await this.verifyCheckpoint(jsonClone(checkpoint, "Harness checkpoint could not be cloned for verification."));
    } catch {
      throw new Error("Canonical harness checkpoint verifier failed.");
    }
    if (
      !result ||
      result.ok !== true ||
      !Array.isArray(result.mismatches) ||
      result.mismatches.length > 0 ||
      result.mismatches.some((mismatch) => typeof mismatch !== "string")
    ) {
      throw new Error("Canonical harness checkpoint verification rejected the checkpoint.");
    }
  }

  private async recoverCheckpointRegistry(
    episodeDirectoryKey: string,
    artifact: TArtifact,
    publishIndex = true
  ): Promise<Map<string, HarnessEpisodeCheckpointStoreEntry>> {
    const episodeDirectory = path.join(this.episodesDirectory, episodeDirectoryKey);
    const checkpointsDirectory = path.join(episodeDirectory, CHECKPOINTS_DIRECTORY);
    await mkdir(checkpointsDirectory, { recursive: true });
    await assertDirectoryInside(episodeDirectory, checkpointsDirectory, "Episode checkpoint directory is not safe.");
    await assertWritableFileTarget(
      path.join(episodeDirectory, CHECKPOINT_INDEX_FILE),
      "Episode checkpoint index is not a safe regular file."
    );
    const children = await readdir(checkpointsDirectory, { withFileTypes: true });
    const checkpointDirectories = children.filter(
      (child) => child.isDirectory() && DIRECTORY_KEY_PATTERN.test(child.name)
    );
    if (checkpointDirectories.length > 0 && !this.verifyCheckpoint) {
      throw new Error("Stored harness checkpoints require an explicit canonical checkpoint verifier.");
    }
    const recovered = new Map<string, HarnessEpisodeCheckpointStoreEntry>();
    for (const child of checkpointDirectories) {
      const loaded = await this.loadCheckpointDirectory(episodeDirectoryKey, artifact, child.name);
      if (!loaded || recovered.has(loaded.entry.checkpointId)) continue;
      if (loaded.checkpoint.source.sourceArtifactVersion !== artifact.artifactVersion) continue;
      recovered.set(loaded.entry.checkpointId, loaded.entry);
    }
    if (publishIndex) await this.writeCheckpointIndex(artifact.runId, episodeDirectoryKey, recovered);
    return recovered;
  }

  private async loadCheckpointDirectory(
    episodeDirectoryKey: string,
    artifact: TArtifact,
    checkpointDirectoryKey: string,
    expectedCheckpointId?: string
  ): Promise<{ checkpoint: TCheckpoint; entry: HarnessEpisodeCheckpointStoreEntry } | undefined> {
    if (!DIRECTORY_KEY_PATTERN.test(checkpointDirectoryKey)) return undefined;
    const episodeDirectory = path.join(this.episodesDirectory, episodeDirectoryKey);
    const checkpointsDirectory = path.join(episodeDirectory, CHECKPOINTS_DIRECTORY);
    const directory = path.join(checkpointsDirectory, checkpointDirectoryKey);
    try {
      await assertDirectoryInside(this.root, this.episodesDirectory, "Episode artifact directory is not safe.");
      await assertDirectoryInside(this.episodesDirectory, episodeDirectory, "Stored episode directory is not safe.");
      await assertDirectoryInside(episodeDirectory, checkpointsDirectory, "Episode checkpoint directory is not safe.");
      await assertDirectoryInside(checkpointsDirectory, directory, "Stored harness checkpoint directory is not safe.");
      const manifestText = await readSafeFile(directory, MANIFEST_FILE);
      const checkpointText = await readSafeFile(directory, CHECKPOINT_FILE);
      const manifest = JSON.parse(manifestText) as unknown;
      const checkpoint = JSON.parse(checkpointText) as TCheckpoint;
      if (!isValidCheckpointManifest(manifest, checkpointDirectoryKey, checkpoint)) return undefined;
      if (directoryKeyForCheckpointId(checkpoint.checkpointId) !== checkpointDirectoryKey) return undefined;
      if (checkpoint.source.runId !== artifact.runId) return undefined;
      if (expectedCheckpointId !== undefined && checkpoint.checkpointId !== expectedCheckpointId) return undefined;
      if (sha256(checkpointText) !== manifest.checkpointSha256) return undefined;
      assertCheckpointIdentity(checkpoint, artifact);
      await this.assertCanonicalCheckpoint(checkpoint);
      return { checkpoint, entry: checkpointEntryFromManifest(manifest) };
    } catch {
      return undefined;
    }
  }

  private async writeCheckpointIndex(
    runId: string,
    episodeDirectoryKey: string,
    entries: Map<string, HarnessEpisodeCheckpointStoreEntry>
  ): Promise<void> {
    const index: HarnessEpisodeCheckpointStoreIndex = {
      schemaVersion: HARNESS_EPISODE_CHECKPOINT_INDEX_VERSION,
      kind: "episode-checkpoint-index",
      runId,
      updatedAt: this.now(),
      entries: [...entries.values()].sort(compareCheckpointEntries).map(cloneCheckpointEntry)
    };
    const episodeDirectory = path.join(this.episodesDirectory, episodeDirectoryKey);
    await assertDirectoryInside(this.episodesDirectory, episodeDirectory, "Stored episode directory is not safe.");
    const target = path.join(episodeDirectory, CHECKPOINT_INDEX_FILE);
    await assertWritableFileTarget(target, "Episode checkpoint index is not a safe regular file.");
    const temporary = path.join(episodeDirectory, `.checkpoint-index-${randomUUID()}.tmp`);
    await writeFile(temporary, jsonDocument(index), { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private updateCheckpointCount(runId: string, checkpointCount: number): void {
    const existing = this.entries.get(runId);
    if (existing) this.entries.set(runId, { ...existing, checkpointCount });
  }

  private async withStoreLease<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const lease = await this.acquireStoreLease();
    try {
      return await operation();
    } finally {
      await releaseStoreLease(lease);
    }
  }

  private async acquireStoreLease(): Promise<ChildProcessWithoutNullStreams> {
    const lockDirectory = path.join(this.locksDirectory, "store.lock");
    try {
      await mkdir(lockDirectory, { recursive: false });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertDirectoryInside(this.locksDirectory, lockDirectory, "Episode artifact store lease path is not safe.");
    const child = spawn(
      "/usr/bin/flock",
      ["--exclusive", lockDirectory, "/bin/sh", "-c", `printf '${STORE_LEASE_ACQUIRED_MARKER}'; cat >/dev/null`],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    try {
      await waitForStoreLease(child);
      return child;
    } catch (error) {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      throw error;
    }
  }

  private async writeIndex(refreshFromCanonical = true, dirtyRunIds: readonly string[] = []): Promise<void> {
    if (refreshFromCanonical) await this.mergeEntriesFromPublishedIndex(dirtyRunIds);
    const index: HarnessEpisodeStoreIndex = {
      schemaVersion: HARNESS_EPISODE_STORE_INDEX_VERSION,
      kind: "episode-store-index",
      updatedAt: this.now(),
      entries: [...this.entries.values()].sort(compareEntries).map(cloneEntry)
    };
    const target = path.join(this.root, INDEX_FILE);
    await assertWritableFileTarget(target, "Episode artifact index is not a safe regular file.");
    const temporary = path.join(this.root, `.index-${randomUUID()}.tmp`);
    await writeFile(temporary, jsonDocument(index), { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export async function openHarnessEpisodeArtifactStore<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope = GenericCheckpointEnvelope
>(
  options: HarnessEpisodeArtifactStoreOptions<TArtifact, TCheckpoint>
): Promise<HarnessEpisodeArtifactStore<TArtifact, TCheckpoint>> {
  return HarnessEpisodeArtifactStore.open(options);
}

export function deriveHarnessEpisodeTrajectoryJsonl(artifact: GenericEpisodeEnvelope): string {
  return trajectoryJsonl(artifact);
}

/** Exact digest used to bind a derived projection to the canonical artifact document. */
export function deriveHarnessEpisodeArtifactSha256(artifact: GenericEpisodeEnvelope): string {
  return sha256(jsonDocument(jsonClone(artifact, "Episode artifact is not JSON serializable.")));
}

function manifestForArtifact(
  artifact: GenericEpisodeEnvelope,
  directoryKey: string,
  artifactText: string,
  trajectoryText: string,
  metricsText: string,
  failuresText: string,
  evaluationText: string,
  projection: HarnessEpisodeProjectionEnvelope | undefined,
  projectionText: string | undefined,
  evaluationReportId?: string
): HarnessEpisodeStoreManifest {
  const metrics = parseMetricRows(metricsText, artifact.runId, evaluationReportId);
  const failures = parseFailureRows(failuresText, artifact.runId);
  return {
    schemaVersion: HARNESS_EPISODE_STORE_MANIFEST_VERSION,
    manifestKind: "episode-store-manifest",
    ...entryForArtifact(artifact, directoryKey, metrics.length, failures.length),
    artifactSha256: sha256(artifactText),
    trajectorySha256: sha256(trajectoryText),
    metricsSha256: sha256(metricsText),
    failuresSha256: sha256(failuresText),
    evaluationSha256: sha256(evaluationText),
    evaluationReportId,
    ...(projection && projectionText ? {
      projectionSha256: sha256(projectionText),
      projectionVisibility: projection.source.visibility,
      projectionPolicyId: projection.source.policyId,
      projectionPolicyVersion: projection.source.policyVersion
    } : {}),
    files: {
      artifact: ARTIFACT_FILE,
      trajectory: TRAJECTORY_FILE,
      metrics: METRICS_FILE,
      failures: FAILURES_FILE,
      evaluation: EVALUATION_FILE,
      ...(projection ? { projection: PROJECTION_FILE } : {}),
      manifest: MANIFEST_FILE,
      checkpointIndex: CHECKPOINT_INDEX_FILE,
      checkpoints: CHECKPOINTS_DIRECTORY
    }
  };
}

function entryForArtifact(
  artifact: GenericEpisodeEnvelope,
  directoryKey: string,
  metricCount = 0,
  failureCount = 0,
  checkpointCount = 0
): HarnessEpisodeStoreEntry {
  return {
    runId: artifact.runId,
    artifactVersion: artifact.artifactVersion,
    kind: artifact.kind,
    createdAt: artifact.createdAt,
    status: artifact.status,
    directoryKey,
    nativeStepCount: artifact.socialEpisode.steps.length,
    messageCount: artifact.socialEpisode.messages.length,
    metricCount,
    failureCount,
    checkpointCount
  };
}

function entryFromManifest(manifest: HarnessEpisodeStoreManifest): HarnessEpisodeStoreEntry {
  return {
    runId: manifest.runId,
    artifactVersion: manifest.artifactVersion,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    status: manifest.status,
    directoryKey: manifest.directoryKey,
    nativeStepCount: manifest.nativeStepCount,
    messageCount: manifest.messageCount,
    metricCount: manifest.metricCount,
    failureCount: manifest.failureCount,
    checkpointCount: 0,
    ...(manifest.evaluationReportId ? { evaluationReportId: manifest.evaluationReportId } : {})
  };
}

function projectionEntryFromManifest(value: unknown, directoryKey: string): HarnessEpisodeStoreEntry | undefined {
  if (!isRecord(value)) return undefined;
  const legacyV1 = value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V1_VERSION;
  const legacyV2 = value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V2_VERSION;
  const legacyV3 = value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V3_VERSION;
  const current = value.schemaVersion === HARNESS_EPISODE_STORE_MANIFEST_VERSION;
  if (
    (!legacyV1 && !legacyV2 && !legacyV3 && !current) ||
    value.manifestKind !== "episode-store-manifest" ||
    !isNonemptyString(value.runId) ||
    directoryKeyForRunId(value.runId) !== directoryKey ||
    value.directoryKey !== directoryKey ||
    !isNonemptyString(value.artifactVersion) ||
    !isNonemptyString(value.kind) ||
    !isNonemptyString(value.createdAt) ||
    (value.status !== "completed" && value.status !== "truncated" && value.status !== "failed") ||
    !isNonnegativeInteger(value.nativeStepCount) ||
    !isNonnegativeInteger(value.messageCount)
  ) return undefined;
  const metricCount = legacyV1 ? 0 : value.metricCount;
  const failureCount = legacyV1 ? 0 : value.failureCount;
  if (!isNonnegativeInteger(metricCount) || !isNonnegativeInteger(failureCount)) return undefined;
  if (value.evaluationReportId !== undefined && !isNonemptyString(value.evaluationReportId)) return undefined;
  return {
    runId: value.runId,
    artifactVersion: value.artifactVersion,
    kind: value.kind,
    createdAt: value.createdAt,
    status: value.status,
    directoryKey,
    nativeStepCount: value.nativeStepCount,
    messageCount: value.messageCount,
    metricCount,
    failureCount,
    checkpointCount: 0,
    ...(isNonemptyString(value.evaluationReportId) ? { evaluationReportId: value.evaluationReportId } : {})
  };
}

function parseEpisodeStoreIndexEntries(value: unknown): Map<string, HarnessEpisodeStoreEntry> | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== HARNESS_EPISODE_STORE_INDEX_VERSION ||
    value.kind !== "episode-store-index" ||
    !isNonemptyString(value.updatedAt) ||
    !Array.isArray(value.entries)
  ) return undefined;
  const recovered = new Map<string, HarnessEpisodeStoreEntry>();
  for (const candidate of value.entries) {
    if (
      !isRecord(candidate) ||
      !isNonemptyString(candidate.runId) ||
      !isNonemptyString(candidate.artifactVersion) ||
      !isNonemptyString(candidate.kind) ||
      !isNonemptyString(candidate.createdAt) ||
      (candidate.status !== "completed" && candidate.status !== "truncated" && candidate.status !== "failed") ||
      !isNonemptyString(candidate.directoryKey) ||
      directoryKeyForRunId(candidate.runId) !== candidate.directoryKey ||
      !isNonnegativeInteger(candidate.nativeStepCount) ||
      !isNonnegativeInteger(candidate.messageCount) ||
      !isNonnegativeInteger(candidate.metricCount) ||
      !isNonnegativeInteger(candidate.failureCount) ||
      !isNonnegativeInteger(candidate.checkpointCount) ||
      (candidate.evaluationReportId !== undefined && !isNonemptyString(candidate.evaluationReportId)) ||
      recovered.has(candidate.runId)
    ) return undefined;
    recovered.set(candidate.runId, {
      runId: candidate.runId,
      artifactVersion: candidate.artifactVersion,
      kind: candidate.kind,
      createdAt: candidate.createdAt,
      status: candidate.status,
      directoryKey: candidate.directoryKey,
      nativeStepCount: candidate.nativeStepCount,
      messageCount: candidate.messageCount,
      metricCount: candidate.metricCount,
      failureCount: candidate.failureCount,
      checkpointCount: candidate.checkpointCount,
      ...(isNonemptyString(candidate.evaluationReportId) ? { evaluationReportId: candidate.evaluationReportId } : {})
    });
  }
  return recovered;
}

function isValidManifest(
  value: unknown,
  directoryKey: string,
  artifact: GenericEpisodeEnvelope
): value is HarnessEpisodeStoreManifest {
  if (!isRecord(value)) return false;
  const expected = entryForArtifact(
    artifact,
    directoryKey,
    typeof value.metricCount === "number" ? value.metricCount : 0,
    typeof value.failureCount === "number" ? value.failureCount : 0
  );
  return (
    value.schemaVersion === HARNESS_EPISODE_STORE_MANIFEST_VERSION &&
    value.manifestKind === "episode-store-manifest" &&
    value.runId === expected.runId &&
    value.artifactVersion === expected.artifactVersion &&
    value.kind === expected.kind &&
    value.createdAt === expected.createdAt &&
    value.status === expected.status &&
    value.directoryKey === expected.directoryKey &&
    value.nativeStepCount === expected.nativeStepCount &&
    value.messageCount === expected.messageCount &&
    typeof value.metricCount === "number" &&
    Number.isInteger(value.metricCount) &&
    value.metricCount >= 0 &&
    typeof value.failureCount === "number" &&
    Number.isInteger(value.failureCount) &&
    value.failureCount >= 0 &&
    typeof value.artifactSha256 === "string" &&
    typeof value.trajectorySha256 === "string" &&
    typeof value.metricsSha256 === "string" &&
    typeof value.failuresSha256 === "string" &&
    typeof value.evaluationSha256 === "string" &&
    (value.evaluationReportId === undefined || isNonemptyString(value.evaluationReportId)) &&
    isRecord(value.files) &&
    value.files.artifact === ARTIFACT_FILE &&
    value.files.trajectory === TRAJECTORY_FILE &&
    value.files.metrics === METRICS_FILE &&
    value.files.failures === FAILURES_FILE &&
    value.files.evaluation === EVALUATION_FILE &&
    isValidProjectionManifestBinding(value) &&
    value.files.manifest === MANIFEST_FILE &&
    value.files.checkpointIndex === CHECKPOINT_INDEX_FILE &&
    value.files.checkpoints === CHECKPOINTS_DIRECTORY
  );
}

function isValidLegacyV3Manifest(
  value: unknown,
  directoryKey: string,
  artifact: GenericEpisodeEnvelope
): value is HarnessEpisodeStoreManifest {
  if (!isRecord(value)) return false;
  const expected = entryForArtifact(
    artifact,
    directoryKey,
    typeof value.metricCount === "number" ? value.metricCount : 0,
    typeof value.failureCount === "number" ? value.failureCount : 0
  );
  return (
    value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V3_VERSION &&
    value.manifestKind === "episode-store-manifest" &&
    value.runId === expected.runId &&
    value.artifactVersion === expected.artifactVersion &&
    value.kind === expected.kind &&
    value.createdAt === expected.createdAt &&
    value.status === expected.status &&
    value.directoryKey === expected.directoryKey &&
    value.nativeStepCount === expected.nativeStepCount &&
    value.messageCount === expected.messageCount &&
    Number.isInteger(value.metricCount) && Number(value.metricCount) >= 0 &&
    Number.isInteger(value.failureCount) && Number(value.failureCount) >= 0 &&
    typeof value.artifactSha256 === "string" &&
    typeof value.trajectorySha256 === "string" &&
    typeof value.metricsSha256 === "string" &&
    typeof value.failuresSha256 === "string" &&
    typeof value.evaluationSha256 === "string" &&
    (value.evaluationReportId === undefined || isNonemptyString(value.evaluationReportId)) &&
    isRecord(value.files) &&
    value.files.artifact === ARTIFACT_FILE &&
    value.files.trajectory === TRAJECTORY_FILE &&
    value.files.metrics === METRICS_FILE &&
    value.files.failures === FAILURES_FILE &&
    value.files.evaluation === EVALUATION_FILE &&
    value.files.projection === undefined &&
    value.files.manifest === MANIFEST_FILE &&
    value.files.checkpointIndex === CHECKPOINT_INDEX_FILE &&
    value.files.checkpoints === CHECKPOINTS_DIRECTORY &&
    value.projectionSha256 === undefined &&
    value.projectionVisibility === undefined &&
    value.projectionPolicyId === undefined &&
    value.projectionPolicyVersion === undefined
  );
}

function isValidProjectionManifestBinding(value: Record<string, unknown>): boolean {
  if (!isRecord(value.files)) return false;
  const fields = [
    value.projectionSha256,
    value.projectionVisibility,
    value.projectionPolicyId,
    value.projectionPolicyVersion,
    value.files.projection
  ];
  const hasProjection = fields.some((field) => field !== undefined);
  if (!hasProjection) return true;
  return (
    isSha256(value.projectionSha256) &&
    (value.projectionVisibility === "postgame-redacted" || value.projectionVisibility === "public") &&
    isNonemptyString(value.projectionPolicyId) &&
    isNonemptyString(value.projectionPolicyVersion) &&
    value.files.projection === PROJECTION_FILE
  );
}

async function readProjection(
  directory: string,
  manifest: HarnessEpisodeStoreManifest,
  artifact: GenericEpisodeEnvelope,
  artifactText: string
): Promise<HarnessEpisodeProjectionEnvelope | undefined | typeof INVALID_PROJECTION> {
  if (manifest.projectionSha256 === undefined) return undefined;
  try {
    const projectionText = await readSafeFile(directory, PROJECTION_FILE);
    if (sha256(projectionText) !== manifest.projectionSha256) return INVALID_PROJECTION;
    const projection = JSON.parse(projectionText) as unknown;
    if (validateHarnessEpisodeProjectionEnvelope(projection).length) return INVALID_PROJECTION;
    const envelope = projection as HarnessEpisodeProjectionEnvelope;
    if (
      envelope.source.runId !== artifact.runId ||
      envelope.source.artifactSha256 !== sha256(artifactText) ||
      envelope.source.visibility !== manifest.projectionVisibility ||
      envelope.source.policyId !== manifest.projectionPolicyId ||
      envelope.source.policyVersion !== manifest.projectionPolicyVersion
    ) return INVALID_PROJECTION;
    return envelope;
  } catch {
    return INVALID_PROJECTION;
  }
}

function isValidLegacyV1Manifest(
  value: unknown,
  directoryKey: string,
  artifact: GenericEpisodeEnvelope
): value is Record<string, unknown> & {
  artifactSha256: string;
  trajectorySha256: string;
} {
  if (!isRecord(value)) return false;
  const expected = entryForArtifact(artifact, directoryKey);
  return (
    value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V1_VERSION &&
    value.manifestKind === "episode-store-manifest" &&
    value.runId === expected.runId &&
    value.artifactVersion === expected.artifactVersion &&
    value.kind === expected.kind &&
    value.createdAt === expected.createdAt &&
    value.status === expected.status &&
    value.directoryKey === expected.directoryKey &&
    value.nativeStepCount === expected.nativeStepCount &&
    value.messageCount === expected.messageCount &&
    typeof value.artifactSha256 === "string" &&
    typeof value.trajectorySha256 === "string" &&
    isRecord(value.files) &&
    value.files.artifact === ARTIFACT_FILE &&
    value.files.trajectory === TRAJECTORY_FILE &&
    value.files.manifest === MANIFEST_FILE
  );
}

function isValidLegacyV2Manifest(
  value: unknown,
  directoryKey: string,
  artifact: GenericEpisodeEnvelope
): value is HarnessEpisodeStoreManifest {
  if (!isRecord(value)) return false;
  const expected = entryForArtifact(
    artifact,
    directoryKey,
    typeof value.metricCount === "number" ? value.metricCount : 0,
    typeof value.failureCount === "number" ? value.failureCount : 0
  );
  return (
    value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V2_VERSION &&
    value.manifestKind === "episode-store-manifest" &&
    value.runId === expected.runId &&
    value.artifactVersion === expected.artifactVersion &&
    value.kind === expected.kind &&
    value.createdAt === expected.createdAt &&
    value.status === expected.status &&
    value.directoryKey === expected.directoryKey &&
    value.nativeStepCount === expected.nativeStepCount &&
    value.messageCount === expected.messageCount &&
    Number.isInteger(value.metricCount) && Number(value.metricCount) >= 0 &&
    Number.isInteger(value.failureCount) && Number(value.failureCount) >= 0 &&
    typeof value.artifactSha256 === "string" &&
    typeof value.trajectorySha256 === "string" &&
    typeof value.metricsSha256 === "string" &&
    typeof value.failuresSha256 === "string" &&
    (value.evaluationReportId === undefined || isNonemptyString(value.evaluationReportId)) &&
    isRecord(value.files) &&
    value.files.artifact === ARTIFACT_FILE &&
    value.files.trajectory === TRAJECTORY_FILE &&
    value.files.metrics === METRICS_FILE &&
    value.files.failures === FAILURES_FILE &&
    value.files.manifest === MANIFEST_FILE &&
    value.files.checkpointIndex === CHECKPOINT_INDEX_FILE &&
    value.files.checkpoints === CHECKPOINTS_DIRECTORY
  );
}

function checkpointManifestFor(
  checkpoint: GenericCheckpointEnvelope,
  directoryKey: string,
  checkpointText: string
): HarnessEpisodeCheckpointStoreManifest {
  return {
    schemaVersion: HARNESS_EPISODE_CHECKPOINT_MANIFEST_VERSION,
    manifestKind: "episode-checkpoint-manifest",
    ...checkpointEntryFor(checkpoint, directoryKey),
    checkpointSha256: sha256(checkpointText),
    files: {
      checkpoint: CHECKPOINT_FILE,
      manifest: MANIFEST_FILE
    }
  };
}

function checkpointEntryFor(
  checkpoint: GenericCheckpointEnvelope,
  directoryKey: string
): HarnessEpisodeCheckpointStoreEntry {
  return {
    checkpointId: checkpoint.checkpointId,
    runId: checkpoint.source.runId,
    artifactVersion: checkpoint.artifactVersion,
    kind: checkpoint.kind,
    createdAt: checkpoint.createdAt,
    directoryKey,
    sourceArtifactVersion: checkpoint.source.sourceArtifactVersion,
    nativeStepCount: checkpoint.source.nativeStepCount,
    messageCount: checkpoint.source.messageCount
  };
}

function checkpointEntryFromManifest(
  manifest: HarnessEpisodeCheckpointStoreManifest
): HarnessEpisodeCheckpointStoreEntry {
  return {
    checkpointId: manifest.checkpointId,
    runId: manifest.runId,
    artifactVersion: manifest.artifactVersion,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    directoryKey: manifest.directoryKey,
    sourceArtifactVersion: manifest.sourceArtifactVersion,
    nativeStepCount: manifest.nativeStepCount,
    messageCount: manifest.messageCount
  };
}

function isValidCheckpointManifest(
  value: unknown,
  directoryKey: string,
  checkpoint: GenericCheckpointEnvelope
): value is HarnessEpisodeCheckpointStoreManifest {
  if (!isRecord(value)) return false;
  const expected = checkpointEntryFor(checkpoint, directoryKey);
  return (
    value.schemaVersion === HARNESS_EPISODE_CHECKPOINT_MANIFEST_VERSION &&
    value.manifestKind === "episode-checkpoint-manifest" &&
    value.checkpointId === expected.checkpointId &&
    value.runId === expected.runId &&
    value.artifactVersion === expected.artifactVersion &&
    value.kind === expected.kind &&
    value.createdAt === expected.createdAt &&
    value.directoryKey === expected.directoryKey &&
    value.sourceArtifactVersion === expected.sourceArtifactVersion &&
    value.nativeStepCount === expected.nativeStepCount &&
    value.messageCount === expected.messageCount &&
    typeof value.checkpointSha256 === "string" &&
    isRecord(value.files) &&
    value.files.checkpoint === CHECKPOINT_FILE &&
    value.files.manifest === MANIFEST_FILE
  );
}

function emptyCheckpointIndex(runId: string, updatedAt: string): HarnessEpisodeCheckpointStoreIndex {
  return {
    schemaVersion: HARNESS_EPISODE_CHECKPOINT_INDEX_VERSION,
    kind: "episode-checkpoint-index",
    runId,
    updatedAt,
    entries: []
  };
}

function evaluationRecordJson(
  artifact: GenericEpisodeEnvelope,
  artifactText: string,
  report?: HarnessEvaluationReport
): string {
  if (!report) return jsonDocument(null);
  assertEvaluationReport(report);
  const record: HarnessEpisodeEvaluationRecordV1 = {
    schemaVersion: HARNESS_EPISODE_EVALUATION_RECORD_VERSION,
    kind: "episode-evaluation",
    runId: artifact.runId,
    artifactSha256: sha256(artifactText),
    evaluatorSetHash: hashStableJsonValue(report.evaluatorRegistry ?? report.evaluatorIds),
    report: jsonClone(report, "Episode evaluation report could not be cloned.")
  };
  return jsonDocument(record);
}

function parseEvaluationRecord(
  text: string,
  artifact: GenericEpisodeEnvelope,
  artifactText: string,
  expectedReportId?: string
): HarnessEvaluationReport | undefined {
  const value = JSON.parse(text) as unknown;
  if (value === null) {
    if (expectedReportId !== undefined) throw new Error("Stored evaluation report identity is missing.");
    return undefined;
  }
  if (!isRecord(value)) throw new Error("Stored episode evaluation record is invalid.");
  const unknownFields = Object.keys(value).filter(
    (key) => !["schemaVersion", "kind", "runId", "artifactSha256", "evaluatorSetHash", "report"].includes(key)
  );
  if (
    unknownFields.length > 0 ||
    value.schemaVersion !== HARNESS_EPISODE_EVALUATION_RECORD_VERSION ||
    value.kind !== "episode-evaluation" ||
    value.runId !== artifact.runId ||
    value.artifactSha256 !== sha256(artifactText) ||
    typeof value.evaluatorSetHash !== "string" ||
    !isRecord(value.report)
  ) {
    throw new Error("Stored episode evaluation record binding is invalid.");
  }
  const report = value.report as unknown as HarnessEvaluationReport;
  assertEvaluationReport(report);
  if (!expectedReportId || report.id !== expectedReportId) {
    throw new Error("Stored episode evaluation report id does not match its manifest.");
  }
  if (value.evaluatorSetHash !== hashStableJsonValue(report.evaluatorRegistry ?? report.evaluatorIds)) {
    throw new Error("Stored episode evaluator set hash does not match its report.");
  }
  return jsonClone(report, "Stored episode evaluation report could not be cloned.");
}

function metricRowsForArtifact(
  artifact: GenericEpisodeEnvelope,
  evaluationReport?: HarnessEvaluationReport
): HarnessEpisodeMetricRow[] {
  if (!evaluationReport) return [];
  assertEvaluationReport(evaluationReport);
  return evaluationReport.metrics.map((metric) => ({
    ...jsonClone(metric, "Episode metric is not JSON serializable."),
    schemaVersion: HARNESS_EPISODE_METRIC_ROW_VERSION,
    kind: "episode-metric",
    runId: artifact.runId,
    evaluationReportId: evaluationReport.id
  }));
}

function failureRowsForArtifact(
  artifact: GenericEpisodeEnvelope,
  evaluationReport?: HarnessEvaluationReport
): HarnessEpisodeFailureRow[] {
  const rows: HarnessEpisodeFailureRow[] = [];
  if (artifact.status === "failed") {
    rows.push({
      schemaVersion: HARNESS_EPISODE_FAILURE_ROW_VERSION,
      kind: "episode-failure",
      runId: artifact.runId,
      source: "episode_lifecycle",
      stage: "execution",
      code: "episode_failed",
      message: reviewedFailureMessage("episode_failed")
    });
  }
  for (const failure of evaluationReport?.failures ?? []) {
    assertEvaluatorFailure(failure);
    rows.push({
      schemaVersion: HARNESS_EPISODE_FAILURE_ROW_VERSION,
      kind: "episode-failure",
      runId: artifact.runId,
      source: "evaluator",
      stage: failure.stage,
      code: failure.code,
      message: reviewedFailureMessage(failure.code),
      evaluatorId: failure.evaluatorId,
      evaluatorVersion: failure.version
    });
  }
  return rows;
}

function parseMetricRows(
  text: string,
  runId: string,
  evaluationReportId?: string
): HarnessEpisodeMetricRow[] {
  const values = parseJsonLines(text);
  const rows: HarnessEpisodeMetricRow[] = [];
  for (const value of values) {
    if (!isRecord(value)) throw new Error("Stored episode metric row is invalid.");
    if (
      value.schemaVersion !== HARNESS_EPISODE_METRIC_ROW_VERSION ||
      value.kind !== "episode-metric" ||
      value.runId !== runId ||
      !isNonemptyString(value.evaluationReportId) ||
      (evaluationReportId !== undefined && value.evaluationReportId !== evaluationReportId)
    ) {
      throw new Error("Stored episode metric row identity is invalid.");
    }
    const {
      schemaVersion: _schemaVersion,
      kind: _kind,
      runId: _runId,
      evaluationReportId: _evaluationReportId,
      ...metric
    } = value;
    assertMetricRecord(metric);
    rows.push(value as unknown as HarnessEpisodeMetricRow);
  }
  if (rows.length > 0 && !evaluationReportId) {
    throw new Error("Stored episode metrics require an evaluation report identity.");
  }
  return rows;
}

function metricFromRow(row: HarnessEpisodeMetricRow): HarnessMetricRecord {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    runId: _runId,
    evaluationReportId: _evaluationReportId,
    ...metric
  } = row;
  return jsonClone(metric, "Stored episode metric could not be cloned.");
}

function parseFailureRows(text: string, runId: string): HarnessEpisodeFailureRow[] {
  const values = parseJsonLines(text);
  const rows: HarnessEpisodeFailureRow[] = [];
  for (const value of values) {
    if (!isRecord(value)) throw new Error("Stored episode failure row is invalid.");
    if (
      value.schemaVersion !== HARNESS_EPISODE_FAILURE_ROW_VERSION ||
      value.kind !== "episode-failure" ||
      value.runId !== runId ||
      (value.source !== "episode_lifecycle" && value.source !== "evaluator") ||
      !isNonemptyString(value.message)
    ) {
      throw new Error("Stored episode failure row identity is invalid.");
    }
    if (value.source === "episode_lifecycle") {
      const unknownFields = Object.keys(value).filter(
        (key) => !["schemaVersion", "kind", "runId", "source", "stage", "code", "message"].includes(key)
      );
      if (
        unknownFields.length > 0 ||
        value.stage !== "execution" ||
        value.code !== "episode_failed" ||
        value.message !== reviewedFailureMessage("episode_failed") ||
        value.evaluatorId !== undefined ||
        value.evaluatorVersion !== undefined
      ) {
        throw new Error("Stored episode lifecycle failure row is invalid.");
      }
    } else {
      const unknownFields = Object.keys(value).filter(
        (key) => ![
          "schemaVersion",
          "kind",
          "runId",
          "source",
          "stage",
          "code",
          "message",
          "evaluatorId",
          "evaluatorVersion"
        ].includes(key)
      );
      if (unknownFields.length > 0) throw new Error("Stored evaluator failure row contains unknown fields.");
      assertEvaluatorFailure({
        evaluatorId: value.evaluatorId,
        label: "stored evaluator",
        version: value.evaluatorVersion,
        stage: value.stage,
        code: value.code,
        message: value.message
      });
      if (value.message !== reviewedFailureMessage(value.code as HarnessEvaluatorFailure["code"])) {
        throw new Error("Stored evaluator failure row message is invalid.");
      }
    }
    rows.push(value as unknown as HarnessEpisodeFailureRow);
  }
  return rows;
}

function assertEvaluationReport(report: HarnessEvaluationReport): void {
  assertJsonData(report, "Episode evaluation report contains unsupported non-JSON data.");
  if (!isRecord(report) || !isNonemptyString(report.id) || !isNonemptyString(report.createdAt)) {
    throw new Error("Episode evaluation report identity is invalid.");
  }
  if (!Number.isFinite(Date.parse(report.createdAt))) throw new Error("Episode evaluation report createdAt is invalid.");
  if (
    !Array.isArray(report.metrics) ||
    !Array.isArray(report.failures ?? []) ||
    !Array.isArray(report.evaluatorIds) ||
    !isRecord(report.outputs) ||
    !isRecord(report.summary)
  ) {
    throw new Error("Episode evaluation report records are invalid.");
  }
  if (report.status !== undefined && report.status !== "completed" && report.status !== "incomplete") {
    throw new Error("Episode evaluation report status is invalid.");
  }
  const evaluatorIds = new Set<string>();
  for (const evaluatorId of report.evaluatorIds) {
    if (!isNonemptyString(evaluatorId) || evaluatorIds.has(evaluatorId)) {
      throw new Error("Episode evaluation report evaluatorIds are invalid.");
    }
    evaluatorIds.add(evaluatorId);
  }
  const registry = report.evaluatorRegistry ?? [];
  if (!Array.isArray(registry)) throw new Error("Episode evaluation report evaluatorRegistry is invalid.");
  const registryIds = new Map<string, string>();
  for (const evaluator of registry) {
    if (!isRecord(evaluator) || !isNonemptyString(evaluator.id) || !isNonemptyString(evaluator.version)) {
      throw new Error("Episode evaluation report evaluator registry identity is invalid.");
    }
    if (registryIds.has(evaluator.id)) throw new Error("Episode evaluation report evaluator registry contains duplicate ids.");
    registryIds.set(evaluator.id, evaluator.version);
  }
  for (const evaluatorId of evaluatorIds) {
    if (registry.length > 0 && !registryIds.has(evaluatorId)) throw new Error("Episode evaluation report evaluator coverage is incomplete.");
    if (!Object.prototype.hasOwnProperty.call(report.outputs, evaluatorId)) {
      throw new Error("Episode evaluation report output coverage is incomplete.");
    }
  }
  if (!Number.isInteger(report.metricCount) || report.metricCount !== report.metrics.length) {
    throw new Error("Episode evaluation report metricCount does not match metrics.");
  }
  for (const metric of report.metrics) {
    assertMetricRecord(metric);
    if (metric.evaluatorId && registry.length > 0 && registryIds.get(metric.evaluatorId) !== metric.evaluatorVersion) {
      throw new Error("Episode evaluation metric evaluator identity is not registered.");
    }
  }
  for (const failure of report.failures ?? []) {
    assertEvaluatorFailure(failure);
    if (!isNonemptyString(failure.label) || failure.message !== reviewedFailureMessage(failure.code)) {
      throw new Error("Episode evaluation report contains an unreviewed evaluator failure.");
    }
    if (registry.length > 0 && registryIds.get(failure.evaluatorId) !== failure.version) {
      throw new Error("Episode evaluation failure evaluator identity is not registered.");
    }
  }
  if (report.warnings !== undefined && !Array.isArray(report.warnings)) {
    throw new Error("Episode evaluation report warnings are invalid.");
  }
  if (report.status === "completed" && (report.failures?.length ?? 0) > 0) {
    throw new Error("Completed episode evaluation report cannot contain failures.");
  }
  if (report.status === "incomplete" && (report.failures?.length ?? 0) === 0) {
    throw new Error("Incomplete episode evaluation report requires a controlled failure record.");
  }
}

function assertMetricRecord(value: unknown): asserts value is HarnessMetricRecord {
  if (!isRecord(value)) throw new Error("Episode metric must be a record.");
  if (!isNonemptyString(value.id) || !isNonemptyString(value.label) || !isNonemptyString(value.source)) {
    throw new Error("Episode metric identity is invalid.");
  }
  if (!["episode", "team", "agent", "profile", "model", "role", "seat"].includes(String(value.scope))) {
    throw new Error("Episode metric scope is invalid.");
  }
  const metricValue = value.value;
  if (
    metricValue !== null &&
    typeof metricValue !== "string" &&
    typeof metricValue !== "boolean" &&
    !(typeof metricValue === "number" && Number.isFinite(metricValue))
  ) {
    throw new Error("Episode metric value is invalid.");
  }
  if (value.evidenceRefs !== undefined && !Array.isArray(value.evidenceRefs)) {
    throw new Error("Episode metric evidenceRefs must be an array when present.");
  }
  assertJsonData(value, "Episode metric contains unsupported non-JSON data.");
}

function assertEvaluatorFailure(value: unknown): asserts value is HarnessEvaluatorFailure {
  if (!isRecord(value)) throw new Error("Evaluator failure must be a record.");
  if (!isNonemptyString(value.evaluatorId) || !isNonemptyString(value.version)) {
    throw new Error("Evaluator failure identity is invalid.");
  }
  const validPair =
    (value.stage === "evaluate" && value.code === "evaluator_exception") ||
    (value.stage === "result_normalization" && value.code === "invalid_module_result");
  if (!validPair) throw new Error("Evaluator failure stage/code pair is invalid.");
}

function reviewedFailureMessage(
  code: "episode_failed" | HarnessEvaluatorFailure["code"]
): string {
  if (code === "episode_failed") return "Harness episode ended with a failed lifecycle; inspect canonical trajectory evidence.";
  if (code === "evaluator_exception") return "Evaluator execution failed; no metrics or output were recorded.";
  return "Evaluator returned an invalid module result; no metrics or output were recorded.";
}

function trajectoryJsonl(artifact: GenericEpisodeEnvelope): string {
  const rows: unknown[] = [
    {
      schemaVersion: HARNESS_EPISODE_TRAJECTORY_HEADER_VERSION,
      kind: "episode-trajectory-header",
      runId: artifact.runId,
      artifactVersion: artifact.artifactVersion,
      status: artifact.status,
      domainId: artifact.socialEpisode.domainId,
      schedulerMode: artifact.socialEpisode.schedulerMode,
      nativeStepCount: artifact.socialEpisode.steps.length,
      messageCount: artifact.socialEpisode.messages.length
    },
    ...artifact.socialEpisode.steps.map((step, index) => ({
      schemaVersion: HARNESS_EPISODE_TRAJECTORY_STEP_VERSION,
      kind: "episode-trajectory-step",
      runId: artifact.runId,
      index,
      step
    })),
    ...artifact.socialEpisode.messages.map((message, index) => ({
      schemaVersion: HARNESS_EPISODE_TRAJECTORY_MESSAGE_VERSION,
      kind: "episode-trajectory-message",
      runId: artifact.runId,
      index,
      message
    }))
  ];
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function readSafeFile(directory: string, fileName: string): Promise<string> {
  const candidate = path.join(directory, fileName);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Stored episode artifact file is not a regular file.");
  const realDirectory = await realpath(directory);
  const realCandidate = await realpath(candidate);
  if (!isStrictlyInside(realCandidate, realDirectory)) throw new Error("Stored episode artifact file escaped its directory.");
  return readFile(candidate, "utf8");
}

async function assertDirectory(directory: string, message: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(message);
}

async function assertDirectoryInside(parent: string, directory: string, message: string): Promise<void> {
  await assertDirectory(parent, message);
  await assertDirectory(directory, message);
  const realParent = await realpath(parent);
  const realDirectory = await realpath(directory);
  if (!isStrictlyInside(realDirectory, realParent)) throw new Error(message);
}

async function assertPathMissing(candidate: string, message: string): Promise<void> {
  try {
    await lstat(candidate);
    throw new Error(message);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function assertWritableFileTarget(candidate: string, message: string): Promise<void> {
  try {
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(message);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

function assertArtifactIdentity(artifact: GenericEpisodeEnvelope): void {
  assertRunId(artifact.runId);
  if (!artifact.artifactVersion.trim()) throw new Error("Episode artifact artifactVersion is required.");
  if (!artifact.kind.trim()) throw new Error("Episode artifact kind is required.");
  if (!artifact.createdAt.trim()) throw new Error("Episode artifact createdAt is required.");
}

function assertCheckpointIdentity(
  checkpoint: GenericCheckpointEnvelope,
  artifact: GenericEpisodeEnvelope
): void {
  assertCheckpointId(checkpoint.checkpointId);
  if (!checkpoint.artifactVersion.trim()) throw new Error("Harness checkpoint artifactVersion is required.");
  if (!checkpoint.kind.trim()) throw new Error("Harness checkpoint kind is required.");
  if (!checkpoint.createdAt.trim()) throw new Error("Harness checkpoint createdAt is required.");
  if (checkpoint.source.runId !== artifact.runId) {
    throw new Error("Harness checkpoint source run id does not match its canonical episode artifact.");
  }
  if (checkpoint.source.sourceArtifactVersion !== artifact.artifactVersion) {
    throw new Error("Harness checkpoint source artifact version does not match its canonical episode artifact.");
  }
  if (checkpoint.executionPrefix.id !== artifact.runId) {
    throw new Error("Harness checkpoint execution prefix id does not match its canonical episode artifact.");
  }
  if (
    checkpoint.source.nativeStepCount > artifact.socialEpisode.steps.length ||
    hashStableState(checkpoint.executionPrefix.steps) !==
      hashStableState(artifact.socialEpisode.steps.slice(0, checkpoint.source.nativeStepCount))
  ) {
    throw new Error("Harness checkpoint steps are not a canonical prefix of the episode artifact.");
  }
  if (
    checkpoint.source.messageCount > artifact.socialEpisode.messages.length ||
    hashStableState(checkpoint.executionPrefix.messages) !==
      hashStableState(artifact.socialEpisode.messages.slice(0, checkpoint.source.messageCount))
  ) {
    throw new Error("Harness checkpoint messages are not a canonical prefix of the episode artifact.");
  }
  for (const [label, checkpointValue, artifactValue] of [
    ["initial state", checkpoint.executionPrefix.initialState, artifact.socialEpisode.initialState],
    ["channels", checkpoint.executionPrefix.channels, artifact.socialEpisode.channels],
    ["domain adapter", checkpoint.executionPrefix.domainAdapter, artifact.socialEpisode.domainAdapter],
    ["runtime actors", checkpoint.executionPrefix.runtimeActorIds, artifact.socialEpisode.runtimeActorIds]
  ] as const) {
    if (hashStableState(checkpointValue) !== hashStableState(artifactValue)) {
      throw new Error(`Harness checkpoint ${label} does not match its canonical episode artifact.`);
    }
  }
  if (
    checkpoint.executionPrefix.domainId !== artifact.socialEpisode.domainId ||
    checkpoint.executionPrefix.schedulerMode !== artifact.socialEpisode.schedulerMode
  ) {
    throw new Error("Harness checkpoint domain or scheduler does not match its canonical episode artifact.");
  }
  if ((checkpoint.source.experiment === undefined) !== (artifact.experiment === undefined)) {
    throw new Error("Harness checkpoint experiment provenance does not match its canonical episode artifact.");
  }
  if (
    checkpoint.source.experiment !== undefined &&
    artifact.experiment !== undefined &&
    hashStableState(checkpoint.source.experiment) !== hashStableState(artifact.experiment)
  ) {
    throw new Error("Harness checkpoint experiment provenance does not match its canonical episode artifact.");
  }
}

function assertRunId(runId: string): void {
  if (typeof runId !== "string" || !runId.trim() || runId.length > 1024 || runId.includes("\0")) {
    throw new Error("Episode artifact runId must be a nonempty bounded string.");
  }
}

function assertCheckpointId(checkpointId: string): void {
  if (
    typeof checkpointId !== "string" ||
    !checkpointId.trim() ||
    checkpointId.length > 1024 ||
    checkpointId.includes("\0")
  ) {
    throw new Error("Harness checkpoint id must be a nonempty bounded string.");
  }
}

function directoryKeyForRunId(runId: string): string {
  assertRunId(runId);
  return sha256(runId);
}

function directoryKeyForCheckpointId(checkpointId: string): string {
  assertCheckpointId(checkpointId);
  return sha256(checkpointId);
}

function compareEntries(left: HarnessEpisodeStoreEntry, right: HarnessEpisodeStoreEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId);
}

function compareCheckpointEntries(
  left: HarnessEpisodeCheckpointStoreEntry,
  right: HarnessEpisodeCheckpointStoreEntry
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.checkpointId.localeCompare(right.checkpointId);
}

function cloneEntry(entry: HarnessEpisodeStoreEntry): HarnessEpisodeStoreEntry {
  return { ...entry };
}

function cloneCheckpointEntry(entry: HarnessEpisodeCheckpointStoreEntry): HarnessEpisodeCheckpointStoreEntry {
  return { ...entry };
}

function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonLines(values: readonly unknown[]): string {
  return values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}

function parseJsonLines(text: string): unknown[] {
  if (!text) return [];
  if (!text.endsWith("\n")) throw new Error("Stored JSONL must end with a newline.");
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => !line)) throw new Error("Stored JSONL contains an empty row.");
  return lines.map((line) => JSON.parse(line) as unknown);
}

function jsonClone<T>(value: T, message: string): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error(message);
    return JSON.parse(serialized) as T;
  } catch {
    throw new Error(message);
  }
}

function assertJsonData(value: unknown, message: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(message);
    return;
  }
  if (typeof value !== "object") throw new Error(message);
  if (seen.has(value)) throw new Error(message);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonData(item, message, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
    for (const item of Object.values(value as Record<string, unknown>)) {
      if (item === undefined) throw new Error(message);
      assertJsonData(item, message, seen);
    }
  }
  seen.delete(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isStrictlyInside(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && DIRECTORY_KEY_PATTERN.test(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isMissing(error: unknown): boolean {
  return isNotFound(error);
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

async function waitForStoreLease(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(STORE_LEASE_ACQUIRED_MARKER)) finish(resolve);
    };
    const onStderr = (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_024); };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(() => reject(new Error(
      `Episode artifact store lease failed before acquisition (code=${code}, signal=${signal}${stderr ? `, detail=${stderr.trim()}` : ""}).`
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

async function releaseStoreLease(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.stdin.end();
  await exited;
}
