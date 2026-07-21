import { countSocialStepCommitsByActor } from "./social";
import type { AdversarialEvaluation } from "./types";

export interface TournamentEvaluationEpisodeLike {
  agents: Array<{
    playerId: string;
    profileId?: string;
    model: string;
  }>;
  socialEpisode?: {
    steps?: ReadonlyArray<{
      actorId: string;
      commitStatus?: "committed" | "rejected";
      error?: string;
    }>;
  };
}

export interface TournamentEvaluatedEpisodePair {
  episode: TournamentEvaluationEpisodeLike;
  evaluation: AdversarialEvaluation;
}

export interface ModelRewardDensitySummary {
  agentGames: number;
  wins: number;
  winRate: number;
  averageReward: number;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
}

export interface ProfileRewardDensitySummary extends ModelRewardDensitySummary {
  profileId: string;
  model: string;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Aggregate model rewards and actor-scoped commit density from evaluated episodes.
 * Density is pure projection over social steps; system actors are excluded.
 */
export function summarizeModelRewardsWithDensity(
  evaluated: ReadonlyArray<TournamentEvaluatedEpisodePair>
): Record<string, ModelRewardDensitySummary> {
  const byModel = new Map<
    string,
    {
      agentGames: number;
      wins: number;
      reward: number;
      nativeSteps: number;
      committedSteps: number;
      rejectedSteps: number;
    }
  >();
  for (const { episode, evaluation } of evaluated) {
    for (const reward of evaluation.agentRewards) {
      const stats = byModel.get(reward.model) ?? {
        agentGames: 0,
        wins: 0,
        reward: 0,
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      };
      stats.agentGames += 1;
      if (reward.won) stats.wins += 1;
      stats.reward += reward.reward;
      byModel.set(reward.model, stats);
    }
    const modelByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent.model]));
    const densityByActor = countSocialStepCommitsByActor(episode.socialEpisode?.steps ?? []);
    for (const [actorId, density] of densityByActor) {
      const modelName = modelByPlayer.get(actorId);
      if (!modelName) continue;
      const stats = byModel.get(modelName) ?? {
        agentGames: 0,
        wins: 0,
        reward: 0,
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      };
      stats.nativeSteps += density.nativeSteps;
      stats.committedSteps += density.committedSteps;
      stats.rejectedSteps += density.rejectedSteps;
      byModel.set(modelName, stats);
    }
  }
  return Object.fromEntries(
    [...byModel.entries()].map(([model, stats]) => [
      model,
      {
        agentGames: stats.agentGames,
        wins: stats.wins,
        winRate: stats.agentGames ? round3(stats.wins / stats.agentGames) : 0,
        averageReward: stats.agentGames ? round3(stats.reward / stats.agentGames) : 0,
        nativeSteps: stats.nativeSteps,
        committedSteps: stats.committedSteps,
        rejectedSteps: stats.rejectedSteps
      }
    ])
  );
}

/**
 * Aggregate profile rewards and actor-scoped commit density from evaluated episodes.
 * Intended for research/CLI exports. Public server summaries must omit this object
 * because it carries raw profile ids.
 */
export function summarizeProfileRewardsWithDensity(
  evaluated: ReadonlyArray<TournamentEvaluatedEpisodePair>
): Record<string, ProfileRewardDensitySummary> {
  const byProfile = new Map<
    string,
    {
      agentGames: number;
      wins: number;
      reward: number;
      model: string;
      nativeSteps: number;
      committedSteps: number;
      rejectedSteps: number;
    }
  >();
  for (const { episode, evaluation } of evaluated) {
    for (const reward of evaluation.agentRewards) {
      if (!reward.profileId) continue;
      const stats = byProfile.get(reward.profileId) ?? {
        agentGames: 0,
        wins: 0,
        reward: 0,
        model: reward.model,
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      };
      stats.agentGames += 1;
      if (reward.won) stats.wins += 1;
      stats.reward += reward.reward;
      stats.model = reward.model;
      byProfile.set(reward.profileId, stats);
    }
    const profileByPlayer = new Map(
      episode.agents
        .filter((agent): agent is typeof agent & { profileId: string } => Boolean(agent.profileId))
        .map((agent) => [agent.playerId, agent.profileId])
    );
    const modelByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent.model]));
    const densityByActor = countSocialStepCommitsByActor(episode.socialEpisode?.steps ?? []);
    for (const [actorId, density] of densityByActor) {
      const profileId = profileByPlayer.get(actorId);
      if (!profileId) continue;
      const stats = byProfile.get(profileId) ?? {
        agentGames: 0,
        wins: 0,
        reward: 0,
        model: modelByPlayer.get(actorId) ?? "unknown",
        nativeSteps: 0,
        committedSteps: 0,
        rejectedSteps: 0
      };
      stats.nativeSteps += density.nativeSteps;
      stats.committedSteps += density.committedSteps;
      stats.rejectedSteps += density.rejectedSteps;
      byProfile.set(profileId, stats);
    }
  }
  return Object.fromEntries(
    [...byProfile.entries()].map(([profileId, stats]) => [
      profileId,
      {
        profileId,
        model: stats.model,
        agentGames: stats.agentGames,
        wins: stats.wins,
        winRate: stats.agentGames ? round3(stats.wins / stats.agentGames) : 0,
        averageReward: stats.agentGames ? round3(stats.reward / stats.agentGames) : 0,
        nativeSteps: stats.nativeSteps,
        committedSteps: stats.committedSteps,
        rejectedSteps: stats.rejectedSteps
      }
    ])
  );
}

export function averageTeamRewards(
  evaluations: ReadonlyArray<AdversarialEvaluation>
): AdversarialEvaluation["teamRewards"] | null {
  if (!evaluations.length) return null;
  return {
    village: round3(evaluations.reduce((sum, evaluation) => sum + evaluation.teamRewards.village, 0) / evaluations.length),
    werewolves: round3(evaluations.reduce((sum, evaluation) => sum + evaluation.teamRewards.werewolves, 0) / evaluations.length)
  };
}
