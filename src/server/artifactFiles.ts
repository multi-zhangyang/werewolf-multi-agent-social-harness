import path from "node:path";
import type { ExperimentMatrixArtifactWriteResult } from "../harness/experimentMatrix";
import type { TournamentArtifactWriteResult } from "../harness/tournamentArtifacts";
import { HttpError } from "./httpValidation";
import { isRecord } from "./jsonUtil";
import type {
  StoredExperimentMatrixArtifactFiles,
  StoredExperimentMatrixArtifactSet,
  StoredPublicTournamentArtifactFiles,
  StoredResearchTournamentArtifactFiles,
  StoredTournamentArtifactFiles,
  StoredTournamentArtifactSet
} from "./store";
import { lstat, mkdir, realpath } from "node:fs/promises";

export const TOURNAMENT_ARTIFACT_SET_INDEX_FILE = "artifact_sets.index.json";

export const MATRIX_ARTIFACT_SET_INDEX_FILE = "matrix_artifact_sets.index.json";

export const TOURNAMENT_PUBLIC_SHARE_INDEX_FILE = "tournament_public_shares.index.json";

export const CHECKPOINT_ARTIFACT_INDEX_FILE = "checkpoints.index.json";

export const CHECKPOINT_FORK_ATTEMPT_FILE = "checkpoint_fork_attempts.json";

export const CHECKPOINT_ARTIFACT_DIR = "checkpoints";

export const MATCH_ARTIFACT_INDEX_FILE = "matches.index.json";

export const MATCH_ARTIFACT_DIR = "matches";

export const COMPARISON_ARTIFACT_INDEX_FILE = "comparisons.index.json";

export const COMPARISON_ARTIFACT_DIR = "comparisons";

export const GENERATED_ARTIFACT_SET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Server-owned match file stems: UUID v4 or safe tournament/episode ids. */
export const PERSISTED_MATCH_ARTIFACT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function isPersistedMatchArtifactId(matchId: string): boolean {
  if (!matchId || matchId.length > 160) return false;
  if (matchId.includes("..") || matchId.startsWith(".") || matchId.endsWith(".")) return false;
  if (GENERATED_ARTIFACT_SET_ID_PATTERN.test(matchId)) return true;
  // Tournament episode ids such as tournament-<seed>-N and other safe stems.
  return PERSISTED_MATCH_ARTIFACT_ID_PATTERN.test(matchId);
}

export function relativeTournamentArtifactFiles(written: TournamentArtifactWriteResult): StoredTournamentArtifactFiles {
  if (!("registry" in written.files)) {
    return {
      manifest: relativeArtifactPath(written.outputDir, written.files.manifest),
      episodes: relativeArtifactPath(written.outputDir, written.files.episodes),
      matches: written.files.matches.map((file) => relativeArtifactPath(written.outputDir, file))
    } satisfies StoredPublicTournamentArtifactFiles;
  }
  return {
    manifest: relativeArtifactPath(written.outputDir, written.files.manifest),
    registry: relativeArtifactPath(written.outputDir, written.files.registry),
    specNormalized: relativeArtifactPath(written.outputDir, written.files.specNormalized),
    assignment: relativeArtifactPath(written.outputDir, written.files.assignment),
    episodes: relativeArtifactPath(written.outputDir, written.files.episodes),
    trajectory: relativeArtifactPath(written.outputDir, written.files.trajectory),
    metrics: relativeArtifactPath(written.outputDir, written.files.metrics),
    integrity: relativeArtifactPath(written.outputDir, written.files.integrity),
    failures: relativeArtifactPath(written.outputDir, written.files.failures),
    costLatency: relativeArtifactPath(written.outputDir, written.files.costLatency),
    leaderboard: relativeArtifactPath(written.outputDir, written.files.leaderboard),
    benchmarkStatistics: relativeArtifactPath(written.outputDir, written.files.benchmarkStatistics),
    tournamentComparison: relativeArtifactPath(written.outputDir, written.files.tournamentComparison),
    tournamentComparisonMarkdown: relativeArtifactPath(written.outputDir, written.files.tournamentComparisonMarkdown),
    summaryMarkdown: relativeArtifactPath(written.outputDir, written.files.summaryMarkdown),
    episodesCsv: relativeArtifactPath(written.outputDir, written.files.episodesCsv),
    agentsCsv: relativeArtifactPath(written.outputDir, written.files.agentsCsv),
    metricsCsv: relativeArtifactPath(written.outputDir, written.files.metricsCsv),
    leaderboardCsv: relativeArtifactPath(written.outputDir, written.files.leaderboardCsv),
    matches: written.files.matches.map((file) => relativeArtifactPath(written.outputDir, file)),
    matchesJsonl: written.files.matchesJsonl.map((file) => relativeArtifactPath(written.outputDir, file))
  } satisfies StoredResearchTournamentArtifactFiles;
}

