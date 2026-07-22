import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessEpisodeArtifactEnvelope } from "./episodeArtifacts";

export const HARNESS_EPISODE_STORE_INDEX_VERSION = "harness.episode-store-index.v1";
export const HARNESS_EPISODE_STORE_MANIFEST_VERSION = "harness.episode-store-manifest.v1";
export const HARNESS_EPISODE_TRAJECTORY_HEADER_VERSION = "harness.episode-trajectory.header.v1";
export const HARNESS_EPISODE_TRAJECTORY_STEP_VERSION = "harness.episode-trajectory.step.v1";
export const HARNESS_EPISODE_TRAJECTORY_MESSAGE_VERSION = "harness.episode-trajectory.message.v1";

const EPISODES_DIRECTORY = "episodes";
const INDEX_FILE = "index.json";
const ARTIFACT_FILE = "artifact.json";
const MANIFEST_FILE = "manifest.json";
const TRAJECTORY_FILE = "trajectory.jsonl";
const DIRECTORY_KEY_PATTERN = /^[a-f0-9]{64}$/;

type GenericEpisodeEnvelope = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;

export interface CanonicalEpisodeArtifactVerification {
  ok: boolean;
  mismatches: readonly string[];
}

export type CanonicalEpisodeArtifactVerifier<TArtifact extends GenericEpisodeEnvelope> = (
  artifact: TArtifact
) => CanonicalEpisodeArtifactVerification | Promise<CanonicalEpisodeArtifactVerification>;

export interface HarnessEpisodeStoreEntry {
  runId: string;
  artifactVersion: string;
  kind: string;
  createdAt: string;
  status: GenericEpisodeEnvelope["status"];
  directoryKey: string;
  nativeStepCount: number;
  messageCount: number;
}

export interface HarnessEpisodeStoreManifest extends HarnessEpisodeStoreEntry {
  schemaVersion: typeof HARNESS_EPISODE_STORE_MANIFEST_VERSION;
  manifestKind: "episode-store-manifest";
  artifactSha256: string;
  trajectorySha256: string;
  files: {
    artifact: typeof ARTIFACT_FILE;
    trajectory: typeof TRAJECTORY_FILE;
    manifest: typeof MANIFEST_FILE;
  };
}

export interface HarnessEpisodeStoreIndex {
  schemaVersion: typeof HARNESS_EPISODE_STORE_INDEX_VERSION;
  kind: "episode-store-index";
  updatedAt: string;
  entries: HarnessEpisodeStoreEntry[];
}

export interface HarnessEpisodeArtifactStoreOptions<TArtifact extends GenericEpisodeEnvelope> {
  /** Trusted server-owned root. Callers never provide child artifact paths. */
  baseDirectory: string;
  /** Canonical, model-free strong verifier supplied by the owning domain. */
  verifyArtifact: CanonicalEpisodeArtifactVerifier<TArtifact>;
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
export class HarnessEpisodeArtifactStore<TArtifact extends GenericEpisodeEnvelope> {
  private readonly root: string;
  private readonly episodesDirectory: string;
  private readonly verifyArtifact: CanonicalEpisodeArtifactVerifier<TArtifact>;
  private readonly now: () => string;
  private readonly entries = new Map<string, HarnessEpisodeStoreEntry>();

  private constructor(options: HarnessEpisodeArtifactStoreOptions<TArtifact>) {
    if (!options.baseDirectory.trim()) throw new Error("Episode artifact store baseDirectory is required.");
    if (typeof options.verifyArtifact !== "function") {
      throw new Error("Episode artifact store requires a canonical artifact verifier.");
    }
    this.root = path.resolve(options.baseDirectory);
    this.episodesDirectory = path.join(this.root, EPISODES_DIRECTORY);
    this.verifyArtifact = options.verifyArtifact;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  static async open<TArtifact extends GenericEpisodeEnvelope>(
    options: HarnessEpisodeArtifactStoreOptions<TArtifact>
  ): Promise<HarnessEpisodeArtifactStore<TArtifact>> {
    const store = new HarnessEpisodeArtifactStore(options);
    await store.initialize();
    return store;
  }

  async put(artifact: TArtifact): Promise<HarnessEpisodeStoreEntry> {
    const canonical = jsonClone(artifact, "Episode artifact is not JSON serializable.");
    assertArtifactIdentity(canonical);
    await this.assertCanonical(canonical);

    const directoryKey = directoryKeyForRunId(canonical.runId);
    const finalDirectory = path.join(this.episodesDirectory, directoryKey);
    await assertPathMissing(finalDirectory, "Episode artifact already exists for this run id.");
    if (this.entries.has(canonical.runId)) throw new Error("Episode artifact already exists for this run id.");

    const artifactText = jsonDocument(canonical);
    const trajectoryText = trajectoryJsonl(canonical);
    const manifest = manifestForArtifact(canonical, directoryKey, artifactText, trajectoryText);
    const temporaryDirectory = path.join(this.episodesDirectory, `.tmp-${randomUUID()}`);
    await mkdir(temporaryDirectory, { recursive: false });
    try {
      await assertDirectoryInside(this.episodesDirectory, temporaryDirectory, "Episode artifact staging directory is not safe.");
      await writeFile(path.join(temporaryDirectory, ARTIFACT_FILE), artifactText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, TRAJECTORY_FILE), trajectoryText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, MANIFEST_FILE), jsonDocument(manifest), { encoding: "utf8", flag: "wx" });
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }

    const entry = entryFromManifest(manifest);
    this.entries.set(entry.runId, entry);
    await this.writeIndex();
    return cloneEntry(entry);
  }

