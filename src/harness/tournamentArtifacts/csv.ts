import { isRecord, ratio, stableJson } from "./ioSupport";
import { MatchArtifact } from "../artifacts";
import { resolveRecordedMetricPromotion, summarizeEvaluationWarnings } from "../evaluation";
import { redactSecrets } from "../redaction";
import { countSocialStepCommits, countSocialStepCommitsByActor } from "../social";
import { TournamentResult } from "../tournament";
import { RebuiltTournamentLeaderboard } from "../tournamentLeaderboard";
import { PublicTournamentMatchRecord, promotionFallbackPolicyForReport } from "./model";
import { numericField, stringFieldFromRecord } from "./publicPack";
import { summarizeTournamentMetricPromotionsFromMetrics } from "./summary";
const PUBLIC_EPISODE_CSV_HEADERS = [
  "episode_index",
  "status",
  "harness_status",
  "phase",
  "day",
  "native_steps",
  "committed_steps",
  "rejected_steps",
  "public_message_count",
  "player_count",
  "metric_count",
  "scorecard_eligible_metric_count",
  "match_artifact",
  "match_jsonl"
];

const PUBLIC_AGENT_CSV_HEADERS = [
  "episode_index",
  "status",
  "harness_status",
  "seat"
];

const PUBLIC_METRIC_CSV_HEADERS = ["promotion_class", "metric_count", "scorecard_eligible_metric_count"];

const PUBLIC_LEADERBOARD_CSV_HEADERS = [
  "model",
  "harness_turns",
  "harness_errors",
  "native_steps",
  "committed_steps",
  "rejected_steps",
  "prompt_tokens",
  "completion_tokens",
  "latency_ms"
];

function publicEpisodeCsvRows(episodes: Array<Record<string, unknown>>): Array<Record<string, CsvCell>> {
  return episodes.map((episode) => ({
    episode_index: numericField(episode.episodeIndex) ?? 0,
    status: stringFieldFromRecord(episode, "status") ?? "unknown",
    harness_status: stringFieldFromRecord(episode, "harnessStatus") ?? "",
    phase: stringFieldFromRecord(episode, "phase") ?? "",
    day: numericField(episode.day) ?? "",
    native_steps: numericField(episode.nativeSteps) ?? 0,
    committed_steps: numericField(episode.committedSteps) ?? 0,
    rejected_steps: numericField(episode.rejectedSteps) ?? 0,
    public_message_count: numericField(episode.publicMessageCount) ?? 0,
    player_count: numericField(episode.playerCount) ?? 0,
    metric_count: numericField(episode.metricCount) ?? 0,
    scorecard_eligible_metric_count: numericField(episode.scorecardEligibleMetricCount) ?? 0,
    match_artifact: stringFieldFromRecord(episode, "matchArtifact") ?? "",
    match_jsonl: stringFieldFromRecord(episode, "matchJsonl") ?? ""
  }));
}

function publicAgentCsvRows(result: TournamentResult, matches: PublicTournamentMatchRecord[]): Array<Record<string, CsvCell>> {
  const matchesByIndex = new Map(matches.map((match) => [match.episodeIndex, match]));
  return result.episodes.flatMap((episode) => {
    const match = matchesByIndex.get(episode.index);
    return episode.agents.map((agent) => ({
        episode_index: episode.index,
        status: episode.status,
        harness_status: episode.harnessStatus ?? match?.harnessStatus ?? "",
        seat: agent.seat
      }));
  });
}

function publicMetricCsvRows(metrics: Array<Record<string, unknown>>): Array<Record<string, CsvCell>> {
  return metrics.map((metric) => ({
    promotion_class: stringFieldFromRecord(metric, "promotionClass") ?? "unknown",
    metric_count: numericField(metric.metricCount) ?? 0,
    scorecard_eligible_metric_count: numericField(metric.scorecardEligibleMetricCount) ?? 0
  }));
}

function publicLeaderboardCsvRows(leaderboard: Record<string, unknown>): Array<Record<string, CsvCell>> {
  const modelStats = isRecord(leaderboard.modelStats) ? leaderboard.modelStats : {};
  return Object.entries(modelStats)
    .filter(([, stats]) => isRecord(stats))
    .map(([model, stats]) => ({
      model,
      harness_turns: numericField((stats as Record<string, unknown>).harnessTurns) ?? 0,
      harness_errors: numericField((stats as Record<string, unknown>).harnessErrors) ?? 0,
      native_steps: numericField((stats as Record<string, unknown>).nativeSteps) ?? 0,
      committed_steps: numericField((stats as Record<string, unknown>).committedSteps) ?? 0,
      rejected_steps: numericField((stats as Record<string, unknown>).rejectedSteps) ?? 0,
      prompt_tokens: numericField((stats as Record<string, unknown>).promptTokens) ?? 0,
      completion_tokens: numericField((stats as Record<string, unknown>).completionTokens) ?? 0,
      latency_ms: numericField((stats as Record<string, unknown>).latencyMs) ?? 0
    }));
}

