import { increment } from "./benchmarkStatistics";
import { aggregateIntegrityRecords, failureAttributionsForEpisode } from "./episodeRecords";
import { isRecord, markdownTable } from "./ioSupport";
import { MatchArtifact } from "../artifacts";
import { summarizeEvaluationWarnings } from "../evaluation";
import { countSocialStepCommits } from "../social";
import { TournamentMatchArtifactRecord, TournamentResult } from "../tournament";
import { PUBLIC_TOURNAMENT_ARTIFACT_VERSION, PublicTournamentMatchRecord, promotionFallbackPolicyForReport } from "./model";
import { buildCostLatencyReport } from "./reports";
import { countStatuses, summarizeTournamentMetricPromotions, summarizeTournamentMetricPromotionsFromMetrics } from "./summary";
export function assertPublicTournamentMatchArtifact(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Public match projector returned a non-object artifact.");
  const keys = Object.keys(value).sort();
  const expected = ["artifactVersion", "episodeIndex", "events", "kind", "messages", "state", "status"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Public match projector returned fields outside the public match schema.");
  }
  if (value.artifactVersion !== "harness.match.public.v1" || value.kind !== "public-match") {
    throw new Error("Public match projector returned an unknown public match schema.");
  }
  if (!Number.isInteger(value.episodeIndex) || typeof value.status !== "string") {
    throw new Error("Public match projector returned an invalid public match identity.");
  }
  if (!isPublicMatchState(value.state) || !Array.isArray(value.events) || !Array.isArray(value.messages)) {
    throw new Error("Public match projector returned an invalid public observation.");
  }
  if (!value.events.every(isPublicMatchEvent) || !value.messages.every(isPublicMatchMessage)) {
    throw new Error("Public match projector retained private event or message topology.");
  }
}

function isPublicMatchState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const allowed = ["currentSpeakerSeat", "day", "pendingActionCount", "phase", "players", "publicEventCount"];
  if (
    keys.some((key) => !allowed.includes(key)) ||
    typeof value.phase !== "string" ||
    !isNonNegativeInteger(value.day) ||
    !isNonNegativeInteger(value.pendingActionCount) ||
    !isNonNegativeInteger(value.publicEventCount) ||
    (value.currentSpeakerSeat !== undefined && !isNonNegativeInteger(value.currentSpeakerSeat)) ||
    !Array.isArray(value.players)
  ) {
    return false;
  }
  return value.players.every(isPublicMatchPlayer);
}

function isPublicMatchPlayer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const allowed = ["alive", "eliminatedAt", "isSheriff", "name", "seat"];
  if (
    keys.some((key) => !allowed.includes(key)) ||
    !isNonNegativeInteger(value.seat) ||
    typeof value.name !== "string" ||
    typeof value.alive !== "boolean" ||
    typeof value.isSheriff !== "boolean"
  ) {
    return false;
  }
  if (value.eliminatedAt === undefined) return true;
  if (!isRecord(value.eliminatedAt)) return false;
  const eliminatedAtKeys = Object.keys(value.eliminatedAt).sort();
  const expected = ["day", "reason"];
  return (
    eliminatedAtKeys.length === expected.length &&
    eliminatedAtKeys.every((key, index) => key === expected[index]) &&
    isNonNegativeInteger(value.eliminatedAt.day) &&
    typeof value.eliminatedAt.reason === "string"
  );
}

function isPublicMatchEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["day", "seq", "type"];
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    isNonNegativeInteger(value.seq) &&
    isNonNegativeInteger(value.day) &&
    typeof value.type === "string"
  );
}

function isPublicMatchMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["content", "senderSeat", "seq"];
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    typeof value.content === "string" &&
    (isNonNegativeInteger(value.senderSeat) || value.senderSeat === null) &&
    isNonNegativeInteger(value.seq)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function publicMessageCount(artifact: Record<string, unknown>): number {
  return Array.isArray(artifact.messages) ? artifact.messages.length : 0;
}

export function publicPlayerCount(artifact: Record<string, unknown>): number {
  const state = artifact.state;
  return isRecord(state) && Array.isArray(state.players) ? state.players.length : 0;
}

function publicStepTotals(result: TournamentResult, artifactsByIndex: Map<number, MatchArtifact>): {
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
} {
  return result.episodes.reduce(
    (totals, episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const counts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      totals.nativeSteps += counts.nativeSteps;
      totals.committedSteps += counts.committedSteps;
      totals.rejectedSteps += counts.rejectedSteps;
      return totals;
    },
    { nativeSteps: 0, committedSteps: 0, rejectedSteps: 0 }
  );
}

