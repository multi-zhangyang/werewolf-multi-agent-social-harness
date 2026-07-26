import type { Role } from "../../core/types";
import type { HarnessAssignmentConfig, ResolvedAgentAssignment } from "../profiles";
import type { MatchArtifact } from "../artifacts";
import type {
  HarnessAgentConfig,
  HarnessAgentProfile,
  HarnessRunResult,
  WerewolfJointPhaseScheduler
} from "../types";
import { countSocialStepCommitsByActor, isSocialStepCommitted } from "../social";
import type { TournamentEpisode, TournamentModelStats, TournamentProfileStats } from "./types";

export function summarizeEpisode(
  index: number,
  seed: string,
  result: HarnessRunResult,
  agents: HarnessAgentConfig[],
  assignment: HarnessAssignmentConfig,
  resolvedAssignments: ResolvedAgentAssignment[],
  artifactInfo?: {
    runId?: string;
    matchId?: string;
    artifact?: MatchArtifact;
  },
  jointPhaseScheduler?: WerewolfJointPhaseScheduler
): TournamentEpisode {
  const modelByPlayer = new Map(agents.map((agent) => [agent.playerId, agent.model]));
  const profileByPlayer = new Map(agents.map((agent) => [agent.playerId, agent.profileId]));
  const policyByPlayer = new Map(result.agents.map((agent) => [agent.playerId, agent.policyName]));
  const rewardByPlayer = new Map(result.evaluation.agentRewards.map((reward) => [reward.playerId, reward.reward]));
  return {
    index,
    seed,
    runId: artifactInfo?.runId,
    matchId: artifactInfo?.matchId,
    status: result.status,
    harnessStatus: result.status,
    jointPhaseScheduler,
    winner: result.state.winner,
    phase: result.state.phase,
    day: result.state.day,
    metrics: result.metrics,
    evaluation: result.evaluation,
    evaluationReport: result.evaluationReport,
    forkOf: result.forkOf,
    trajectory: result.trajectory,
    socialEpisode: result.socialEpisode,
    assignment,
    resolvedAssignments,
    agents: result.state.players.map((player) => ({
      playerId: player.id,
      seat: player.seat,
      profileId: profileByPlayer.get(player.id),
      model: modelByPlayer.get(player.id) ?? "unknown",
      role: player.role,
      team: player.team,
      policyName: policyByPlayer.get(player.id),
      won: result.state.winner ? player.team === result.state.winner : undefined,
      reward: rewardByPlayer.get(player.id)
    })),
    error: result.status === "failed" ? result.failureReason : undefined,
    artifact: artifactInfo?.artifact
  };
}

export function accumulateCompletedEpisode(
  modelStats: Record<string, TournamentModelStats>,
  profileStats: Record<string, TournamentProfileStats>,
  episode: TournamentEpisode
): void {
  for (const agent of episode.agents) {
    accumulateAgentStats(modelStats[agent.model] ??= createEmptyStats(agent.model), agent);
    if (agent.profileId) {
      accumulateAgentStats(profileStats[agent.profileId] ??= createEmptyProfileStats({ id: agent.profileId, model: agent.model }), agent);
    }
  }

  for (const [modelName, usage] of Object.entries(episode.metrics?.modelUsage ?? {})) {
    const model = modelStats[modelName] ?? createEmptyStats(modelName);
    modelStats[modelName] = model;
    model.harnessTurns += usage.calls;
    model.promptTokens += usage.promptTokens;
    model.completionTokens += usage.completionTokens;
    model.latencyMs += usage.latencyMs;
  }

  for (const model of Object.values(modelStats)) {
    model.harnessErrors += episode.metrics?.harnessErrorCount ?? 0;
  }
  for (const step of episode.evaluation?.trajectory ?? []) {
    if (!step.profileId) continue;
    const profile = profileStats[step.profileId];
    if (profile) profile.harnessTurns += 1;
  }
  for (const profile of Object.values(profileStats)) {
    profile.harnessErrors += episode.metrics?.harnessErrorCount ?? 0;
  }

  accumulateSocialStepDensity(modelStats, profileStats, episode);
}

export function accumulateSocialStepDensity(
  modelStats: Record<string, TournamentModelStats>,
  profileStats: Record<string, TournamentProfileStats>,
  episode: TournamentEpisode
): void {
  const modelByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent.model]));
  const profileByPlayer = new Map(
    episode.agents
      .filter((agent): agent is typeof agent & { profileId: string } => Boolean(agent.profileId))
      .map((agent) => [agent.playerId, agent.profileId])
  );
  const steps = episode.socialEpisode?.steps ?? [];
  const densityByActor = countSocialStepCommitsByActor(steps);
  for (const [actorId, density] of densityByActor) {
    const modelName = modelByPlayer.get(actorId);
    if (!modelName) continue;
    const model = modelStats[modelName] ??= createEmptyStats(modelName);
    model.nativeSteps += density.nativeSteps;
    model.committedSteps += density.committedSteps;
    model.rejectedSteps += density.rejectedSteps;
  }
  for (const step of steps) {
    if (step.actorId === "system") continue;
    const profileId = step.profileId || profileByPlayer.get(step.actorId);
    if (!profileId) continue;
    const profile =
      profileStats[profileId] ??=
        createEmptyProfileStats({
          id: profileId,
          model: modelByPlayer.get(step.actorId) ?? "unknown"
        });
    profile.nativeSteps += 1;
    if (isSocialStepCommitted(step)) profile.committedSteps += 1;
    else profile.rejectedSteps += 1;
  }
}

export function accumulateAgentStats(stats: TournamentModelStats, agent: TournamentEpisode["agents"][number]): void {
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
  stats.rewardTotal += agent.reward ?? 0;
  stats.averageReward = round3(stats.rewardTotal / Math.max(1, stats.seatGames));
}

export function initializeModelStats(models: string[]): Record<string, TournamentModelStats> {
  return Object.fromEntries(models.map((model) => [model, createEmptyStats(model)]));
}

export function initializeProfileStats(profiles: HarnessAgentProfile[]): Record<string, TournamentProfileStats> {
  return Object.fromEntries(profiles.map((profile) => [profile.id, createEmptyProfileStats(profile)]));
}

export function createEmptyStats(model: string): TournamentModelStats {
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

export function createEmptyProfileStats(profile: Pick<HarnessAgentProfile, "id" | "model" | "policyName">): TournamentProfileStats {
  return {
    ...createEmptyStats(profile.model),
    profileId: profile.id,
    policyName: profile.policyName
  };
}

export function emptyRoleRecord(): Record<Role, number> {
  return {
    villager: 0,
    werewolf: 0,
    seer: 0,
    witch: 0,
    hunter: 0
  };
}

export function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
