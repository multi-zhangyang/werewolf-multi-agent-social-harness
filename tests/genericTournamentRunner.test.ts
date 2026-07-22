import { describe, expect, it } from "vitest";
import { runTournamentEpisodes, type TournamentEpisodeLifecycle } from "../src/harness/tournamentRunner";

describe("generic tournament control plane", () => {
  it("preserves completed, truncated, and failed lifecycle records without a domain dependency", async () => {
    const preparedSeeds: string[] = [];
    const result = await runTournamentEpisodes({
      games: 3,
      seed: "ledger-experiment",
      continueOnError: true,
      prepareEpisode: ({ index, seed }) => {
        preparedSeeds.push(seed);
        return { index };
      },
      runEpisode: (prepared): { status: TournamentEpisodeLifecycle } => ({
        status: prepared.index === 0 ? "completed" : prepared.index === 1 ? "truncated" : "failed"
      }),
      statusOf: (episode) => episode.status
    });

    expect(preparedSeeds).toEqual(["ledger-experiment:g1", "ledger-experiment:g2", "ledger-experiment:g3"]);
    expect(result).toMatchObject({
      gamesRequested: 3,
      gamesCompleted: 1,
      gamesTruncated: 1,
      gamesFailed: 1
    });
    expect(result.episodes.map((episode) => episode.status)).toEqual(["completed", "truncated", "failed"]);
  });

  it("continues after a bounded episode but stops after a failed one by default", async () => {
    const result = await runTournamentEpisodes({
      games: 4,
      seed: "lifecycle-stop",
      prepareEpisode: ({ index }) => index,
      runEpisode: (index): { status: TournamentEpisodeLifecycle } => ({
        status: index === 0 ? "truncated" : index === 1 ? "failed" : "completed"
      }),
      statusOf: (episode) => episode.status
    });

    expect(result.episodes.map((episode) => episode.index)).toEqual([0, 1]);
    expect(result.episodes.map((episode) => episode.status)).toEqual(["truncated", "failed"]);
    expect(result).toMatchObject({ gamesCompleted: 0, gamesTruncated: 1, gamesFailed: 1, gamesUnstarted: 2 });
  });

  it("does not schedule unstarted episodes after a shared control-plane abort", async () => {
    const controller = new AbortController();
    const prepared: number[] = [];
    const result = await runTournamentEpisodes({
      games: 3,
      seed: "abort-control",
      continueOnError: true,
      abortSignal: controller.signal,
      prepareEpisode: ({ index }) => {
        prepared.push(index);
        return index;
      },
      runEpisode: (index): { status: TournamentEpisodeLifecycle } => {
        controller.abort();
        return { status: index === 0 ? "failed" : "completed" };
      },
      statusOf: (episode) => episode.status
    });

    expect(prepared).toEqual([0]);
    expect(result.episodes).toMatchObject([{ index: 0, status: "failed" }]);
    expect(result).toMatchObject({ gamesRequested: 3, gamesCompleted: 0, gamesTruncated: 0, gamesFailed: 1, gamesUnstarted: 2 });
  });

  it("does not start an asynchronously prepared episode after the shared control plane aborts", async () => {
    const controller = new AbortController();
    const prepared: number[] = [];
    const started: number[] = [];
    const result = await runTournamentEpisodes({
      games: 2,
      seed: "abort-during-prepare",
      abortSignal: controller.signal,
      prepareEpisode: async ({ index }) => {
        prepared.push(index);
        controller.abort();
        return index;
      },
      runEpisode: (index): { status: TournamentEpisodeLifecycle } => {
        started.push(index);
        return { status: "completed" };
      },
      statusOf: (episode) => episode.status
    });

    expect(prepared).toEqual([0]);
    expect(started).toEqual([]);
    expect(result).toMatchObject({
      gamesRequested: 2,
      gamesCompleted: 0,
      gamesTruncated: 0,
      gamesFailed: 0,
      gamesUnstarted: 2,
      episodes: []
    });
  });

  it("awaits terminal progress hooks before scheduling the next episode and treats hook failure as fatal", async () => {
    const lifecycle: string[] = [];
    await expect(
      runTournamentEpisodes({
        games: 2,
        seed: "durable-progress",
        continueOnError: true,
        prepareEpisode: ({ index }) => {
          lifecycle.push(`prepare:${index}`);
          return index;
        },
        runEpisode: (index): { status: TournamentEpisodeLifecycle } => ({ status: index === 0 ? "completed" : "failed" }),
        statusOf: (episode) => episode.status,
        async onEpisodeSettled(episode) {
          lifecycle.push(`settle:${episode.index}:${episode.status}`);
          if (episode.index === 1) throw new Error("durable progress unavailable");
        }
      })
    ).rejects.toThrow(/durable progress unavailable/i);
    expect(lifecycle).toEqual([
      "prepare:0",
      "settle:0:completed",
      "prepare:1",
      "settle:1:failed"
    ]);
  });
});
