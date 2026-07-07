import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toTrajectoryJsonl, validateMatchArtifactIntegrity, type MatchArtifact } from "./artifacts";
import { summarizeEvaluationWarnings } from "./evaluation";
import type { NormalizedTournamentExperiment } from "./experiment";
import { hashStableState } from "./hash";
import type { HarnessAssignmentConfig, ResolvedAgentAssignment } from "./profiles";
import type { TournamentEpisode, TournamentMatchArtifactRecord, TournamentResult } from "./tournament";
import type { HarnessEvaluatorManifestEntry, HarnessForkProvenance, ProviderFailureSummary } from "./types";
import { redactSecrets } from "./redaction";

export const TOURNAMENT_ARTIFACT_VERSION = "harness.tournament.v1";
export const BENCHMARK_STATISTICS_VERSION = "harness.benchmark-statistics.v1";
export const BENCHMARK_STATISTICS_EVALUATOR_ID = "evaluation.benchmark-statistics.v1";
export const BENCHMARK_STATISTICS_EVALUATOR_VERSION = "1.0.0";
export const BENCHMARK_STATISTICS_METRIC_IDS = [
  "benchmark.status_denominators",
  "benchmark.agent_seat_strata",
  "benchmark.episode_status_strata",
  "benchmark.harness_status_strata"
];

export interface TournamentArtifactWriteOptions {
  outputDir: string;
  experimentId?: string;
  createdAt?: string;
  overwrite?: boolean;
}

export interface TournamentArtifactWriteResult {
  outputDir: string;
  files: {
    manifest: string;
    registry: string;
    specNormalized: string;
    assignment: string;
    episodes: string;
    trajectory: string;
    metrics: string;
    integrity: string;
    failures: string;
    costLatency: string;
    leaderboard: string;
    benchmarkStatistics: string;
    summaryMarkdown: string;
    episodesCsv: string;
    agentsCsv: string;
    metricsCsv: string;
    leaderboardCsv: string;
    matchesDir: string;
    matches: string[];
    matchesJsonl: string[];
  };
}

export interface TournamentForkSummary {
  checkpointId: string;
  parentRunId: string | null;
  parentMatchId: string | null;
  parentTraceId: string | null;
  parentTurnIndex: number | null;
  parentStateHash: string;
  parentTrajectoryHash: string | null;
  parentAgentsHash: string | null;
  parentSocialMessagesHash: string | null;
  parentTrajectoryLength: number;
  createdAt: string;
  reason: string | null;
}

export type TournamentNormalizedSpecArtifact = NormalizedTournamentExperiment;

export interface TournamentAssignmentArtifact {
  artifactVersion: typeof TOURNAMENT_ARTIFACT_VERSION;
  kind: "tournament-assignment";
  createdAt: string;
  seed: string;
  gamesRequested: number;
  gamesCompleted: number;
  gamesFailed: number;
  models: string[];
  profiles: TournamentResult["profiles"];
  assignment: HarnessAssignmentConfig | null;
  episodes: TournamentAssignmentEpisodeRecord[];
}

export interface TournamentAssignmentEpisodeRecord {
  episodeIndex: number;
  tournamentEpisodeIndex: number;
  seed: string;
  runId: string | null;
  matchId: string | null;
  status: TournamentEpisode["status"];
  harnessStatus: MatchArtifact["status"] | null;
  forkOf: TournamentForkSummary | null;
  matchArtifact: string | null;
  matchJsonl: string | null;
  assignment: HarnessAssignmentConfig | null;
  resolvedAssignments: ResolvedAgentAssignment[];
  agents: TournamentAssignmentAgentRecord[];
}

export interface TournamentAssignmentAgentRecord {
  playerId: string;
  seat: number;
  profileId?: string;
  model: string;
  temperature: number | null;
  role?: ResolvedAgentAssignment["role"];
  team?: ResolvedAgentAssignment["team"];
  policyName?: ResolvedAgentAssignment["policyName"];
}

export interface TournamentFailureAttribution {
  actorId: string | null;
  profileId: string | null;
  model: string | null;
  seat: number | null;
  role: string | null;
  team: string | null;
  policyName: string | null;
  actionKind: string | null;
  traceId: string | null;
  eventId: string | null;
  eventSeq: number | null;
  failureKind: ProviderFailureSummary["failureKind"] | null;
  providerStage: ProviderFailureSummary["providerStage"] | null;
  status: number | null;
  timeoutMs: number | null;
  aborted: boolean | null;
  retryable: boolean | null;
  attempts: number | null;
  maxAttempts: number | null;
  providerRequestId: string | null;
  providerFailure: ProviderFailureSummary | null;
  source: "harness.error";
}

interface BenchmarkAgentSeatStratum {
  dimension: "model" | "profile" | "role" | "team" | "seat";
  key: string;
  scheduledSeatCount: number;
  completedSeatCount: number;
  failedSeatCount: number;
  completedWithOutcomeCount: number;
  winCount: number;
  rewardCount: number;
  rewardTotal: number;
  averageReward: number;
  episodeIndexes: number[];
  seeds: string[];
}

interface BenchmarkEpisodeStratum {
  dimension: "episodeStatus" | "harnessStatus";
  key: string;
  episodeCount: number;
  completedCount: number;
  failedCount: number;
  artifactCount: number;
  evaluationCount: number;
  evaluationReportCount: number;
  harnessErrorCount: number;
  episodeIndexes: number[];
  seeds: string[];
}

export async function writeTournamentArtifactDirectory(
  result: TournamentResult,
  options: TournamentArtifactWriteOptions
): Promise<TournamentArtifactWriteResult> {
  const outputDir = path.resolve(options.outputDir);
  const overwrite = options.overwrite ?? false;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const artifactRecords = collectArtifactRecords(result);
  const relativeMatchPaths = new Map<number, string>();
  const relativeMatchJsonlPaths = new Map<number, string>();

  await mkdir(outputDir, { recursive: true });
  const matchesDir = path.join(outputDir, "matches");
  await mkdir(matchesDir, { recursive: true });

  const files = {
    manifest: path.join(outputDir, "manifest.json"),
    registry: path.join(outputDir, "registry.json"),
    specNormalized: path.join(outputDir, "spec.normalized.json"),
    assignment: path.join(outputDir, "assignment.json"),
    episodes: path.join(outputDir, "episodes.jsonl"),
    trajectory: path.join(outputDir, "trajectory.jsonl"),
    metrics: path.join(outputDir, "metrics.jsonl"),
    integrity: path.join(outputDir, "integrity.jsonl"),
    failures: path.join(outputDir, "failures.jsonl"),
    costLatency: path.join(outputDir, "cost_latency.json"),
    leaderboard: path.join(outputDir, "leaderboard.json"),
    benchmarkStatistics: path.join(outputDir, "benchmark_statistics.json"),
    summaryMarkdown: path.join(outputDir, "summary.md"),
    episodesCsv: path.join(outputDir, "episodes.csv"),
    agentsCsv: path.join(outputDir, "agents.csv"),
    metricsCsv: path.join(outputDir, "metrics.csv"),
    leaderboardCsv: path.join(outputDir, "leaderboard.csv"),
    matchesDir,
    matches: [] as string[],
    matchesJsonl: [] as string[]
  };

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
    await writeJson(absolutePath, record.artifact, overwrite);
    await writeJsonl(absoluteJsonlPath, trajectoryRecordsFromArtifact(record.artifact), overwrite);
  }

  const manifest = buildManifest(result, {
    experimentId: options.experimentId,
    createdAt,
    overwrite,
    artifactRecords,
    relativeMatchPaths,
    relativeMatchJsonlPaths
  });
  const registry = buildRegistrySnapshot(result, createdAt);
  const specNormalized = buildNormalizedSpecExport(result);
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  const assignment = buildAssignmentExport(result, {
    createdAt,
    artifactsByIndex,
    relativeMatchPaths,
    relativeMatchJsonlPaths
  });
  const episodes = result.episodes.map((episode) =>
    episodeRecord(episode, relativeMatchPaths.get(episode.index), relativeMatchJsonlPaths.get(episode.index), artifactsByIndex.get(episode.index))
  );
  const trajectory = aggregateTrajectoryRecords(result, artifactRecords);
  const metrics = aggregateMetricRecords(result);
  const integrity = aggregateIntegrityRecords(result, artifactRecords, relativeMatchPaths, relativeMatchJsonlPaths);
  const failures = aggregateFailureRecords(result, artifactRecords, relativeMatchPaths);
  const costLatency = buildCostLatencyReport(result, artifactRecords, createdAt);
  const benchmarkStatistics = buildBenchmarkStatistics(result, createdAt, artifactsByIndex);
  const leaderboard = buildLeaderboard(result, createdAt, artifactsByIndex, benchmarkStatistics);
  const summaryMarkdown = buildTournamentSummaryMarkdown(result, {
    createdAt,
    experimentId: options.experimentId ?? result.experiment.id,
    artifactRecords,
    integrity,
    failures
  });
  const episodesCsv = buildCsv(EPISODE_CSV_HEADERS, episodeCsvRows(result, relativeMatchPaths, relativeMatchJsonlPaths, artifactsByIndex));
  const agentsCsv = buildCsv(AGENT_CSV_HEADERS, agentCsvRows(result));
  const metricsCsv = buildCsv(METRIC_CSV_HEADERS, metricCsvRows(result));
  const leaderboardCsv = buildCsv(LEADERBOARD_CSV_HEADERS, leaderboardCsvRows(result));

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
  await writeText(files.summaryMarkdown, summaryMarkdown, overwrite);
  await writeText(files.episodesCsv, episodesCsv, overwrite);
  await writeText(files.agentsCsv, agentsCsv, overwrite);
  await writeText(files.metricsCsv, metricsCsv, overwrite);
  await writeText(files.leaderboardCsv, leaderboardCsv, overwrite);

  return filesResult(outputDir, files);
}