function publicModelAliasMap(result: TournamentResult): Map<string, string> {
  const models = Array.from(new Set([...result.models, ...Object.keys(result.modelStats)])).sort((left, right) => left.localeCompare(right));
  return new Map(models.map((model, index) => [model, `model-${index + 1}`]));
}

function publicEpisodeRecords(result: TournamentResult, matches: PublicTournamentMatchRecord[]): Array<Record<string, unknown>> {
  const matchesByIndex = new Map(matches.map((match) => [match.episodeIndex, match]));
  return result.episodes.map((episode) => {
    const match = matchesByIndex.get(episode.index);
    const promotion = summarizeTournamentMetricPromotionsFromMetrics(
      episode.evaluationReport?.metrics ?? [],
      promotionFallbackPolicyForReport(episode.evaluationReport)
    );
    return {
      type: "public_episode",
      episodeIndex: episode.index,
      status: episode.status,
      harnessStatus: episode.harnessStatus ?? match?.harnessStatus ?? null,
      phase: publicStateString(match?.projectedArtifact, "phase"),
      day: publicStateNumber(match?.projectedArtifact, "day"),
      nativeSteps: match?.nativeSteps ?? 0,
      committedSteps: match?.committedSteps ?? 0,
      rejectedSteps: match?.rejectedSteps ?? 0,
      publicMessageCount: match?.publicMessageCount ?? 0,
      playerCount: match?.playerCount ?? episode.agents.length,
      metricCount: episode.evaluationReport?.metricCount ?? promotion.metricCount,
      scorecardEligibleMetricCount: promotion.scorecardEligibleCount,
      metricPromotionClassCounts: promotion.byClass,
      scorecardEligibleMetricClassCounts: promotion.scorecardEligibleByClass,
      evaluationWarningCount: summarizeEvaluationWarnings(episode.evaluationReport?.warnings).warningCount,
      matchArtifact: match?.relativePath ?? null,
      matchJsonl: match?.relativeJsonlPath ?? null
    };
  });
}

function publicStateString(artifact: Record<string, unknown> | undefined, key: string): string | null {
  const state = artifact && isRecord(artifact.state) ? artifact.state : undefined;
  return state && isRecord(state) ? stringFieldFromRecord(state, key) : null;
}

function publicStateNumber(artifact: Record<string, unknown> | undefined, key: string): number | null {
  const state = artifact && isRecord(artifact.state) ? artifact.state : undefined;
  return state && isRecord(state) ? numericField(state[key]) : null;
}

function publicMetricRecords(summary: ReturnType<typeof summarizeTournamentMetricPromotions>): Array<Record<string, unknown>> {
  return (["scorecard", "diagnostic", "benchmark_only"] as const).map((promotionClass) => ({
    type: "public_metric_summary",
    promotionClass,
    metricCount: summary.byClass[promotionClass],
    scorecardEligibleMetricCount: summary.scorecardEligibleByClass[promotionClass]
  }));
}

function publicFailureRecords(result: TournamentResult, artifactsByIndex: Map<number, MatchArtifact>): Array<Record<string, unknown>> {
  return result.episodes
    .filter((episode) => episode.status === "failed" || episode.harnessStatus === "failed")
    .map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const counts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      const failureKinds: Record<string, number> = {};
      for (const attribution of failureAttributionsForEpisode(episode, artifact, true)) {
        if (attribution.failureKind) increment(failureKinds, attribution.failureKind);
      }
      return {
        type: "public_failure_summary",
        episodeIndex: episode.index,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
        failureKindCounts: failureKinds,
        harnessErrorCount: episode.metrics?.harnessErrorCount ?? artifact?.metrics.harnessErrorCount ?? 0,
        nativeSteps: counts.nativeSteps,
        committedSteps: counts.committedSteps,
        rejectedSteps: counts.rejectedSteps
      };
    });
}

