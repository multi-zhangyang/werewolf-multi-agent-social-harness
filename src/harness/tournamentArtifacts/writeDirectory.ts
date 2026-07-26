import { buildBenchmarkStatistics } from "./benchmarkStatistics";
import { AGENT_CSV_HEADERS, EPISODE_CSV_HEADERS, LEADERBOARD_CSV_HEADERS, METRIC_CSV_HEADERS, agentCsvRows, buildCsv, episodeCsvRows, leaderboardCsvRows, metricCsvRows } from "./csv";
import { aggregateFailureRecords, aggregateIntegrityRecords, aggregateMetricRecords, aggregateTrajectoryRecords, episodeRecord, trajectoryRecordsFromArtifact } from "./episodeRecords";
import { filesResult, safeFileStem, writeJson, writeJsonl, writeText } from "./ioSupport";
import { buildAssignmentExport, buildManifest, buildNormalizedSpecExport, buildRegistrySnapshot, collectArtifactRecords } from "./manifest";
import { publishNewLocalArtifactDirectory } from "../localArtifactDirectory";
import { formatTournamentComparisonMarkdown } from "../matchComparison";
import { TournamentResult } from "../tournament";
import { rebuildTournamentLeaderboardFromRawRecords } from "../tournamentLeaderboard";
import { PUBLIC_TOURNAMENT_ARTIFACT_VERSION, PublicTournamentArtifactFiles, PublicTournamentArtifactWriteOptions, PublicTournamentMatchRecord, ResearchTournamentArtifactFiles, ResearchTournamentArtifactWriteOptions, TournamentArtifactWriteOptions, TournamentArtifactWriteResult, tournamentArtifactFilePaths, tournamentArtifactVisibilityForOptions } from "./model";
import { assertPublicTournamentMatchArtifact, publicMessageCount, publicPlayerCount } from "./publicPack";
import { buildCostLatencyReport, buildLeaderboard, buildTournamentComparisonExport } from "./reports";
import { buildTournamentSummaryMarkdown } from "./summary";
import path from "node:path";
import { mkdir } from "node:fs/promises";
export function writeTournamentArtifactDirectory(
  result: TournamentResult,
  options: PublicTournamentArtifactWriteOptions
): Promise<TournamentArtifactWriteResult<PublicTournamentArtifactFiles>>;
export function writeTournamentArtifactDirectory(
  result: TournamentResult,
  options: ResearchTournamentArtifactWriteOptions
): Promise<TournamentArtifactWriteResult<ResearchTournamentArtifactFiles>>;
export async function writeTournamentArtifactDirectory(
  result: TournamentResult,
  options: TournamentArtifactWriteOptions
): Promise<TournamentArtifactWriteResult> {
  const outputDir = path.resolve(options.outputDir);
  if (options.overwrite) {
    // Mutable overwrite remains a legacy CLI compatibility path. Canonical
    // server exports and matrix nesting use immutable publication below.
    return writeTournamentArtifactDirectoryDirect(result, { ...options, outputDir });
  }
  const stagedResult = await publishNewLocalArtifactDirectory({
    finalDirectory: outputDir,
    populate: (stagingDirectory) => writeTournamentArtifactDirectoryDirect(result, {
      ...options,
      outputDir: stagingDirectory,
      overwrite: false
    })
  });
  return remapArtifactDirectoryResult(stagedResult, stagedResult.outputDir, outputDir);
}