function collectArtifactRecords(result: TournamentResult): TournamentMatchArtifactRecord[] {
  if (result.artifacts?.length) return result.artifacts;
  return result.episodes.flatMap((episode) => {
    if (!episode.artifact) return [];
    return [
      {
        index: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? episode.artifact.runId,
        matchId: episode.matchId ?? episode.artifact.matchId,
        artifact: episode.artifact
      }
    ];
  });
}

function buildManifest(
  result: TournamentResult,
  options: {
    experimentId?: string;
    createdAt: string;
    overwrite: boolean;
    artifactRecords: TournamentMatchArtifactRecord[];
    relativeMatchPaths: Map<number, string>;
    relativeMatchJsonlPaths: Map<number, string>;
  }
): object {
  const statusCounts = countStatuses(result.episodes);
  const forkLineage = collectForkLineage(result, options.artifactRecords);
  const warningSummary = summarizeEvaluationWarnings(
    options.artifactRecords.flatMap((record) => record.artifact.evaluationReport.warnings ?? [])
  );
  const integrityRecords = aggregateIntegrityRecords(result, options.artifactRecords, options.relativeMatchPaths, options.relativeMatchJsonlPaths);
  const integrityErrorCount = integrityRecords.reduce((sum, record) => sum + record.errorCount, 0);
  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament",
    experimentId: options.experimentId ?? result.experiment.id,
    createdAt: options.createdAt,
    seed: result.seed,
    seedSchedule: result.episodes.map((episode) => ({ index: episode.index, seed: episode.seed })),
    models: result.models,
    profiles: result.profiles,
    assignment: result.assignment ?? null,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesHarnessCompleted: statusCounts.completed ?? 0,
    gamesTruncated: statusCounts.truncated ?? 0,
    gamesHarnessFailed: statusCounts.failed ?? 0,
    maxTransitions: result.maxTransitions ?? null,
    statusCounts,
    evaluationWarningCount: warningSummary.warningCount,
    evaluationWarningSeverityCounts: warningSummary.warningSeverityCounts,
    evaluationWarningCodes: warningSummary.warningCodes.map((warning) => warning.code),
    evaluationWarningSummary: warningSummary,
    artifactIntegrityOkCount: integrityRecords.filter((record) => record.ok).length,
    artifactIntegrityErrorCount: integrityErrorCount,
    artifactIntegrityErroredMatchCount: integrityRecords.filter((record) => !record.ok).length,
    forkCount: forkLineage.length,
    forks: forkLineage,
    collisionPolicy: options.overwrite ? "overwrite" : "fail-if-exists",
    files: {
      manifest: "manifest.json",
      registry: "registry.json",
      specNormalized: "spec.normalized.json",
      assignment: "assignment.json",
      episodes: "episodes.jsonl",
      trajectory: "trajectory.jsonl",
      metrics: "metrics.jsonl",
      integrity: "integrity.jsonl",
      failures: "failures.jsonl",
      costLatency: "cost_latency.json",
      leaderboard: "leaderboard.json",
      benchmarkStatistics: "benchmark_statistics.json",
      summaryMarkdown: "summary.md",
      episodesCsv: "episodes.csv",
      agentsCsv: "agents.csv",
      metricsCsv: "metrics.csv",
      leaderboardCsv: "leaderboard.csv",
      matches: options.artifactRecords.map((record) => options.relativeMatchPaths.get(record.index)).filter(Boolean),
      matchesJsonl: options.artifactRecords.map((record) => options.relativeMatchJsonlPaths.get(record.index)).filter(Boolean)
    },
    matchCount: options.artifactRecords.length,
    matches: options.artifactRecords.map((record) => {
      const matchWarningSummary = summarizeEvaluationWarnings(record.artifact.evaluationReport.warnings);
      const integrity = integrityRecords.find((item) => item.episodeIndex === record.index);
      return {
        episodeIndex: record.index,
        seed: record.seed,
        runId: record.runId,
        matchId: record.matchId ?? null,
        status: record.artifact.status,
        evaluationWarningCount: matchWarningSummary.warningCount,
        evaluationWarningCodes: matchWarningSummary.warningCodes.map((warning) => warning.code),
        integrityOk: integrity?.ok ?? false,
        integrityErrorCount: integrity?.errorCount ?? null,
        forkOf: summarizeForkOf(forkOfForEpisode(result.episodes.find((episode) => episode.index === record.index), record.artifact)),
        path: options.relativeMatchPaths.get(record.index) ?? null,
        jsonlPath: options.relativeMatchJsonlPaths.get(record.index) ?? null
      };
    })
  };
}

function buildNormalizedSpecExport(result: TournamentResult): TournamentNormalizedSpecArtifact {
  return result.experiment;
}

function buildAssignmentExport(
  result: TournamentResult,
  options: {
    createdAt: string;
    artifactsByIndex: Map<number, MatchArtifact>;
    relativeMatchPaths: Map<number, string>;
    relativeMatchJsonlPaths: Map<number, string>;
  }
): TournamentAssignmentArtifact {
  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament-assignment",
    createdAt: options.createdAt,
    seed: result.seed,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    models: result.models,
    profiles: result.profiles,
    assignment: result.assignment ?? null,
    episodes: result.episodes.map((episode) => {
      const artifact = options.artifactsByIndex.get(episode.index);
      const resolvedAssignments = episode.resolvedAssignments.length ? episode.resolvedAssignments : artifact?.resolvedAssignments ?? [];
      return {
        episodeIndex: episode.index,
        tournamentEpisodeIndex: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
        matchArtifact: options.relativeMatchPaths.get(episode.index) ?? null,
        matchJsonl: options.relativeMatchJsonlPaths.get(episode.index) ?? null,
        assignment: episode.assignment ?? result.assignment ?? artifact?.assignment ?? null,
        resolvedAssignments,
        agents: assignmentAgentsForEpisode(episode, resolvedAssignments)
      };
    })
  };
}