function publicCostLatencyReport(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  createdAt: string,
  aliases: Map<string, string>
): Record<string, unknown> {
  const source = buildCostLatencyReport(result, artifactRecords, createdAt, true);
  const sourceRecord: Record<string, unknown> = source;
  const byModel = isRecord(sourceRecord.byModel) ? sourceRecord.byModel : {};
  const episodes = Array.isArray(sourceRecord.episodes) ? sourceRecord.episodes : [];
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-cost-latency",
    visibility: "public",
    createdAt,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
    totals: publicCostStats(sourceRecord.totals),
    byModel: Object.fromEntries(
      Object.entries(byModel)
        .filter(([model]) => aliases.has(model))
        .map(([model, stats]) => [aliases.get(model)!, publicCostStats(stats)])
    ),
    episodes: episodes.map((episode, index) => {
      const record = isRecord(episode) ? episode : {};
      return {
        episodeIndex: numericField(record.episodeIndex) ?? index,
        status: stringFieldFromRecord(record, "status") ?? "unknown",
        harnessStatus: stringFieldFromRecord(record, "harnessStatus"),
        ...publicCostStats(record)
      };
    })
  };
}

function publicCostStats(value: unknown): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  const providerFailures = isRecord(record.providerFailures) ? record.providerFailures : {};
  return {
    calls: numericField(record.calls) ?? 0,
    promptTokens: numericField(record.promptTokens) ?? 0,
    completionTokens: numericField(record.completionTokens) ?? 0,
    totalTokens: numericField(record.totalTokens) ?? 0,
    latencyMs: numericField(record.latencyMs) ?? 0,
    averageLatencyMs: numericField(record.averageLatencyMs) ?? 0,
    harnessTurns: numericField(record.harnessTurns) ?? 0,
    harnessErrors: numericField(record.harnessErrors) ?? 0,
    nativeSteps: numericField(record.nativeSteps) ?? 0,
    committedSteps: numericField(record.committedSteps) ?? 0,
    rejectedSteps: numericField(record.rejectedSteps) ?? 0,
    attempts: publicAttempts(record.attempts),
    providerFailures: {
      count: numericField(providerFailures.count) ?? 0,
      byKind: publicNumberRecord(providerFailures.byKind),
      retryable: numericField(providerFailures.retryable) ?? 0,
      aborted: numericField(providerFailures.aborted) ?? 0,
      timeouts: numericField(providerFailures.timeouts) ?? 0,
      streamAborts: numericField(providerFailures.streamAborts) ?? 0
    }
  };
}

function publicAttempts(value: unknown): Record<string, number> {
  const record = isRecord(value) ? value : {};
  return {
    count: numericField(record.count) ?? 0,
    sum: numericField(record.sum) ?? 0,
    max: numericField(record.max) ?? 0,
    missing: numericField(record.missing) ?? 0,
    average: numericField(record.average) ?? 0
  };
}

function publicNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => typeof count === "number" && Number.isFinite(count))
      .sort(([left], [right]) => left.localeCompare(right))
  ) as Record<string, number>;
}

export function numericField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringFieldFromRecord(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function publicLeaderboard(
  result: TournamentResult,
  createdAt: string,
  aliases: Map<string, string>,
  summary: ReturnType<typeof summarizeTournamentMetricPromotions>
): Record<string, unknown> {
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-leaderboard",
    visibility: "public",
    createdAt,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesTruncated: result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length,
    maxTransitions: result.maxTransitions ?? null,
    modelStats: Object.fromEntries(
      Object.entries(result.modelStats)
        .filter(([model]) => aliases.has(model))
        .map(([model, stats]) => [aliases.get(model)!, publicModelStats(stats)])
    ),
    metricCount: summary.metricCount,
    scorecardEligibleMetricCount: summary.scorecardEligibleCount,
    metricPromotionClassCounts: summary.byClass,
    scorecardEligibleMetricClassCounts: summary.scorecardEligibleByClass
  };
}

function publicModelStats(stats: TournamentResult["modelStats"][string]): Record<string, number> {
  return {
    harnessTurns: stats.harnessTurns,
    harnessErrors: stats.harnessErrors,
    nativeSteps: stats.nativeSteps,
    committedSteps: stats.committedSteps,
    rejectedSteps: stats.rejectedSteps,
    promptTokens: stats.promptTokens,
    completionTokens: stats.completionTokens,
    latencyMs: stats.latencyMs
  };
}

function publicBenchmarkStatistics(
  result: TournamentResult,
  createdAt: string,
  artifactsByIndex: Map<number, MatchArtifact>,
  aliases: Map<string, string>,
  summary: ReturnType<typeof summarizeTournamentMetricPromotions>
): Record<string, unknown> {
  const totals = publicStepTotals(result, artifactsByIndex);
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-benchmark-statistics",
    visibility: "public",
    createdAt,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    statusCounts: countStatuses(result.episodes),
    nativeSteps: totals.nativeSteps,
    committedSteps: totals.committedSteps,
    rejectedSteps: totals.rejectedSteps,
    metricCount: summary.metricCount,
    scorecardEligibleMetricCount: summary.scorecardEligibleCount,
    metricPromotionClassCounts: summary.byClass,
    scorecardEligibleMetricClassCounts: summary.scorecardEligibleByClass,
    modelStats: Object.fromEntries(
      Object.entries(result.modelStats)
        .filter(([model]) => aliases.has(model))
        .map(([model, stats]) => [aliases.get(model)!, publicModelStats(stats)])
    )
  };
}

