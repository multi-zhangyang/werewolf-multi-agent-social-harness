import type { Role } from "../core/types";
import type { HarnessAgentProfile } from "./types";
import type { TournamentModelStats, TournamentProfileStats } from "./tournament";

/**
 * The leaderboard is an artifact-derived analysis, not a second source of
 * execution truth.  This input intentionally accepts parsed JSON records so
 * researchers can rebuild the aggregate after the in-memory TournamentResult
 * has gone away.
 */
export interface RebuildTournamentLeaderboardFromRawRecordsOptions {
  models: readonly string[];
  profiles: ReadonlyArray<Pick<HarnessAgentProfile, "id" | "model" | "policyName">>;
  episodeRecords: readonly unknown[];
  metricRecords: readonly unknown[];
  costLatencyReport: unknown;
}

export interface TournamentMetricPromotionTotals {
  metricCount: number;
  scorecardEligibleCount: number;
  byClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
  scorecardEligibleByClass: Record<"scorecard" | "diagnostic" | "benchmark_only", number>;
}

export interface TournamentEvaluationCoverage {
  evaluationReportCount: number;
  evaluationCompletedEpisodes: number;
  evaluationIncompleteEpisodes: number;
  evaluatorFailureCount: number;
}

export interface RebuiltTournamentLeaderboard {
  modelStats: Record<string, TournamentModelStats>;
  profileStats: Record<string, TournamentProfileStats>;
  metricPromotion: TournamentMetricPromotionTotals;
  evaluationCoverage: TournamentEvaluationCoverage;
}

type Density = {
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
};

interface RawEpisodeAgent extends Density {
  playerId: string;
  seat: number;
  profileId?: string;
  model: string;
  role?: Role;
  team?: "village" | "werewolves";
  won?: boolean;
}

interface RawProfileExecutionDensity extends Density {
  profileId: string;
  model: string;
  harnessTurns: number;
}

interface RawEpisodeRecord {
  episodeIndex: number;
  status: "completed" | "truncated" | "failed";
  hasEvaluationReport: boolean;
  evaluationStatus: "completed" | "incomplete" | null;
  evaluatorFailureCount: number;
  agents: RawEpisodeAgent[];
  profileExecution: RawProfileExecutionDensity[];
}

interface RawModelUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

interface RawCostLatencyEpisode {
  episodeIndex: number;
  harnessErrors: number;
  modelUsage: Record<string, RawModelUsage>;
}

const ROLES: readonly Role[] = ["villager", "werewolf", "seer", "witch", "hunter"];
const PROMOTION_CLASSES = ["scorecard", "diagnostic", "benchmark_only"] as const;

/**
 * Rebuild the completed-only tournament leaderboard from persisted raw
 * records. It never reads TournamentResult.modelStats/profileStats and never
 * re-runs evaluator code or a currently-installed promotion catalog.
 *
 * A strict public pack deliberately does not include these research records;
 * callers must therefore fail closed rather than attempting to infer hidden
 * role/team/profile facts from public observations.
 */
export function rebuildTournamentLeaderboardFromRawRecords(
  options: RebuildTournamentLeaderboardFromRawRecordsOptions
): RebuiltTournamentLeaderboard {
  const episodes = options.episodeRecords.map((record, index) => parseEpisodeRecord(record, index));
  const costsByEpisode = parseCostLatencyReport(options.costLatencyReport);
  const metricPromotion = summarizeRecordedMetricPromotions(options.metricRecords);
  const rewardsByEpisodeAndPlayer = recordedAgentRewards(options.metricRecords);
  const modelStats = Object.fromEntries(options.models.map((model) => [model, createEmptyModelStats(model)]));
  const profileStats = Object.fromEntries(
    options.profiles.map((profile) => [profile.id, createEmptyProfileStats(profile)])
  );

  for (const episode of episodes) {
    if (episode.status !== "completed") continue;
    const cost = costsByEpisode.get(episode.episodeIndex);
    if (!cost) {
      throw new Error(`Raw leaderboard rebuild requires a cost/latency episode record for completed episode ${episode.episodeIndex}.`);
    }

    for (const agent of episode.agents) {
      const model = modelStats[agent.model] ?? (modelStats[agent.model] = createEmptyModelStats(agent.model));
      accumulateSeatStats(model, agent, rewardsByEpisodeAndPlayer.get(rewardKey(episode.episodeIndex, agent.playerId)));
      if (agent.profileId) {
        const profile =
          profileStats[agent.profileId] ??
          (profileStats[agent.profileId] = createEmptyProfileStats({ id: agent.profileId, model: agent.model }));
        accumulateSeatStats(profile, agent, rewardsByEpisodeAndPlayer.get(rewardKey(episode.episodeIndex, agent.playerId)));
      }
      model.nativeSteps += agent.nativeSteps;
      model.committedSteps += agent.committedSteps;
      model.rejectedSteps += agent.rejectedSteps;
    }

    for (const [modelName, usage] of Object.entries(cost.modelUsage)) {
      const model = modelStats[modelName] ?? (modelStats[modelName] = createEmptyModelStats(modelName));
      model.harnessTurns += usage.calls;
      model.promptTokens += usage.promptTokens;
      model.completionTokens += usage.completionTokens;
      model.latencyMs += usage.latencyMs;
    }

    for (const density of episode.profileExecution) {
      const profile =
        profileStats[density.profileId] ??
        (profileStats[density.profileId] = createEmptyProfileStats({ id: density.profileId, model: density.model }));
      profile.harnessTurns += density.harnessTurns;
      profile.nativeSteps += density.nativeSteps;
      profile.committedSteps += density.committedSteps;
      profile.rejectedSteps += density.rejectedSteps;
    }

    // Preserve the historic completed-episode contract: a harness error is a
    // run-level reliability observation attached to every configured subject,
    // not an inferred per-actor blame score.
    for (const stats of Object.values(modelStats)) stats.harnessErrors += cost.harnessErrors;
    for (const stats of Object.values(profileStats)) stats.harnessErrors += cost.harnessErrors;
  }

  for (const stats of Object.values(modelStats)) {
    stats.averageReward = round3(stats.rewardTotal / Math.max(1, stats.seatGames));
  }
  for (const stats of Object.values(profileStats)) {
    stats.averageReward = round3(stats.rewardTotal / Math.max(1, stats.seatGames));
  }

  return {
    modelStats,
    profileStats,
    metricPromotion,
    evaluationCoverage: evaluationCoverageFromRawEpisodes(episodes)
  };
}