function assignmentAgentsForEpisode(
  episode: TournamentEpisode,
  resolvedAssignments: MatchArtifact["resolvedAssignments"]
): TournamentAssignmentAgentRecord[] {
  const agentsByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent]));
  if (resolvedAssignments.length) {
    return resolvedAssignments.map((assignment) => {
      const agent = agentsByPlayer.get(assignment.playerId);
      return {
        playerId: assignment.playerId,
        seat: assignment.seat,
        profileId: assignment.profileId ?? agent?.profileId,
        model: assignment.model,
        temperature: assignment.temperature,
        role: assignment.role ?? agent?.role,
        team: assignment.team ?? agent?.team,
        policyName: assignment.policyName ?? agent?.policyName
      };
    });
  }
  return episode.agents.map((agent) => ({
    playerId: agent.playerId,
    seat: agent.seat,
    profileId: agent.profileId,
    model: agent.model,
    temperature: null,
    role: agent.role,
    team: agent.team,
    policyName: agent.policyName
  }));
}

function buildRegistrySnapshot(result: TournamentResult, createdAt: string): object {
  const reports = result.episodes.flatMap((episode) => (episode.evaluationReport ? [{ episode, report: episode.evaluationReport }] : []));
  const registryEntries = [
    benchmarkStatisticsManifestEntry(),
    ...reports.flatMap(({ report }) =>
      report.evaluatorRegistry?.length
        ? report.evaluatorRegistry
        : report.evaluatorIds.map((id) => ({
            id,
            label: id,
            version: "unknown"
          }))
    )
  ];
  const registryById = new Map(registryEntries.map((entry) => [`${entry.id}@${entry.version}`, entry]));
  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "evaluator-registry-snapshot",
    createdAt,
    evaluatorIds: Array.from(new Set(registryEntries.map((entry) => entry.id))),
    evaluators: [...registryById.values()],
    reports: reports.map(({ episode, report }) => ({
      episodeIndex: episode.index,
      seed: episode.seed,
      matchId: episode.matchId ?? null,
      runId: episode.runId ?? null,
      reportId: report.id,
      createdAt: report.createdAt,
      evaluatorIds: report.evaluatorIds,
      evaluatorRegistry: report.evaluatorRegistry ?? [],
      metricCount: report.metricCount,
      warnings: report.warnings ?? [],
      warningSummary: summarizeEvaluationWarnings(report.warnings),
      summary: report.summary
    }))
  };
}

function benchmarkStatisticsManifestEntry(): HarnessEvaluatorManifestEntry {
  return {
    id: BENCHMARK_STATISTICS_EVALUATOR_ID,
    label: "Benchmark statistics run-set evaluator",
    version: BENCHMARK_STATISTICS_EVALUATOR_VERSION,
    inputSchema: "harness.tournament-result.v1",
    outputSchema: BENCHMARK_STATISTICS_VERSION,
    mode: "deterministic",
    metricIds: BENCHMARK_STATISTICS_METRIC_IDS,
    rubric:
      "Aggregates run-set denominators, seed ledger, artifact coverage, and descriptive stratification counts. It does not claim model superiority, causal influence, or counterfactual effects.",
    dependencies: {
      artifacts: "TournamentResult episodes, match artifacts, assignment artifact, failure records, metrics records, and normalized experiment spec"
    },
    aggregation: "run_set_denominators_and_strata",
    visibility: "postgame"
  };
}

function episodeRecord(episode: TournamentEpisode, matchPath?: string, matchJsonlPath?: string, artifact?: MatchArtifact): object {
  return {
    type: "episode",
    episodeIndex: episode.index,
    tournamentEpisodeIndex: episode.index,
    index: episode.index,
    seed: episode.seed,
    runId: episode.runId ?? null,
    matchId: episode.matchId ?? null,
    status: episode.status,
    harnessStatus: episode.harnessStatus ?? null,
    winner: episode.winner ?? null,
    phase: episode.phase ?? null,
    day: episode.day ?? null,
    trajectorySteps: episode.trajectory?.length ?? 0,
    socialStatus: episode.socialEpisode?.status ?? null,
    messageCount: episode.socialEpisode?.messages.length ?? 0,
    channelCount: episode.socialEpisode?.channels.length ?? 0,
    metricCount: episode.evaluationReport?.metricCount ?? 0,
    evaluationWarningCount: summarizeEvaluationWarnings(episode.evaluationReport?.warnings).warningCount,
    evaluationWarningCodes: summarizeEvaluationWarnings(episode.evaluationReport?.warnings).warningCodes.map((warning) => warning.code),
    warningSummary: summarizeEvaluationWarnings(episode.evaluationReport?.warnings),
    evaluatorIds: episode.evaluationReport?.evaluatorIds ?? [],
    forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
    assignment: episode.assignment ?? null,
    resolvedAssignments: episode.resolvedAssignments,
    agents: episode.agents,
    error: episode.error ?? null,
    matchArtifact: matchPath ?? null,
    matchJsonl: matchJsonlPath ?? null
  };
}

function aggregateTrajectoryRecords(result: TournamentResult, artifactRecords: TournamentMatchArtifactRecord[]): object[] {
  return artifactRecords.flatMap((record) => {
    const episode = result.episodes.find((item) => item.index === record.index);
    return trajectoryRecordsFromArtifact(record.artifact).map((parsed) => {
      return {
        ...parsed,
        episodeIndex: record.index,
        tournamentEpisodeIndex: record.index,
        tournamentSeed: result.seed,
        episodeSeed: episode?.seed ?? record.seed,
        runId: typeof parsed.runId === "string" ? parsed.runId : record.runId,
        matchId: typeof parsed.matchId === "string" ? parsed.matchId : record.matchId ?? null
      };
    });
  });
}

function trajectoryRecordsFromArtifact(artifact: MatchArtifact): Record<string, unknown>[] {
  return toTrajectoryJsonl(artifact)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function aggregateMetricRecords(result: TournamentResult): object[] {
  return result.episodes.flatMap((episode) =>
    (episode.evaluationReport?.metrics ?? []).map((metric) => ({
      type: "metric",
      episodeIndex: episode.index,
      tournamentEpisodeIndex: episode.index,
      tournamentSeed: result.seed,
      episodeSeed: episode.seed,
      runId: episode.runId ?? null,
      matchId: episode.matchId ?? null,
      status: episode.status,
      harnessStatus: episode.harnessStatus ?? null,
      agents: episode.agents.map((agent) => ({
        playerId: agent.playerId,
        profileId: agent.profileId,
        model: agent.model,
        role: agent.role,
        team: agent.team,
        seat: agent.seat
      })),
      evaluationReportId: episode.evaluationReport?.id,
      ...metric
    }))
  );
}

function aggregateIntegrityRecords(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  relativeMatchPaths: Map<number, string>,
  relativeMatchJsonlPaths: Map<number, string>
): Array<{
  type: "artifact_integrity";
  episodeIndex: number;
  tournamentEpisodeIndex: number;
  tournamentSeed: string;
  episodeSeed: string;
  runId: string;
  matchId: string | null;
  status: MatchArtifact["status"];
  ok: boolean;
  errorCount: number;
  errors: string[];
  matchArtifact: string | null;
  matchJsonl: string | null;
}> {
  return artifactRecords.map((record) => {
    const episode = result.episodes.find((item) => item.index === record.index);
    const errors = validateMatchArtifactIntegrity(record.artifact);
    return {
      type: "artifact_integrity",
      episodeIndex: record.index,
      tournamentEpisodeIndex: record.index,
      tournamentSeed: result.seed,
      episodeSeed: episode?.seed ?? record.seed,
      runId: record.runId,
      matchId: record.matchId ?? null,
      status: record.artifact.status,
      ok: errors.length === 0,
      errorCount: errors.length,
      errors,
      matchArtifact: relativeMatchPaths.get(record.index) ?? null,
      matchJsonl: relativeMatchJsonlPaths.get(record.index) ?? null
    };
  });
}

function aggregateFailureRecords(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  relativeMatchPaths: Map<number, string>
): object[] {
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  return result.episodes
    .filter((episode) => episode.status === "failed" || episode.harnessStatus === "failed")
    .map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const failureAttributions = failureAttributionsForEpisode(episode, artifact);
      return {
        type: "failure",
        episodeIndex: episode.index,
        tournamentEpisodeIndex: episode.index,
        tournamentSeed: result.seed,
        episodeSeed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
        failureReason: episode.error ?? artifact?.failureReason ?? null,
        failureStateHash: artifact?.failureStateHash ?? null,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
        harnessErrorCount: episode.metrics?.harnessErrorCount ?? artifact?.metrics.harnessErrorCount ?? null,
        primaryFailure: failureAttributions[0] ?? null,
        failureAttributions,
        agents: episode.agents,
        partialArtifact: relativeMatchPaths.get(episode.index) ?? null
      };
    });
}

