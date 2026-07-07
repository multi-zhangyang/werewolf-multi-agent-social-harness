import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function runTsxJson<T>(source: string): Promise<T> {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--eval", source], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024
  });
  const output = stdout.trim();
  if (!output) throw new Error("tsx script produced no JSON output.");
  return JSON.parse(output) as T;
}

describe("role-balanced tournament harness", () => {
  it("rotates model seat assignments across episodes", async () => {
    const result = await runTsxJson<{ first: string[]; second: string[] }>(`
      import { createGame } from "./src/core/engine.ts";
      import { buildRoleBalancedAgents } from "./src/harness/tournament.ts";

      const state = createGame({ id: "schedule", seed: "schedule" });
      const first = buildRoleBalancedAgents(state.players, ["alpha", "beta", "gamma"], 0, 0.7);
      const second = buildRoleBalancedAgents(state.players, ["alpha", "beta", "gamma"], 1, 0.7);
      console.log(JSON.stringify({
        first: first.slice(0, 4).map((agent) => agent.model),
        second: second.slice(0, 4).map((agent) => agent.model)
      }));
    `);

    expect(result.first).toEqual(["alpha", "beta", "gamma", "alpha"]);
    expect(result.second).toEqual(["beta", "gamma", "alpha", "beta"]);
  });

  it("aggregates completed episode exposure, roles, model usage, harness turns, and rewards", async () => {
    const result = await runTsxJson<{
      gamesRequested: number;
      gamesCompleted: number;
      gamesFailed: number;
      episodeCount: number;
      episodeAgentCounts: number[];
      episodesHaveEvaluation: boolean;
      alpha: {
        seatGames: number;
        harnessTurns: number;
        promptTokens: number;
        completionTokens: number;
        roleGames: Record<string, number>;
        rewardTotal: number;
        averageReward: number;
      };
      beta: {
        seatGames: number;
        harnessTurns: number;
        promptTokens: number;
        completionTokens: number;
        roleGames: Record<string, number>;
        rewardTotal: number;
        averageReward: number;
      };
    }>(`
      import { runTournament } from "./src/harness/tournament.ts";

      const tournamentStubReasoner = {
        async think(input) {
          const content =
            input.action.kind === "speech"
              ? "我按公开信息发言，先看夜晚结果和票型关系，今天优先统一视角，不急着扩大身份对跳。"
              : "锦标赛备忘：" + input.agent.model + "/" + input.action.kind + "/" + input.policyPlan.policyName;
          return {
            content,
            completion: {
              content,
              latencyMs: 3,
              usage: {
                promptTokens: 5,
                completionTokens: 9,
                totalTokens: 14
              },
              providerRequestId: "tournament-stub-" + input.traceId,
              attempts: 1
            }
          };
        }
      };

      const result = await runTournament({
        models: ["alpha", "beta"],
        games: 2,
        seed: "tournament-test",
        reasoner: tournamentStubReasoner,
        maxTransitions: 3
      });
      console.log(JSON.stringify({
        gamesRequested: result.gamesRequested,
        gamesCompleted: result.gamesCompleted,
        gamesFailed: result.gamesFailed,
        episodeCount: result.episodes.length,
        episodeAgentCounts: result.episodes.map((episode) => episode.agents.length),
        episodesHaveEvaluation: result.episodes.every((episode) => Boolean(episode.evaluation)),
        alpha: result.modelStats.alpha,
        beta: result.modelStats.beta
      }));
    `);

    expect(result.gamesRequested).toBe(2);
    expect(result.gamesCompleted).toBe(2);
    expect(result.gamesFailed).toBe(0);
    expect(result.episodeCount).toBe(2);
    expect(result.episodeAgentCounts.every((count) => count === 9)).toBe(true);
    expect(result.episodesHaveEvaluation).toBe(true);

    const alpha = result.alpha;
    const beta = result.beta;
    expect(alpha.seatGames).toBe(9);
    expect(beta.seatGames).toBe(9);
    expect(alpha.harnessTurns + beta.harnessTurns).toBe(6);
    expect(alpha.promptTokens + beta.promptTokens).toBe(30);
    expect(alpha.completionTokens + beta.completionTokens).toBe(54);
    expect(Object.values(alpha.roleGames).reduce((sum, value) => sum + value, 0)).toBe(alpha.seatGames);
    expect(Object.values(beta.roleGames).reduce((sum, value) => sum + value, 0)).toBe(beta.seatGames);
    expect(alpha.rewardTotal + beta.rewardTotal).toBeLessThan(0);
    expect(alpha.averageReward).toBeCloseTo(alpha.rewardTotal / alpha.seatGames, 3);
    expect(beta.averageReward).toBeCloseTo(beta.rewardTotal / beta.seatGames, 3);
  });

  it("counts returned failed harness results without aggregating them as completed exposure", async () => {
    const result = await runTsxJson<{
      gamesRequested: number;
      gamesCompleted: number;
      gamesFailed: number;
      episodeCount: number;
      firstStatus: string;
      firstHarnessStatus?: string;
      firstError?: string;
      firstMetricErrors?: number;
      firstSocialStatus?: string;
      alphaSeatGames: number;
      betaSeatGames: number;
    }>(`
      import { runTournament } from "./src/harness/tournament.ts";

      const failingReasoner = {
        async think(input) {
          throw new Error("tournament planned reasoner failure:" + input.action.kind);
        }
      };

      const result = await runTournament({
        models: ["alpha", "beta"],
        games: 2,
        seed: "tournament-failed-return",
        reasoner: failingReasoner,
        maxTransitions: 4,
        continueOnError: true
      });
      console.log(JSON.stringify({
        gamesRequested: result.gamesRequested,
        gamesCompleted: result.gamesCompleted,
        gamesFailed: result.gamesFailed,
        episodeCount: result.episodes.length,
        firstStatus: result.episodes[0]?.status,
        firstHarnessStatus: result.episodes[0]?.harnessStatus,
        firstError: result.episodes[0]?.error,
        firstMetricErrors: result.episodes[0]?.metrics?.harnessErrorCount,
        firstSocialStatus: result.episodes[0]?.socialEpisode?.status,
        alphaSeatGames: result.modelStats.alpha.seatGames,
        betaSeatGames: result.modelStats.beta.seatGames
      }));
    `);

    expect(result.gamesRequested).toBe(2);
    expect(result.gamesCompleted).toBe(0);
    expect(result.gamesFailed).toBe(2);
    expect(result.episodeCount).toBe(2);
    expect(result.firstStatus).toBe("failed");
    expect(result.firstHarnessStatus).toBe("failed");
    expect(result.firstError).toContain("tournament planned reasoner failure");
    expect(result.firstMetricErrors).toBe(1);
    expect(result.firstSocialStatus).toBe("failed");
    expect(result.alphaSeatGames).toBe(0);
    expect(result.betaSeatGames).toBe(0);
  });
});