export function relativeExperimentMatrixArtifactFiles(
  written: ExperimentMatrixArtifactWriteResult
): StoredExperimentMatrixArtifactFiles {
  return {
    manifest: relativeArtifactPath(written.outputDir, written.files.manifest),
    specNormalized: relativeArtifactPath(written.outputDir, written.files.specNormalized),
    cells: relativeArtifactPath(written.outputDir, written.files.cells),
    statistics: relativeArtifactPath(written.outputDir, written.files.statistics),
    summaryMarkdown: relativeArtifactPath(written.outputDir, written.files.summaryMarkdown),
    modelStatsCsv: relativeArtifactPath(written.outputDir, written.files.modelStatsCsv),
    profileStatsCsv: relativeArtifactPath(written.outputDir, written.files.profileStatsCsv),
    pairwiseModelComparisonsCsv: relativeArtifactPath(written.outputDir, written.files.pairwiseModelComparisonsCsv),
    // Matrix writer already returns nested tournament manifests relative to the
    // matrix root. Validate those strings rather than treating them as cwd paths.
    tournaments: written.files.tournaments.map((file) => ({
      cellId: file.cellId,
      manifest: normalizeRequestedArtifactPath(file.manifest.split(path.sep).join("/"))
    }))
  };
}

export function relativeArtifactPath(rootDir: string, absolutePath: string): string {
  const relativePath = path.relative(path.resolve(rootDir), path.resolve(absolutePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new HttpError(500, "Tournament artifact writer returned a file outside the artifact directory.");
  }
  return relativePath.split(path.sep).join("/");
}

export function mapTournamentArtifactFiles(
  files: StoredTournamentArtifactFiles,
  mapFile: (relativePath: string) => string
): StoredTournamentArtifactFiles {
  if (!("registry" in files)) {
    return {
      manifest: mapFile(files.manifest),
      episodes: mapFile(files.episodes),
      matches: files.matches.map(mapFile)
    } satisfies StoredPublicTournamentArtifactFiles;
  }
  return {
    manifest: mapFile(files.manifest),
    registry: mapFile(files.registry),
    specNormalized: mapFile(files.specNormalized),
    assignment: mapFile(files.assignment),
    episodes: mapFile(files.episodes),
    trajectory: mapFile(files.trajectory),
    metrics: mapFile(files.metrics),
    integrity: mapFile(files.integrity),
    failures: mapFile(files.failures),
    costLatency: mapFile(files.costLatency),
    leaderboard: mapFile(files.leaderboard),
    benchmarkStatistics: mapFile(files.benchmarkStatistics),
    tournamentComparison: mapFile(files.tournamentComparison),
    tournamentComparisonMarkdown: mapFile(files.tournamentComparisonMarkdown),
    summaryMarkdown: mapFile(files.summaryMarkdown),
    episodesCsv: mapFile(files.episodesCsv),
    agentsCsv: mapFile(files.agentsCsv),
    metricsCsv: mapFile(files.metricsCsv),
    leaderboardCsv: mapFile(files.leaderboardCsv),
    matches: files.matches.map(mapFile),
    matchesJsonl: files.matchesJsonl.map(mapFile)
  } satisfies StoredResearchTournamentArtifactFiles;
}

export function mapExperimentMatrixArtifactFiles(
  files: StoredExperimentMatrixArtifactFiles,
  mapFile: (relativePath: string) => string
): StoredExperimentMatrixArtifactFiles {
  return {
    manifest: mapFile(files.manifest),
    specNormalized: mapFile(files.specNormalized),
    cells: mapFile(files.cells),
    statistics: mapFile(files.statistics),
    summaryMarkdown: mapFile(files.summaryMarkdown),
    modelStatsCsv: mapFile(files.modelStatsCsv),
    profileStatsCsv: mapFile(files.profileStatsCsv),
    pairwiseModelComparisonsCsv: mapFile(files.pairwiseModelComparisonsCsv),
    tournaments: files.tournaments.map((file) => ({ cellId: file.cellId, manifest: mapFile(file.manifest) }))
  };
}

export async function resolveRegisteredTournamentArtifactFile(
  set: StoredTournamentArtifactSet,
  requestedPath: string | undefined,
  baseDir: string | undefined
): Promise<{ relativePath: string; absolutePath: string }> {
  const relativePath = normalizeRequestedArtifactPath(requestedPath);
  const registered = registeredTournamentArtifactFiles(set);
  if (!registered.has(relativePath)) {
    throw new HttpError(404, "tournament artifact file not found");
  }
  const absolutePath = resolveUnderDirectory(set.outputDir, relativePath);
  await assertRegularFileInsideArtifactSet({ baseDir, outputDir: set.outputDir, absolutePath });
  return { relativePath, absolutePath };
}

export async function resolveRegisteredExperimentMatrixArtifactFile(
  set: StoredExperimentMatrixArtifactSet,
  requestedPath: string | undefined,
  baseDir: string | undefined
): Promise<{ relativePath: string; absolutePath: string }> {
  const relativePath = normalizeRequestedArtifactPath(requestedPath);
  if (!registeredExperimentMatrixArtifactFiles(set).has(relativePath)) {
    throw new HttpError(404, "experiment matrix artifact file not found");
  }
  const absolutePath = resolveUnderDirectory(set.outputDir, relativePath);
  await assertRegularFileInsideArtifactSet({ baseDir, outputDir: set.outputDir, absolutePath });
  return { relativePath, absolutePath };
}

export function registeredTournamentArtifactFiles(set: StoredTournamentArtifactSet): Set<string> {
  return new Set(flattenTournamentArtifactFiles(set.relativeFiles));
}

export function registeredExperimentMatrixArtifactFiles(set: StoredExperimentMatrixArtifactSet): Set<string> {
  return new Set(flattenExperimentMatrixArtifactFiles(set.relativeFiles));
}

export function flattenTournamentArtifactFiles(files: StoredTournamentArtifactFiles): string[] {
  if (!("registry" in files)) {
    return [files.manifest, files.episodes, ...files.matches];
  }
  return [
    files.manifest,
    files.registry,
    files.specNormalized,
    files.assignment,
    files.episodes,
    files.trajectory,
    files.metrics,
    files.integrity,
    files.failures,
    files.costLatency,
    files.leaderboard,
    files.benchmarkStatistics,
    files.tournamentComparison,
    files.tournamentComparisonMarkdown,
    files.summaryMarkdown,
    files.episodesCsv,
    files.agentsCsv,
    files.metricsCsv,
    files.leaderboardCsv,
    ...files.matches,
    ...files.matchesJsonl
  ];
}

export function flattenExperimentMatrixArtifactFiles(files: StoredExperimentMatrixArtifactFiles): string[] {
  return [
    files.manifest,
    files.specNormalized,
    files.cells,
    files.statistics,
    files.summaryMarkdown,
    files.modelStatsCsv,
    files.profileStatsCsv,
    files.pairwiseModelComparisonsCsv,
    ...files.tournaments.map((file) => file.manifest)
  ];
}

export function normalizeRequestedArtifactPath(requestedPath: string | undefined): string {
  if (!requestedPath) throw new HttpError(400, "artifact file path is required");
  let decoded = requestedPath;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    throw new HttpError(400, "artifact file path is not valid URL encoding");
  }
  if (!decoded || decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("/") || /^[A-Za-z]:\//.test(decoded)) {
    throw new HttpError(400, "artifact file path must be relative");
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new HttpError(400, "artifact file path must not contain traversal");
  }
  const normalized = path.posix.normalize(decoded);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    throw new HttpError(400, "artifact file path must stay inside the artifact set");
  }
  return normalized;
}

