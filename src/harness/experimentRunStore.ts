import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessEpisodeArtifactEnvelope } from "./episodeArtifacts";
import {
  validateGenericExperimentProvenance,
  type GenericExperimentProvenanceV1
} from "./experimentSpec";
import type { GenericTournamentRunSetArtifact } from "./genericTournamentArtifacts";
import { validateGenericTournamentRunSetArtifact } from "./genericTournamentArtifacts";
import { hashStableJsonValue } from "./hash";
import { GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } from "./tournamentRunner";
import type { HarnessMetricRecord } from "./types";

export const HARNESS_EXPERIMENT_RUN_RECORD_VERSION = "harness.experiment-run-record.v1";
export const HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION = "harness.experiment-run-manifest.v1";
export const HARNESS_EXPERIMENT_RUN_INDEX_VERSION = "harness.experiment-run-index.v1";

const RUNS_DIRECTORY = "runs";
const REVISIONS_DIRECTORY = "revisions";
const RECORD_FILE = "record.json";
const MANIFEST_FILE = "manifest.json";
const INDEX_FILE = "index.json";
const DIRECTORY_KEY_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_DIRECTORY_PATTERN = /^(\d{12})-([a-f0-9]{16})$/;

type GenericEpisodeEnvelope = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;

export interface GenericExperimentEpisodeAuthority<TArtifact extends GenericEpisodeEnvelope> {
  /** Must be the canonical store read path; it is expected to re-verify on every read. */
  get(runId: string): Promise<TArtifact | undefined>;
  getMetrics(runId: string): Promise<HarnessMetricRecord[] | undefined>;
  getFailures(runId: string): Promise<readonly unknown[] | undefined>;
}

export interface HarnessExperimentRunEpisodeReferenceV1 {
  index: number;
  seed: string;
  status: "completed" | "truncated" | "failed";
  runId?: string;
  artifactSha256?: string;
  metricCount: number;
  failureCount: number;
  error?: typeof GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE;
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

export interface HarnessExperimentRunManifestV1 {
  schemaVersion: typeof HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION;
  kind: "experiment-run-manifest";
  runSetId: string;
  directoryKey: string;
  revision: number;
  state: HarnessExperimentRunRecordV1["state"];
  recordSha256: string;
  files: {
    record: typeof RECORD_FILE;
    manifest: typeof MANIFEST_FILE;
  };
}

export interface HarnessExperimentRunStoreEntry {
  runSetId: string;
  specId: string;
  specHash: string;
  domainId: string;
  createdAt: string;
  updatedAt: string;
  directoryKey: string;
  revision: number;
  state: HarnessExperimentRunRecordV1["state"];
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
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
  private readonly episodeStore: GenericExperimentEpisodeAuthority<TArtifact>;
  private readonly now: () => string;
  private readonly entries = new Map<string, HarnessExperimentRunStoreEntry>();
  private readonly finalizing = new Set<string>();

  private constructor(options: HarnessExperimentRunStoreOptions<TArtifact>) {
    if (!options.baseDirectory.trim()) throw new Error("Experiment run store baseDirectory is required.");
    if (!options.episodeStore || typeof options.episodeStore.get !== "function") {
      throw new Error("Experiment run store requires a canonical episode store.");
    }
    this.root = path.resolve(options.baseDirectory);
    this.runsDirectory = path.join(this.root, RUNS_DIRECTORY);
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
      // Temporary directories are ignored by recovery. Avoid deleting a path
      // that could have been replaced by another process after publication.
      throw error;
    }
    const entry = entryFromRecord(record, directoryKey, 1);
    this.entries.set(entry.runSetId, entry);
    await this.writeIndex();
    return structuredClone(entry);
  }

