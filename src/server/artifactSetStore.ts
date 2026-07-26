import path from "node:path";
import {
  type ExperimentMatrixArtifactWriteResult,
  type ExperimentMatrixResult,
  MATRIX_ARTIFACT_VERSION,
  writeExperimentMatrixArtifactDirectory
} from "../harness/experimentMatrix";
import { redactSecrets } from "../harness/redaction";
import {
  PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
  type PublicTournamentArtifactFiles,
  TOURNAMENT_ARTIFACT_VERSION,
  type TournamentArtifactWriteResult,
  assertPublicTournamentMatchArtifact
} from "../harness/tournamentArtifacts";
import {
  GENERATED_ARTIFACT_SET_ID_PATTERN,
  MATRIX_ARTIFACT_SET_INDEX_FILE,
  TOURNAMENT_ARTIFACT_SET_INDEX_FILE,
  assertExistingArtifactSetDirectoryInsideBase,
  assertRegularFileInsideArtifactSet,
  flattenExperimentMatrixArtifactFiles,
  isFileReadNotFound,
  normalizeRequestedArtifactPath,
  relativeExperimentMatrixArtifactFiles,
  resolveGeneratedArtifactDirectory,
  resolveUnderDirectory
} from "./artifactFiles";
import { HttpError } from "./httpValidation";
import { isRecord, numberField, stringArrayField, stringField } from "./jsonUtil";
import {
  type ArtifactRecoveryReadResult,
  artifactRecoveryAuditMessageForCode,
  loadArtifactRecoveryAuditSidecar,
  recordArtifactRecoveryAudit
} from "./recoveryAudit";
import {
  type StoredExperimentMatrixArtifactFiles,
  type StoredExperimentMatrixArtifactSet,
  type StoredPublicTournamentArtifactFiles,
  type StoredResearchTournamentArtifactFiles,
  type StoredTournamentArtifactFiles,
  type StoredTournamentArtifactSet,
  getExperimentMatrixArtifactSet,
  getTournamentArtifactSet,
  listExperimentMatrixArtifactSets,
  listTournamentArtifactSets,
  saveExperimentMatrixArtifactSet,
  saveTournamentArtifactSet
} from "./store";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

/** Matrix bundles contain research-full nested tournament artifacts. They have
 * their own registry/root and are never eligible for the public-share API. */
export async function persistExperimentMatrixArtifactSet(options: {
  result: ExperimentMatrixResult;
  baseDir: string | undefined;
}): Promise<StoredExperimentMatrixArtifactSet> {
  if (!options.baseDir) {
    throw new HttpError(
      400,
      "Experiment matrix artifact export requires configured MATRIX_ARTIFACT_BASE_DIR or TOURNAMENT_ARTIFACT_BASE_DIR."
    );
  }
  const id = randomUUID();
  const baseDir = path.resolve(options.baseDir);
  const outputDir = resolveGeneratedArtifactDirectory(baseDir, id);
  const createdAt = new Date().toISOString();
  let written: ExperimentMatrixArtifactWriteResult;
  try {
    written = await writeExperimentMatrixArtifactDirectory(options.result, { outputDir, createdAt, overwrite: false });
  } catch {
    throw new HttpError(500, "Experiment matrix artifact export failed.");
  }
  const set: StoredExperimentMatrixArtifactSet = {
    id,
    createdAt,
    matrixId: options.result.experiment.id,
    outputDir: written.outputDir,
    files: written.files,
    relativeFiles: relativeExperimentMatrixArtifactFiles(written)
  };
  await loadExperimentMatrixArtifactSetIndex(baseDir);
  saveExperimentMatrixArtifactSet(set);
  await writeExperimentMatrixArtifactSetIndex(baseDir);
  return set;
}

export async function loadExperimentMatrixArtifactSetIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  let parsed: unknown;
  let rewrite = false;
  const loadedIds = new Set<string>();
  try {
    parsed = JSON.parse(await readFile(experimentMatrixArtifactSetIndexPath(root), "utf8")) as unknown;
  } catch (error) {
    if (!isFileReadNotFound(error) && !(error instanceof SyntaxError)) {
      throw new HttpError(500, "Experiment matrix artifact set index could not be read.");
    }
    rewrite = error instanceof SyntaxError;
  }
  if (parsed !== undefined) {
    if (!isRecord(parsed) || parsed.kind !== "experiment-matrix-artifact-set-index" || !Array.isArray(parsed.artifactSets)) {
      rewrite = true;
    } else {
      for (const record of parsed.artifactSets) {
        const set = await storedExperimentMatrixArtifactSetFromIndexRecord(root, record);
        if (!set) {
          rewrite = true;
          continue;
        }
        saveExperimentMatrixArtifactSet(set);
        loadedIds.add(set.id);
      }
    }
  }
  const scanned = await loadExperimentMatrixArtifactSetsFromManifests(root, loadedIds);
  if (rewrite || scanned.length) await writeExperimentMatrixArtifactSetIndex(root);
}

