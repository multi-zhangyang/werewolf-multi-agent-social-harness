import { describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import {
  assertAssignmentProfileReferences,
  assignmentFromUnknown,
  describeResolvedAssignments,
  resolveAgentConfigs,
  type HarnessAssignmentConfig
} from "../src/harness/profiles";
import { runTournament } from "../src/harness/tournament";
import type { HarnessAgentProfile, HarnessReasoner } from "../src/harness/types";

const profiles: HarnessAgentProfile[] = [
  { id: "wolf", model: "wolf-model", temperature: 0.9, policyName: "wolf-deceiver" },
  { id: "village", model: "village-model", policyName: "village-analyst" },
  { id: "seer", model: "seer-model", temperature: 0.2, policyName: "seer-information" }
];

describe("agent profile assignment resolver", () => {
  it("is deterministic, seat ordered, metadata preserving, and input immutable", () => {
    const state = createGame({ id: "resolver-deterministic", seed: "resolver-deterministic" });
    const shuffledPlayers = [state.players[4], state.players[0], state.players[8], ...state.players.slice(1, 4), ...state.players.slice(5, 8)];
    const playersBefore = JSON.stringify(shuffledPlayers);
    const profilesBefore = JSON.stringify(profiles);
    const assignment: HarnessAssignmentConfig = {
      strategy: "seat",
      seats: {
        "1": "wolf",
        "2": "village",
        "3": "seer"
      },
      fallback: "profile-rotation"
    };

    const first = resolveAgentConfigs(shuffledPlayers, profiles, 2, 0.7, assignment);
    const second = resolveAgentConfigs(shuffledPlayers, profiles, 2, 0.7, assignment);
    const resolved = describeResolvedAssignments(state.players, first);

    expect(first).toEqual(second);
    expect(JSON.stringify(shuffledPlayers)).toBe(playersBefore);
    expect(JSON.stringify(profiles)).toBe(profilesBefore);
    expect(first.map((agent) => agent.playerId)).toEqual(state.players.map((player) => player.id));
    expect(new Set(first.map((agent) => agent.playerId)).size).toBe(state.players.length);
    expect(resolved.slice(0, 3).map((agent) => agent.profileId)).toEqual(["wolf", "village", "seer"]);
    expect(first[0]).toMatchObject({
      playerId: "p1",
      profileId: "wolf",
      model: "wolf-model",
      temperature: 0.9,
      policyName: "wolf-deceiver"
    });
    expect(first[1]).toMatchObject({
      profileId: "village",
      model: "village-model",
      temperature: 0.7,
      policyName: "village-analyst"
    });
  });

  it("assigns by role and team, and rejects unresolved mappings when fallback is error", () => {
    const state = createGame({ id: "resolver-role-team", seed: "resolver-role-team" });
    const roleAgents = resolveAgentConfigs(state.players, profiles, 0, 0.7, {
      strategy: "role",
      roles: {
        werewolf: "wolf",
        seer: "seer",
        villager: "village",
        witch: "village",
        hunter: "village"
      },
      fallback: "error"
    });
    const roleResolved = describeResolvedAssignments(state.players, roleAgents);
    expect(roleResolved.filter((agent) => agent.role === "werewolf").every((agent) => agent.profileId === "wolf")).toBe(true);
    expect(roleResolved.find((agent) => agent.role === "seer")?.profileId).toBe("seer");
    expect(roleResolved.filter((agent) => agent.team === "village" && agent.role !== "seer").every((agent) => agent.profileId === "village")).toBe(
      true
    );

    const teamAgents = resolveAgentConfigs(state.players, profiles, 0, 0.7, {
      strategy: "team",
      teams: {
        werewolves: "wolf",
        village: ["village", "seer"]
      },
      fallback: "error"
    });
    const teamResolved = describeResolvedAssignments(state.players, teamAgents);
    expect(teamResolved.filter((agent) => agent.team === "werewolves").every((agent) => agent.profileId === "wolf")).toBe(true);
    expect(new Set(teamResolved.filter((agent) => agent.team === "village").map((agent) => agent.profileId))).toEqual(
      new Set(["village", "seer"])
    );

    expect(() =>
      resolveAgentConfigs(state.players, profiles, 0, 0.7, {
        strategy: "role",
        roles: { werewolf: "wolf" },
        fallback: "error"
      })
    ).toThrow(/No Agent profile assignment/);
  });

  it("normalizes assignment input and rejects unknown role or profile references", () => {
    expect(
      assignmentFromUnknown('{"strategy":"team","teams":{"werewolves":["wolf"],"village":"village"},"fallback":"error"}')
    ).toEqual({
      strategy: "team",
      teams: { werewolves: ["wolf"], village: "village" },
      fallback: "error"
    });
    expect(() => assignmentFromUnknown('{"strategy":"role","roles":{"sorcerer":"wolf"}}')).toThrow(/not supported/);

    const state = createGame({ id: "resolver-errors", seed: "resolver-errors" });
    expect(() =>
      resolveAgentConfigs(state.players, profiles, 0, 0.7, {
        strategy: "seat",
        seats: { "1": "missing-profile" }
      })
    ).toThrow(/unknown profile/);
    expect(() =>
      resolveAgentConfigs(
        [
          { id: "p1", seat: 1 },
          { id: "p1", seat: 2 }
        ],
        profiles,
        0,
        0.7
      )
    ).toThrow(/Duplicate player id/);
  });

  it("rejects unknown assignment profile references even before a mapping is selected", () => {
    const assignment: HarnessAssignmentConfig = {
      strategy: "seat",
      seats: {
        "99": "missing-unused-profile"
      },
      fallback: "profile-rotation"
    };

    expect(() => assertAssignmentProfileReferences(assignment, profiles)).toThrow(/missing-unused-profile/);
  });
});

describe("tournament profile assignment integration", () => {
  it("propagates assignment, resolved profile metadata, profile stats, and evaluation rewards", async () => {
    const reasoner: HarnessReasoner = {
      async think(input) {
        const content =
          input.action.kind === "speech"
            ? "我按公开信息发言，优先比较夜晚死亡、发言压力和票型关系，今天先统一视角减少分票。"
            : `assignment-test:${input.agent.profileId}:${input.action.kind}:${input.policyPlan.policyName}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `assignment-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };

    const assignment: HarnessAssignmentConfig = {
      strategy: "team",
      teams: {
        werewolves: "wolf",
        village: "village"
      },
      fallback: "error"
    };
    const result = await runTournament({
      models: [],
      profiles,
      games: 2,
      seed: "assignment-tournament",
      assignment,
      reasoner,
      maxTransitions: 3
    });

    expect(result.assignment).toEqual(assignment);
    expect(result.profileStats.wolf.profileId).toBe("wolf");
    expect(result.profileStats.village.profileId).toBe("village");
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes.every((episode) => episode.resolvedAssignments.length === 9)).toBe(true);
    for (const episode of result.episodes) {
      expect(episode.assignment).toEqual(assignment);
      expect(episode.agents.filter((agent) => agent.team === "werewolves").every((agent) => agent.profileId === "wolf")).toBe(true);
      expect(episode.agents.filter((agent) => agent.team === "village").every((agent) => agent.profileId === "village")).toBe(true);
      expect(episode.evaluation?.agentRewards.every((reward) => Boolean(reward.profileId))).toBe(true);
    }
  });
});