  async finalize<TEmbeddedArtifact extends TArtifact>(
    runSet: GenericTournamentRunSetArtifact<TEmbeddedArtifact>
  ): Promise<HarnessExperimentRunStoreEntry> {
    if (this.finalizing.has(runSet.runSetId)) throw new Error("Experiment run finalization is already in progress.");
    this.finalizing.add(runSet.runSetId);
    try {
      const loaded = await this.loadKnownRun(runSet.runSetId);
      if (!loaded) throw new Error("Experiment run must begin before it can be finalized.");
      if (loaded.record.state !== "active") throw new Error("Experiment run is already finalized.");
      const refs = await this.referencesForRunSet(runSet, loaded.record);
      const record: HarnessExperimentRunRecordV1 = {
        schemaVersion: HARNESS_EXPERIMENT_RUN_RECORD_VERSION,
        kind: "experiment-run-record",
        state: "finalized",
        runSetId: loaded.record.runSetId,
        createdAt: loaded.record.createdAt,
        updatedAt: this.now(),
        experiment: structuredClone(loaded.record.experiment),
        gamesRequested: runSet.gamesRequested,
        gamesCompleted: runSet.gamesCompleted,
        gamesTruncated: runSet.gamesTruncated,
        gamesFailed: runSet.gamesFailed,
        gamesUnstarted: runSet.gamesUnstarted ?? runSet.gamesRequested - runSet.episodes.length,
        episodes: refs
      };
      assertRunRecord(record);
      const revisionsDirectory = path.join(this.runsDirectory, loaded.entry.directoryKey, REVISIONS_DIRECTORY);
      await assertDirectoryInside(
        path.join(this.runsDirectory, loaded.entry.directoryKey),
        revisionsDirectory,
        "Experiment run revisions directory is not safe."
      );
      await this.writeRevision(revisionsDirectory, loaded.entry.directoryKey, loaded.entry.revision + 1, record);
      const entry = entryFromRecord(record, loaded.entry.directoryKey, loaded.entry.revision + 1);
      this.entries.set(entry.runSetId, entry);
      await this.writeIndex();
      return structuredClone(entry);
    } finally {
      this.finalizing.delete(runSet.runSetId);
    }
  }

  async get(runSetId: string): Promise<HarnessExperimentRunRecordV1 | undefined> {
    const loaded = await this.loadKnownRun(runSetId);
    return loaded ? structuredClone(loaded.record) : undefined;
  }

  async list(): Promise<HarnessExperimentRunStoreEntry[]> {
    const verified: HarnessExperimentRunStoreEntry[] = [];
    for (const entry of [...this.entries.values()].sort(compareEntries)) {
      const loaded = await this.loadDirectory(entry.directoryKey, entry.runSetId);
      if (!loaded) throw new Error("Stored experiment run failed canonical recovery validation.");
      verified.push(structuredClone(loaded.entry));
    }
    return verified;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await assertDirectory(this.root, "Experiment run store root is not a safe directory.");
    await mkdir(this.runsDirectory, { recursive: true });
    await assertDirectoryInside(this.root, this.runsDirectory, "Experiment runs directory is not safe.");
    await assertWritableFileTarget(path.join(this.root, INDEX_FILE), "Experiment run index is not a safe regular file.");

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
    await this.writeIndex();
  }

  private async referencesForRunSet<TEmbeddedArtifact extends TArtifact>(
    runSet: GenericTournamentRunSetArtifact<TEmbeddedArtifact>,
    header: HarnessExperimentRunRecordV1
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
      if (!episode.artifact) {
        refs.push({
          index: episode.index,
          seed: episode.seed,
          status: episode.status,
          metricCount: 0,
          failureCount: 0,
          ...(episode.status === "failed" ? { error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } : {})
        });
        continue;
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
      if (!metrics || !failures) throw new Error(`Canonical episode ${episode.runId} sidecars are missing.`);
      refs.push({
        index: episode.index,
        seed: episode.seed,
        status: episode.status,
        runId: episode.runId,
        artifactSha256: hashStableJsonValue(canonical),
        metricCount: metrics.length,
        failureCount: failures.length,
        ...(episode.status === "failed" ? { error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } : {})
      });
    }
    return refs;
  }

  private async loadKnownRun(runSetId: string): Promise<{ record: HarnessExperimentRunRecordV1; entry: HarnessExperimentRunStoreEntry } | undefined> {
    assertIdentifier(runSetId, "runSetId");
    const known = this.entries.get(runSetId);
    if (!known) return undefined;
    const loaded = await this.loadDirectory(known.directoryKey, runSetId);
    if (!loaded) throw new Error("Stored experiment run failed canonical recovery validation.");
    return loaded;
  }