function parseEpisodeRecord(value: unknown, index: number): RawEpisodeRecord {
  const record = requiredRecord(value, `episode record ${index}`);
  if (record.type !== "episode") throw new Error(`Raw leaderboard rebuild requires an episode record at index ${index}.`);
  const episodeIndex = requiredNonNegativeInteger(record.episodeIndex, `episode record ${index}.episodeIndex`);
  const status = requiredEpisodeStatus(record.status, `episode record ${episodeIndex}.status`);
  const hasEvaluationReport = requiredBoolean(record.hasEvaluationReport, `episode record ${episodeIndex}.hasEvaluationReport`);
  const evaluationStatus = nullableEvaluationStatus(record.evaluationStatus, `episode record ${episodeIndex}.evaluationStatus`);
  if (hasEvaluationReport !== (evaluationStatus !== null)) {
    throw new Error(`Raw leaderboard rebuild rejected inconsistent evaluation coverage for episode ${episodeIndex}.`);
  }
  const evaluatorFailureCount = requiredNonNegativeInteger(
    record.evaluatorFailureCount,
    `episode record ${episodeIndex}.evaluatorFailureCount`
  );
  const agents = requiredArray(record.agents, `episode record ${episodeIndex}.agents`).map((agent, agentIndex) =>
    parseEpisodeAgent(agent, episodeIndex, agentIndex)
  );
  const profileExecution = requiredArray(record.profileExecution, `episode record ${episodeIndex}.profileExecution`).map(
    (density, densityIndex) => parseProfileExecutionDensity(density, episodeIndex, densityIndex)
  );
  return { episodeIndex, status, hasEvaluationReport, evaluationStatus, evaluatorFailureCount, agents, profileExecution };
}

function parseEpisodeAgent(value: unknown, episodeIndex: number, agentIndex: number): RawEpisodeAgent {
  const record = requiredRecord(value, `episode record ${episodeIndex}.agents[${agentIndex}]`);
  const role = optionalRole(record.role, `episode record ${episodeIndex}.agents[${agentIndex}].role`);
  const team = optionalTeam(record.team, `episode record ${episodeIndex}.agents[${agentIndex}].team`);
  return {
    playerId: requiredString(record.playerId, `episode record ${episodeIndex}.agents[${agentIndex}].playerId`),
    seat: requiredNonNegativeInteger(record.seat, `episode record ${episodeIndex}.agents[${agentIndex}].seat`),
    profileId: optionalString(record.profileId, `episode record ${episodeIndex}.agents[${agentIndex}].profileId`),
    model: requiredString(record.model, `episode record ${episodeIndex}.agents[${agentIndex}].model`),
    ...(role ? { role } : {}),
    ...(team ? { team } : {}),
    ...(typeof record.won === "boolean" ? { won: record.won } : {}),
    ...parseDensity(record, `episode record ${episodeIndex}.agents[${agentIndex}]`)
  };
}