  async get(runId: string): Promise<TArtifact | undefined> {
    assertRunId(runId);
    const known = this.entries.get(runId);
    if (!known) return undefined;
    const loaded = await this.loadDirectory(known.directoryKey, runId);
    if (!loaded) throw new Error("Stored episode artifact failed canonical recovery validation.");
    return jsonClone(loaded.artifact, "Stored episode artifact could not be cloned.");
  }

  async list(): Promise<HarnessEpisodeStoreEntry[]> {
    const verified: HarnessEpisodeStoreEntry[] = [];
    for (const entry of [...this.entries.values()].sort(compareEntries)) {
      const loaded = await this.loadDirectory(entry.directoryKey, entry.runId);
      if (!loaded) throw new Error("Stored episode artifact failed canonical recovery validation.");
      verified.push(cloneEntry(loaded.entry));
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
    const children = await readdir(this.episodesDirectory, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory() || !DIRECTORY_KEY_PATTERN.test(child.name)) continue;
      const loaded = await this.loadDirectory(child.name);
      if (!loaded || recovered.has(loaded.entry.runId)) continue;
      recovered.set(loaded.entry.runId, loaded.entry);
    }
    this.entries.clear();
    for (const [runId, entry] of recovered) this.entries.set(runId, entry);
    await this.writeIndex();
  }

  private async loadDirectory(
    directoryKey: string,
    expectedRunId?: string
  ): Promise<{ artifact: TArtifact; entry: HarnessEpisodeStoreEntry } | undefined> {
    if (!DIRECTORY_KEY_PATTERN.test(directoryKey)) return undefined;
    const directory = path.join(this.episodesDirectory, directoryKey);
    try {
      await assertDirectoryInside(this.episodesDirectory, directory, "Stored episode directory is not safe.");
      const manifestText = await readSafeFile(directory, MANIFEST_FILE);
      const artifactText = await readSafeFile(directory, ARTIFACT_FILE);
      const recordedTrajectory = await readSafeFile(directory, TRAJECTORY_FILE);
      const manifest = JSON.parse(manifestText) as unknown;
      const artifact = JSON.parse(artifactText) as TArtifact;
      if (!isValidManifest(manifest, directoryKey, artifact)) return undefined;
      if (expectedRunId !== undefined && artifact.runId !== expectedRunId) return undefined;
      if (sha256(artifactText) !== manifest.artifactSha256) return undefined;
      if (sha256(recordedTrajectory) !== manifest.trajectorySha256) return undefined;
      if (trajectoryJsonl(artifact) !== recordedTrajectory) return undefined;
      await this.assertCanonical(artifact);
      return { artifact, entry: entryFromManifest(manifest) };
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
      result.mismatches.some((mismatch) => typeof mismatch !== "string")
    ) {
      throw new Error("Canonical episode artifact verification rejected the artifact.");
    }
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

export async function openHarnessEpisodeArtifactStore<TArtifact extends GenericEpisodeEnvelope>(
  options: HarnessEpisodeArtifactStoreOptions<TArtifact>
): Promise<HarnessEpisodeArtifactStore<TArtifact>> {
  return HarnessEpisodeArtifactStore.open(options);
}

export function deriveHarnessEpisodeTrajectoryJsonl(artifact: GenericEpisodeEnvelope): string {
  return trajectoryJsonl(artifact);
}

function manifestForArtifact(
  artifact: GenericEpisodeEnvelope,
  directoryKey: string,
  artifactText: string,
  trajectoryText: string
): HarnessEpisodeStoreManifest {
  return {
    schemaVersion: HARNESS_EPISODE_STORE_MANIFEST_VERSION,
    manifestKind: "episode-store-manifest",
    ...entryForArtifact(artifact, directoryKey),
    artifactSha256: sha256(artifactText),
    trajectorySha256: sha256(trajectoryText),
    files: {
      artifact: ARTIFACT_FILE,
      trajectory: TRAJECTORY_FILE,
      manifest: MANIFEST_FILE
    }
  };
}

function entryForArtifact(artifact: GenericEpisodeEnvelope, directoryKey: string): HarnessEpisodeStoreEntry {
  return {
    runId: artifact.runId,
    artifactVersion: artifact.artifactVersion,
    kind: artifact.kind,
    createdAt: artifact.createdAt,
    status: artifact.status,
    directoryKey,
    nativeStepCount: artifact.socialEpisode.steps.length,
    messageCount: artifact.socialEpisode.messages.length
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
    messageCount: manifest.messageCount
  };
}

function isValidManifest(
  value: unknown,
  directoryKey: string,
  artifact: GenericEpisodeEnvelope
): value is HarnessEpisodeStoreManifest {
  if (!isRecord(value)) return false;
  const expected = entryForArtifact(artifact, directoryKey);
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
    typeof value.artifactSha256 === "string" &&
    typeof value.trajectorySha256 === "string" &&
    isRecord(value.files) &&
    value.files.artifact === ARTIFACT_FILE &&
    value.files.trajectory === TRAJECTORY_FILE &&
    value.files.manifest === MANIFEST_FILE
  );
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

function assertRunId(runId: string): void {
  if (typeof runId !== "string" || !runId.trim() || runId.length > 1024 || runId.includes("\0")) {
    throw new Error("Episode artifact runId must be a nonempty bounded string.");
  }
}

function directoryKeyForRunId(runId: string): string {
  assertRunId(runId);
  return sha256(runId);
}

function compareEntries(left: HarnessEpisodeStoreEntry, right: HarnessEpisodeStoreEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId);
}

function cloneEntry(entry: HarnessEpisodeStoreEntry): HarnessEpisodeStoreEntry {
  return { ...entry };
}

function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