function publicTournamentComparison(
  result: TournamentResult,
  createdAt: string,
  summary: ReturnType<typeof summarizeTournamentMetricPromotions>
): Record<string, unknown> {
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-comparison",
    visibility: "public",
    createdAt,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    metricCount: summary.metricCount,
    scorecardEligibleMetricCount: summary.scorecardEligibleCount
  };
}

function publicAssignmentExport(result: TournamentResult, matches: PublicTournamentMatchRecord[]): Record<string, unknown> {
  const matchesByIndex = new Map(matches.map((match) => [match.episodeIndex, match]));
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-roster",
    visibility: "public",
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    episodes: result.episodes.map((episode) => {
      const match = matchesByIndex.get(episode.index);
      return {
        episodeIndex: episode.index,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? match?.harnessStatus ?? null,
        seats: episode.agents.map((agent) => agent.seat).sort((left, right) => left - right),
        nativeSteps: match?.nativeSteps ?? 0,
        committedSteps: match?.committedSteps ?? 0,
        rejectedSteps: match?.rejectedSteps ?? 0,
        matchArtifact: match?.relativePath ?? null,
        matchJsonl: match?.relativeJsonlPath ?? null
      };
    })
  };
}

function publicRegistryExport(createdAt: string, summary: ReturnType<typeof summarizeTournamentMetricPromotions>): Record<string, unknown> {
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-evaluation-summary",
    visibility: "public",
    createdAt,
    metricCount: summary.metricCount,
    scorecardEligibleMetricCount: summary.scorecardEligibleCount,
    metricPromotionClassCounts: summary.byClass,
    scorecardEligibleMetricClassCounts: summary.scorecardEligibleByClass
  };
}

function publicSpecExport(result: TournamentResult, aliases: Map<string, string>): Record<string, unknown> {
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament-spec",
    visibility: "public",
    gamesRequested: result.gamesRequested,
    maxTransitions: result.maxTransitions ?? null,
    modelCount: aliases.size,
    models: [...aliases.values()]
  };
}

function publicManifest(
  result: TournamentResult,
  options: {
    createdAt: string;
    overwrite: boolean;
    publicMatches: PublicTournamentMatchRecord[];
    stepTotals: ReturnType<typeof publicStepTotals>;
    promotionSummary: ReturnType<typeof summarizeTournamentMetricPromotions>;
    integrity: ReturnType<typeof aggregateIntegrityRecords>;
  }
): Record<string, unknown> {
  const statusCounts = countStatuses(result.episodes);
  const integrityErrorCount = options.integrity.reduce((sum, record) => sum + record.errorCount, 0);
  return {
    artifactVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    kind: "public-tournament",
    visibility: "public",
    createdAt: options.createdAt,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesHarnessCompleted: statusCounts.completed ?? 0,
    gamesHarnessFailed: statusCounts.failed ?? 0,
    maxTransitions: result.maxTransitions ?? null,
    statusCounts,
    nativeSteps: options.stepTotals.nativeSteps,
    committedSteps: options.stepTotals.committedSteps,
    rejectedSteps: options.stepTotals.rejectedSteps,
    metricCount: options.promotionSummary.metricCount,
    scorecardEligibleMetricCount: options.promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: options.promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: options.promotionSummary.scorecardEligibleByClass,
    artifactIntegrityOkCount: options.integrity.filter((record) => record.ok).length,
    artifactIntegrityErrorCount: integrityErrorCount,
    collisionPolicy: options.overwrite ? "overwrite" : "fail-if-exists",
    projection: {
      visibility: "public",
      matchArtifactView: "truth-redacted",
      assignmentTruthRedacted: true,
      publicShareSafe: true,
      schemaVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION
    },
    files: publicFileManifest(options.publicMatches),
    matchCount: options.publicMatches.length,
    matches: options.publicMatches.map((match) => ({
      episodeIndex: match.episodeIndex,
      status: match.status,
      harnessStatus: match.harnessStatus,
      nativeSteps: match.nativeSteps,
      committedSteps: match.committedSteps,
      rejectedSteps: match.rejectedSteps,
      publicMessageCount: match.publicMessageCount,
      playerCount: match.playerCount,
      path: match.relativePath,
      jsonlPath: match.relativeJsonlPath
    }))
  };
}