function failureAttributionsForEpisode(episode: TournamentEpisode, artifact?: MatchArtifact): TournamentFailureAttribution[] {
  const agentByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent]));
  return (artifact?.events ?? [])
    .filter((event) => event.type === "harness.error")
    .map((event) => {
      const payload = failurePayload(event.payload);
      const actorId = event.actorId ?? null;
      const agent = actorId ? agentByPlayer.get(actorId) : undefined;
      const providerFailure = payload.providerFailure ?? null;
      return {
        actorId,
        profileId: agent?.profileId ?? null,
        model: agent?.model ?? payload.model ?? null,
        seat: agent?.seat ?? null,
        role: agent?.role ?? null,
        team: agent?.team ?? null,
        policyName: agent?.policyName ?? null,
        actionKind: payload.actionKind ?? null,
        traceId: payload.traceId ?? null,
        eventId: event.id ?? null,
        eventSeq: event.seq ?? null,
        failureKind: providerFailure?.failureKind ?? null,
        providerStage: providerFailure?.providerStage ?? null,
        status: providerFailure?.status ?? null,
        timeoutMs: providerFailure?.timeoutMs ?? null,
        aborted: providerFailure?.aborted ?? null,
        retryable: providerFailure?.retryable ?? null,
        attempts: providerFailure?.attempts ?? null,
        maxAttempts: providerFailure?.maxAttempts ?? null,
        providerRequestId: providerFailure?.providerRequestId ?? null,
        providerFailure,
        source: "harness.error"
      };
    });
}

function failurePayload(payload: unknown): {
  model?: string;
  actionKind?: string;
  traceId?: string;
  providerFailure?: ProviderFailureSummary;
} {
  if (!isRecord(payload)) return {};
  return {
    model: typeof payload.model === "string" ? payload.model : undefined,
    actionKind: typeof payload.actionKind === "string" ? payload.actionKind : undefined,
    traceId: typeof payload.traceId === "string" ? payload.traceId : undefined,
    providerFailure: providerFailurePayload(payload.providerFailure)
  };
}

function providerFailurePayload(value: unknown): ProviderFailureSummary | undefined {
  if (!isRecord(value)) return undefined;
  const failureKind = typeof value.failureKind === "string" ? value.failureKind : undefined;
  if (!isProviderFailureKind(failureKind)) return undefined;
  const summary: ProviderFailureSummary = { failureKind };
  const providerStage = typeof value.providerStage === "string" ? value.providerStage : undefined;
  if (isProviderFailureStage(providerStage)) summary.providerStage = providerStage;
  copyNumber(value, summary, "status");
  copyNumber(value, summary, "timeoutMs");
  copyBoolean(value, summary, "aborted");
  copyBoolean(value, summary, "retryable");
  copyNumber(value, summary, "attempts");
  copyNumber(value, summary, "maxAttempts");
  copyString(value, summary, "providerRequestId");
  copyString(value, summary, "retryCause");
  copyString(value, summary, "abortReason");
  copyString(value, summary, "causeName");
  return summary;
}

function copyNumber(source: Record<string, unknown>, target: ProviderFailureSummary, key: "status" | "timeoutMs" | "attempts" | "maxAttempts"): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function copyBoolean(source: Record<string, unknown>, target: ProviderFailureSummary, key: "aborted" | "retryable"): void {
  const value = source[key];
  if (typeof value === "boolean") target[key] = value;
}

function copyString(
  source: Record<string, unknown>,
  target: ProviderFailureSummary,
  key: "providerRequestId" | "retryCause" | "abortReason" | "causeName"
): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) target[key] = value;
}

function isProviderFailureKind(value: string | undefined): value is ProviderFailureSummary["failureKind"] {
  return (
    value === "http" ||
    value === "timeout" ||
    value === "abort" ||
    value === "stream_invalid_json" ||
    value === "stream_empty" ||
    value === "stream_missing_body" ||
    value === "non_json" ||
    value === "empty_content" ||
    value === "network" ||
    value === "unknown"
  );
}

function isProviderFailureStage(value: string | undefined): value is NonNullable<ProviderFailureSummary["providerStage"]> {
  return (
    value === "before_start" ||
    value === "during_request" ||
    value === "during_stream" ||
    value === "during_retry_delay" ||
    value === "http_response" ||
    value === "stream_start" ||
    value === "stream_parse" ||
    value === "stream_finish" ||
    value === "non_stream_parse"
  );
}

function buildCostLatencyReport(result: TournamentResult, artifactRecords: TournamentMatchArtifactRecord[], createdAt: string): object {
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  const totals = createEmptyCostLatencyStats();
  const byModel = new Map<string, ReturnType<typeof createEmptyCostLatencyStats>>();
  const episodes = result.episodes.map((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const metrics = artifact?.metrics ?? episode.metrics;
    const usage = metrics?.modelUsage ?? {};
    const episodeStats = createEmptyCostLatencyStats();
    episodeStats.harnessTurns = metrics?.harnessTurnCount ?? artifact?.trajectory.length ?? episode.trajectory?.length ?? 0;
    episodeStats.harnessErrors = metrics?.harnessErrorCount ?? 0;

    for (const [model, modelUsage] of Object.entries(usage)) {
      addModelUsage(episodeStats, modelUsage);
      addModelUsage(totals, modelUsage);
      const modelStats = byModel.get(model) ?? createEmptyCostLatencyStats();
      addModelUsage(modelStats, modelUsage);
      modelStats.harnessTurns += modelUsage.calls;
      byModel.set(model, modelStats);
    }
    totals.harnessTurns += episodeStats.harnessTurns;
    totals.harnessErrors += episodeStats.harnessErrors;

    const traceStats = traceCostLatencyStats(artifact);
    mergeTraceStats(episodeStats, traceStats);
    mergeTraceStats(totals, traceStats);
    for (const [model, stats] of traceStats.byModel.entries()) {
      const modelStats = byModel.get(model) ?? createEmptyCostLatencyStats();
      mergeTraceStats(modelStats, stats);
      byModel.set(model, modelStats);
    }

    for (const attribution of failureAttributionsForEpisode(episode, artifact)) {
      if (!attribution.providerFailure) continue;
      recordProviderFailure(episodeStats.providerFailures, attribution.providerFailure);
      recordProviderFailure(totals.providerFailures, attribution.providerFailure);
      const model = attribution.model ?? "unknown";
      const modelStats = byModel.get(model) ?? createEmptyCostLatencyStats();
      recordProviderFailure(modelStats.providerFailures, attribution.providerFailure);
      byModel.set(model, modelStats);
    }

    return {
      episodeIndex: episode.index,
      tournamentEpisodeIndex: episode.index,
      tournamentSeed: result.seed,
      episodeSeed: episode.seed,
      runId: episode.runId ?? artifact?.runId ?? null,
      matchId: episode.matchId ?? artifact?.matchId ?? null,
      status: episode.status,
      harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
      providerRequestIds: traceStats.providerRequestIds,
      attempts: traceStats.attempts,
      ...finalizeCostLatencyStats(episodeStats),
      modelUsage: Object.fromEntries(
        Object.entries(usage).map(([model, modelUsage]) => [
          model,
          {
            ...modelUsage,
            averageLatencyMs: modelUsage.calls ? Math.round(modelUsage.latencyMs / modelUsage.calls) : 0
          }
        ])
      )
    };
  });

  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament-cost-latency",
    createdAt,
    seed: result.seed,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    pricing: {
      costEstimate: null,
      currency: null,
      note: "Token and latency totals are recorded, but no provider pricing table is configured in this harness."
    },
    totals: finalizeCostLatencyStats(totals),
    byModel: Object.fromEntries([...byModel.entries()].map(([model, stats]) => [model, finalizeCostLatencyStats(stats)])),
    episodes
  };
}