async function writeTournamentArtifactDirectoryDirect(
  result: TournamentResult,
  options: TournamentArtifactWriteOptions
): Promise<TournamentArtifactWriteResult> {
  const visibility = tournamentArtifactVisibilityForOptions(options);
  if (visibility === "public") {
    return writePublicTournamentArtifactDirectory(result, options);
  }
  const outputDir = path.resolve(options.outputDir);
  const overwrite = options.overwrite ?? false;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const artifactRecords = collectArtifactRecords(result);
  const relativeMatchPaths = new Map<number, string>();
  const relativeMatchJsonlPaths = new Map<number, string>();

  await mkdir(outputDir, { recursive: true });
  const files = tournamentArtifactFilePaths(outputDir);
  await mkdir(files.matchesDir, { recursive: true });

  for (const record of artifactRecords) {
    const stem = safeFileStem(record.matchId ?? record.runId);
    const relativePath = path.join("matches", `${stem}.json`);
    const relativeJsonlPath = path.join("matches", `${stem}.jsonl`);
    const absolutePath = path.join(outputDir, relativePath);
    const absoluteJsonlPath = path.join(outputDir, relativeJsonlPath);
    relativeMatchPaths.set(record.index, relativePath);
    relativeMatchJsonlPaths.set(record.index, relativeJsonlPath);
    files.matches.push(absolutePath);
    files.matchesJsonl.push(absoluteJsonlPath);
    // Research-truth integrity is recorded later via aggregateIntegrityRecords.
    // Public packs may write projected match files that intentionally omit truth.
    const writtenArtifact = options.projectMatchArtifact
      ? options.projectMatchArtifact(record.artifact)
      : record.artifact;
    await writeJson(absolutePath, writtenArtifact, overwrite);
    await writeJsonl(absoluteJsonlPath, trajectoryRecordsFromArtifact(writtenArtifact), overwrite);
  }

  const manifest = buildManifest(result, {
    experimentId: options.experimentId,
    createdAt,
    overwrite,
    artifactRecords,
    relativeMatchPaths,
    relativeMatchJsonlPaths,
    matchArtifactView: options.matchArtifactView ?? (options.projectMatchArtifact ? "truth-redacted" : "full"),
    assignmentTruthRedacted: Boolean(options.redactAssignmentTruth),
    visibility
  });
  const registry = buildRegistrySnapshot(result, createdAt);
  const specNormalized = buildNormalizedSpecExport(result);
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  const assignment = buildAssignmentExport(result, {
    createdAt,
    artifactsByIndex,
    relativeMatchPaths,
    relativeMatchJsonlPaths,
    redactAssignmentTruth: options.redactAssignmentTruth
  });
  const episodes = result.episodes.map((episode) =>
    episodeRecord(
      episode,
      relativeMatchPaths.get(episode.index),
      relativeMatchJsonlPaths.get(episode.index),
      artifactsByIndex.get(episode.index),
      Boolean(options.redactAssignmentTruth)
    )
  );
  const trajectory = aggregateTrajectoryRecords(result, artifactRecords, options.projectMatchArtifact);
  const metrics = aggregateMetricRecords(result, Boolean(options.redactAssignmentTruth));
  const integrity = aggregateIntegrityRecords(result, artifactRecords, relativeMatchPaths, relativeMatchJsonlPaths);
  const failures = aggregateFailureRecords(result, artifactRecords, relativeMatchPaths, Boolean(options.redactAssignmentTruth));
  const costLatency = buildCostLatencyReport(result, artifactRecords, createdAt, Boolean(options.redactAssignmentTruth));
  const benchmarkStatistics = buildBenchmarkStatistics(result, createdAt, artifactsByIndex, Boolean(options.redactAssignmentTruth));
  const rebuiltLeaderboard = rebuildTournamentLeaderboardFromRawRecords({
    models: result.models,
    profiles: result.profiles,
    episodeRecords: episodes,
    metricRecords: metrics,
    costLatencyReport: costLatency
  });
  const leaderboard = buildLeaderboard(
    result,
    createdAt,
    artifactsByIndex,
    benchmarkStatistics,
    rebuiltLeaderboard,
    Boolean(options.redactAssignmentTruth)
  );
  const tournamentComparison = buildTournamentComparisonExport(result, {
    createdAt,
    artifactRecords,
    matchArtifactView: options.matchArtifactView ?? (options.projectMatchArtifact ? "truth-redacted" : "full"),
    projectMatchArtifact: options.projectMatchArtifact
  });
  const summaryMarkdown = buildTournamentSummaryMarkdown(result, {
    createdAt,
    experimentId: options.experimentId ?? result.experiment.id,
    artifactRecords,
    integrity,
    failures,
    rebuiltLeaderboard
  });
  const episodesCsv = buildCsv(
    EPISODE_CSV_HEADERS,
    episodeCsvRows(result, relativeMatchPaths, relativeMatchJsonlPaths, artifactsByIndex, Boolean(options.redactAssignmentTruth))
  );
  const agentsCsv = buildCsv(AGENT_CSV_HEADERS, agentCsvRows(result, artifactsByIndex, Boolean(options.redactAssignmentTruth)));
  const metricsCsv = buildCsv(METRIC_CSV_HEADERS, metricCsvRows(result, Boolean(options.redactAssignmentTruth)));
  const leaderboardCsv = buildCsv(
    LEADERBOARD_CSV_HEADERS,
    leaderboardCsvRows(rebuiltLeaderboard, Boolean(options.redactAssignmentTruth))
  );
  await writeJson(files.manifest, manifest, overwrite);
  await writeJson(files.registry, registry, overwrite);
  await writeJson(files.specNormalized, specNormalized, overwrite);
  await writeJson(files.assignment, assignment, overwrite);
  await writeJsonl(files.episodes, episodes, overwrite);
  await writeJsonl(files.trajectory, trajectory, overwrite);
  await writeJsonl(files.metrics, metrics, overwrite);
  await writeJsonl(files.integrity, integrity, overwrite);
  await writeJsonl(files.failures, failures, overwrite);
  await writeJson(files.costLatency, costLatency, overwrite);
  await writeJson(files.benchmarkStatistics, benchmarkStatistics, overwrite);
  await writeJson(files.leaderboard, leaderboard, overwrite);
  await writeJson(files.tournamentComparison, tournamentComparison, overwrite);
  await writeText(files.tournamentComparisonMarkdown, formatTournamentComparisonMarkdown(tournamentComparison), overwrite);
  await writeText(files.summaryMarkdown, summaryMarkdown, overwrite);
  await writeText(files.episodesCsv, episodesCsv, overwrite);
  await writeText(files.agentsCsv, agentsCsv, overwrite);
  await writeText(files.metricsCsv, metricsCsv, overwrite);
  await writeText(files.leaderboardCsv, leaderboardCsv, overwrite);

  return filesResult(outputDir, files);
}

