import { MatchArtifact } from "../artifacts";
import { hashStableState } from "../hash";
import { countSocialStepCommits, countSocialStepCommitsByActor } from "../social";
import { TournamentEpisode, TournamentResult } from "../tournament";
import { HarnessStepRecord, ProviderFailureSummary } from "../types";
import { werewolfHarnessTurnEvidenceFromEpisode } from "../werewolfExecutionEvidence";
import { BENCHMARK_STATISTICS_EVALUATOR_ID, BENCHMARK_STATISTICS_EVALUATOR_VERSION, BENCHMARK_STATISTICS_METRIC_IDS, BENCHMARK_STATISTICS_VERSION, BenchmarkAgentSeatStratum, BenchmarkEpisodeStratum, TOURNAMENT_ARTIFACT_VERSION, evaluationCoverageForEpisodes, metricPromotionExportMetadata } from "./model";
import { countStatuses, summarizeTournamentMetricPromotions } from "./summary";
export function buildBenchmarkStatistics(
  result: TournamentResult,
  createdAt: string,
  artifactsByIndex: Map<number, MatchArtifact>,
  redactTruth = false
): object {
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
  let nativeSteps = 0;
  let committedSteps = 0;
  let rejectedSteps = 0;
  for (const episode of result.episodes) {
    const artifact = artifactsByIndex.get(episode.index);
    const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
    nativeSteps += stepCounts.nativeSteps;
    committedSteps += stepCounts.committedSteps;
    rejectedSteps += stepCounts.rejectedSteps;
    recordEpisodeStratum(episodeStrata.byEpisodeStatus, "episodeStatus", episode.status, episode, artifact, stepCounts);
    recordEpisodeStratum(episodeStrata.byHarnessStatus, "harnessStatus", episode.harnessStatus ?? "tournamentFailed", episode, artifact, stepCounts);
    const densityByActor = countSocialStepCommitsByActor(
      episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []
    );
    for (const agent of episode.agents) {
      const density = densityByActor.get(agent.playerId) ?? {
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      };
      recordAgentSeatStratum(agentStrata.byModel, "model", agent.model, episode, agent, density);
      if (agent.profileId) {
        recordAgentSeatStratum(agentStrata.byProfile, "profile", agent.profileId, episode, agent, density);
      }
      if (!redactTruth) {
        if (agent.role) recordAgentSeatStratum(agentStrata.byRole, "role", agent.role, episode, agent, density);
        if (agent.team) recordAgentSeatStratum(agentStrata.byTeam, "team", agent.team, episode, agent, density);
      }
      recordAgentSeatStratum(agentStrata.bySeat, "seat", String(agent.seat), episode, agent, density);
    }
  }
  const promotionSummary = summarizeTournamentMetricPromotions(result);
  const promotionMetadata = metricPromotionExportMetadata(result);
  const evaluationCoverage = evaluationCoverageForEpisodes(result.episodes);

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
    ...promotionMetadata,
    metricCount: promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    evaluationCoverage,
    statusDenominators: {
      gamesRequested: result.gamesRequested,
      episodesScheduled: scheduledEpisodes,
      episodesUnscheduled: Math.max(0, result.gamesRequested - scheduledEpisodes),
      gamesCompleted: result.gamesCompleted,
      gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
      gamesFailed: result.gamesFailed,
      artifactCount,
      matchArtifactCount: artifactCount,
      completedWithEvaluation: result.episodes.filter((episode) => episode.status === "completed" && Boolean(episode.evaluation)).length,
      completedWithEvaluationReport: result.episodes.filter((episode) => episode.status === "completed" && Boolean(episode.evaluationReport)).length,
      evaluationCompletedEpisodes: evaluationCoverage.evaluationCompletedEpisodes,
      evaluationIncompleteEpisodes: evaluationCoverage.evaluationIncompleteEpisodes,
      evaluatorFailureCount: evaluationCoverage.evaluatorFailureCount,
      truncatedWithArtifact: result.episodes.filter((episode) => episode.status === "truncated" && artifactsByIndex.has(episode.index)).length,
      truncatedWithEvaluation: result.episodes.filter((episode) => episode.status === "truncated" && Boolean(episode.evaluation)).length,
      truncatedWithEvaluationReport: result.episodes.filter((episode) => episode.status === "truncated" && Boolean(episode.evaluationReport)).length,
      failedWithArtifact: result.episodes.filter((episode) => episode.status === "failed" && artifactsByIndex.has(episode.index)).length,
      preHarnessFailures: result.episodes.filter((episode) => episode.status === "failed" && !episode.harnessStatus).length,
      harnessStatusCounts,
      nativeSteps,
      committedSteps,
      rejectedSteps
    },
    stratificationDimensions: redactTruth
      ? ["model", "profile", "seat", "episodeStatus", "harnessStatus"]
      : ["model", "profile", "role", "team", "seat", "episodeStatus", "harnessStatus"],
    seedLedger: result.episodes.map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
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
        hasEvaluationReport: Boolean(episode.evaluationReport),
        evaluationStatus: episode.evaluationReport ? episode.evaluationReport.status ?? "completed" : null,
        evaluatorFailureCount: episode.evaluationReport?.failures?.length ?? 0,
        nativeSteps: stepCounts.nativeSteps,
        committedSteps: stepCounts.committedSteps,
        rejectedSteps: stepCounts.rejectedSteps
      };
    }),
    strata: {
      byModel: mapToSortedRecord(agentStrata.byModel, finalizeAgentSeatStratum),
      byProfile: mapToSortedRecord(agentStrata.byProfile, finalizeAgentSeatStratum),
      ...(redactTruth
        ? {}
        : {
            byRole: mapToSortedRecord(agentStrata.byRole, finalizeAgentSeatStratum),
            byTeam: mapToSortedRecord(agentStrata.byTeam, finalizeAgentSeatStratum)
          }),
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
  agent: TournamentEpisode["agents"][number],
  density: { nativeSteps: number; committedSteps: number; rejectedSteps: number } = {
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0
  }
): void {
  const stats = strata.get(key) ?? createAgentSeatStratum(dimension, key);
  stats.scheduledSeatCount += 1;
  if (episode.status === "completed") {
    stats.completedSeatCount += 1;
  } else if (episode.status === "truncated") {
    stats.truncatedSeatCount += 1;
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
  stats.nativeSteps += density.nativeSteps;
  stats.committedSteps += density.committedSteps;
  stats.rejectedSteps += density.rejectedSteps;
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
    truncatedSeatCount: 0,
    failedSeatCount: 0,
    completedWithOutcomeCount: 0,
    winCount: 0,
    rewardCount: 0,
    rewardTotal: 0,
    averageReward: 0,
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0,
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
  artifact: MatchArtifact | undefined,
  density: { nativeSteps: number; committedSteps: number; rejectedSteps: number } = {
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0
  }
): void {
  const stats = strata.get(key) ?? createEpisodeStratum(dimension, key);
  stats.episodeCount += 1;
  if (episode.status === "completed") {
    stats.completedCount += 1;
  } else if (episode.status === "truncated") {
    stats.truncatedCount += 1;
  } else {
    stats.failedCount += 1;
  }
  if (artifact) stats.artifactCount += 1;
  if (episode.evaluation) stats.evaluationCount += 1;
  if (episode.evaluationReport) stats.evaluationReportCount += 1;
  stats.harnessErrorCount += episode.metrics?.harnessErrorCount ?? artifact?.metrics.harnessErrorCount ?? 0;
  stats.nativeSteps += density.nativeSteps;
  stats.committedSteps += density.committedSteps;
  stats.rejectedSteps += density.rejectedSteps;
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
    truncatedCount: 0,
    failedCount: 0,
    artifactCount: 0,
    evaluationCount: 0,
    evaluationReportCount: 0,
    harnessErrorCount: 0,
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0,
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

export function createEmptyCostLatencyStats(): {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  harnessTurns: number;
  harnessErrors: number;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
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
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0,
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
    attempts: {
      count: 0,
      sum: 0,
      max: 0,
      missing: 0
    }
  };
}

export function addModelUsage(stats: ReturnType<typeof createEmptyCostLatencyStats>, usage: { calls: number; promptTokens: number; completionTokens: number; latencyMs: number }): void {
  stats.calls += usage.calls;
  stats.promptTokens += usage.promptTokens;
  stats.completionTokens += usage.completionTokens;
  stats.totalTokens += usage.promptTokens + usage.completionTokens;
  stats.latencyMs += usage.latencyMs;
}

export function traceCostLatencyStats(
  artifact: MatchArtifact | undefined,
  fallbackTrajectory: readonly HarnessStepRecord[] = []
): ReturnType<typeof createEmptyCostLatencyStats> & {
  byModel: Map<string, ReturnType<typeof createEmptyCostLatencyStats>>;
} {
  const stats = Object.assign(createEmptyCostLatencyStats(), {
    byModel: new Map<string, ReturnType<typeof createEmptyCostLatencyStats>>()
  });
  const nativeTraces = werewolfHarnessTurnEvidenceFromEpisode(artifact?.socialEpisode).map(({ trace }) => ({
    model: trace.model,
    attempts: trace.attempts
  }));
  const traces = nativeTraces.length
    ? nativeTraces
    : (artifact?.trajectory ?? fallbackTrajectory).map((step) => ({
        model: step.model,
        attempts: step.reasonerOutput.attempts
      }));
  for (const trace of traces) {
    const attempts = trace.attempts;
    recordAttempts(stats, attempts);
    const modelStats = stats.byModel.get(trace.model) ?? createEmptyCostLatencyStats();
    recordAttempts(modelStats, attempts);
    stats.byModel.set(trace.model, modelStats);
  }
  return stats;
}

export function mergeTraceStats(target: ReturnType<typeof createEmptyCostLatencyStats>, traceStats: ReturnType<typeof createEmptyCostLatencyStats>): void {
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

export function finalizeCostLatencyStats(stats: ReturnType<typeof createEmptyCostLatencyStats>): object {
  return {
    calls: stats.calls,
    promptTokens: stats.promptTokens,
    completionTokens: stats.completionTokens,
    totalTokens: stats.totalTokens,
    latencyMs: stats.latencyMs,
    averageLatencyMs: stats.calls ? Math.round(stats.latencyMs / stats.calls) : 0,
    harnessTurns: stats.harnessTurns,
    harnessErrors: stats.harnessErrors,
    nativeSteps: stats.nativeSteps,
    committedSteps: stats.committedSteps,
    rejectedSteps: stats.rejectedSteps,
    attempts: {
      ...stats.attempts,
      average: stats.attempts.count ? Math.round((stats.attempts.sum / stats.attempts.count) * 1000) / 1000 : 0
    },
    providerFailures: finalizeProviderFailureStats(stats.providerFailures)
  };
}

export function recordProviderFailure(stats: ReturnType<typeof createEmptyProviderFailureStats>, failure: ProviderFailureSummary): void {
  stats.count += 1;
  increment(stats.byKind, failure.failureKind);
  if (failure.providerStage) increment(stats.byStage, failure.providerStage);
  if (failure.status !== undefined) increment(stats.byStatus, String(failure.status));
  if (failure.retryable) stats.retryable += 1;
  if (failure.aborted) stats.aborted += 1;
  if (failure.failureKind === "timeout") stats.timeouts += 1;
  if (failure.aborted && failure.providerStage === "during_stream") stats.streamAborts += 1;
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
    attempts: {
      ...stats.attempts,
      average: stats.attempts.count ? Math.round((stats.attempts.sum / stats.attempts.count) * 1000) / 1000 : 0
    }
  };
}

export function increment(counts: Record<string, number>, key: string): void {
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

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
