import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MATRIX_ARTIFACT_VERSION,
  MATRIX_EXPERIMENT_VERSION,
  buildExperimentMatrixStatistics,
  type ExperimentMatrixCellResult,
  normalizeMatrixExperimentSpec,
  runExperimentMatrix,
  writeExperimentMatrixArtifactDirectory
} from "../src/harness/experimentMatrix";
import type { HarnessReasoner } from "../src/harness/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const deterministicReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? `矩阵测试发言 ${input.agent.model} ${input.traceId}`
        : `matrix test memo ${input.agent.model}/${input.action.kind}/${input.policyPlan.policyName}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        providerRequestId: `matrix-test-${input.traceId}`,
        attempts: 1
      }
    };
  }
};

describe("experiment matrix harness", () => {
  it("routes configured matrix cells through stable V2 tournament authority on restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "werewolf-matrix-v2-"));
    tempDirs.push(root);
    const experiment = normalizeMatrixExperimentSpec({
      version: MATRIX_EXPERIMENT_VERSION,
      id: "matrix-v2-restart",
      kind: "matrix",
      base: {
        profiles: [{ id: "matrix-profile", model: "opaque/matrix-model", temperature: 0.3 }],
        assignment: { strategy: "profile-rotation" },
        games: 1,
        seed: "matrix-v2-restart",
        maxTransitions: 1,
        continueOnError: true
      },
      cells: [{ id: "durable-cell" }]
    });
    const first = await runExperimentMatrix({
      experiment,
      reasoner: deterministicReasoner,
      orchestrationBaseDirectory: root,
      includeArtifacts: true
    });
    expect(first.cells).toHaveLength(1);
    expect(
      first.cells[0]?.tournament?.gamesTruncated,
      JSON.stringify(first.cells.map((cell) => ({
        status: cell.status,
        error: cell.error,
        tournament: cell.tournament && {
          failed: cell.tournament.gamesFailed,
          truncated: cell.tournament.gamesTruncated,
          unstarted: cell.tournament.gamesUnstarted,
          episodes: cell.tournament.episodes.map((episode) => ({ status: episode.status, error: episode.error }))
        }
      })))
    ).toBe(1);
    expect(first.cells[0]?.tournament?.episodes[0]?.artifact?.experiment?.specId).toBe("durable-cell");

    const noRerunReasoner: HarnessReasoner = {
      async think() {
        throw new Error("finalized matrix cell must not rerun model work");
      }
    };
    const restarted = await runExperimentMatrix({
      experiment,
      reasoner: noRerunReasoner,
      orchestrationBaseDirectory: root,
      includeArtifacts: true
    });
    expect(restarted.cells[0]?.tournament?.episodes.map((episode) => episode.runId))
      .toEqual(first.cells[0]?.tournament?.episodes.map((episode) => episode.runId));
    expect(restarted.cells[0]?.elapsedMs).toBe(0);
    expect(restarted.statistics).toEqual(first.statistics);

    const conflicting = structuredClone(experiment);
    conflicting.cells[0]!.tournament.seed = "conflicting-durable-seed";
    await expect(runExperimentMatrix({
      experiment: conflicting,
      reasoner: noRerunReasoner,
      orchestrationBaseDirectory: root,
      includeArtifacts: true
    })).rejects.toThrow(/provenance conflicts with durable authority/i);
  });

  it("does not mark a single-cell matrix completed when its tournament deadline leaves games unstarted", async () => {
    const controller = new AbortController();
    const abortingReasoner: HarnessReasoner = {
      async think(input) {
        controller.abort();
        const content = `abort control ${input.traceId}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            attempts: 1
          }
        };
      }
    };
    const experiment = normalizeMatrixExperimentSpec({
      version: MATRIX_EXPERIMENT_VERSION,
      id: "matrix-inner-tournament-abort",
      kind: "matrix",
      base: {
        models: ["alpha"],
        games: 3,
        seed: "matrix-inner-tournament-abort",
        maxTransitions: 4,
        continueOnError: true
      },
      cells: [{ id: "only-cell" }]
    });

    const result = await runExperimentMatrix({
      experiment,
      reasoner: abortingReasoner,
      executionLimits: { abortSignal: controller.signal }
    });

    expect(result).toMatchObject({
      status: "failed",
      cellsRequested: 1,
      cellsUnstarted: 0,
      cellsFailed: 1,
      gamesRequested: 3,
      gamesFailed: 1,
      gamesUnstarted: 2
    });
    expect(result.cells[0]).toMatchObject({ status: "failed" });
  });

  it("normalizes explicit cells with inherited tournament defaults", () => {
    const matrix = normalizeMatrixExperimentSpec({
      version: MATRIX_EXPERIMENT_VERSION,
      id: "explicit-matrix",
      kind: "matrix",
      base: {
        models: ["alpha", "beta"],
        games: 2,
        seed: "base-seed",
        maxTransitions: 0,
        continueOnError: true
      },
      cells: [
        {
          id: "cell-one",
          label: "Cell One",
          group: "baseline",
          seed: "cell-seed",
          games: 1
        },
        {
          id: "cell-two",
          group: "variant",
          spec: {
            models: ["gamma", "delta"],
            seed: "nested-seed"
          }
        }
      ]
    });

    expect(matrix).toMatchObject({
      version: MATRIX_EXPERIMENT_VERSION,
      id: "explicit-matrix",
      kind: "matrix",
      continueOnError: true
    });
    expect(matrix.cells).toHaveLength(2);
    expect(matrix.cells[0]).toMatchObject({
      id: "cell-one",
      label: "Cell One",
      group: "baseline",
      tournament: {
        id: "cell-one",
        seed: "cell-seed",
        models: ["alpha", "beta"],
        games: 1,
        maxTransitions: 0
      }
    });
    expect(matrix.cells[1]).toMatchObject({
      id: "cell-two",
      label: "cell-two",
      group: "variant",
      tournament: {
        id: "cell-two",
        seed: "nested-seed",
        models: ["gamma", "delta"],
        games: 2,
        maxTransitions: 0
      }
    });
  });

  it("expands dimensions into normalized tournament cells", () => {
    const matrix = normalizeMatrixExperimentSpec({
      version: MATRIX_EXPERIMENT_VERSION,
      id: "dimension-matrix",
      kind: "matrix",
      base: {
        games: 1,
        maxTransitions: 4,
        continueOnError: true
      },
      dimensions: {
        models: [["alpha"], ["beta"]],
        seeds: ["seed-a", "seed-b"],
        games: [1, 2],
        jointPhaseSchedulers: ["aec-batched-decision", "parallel"]
      }
    });

    expect(matrix.cells).toHaveLength(16);
    expect(new Set(matrix.cells.map((cell) => cell.id)).size).toBe(16);
    expect(matrix.cells.map((cell) => cell.tournament.models)).toEqual(
      expect.arrayContaining([["alpha"], ["beta"]])
    );
    expect(matrix.cells.map((cell) => cell.tournament.seed)).toEqual(
      expect.arrayContaining(["seed-a", "seed-b"])
    );
    expect(matrix.cells.map((cell) => cell.tournament.games)).toEqual(expect.arrayContaining([1, 2]));
    expect(matrix.cells.every((cell) => cell.tournament.maxTransitions === 4)).toBe(true);
    expect(matrix.cells.map((cell) => cell.tournament.jointPhaseScheduler)).toEqual(
      expect.arrayContaining(["aec-batched-decision", "parallel"])
    );
  });

  it("preserves explicitly different scheduler conditions for matrix cells", () => {
    const matrix = normalizeMatrixExperimentSpec({
      version: MATRIX_EXPERIMENT_VERSION,
      id: "scheduler-matrix",
      base: { models: ["alpha"], games: 1, maxTransitions: 4 },
      cells: [
        { id: "aec", jointPhaseScheduler: "aec-batched-decision" },
        { id: "parallel", jointPhaseScheduler: "parallel" }
      ]
    });

    expect(matrix.cells.map((cell) => [cell.id, cell.tournament.jointPhaseScheduler])).toEqual([
      ["aec", "aec-batched-decision"],
      ["parallel", "parallel"]
    ]);
  });

  it("runs matrix cells through the tournament harness without inventing outcome rows for truncated games", async () => {
    const matrix = normalizeMatrixExperimentSpec({
      version: MATRIX_EXPERIMENT_VERSION,
      id: "run-matrix",
      kind: "matrix",
      base: {
        games: 1,
        seed: "run-matrix",
        maxTransitions: 0,
        continueOnError: true
      },
      cells: [
        {
          id: "alpha-beta",
          models: ["alpha", "beta"],
          seed: "alpha-beta"
        },
        {
          id: "alpha-gamma",
          models: ["alpha", "gamma"],
          seed: "alpha-gamma"
        }
      ]
    });

    const result = await runExperimentMatrix({
      experiment: matrix,
      reasoner: deterministicReasoner,
      includeArtifacts: true
    });

    expect(result).toMatchObject({
      artifactVersion: MATRIX_ARTIFACT_VERSION,
      kind: "experiment-matrix-result",
      status: "completed",
      cellsRequested: 2,
      cellsCompleted: 0,
      cellsTruncated: 2,
      cellsFailed: 0,
      gamesRequested: 2,
      gamesCompleted: 0,
      gamesTruncated: 2,
      gamesFailed: 0
    });
    expect(result.cells.every((cell) => cell.tournament?.artifacts?.length === 1)).toBe(true);
    expect(result.cells.every((cell) => cell.status === "truncated")).toBe(true);
    expect(result.statistics.status).toMatchObject({ gamesTruncated: 2, completedSeatRows: 0 });
    expect(result.statistics.modelStats).toEqual([]);
    expect(result.statistics.profileStats).toEqual([]);
  });

  it("aggregates outcome statistics and descriptive pairwise significance from recorded seat outcomes", () => {
    const matrix = normalizeMatrixExperimentSpec({
      version: MATRIX_EXPERIMENT_VERSION,
      id: "stats-matrix",
      kind: "matrix",
      base: {
        models: ["alpha", "beta", "gamma"],
        games: 1,
        seed: "stats-matrix",
        maxTransitions: 0,
        continueOnError: true
      },
      cells: [{ id: "stats-cell", models: ["alpha", "beta", "gamma"] }]
    });

    const statistics = buildExperimentMatrixStatistics(matrix, [
      syntheticOutcomeCell("stats-cell-a", [
        { model: "alpha", profileId: "alpha-profile", policyName: "balanced", won: true, reward: 1 },
        { model: "alpha", profileId: "alpha-profile", policyName: "balanced", won: true, reward: 1 },
        { model: "alpha", profileId: "alpha-profile", policyName: "balanced", won: true, reward: 1 },
        { model: "beta", profileId: "beta-profile", policyName: "village-analyst", won: false, reward: -1 },
        { model: "beta", profileId: "beta-profile", policyName: "village-analyst", won: false, reward: -1 },
        { model: "beta", profileId: "beta-profile", policyName: "village-analyst", won: true, reward: 0.5 },
        { model: "gamma", profileId: "gamma-profile", policyName: "wolf-deceiver", won: false, reward: -1 },
        { model: "gamma", profileId: "gamma-profile", policyName: "wolf-deceiver", won: false, reward: -1 },
        { model: "gamma", profileId: "gamma-profile", policyName: "wolf-deceiver", won: false, reward: -1 }
      ]),
      syntheticOutcomeCell("stats-cell-b", [
        { model: "alpha", profileId: "alpha-profile", policyName: "balanced", won: false, reward: -1 },
        { model: "alpha", profileId: "alpha-profile", policyName: "balanced", won: true, reward: 1 },
        { model: "alpha", profileId: "alpha-profile", policyName: "balanced", won: true, reward: 1 },
        { model: "beta", profileId: "beta-profile", policyName: "village-analyst", won: true, reward: 1 },
        { model: "beta", profileId: "beta-profile", policyName: "village-analyst", won: false, reward: -1 },
        { model: "beta", profileId: "beta-profile", policyName: "village-analyst", won: false, reward: -1 },
        { model: "gamma", profileId: "gamma-profile", policyName: "wolf-deceiver", won: true, reward: 1 },
        { model: "gamma", profileId: "gamma-profile", policyName: "wolf-deceiver", won: false, reward: -1 },
        { model: "gamma", profileId: "gamma-profile", policyName: "wolf-deceiver", won: false, reward: -1 }
      ])
    ]);

    expect(statistics.status.completedSeatRows).toBe(18);
    expect(statistics.modelStats.map((stats) => stats.subjectId)).toEqual(["alpha", "beta", "gamma"]);
    expect(statistics.modelStats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subjectType: "model",
          subjectId: "alpha",
          seatGames: 6,
          wins: 5,
          losses: 1,
          winRate: 0.8333,
          winRateWilson95: expect.any(Array),
          rewardCount: 6,
          rewardMean: 0.6667
        }),
        expect.objectContaining({
          subjectId: "gamma",
          seatGames: 6,
          wins: 1,
          losses: 5,
          winRate: 0.1667
        })
      ])
    );
    expect(statistics.profileStats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subjectType: "profile",
          subjectId: "alpha-profile",
          model: "alpha",
          profileId: "alpha-profile",
          policyName: "balanced"
        })
      ])
    );
    expect(statistics.denominatorPolicy.superiorityClaims).toBe(false);
    expect(statistics.pairwiseModelComparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leftModel: "alpha",
          rightModel: "beta",
          method: "two_proportion_z_test_unpaired_seat_level",
          warning: expect.stringContaining("not independent")
        })
      ])
    );
    expect(statistics.pairwiseModelComparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leftModel: "alpha",
          rightModel: "gamma",
          leftSeatGames: 6,
          rightSeatGames: 6,
          leftWinRate: 0.8333,
          rightWinRate: 0.1667,
          pValueTwoSided: expect.any(Number),
          pValueHolm: expect.any(Number)
        })
      ])
    );
    expect(statistics.pairwiseModelComparisons.every((comparison) => comparison.pValueHolm !== null || comparison.pValueTwoSided === null)).toBe(true);
  });

  it("writes a paper-ready matrix artifact directory with nested tournament artifacts and relative manifest paths", async () => {
    const outputDir = await makeTempDir();
    const matrix = normalizeMatrixExperimentSpec({
      version: MATRIX_EXPERIMENT_VERSION,
      id: "artifact-matrix",
      kind: "matrix",
      base: {
        games: 1,
        seed: "artifact-matrix",
        maxTransitions: 4,
        jointPhaseScheduler: "parallel",
        continueOnError: true
      },
      cells: [
        {
          id: "artifact-alpha-beta",
          models: ["alpha", "beta"],
          seed: "artifact-alpha-beta"
        }
      ]
    });
    const result = await runExperimentMatrix({
      experiment: matrix,
      reasoner: deterministicReasoner,
      includeArtifacts: true
    });

    const written = await writeExperimentMatrixArtifactDirectory(result, {
      outputDir,
      createdAt: "2026-01-02T03:04:05.000Z"
    });

    await expect(writeExperimentMatrixArtifactDirectory(result, { outputDir })).rejects.toThrow();
    expect(path.resolve(written.outputDir)).toBe(outputDir);
    expect(written.files.manifest).toBe(path.join(outputDir, "manifest.json"));
    expect(written.files.specNormalized).toBe(path.join(outputDir, "spec.normalized.json"));
    expect(written.files.cells).toBe(path.join(outputDir, "cells.jsonl"));
    expect(written.files.statistics).toBe(path.join(outputDir, "statistics.json"));
    expect(written.files.summaryMarkdown).toBe(path.join(outputDir, "summary.md"));
    expect(written.files.modelStatsCsv).toBe(path.join(outputDir, "model_stats.csv"));
    expect(written.files.profileStatsCsv).toBe(path.join(outputDir, "profile_stats.csv"));
    expect(written.files.pairwiseModelComparisonsCsv).toBe(path.join(outputDir, "pairwise_model_comparisons.csv"));
    expect(written.files.tournaments).toEqual([
      {
        cellId: "artifact-alpha-beta",
        manifest: "tournaments/artifact-alpha-beta/manifest.json"
      }
    ]);

    const manifest = await readJson<Record<string, any>>(path.join(outputDir, "manifest.json"));
    expect(manifest).toMatchObject({
      artifactVersion: MATRIX_ARTIFACT_VERSION,
      kind: "experiment-matrix",
      createdAt: "2026-01-02T03:04:05.000Z",
      matrixId: "artifact-matrix",
      status: "completed",
      cellsRequested: 1,
      cellsCompleted: 0,
      cellsTruncated: 1,
      cellsFailed: 0,
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesTruncated: 1,
      gamesFailed: 0,
      files: {
        manifest: "manifest.json",
        specNormalized: "spec.normalized.json",
        cells: "cells.jsonl",
        statistics: "statistics.json",
        summaryMarkdown: "summary.md",
        modelStatsCsv: "model_stats.csv",
        profileStatsCsv: "profile_stats.csv",
        pairwiseModelComparisonsCsv: "pairwise_model_comparisons.csv",
        tournaments: [
          {
            cellId: "artifact-alpha-beta",
            manifest: "tournaments/artifact-alpha-beta/manifest.json"
          }
        ]
      }
    });
    expect(JSON.stringify(manifest)).not.toContain(outputDir);
    expect(flattenManifestFiles(manifest.files).every((file) => !path.isAbsolute(file))).toBe(true);

    const normalizedSpec = await readJson<Record<string, any>>(path.join(outputDir, "spec.normalized.json"));
    expect(normalizedSpec.cells[0]?.tournament).toMatchObject({
      maxTransitions: 4,
      jointPhaseScheduler: "parallel"
    });

    const cells = await readJsonl<Record<string, any>>(path.join(outputDir, "cells.jsonl"));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      type: "matrix_cell",
      id: "artifact-alpha-beta",
      status: "truncated",
      gamesCompleted: 0,
      gamesTruncated: 1,
      gamesFailed: 0,
      models: ["alpha", "beta"]
    });

    const statistics = await readJson<Record<string, any>>(path.join(outputDir, "statistics.json"));
    expect(statistics).toMatchObject({
      artifactVersion: MATRIX_ARTIFACT_VERSION,
      kind: "experiment-matrix-statistics",
      matrixId: "artifact-matrix",
      status: {
        cellsRequested: 1,
        cellsCompleted: 0,
        cellsTruncated: 1,
        gamesCompleted: 0,
        gamesTruncated: 1,
        completedSeatRows: 0
      }
    });

    const summaryMarkdown = await readFile(path.join(outputDir, "summary.md"), "utf8");
    expect(summaryMarkdown).toContain("# Experiment Matrix Summary: artifact-matrix");
    expect(summaryMarkdown).toContain("Games truncated: 1");
    expect(summaryMarkdown).toContain("## Pairwise Model Comparisons");
    expect(summaryMarkdown).toContain("descriptive screening statistic");
    expect(summaryMarkdown).not.toContain(outputDir);

    const modelStatsCsv = await readFile(path.join(outputDir, "model_stats.csv"), "utf8");
    expect(modelStatsCsv).toMatch(/^subject_type,subject_id,model,profile_id,policy_name,seat_games,/);
    expect(modelStatsCsv.trim().split(/\r?\n/)).toHaveLength(1);

    const pairwiseCsv = await readFile(path.join(outputDir, "pairwise_model_comparisons.csv"), "utf8");
    expect(pairwiseCsv).toMatch(/^left_model,right_model,left_seat_games,right_seat_games,/);
    expect(pairwiseCsv.trim().split(/\r?\n/)).toHaveLength(1);

    const nestedManifest = await readJson<Record<string, any>>(path.join(outputDir, "tournaments", "artifact-alpha-beta", "manifest.json"));
    expect(nestedManifest).toMatchObject({
      artifactVersion: "harness.tournament.v1",
      kind: "tournament",
      seed: "artifact-alpha-beta"
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "werewolf-matrix-test-"));
  tempDirs.push(dir);
  return dir;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function flattenManifestFiles(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenManifestFiles);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenManifestFiles);
  return [];
}

function syntheticOutcomeCell(
  id: string,
  agents: Array<{
    model: string;
    profileId: string;
    policyName: string;
    won: boolean;
    reward: number;
  }>
): ExperimentMatrixCellResult {
  return {
    index: id.endsWith("b") ? 1 : 0,
    id,
    label: id,
    group: "synthetic",
    status: "completed",
    elapsedMs: 1,
    tournament: {
      gamesRequested: 1,
      gamesCompleted: 1,
      gamesFailed: 0,
      episodes: [
        {
          index: 0,
          seed: `${id}:g1`,
          status: "completed",
          resolvedAssignments: [],
          agents: agents.map((agent, index) => ({
            playerId: `p${index + 1}`,
            seat: index + 1,
            ...agent
          }))
        }
      ]
    } as unknown as ExperimentMatrixCellResult["tournament"]
  };
}