export function resolveUnderDirectory(rootDir: string, relativePath: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath.split("/").join(path.sep));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HttpError(400, "artifact file path must stay inside the artifact set");
  }
  return resolved;
}

export function resolveGeneratedArtifactDirectory(baseDir: string, artifactSetId: string): string {
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(artifactSetId)) throw new HttpError(500, "generated artifact set id is invalid");
  return resolveUnderDirectory(baseDir, artifactSetId);
}

export async function ensureWritableArtifactSubdirectory(rootDir: string, subdirectory: string, message: string): Promise<void> {
  try {
    const root = path.resolve(rootDir);
    await mkdir(subdirectory, { recursive: true });
    const info = await lstat(subdirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(500, message);
    const realRoot = await realpath(root);
    const realSubdirectory = await realpath(subdirectory);
    if (!isPathStrictlyInsideDirectory(realSubdirectory, realRoot)) {
      throw new HttpError(500, message);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, message);
  }
}

export async function assertRegularFileInsideDirectory(rootDir: string, absolutePath: string, message: string): Promise<void> {
  try {
    const root = path.resolve(rootDir);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(404, message);
    const realRoot = await realpath(root);
    const realFile = await realpath(absolutePath);
    if (!isPathStrictlyInsideDirectory(realFile, realRoot)) {
      throw new HttpError(404, message);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, message);
  }
}

export async function assertExistingArtifactSetDirectoryInsideBase(baseDir: string | undefined, outputDir: string): Promise<void> {
  try {
    const info = await lstat(outputDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(404, "tournament artifact set not found");
    const realOutputDir = await realpath(outputDir);
    if (baseDir) {
      const realBaseDir = await realpath(path.resolve(baseDir));
      if (!isPathStrictlyInsideDirectory(realOutputDir, realBaseDir)) {
        throw new HttpError(404, "tournament artifact set not found");
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "tournament artifact set not found");
  }
}

export async function assertRegularFileInsideArtifactSet(options: {
  baseDir: string | undefined;
  outputDir: string;
  absolutePath: string;
}): Promise<void> {
  try {
    await assertExistingArtifactSetDirectoryInsideBase(options.baseDir, options.outputDir);
    const info = await lstat(options.absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(404, "tournament artifact file not found");
    const realOutputDir = await realpath(options.outputDir);
    const realFile = await realpath(options.absolutePath);
    if (!isPathStrictlyInsideDirectory(realFile, realOutputDir)) {
      throw new HttpError(404, "tournament artifact file not found");
    }
    if (options.baseDir) {
      const realBaseDir = await realpath(path.resolve(options.baseDir));
      if (!isPathStrictlyInsideDirectory(realFile, realBaseDir)) {
        throw new HttpError(404, "tournament artifact file not found");
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "tournament artifact file not found");
  }
}

export function isPathStrictlyInsideDirectory(candidate: string, directory: string): boolean {
  const relativePath = path.relative(path.resolve(directory), path.resolve(candidate));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

export function contentTypeForArtifactFile(relativePath: string): string {
  if (relativePath.endsWith(".jsonl")) return "application/x-ndjson";
  if (relativePath.endsWith(".json")) return "application/json";
  if (relativePath.endsWith(".csv")) return "text/csv";
  if (relativePath.endsWith(".md")) return "text/markdown";
  return "application/octet-stream";
}

export function isFileReadNotFound(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR");
}
