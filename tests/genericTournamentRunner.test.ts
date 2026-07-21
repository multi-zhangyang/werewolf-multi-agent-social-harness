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
    expect(result).toMatchObject({ gamesCompleted: 0, gamesTruncated: 1, gamesFailed: 1 });
  });
});