function remapArtifactDirectoryResult(
  result: TournamentArtifactWriteResult,
  stagingDirectory: string,
  finalDirectory: string
): TournamentArtifactWriteResult {
  const stagingRoot = path.resolve(stagingDirectory);
  const finalRoot = path.resolve(finalDirectory);
  const remap = (value: unknown): unknown => {
    if (typeof value === "string") {
      const candidate = path.resolve(value);
      if (candidate === stagingRoot) return finalRoot;
      if (candidate.startsWith(`${stagingRoot}${path.sep}`)) {
        return path.join(finalRoot, path.relative(stagingRoot, candidate));
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    }
    return value;
  };
  return remap(result) as TournamentArtifactWriteResult;
}

/**
 * The public publication boundary is intentionally tiny.  These files are
 * display artifacts, never replay, evaluation, or control-plane authority:
 *
 * - manifest.json: publication metadata and a fixed file allowlist
 * - episodes.jsonl: public episode index records
 * - matches/episode-N.json: a domain-owned public observation DTO
 */
async function writePublicTournamentArtifactDirectory(
  result: TournamentResult,
  options: TournamentArtifactWriteOptions
): Promise<TournamentArtifactWriteResult<PublicTournamentArtifactFiles>> {
  if (!options.projectPublicMatchArtifact) {
    throw new Error("Public tournament artifacts require a domain-owned public match artifact projector.");
  }
  const outputDir = path.resolve(options.outputDir);
  const overwrite = options.overwrite ?? false;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const files: PublicTournamentArtifactFiles = {
    manifest: path.join(outputDir, "manifest.json"),
    episodes: path.join(outputDir, "episodes.jsonl"),
    matchesDir: path.join(outputDir, "matches"),
    matches: []
  };
  const publicMatches: PublicTournamentMatchRecord[] = [];

  for (const record of collectArtifactRecords(result)) {
    const relativePath = path.join("matches", `episode-${record.index + 1}.json`);
    const projected = options.projectPublicMatchArtifact(record.artifact, record.index);
    assertPublicTournamentMatchArtifact(projected);
    const artifact = projected as Record<string, unknown>;
    if (artifact.episodeIndex !== record.index) {
      throw new Error("Public match projector returned an artifact for the wrong tournament episode.");
    }
    publicMatches.push({
      episodeIndex: record.index,
      projectedArtifact: artifact,
      relativePath,
      relativeJsonlPath: "",
      status: typeof artifact.status === "string" ? artifact.status : "unknown",
      harnessStatus: null,
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0,
      publicMessageCount: publicMessageCount(artifact),
      playerCount: publicPlayerCount(artifact)
    });
  }

  const episodes = publicMatches.map((match) => ({
    kind: "public-episode",
    episodeIndex: match.episodeIndex,
    status: match.status,
    match: match.relativePath,
    publicMessageCount: match.publicMessageCount
  }));
  const manifest = {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament",
    visibility: "public",
    createdAt,
    games: {
      requested: result.gamesRequested,
      completed: result.gamesCompleted,
      failed: result.gamesFailed,
      truncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length
    },
    files: {
      manifest: "manifest.json",
      episodes: "episodes.jsonl",
      matches: publicMatches.map((match) => match.relativePath)
    }
  };

  await mkdir(outputDir, { recursive: true });
  await mkdir(files.matchesDir, { recursive: true });
  for (const match of publicMatches) {
    const absolutePath = path.join(outputDir, match.relativePath);
    files.matches.push(absolutePath);
    await writeJson(absolutePath, match.projectedArtifact, overwrite);
  }
  await writeJson(files.manifest, manifest, overwrite);
  await writeJsonl(files.episodes, episodes, overwrite);
  return filesResult(outputDir, files);
}
