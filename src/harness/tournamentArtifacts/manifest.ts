import { aggregateIntegrityRecords } from "./episodeRecords";
import { MatchArtifact } from "../artifacts";
import { summarizeEvaluationWarnings } from "../evaluation";
import { countSocialStepCommits, countSocialStepCommitsByActor } from "../social";
import { TournamentEpisode, TournamentMatchArtifactRecord, TournamentResult } from "../tournament";
import { HarnessEvaluatorManifestEntry } from "../types";
import { BENCHMARK_STATISTICS_EVALUATOR_ID, BENCHMARK_STATISTICS_EVALUATOR_VERSION, BENCHMARK_STATISTICS_METRIC_IDS, BENCHMARK_STATISTICS_VERSION, TOURNAMENT_ARTIFACT_VERSION, TournamentArtifactVisibility, TournamentAssignmentAgentRecord, TournamentAssignmentArtifact, TournamentNormalizedSpecArtifact, evaluationCoverageForEpisodes, metricPromotionExportMetadata } from "./model";
import { collectForkLineage, countStatuses, forkOfForEpisode, summarizeForkOf, summarizeTournamentMetricPromotions } from "./summary";
export function collectArtifactRecords(result: TournamentResult): TournamentMatchArtifactRecord[] {
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

export function buildManifest(
  result: TournamentResult,
  options: {
    experimentId?: string;
    createdAt: string;
    overwrite: boolean;
    artifactRecords: TournamentMatchArtifactRecord[];
    relativeMatchPaths: Map<number, string>;
    relativeMatchJsonlPaths: Map<number, string>;
    matchArtifactView: "full" | "postgame-redacted" | "truth-redacted";
    assignmentTruthRedacted: boolean;
    visibility: TournamentArtifactVisibility;
  }
): object {
  const statusCounts = countStatuses(result.episodes);
  const forkLineage = collectForkLineage(result, options.artifactRecords);
  const warningSummary = summarizeEvaluationWarnings(
    options.artifactRecords.flatMap((record) => record.artifact.evaluationReport.warnings ?? [])
  );
  const integrityRecords = aggregateIntegrityRecords(result, options.artifactRecords, options.relativeMatchPaths, options.relativeMatchJsonlPaths);
  const integrityErrorCount = integrityRecords.reduce((sum, record) => sum + record.errorCount, 0);
  const stepTotals = result.episodes.reduce(
    (totals, episode) => {
      const artifact = options.artifactRecords.find((record) => record.index === episode.index)?.artifact;
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      totals.nativeSteps += stepCounts.nativeSteps;
      totals.committedSteps += stepCounts.committedSteps;
      totals.rejectedSteps += stepCounts.rejectedSteps;
      return totals;
    },
    { nativeSteps: 0, committedSteps: 0, rejectedSteps: 0 }
  );
  const promotionSummary = summarizeTournamentMetricPromotions(result);
  const evaluationCoverage = evaluationCoverageForEpisodes(result.episodes);
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
    nativeSteps: stepTotals.nativeSteps,
    committedSteps: stepTotals.committedSteps,
    rejectedSteps: stepTotals.rejectedSteps,
    metricCount: promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    evaluationWarningCount: warningSummary.warningCount,
    evaluationWarningSeverityCounts: warningSummary.warningSeverityCounts,
    evaluationWarningCodes: warningSummary.warningCodes.map((warning) => warning.code),
    evaluationWarningSummary: warningSummary,
    evaluationCoverage,
    artifactIntegrityOkCount: integrityRecords.filter((record) => record.ok).length,
    artifactIntegrityErrorCount: integrityErrorCount,
    artifactIntegrityErroredMatchCount: integrityRecords.filter((record) => !record.ok).length,
    forkCount: forkLineage.length,
    forks: forkLineage,
    collisionPolicy: options.overwrite ? "overwrite" : "fail-if-exists",
    projection: {
      matchArtifactView: options.matchArtifactView,
      assignmentTruthRedacted: options.assignmentTruthRedacted,
      visibility: options.visibility,
      publicShareSafe: false
    },
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
      tournamentComparison: "tournament_comparison.json",
      tournamentComparisonMarkdown: "tournament_comparison.md",
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
      const episode = result.episodes.find((item) => item.index === record.index);
      const stepCounts = countSocialStepCommits(episode?.socialEpisode?.steps ?? record.artifact.socialEpisode.steps ?? []);
      return {
        episodeIndex: record.index,
        seed: record.seed,
        runId: record.runId,
        matchId: record.matchId ?? null,
        status: record.artifact.status,
        evaluationStatus: record.artifact.evaluationReport.status ?? "completed",
        evaluatorFailureCount: record.artifact.evaluationReport.failures?.length ?? 0,
        evaluationWarningCount: matchWarningSummary.warningCount,
        evaluationWarningCodes: matchWarningSummary.warningCodes.map((warning) => warning.code),
        integrityOk: integrity?.ok ?? false,
        integrityErrorCount: integrity?.errorCount ?? null,
        nativeSteps: stepCounts.nativeSteps,
        committedSteps: stepCounts.committedSteps,
        rejectedSteps: stepCounts.rejectedSteps,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, record.artifact)),
        path: options.relativeMatchPaths.get(record.index) ?? null,
        jsonlPath: options.relativeMatchJsonlPaths.get(record.index) ?? null
      };
    })
  };
}