export async function writeExperimentMatrixArtifactSetIndex(baseDir: string): Promise<void> {
  const root = path.resolve(baseDir);
  await mkdir(root, { recursive: true });
  const index = {
    artifactVersion: "harness.experiment-matrix-artifact-set-index.v1",
    kind: "experiment-matrix-artifact-set-index",
    updatedAt: new Date().toISOString(),
    artifactSets: listExperimentMatrixArtifactSetsForBaseDir(root).map((set) => ({
      id: set.id,
      createdAt: set.createdAt,
      matrixId: set.matrixId,
      relativeFiles: set.relativeFiles
    }))
  };
  await writeFile(experimentMatrixArtifactSetIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

export function experimentMatrixArtifactSetIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), MATRIX_ARTIFACT_SET_INDEX_FILE);
}

export async function storedExperimentMatrixArtifactSetFromIndexRecord(
  baseDir: string,
  value: unknown
): Promise<StoredExperimentMatrixArtifactSet | null> {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const indexedFiles = experimentMatrixArtifactFilesFromUnknown(value.relativeFiles);
  if (!indexedFiles) return null;
  const restored = await storedExperimentMatrixArtifactSetFromManifestDirectory(baseDir, value.id);
  return restored && equalExperimentMatrixArtifactFiles(restored.relativeFiles, indexedFiles) ? restored : null;
}

export async function loadExperimentMatrixArtifactSetsFromManifests(baseDir: string, skipIds: Set<string>): Promise<string[]> {
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(path.resolve(baseDir), { withFileTypes: true });
  } catch (error) {
    if (isFileReadNotFound(error)) return [];
    throw new HttpError(500, "Experiment matrix artifact set directory could not be read.");
  }
  const loaded: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !GENERATED_ARTIFACT_SET_ID_PATTERN.test(entry.name) || skipIds.has(entry.name)) continue;
    const restored = await storedExperimentMatrixArtifactSetFromManifestDirectory(baseDir, entry.name);
    if (!restored) continue;
    saveExperimentMatrixArtifactSet(restored);
    skipIds.add(restored.id);
    loaded.push(restored.id);
  }
  return loaded;
}

export async function storedExperimentMatrixArtifactSetFromManifestDirectory(
  baseDir: string,
  id: string
): Promise<StoredExperimentMatrixArtifactSet | null> {
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(id)) return null;
  try {
    const root = path.resolve(baseDir);
    const outputDir = resolveGeneratedArtifactDirectory(root, id);
    await assertExistingArtifactSetDirectoryInsideBase(root, outputDir);
    const manifestPath = resolveUnderDirectory(outputDir, "manifest.json");
    await assertRegularFileInsideArtifactSet({ baseDir: root, outputDir, absolutePath: manifestPath });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!isRecord(manifest) || manifest.artifactVersion !== MATRIX_ARTIFACT_VERSION || manifest.kind !== "experiment-matrix") return null;
    const createdAt = stringField(manifest, "createdAt");
    const matrixId = stringField(manifest, "matrixId");
    const relativeFiles = experimentMatrixArtifactFilesFromUnknown(manifest.files);
    if (!createdAt || !matrixId || !relativeFiles) return null;
    for (const relativeFile of flattenExperimentMatrixArtifactFiles(relativeFiles)) {
      const absolutePath = resolveUnderDirectory(
        outputDir,
        normalizeRequestedArtifactPath(relativeFile)
      );
      await assertRegularFileInsideArtifactSet({
        baseDir: root,
        outputDir,
        absolutePath
      });
    }
    return {
      id,
      createdAt,
      matrixId,
      outputDir,
      files: absoluteExperimentMatrixArtifactFiles(outputDir, relativeFiles),
      relativeFiles
    };
  } catch {
    return null;
  }
}

export async function loadTournamentArtifactSetIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await loadArtifactRecoveryAuditSidecar(root, "tournament");
  let parsed: unknown;
  let shouldRewriteIndex = false;
  const loadedIds = new Set<string>();
  try {
    const content = await readFile(tournamentArtifactSetIndexPath(root), "utf8");
    parsed = JSON.parse(content);
  } catch (error) {
    if (isFileReadNotFound(error)) {
      const scannedIds = await loadTournamentArtifactSetsFromManifests(root, loadedIds);
      if (scannedIds.length > 0) await writeTournamentArtifactSetIndex(root);
      return;
    }
    if (error instanceof SyntaxError) {
      await recordArtifactRecoveryAudit(root, {
        store: "tournament",
        source: "index",
        code: "index_invalid_json",
        relativeFile: TOURNAMENT_ARTIFACT_SET_INDEX_FILE,
        message: "Tournament artifact set index contained invalid JSON and will be repaired from child manifests."
      });
      shouldRewriteIndex = true;
    } else {
      throw new HttpError(500, "Tournament artifact set index could not be read.");
    }
  }
  if (parsed !== undefined && (!isRecord(parsed) || parsed.kind !== "tournament-artifact-set-index" || !Array.isArray(parsed.artifactSets))) {
    await recordArtifactRecoveryAudit(root, {
      store: "tournament",
      source: "index",
      code: "index_invalid_shape",
      relativeFile: TOURNAMENT_ARTIFACT_SET_INDEX_FILE,
      message: "Tournament artifact set index shape was invalid and will be repaired from child manifests."
    });
    shouldRewriteIndex = true;
  } else if (isRecord(parsed) && Array.isArray(parsed.artifactSets)) {
    for (const record of parsed.artifactSets) {
      const set = await storedTournamentArtifactSetFromIndexRecord(root, record);
      if (set) {
        saveTournamentArtifactSet(set);
        loadedIds.add(set.id);
      } else {
        await recordArtifactRecoveryAudit(root, {
          store: "tournament",
          source: "index",
          code: "index_record_rejected",
          artifactId: isRecord(record) ? stringField(record, "id") ?? undefined : undefined,
          message: "Tournament artifact set index record did not resolve to a valid manifest directory."
        });
        shouldRewriteIndex = true;
      }
    }
  }
  const scannedIds = await loadTournamentArtifactSetsFromManifests(root, loadedIds);
  if (scannedIds.length > 0 || shouldRewriteIndex) {
    await writeTournamentArtifactSetIndex(root);
  }
}

