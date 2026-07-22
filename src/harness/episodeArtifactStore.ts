import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessCheckpointEnvelope, HarnessEpisodeArtifactEnvelope } from "./episodeArtifacts";
import { hashStableState } from "./hash";
import type { HarnessEvaluationReport, HarnessEvaluatorFailure, HarnessMetricRecord } from "./types";

export const HARNESS_EPISODE_STORE_INDEX_VERSION = "harness.episode-store-index.v2";
export const HARNESS_EPISODE_STORE_MANIFEST_VERSION = "harness.episode-store-manifest.v2";
export const HARNESS_EPISODE_TRAJECTORY_HEADER_VERSION = "harness.episode-trajectory.header.v1";
export const HARNESS_EPISODE_TRAJECTORY_STEP_VERSION = "harness.episode-trajectory.step.v1";
export const HARNESS_EPISODE_TRAJECTORY_MESSAGE_VERSION = "harness.episode-trajectory.message.v1";
export const HARNESS_EPISODE_METRIC_ROW_VERSION = "harness.episode-metric.v1";
export const HARNESS_EPISODE_FAILURE_ROW_VERSION = "harness.episode-failure.v1";
export const HARNESS_EPISODE_CHECKPOINT_INDEX_VERSION = "harness.episode-checkpoint-index.v1";
export const HARNESS_EPISODE_CHECKPOINT_MANIFEST_VERSION = "harness.episode-checkpoint-manifest.v1";

const EPISODES_DIRECTORY = "episodes";
const INDEX_FILE = "index.json";
const ARTIFACT_FILE = "artifact.json";
const MANIFEST_FILE = "manifest.json";
const TRAJECTORY_FILE = "trajectory.jsonl";
const METRICS_FILE = "metrics.jsonl";
const FAILURES_FILE = "failures.jsonl";
const CHECKPOINTS_DIRECTORY = "checkpoints";
const CHECKPOINT_INDEX_FILE = "checkpoints.index.json";
const CHECKPOINT_FILE = "checkpoint.json";
const DIRECTORY_KEY_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_EPISODE_STORE_MANIFEST_VERSION = "harness.episode-store-manifest.v1";

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
}

