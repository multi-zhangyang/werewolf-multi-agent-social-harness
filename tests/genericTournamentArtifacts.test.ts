import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGenericTournamentRunSetArtifact,
  validateGenericTournamentRunSetArtifact,
  writeGenericTournamentRunSetArtifact
} from "../src/harness/genericTournamentArtifacts";
import type { GenericTournamentResult } from "../src/harness/tournamentRunner";

interface PreparedLedgerEpisode {
  privateRuntimeSecret: string;
}

interface LedgerEpisodeResult {
  runId: string;
  entries: string[];
}

describe("generic tournament research artifacts", () => {
  it("persists ordered lifecycle evidence and canonical domain artifacts without serializing preparation runtime state", async () => {
    const result: GenericTournamentResult<PreparedLedgerEpisode, LedgerEpisodeResult> = {
      seed: "ledger-tournament-seed",
      gamesRequested: 3,
      gamesCompleted: 1,
      gamesTruncated: 1,
      gamesFailed: 1,
      episodes: [
        {
          index: 0,
          seed: "ledger-tournament-seed:g1",
          status: "completed",
          prepared: { privateRuntimeSecret: "must-not-persist" },
          result: { runId: "ledger-complete", entries: ["a:open", "b:close"] }
        },
        {
          index: 1,
          seed: "ledger-tournament-seed:g2",
          status: "truncated",
          prepared: { privateRuntimeSecret: "must-not-persist" },
          result: { runId: "ledger-truncated", entries: ["a:open"] }
        },
        {
          index: 2,
          seed: "ledger-tournament-seed:g3",
          status: "failed",
          prepared: { privateRuntimeSecret: "must-not-persist" },
          error: "ledger provider unavailable"
        }
      ]
    };
    const artifact = await buildGenericTournamentRunSetArtifact({
      runSetId: "ledger-run-set-01",
      createdAt: "2026-07-21T02:00:00.000Z",
      result,
      adapter: {
        domainId: "ledger",
        artifactForEpisode(episode) {
          return { artifactVersion: "ledger.episode.v1", runId: episode.runId, entries: episode.entries };
        },
        validateArtifact(episode) {
          return episode.entries.length || episode.runId === "ledger-truncated" ? [] : ["ledger artifact must have entries"];
        },
        runIdOf(episode) {
          return episode.runId;
        }
      }
    });

    expect(artifact).toMatchObject({
      domainId: "ledger",
      gamesCompleted: 1,
      gamesTruncated: 1,
      gamesFailed: 1,
      episodes: [
        { index: 0, status: "completed", runId: "ledger-complete" },
        { index: 1, status: "truncated", runId: "ledger-truncated" },
        { index: 2, status: "failed", error: "ledger provider unavailable" }
      ]
    });
    expect(validateGenericTournamentRunSetArtifact(artifact)).toEqual([]);
    expect(JSON.stringify(artifact)).not.toContain("must-not-persist");

    const temporaryBase = await mkdtemp(join(tmpdir(), "harness-generic-tournament-"));
    try {
      const output = await writeGenericTournamentRunSetArtifact({
        directory: join(temporaryBase, "ledger-run-set-01"),
        artifact
      });
      expect((await readdir(output.directory)).sort()).toEqual(["episodes", "episodes.jsonl", "manifest.json", "metrics.jsonl"]);
      expect((await readdir(join(output.directory, "episodes"))).sort()).toEqual(["0.json", "1.json"]);
      const manifest = JSON.parse(await readFile(output.manifestPath, "utf8")) as { episodes: Array<Record<string, unknown>>; files: string[] };
      expect(manifest.episodes).toEqual([
        expect.objectContaining({ index: 0, artifactFile: "episodes/0.json" }),
        expect.objectContaining({ index: 1, artifactFile: "episodes/1.json" }),
        expect.objectContaining({ index: 2, artifactFile: null, error: "ledger provider unavailable" })
      ]);
      expect(manifest.files).toEqual(["manifest.json", "episodes.jsonl", "metrics.jsonl", "episodes/0.json", "episodes/1.json"]);
      expect(await readFile(output.episodesJsonlPath, "utf8")).not.toContain("must-not-persist");
      expect(await readFile(output.metricsJsonlPath, "utf8")).toBe("");
    } finally {
      await rm(temporaryBase, { recursive: true, force: true });
    }
  });

  it("rejects invalid lifecycle accounting and invalid canonical domain artifacts", async () => {
    const invalid = {
      artifactVersion: "harness.tournament-run-set.v1" as const,
      kind: "tournament-run-set" as const,
      domainId: "ledger",
      runSetId: "bad",
      createdAt: "2026-07-21T02:00:00.000Z",
      seed: "seed",
      gamesRequested: 1,
      gamesCompleted: 1,
      gamesTruncated: 0,
      gamesFailed: 0,
      episodes: [{ index: 0, seed: "seed:g1", status: "failed" as const }]
    };
    expect(validateGenericTournamentRunSetArtifact(invalid).join(" ")).toMatch(/gamesCompleted mismatch/);

    await expect(
      buildGenericTournamentRunSetArtifact({
        runSetId: "invalid-domain-artifact",
        result: {
          seed: "seed",
          gamesRequested: 1,
          gamesCompleted: 1,
          gamesTruncated: 0,
          gamesFailed: 0,
          episodes: [{ index: 0, seed: "seed:g1", status: "completed" as const, result: { runId: "r", entries: [] } }]
        },
        adapter: {
          domainId: "ledger",
          artifactForEpisode: (episode) => episode,
          validateArtifact: () => ["deliberate domain integrity failure"]
        }
      })
    ).rejects.toThrow(/deliberate domain integrity failure/);
  });
});
