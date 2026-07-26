import { addModelUsage, buildBenchmarkStatistics, createEmptyCostLatencyStats, finalizeCostLatencyStats, mergeTraceStats, recordProviderFailure, traceCostLatencyStats } from "./benchmarkStatistics";
import { failureAttributionsForEpisode } from "./episodeRecords";
import { collectArtifactRecords } from "./manifest";
import { MatchArtifact } from "../artifacts";
import { MatchComparisonView, TournamentComparisonAggregate, buildTournamentComparisonAggregate } from "../matchComparison";
import { countSocialStepCommits, countSocialStepCommitsByActor } from "../social";
import { TournamentMatchArtifactRecord, TournamentResult } from "../tournament";
import { RebuiltTournamentLeaderboard } from "../tournamentLeaderboard";
import { TOURNAMENT_ARTIFACT_VERSION } from "./model";
import { forkOfForEpisode, summarizeForkOf } from "./summary";
export function buildTournamentComparisonExport(
  result: TournamentResult,
  options: {
    createdAt: string;
    artifactRecords: TournamentMatchArtifactRecord[];
    matchArtifactView: MatchComparisonView;
    projectMatchArtifact?: (artifact: MatchArtifact) => unknown;
  }
): TournamentComparisonAggregate {
  return buildTournamentComparisonAggregate({
    sources: options.artifactRecords.map((record) => {
      const projected = options.projectMatchArtifact
        ? options.projectMatchArtifact(record.artifact)
        : record.artifact;
      // Projectors may return structural comparison sources (including
      // truth-redacted DTO projections). Comparison is pure projection over
      // those recorded artifacts and does not invent truth.
      const artifact = projected as MatchArtifact;
      return {
        episodeIndex: record.index,
        seed: record.seed,
        runId: record.runId,
        matchId: record.matchId,
        artifact
      };
    }),
    view: options.matchArtifactView,
    tournamentSeed: result.seed,
    gamesRequested: result.gamesRequested,
    experimentId: result.experiment.id,
    createdAt: options.createdAt
  });
}