  private async loadDirectory(
    directoryKey: string,
    expectedRunSetId?: string
  ): Promise<{ record: HarnessExperimentRunRecordV1; entry: HarnessExperimentRunStoreEntry } | undefined> {
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
    if (children.length > 2) throw new Error("Stored experiment run has an unsupported revision history.");
    let latest: { record: HarnessExperimentRunRecordV1; entry: HarnessExperimentRunStoreEntry } | undefined;
    let header: HarnessExperimentRunRecordV1 | undefined;
    for (const [position, child] of children.entries()) {
      const match = REVISION_DIRECTORY_PATTERN.exec(child.name)!;
      const revision = Number(match[1]);
      if (revision !== position + 1) throw new Error("Experiment run revisions must be contiguous and ordered.");
      const revisionDirectory = path.join(revisionsDirectory, child.name);
      await assertDirectoryInside(revisionsDirectory, revisionDirectory, "Stored experiment revision directory is not safe.");
      const recordText = await readSafeFile(revisionDirectory, RECORD_FILE);
      const manifestText = await readSafeFile(revisionDirectory, MANIFEST_FILE);
      const record = JSON.parse(recordText) as HarnessExperimentRunRecordV1;
      const manifest = JSON.parse(manifestText) as HarnessExperimentRunManifestV1;
      assertRunRecord(record);
      assertManifest(manifest, record, directoryKey, revision, recordText, child.name);
      if (revision === 1) {
        if (record.state !== "active") throw new Error("First experiment run revision must be active.");
        header = record;
      } else {
        if (!header || record.state !== "finalized") {
          throw new Error("Second experiment run revision must finalize its active header.");
        }
        if (
          record.runSetId !== header.runSetId ||
          record.createdAt !== header.createdAt ||
          record.gamesRequested !== header.gamesRequested ||
          hashStableJsonValue(record.experiment) !== hashStableJsonValue(header.experiment)
        ) {
          throw new Error("Final experiment run revision changed immutable header authority.");
        }
      }
      if (expectedRunSetId && record.runSetId !== expectedRunSetId) throw new Error("Stored experiment run id does not match the registry.");
      await this.assertEpisodeReferences(record);
      latest = { record, entry: entryFromRecord(record, directoryKey, revision) };
    }
    if (!latest) throw new Error("Stored experiment run has no recoverable canonical revision.");
    if (directoryKeyForRunSetId(latest.record.runSetId) !== directoryKey) {
      throw new Error("Stored experiment run directory key does not match runSetId.");
    }
    return latest;
  }

  private async assertEpisodeReferences(record: HarnessExperimentRunRecordV1): Promise<void> {
    if (record.state === "active") return;
    for (const episode of record.episodes) {
      if (!episode.runId) continue;
      const canonical = await this.episodeStore.get(episode.runId);
      const metrics = await this.episodeStore.getMetrics(episode.runId);
      const failures = await this.episodeStore.getFailures(episode.runId);
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
    }
  }

  private async writeRevision(
    revisionsDirectory: string,
    directoryKey: string,
    revision: number,
    record: HarnessExperimentRunRecordV1
  ): Promise<void> {
    const recordText = jsonDocument(record);
    const recordSha256 = sha256(recordText);
    const revisionName = revisionDirectoryName(revision, recordSha256);
    const finalDirectory = path.join(revisionsDirectory, revisionName);
    await assertPathMissing(finalDirectory, "Experiment run revision already exists.");
    const temporaryDirectory = path.join(revisionsDirectory, `.tmp-${randomUUID()}`);
    await mkdir(temporaryDirectory, { recursive: false });
    const manifest: HarnessExperimentRunManifestV1 = {
      schemaVersion: HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION,
      kind: "experiment-run-manifest",
      runSetId: record.runSetId,
      directoryKey,
      revision,
      state: record.state,
      recordSha256,
      files: { record: RECORD_FILE, manifest: MANIFEST_FILE }
    };
    await writeFile(path.join(temporaryDirectory, RECORD_FILE), recordText, { encoding: "utf8", flag: "wx" });
    await writeFile(path.join(temporaryDirectory, MANIFEST_FILE), jsonDocument(manifest), { encoding: "utf8", flag: "wx" });
    await rename(temporaryDirectory, finalDirectory);
  }

  private async writeIndex(): Promise<void> {
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
  }
}