function buildLeaderboard(
  result: TournamentResult,
  createdAt: string,
  artifactsByIndex: Map<number, MatchArtifact> = new Map(),
  benchmarkStatistics: object = buildBenchmarkStatistics(result, createdAt, artifactsByIndex)
): object {
  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament-leaderboard",
    createdAt,
    seed: result.seed,
    models: result.models,
    profiles: result.profiles,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    maxTransitions: result.maxTransitions ?? null,
    assignment: result.assignment ?? null,
    modelStats: result.modelStats,
    profileStats: result.profileStats,
    benchmarkStatistics,
    episodes: result.episodes.map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      return {
        index: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? null,
        winner: episode.winner ?? null,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
        error: episode.error ?? null
      };
    })
  };
}

function buildBenchmarkStatistics(result: TournamentResult, createdAt: string, artifactsByIndex: Map<number, MatchArtifact>): object {
  const harnessStatusCounts = countStatuses(result.episodes);
  const scheduledEpisodes = result.episodes.length;
  const artifactCount = artifactsByIndex.size;
  const agentStrata = {
    byModel: new Map<string, BenchmarkAgentSeatStratum>(),
    byProfile: new Map<string, BenchmarkAgentSeatStratum>(),
    byRole: new Map<string, BenchmarkAgentSeatStratum>(),
    byTeam: new Map<string, BenchmarkAgentSeatStratum>(),
    bySeat: new Map<string, BenchmarkAgentSeatStratum>()
  };
  const episodeStrata = {
    byEpisodeStatus: new Map<string, BenchmarkEpisodeStratum>(),
    byHarnessStatus: new Map<string, BenchmarkEpisodeStratum>()
  };

  for (const episode of result.episodes) {
    const artifact = artifactsByIndex.get(episode.index);
    recordEpisodeStratum(episodeStrata.byEpisodeStatus, "episodeStatus", episode.status, episode, artifact);
    recordEpisodeStratum(episodeStrata.byHarnessStatus, "harnessStatus", episode.harnessStatus ?? "tournamentFailed", episode, artifact);
    for (const agent of episode.agents) {
      recordAgentSeatStratum(agentStrata.byModel, "model", agent.model, episode, agent);
      if (agent.profileId) recordAgentSeatStratum(agentStrata.byProfile, "profile", agent.profileId, episode, agent);
      if (agent.role) recordAgentSeatStratum(agentStrata.byRole, "role", agent.role, episode, agent);
      if (agent.team) recordAgentSeatStratum(agentStrata.byTeam, "team", agent.team, episode, agent);
      recordAgentSeatStratum(agentStrata.bySeat, "seat", String(agent.seat), episode, agent);
    }
  }

  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament-benchmark-statistics",
    schemaVersion: BENCHMARK_STATISTICS_VERSION,
    evaluatorId: BENCHMARK_STATISTICS_EVALUATOR_ID,
    evaluatorVersion: BENCHMARK_STATISTICS_EVALUATOR_VERSION,
    metricIds: BENCHMARK_STATISTICS_METRIC_IDS,
    createdAt,
    benchmarkId: result.experiment.id,
    runSetId: `${result.seed}:requested=${result.gamesRequested}:scheduled=${scheduledEpisodes}`,
    experimentSpecVersion: result.experiment.version,
    experimentSpecHash: hashStableState(result.experiment),
    visibility: "postgame",
    inputArtifacts: ["spec.normalized.json", "assignment.json", "episodes.jsonl", "integrity.jsonl", "matches/*.json"],
    denominatorPolicy: {
      requestedEpisodes: "All requested tournament episodes, including unscheduled episodes after an early stop.",
      scheduledEpisodes: "Episodes present in TournamentResult.episodes.",
      completedOnlyAggregates: "Existing modelStats and profileStats aggregate only episodes with episode.status === completed.",
      failedEpisodes: "Harness and pre-harness failures remain in status denominators and failure artifacts, not in completed-only reward averages.",
      superiorityClaims: false
    },
    comparisonPolicy: {
      pairedSeedDeltas: "not_available_without_paired_design_contract",
      headToHeadMatrix: "not_available_without_paired_design_contract",
      confidenceIntervals: "not_available_without_metric_specific_interval_contract",
      effectSizes: "not_available_without_metric_specific_effect_size_contract"
    },
    statusDenominators: {
      gamesRequested: result.gamesRequested,
      episodesScheduled: scheduledEpisodes,
      episodesUnscheduled: Math.max(0, result.gamesRequested - scheduledEpisodes),
      gamesCompleted: result.gamesCompleted,
      gamesFailed: result.gamesFailed,
      artifactCount,
      matchArtifactCount: artifactCount,
      completedWithEvaluation: result.episodes.filter((episode) => episode.status === "completed" && Boolean(episode.evaluation)).length,
      completedWithEvaluationReport: result.episodes.filter((episode) => episode.status === "completed" && Boolean(episode.evaluationReport)).length,
      failedWithArtifact: result.episodes.filter((episode) => episode.status === "failed" && artifactsByIndex.has(episode.index)).length,
      preHarnessFailures: result.episodes.filter((episode) => episode.status === "failed" && !episode.harnessStatus).length,
      harnessStatusCounts
    },
    stratificationDimensions: ["model", "profile", "role", "team", "seat", "episodeStatus", "harnessStatus"],
    seedLedger: result.episodes.map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      return {
        episodeIndex: episode.index,
        tournamentEpisodeIndex: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? null,
        hasArtifact: Boolean(artifact),
        hasEvaluation: Boolean(episode.evaluation),
        hasEvaluationReport: Boolean(episode.evaluationReport)
      };
    }),
    strata: {
      byModel: mapToSortedRecord(agentStrata.byModel, finalizeAgentSeatStratum),
      byProfile: mapToSortedRecord(agentStrata.byProfile, finalizeAgentSeatStratum),
      byRole: mapToSortedRecord(agentStrata.byRole, finalizeAgentSeatStratum),
      byTeam: mapToSortedRecord(agentStrata.byTeam, finalizeAgentSeatStratum),
      bySeat: mapToSortedRecord(agentStrata.bySeat, finalizeAgentSeatStratum),
      byEpisodeStatus: mapToSortedRecord(episodeStrata.byEpisodeStatus, finalizeEpisodeStratum),
      byHarnessStatus: mapToSortedRecord(episodeStrata.byHarnessStatus, finalizeEpisodeStratum)
    }
  };
}

function recordAgentSeatStratum(
  strata: Map<string, BenchmarkAgentSeatStratum>,
  dimension: BenchmarkAgentSeatStratum["dimension"],
  key: string,
  episode: TournamentEpisode,
  agent: TournamentEpisode["agents"][number]
): void {
  const stats = strata.get(key) ?? createAgentSeatStratum(dimension, key);
  stats.scheduledSeatCount += 1;
  if (episode.status === "completed") {
    stats.completedSeatCount += 1;
  } else {
    stats.failedSeatCount += 1;
  }
  if (agent.won !== undefined) {
    stats.completedWithOutcomeCount += 1;
    if (agent.won) stats.winCount += 1;
  }
  if (typeof agent.reward === "number" && Number.isFinite(agent.reward)) {
    stats.rewardCount += 1;
    stats.rewardTotal += agent.reward;
  }
  addUniqueNumber(stats.episodeIndexes, episode.index);
  addUnique(stats.seeds, episode.seed);
  strata.set(key, stats);
}