export function buildCostLatencyReport(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  createdAt: string,
  redactTruth = false
) {
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  const totals = createEmptyCostLatencyStats();
  const byModel = new Map<string, ReturnType<typeof createEmptyCostLatencyStats>>();
  const episodes = result.episodes.map((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const metrics = artifact?.metrics ?? episode.metrics;
    const usage = metrics?.modelUsage ?? {};
    const episodeStats = createEmptyCostLatencyStats();
    const stepCounts = countSocialStepCommits(artifact?.socialEpisode.steps ?? episode.socialEpisode?.steps ?? []);
    episodeStats.harnessTurns = metrics?.harnessTurnCount ?? stepCounts.committedSteps;
    episodeStats.harnessErrors = metrics?.harnessErrorCount ?? 0;
    episodeStats.nativeSteps = stepCounts.nativeSteps;
    episodeStats.committedSteps = stepCounts.committedSteps;
    episodeStats.rejectedSteps = stepCounts.rejectedSteps;

    const modelByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent.model]));
    const densityByActor = countSocialStepCommitsByActor(
      artifact?.socialEpisode.steps ?? episode.socialEpisode?.steps ?? []
    );
    for (const [actorId, density] of densityByActor) {
      const modelName = modelByPlayer.get(actorId);
      if (!modelName) continue;
      const modelStats = byModel.get(modelName) ?? createEmptyCostLatencyStats();
      modelStats.nativeSteps += density.nativeSteps;
      modelStats.committedSteps += density.committedSteps;
      modelStats.rejectedSteps += density.rejectedSteps;
      byModel.set(modelName, modelStats);
    }

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
    totals.nativeSteps += episodeStats.nativeSteps;
    totals.committedSteps += episodeStats.committedSteps;
    totals.rejectedSteps += episodeStats.rejectedSteps;

    const traceStats = traceCostLatencyStats(artifact, episode.trajectory);
    mergeTraceStats(episodeStats, traceStats);
    mergeTraceStats(totals, traceStats);
    for (const [model, stats] of traceStats.byModel.entries()) {
      const modelStats = byModel.get(model) ?? createEmptyCostLatencyStats();
      mergeTraceStats(modelStats, stats);
      byModel.set(model, modelStats);
    }

    for (const attribution of failureAttributionsForEpisode(episode, artifact, redactTruth)) {
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
    gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
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

/**
 * Lifecycle-inclusive execution telemetry for runtime/API/CLI summaries.
 *
 * Outcome, reward, role, and seat aggregates intentionally remain completed-
 * only in TournamentResult.modelStats/profileStats. This projection answers a
 * different question: what work actually ran, including bounded truncated and
 * failed episodes that produced a HarnessRunResult. It reuses the canonical
 * cost/latency artifact reducer so summaries cannot drift from exported
 * cost_latency.json semantics.
 */
export function summarizeTournamentExecutionTelemetry(result: TournamentResult) {
  const source = buildCostLatencyReport(result, collectArtifactRecords(result), "runtime-summary");
  const episodesWithHarnessResult = result.episodes.filter(
    (episode) => episode.harnessStatus !== undefined || episode.socialEpisode !== undefined
  );
  return {
    schemaVersion: "harness.tournament-execution-telemetry.v1",
    denominatorPolicy: {
      outcomeAggregates: "completed episodes only; see modelStats/profileStats",
      executionAggregates: "completed, truncated, and failed episodes that produced a harness result",
      preparationFailures: "excluded from model calls, tokens, latency, and step totals",
      unstartedEpisodes: "excluded from execution totals"
    },
    lifecycle: {
      episodesWithHarnessResult: episodesWithHarnessResult.length,
      completed: episodesWithHarnessResult.filter((episode) => episode.status === "completed").length,
      truncated: episodesWithHarnessResult.filter((episode) => episode.status === "truncated").length,
      failed: episodesWithHarnessResult.filter((episode) => episode.status === "failed").length,
      preparationFailed: result.episodes.filter(
        (episode) => episode.status === "failed" && episode.harnessStatus === undefined && episode.socialEpisode === undefined
      ).length,
      unstarted: result.gamesUnstarted ?? Math.max(0, result.gamesRequested - result.episodes.length)
    },
    totals: source.totals,
    byModel: source.byModel
  };
}

export function buildLeaderboard(
  result: TournamentResult,
  createdAt: string,
  artifactsByIndex: Map<number, MatchArtifact> = new Map(),
  benchmarkStatistics: object = buildBenchmarkStatistics(result, createdAt, artifactsByIndex),
  rebuilt: RebuiltTournamentLeaderboard,
  redactTruth = false
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
    gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
    maxTransitions: result.maxTransitions ?? null,
    assignment: result.assignment ?? null,
    // `modelStats`/`profileStats` and metric coverage are reconstructed from
    // the same persisted raw rows written beside this file.  They deliberately
    // do not trust TournamentResult's in-memory aggregate cache.
    aggregation: {
      source: ["spec.normalized.json", "episodes.jsonl", "metrics.jsonl", "cost_latency.json"],
      completedOnly: true,
      promotionResolution: "recorded_raw_metric_fields"
    },
    modelStats: rebuilt.modelStats,
    profileStats: rebuilt.profileStats,
    metricCount: rebuilt.metricPromotion.metricCount,
    scorecardEligibleMetricCount: rebuilt.metricPromotion.scorecardEligibleCount,
    metricPromotionClassCounts: rebuilt.metricPromotion.byClass,
    scorecardEligibleMetricClassCounts: rebuilt.metricPromotion.scorecardEligibleByClass,
    evaluationCoverage: rebuilt.evaluationCoverage,
    benchmarkStatistics,
    episodes: result.episodes.map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      return {
        index: episode.index,
        seed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? null,
        winner: redactTruth ? null : episode.winner ?? null,
        nativeSteps: stepCounts.nativeSteps,
        committedSteps: stepCounts.committedSteps,
        rejectedSteps: stepCounts.rejectedSteps,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
        error: episode.error ?? null
      };
    })
  };
}