export async function writeTournamentArtifactSetIndex(baseDir: string): Promise<void> {
  const root = path.resolve(baseDir);
  await mkdir(root, { recursive: true });
  const artifactSets = listTournamentArtifactSetsForBaseDir(root).map((set) => ({
    id: set.id,
    createdAt: set.createdAt,
    experimentId: set.experimentId,
    seed: set.seed,
    relativeFiles: set.relativeFiles,
    nativeSteps: set.nativeSteps ?? null,
    committedSteps: set.committedSteps ?? null,
    rejectedSteps: set.rejectedSteps ?? null,
    metricCount: set.metricCount ?? null,
    scorecardEligibleMetricCount: set.scorecardEligibleMetricCount ?? null,
    metricPromotionClassCounts: set.metricPromotionClassCounts ?? null,
    scorecardEligibleMetricClassCounts: set.scorecardEligibleMetricClassCounts ?? null,
    projection: set.projection ?? null
  }));
  const index = {
    artifactVersion: "harness.tournament-artifact-set-index.v1",
    kind: "tournament-artifact-set-index",
    updatedAt: new Date().toISOString(),
    artifactSets
  };
  await writeFile(tournamentArtifactSetIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

export function tournamentArtifactSetIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), TOURNAMENT_ARTIFACT_SET_INDEX_FILE);
}

export async function storedTournamentArtifactSetFromIndexRecord(baseDir: string, value: unknown): Promise<StoredTournamentArtifactSet | null> {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const relativeFiles = tournamentArtifactFilesFromUnknown(value.relativeFiles);
  if (!id || !relativeFiles) return null;
  try {
    const set = await storedTournamentArtifactSetFromManifestDirectory(baseDir, id);
    if (!set) return null;
    return equalTournamentArtifactFiles(set.relativeFiles, relativeFiles) ? set : null;
  } catch {
    return null;
  }
}

export async function loadTournamentArtifactSetsFromManifests(baseDir: string, skipIds: Set<string>): Promise<string[]> {
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(path.resolve(baseDir), { withFileTypes: true });
  } catch (error) {
    if (isFileReadNotFound(error)) return [];
    throw new HttpError(500, "Tournament artifact set directory could not be read.");
  }
  const loadedIds: string[] = [];
  for (const entry of entries) {
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(entry.name)) continue;
    if (!entry.isDirectory()) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "tournament",
        source: "directory",
        code: "directory_entry_rejected",
        artifactId: entry.name,
        message: "Tournament artifact set entry was not a generated artifact directory."
      });
      continue;
    }
    if (skipIds.has(entry.name)) continue;
    const setResult = await readTournamentArtifactSetFromManifestDirectory(baseDir, entry.name);
    if (!setResult.ok) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "tournament",
        source: "manifest",
        code: setResult.code,
        artifactId: entry.name,
        relativeFile: "manifest.json",
        message:
          artifactRecoveryAuditMessageForCode("tournament", "manifest", setResult.code) ??
          "Tournament artifact set manifest failed recovery validation."
      });
      continue;
    }
    const set = setResult.artifact;
    saveTournamentArtifactSet(set);
    skipIds.add(set.id);
    loadedIds.push(set.id);
  }
  return loadedIds;
}

export async function storedTournamentArtifactSetFromManifestDirectory(baseDir: string, id: string): Promise<StoredTournamentArtifactSet | null> {
  const result = await readTournamentArtifactSetFromManifestDirectory(baseDir, id);
  return result.ok ? result.artifact : null;
}