function parseProfileExecutionDensity(value: unknown, episodeIndex: number, densityIndex: number): RawProfileExecutionDensity {
  const label = `episode record ${episodeIndex}.profileExecution[${densityIndex}]`;
  const record = requiredRecord(value, label);
  return {
    profileId: requiredString(record.profileId, `${label}.profileId`),
    model: requiredString(record.model, `${label}.model`),
    harnessTurns: requiredNonNegativeInteger(record.harnessTurns, `${label}.harnessTurns`),
    ...parseDensity(record, label)
  };
}

function parseDensity(record: Record<string, unknown>, label: string): Density {
  const nativeSteps = requiredNonNegativeInteger(record.nativeSteps, `${label}.nativeSteps`);
  const committedSteps = requiredNonNegativeInteger(record.committedSteps, `${label}.committedSteps`);
  const rejectedSteps = requiredNonNegativeInteger(record.rejectedSteps, `${label}.rejectedSteps`);
  if (nativeSteps !== committedSteps + rejectedSteps) {
    throw new Error(`Raw leaderboard rebuild rejected inconsistent step density for ${label}.`);
  }
  return { nativeSteps, committedSteps, rejectedSteps };
}

function parseCostLatencyReport(value: unknown): Map<number, RawCostLatencyEpisode> {
  const report = requiredRecord(value, "cost/latency report");
  if (report.kind !== "tournament-cost-latency") {
    throw new Error("Raw leaderboard rebuild requires a research tournament cost/latency report.");
  }
  const entries = requiredArray(report.episodes, "cost/latency report.episodes");
  const parsed = new Map<number, RawCostLatencyEpisode>();
  for (const [index, value] of entries.entries()) {
    const record = requiredRecord(value, `cost/latency report.episodes[${index}]`);
    const episodeIndex = requiredNonNegativeInteger(record.episodeIndex, `cost/latency report.episodes[${index}].episodeIndex`);
    if (parsed.has(episodeIndex)) throw new Error(`Raw leaderboard rebuild found duplicate cost/latency episode ${episodeIndex}.`);
    const usageRecord = requiredRecord(record.modelUsage, `cost/latency report.episodes[${index}].modelUsage`);
    const modelUsage = Object.fromEntries(
      Object.entries(usageRecord).map(([model, usage]) => [model, parseModelUsage(usage, episodeIndex, model)])
    );
    parsed.set(episodeIndex, {
      episodeIndex,
      harnessErrors: requiredNonNegativeInteger(record.harnessErrors, `cost/latency report.episodes[${index}].harnessErrors`),
      modelUsage
    });
  }
  return parsed;
}

function parseModelUsage(value: unknown, episodeIndex: number, model: string): RawModelUsage {
  const label = `cost/latency episode ${episodeIndex}.modelUsage.${model}`;
  const record = requiredRecord(value, label);
  return {
    calls: requiredNonNegativeInteger(record.calls, `${label}.calls`),
    promptTokens: requiredNonNegativeInteger(record.promptTokens, `${label}.promptTokens`),
    completionTokens: requiredNonNegativeInteger(record.completionTokens, `${label}.completionTokens`),
    latencyMs: requiredNonNegativeInteger(record.latencyMs, `${label}.latencyMs`)
  };
}

function recordedAgentRewards(records: readonly unknown[]): Map<string, number> {
  const rewards = new Map<string, number>();
  for (const [index, value] of records.entries()) {
    const record = requiredRecord(value, `metric record ${index}`);
    if (record.type !== "metric" || record.id !== "agent.reward") continue;
    const episodeIndex = requiredNonNegativeInteger(record.episodeIndex, `metric record ${index}.episodeIndex`);
    const playerId = requiredString(record.subjectId, `metric record ${index}.subjectId`);
    const reward = requiredFiniteNumber(record.value, `metric record ${index}.value`);
    const key = rewardKey(episodeIndex, playerId);
    if (rewards.has(key)) throw new Error(`Raw leaderboard rebuild found duplicate agent.reward metric for ${key}.`);
    rewards.set(key, reward);
  }
  return rewards;
}

function summarizeRecordedMetricPromotions(records: readonly unknown[]): TournamentMetricPromotionTotals {
  const totals: TournamentMetricPromotionTotals = {
    metricCount: 0,
    scorecardEligibleCount: 0,
    byClass: { scorecard: 0, diagnostic: 0, benchmark_only: 0 },
    scorecardEligibleByClass: { scorecard: 0, diagnostic: 0, benchmark_only: 0 }
  };
  for (const [index, value] of records.entries()) {
    const record = requiredRecord(value, `metric record ${index}`);
    if (record.type !== "metric") throw new Error(`Raw leaderboard rebuild requires a metric record at index ${index}.`);
    const promotionClass = requiredPromotionClass(record.promotionClass, `metric record ${index}.promotionClass`);
    const scorecardEligible = requiredBoolean(record.scorecardEligible, `metric record ${index}.scorecardEligible`);
    totals.metricCount += 1;
    totals.byClass[promotionClass] += 1;
    if (scorecardEligible) {
      totals.scorecardEligibleCount += 1;
      totals.scorecardEligibleByClass[promotionClass] += 1;
    }
  }
  return totals;
}