function createAgentSeatStratum(dimension: BenchmarkAgentSeatStratum["dimension"], key: string): BenchmarkAgentSeatStratum {
  return {
    dimension,
    key,
    scheduledSeatCount: 0,
    completedSeatCount: 0,
    failedSeatCount: 0,
    completedWithOutcomeCount: 0,
    winCount: 0,
    rewardCount: 0,
    rewardTotal: 0,
    averageReward: 0,
    episodeIndexes: [],
    seeds: []
  };
}

function finalizeAgentSeatStratum(stats: BenchmarkAgentSeatStratum): BenchmarkAgentSeatStratum {
  return {
    ...stats,
    rewardTotal: round3(stats.rewardTotal),
    averageReward: stats.rewardCount ? round3(stats.rewardTotal / stats.rewardCount) : 0
  };
}

function recordEpisodeStratum(
  strata: Map<string, BenchmarkEpisodeStratum>,
  dimension: BenchmarkEpisodeStratum["dimension"],
  key: string,
  episode: TournamentEpisode,
  artifact: MatchArtifact | undefined
): void {
  const stats = strata.get(key) ?? createEpisodeStratum(dimension, key);
  stats.episodeCount += 1;
  if (episode.status === "completed") {
    stats.completedCount += 1;
  } else {
    stats.failedCount += 1;
  }
  if (artifact) stats.artifactCount += 1;
  if (episode.evaluation) stats.evaluationCount += 1;
  if (episode.evaluationReport) stats.evaluationReportCount += 1;
  stats.harnessErrorCount += episode.metrics?.harnessErrorCount ?? artifact?.metrics.harnessErrorCount ?? 0;
  addUniqueNumber(stats.episodeIndexes, episode.index);
  addUnique(stats.seeds, episode.seed);
  strata.set(key, stats);
}

function createEpisodeStratum(dimension: BenchmarkEpisodeStratum["dimension"], key: string): BenchmarkEpisodeStratum {
  return {
    dimension,
    key,
    episodeCount: 0,
    completedCount: 0,
    failedCount: 0,
    artifactCount: 0,
    evaluationCount: 0,
    evaluationReportCount: 0,
    harnessErrorCount: 0,
    episodeIndexes: [],
    seeds: []
  };
}

function finalizeEpisodeStratum(stats: BenchmarkEpisodeStratum): BenchmarkEpisodeStratum {
  return { ...stats };
}

function mapToSortedRecord<T>(map: Map<string, T>, finalize: (value: T) => T): Record<string, T> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, finalize(value)]));
}

function createEmptyCostLatencyStats(): {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  harnessTurns: number;
  harnessErrors: number;
  providerRequestIds: string[];
  attempts: {
    count: number;
    sum: number;
    max: number;
    missing: number;
  };
  providerFailures: ReturnType<typeof createEmptyProviderFailureStats>;
} {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    harnessTurns: 0,
    harnessErrors: 0,
    providerRequestIds: [],
    attempts: {
      count: 0,
      sum: 0,
      max: 0,
      missing: 0
    },
    providerFailures: createEmptyProviderFailureStats()
  };
}

function createEmptyProviderFailureStats(): {
  count: number;
  byKind: Record<string, number>;
  byStage: Record<string, number>;
  byStatus: Record<string, number>;
  retryable: number;
  aborted: number;
  timeouts: number;
  streamAborts: number;
  providerRequestIds: string[];
  attempts: {
    count: number;
    sum: number;
    max: number;
    missing: number;
  };
} {
  return {
    count: 0,
    byKind: {},
    byStage: {},
    byStatus: {},
    retryable: 0,
    aborted: 0,
    timeouts: 0,
    streamAborts: 0,
    providerRequestIds: [],
    attempts: {
      count: 0,
      sum: 0,
      max: 0,
      missing: 0
    }
  };
}

function addModelUsage(stats: ReturnType<typeof createEmptyCostLatencyStats>, usage: { calls: number; promptTokens: number; completionTokens: number; latencyMs: number }): void {
  stats.calls += usage.calls;
  stats.promptTokens += usage.promptTokens;
  stats.completionTokens += usage.completionTokens;
  stats.totalTokens += usage.promptTokens + usage.completionTokens;
  stats.latencyMs += usage.latencyMs;
}

function traceCostLatencyStats(artifact: MatchArtifact | undefined): ReturnType<typeof createEmptyCostLatencyStats> & {
  byModel: Map<string, ReturnType<typeof createEmptyCostLatencyStats>>;
} {
  const stats = Object.assign(createEmptyCostLatencyStats(), {
    byModel: new Map<string, ReturnType<typeof createEmptyCostLatencyStats>>()
  });
  for (const step of artifact?.trajectory ?? []) {
    const providerRequestId = step.reasonerOutput.providerRequestId ?? step.turnTrace.providerRequestId;
    if (providerRequestId) addUnique(stats.providerRequestIds, providerRequestId);
    const attempts = step.reasonerOutput.attempts;
    recordAttempts(stats, attempts);
    const modelStats = stats.byModel.get(step.model) ?? createEmptyCostLatencyStats();
    if (providerRequestId) addUnique(modelStats.providerRequestIds, providerRequestId);
    recordAttempts(modelStats, attempts);
    stats.byModel.set(step.model, modelStats);
  }
  return stats;
}

function mergeTraceStats(target: ReturnType<typeof createEmptyCostLatencyStats>, traceStats: ReturnType<typeof createEmptyCostLatencyStats>): void {
  for (const providerRequestId of traceStats.providerRequestIds) addUnique(target.providerRequestIds, providerRequestId);
  target.attempts.count += traceStats.attempts.count;
  target.attempts.sum += traceStats.attempts.sum;
  target.attempts.max = Math.max(target.attempts.max, traceStats.attempts.max);
  target.attempts.missing += traceStats.attempts.missing;
  mergeProviderFailureStats(target.providerFailures, traceStats.providerFailures);
}

function recordAttempts(
  stats: {
    attempts: {
      count: number;
      sum: number;
      max: number;
      missing: number;
    };
  },
  attempts: number | undefined
): void {
  if (attempts === undefined) {
    stats.attempts.missing += 1;
    return;
  }
  stats.attempts.count += 1;
  stats.attempts.sum += attempts;
  stats.attempts.max = Math.max(stats.attempts.max, attempts);
}

function finalizeCostLatencyStats(stats: ReturnType<typeof createEmptyCostLatencyStats>): object {
  return {
    calls: stats.calls,
    promptTokens: stats.promptTokens,
    completionTokens: stats.completionTokens,
    totalTokens: stats.totalTokens,
    latencyMs: stats.latencyMs,
    averageLatencyMs: stats.calls ? Math.round(stats.latencyMs / stats.calls) : 0,
    harnessTurns: stats.harnessTurns,
    harnessErrors: stats.harnessErrors,
    providerRequestIds: stats.providerRequestIds,
    attempts: {
      ...stats.attempts,
      average: stats.attempts.count ? Math.round((stats.attempts.sum / stats.attempts.count) * 1000) / 1000 : 0
    },
    providerFailures: finalizeProviderFailureStats(stats.providerFailures)
  };
}

function recordProviderFailure(stats: ReturnType<typeof createEmptyProviderFailureStats>, failure: ProviderFailureSummary): void {
  stats.count += 1;
  increment(stats.byKind, failure.failureKind);
  if (failure.providerStage) increment(stats.byStage, failure.providerStage);
  if (failure.status !== undefined) increment(stats.byStatus, String(failure.status));
  if (failure.retryable) stats.retryable += 1;
  if (failure.aborted) stats.aborted += 1;
  if (failure.failureKind === "timeout") stats.timeouts += 1;
  if (failure.aborted && failure.providerStage === "during_stream") stats.streamAborts += 1;
  if (failure.providerRequestId) addUnique(stats.providerRequestIds, failure.providerRequestId);
  recordAttempts(stats, failure.attempts);
}

