import { entryForArtifact, entryFromManifest, isValidLegacyV1Manifest, isValidLegacyV2Manifest, isValidLegacyV3Manifest, isValidManifest, manifestForArtifact, parseEpisodeStoreIndexEntries, projectionEntryFromManifest, readProjection } from "./manifests";
import { assertEvaluationReport, checkpointEntryFromManifest, checkpointManifestFor, emptyCheckpointIndex, evaluationRecordJson, failureRowsForArtifact, isValidCheckpointManifest, metricFromRow, metricRowsForArtifact, parseEvaluationRecord, parseFailureRows, parseMetricRows, trajectoryJsonl } from "./records";
import { assertArtifactIdentity, assertCheckpointId, assertCheckpointIdentity, assertDirectory, assertDirectoryInside, assertJsonData, assertPathMissing, assertRunId, assertWritableFileTarget, cloneCheckpointEntry, cloneEntry, compareCheckpointEntries, compareEntries, directoryKeyForCheckpointId, directoryKeyForRunId, isAlreadyExists, isMissing, isRecord, jsonClone, jsonDocument, jsonLines, readSafeFile, releaseStoreLease, sha256, waitForStoreLease } from "./support";
import { HarnessEpisodeProjectionEnvelope, validateHarnessEpisodeProjectionEnvelope } from "../episodeArtifacts";
import { hashStableJsonValue } from "../hash";
import { HarnessEvaluationReport, HarnessMetricRecord } from "../types";
import { ARTIFACT_FILE, CHECKPOINTS_DIRECTORY, CHECKPOINT_FILE, CHECKPOINT_INDEX_FILE, CanonicalEpisodeArtifactVerification, CanonicalEpisodeArtifactVerifier, CanonicalHarnessCheckpointVerifier, DIRECTORY_KEY_PATTERN, EPISODES_DIRECTORY, EVALUATION_FILE, FAILURES_FILE, GenericCheckpointEnvelope, GenericEpisodeEnvelope, HARNESS_EPISODE_CHECKPOINT_INDEX_VERSION, HARNESS_EPISODE_STORE_INDEX_VERSION, HarnessEpisodeArtifactStoreOptions, HarnessEpisodeCheckpointStoreEntry, HarnessEpisodeCheckpointStoreIndex, HarnessEpisodeCheckpointStoreManifest, HarnessEpisodeFailureRow, HarnessEpisodeMetricRow, HarnessEpisodeStoreEntry, HarnessEpisodeStoreIndex, HarnessEpisodeStoreManifest, HarnessEpisodeStorePutOptions, INDEX_FILE, INVALID_PROJECTION, LOCKS_DIRECTORY, MANIFEST_FILE, METRICS_FILE, PROJECTION_FILE, STORE_LEASE_ACQUIRED_MARKER, TRAJECTORY_FILE } from "./model";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
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