function publicFileManifest(matches: PublicTournamentMatchRecord[]): Record<string, unknown> {
  return {
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
    matches: matches.map((match) => match.relativePath),
    matchesJsonl: matches.map((match) => match.relativeJsonlPath)
  };
}

function publicTrajectoryRecord(match: PublicTournamentMatchRecord): Record<string, unknown> {
  return {
    type: "public_match_summary",
    schemaVersion: PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
    episodeIndex: match.episodeIndex,
    status: match.status,
    harnessStatus: match.harnessStatus,
    nativeSteps: match.nativeSteps,
    committedSteps: match.committedSteps,
    rejectedSteps: match.rejectedSteps,
    publicMessageCount: match.publicMessageCount,
    playerCount: match.playerCount
  };
}

function publicTournamentSummaryMarkdown(input: {
  createdAt: string;
  result: TournamentResult;
  stepTotals: ReturnType<typeof publicStepTotals>;
  promotionSummary: ReturnType<typeof summarizeTournamentMetricPromotions>;
  integrity: ReturnType<typeof aggregateIntegrityRecords>;
  failures: Array<Record<string, unknown>>;
  publicModelAliases: Map<string, string>;
}): string {
  const integrityErrors = input.integrity.reduce((sum, record) => sum + record.errorCount, 0);
  const modelRows = Object.entries(input.result.modelStats)
    .filter(([model]) => input.publicModelAliases.has(model))
    .map(([model, stats]) => [
      input.publicModelAliases.get(model)!,
      String(stats.harnessTurns),
      String(stats.nativeSteps),
      String(stats.committedSteps),
      String(stats.rejectedSteps)
    ]);
  return [
    "# Public Tournament Summary",
    "",
    "This bundle contains public observations and anonymous aggregate measurements only. It is not replay authority.",
    "",
    "## Run Set",
    "",
    `- Created at: ${input.createdAt}`,
    `- Games requested: ${input.result.gamesRequested}`,
    `- Games completed: ${input.result.gamesCompleted}`,
    `- Games failed: ${input.result.gamesFailed}`,
    `- Native steps: ${input.stepTotals.nativeSteps}`,
    `- Committed steps: ${input.stepTotals.committedSteps}`,
    `- Rejected steps: ${input.stepTotals.rejectedSteps}`,
    `- Integrity errors: ${integrityErrors}`,
    `- Failure summaries: ${input.failures.length}`,
    `- Metric rows: ${input.promotionSummary.metricCount}`,
    "",
    "## Anonymous Model Aggregate",
    "",
    markdownTable(
      ["model", "turns", "native", "committed", "rejected"],
      modelRows
    ),
    "",
    "## Publication Boundary",
    "",
    "Seeds, profile and policy identities, role/team assignments, private channels, action traces, evaluator evidence, and provider request identifiers are intentionally excluded."
  ].join("\n") + "\n";
}

function publicTournamentComparisonMarkdown(comparison: Record<string, unknown>): string {
  return [
    "# Public Tournament Comparison",
    "",
    "This aggregate intentionally excludes per-match provenance and hidden-truth evidence.",
    "",
    `- Games requested: ${numericField(comparison.gamesRequested) ?? 0}`,
    `- Games completed: ${numericField(comparison.gamesCompleted) ?? 0}`,
    `- Games failed: ${numericField(comparison.gamesFailed) ?? 0}`,
    `- Metric rows: ${numericField(comparison.metricCount) ?? 0}`
  ].join("\n") + "\n";
}

function assertPublicPackDoesNotContainKnownSecrets(
  values: unknown[],
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[]
): void {
  const sensitiveValues = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && value.length >= 3) sensitiveValues.add(value);
  };
  add(result.seed);
  add(result.experiment.id);
  for (const episode of result.episodes) {
    add(episode.seed);
    add(episode.runId);
    add(episode.matchId);
  }
  for (const profile of result.profiles) {
    add(profile.id);
    add(profile.model);
    add(profile.policyName);
  }
  for (const artifact of artifactRecords) {
    add(artifact.seed);
    add(artifact.runId);
    add(artifact.matchId);
  }
  const serialized = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  for (const secret of sensitiveValues) {
    if (serialized.includes(secret)) {
      throw new Error("Public tournament artifact projection retained a canonical identity or deterministic seed.");
    }
  }
}