function evaluationCoverageFromRawEpisodes(episodes: readonly RawEpisodeRecord[]): TournamentEvaluationCoverage {
  const reports = episodes.filter((episode) => episode.hasEvaluationReport);
  return {
    evaluationReportCount: reports.length,
    evaluationCompletedEpisodes: reports.filter((episode) => episode.evaluationStatus === "completed").length,
    evaluationIncompleteEpisodes: reports.filter((episode) => episode.evaluationStatus === "incomplete").length,
    evaluatorFailureCount: reports.reduce((sum, episode) => sum + episode.evaluatorFailureCount, 0)
  };
}

function accumulateSeatStats(
  stats: TournamentModelStats,
  agent: RawEpisodeAgent,
  recordedReward: number | undefined
): void {
  stats.seatGames += 1;
  if (agent.won) stats.seatWins += 1;
  if (agent.team === "village") {
    stats.villageSeatGames += 1;
    if (agent.won) stats.villageSeatWins += 1;
  }
  if (agent.team === "werewolves") {
    stats.werewolfSeatGames += 1;
    if (agent.won) stats.werewolfSeatWins += 1;
  }
  if (agent.role) {
    stats.roleGames[agent.role] += 1;
    if (agent.won) stats.roleWins[agent.role] += 1;
  }
  // The aggregate intentionally consumes the persisted agent.reward metric,
  // not the current evaluator implementation or an episode convenience field.
  if (recordedReward !== undefined) stats.rewardTotal += recordedReward;
}

function createEmptyModelStats(model: string): TournamentModelStats {
  return {
    model,
    seatGames: 0,
    seatWins: 0,
    villageSeatGames: 0,
    villageSeatWins: 0,
    werewolfSeatGames: 0,
    werewolfSeatWins: 0,
    roleGames: emptyRoleRecord(),
    roleWins: emptyRoleRecord(),
    harnessTurns: 0,
    harnessErrors: 0,
    nativeSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
    rewardTotal: 0,
    averageReward: 0
  };
}

function createEmptyProfileStats(profile: Pick<HarnessAgentProfile, "id" | "model" | "policyName">): TournamentProfileStats {
  return {
    ...createEmptyModelStats(profile.model),
    profileId: profile.id,
    policyName: profile.policyName
  };
}

function emptyRoleRecord(): Record<Role, number> {
  return { villager: 0, werewolf: 0, seer: 0, witch: 0, hunter: 0 };
}

function rewardKey(episodeIndex: number, playerId: string): string {
  return `${episodeIndex}:${playerId}`;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Raw leaderboard rebuild requires ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Raw leaderboard rebuild requires ${label} to be an array.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Raw leaderboard rebuild requires ${label} to be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, label);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Raw leaderboard rebuild requires ${label} to be a boolean.`);
  return value;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Raw leaderboard rebuild requires ${label} to be a finite number.`);
  return value;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Raw leaderboard rebuild requires ${label} to be a non-negative integer.`);
  }
  return value;
}

function requiredEpisodeStatus(value: unknown, label: string): RawEpisodeRecord["status"] {
  if (value === "completed" || value === "truncated" || value === "failed") return value;
  throw new Error(`Raw leaderboard rebuild requires ${label} to be completed, truncated, or failed.`);
}

function nullableEvaluationStatus(value: unknown, label: string): RawEpisodeRecord["evaluationStatus"] {
  if (value === null || value === undefined) return null;
  if (value === "completed" || value === "incomplete") return value;
  throw new Error(`Raw leaderboard rebuild requires ${label} to be completed, incomplete, or null.`);
}

function optionalRole(value: unknown, label: string): Role | undefined {
  if (value === undefined || value === null) return undefined;
  if ((ROLES as readonly string[]).includes(String(value))) return value as Role;
  throw new Error(`Raw leaderboard rebuild rejected an unknown role in ${label}.`);
}

function optionalTeam(value: unknown, label: string): RawEpisodeAgent["team"] {
  if (value === undefined || value === null) return undefined;
  if (value === "village" || value === "werewolves") return value;
  throw new Error(`Raw leaderboard rebuild rejected an unknown team in ${label}.`);
}

function requiredPromotionClass(value: unknown, label: string): (typeof PROMOTION_CLASSES)[number] {
  if ((PROMOTION_CLASSES as readonly string[]).includes(String(value))) return value as (typeof PROMOTION_CLASSES)[number];
  throw new Error(`Raw leaderboard rebuild requires a recorded promotion class for ${label}.`);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
