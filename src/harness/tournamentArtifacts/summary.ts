import { aggregateFailureRecords, aggregateIntegrityRecords } from "./episodeRecords";
import { markdownTable, markdownText, ratio } from "./ioSupport";
import { MatchArtifact } from "../artifacts";
import { DEFAULT_METRIC_PROMOTION_POLICY, MetricPromotionPolicy, resolveRecordedMetricPromotion, summarizeEvaluationWarnings } from "../evaluation";
import { countSocialStepCommits } from "../social";
import { TournamentEpisode, TournamentMatchArtifactRecord, TournamentResult } from "../tournament";
import { RebuiltTournamentLeaderboard } from "../tournamentLeaderboard";
import { HarnessEvaluationReport, HarnessForkProvenance, HarnessMetricRecord } from "../types";
import { TournamentForkSummary, promotionFallbackPolicyForReport } from "./model";
export function collectForkLineage(result: TournamentResult, artifactRecords: TournamentMatchArtifactRecord[]): object[] {
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

export function forkOfForEpisode(episode?: TournamentEpisode, artifact?: MatchArtifact): HarnessForkProvenance | undefined {
  return episode?.forkOf ?? artifact?.forkOf;
}

export function summarizeForkOf(forkOf?: HarnessForkProvenance): TournamentForkSummary | null {
  if (!forkOf) return null;
  return {
    checkpointId: forkOf.checkpointId,
    parentRunId: forkOf.parentRunId ?? null,
    parentMatchId: forkOf.parentMatchId ?? null,
    parentBoundaryTraceId: forkOf.parentBoundaryTraceId ?? null,
    parentBoundaryTurnIndex: forkOf.parentBoundaryTurnIndex ?? null,
    parentStateHash: forkOf.parentStateHash,
    parentExecutionPrefixHash: forkOf.parentExecutionPrefixHash,
    parentAgentsHash: forkOf.parentAgentsHash,
    parentChannelsHash: forkOf.parentChannelsHash,
    parentMessagesHash: forkOf.parentMessagesHash,
    parentNativeStepCount: forkOf.parentNativeStepCount,
    parentMessageCount: forkOf.parentMessageCount,
    createdAt: forkOf.createdAt,
    reason: forkOf.reason ?? null
  };
}

export function countStatuses(episodes: TournamentEpisode[]): Record<string, number> {
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

export function summarizeTournamentMetricPromotionsFromMetrics(
  metrics: HarnessMetricRecord[],
  fallbackPolicy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY
): {
  metricCount: number;
  scorecardEligibleCount: number;
  byClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
  scorecardEligibleByClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
} {
  const byClass = {
    scorecard: 0,
    diagnostic: 0,
    benchmark_only: 0
  };
  const scorecardEligibleByClass = {
    scorecard: 0,
    diagnostic: 0,
    benchmark_only: 0
  };
  let metricCount = 0;
  let scorecardEligibleCount = 0;
  for (const metric of metrics) {
    const promotion = resolveRecordedMetricPromotion(metric, fallbackPolicy);
    metricCount += 1;
    byClass[promotion.promotionClass] += 1;
    if (promotion.eligibleForScorecard) {
      scorecardEligibleCount += 1;
      scorecardEligibleByClass[promotion.promotionClass] += 1;
    }
  }
  return {
    metricCount,
    scorecardEligibleCount,
    byClass,
    scorecardEligibleByClass
  };
}

export function summarizeTournamentMetricPromotions(result: TournamentResult): {
  metricCount: number;
  scorecardEligibleCount: number;
  byClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
  scorecardEligibleByClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
} {
  return summarizeTournamentMetricPromotionsFromReports(
    result.episodes.flatMap((episode) => (episode.evaluationReport ? [episode.evaluationReport] : []))
  );
}

export function summarizeTournamentMetricPromotionsFromReports(reports: readonly HarnessEvaluationReport[]): {
  metricCount: number;
  scorecardEligibleCount: number;
  byClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
  scorecardEligibleByClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
} {
  const aggregate = {
    metricCount: 0,
    scorecardEligibleCount: 0,
    byClass: {
      scorecard: 0,
      diagnostic: 0,
      benchmark_only: 0
    },
    scorecardEligibleByClass: {
      scorecard: 0,
      diagnostic: 0,
      benchmark_only: 0
    }
  };
  for (const report of reports) {
    const summary = summarizeTournamentMetricPromotionsFromMetrics(
      report.metrics ?? [],
      promotionFallbackPolicyForReport(report)
    );
    aggregate.metricCount += summary.metricCount;
    aggregate.scorecardEligibleCount += summary.scorecardEligibleCount;
    for (const promotionClass of ["scorecard", "diagnostic", "benchmark_only"] as const) {
      aggregate.byClass[promotionClass] += summary.byClass[promotionClass];
      aggregate.scorecardEligibleByClass[promotionClass] += summary.scorecardEligibleByClass[promotionClass];
    }
  }
  return aggregate;
}

export function buildTournamentSummaryMarkdown(
  result: TournamentResult,
  options: {
    createdAt: string;
    experimentId: string;
    artifactRecords: TournamentMatchArtifactRecord[];
    integrity: ReturnType<typeof aggregateIntegrityRecords>;
    failures: ReturnType<typeof aggregateFailureRecords>;
    rebuiltLeaderboard: RebuiltTournamentLeaderboard;
  }
): string {
  const warningSummary = summarizeEvaluationWarnings(
    result.episodes.flatMap((episode) => episode.evaluationReport?.warnings ?? [])
  );
  const statusCounts = countStatuses(result.episodes);
  const integrityErrorCount = options.integrity.reduce((sum, record) => sum + record.errorCount, 0);
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
  const promotionSummary = options.rebuiltLeaderboard.metricPromotion;
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
    `- Games truncated: ${result.gamesTruncated ?? statusCounts.truncated ?? 0}`,
    `- Games failed: ${result.gamesFailed}`,
    `- Match artifacts: ${options.artifactRecords.length}`,
    `- Native steps: ${stepTotals.nativeSteps}`,
    `- Committed steps: ${stepTotals.committedSteps}`,
    `- Rejected steps: ${stepTotals.rejectedSteps}`,
    `- Evaluation warnings: ${warningSummary.warningCount}`,
    `- Integrity errors: ${integrityErrorCount}`,
    `- Failure records: ${options.failures.length}`,
    `- Metric rows: ${promotionSummary.metricCount}`,
    `- Scorecard-eligible metric rows: ${promotionSummary.scorecardEligibleCount}`,
    `- Diagnostic metric rows: ${promotionSummary.byClass.diagnostic}`,
    `- Benchmark-only metric rows: ${promotionSummary.byClass.benchmark_only}`,
    `- Scorecard-class metric rows: ${promotionSummary.byClass.scorecard}`,
    "",
    "## Harness Status",
    "",
    markdownTable(
      ["status", "count"],
      Object.entries(statusCounts).map(([status, count]) => [status, String(count)])
    ),
    "",
    "## Metric Promotion",
    "",
    markdownTable(
      ["promotion_class", "rows", "scorecard_eligible_rows"],
      [
        ["scorecard", String(promotionSummary.byClass.scorecard), String(promotionSummary.scorecardEligibleByClass.scorecard)],
        ["diagnostic", String(promotionSummary.byClass.diagnostic), String(promotionSummary.scorecardEligibleByClass.diagnostic)],
        ["benchmark_only", String(promotionSummary.byClass.benchmark_only), String(promotionSummary.scorecardEligibleByClass.benchmark_only)]
      ]
    ),
    "",
    "Promotion classes are read from each metric's recorded evaluation decision. Older rows without that decision are explicitly marked as `legacy_recomputed` and use only their report-derived fallback policy; a later catalog change does not rewrite recorded rows.",
    "",
    "## Model Leaderboard",
    "",
    markdownTable(
      ["model", "seat_games", "seat_wins", "win_rate", "avg_reward", "turns", "errors", "native", "committed", "rejected"],
      Object.values(options.rebuiltLeaderboard.modelStats).map((stats) => [
        stats.model,
        String(stats.seatGames),
        String(stats.seatWins),
        ratio(stats.seatWins, stats.seatGames),
        String(stats.averageReward),
        String(stats.harnessTurns),
        String(stats.harnessErrors),
        String(stats.nativeSteps),
        String(stats.committedSteps),
        String(stats.rejectedSteps)
      ])
    ),
    "",
    "## Profile Leaderboard",
    "",
    markdownTable(
      ["profile", "model", "policy", "seat_games", "seat_wins", "win_rate", "avg_reward", "native", "committed", "rejected"],
      Object.values(options.rebuiltLeaderboard.profileStats).map((stats) => [
        stats.profileId,
        stats.model,
        stats.policyName ?? "",
        String(stats.seatGames),
        String(stats.seatWins),
        ratio(stats.seatWins, stats.seatGames),
        String(stats.averageReward),
        String(stats.nativeSteps),
        String(stats.committedSteps),
        String(stats.rejectedSteps)
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
    "- `leaderboard.json`, `benchmark_statistics.json`, `tournament_comparison.json`, `tournament_comparison.md`: aggregate deterministic summaries",
    "- `matches/*.json`, `matches/*.jsonl`: per-match artifacts and replay streams",
    "",
    "## Interpretation Policy",
    "",
    "This summary is derived from recorded harness artifacts. It is suitable for run-set inspection and paper experiment bookkeeping. It does not make model superiority, causality, persuasion-success, or counterfactual claims without an explicit paired design and statistical contract."
  ];
  return `${lines.join("\n")}\n`;
}