export async function readTournamentArtifactSetFromManifestDirectory(
  baseDir: string,
  id: string
): Promise<ArtifactRecoveryReadResult<StoredTournamentArtifactSet>> {
  try {
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(id)) return { ok: false, code: "manifest_identity_mismatch" };
    const root = path.resolve(baseDir);
    const outputDir = resolveGeneratedArtifactDirectory(root, id);
    try {
      await assertExistingArtifactSetDirectoryInsideBase(root, outputDir);
    } catch {
      return { ok: false, code: "manifest_directory_rejected" };
    }
    const manifestPath = resolveUnderDirectory(outputDir, "manifest.json");
    try {
      await assertRegularFileInsideArtifactSet({ baseDir: root, outputDir, absolutePath: manifestPath });
    } catch {
      return { ok: false, code: "manifest_file_not_regular" };
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    } catch (error) {
      return { ok: false, code: error instanceof SyntaxError ? "manifest_invalid_json" : "manifest_file_not_regular" };
    }
    if (!isRecord(manifest)) return { ok: false, code: "manifest_invalid_shape" };
    if (
      manifest.artifactVersion === PUBLIC_TOURNAMENT_ARTIFACT_VERSION &&
      manifest.kind === "public-tournament" &&
      manifest.visibility === "public"
    ) {
      return readPublicTournamentArtifactSetFromManifest({ root, outputDir, id, manifest });
    }
    if (manifest.artifactVersion !== TOURNAMENT_ARTIFACT_VERSION || manifest.kind !== "tournament") {
      return { ok: false, code: "manifest_invalid_shape" };
    }
    const createdAt = stringField(manifest, "createdAt");
    const experimentId = stringField(manifest, "experimentId");
    const seed = stringField(manifest, "seed");
    const relativeFiles = researchTournamentArtifactFileShapeFromUnknown(manifest.files);
    if (!createdAt || !experimentId || !seed || !relativeFiles) return { ok: false, code: "manifest_invalid_shape" };
    if (!isExpectedTournamentArtifactFileSet(relativeFiles)) return { ok: false, code: "manifest_file_set_invalid" };
    const density = tournamentDensityFromUnknown(manifest);
    return {
      ok: true,
      artifact: {
        id,
        createdAt,
        experimentId,
        seed,
        outputDir,
        files: absoluteTournamentArtifactFiles(outputDir, relativeFiles),
        relativeFiles,
        nativeSteps: density?.nativeSteps,
        committedSteps: density?.committedSteps,
        rejectedSteps: density?.rejectedSteps,
        metricCount: density?.metricCount,
        scorecardEligibleMetricCount: density?.scorecardEligibleMetricCount,
        metricPromotionClassCounts: density?.metricPromotionClassCounts,
        scorecardEligibleMetricClassCounts: density?.scorecardEligibleMetricClassCounts,
        projection: tournamentProjectionFromUnknown(manifest.projection)
      }
    };
  } catch {
    return { ok: false, code: "manifest_identity_mismatch" };
  }
}

export async function readPublicTournamentArtifactSetFromManifest(input: {
  root: string;
  outputDir: string;
  id: string;
  manifest: Record<string, unknown>;
}): Promise<ArtifactRecoveryReadResult<StoredTournamentArtifactSet>> {
  const createdAt = stringField(input.manifest, "createdAt");
  const relativeFiles = publicTournamentArtifactFileShapeFromUnknown(input.manifest.files);
  if (!createdAt || !relativeFiles || !isExpectedPublicTournamentArtifactFileSet(relativeFiles)) {
    return { ok: false, code: "manifest_invalid_shape" };
  }
  const validated = await validatePublicTournamentArtifactDirectory({
    baseDir: input.root,
    outputDir: input.outputDir,
    manifest: input.manifest,
    files: relativeFiles
  });
  if (!validated) return { ok: false, code: "public_projection_invalid" };
  return {
    ok: true,
    artifact: {
      id: input.id,
      createdAt,
      experimentId: input.id,
      seed: "[REDACTED deterministic seed]",
      outputDir: input.outputDir,
      files: absolutePublicTournamentArtifactFiles(input.outputDir, relativeFiles),
      relativeFiles,
      projection: {
        visibility: "public",
        matchArtifactView: "truth-redacted",
        assignmentTruthRedacted: true,
        publicShareSafe: true
      }
    }
  };
}

