import { describe, expect, it } from "vitest";
import {
  averageTeamRewards,
  summarizeModelRewardsWithDensity,
  summarizeProfileRewardsWithDensity
} from "../src/harness/tournamentEvaluationSummary";
import type { AdversarialEvaluation } from "../src/harness/types";

function evaluationFixture(overrides: Partial<AdversarialEvaluation> = {}): AdversarialEvaluation {
  return {
    winner: "village",
    teamRewards: { village: 1, werewolves: -1 },
    agentRewards: [
      {
        playerId: "p1",
        profileId: "wolf-profile",
        model: "model-a",
        role: "werewolf",
        team: "werewolves",
        won: false,
        reward: -1,
        components: {
          win: -1,
          voteAccuracy: 0,
          survival: 0,
          influence: 0,
          deception: 0,
          illegalActionPenalty: 0
        }
      },
      {
        playerId: "p2",
        profileId: "village-profile",
        model: "model-b",
        role: "villager",
        team: "village",
        won: true,
        reward: 1,
        components: {
          win: 1,
          voteAccuracy: 0,
          survival: 0,
          influence: 0,
          deception: 0,
          illegalActionPenalty: 0
        }
      }
    ],
    trajectory: [],
    voteAccuracyByAgent: {},
    influenceByAgent: {},
    deceptionByAgent: {},
    ...overrides
  };
}

describe("tournamentEvaluationSummary density helpers", () => {
  it("aggregates model rewards with actor-scoped commit density", () => {
    const summary = summarizeModelRewardsWithDensity([
      {
        episode: {
          agents: [
            { playerId: "p1", profileId: "wolf-profile", model: "model-a" },
            { playerId: "p2", profileId: "village-profile", model: "model-b" }
          ],
          socialEpisode: {
            steps: [
              { actorId: "system", commitStatus: "committed" },
              { actorId: "p1", commitStatus: "committed" },
              { actorId: "p1", commitStatus: "rejected", error: "illegal" },
              { actorId: "p2", commitStatus: "committed" }
            ]
          }
        },
        evaluation: evaluationFixture()
      }
    ]);

    expect(summary["model-a"]).toEqual({
      agentGames: 1,
      wins: 0,
      winRate: 0,
      averageReward: -1,
      nativeSteps: 2,
      committedSteps: 1,
      rejectedSteps: 1
    });
    expect(summary["model-b"]).toEqual({
      agentGames: 1,
      wins: 1,
      winRate: 1,
      averageReward: 1,
      nativeSteps: 1,
      committedSteps: 1,
      rejectedSteps: 0
    });
  });

  it("aggregates profile rewards with actor-scoped commit density", () => {
    const summary = summarizeProfileRewardsWithDensity([
      {
        episode: {
          agents: [
            { playerId: "p1", profileId: "wolf-profile", model: "model-a" },
            { playerId: "p2", profileId: "village-profile", model: "model-b" }
          ],
          socialEpisode: {
            steps: [
              { actorId: "p1", commitStatus: "committed" },
              { actorId: "p2", commitStatus: "rejected", error: "illegal" },
              { actorId: "p2" }
            ]
          }
        },
        evaluation: evaluationFixture()
      }
    ]);

    expect(summary["wolf-profile"]).toEqual({
      profileId: "wolf-profile",
      model: "model-a",
      agentGames: 1,
      wins: 0,
      winRate: 0,
      averageReward: -1,
      nativeSteps: 1,
      committedSteps: 1,
      rejectedSteps: 0
    });
    expect(summary["village-profile"]).toEqual({
      profileId: "village-profile",
      model: "model-b",
      agentGames: 1,
      wins: 1,
      winRate: 1,
      averageReward: 1,
      nativeSteps: 2,
      committedSteps: 1,
      rejectedSteps: 1
    });
  });

  it("ignores rewards without profileId for profileRewards and averages team rewards", () => {
    const evaluation = evaluationFixture({
      agentRewards: [
        {
          playerId: "p3",
          model: "model-c",
          role: "villager",
          team: "village",
          won: true,
          reward: 0.5,
          components: {
            win: 0.5,
            voteAccuracy: 0,
            survival: 0,
            influence: 0,
            deception: 0,
            illegalActionPenalty: 0
          }
        }
      ]
    });
    const profileSummary = summarizeProfileRewardsWithDensity([
      {
        episode: {
          agents: [{ playerId: "p3", model: "model-c" }],
          socialEpisode: { steps: [{ actorId: "p3", commitStatus: "committed" }] }
        },
        evaluation
      }
    ]);
    expect(profileSummary).toEqual({});
    expect(averageTeamRewards([evaluationFixture(), evaluationFixture({ teamRewards: { village: 0, werewolves: 0 } })])).toEqual({
      village: 0.5,
      werewolves: -0.5
    });
  });
});