function assertRunRecord(record: HarnessExperimentRunRecordV1): void {
  assertExactKeys(record, [
    "schemaVersion", "kind", "state", "runSetId", "createdAt", "updatedAt", "experiment",
    "gamesRequested", "gamesCompleted", "gamesTruncated", "gamesFailed", "gamesUnstarted", "episodes"
  ], "Experiment run record");
  if (record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION || record.kind !== "experiment-run-record") {
    throw new Error("Experiment run record version or kind is invalid.");
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
  if (!Array.isArray(record.episodes)) throw new Error("Experiment run episodes must be an array.");
  if (record.gamesRequested !== record.experiment.spec.episodeCount) throw new Error("Experiment run gamesRequested does not match provenance.");
  const counts = [record.gamesRequested, record.gamesCompleted, record.gamesTruncated, record.gamesFailed, record.gamesUnstarted];
  if (counts.some((count) => !Number.isInteger(count) || count < 0)) throw new Error("Experiment run lifecycle counts must be non-negative integers.");
  if (record.state === "active") {
    if (record.episodes.length || record.gamesCompleted || record.gamesTruncated || record.gamesFailed || record.gamesUnstarted !== record.gamesRequested) {
      throw new Error("Active experiment run must retain its untouched requested schedule.");
    }
    return;
  }
  if (record.gamesCompleted + record.gamesTruncated + record.gamesFailed + record.gamesUnstarted !== record.gamesRequested) {
    throw new Error("Finalized experiment run lifecycle counts do not cover the requested schedule.");
  }
  if (record.episodes.length !== record.gamesRequested - record.gamesUnstarted) throw new Error("Finalized experiment episode count mismatch.");
  const lifecycleCounts = { completed: 0, truncated: 0, failed: 0 };
  const runIds = new Set<string>();
  for (const [position, episode] of record.episodes.entries()) {
    assertExactKeys(episode, [
      "index", "seed", "status", "runId", "artifactSha256", "metricCount", "failureCount", "error"
    ], `Experiment run episode ${position}`);
    if (episode.index !== position || episode.seed !== `${record.experiment.spec.seed}:g${position + 1}`) {
      throw new Error("Finalized experiment episode ordering or seed is invalid.");
    }
    if (episode.status !== "completed" && episode.status !== "truncated" && episode.status !== "failed") {
      throw new Error("Finalized experiment episode lifecycle is invalid.");
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
    } else {
      if (episode.status !== "failed") throw new Error("Only a failed episode may lack a canonical artifact reference.");
      if (episode.artifactSha256 || episode.metricCount || episode.failureCount) {
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
    throw new Error("Finalized experiment lifecycle counts do not match episode references.");
  }
}

function assertManifest(
  manifest: HarnessExperimentRunManifestV1,
  record: HarnessExperimentRunRecordV1,
  directoryKey: string,
  revision: number,
  recordText: string,
  revisionDirectory: string
): void {
  assertExactKeys(manifest, [
    "schemaVersion", "kind", "runSetId", "directoryKey", "revision", "state", "recordSha256", "files"
  ], "Experiment run manifest");
  assertExactKeys(manifest.files, ["record", "manifest"], "Experiment run manifest files");
  if (manifest.schemaVersion !== HARNESS_EXPERIMENT_RUN_MANIFEST_VERSION || manifest.kind !== "experiment-run-manifest") {
    throw new Error("Experiment run manifest version or kind is invalid.");
  }
  if (
    manifest.runSetId !== record.runSetId ||
    manifest.directoryKey !== directoryKey ||
    manifest.revision !== revision ||
    manifest.state !== record.state ||
    manifest.recordSha256 !== sha256(recordText) ||
    manifest.files.record !== RECORD_FILE ||
    manifest.files.manifest !== MANIFEST_FILE
  ) throw new Error("Experiment run manifest does not match its canonical record.");
  if (revisionDirectory !== revisionDirectoryName(revision, manifest.recordSha256)) {
    throw new Error("Experiment run revision directory does not match its content hash.");
  }
}

function entryFromRecord(record: HarnessExperimentRunRecordV1, directoryKey: string, revision: number): HarnessExperimentRunStoreEntry {
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
    gamesUnstarted: record.gamesUnstarted
  };
}

function revisionDirectoryName(revision: number, recordSha256: string): string {
  return `${String(revision).padStart(12, "0")}-${recordSha256.slice(0, 16)}`;
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