export async function validatePublicTournamentArtifactDirectory(input: {
  baseDir: string;
  outputDir: string;
  manifest: Record<string, unknown>;
  files: StoredPublicTournamentArtifactFiles;
}): Promise<boolean> {
  try {
    if (!isPublicTournamentManifest(input.manifest, input.files)) return false;
    if (!(await hasExactPublicTournamentArtifactFileSet(input))) return false;
    const episodePath = resolveUnderDirectory(input.outputDir, input.files.episodes);
    await assertRegularFileInsideArtifactSet({
      baseDir: input.baseDir,
      outputDir: input.outputDir,
      absolutePath: episodePath
    });
    const episodeRecords = (await readFile(episodePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    if (episodeRecords.length !== input.files.matches.length) return false;
    const expectedByPath = new Map<string, Record<string, unknown>>();
    for (const record of episodeRecords) {
      if (!isPublicTournamentEpisodeRecord(record)) return false;
      const value = record as Record<string, unknown>;
      const matchPath = value.match;
      if (typeof matchPath !== "string" || expectedByPath.has(matchPath)) return false;
      expectedByPath.set(matchPath, value);
    }
    for (const matchPath of input.files.matches) {
      const episode = expectedByPath.get(matchPath);
      if (!episode) return false;
      const expectedEpisodeIndex = publicEpisodeIndexFromMatchPath(matchPath);
      if (expectedEpisodeIndex === null || expectedEpisodeIndex !== episode.episodeIndex) return false;
      const absolutePath = resolveUnderDirectory(input.outputDir, matchPath);
      await assertRegularFileInsideArtifactSet({
        baseDir: input.baseDir,
        outputDir: input.outputDir,
        absolutePath
      });
      const match = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
      assertPublicTournamentMatchArtifact(match);
      const publicMatch = match as Record<string, unknown>;
      if (publicMatch.episodeIndex !== episode.episodeIndex || publicMatch.status !== episode.status) return false;
      if (!Array.isArray(publicMatch.messages) || publicMatch.messages.length !== episode.publicMessageCount) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function hasExactPublicTournamentArtifactFileSet(input: {
  baseDir: string;
  outputDir: string;
  files: StoredPublicTournamentArtifactFiles;
}): Promise<boolean> {
  try {
    await assertExistingArtifactSetDirectoryInsideBase(input.baseDir, input.outputDir);
    const rootEntries = await readdir(input.outputDir, { withFileTypes: true });
    const expectedRootEntries = new Set(["manifest.json", "episodes.jsonl", "matches"]);
    if (rootEntries.length !== expectedRootEntries.size || rootEntries.some((entry) => !expectedRootEntries.has(entry.name))) {
      return false;
    }
    const matchesDirectory = resolveUnderDirectory(input.outputDir, "matches");
    const matchesInfo = await lstat(matchesDirectory);
    if (!matchesInfo.isDirectory() || matchesInfo.isSymbolicLink()) return false;
    const expectedMatchNames = new Set(input.files.matches.map((file) => path.basename(file)));
    if (expectedMatchNames.size !== input.files.matches.length) return false;
    const matchEntries = await readdir(matchesDirectory, { withFileTypes: true });
    if (
      matchEntries.length !== expectedMatchNames.size ||
      matchEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expectedMatchNames.has(entry.name))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function publicEpisodeIndexFromMatchPath(matchPath: string): number | null {
  const match = /^matches\/episode-([1-9][0-9]*)\.json$/.exec(matchPath);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

export async function assertVerifiedPublicTournamentArtifactSet(
  set: StoredTournamentArtifactSet,
  baseDir: string | undefined
): Promise<void> {
  if (!baseDir || "registry" in set.relativeFiles) {
    throw new HttpError(409, "Tournament artifact set is not a verified public publication.", "public_tournament_artifact_invalid");
  }
  const files = set.relativeFiles as StoredPublicTournamentArtifactFiles;
  if (!isExpectedPublicTournamentArtifactFileSet(files)) {
    throw new HttpError(409, "Tournament artifact set is not a verified public publication.", "public_tournament_artifact_invalid");
  }
  try {
    const manifestPath = resolveUnderDirectory(set.outputDir, files.manifest);
    await assertRegularFileInsideArtifactSet({ baseDir, outputDir: set.outputDir, absolutePath: manifestPath });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!isRecord(manifest)) throw new Error("invalid manifest");
    const valid = await validatePublicTournamentArtifactDirectory({
      baseDir,
      outputDir: set.outputDir,
      manifest,
      files
    });
    if (!valid) throw new Error("invalid public projection");
  } catch {
    throw new HttpError(409, "Tournament public publication failed verification.", "public_tournament_artifact_invalid");
  }
}

export function isPublicTournamentManifest(
  manifest: Record<string, unknown>,
  files: StoredPublicTournamentArtifactFiles
): boolean {
  const keys = Object.keys(manifest).sort();
  const expected = ["artifactVersion", "createdAt", "files", "games", "kind", "visibility"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  if (
    manifest.artifactVersion !== PUBLIC_TOURNAMENT_ARTIFACT_VERSION ||
    manifest.kind !== "public-tournament" ||
    manifest.visibility !== "public" ||
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  ) {
    return false;
  }
  if (!isRecord(manifest.games)) return false;
  const gameKeys = Object.keys(manifest.games).sort();
  if (
    gameKeys.length !== 4 ||
    gameKeys[0] !== "completed" ||
    gameKeys[1] !== "failed" ||
    gameKeys[2] !== "requested" ||
    gameKeys[3] !== "truncated" ||
    !Object.values(manifest.games).every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0)
  ) {
    return false;
  }
  const manifestFiles = publicTournamentArtifactFileShapeFromUnknown(manifest.files);
  return Boolean(manifestFiles && equalTournamentArtifactFiles(manifestFiles, files));
}

export function isPublicTournamentEpisodeRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["episodeIndex", "kind", "match", "publicMessageCount", "status"];
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    value.kind === "public-episode" &&
    typeof value.episodeIndex === "number" &&
    Number.isInteger(value.episodeIndex) &&
    value.episodeIndex >= 0 &&
    typeof value.status === "string" &&
    typeof value.match === "string" &&
    typeof value.publicMessageCount === "number" &&
    Number.isInteger(value.publicMessageCount) &&
    value.publicMessageCount >= 0
  );
}

export function tournamentArtifactFilesFromUnknown(value: unknown): StoredTournamentArtifactFiles | null {
  const publicFiles = publicTournamentArtifactFileShapeFromUnknown(value);
  if (publicFiles && isExpectedPublicTournamentArtifactFileSet(publicFiles)) return publicFiles;
  const researchFiles = researchTournamentArtifactFileShapeFromUnknown(value);
  return researchFiles && isExpectedTournamentArtifactFileSet(researchFiles) ? researchFiles : null;
}

export function researchTournamentArtifactFileShapeFromUnknown(value: unknown): StoredResearchTournamentArtifactFiles | null {
  if (!isRecord(value)) return null;
  const manifest = stringField(value, "manifest");
  const registry = stringField(value, "registry");
  const specNormalized = stringField(value, "specNormalized");
  const assignment = stringField(value, "assignment");
  const episodes = stringField(value, "episodes");
  const trajectory = stringField(value, "trajectory");
  const metrics = stringField(value, "metrics");
  const integrity = stringField(value, "integrity");
  const failures = stringField(value, "failures");
  const costLatency = stringField(value, "costLatency");
  const leaderboard = stringField(value, "leaderboard");
  const benchmarkStatistics = stringField(value, "benchmarkStatistics");
  const tournamentComparison = stringField(value, "tournamentComparison");
  const tournamentComparisonMarkdown = stringField(value, "tournamentComparisonMarkdown");
  const summaryMarkdown = stringField(value, "summaryMarkdown");
  const episodesCsv = stringField(value, "episodesCsv");
  const agentsCsv = stringField(value, "agentsCsv");
  const metricsCsv = stringField(value, "metricsCsv");
  const leaderboardCsv = stringField(value, "leaderboardCsv");
  const matches = stringArrayField(value, "matches");
  const matchesJsonl = stringArrayField(value, "matchesJsonl");
  if (
    !manifest ||
    !registry ||
    !specNormalized ||
    !assignment ||
    !episodes ||
    !trajectory ||
    !metrics ||
    !integrity ||
    !failures ||
    !costLatency ||
    !leaderboard ||
    !benchmarkStatistics ||
    !tournamentComparison ||
    !tournamentComparisonMarkdown ||
    !summaryMarkdown ||
    !episodesCsv ||
    !agentsCsv ||
    !metricsCsv ||
    !leaderboardCsv ||
    !matches ||
    !matchesJsonl
  ) {
    return null;
  }
  const files = {
    manifest,
    registry,
    specNormalized,
    assignment,
    episodes,
    trajectory,
    metrics,
    integrity,
    failures,
    costLatency,
    leaderboard,
    benchmarkStatistics,
    tournamentComparison,
    tournamentComparisonMarkdown,
    summaryMarkdown,
    episodesCsv,
    agentsCsv,
    metricsCsv,
    leaderboardCsv,
    matches,
    matchesJsonl
  };
  return files satisfies StoredResearchTournamentArtifactFiles;
}

export function publicTournamentArtifactFileShapeFromUnknown(value: unknown): StoredPublicTournamentArtifactFiles | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = ["episodes", "manifest", "matches"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  const manifest = stringField(value, "manifest");
  const episodes = stringField(value, "episodes");
  const matches = stringArrayField(value, "matches");
  if (!manifest || !episodes || !matches) return null;
  return { manifest, episodes, matches };
}

export function isExpectedTournamentArtifactFileSet(files: StoredResearchTournamentArtifactFiles): boolean {
  return (
    files.manifest === "manifest.json" &&
    files.registry === "registry.json" &&
    files.specNormalized === "spec.normalized.json" &&
    files.assignment === "assignment.json" &&
    files.episodes === "episodes.jsonl" &&
    files.trajectory === "trajectory.jsonl" &&
    files.metrics === "metrics.jsonl" &&
    files.integrity === "integrity.jsonl" &&
    files.failures === "failures.jsonl" &&
    files.costLatency === "cost_latency.json" &&
    files.leaderboard === "leaderboard.json" &&
    files.benchmarkStatistics === "benchmark_statistics.json" &&
    files.tournamentComparison === "tournament_comparison.json" &&
    files.tournamentComparisonMarkdown === "tournament_comparison.md" &&
    files.summaryMarkdown === "summary.md" &&
    files.episodesCsv === "episodes.csv" &&
    files.agentsCsv === "agents.csv" &&
    files.metricsCsv === "metrics.csv" &&
    files.leaderboardCsv === "leaderboard.csv" &&
    files.matches.every((file) => isWriterTournamentMatchArtifactFile(file, ".json")) &&
    files.matchesJsonl.every((file) => isWriterTournamentMatchArtifactFile(file, ".jsonl"))
  );
}

export function isExpectedPublicTournamentArtifactFileSet(files: StoredPublicTournamentArtifactFiles): boolean {
  return (
    files.manifest === "manifest.json" &&
    files.episodes === "episodes.jsonl" &&
    files.matches.every((file) => /^matches\/episode-[1-9][0-9]*\.json$/.test(file))
  );
}

export function experimentMatrixArtifactFilesFromUnknown(value: unknown): StoredExperimentMatrixArtifactFiles | null {
  if (!isRecord(value)) return null;
  const manifest = stringField(value, "manifest");
  const specNormalized = stringField(value, "specNormalized");
  const cells = stringField(value, "cells");
  const statistics = stringField(value, "statistics");
  const summaryMarkdown = stringField(value, "summaryMarkdown");
  const modelStatsCsv = stringField(value, "modelStatsCsv");
  const profileStatsCsv = stringField(value, "profileStatsCsv");
  const pairwiseModelComparisonsCsv = stringField(value, "pairwiseModelComparisonsCsv");
  if (
    !manifest ||
    !specNormalized ||
    !cells ||
    !statistics ||
    !summaryMarkdown ||
    !modelStatsCsv ||
    !profileStatsCsv ||
    !pairwiseModelComparisonsCsv ||
    !Array.isArray(value.tournaments)
  ) {
    return null;
  }
  const tournaments: StoredExperimentMatrixArtifactFiles["tournaments"] = [];
  for (const item of value.tournaments) {
    if (!isRecord(item)) return null;
    const cellId = stringField(item, "cellId");
    const tournamentManifest = stringField(item, "manifest");
    if (!cellId || !tournamentManifest) return null;
    tournaments.push({ cellId, manifest: tournamentManifest });
  }
  const files = {
    manifest,
    specNormalized,
    cells,
    statistics,
    summaryMarkdown,
    modelStatsCsv,
    profileStatsCsv,
    pairwiseModelComparisonsCsv,
    tournaments
  } satisfies StoredExperimentMatrixArtifactFiles;
  return isExpectedExperimentMatrixArtifactFileSet(files) ? files : null;
}

export function isExpectedExperimentMatrixArtifactFileSet(files: StoredExperimentMatrixArtifactFiles): boolean {
  return (
    files.manifest === "manifest.json" &&
    files.specNormalized === "spec.normalized.json" &&
    files.cells === "cells.jsonl" &&
    files.statistics === "statistics.json" &&
    files.summaryMarkdown === "summary.md" &&
    files.modelStatsCsv === "model_stats.csv" &&
    files.profileStatsCsv === "profile_stats.csv" &&
    files.pairwiseModelComparisonsCsv === "pairwise_model_comparisons.csv" &&
    files.tournaments.every((file) => {
      if (!/^[A-Za-z0-9_.-]+$/.test(file.cellId)) return false;
      return file.manifest === `tournaments/${file.cellId}/manifest.json`;
    })
  );
}

export function isWriterTournamentMatchArtifactFile(file: string, extension: ".json" | ".jsonl"): boolean {
  if (!file.startsWith("matches/") || !file.endsWith(extension)) return false;
  const matchStem = file.slice("matches/".length, -extension.length);
  return /^tournament-[A-Za-z0-9_.-]+-[1-9][0-9]*$/.test(matchStem);
}

export function absoluteTournamentArtifactFiles(
  outputDir: string,
  files: StoredResearchTournamentArtifactFiles
): TournamentArtifactWriteResult["files"] {
  const resolve = (relativePath: string) => resolveUnderDirectory(outputDir, normalizeRequestedArtifactPath(relativePath));
  return {
    manifest: resolve(files.manifest),
    registry: resolve(files.registry),
    specNormalized: resolve(files.specNormalized),
    assignment: resolve(files.assignment),
    episodes: resolve(files.episodes),
    trajectory: resolve(files.trajectory),
    metrics: resolve(files.metrics),
    integrity: resolve(files.integrity),
    failures: resolve(files.failures),
    costLatency: resolve(files.costLatency),
    leaderboard: resolve(files.leaderboard),
    benchmarkStatistics: resolve(files.benchmarkStatistics),
    tournamentComparison: resolve(files.tournamentComparison),
    tournamentComparisonMarkdown: resolve(files.tournamentComparisonMarkdown),
    summaryMarkdown: resolve(files.summaryMarkdown),
    episodesCsv: resolve(files.episodesCsv),
    agentsCsv: resolve(files.agentsCsv),
    metricsCsv: resolve(files.metricsCsv),
    leaderboardCsv: resolve(files.leaderboardCsv),
    matchesDir: resolveUnderDirectory(outputDir, "matches"),
    matches: files.matches.map(resolve),
    matchesJsonl: files.matchesJsonl.map(resolve)
  };
}

export function absolutePublicTournamentArtifactFiles(
  outputDir: string,
  files: StoredPublicTournamentArtifactFiles
): PublicTournamentArtifactFiles {
  const resolve = (relativePath: string) => resolveUnderDirectory(outputDir, normalizeRequestedArtifactPath(relativePath));
  return {
    manifest: resolve(files.manifest),
    episodes: resolve(files.episodes),
    matchesDir: resolveUnderDirectory(outputDir, "matches"),
    matches: files.matches.map(resolve)
  };
}

export function absoluteExperimentMatrixArtifactFiles(
  outputDir: string,
  files: StoredExperimentMatrixArtifactFiles
): ExperimentMatrixArtifactWriteResult["files"] {
  const resolve = (relativePath: string) => resolveUnderDirectory(outputDir, normalizeRequestedArtifactPath(relativePath));
  return {
    manifest: resolve(files.manifest),
    specNormalized: resolve(files.specNormalized),
    cells: resolve(files.cells),
    statistics: resolve(files.statistics),
    summaryMarkdown: resolve(files.summaryMarkdown),
    modelStatsCsv: resolve(files.modelStatsCsv),
    profileStatsCsv: resolve(files.profileStatsCsv),
    pairwiseModelComparisonsCsv: resolve(files.pairwiseModelComparisonsCsv),
    tournamentsDir: resolveUnderDirectory(outputDir, "tournaments"),
    tournaments: files.tournaments.map((file) => ({ cellId: file.cellId, manifest: resolve(file.manifest) }))
  };
}

export function equalTournamentArtifactFiles(left: StoredTournamentArtifactFiles, right: StoredTournamentArtifactFiles): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function equalExperimentMatrixArtifactFiles(
  left: StoredExperimentMatrixArtifactFiles,
  right: StoredExperimentMatrixArtifactFiles
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function listTournamentArtifactSetsForBaseDir(baseDir: string | undefined): StoredTournamentArtifactSet[] {
  if (!baseDir) return listTournamentArtifactSets();
  return listTournamentArtifactSets().filter((set) => isTournamentArtifactSetInsideBaseDir(set, baseDir));
}

export function getTournamentArtifactSetForBaseDir(id: string, baseDir: string | undefined): StoredTournamentArtifactSet | undefined {
  const set = getTournamentArtifactSet(id);
  if (!set) return undefined;
  if (baseDir && !isTournamentArtifactSetInsideBaseDir(set, baseDir)) return undefined;
  return set;
}

export function isTournamentArtifactSetInsideBaseDir(set: StoredTournamentArtifactSet, baseDir: string): boolean {
  const root = path.resolve(baseDir);
  const outputDir = path.resolve(set.outputDir);
  return outputDir !== root && outputDir.startsWith(root + path.sep);
}

export function listExperimentMatrixArtifactSetsForBaseDir(baseDir: string | undefined): StoredExperimentMatrixArtifactSet[] {
  if (!baseDir) return listExperimentMatrixArtifactSets();
  return listExperimentMatrixArtifactSets().filter((set) => isExperimentMatrixArtifactSetInsideBaseDir(set, baseDir));
}

export function getExperimentMatrixArtifactSetForBaseDir(
  id: string,
  baseDir: string | undefined
): StoredExperimentMatrixArtifactSet | undefined {
  const set = getExperimentMatrixArtifactSet(id);
  if (!set || (baseDir && !isExperimentMatrixArtifactSetInsideBaseDir(set, baseDir))) return undefined;
  return set;
}

export function isExperimentMatrixArtifactSetInsideBaseDir(set: StoredExperimentMatrixArtifactSet, baseDir: string): boolean {
  const root = path.resolve(baseDir);
  const outputDir = path.resolve(set.outputDir);
  return outputDir !== root && outputDir.startsWith(root + path.sep);
}

export function tournamentDensityFromUnknown(
  value: unknown
): {
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  metricCount?: number;
  scorecardEligibleMetricCount?: number;
  metricPromotionClassCounts?: StoredTournamentArtifactSet["metricPromotionClassCounts"];
  scorecardEligibleMetricClassCounts?: StoredTournamentArtifactSet["scorecardEligibleMetricClassCounts"];
} | undefined {
  if (!isRecord(value)) return undefined;
  const nativeSteps = numberField(value, "nativeSteps");
  const committedSteps = numberField(value, "committedSteps");
  const rejectedSteps = numberField(value, "rejectedSteps");
  if (nativeSteps === null || committedSteps === null || rejectedSteps === null) return undefined;
  if (nativeSteps < 0 || committedSteps < 0 || rejectedSteps < 0) return undefined;
  const metricCount = numberField(value, "metricCount");
  const scorecardEligibleMetricCount = numberField(value, "scorecardEligibleMetricCount");
  const metricPromotionClassCounts = tournamentPromotionClassCountsFromUnknown(value.metricPromotionClassCounts);
  const scorecardEligibleMetricClassCounts = tournamentPromotionClassCountsFromUnknown(
    value.scorecardEligibleMetricClassCounts
  );
  return {
    nativeSteps,
    committedSteps,
    rejectedSteps,
    ...(metricCount !== null && metricCount >= 0 ? { metricCount } : {}),
    ...(scorecardEligibleMetricCount !== null && scorecardEligibleMetricCount >= 0
      ? { scorecardEligibleMetricCount }
      : {}),
    ...(metricPromotionClassCounts ? { metricPromotionClassCounts } : {}),
    ...(scorecardEligibleMetricClassCounts ? { scorecardEligibleMetricClassCounts } : {})
  };
}

export function tournamentPromotionClassCountsFromUnknown(
  value: unknown
): StoredTournamentArtifactSet["metricPromotionClassCounts"] | undefined {
  if (!isRecord(value)) return undefined;
  const scorecard = numberField(value, "scorecard");
  const diagnostic = numberField(value, "diagnostic");
  const benchmarkOnly = numberField(value, "benchmark_only");
  if (scorecard === null || diagnostic === null || benchmarkOnly === null) return undefined;
  if (scorecard < 0 || diagnostic < 0 || benchmarkOnly < 0) return undefined;
  return {
    scorecard,
    diagnostic,
    benchmark_only: benchmarkOnly
  };
}

export async function tournamentDensityFromManifestFile(
  manifestPath: string
): Promise<
  | {
      nativeSteps: number;
      committedSteps: number;
      rejectedSteps: number;
      metricCount?: number;
      scorecardEligibleMetricCount?: number;
      metricPromotionClassCounts?: StoredTournamentArtifactSet["metricPromotionClassCounts"];
      scorecardEligibleMetricClassCounts?: StoredTournamentArtifactSet["scorecardEligibleMetricClassCounts"];
    }
  | undefined
> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    return tournamentDensityFromUnknown(manifest);
  } catch {
    return undefined;
  }
}

export function tournamentProjectionFromUnknown(
  value: unknown
): StoredTournamentArtifactSet["projection"] | undefined {
  if (!isRecord(value)) return undefined;
  const visibility = stringField(value, "visibility");
  const matchArtifactView = stringField(value, "matchArtifactView");
  if (
    matchArtifactView !== "full" &&
    matchArtifactView !== "postgame-redacted" &&
    matchArtifactView !== "truth-redacted"
  ) {
    return undefined;
  }
  if (typeof value.assignmentTruthRedacted !== "boolean") return undefined;
  if (visibility !== "research-full" && visibility !== "postgame-research" && visibility !== "public") return undefined;
  if (typeof value.publicShareSafe !== "boolean") return undefined;
  return {
    visibility,
    matchArtifactView,
    assignmentTruthRedacted: value.assignmentTruthRedacted,
    // A stored boolean is never authority for public sharing.  The public
    // manifest schema and its file set are validated during recovery.
    publicShareSafe: visibility === "public" && value.publicShareSafe
  };
}