function mergeProviderFailureStats(target: ReturnType<typeof createEmptyProviderFailureStats>, source: ReturnType<typeof createEmptyProviderFailureStats>): void {
  target.count += source.count;
  mergeCounts(target.byKind, source.byKind);
  mergeCounts(target.byStage, source.byStage);
  mergeCounts(target.byStatus, source.byStatus);
  target.retryable += source.retryable;
  target.aborted += source.aborted;
  target.timeouts += source.timeouts;
  target.streamAborts += source.streamAborts;
  for (const providerRequestId of source.providerRequestIds) addUnique(target.providerRequestIds, providerRequestId);
  target.attempts.count += source.attempts.count;
  target.attempts.sum += source.attempts.sum;
  target.attempts.max = Math.max(target.attempts.max, source.attempts.max);
  target.attempts.missing += source.attempts.missing;
}

function finalizeProviderFailureStats(stats: ReturnType<typeof createEmptyProviderFailureStats>): object {
  return {
    count: stats.count,
    byKind: stats.byKind,
    byStage: stats.byStage,
    byStatus: stats.byStatus,
    retryable: stats.retryable,
    aborted: stats.aborted,
    timeouts: stats.timeouts,
    streamAborts: stats.streamAborts,
    providerRequestIds: stats.providerRequestIds,
    attempts: {
      ...stats.attempts,
      average: stats.attempts.count ? Math.round((stats.attempts.sum / stats.attempts.count) * 1000) / 1000 : 0
    }
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function addUniqueNumber(values: number[], value: number): void {
  if (!values.includes(value)) values.push(value);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function collectForkLineage(result: TournamentResult, artifactRecords: TournamentMatchArtifactRecord[]): object[] {
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  return result.episodes.flatMap((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const forkOf = forkOfForEpisode(episode, artifact);
    if (!forkOf) return [];
    return [
      {
        episodeIndex: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        forkOf: summarizeForkOf(forkOf)
      }
    ];
  });
}

function forkOfForEpisode(episode?: TournamentEpisode, artifact?: MatchArtifact): HarnessForkProvenance | undefined {
  return episode?.forkOf ?? artifact?.forkOf;
}

function summarizeForkOf(forkOf?: HarnessForkProvenance): TournamentForkSummary | null {
  if (!forkOf) return null;
  return {
    checkpointId: forkOf.checkpointId,
    parentRunId: forkOf.parentRunId ?? null,
    parentMatchId: forkOf.parentMatchId ?? null,
    parentTraceId: forkOf.parentTraceId ?? null,
    parentTurnIndex: forkOf.parentTurnIndex ?? null,
    parentStateHash: forkOf.parentStateHash,
    parentTrajectoryHash: forkOf.parentTrajectoryHash ?? null,
    parentAgentsHash: forkOf.parentAgentsHash ?? null,
    parentSocialMessagesHash: forkOf.parentSocialMessagesHash ?? null,
    parentTrajectoryLength: forkOf.parentTrajectoryLength,
    createdAt: forkOf.createdAt,
    reason: forkOf.reason ?? null
  };
}

function countStatuses(episodes: TournamentEpisode[]): Record<string, number> {
  const counts: Record<string, number> = {
    completed: 0,
    truncated: 0,
    failed: 0,
    tournamentFailed: 0
  };
  for (const episode of episodes) {
    if (episode.harnessStatus) counts[episode.harnessStatus] = (counts[episode.harnessStatus] ?? 0) + 1;
    if (!episode.harnessStatus && episode.status === "failed") counts.tournamentFailed += 1;
  }
  return counts;
}

function buildTournamentSummaryMarkdown(
  result: TournamentResult,
  options: {
    createdAt: string;
    experimentId: string;
    artifactRecords: TournamentMatchArtifactRecord[];
    integrity: ReturnType<typeof aggregateIntegrityRecords>;
    failures: ReturnType<typeof aggregateFailureRecords>;
  }
): string {
  const warningSummary = summarizeEvaluationWarnings(
    result.episodes.flatMap((episode) => episode.evaluationReport?.warnings ?? [])
  );
  const statusCounts = countStatuses(result.episodes);
  const integrityErrorCount = options.integrity.reduce((sum, record) => sum + record.errorCount, 0);
  const lines = [
    `# Tournament Summary: ${markdownText(options.experimentId)}`,
    "",
    "## Run Set",
    "",
    `- Created at: ${markdownText(options.createdAt)}`,
    `- Experiment id: ${markdownText(options.experimentId)}`,
    `- Seed: ${markdownText(result.seed)}`,
    `- Models: ${result.models.map(markdownText).join(", ") || "none"}`,
    `- Profiles: ${result.profiles.length}`,
    `- Games requested: ${result.gamesRequested}`,
    `- Episodes scheduled: ${result.episodes.length}`,
    `- Games completed: ${result.gamesCompleted}`,
    `- Games failed: ${result.gamesFailed}`,
    `- Match artifacts: ${options.artifactRecords.length}`,
    `- Evaluation warnings: ${warningSummary.warningCount}`,
    `- Integrity errors: ${integrityErrorCount}`,
    `- Failure records: ${options.failures.length}`,
    "",
    "## Harness Status",
    "",
    markdownTable(
      ["status", "count"],
      Object.entries(statusCounts).map(([status, count]) => [status, String(count)])
    ),
    "",
    "## Model Leaderboard",
    "",
    markdownTable(
      ["model", "seat_games", "seat_wins", "win_rate", "avg_reward", "turns", "errors"],
      Object.values(result.modelStats).map((stats) => [
        stats.model,
        String(stats.seatGames),
        String(stats.seatWins),
        ratio(stats.seatWins, stats.seatGames),
        String(stats.averageReward),
        String(stats.harnessTurns),
        String(stats.harnessErrors)
      ])
    ),
    "",
    "## Profile Leaderboard",
    "",
    markdownTable(
      ["profile", "model", "policy", "seat_games", "seat_wins", "win_rate", "avg_reward"],
      Object.values(result.profileStats).map((stats) => [
        stats.profileId,
        stats.model,
        stats.policyName ?? "",
        String(stats.seatGames),
        String(stats.seatWins),
        ratio(stats.seatWins, stats.seatGames),
        String(stats.averageReward)
      ])
    ),
    "",
    "## Files",
    "",
    "- `manifest.json`: run-set manifest and artifact file registry",
    "- `spec.normalized.json`: normalized reproducible experiment spec",
    "- `assignment.json`: per-episode profile/model/role/seat assignment ledger",
    "- `episodes.jsonl`, `trajectory.jsonl`, `metrics.jsonl`: machine-readable analysis streams",
    "- `episodes.csv`, `agents.csv`, `metrics.csv`, `leaderboard.csv`: tabular analysis exports",
    "- `integrity.jsonl`, `failures.jsonl`, `cost_latency.json`: audit, failure, and provider telemetry",
    "- `leaderboard.json`, `benchmark_statistics.json`: aggregate deterministic summaries",
    "- `matches/*.json`, `matches/*.jsonl`: per-match artifacts and replay streams",
    "",
    "## Interpretation Policy",
    "",
    "This summary is derived from recorded harness artifacts. It is suitable for run-set inspection and paper experiment bookkeeping. It does not make model superiority, causality, persuasion-success, or counterfactual claims without an explicit paired design and statistical contract."
  ];
  return `${lines.join("\n")}\n`;
}

function episodeCsvRows(
  result: TournamentResult,
  relativeMatchPaths: Map<number, string>,
  relativeMatchJsonlPaths: Map<number, string>,
  artifactsByIndex: Map<number, MatchArtifact>
): Array<Record<string, CsvCell>> {
  return result.episodes.map((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const warningSummary = summarizeEvaluationWarnings(episode.evaluationReport?.warnings);
    return {
      tournament_seed: result.seed,
      episode_index: episode.index,
      episode_seed: episode.seed,
      run_id: episode.runId ?? artifact?.runId ?? "",
      match_id: episode.matchId ?? artifact?.matchId ?? "",
      status: episode.status,
      harness_status: episode.harnessStatus ?? artifact?.status ?? "",
      winner: episode.winner ?? artifact?.finalState.winner ?? "",
      phase: episode.phase ?? artifact?.finalState.phase ?? "",
      day: episode.day ?? artifact?.finalState.day ?? "",
      trajectory_steps: episode.trajectory?.length ?? artifact?.trajectory.length ?? 0,
      message_count: episode.socialEpisode?.messages.length ?? artifact?.socialEpisode.messages.length ?? 0,
      metric_count: episode.evaluationReport?.metricCount ?? artifact?.evaluationReport.metricCount ?? 0,
      warning_count: warningSummary.warningCount,
      warning_codes: warningSummary.warningCodes.map((warning) => warning.code).join("|"),
      harness_error_count: episode.metrics?.harnessErrorCount ?? artifact?.metrics.harnessErrorCount ?? 0,
      agent_count: episode.agents.length,
      match_artifact: relativeMatchPaths.get(episode.index) ?? "",
      match_jsonl: relativeMatchJsonlPaths.get(episode.index) ?? "",
      error: episode.error ?? artifact?.failureReason ?? ""
    };
  });
}

function agentCsvRows(result: TournamentResult): Array<Record<string, CsvCell>> {
  return result.episodes.flatMap((episode) =>
    episode.agents.map((agent) => ({
      tournament_seed: result.seed,
      episode_index: episode.index,
      episode_seed: episode.seed,
      run_id: episode.runId ?? "",
      match_id: episode.matchId ?? "",
      status: episode.status,
      harness_status: episode.harnessStatus ?? "",
      player_id: agent.playerId,
      seat: agent.seat,
      profile_id: agent.profileId ?? "",
      model: agent.model,
      policy_name: agent.policyName ?? "",
      role: agent.role ?? "",
      team: agent.team ?? "",
      won: agent.won ?? "",
      reward: agent.reward ?? ""
    }))
  );
}

function metricCsvRows(result: TournamentResult): Array<Record<string, CsvCell>> {
  return result.episodes.flatMap((episode) =>
    (episode.evaluationReport?.metrics ?? []).map((metric) => ({
      tournament_seed: result.seed,
      episode_index: episode.index,
      episode_seed: episode.seed,
      run_id: episode.runId ?? "",
      match_id: episode.matchId ?? "",
      status: episode.status,
      harness_status: episode.harnessStatus ?? "",
      metric_id: metric.id,
      label: metric.label,
      evaluator_id: metric.evaluatorId ?? "",
      evaluator_version: metric.evaluatorVersion ?? "",
      scope: metric.scope,
      subject_id: metric.subjectId ?? "",
      value: metric.value,
      unit: metric.unit ?? "",
      higher_is_better: metric.higherIsBetter ?? "",
      weight: metric.weight ?? "",
      denominator: metric.denominator ?? "",
      confidence: metric.confidence ?? "",
      aggregation: metric.aggregation ?? "",
      source: metric.source,
      scenario: metric.scenario ?? "",
      split: metric.split ?? "",
      evidence_ref_count: metric.evidenceRefs?.length ?? 0,
      metadata: metric.metadata ? stableJson(metric.metadata) : ""
    }))
  );
}

function leaderboardCsvRows(result: TournamentResult): Array<Record<string, CsvCell>> {
  return [
    ...Object.values(result.modelStats).map((stats) => ({
      subject_type: "model",
      subject_id: stats.model,
      model: stats.model,
      profile_id: "",
      policy_name: "",
      seat_games: stats.seatGames,
      seat_wins: stats.seatWins,
      win_rate: ratio(stats.seatWins, stats.seatGames),
      village_seat_games: stats.villageSeatGames,
      village_seat_wins: stats.villageSeatWins,
      werewolf_seat_games: stats.werewolfSeatGames,
      werewolf_seat_wins: stats.werewolfSeatWins,
      harness_turns: stats.harnessTurns,
      harness_errors: stats.harnessErrors,
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      latency_ms: stats.latencyMs,
      reward_total: stats.rewardTotal,
      average_reward: stats.averageReward
    })),
    ...Object.values(result.profileStats).map((stats) => ({
      subject_type: "profile",
      subject_id: stats.profileId,
      model: stats.model,
      profile_id: stats.profileId,
      policy_name: stats.policyName ?? "",
      seat_games: stats.seatGames,
      seat_wins: stats.seatWins,
      win_rate: ratio(stats.seatWins, stats.seatGames),
      village_seat_games: stats.villageSeatGames,
      village_seat_wins: stats.villageSeatWins,
      werewolf_seat_games: stats.werewolfSeatGames,
      werewolf_seat_wins: stats.werewolfSeatWins,
      harness_turns: stats.harnessTurns,
      harness_errors: stats.harnessErrors,
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      latency_ms: stats.latencyMs,
      reward_total: stats.rewardTotal,
      average_reward: stats.averageReward
    }))
  ];
}

type CsvCell = string | number | boolean | null | undefined;

const EPISODE_CSV_HEADERS = [
  "tournament_seed",
  "episode_index",
  "episode_seed",
  "run_id",
  "match_id",
  "status",
  "harness_status",
  "winner",
  "phase",
  "day",
  "trajectory_steps",
  "message_count",
  "metric_count",
  "warning_count",
  "warning_codes",
  "harness_error_count",
  "agent_count",
  "match_artifact",
  "match_jsonl",
  "error"
];

const AGENT_CSV_HEADERS = [
  "tournament_seed",
  "episode_index",
  "episode_seed",
  "run_id",
  "match_id",
  "status",
  "harness_status",
  "player_id",
  "seat",
  "profile_id",
  "model",
  "policy_name",
  "role",
  "team",
  "won",
  "reward"
];

const METRIC_CSV_HEADERS = [
  "tournament_seed",
  "episode_index",
  "episode_seed",
  "run_id",
  "match_id",
  "status",
  "harness_status",
  "metric_id",
  "label",
  "evaluator_id",
  "evaluator_version",
  "scope",
  "subject_id",
  "value",
  "unit",
  "higher_is_better",
  "weight",
  "denominator",
  "confidence",
  "aggregation",
  "source",
  "scenario",
  "split",
  "evidence_ref_count",
  "metadata"
];

const LEADERBOARD_CSV_HEADERS = [
  "subject_type",
  "subject_id",
  "model",
  "profile_id",
  "policy_name",
  "seat_games",
  "seat_wins",
  "win_rate",
  "village_seat_games",
  "village_seat_wins",
  "werewolf_seat_games",
  "werewolf_seat_wins",
  "harness_turns",
  "harness_errors",
  "prompt_tokens",
  "completion_tokens",
  "latency_ms",
  "reward_total",
  "average_reward"
];

function buildCsv(headers: string[], rows: Array<Record<string, CsvCell>>): string {
  return `${[headers, ...rows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: CsvCell): string {
  if (value === undefined || value === null) return "";
  const redacted = redactSecrets(String(value));
  const text = typeof redacted === "string" ? redacted : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function markdownTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return "_No records._";
  const safeHeaders = headers.map(markdownTableCell);
  const safeRows = rows.map((row) => row.map(markdownTableCell));
  return [
    `| ${safeHeaders.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...safeRows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function markdownTableCell(value: string): string {
  return markdownText(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function markdownText(value: string): string {
  const redacted = redactSecrets(value);
  return typeof redacted === "string" ? redacted : value;
}

function ratio(numerator: number, denominator: number): string {
  return denominator ? String(round3(numerator / denominator)) : "0";
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

async function writeJson(filePath: string, value: unknown, overwrite: boolean): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(redactSecrets(value), null, 2)}\n`, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

async function writeJsonl(filePath: string, records: unknown[], overwrite: boolean): Promise<void> {
  const data = records.length ? `${records.map((record) => JSON.stringify(redactSecrets(record))).join("\n")}\n` : "";
  await writeFile(filePath, data, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

async function writeText(filePath: string, value: string, overwrite: boolean): Promise<void> {
  const redacted = redactSecrets(value);
  await writeFile(filePath, typeof redacted === "string" ? redacted : value, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

function filesResult(outputDir: string, files: TournamentArtifactWriteResult["files"]): TournamentArtifactWriteResult {
  return {
    outputDir,
    files
  };
}

function safeFileStem(value: string): string {
  const stem = value.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+$/, "artifact");
  return stem || "artifact";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