export function episodeCsvRows(
  result: TournamentResult,
  relativeMatchPaths: Map<number, string>,
  relativeMatchJsonlPaths: Map<number, string>,
  artifactsByIndex: Map<number, MatchArtifact>,
  redactTruth = false
): Array<Record<string, CsvCell>> {
  return result.episodes.map((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const warningSummary = summarizeEvaluationWarnings(episode.evaluationReport?.warnings);
    const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
    const promotionSummary = summarizeTournamentMetricPromotionsFromMetrics(
      episode.evaluationReport?.metrics ?? [],
      promotionFallbackPolicyForReport(episode.evaluationReport)
    );
    return {
      tournament_seed: result.seed,
      episode_index: episode.index,
      episode_seed: episode.seed,
      run_id: episode.runId ?? artifact?.runId ?? "",
      match_id: episode.matchId ?? artifact?.matchId ?? "",
      status: episode.status,
      harness_status: episode.harnessStatus ?? artifact?.status ?? "",
      winner: redactTruth ? "" : episode.winner ?? artifact?.finalState.winner ?? "",
      phase: episode.phase ?? artifact?.finalState.phase ?? "",
      day: episode.day ?? artifact?.finalState.day ?? "",
      native_steps: stepCounts.nativeSteps,
      committed_steps: stepCounts.committedSteps,
      rejected_steps: stepCounts.rejectedSteps,
      trajectory_steps: episode.trajectory?.length ?? artifact?.trajectory.length ?? 0,
      message_count: episode.socialEpisode?.messages.length ?? artifact?.socialEpisode.messages.length ?? 0,
      metric_count: episode.evaluationReport?.metricCount ?? artifact?.evaluationReport.metricCount ?? promotionSummary.metricCount,
      scorecard_eligible_metric_count: promotionSummary.scorecardEligibleCount,
      scorecard_metric_count: promotionSummary.byClass.scorecard,
      diagnostic_metric_count: promotionSummary.byClass.diagnostic,
      benchmark_only_metric_count: promotionSummary.byClass.benchmark_only,
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

export function agentCsvRows(
  result: TournamentResult,
  artifactsByIndex: Map<number, MatchArtifact> = new Map(),
  redactTruth = false
): Array<Record<string, CsvCell>> {
  return result.episodes.flatMap((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const densityByActor = countSocialStepCommitsByActor(
      episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []
    );
    return episode.agents.map((agent) => {
      const density = densityByActor.get(agent.playerId) ?? {
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      };
      return {
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
        role: redactTruth ? "" : agent.role ?? "",
        team: redactTruth ? "" : agent.team ?? "",
        won: redactTruth ? "" : agent.won ?? "",
        reward: agent.reward ?? "",
        native_steps: density.nativeSteps,
        committed_steps: density.committedSteps,
        rejected_steps: density.rejectedSteps
      };
    });
  });
}

export function metricCsvRows(result: TournamentResult, redactTruth = false): Array<Record<string, CsvCell>> {
  return result.episodes.flatMap((episode) =>
    (episode.evaluationReport?.metrics ?? []).map((metric) => {
      const metadata =
        redactTruth && metric.metadata && typeof metric.metadata === "object"
          ? (() => {
              const { role: _role, team: _team, ...rest } = metric.metadata as Record<string, unknown>;
              return Object.keys(rest).length ? rest : undefined;
            })()
          : metric.metadata;
      // subject_id and scope remain; role/team truth lives mainly in subject/metadata
      // and is stripped from metrics.jsonl via aggregateMetricRecords. CSV keeps the
      // same column set so public packs do not invent new schema fields.
      void redactTruth;
      const promotion = resolveRecordedMetricPromotion(metric, promotionFallbackPolicyForReport(episode.evaluationReport));
      return {
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
        promotion_class: promotion.promotionClass,
        scorecard_eligible: promotion.eligibleForScorecard,
        promotion_reasons: promotion.reasons.join("|"),
        promotion_decision_id: promotion.catalogDecisionId ?? "",
        metadata: metadata ? stableJson(metadata) : "",
        promotion_policy_id: promotion.policyId,
        promotion_policy_version: promotion.policyVersion,
        promotion_policy_hash: promotion.policyHash,
        promotion_catalog_id: promotion.catalogId,
        promotion_catalog_version: promotion.catalogVersion,
        promotion_catalog_hash: promotion.catalogHash,
        promotion_resolution: promotion.resolution
      };
    })
  );
}

export function leaderboardCsvRows(
  rebuilt: RebuiltTournamentLeaderboard,
  redactTruth = false
): Array<Record<string, CsvCell>> {
  return [
    ...Object.values(rebuilt.modelStats).map((stats) => ({
      subject_type: "model",
      subject_id: stats.model,
      model: stats.model,
      profile_id: "",
      policy_name: "",
      seat_games: stats.seatGames,
      seat_wins: stats.seatWins,
      win_rate: ratio(stats.seatWins, stats.seatGames),
      village_seat_games: redactTruth ? "" : stats.villageSeatGames,
      village_seat_wins: redactTruth ? "" : stats.villageSeatWins,
      werewolf_seat_games: redactTruth ? "" : stats.werewolfSeatGames,
      werewolf_seat_wins: redactTruth ? "" : stats.werewolfSeatWins,
      harness_turns: stats.harnessTurns,
      harness_errors: stats.harnessErrors,
      native_steps: stats.nativeSteps,
      committed_steps: stats.committedSteps,
      rejected_steps: stats.rejectedSteps,
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      latency_ms: stats.latencyMs,
      reward_total: stats.rewardTotal,
      average_reward: stats.averageReward
    })),
    ...Object.values(rebuilt.profileStats).map((stats) => ({
      subject_type: "profile",
      subject_id: stats.profileId,
      model: stats.model,
      profile_id: stats.profileId,
      policy_name: stats.policyName ?? "",
      seat_games: stats.seatGames,
      seat_wins: stats.seatWins,
      win_rate: ratio(stats.seatWins, stats.seatGames),
      village_seat_games: redactTruth ? "" : stats.villageSeatGames,
      village_seat_wins: redactTruth ? "" : stats.villageSeatWins,
      werewolf_seat_games: redactTruth ? "" : stats.werewolfSeatGames,
      werewolf_seat_wins: redactTruth ? "" : stats.werewolfSeatWins,
      harness_turns: stats.harnessTurns,
      harness_errors: stats.harnessErrors,
      native_steps: stats.nativeSteps,
      committed_steps: stats.committedSteps,
      rejected_steps: stats.rejectedSteps,
      prompt_tokens: stats.promptTokens,
      completion_tokens: stats.completionTokens,
      latency_ms: stats.latencyMs,
      reward_total: stats.rewardTotal,
      average_reward: stats.averageReward
    }))
  ];
}

type CsvCell = string | number | boolean | null | undefined;

export const EPISODE_CSV_HEADERS = [
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
  "native_steps",
  "committed_steps",
  "rejected_steps",
  "trajectory_steps",
  "message_count",
  "metric_count",
  "scorecard_eligible_metric_count",
  "scorecard_metric_count",
  "diagnostic_metric_count",
  "benchmark_only_metric_count",
  "warning_count",
  "warning_codes",
  "harness_error_count",
  "agent_count",
  "match_artifact",
  "match_jsonl",
  "error"
];

export const AGENT_CSV_HEADERS = [
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
  "reward",
  "native_steps",
  "committed_steps",
  "rejected_steps"
];

export const METRIC_CSV_HEADERS = [
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
  "promotion_class",
  "scorecard_eligible",
  "promotion_reasons",
  "promotion_decision_id",
  "metadata",
  "promotion_policy_id",
  "promotion_policy_version",
  "promotion_policy_hash",
  "promotion_catalog_id",
  "promotion_catalog_version",
  "promotion_catalog_hash",
  "promotion_resolution"
];

export const LEADERBOARD_CSV_HEADERS = [
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
  "native_steps",
  "committed_steps",
  "rejected_steps",
  "prompt_tokens",
  "completion_tokens",
  "latency_ms",
  "reward_total",
  "average_reward"
];

export function buildCsv(headers: string[], rows: Array<Record<string, CsvCell>>): string {
  return `${[headers, ...rows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: CsvCell): string {
  if (value === undefined || value === null) return "";
  const redacted = redactSecrets(String(value));
  const text = typeof redacted === "string" ? redacted : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