export function buildNormalizedSpecExport(result: TournamentResult): TournamentNormalizedSpecArtifact {
  return result.experiment;
}

export function buildAssignmentExport(
  result: TournamentResult,
  options: {
    createdAt: string;
    artifactsByIndex: Map<number, MatchArtifact>;
    relativeMatchPaths: Map<number, string>;
    relativeMatchJsonlPaths: Map<number, string>;
    redactAssignmentTruth?: boolean;
  }
): TournamentAssignmentArtifact {
  const redactTruth = Boolean(options.redactAssignmentTruth);
  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "tournament-assignment",
    createdAt: options.createdAt,
    seed: result.seed,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
    models: result.models,
    profiles: result.profiles,
    assignment: result.assignment ?? null,
    episodes: result.episodes.map((episode) => {
      const artifact = options.artifactsByIndex.get(episode.index);
      const resolvedAssignments = episode.resolvedAssignments.length ? episode.resolvedAssignments : artifact?.resolvedAssignments ?? [];
      const agents = assignmentAgentsForEpisode(episode, resolvedAssignments, redactTruth, artifact);
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      return {
        episodeIndex: episode.index,
        tournamentEpisodeIndex: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
        nativeSteps: stepCounts.nativeSteps,
        committedSteps: stepCounts.committedSteps,
        rejectedSteps: stepCounts.rejectedSteps,
        matchArtifact: options.relativeMatchPaths.get(episode.index) ?? null,
        matchJsonl: options.relativeMatchJsonlPaths.get(episode.index) ?? null,
        assignment: episode.assignment ?? result.assignment ?? artifact?.assignment ?? null,
        resolvedAssignments: redactTruth
          ? resolvedAssignments.map((assignment) => {
              const { role: _role, team: _team, ...rest } = assignment;
              return rest as typeof assignment;
            })
          : resolvedAssignments,
        agents
      };
    })
  };
}

function assignmentAgentsForEpisode(
  episode: TournamentEpisode,
  resolvedAssignments: MatchArtifact["resolvedAssignments"],
  redactTruth = false,
  artifact?: MatchArtifact
): TournamentAssignmentAgentRecord[] {
  const agentsByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent]));
  const densityByActor = countSocialStepCommitsByActor(
    episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []
  );
  const densityFor = (playerId: string) =>
    densityByActor.get(playerId) ?? {
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0
    };
  if (resolvedAssignments.length) {
    return resolvedAssignments.map((assignment) => {
      const agent = agentsByPlayer.get(assignment.playerId);
      const density = densityFor(assignment.playerId);
      return {
        playerId: assignment.playerId,
        seat: assignment.seat,
        profileId: assignment.profileId ?? agent?.profileId,
        model: assignment.model,
        temperature: assignment.temperature,
        role: redactTruth ? undefined : assignment.role ?? agent?.role,
        team: redactTruth ? undefined : assignment.team ?? agent?.team,
        policyName: assignment.policyName ?? agent?.policyName,
        nativeSteps: density.nativeSteps,
        committedSteps: density.committedSteps,
        rejectedSteps: density.rejectedSteps
      };
    });
  }
  return episode.agents.map((agent) => {
    const density = densityFor(agent.playerId);
    return {
      playerId: agent.playerId,
      seat: agent.seat,
      profileId: agent.profileId,
      model: agent.model,
      temperature: null,
      role: redactTruth ? undefined : agent.role,
      team: redactTruth ? undefined : agent.team,
      policyName: agent.policyName,
      nativeSteps: density.nativeSteps,
      committedSteps: density.committedSteps,
      rejectedSteps: density.rejectedSteps
    };
  });
}

export function buildRegistrySnapshot(result: TournamentResult, createdAt: string): object {
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
  const promotionSummary = summarizeTournamentMetricPromotions(result);
  const promotionMetadata = metricPromotionExportMetadata(result);
  const evaluationCoverage = evaluationCoverageForEpisodes(result.episodes);
  return {
    artifactVersion: TOURNAMENT_ARTIFACT_VERSION,
    kind: "evaluator-registry-snapshot",
    createdAt,
    evaluatorIds: Array.from(new Set(registryEntries.map((entry) => entry.id))),
    evaluators: [...registryById.values()],
    ...promotionMetadata,
    metricCount: promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    evaluationCoverage,
    reports: reports.map(({ episode, report }) => ({
      episodeIndex: episode.index,
      seed: episode.seed,
      matchId: episode.matchId ?? null,
      runId: episode.runId ?? null,
      reportId: report.id,
      createdAt: report.createdAt,
      status: report.status ?? "completed",
      evaluatorFailureCount: report.failures?.length ?? 0,
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