export interface HarnessEpisodeStoreManifest extends HarnessEpisodeStoreEntry {
  schemaVersion: typeof HARNESS_EPISODE_STORE_MANIFEST_VERSION;
  manifestKind: "episode-store-manifest";
  artifactSha256: string;
  trajectorySha256: string;
  metricsSha256: string;
  failuresSha256: string;
  evaluationReportId?: string;
  files: {
    artifact: typeof ARTIFACT_FILE;
    trajectory: typeof TRAJECTORY_FILE;
    metrics: typeof METRICS_FILE;
    failures: typeof FAILURES_FILE;
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
 *   <base>/episodes/<sha256(runId)>/{manifest.json,artifact.json,trajectory.jsonl}
 *
 * Neither run ids nor artifact data become paths. Every artifact is strongly
 * verified before publication and again on every read/recovery operation.
 */
export class HarnessEpisodeArtifactStore<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope = GenericCheckpointEnvelope
> {
  private readonly root: string;
  private readonly episodesDirectory: string;
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
    const evaluationReport = options.evaluationReport
      ? jsonClone(options.evaluationReport, "Episode evaluation report is not JSON serializable.")
      : undefined;
    const metricRows = metricRowsForArtifact(canonical, evaluationReport);
    const failureRows = failureRowsForArtifact(canonical, evaluationReport);

    const directoryKey = directoryKeyForRunId(canonical.runId);
    const finalDirectory = path.join(this.episodesDirectory, directoryKey);
    await assertPathMissing(finalDirectory, "Episode artifact already exists for this run id.");
    if (this.entries.has(canonical.runId)) throw new Error("Episode artifact already exists for this run id.");

    const artifactText = jsonDocument(canonical);
    const trajectoryText = trajectoryJsonl(canonical);
    const metricsText = jsonLines(metricRows);
    const failuresText = jsonLines(failureRows);
    const manifest = manifestForArtifact(
      canonical,
      directoryKey,
      artifactText,
      trajectoryText,
      metricsText,
      failuresText,
      evaluationReport?.id
    );
    const temporaryDirectory = path.join(this.episodesDirectory, `.tmp-${randomUUID()}`);
    await mkdir(temporaryDirectory, { recursive: false });
    try {
      await assertDirectoryInside(this.episodesDirectory, temporaryDirectory, "Episode artifact staging directory is not safe.");
      await writeFile(path.join(temporaryDirectory, ARTIFACT_FILE), artifactText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, TRAJECTORY_FILE), trajectoryText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, METRICS_FILE), metricsText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, FAILURES_FILE), failuresText, { encoding: "utf8", flag: "wx" });
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
      throw error;
    }

    const entry = entryFromManifest(manifest);
    this.entries.set(entry.runId, entry);
    this.checkpoints.set(entry.runId, new Map());
    await this.writeIndex();
    return cloneEntry(entry);
  }

  async get(runId: string): Promise<TArtifact | undefined> {
    const loaded = await this.loadKnownEpisode(runId);
    if (!loaded) return undefined;
    return jsonClone(loaded.artifact, "Stored episode artifact could not be cloned.");
  }

  async list(): Promise<HarnessEpisodeStoreEntry[]> {
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

  async putCheckpoint(runId: string, checkpoint: TCheckpoint): Promise<HarnessEpisodeCheckpointStoreEntry> {
    const loadedEpisode = await this.loadKnownEpisode(runId);
    if (!loadedEpisode) throw new Error("Episode artifact does not exist for this run id.");
    const canonical = jsonClone(checkpoint, "Harness checkpoint is not JSON serializable.");
    assertCheckpointIdentity(canonical, loadedEpisode.artifact);
    await this.assertCanonicalCheckpoint(canonical);

    const checkpointEntries = this.checkpoints.get(runId) ?? new Map<string, HarnessEpisodeCheckpointStoreEntry>();
    if (checkpointEntries.has(canonical.checkpointId)) {
      throw new Error("Harness checkpoint already exists for this checkpoint id.");
    }
    const checkpointsDirectory = path.join(this.episodesDirectory, loadedEpisode.entry.directoryKey, CHECKPOINTS_DIRECTORY);
    await assertDirectoryInside(
      path.join(this.episodesDirectory, loadedEpisode.entry.directoryKey),
      checkpointsDirectory,
      "Episode checkpoint directory is not safe."
    );
    const directoryKey = directoryKeyForCheckpointId(canonical.checkpointId);
    const finalDirectory = path.join(checkpointsDirectory, directoryKey);
    await assertPathMissing(finalDirectory, "Harness checkpoint already exists for this checkpoint id.");
    const checkpointText = jsonDocument(canonical);
    const manifest = checkpointManifestFor(canonical, directoryKey, checkpointText);
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
    await this.writeIndex();
    return cloneCheckpointEntry(entry);
  }

  async getCheckpoint(runId: string, checkpointId: string): Promise<TCheckpoint | undefined> {
    assertRunId(runId);
    assertCheckpointId(checkpointId);
    const loadedEpisode = await this.loadKnownEpisode(runId);
    const known = this.checkpoints.get(runId)?.get(checkpointId);
    if (!loadedEpisode || !known) return undefined;
    const loaded = await this.loadCheckpointDirectory(
      loadedEpisode.entry.directoryKey,
      loadedEpisode.artifact,
      known.directoryKey,
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
    await assertWritableFileTarget(path.join(this.root, INDEX_FILE), "Episode artifact index is not a safe regular file.");

    const recovered = new Map<string, HarnessEpisodeStoreEntry>();
    const recoveredCheckpoints = new Map<string, Map<string, HarnessEpisodeCheckpointStoreEntry>>();
    const children = await readdir(this.episodesDirectory, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory() || !DIRECTORY_KEY_PATTERN.test(child.name)) continue;
      const loaded = await this.loadDirectory(child.name);
      if (!loaded || recovered.has(loaded.entry.runId)) continue;
      const checkpoints = await this.recoverCheckpointRegistry(child.name, loaded.artifact);
      recovered.set(loaded.entry.runId, { ...loaded.entry, checkpointCount: checkpoints.size });
      recoveredCheckpoints.set(loaded.entry.runId, checkpoints);
    }
    this.entries.clear();
    for (const [runId, entry] of recovered) this.entries.set(runId, entry);
    this.checkpoints.clear();
    for (const [runId, entries] of recoveredCheckpoints) this.checkpoints.set(runId, entries);
    await this.writeIndex();
  }

  private async loadKnownEpisode(
    runId: string
  ): Promise<{
    artifact: TArtifact;
    entry: HarnessEpisodeStoreEntry;
    metrics: HarnessEpisodeMetricRow[];
    failures: HarnessEpisodeFailureRow[];
  } | undefined> {
    assertRunId(runId);
    const known = this.entries.get(runId);
    if (!known) return undefined;
    const loaded = await this.loadDirectory(known.directoryKey, runId);
    if (!loaded) throw new Error("Stored episode artifact failed canonical recovery validation.");
    loaded.entry.checkpointCount = this.checkpoints.get(runId)?.size ?? 0;
    return loaded;
  }

  private async loadDirectory(
    directoryKey: string,
    expectedRunId?: string
  ): Promise<{
    artifact: TArtifact;
    entry: HarnessEpisodeStoreEntry;
    metrics: HarnessEpisodeMetricRow[];
    failures: HarnessEpisodeFailureRow[];
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
      if (isValidLegacyManifest(manifest, directoryKey, artifact)) {
        if (sha256(artifactText) !== manifest.artifactSha256) return undefined;
        if (sha256(recordedTrajectory) !== manifest.trajectorySha256) return undefined;
        await this.assertCanonical(artifact);
        return {
          artifact,
          entry: entryForArtifact(artifact, directoryKey),
          metrics: [],
          failures: []
        };
      }
      if (!isValidManifest(manifest, directoryKey, artifact)) return undefined;
      const recordedMetrics = await readSafeFile(directory, METRICS_FILE);
      const recordedFailures = await readSafeFile(directory, FAILURES_FILE);
      if (sha256(artifactText) !== manifest.artifactSha256) return undefined;
      if (sha256(recordedTrajectory) !== manifest.trajectorySha256) return undefined;
      if (sha256(recordedMetrics) !== manifest.metricsSha256) return undefined;
      if (sha256(recordedFailures) !== manifest.failuresSha256) return undefined;
      const metrics = parseMetricRows(recordedMetrics, artifact.runId, manifest.evaluationReportId);
      const failures = parseFailureRows(recordedFailures, artifact.runId);
      if (metrics.length !== manifest.metricCount || failures.length !== manifest.failureCount) return undefined;
      await this.assertCanonical(artifact);
      return { artifact, entry: entryFromManifest(manifest), metrics, failures };
    } catch {
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
    artifact: TArtifact
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
    await this.writeCheckpointIndex(artifact.runId, episodeDirectoryKey, recovered);
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

  private async writeIndex(): Promise<void> {
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

function manifestForArtifact(
  artifact: GenericEpisodeEnvelope,
  directoryKey: string,
  artifactText: string,
  trajectoryText: string,
  metricsText: string,
  failuresText: string,
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
    evaluationReportId,
    files: {
      artifact: ARTIFACT_FILE,
      trajectory: TRAJECTORY_FILE,
      metrics: METRICS_FILE,
      failures: FAILURES_FILE,
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
    checkpointCount: 0
  };
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

function isValidLegacyManifest(
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
    value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_VERSION &&
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
  if (!isRecord(report) || !isNonemptyString(report.id) || !isNonemptyString(report.createdAt)) {
    throw new Error("Episode evaluation report identity is invalid.");
  }
  if (!Array.isArray(report.metrics) || !Array.isArray(report.failures ?? [])) {
    throw new Error("Episode evaluation report records are invalid.");
  }
  if (!Number.isInteger(report.metricCount) || report.metricCount !== report.metrics.length) {
    throw new Error("Episode evaluation report metricCount does not match metrics.");
  }
  for (const metric of report.metrics) assertMetricRecord(metric);
  for (const failure of report.failures ?? []) assertEvaluatorFailure(failure);
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

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
