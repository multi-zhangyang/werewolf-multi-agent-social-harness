import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerApp } from "../src/server/index";
import { clearServerStoreForTests } from "../src/server/store";
import type { HarnessReasoner } from "../src/harness/types";

const fakeReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? `server matrix speech ${input.traceId}`
        : `server matrix memo ${input.agent.model}/${input.action.kind}/${input.policyPlan.policyName}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        providerRequestId: `server-matrix-${input.traceId}`,
        attempts: 1
      }
    };
  }
};

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  clearServerStoreForTests();
});

describe("experiment matrix server API", () => {
  it("exports matrix artifacts under a configured base dir and downloads registered files only", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ matrixArtifactBaseDir: artifactBaseDir });

    const exported = await requestJson(baseUrl, "POST", "/api/experiments/matrix/run", {
      version: "harness.experiment-matrix.v1",
      id: "server-matrix-artifacts",
      kind: "matrix",
      continueOnError: true,
      base: {
        games: 1,
        seed: "server-matrix-artifacts",
        maxTransitions: 0,
        continueOnError: true
      },
      cells: [
        {
          id: "server-matrix-alpha-beta",
          label: "Alpha Beta",
          group: "baseline",
          models: ["alpha", "beta"],
          seed: "server-matrix-alpha-beta"
        }
      ],
      exportArtifacts: true
    });

    expect(exported.status).toBe(200);
    expect(exported.body.summary).toMatchObject({
      kind: "experiment-matrix",
      ok: true,
      matrixId: "server-matrix-artifacts",
      status: "completed",
      cellsRequested: 1,
      cellsCompleted: 0,
      cellsTruncated: 1,
      cellsFailed: 0,
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesTruncated: 1,
      gamesFailed: 0,
      artifacts: {
        artifactSetId: expect.any(String),
        matrixId: "server-matrix-artifacts",
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
              cellId: "server-matrix-alpha-beta",
              manifest: "tournaments/server-matrix-alpha-beta/manifest.json"
            }
          ]
        }
      }
    });
    expect(exported.body.artifacts).toEqual(exported.body.summary.artifacts);
    expect(exported.body.statistics).toMatchObject({
      kind: "experiment-matrix-statistics",
      matrixId: "server-matrix-artifacts",
      status: {
        cellsRequested: 1,
        cellsCompleted: 0,
        cellsTruncated: 1,
        gamesCompleted: 0,
        gamesTruncated: 1
      },
      denominatorPolicy: {
        superiorityClaims: false
      }
    });
    expect(exported.body.cells).toHaveLength(1);
    expect(exported.body.cells[0]).toMatchObject({
      id: "server-matrix-alpha-beta",
      label: "Alpha Beta",
      group: "baseline",
      status: "truncated",
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesTruncated: 1,
      gamesFailed: 0,
      models: ["alpha", "beta"],
      hasArtifacts: true
    });
    expect(exported.body.cells[0]).not.toHaveProperty("tournament");
    expect(JSON.stringify(exported.body)).not.toContain(artifactBaseDir);
    expect(JSON.stringify(exported.body)).not.toContain("outputDir");

    const artifactSetId = exported.body.artifacts.artifactSetId;
    expect(exported.body.artifacts.downloads.statistics).toBe(
      `/api/experiments/matrix/artifacts/${encodeURIComponent(artifactSetId)}/files/statistics.json`
    );

    const listed = await requestJson(baseUrl, "GET", "/api/experiments/matrix/artifacts");
    expect(listed.status).toBe(200);
    expect(listed.body.artifactSets).toEqual([exported.body.artifacts]);
    expectNoArtifactPathLeak(listed.body, artifactBaseDir);

    const detail = await requestJson(baseUrl, "GET", `/api/experiments/matrix/artifacts/${artifactSetId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(exported.body.artifacts);
    expectNoArtifactPathLeak(detail.body, artifactBaseDir);

    const manifest = await requestJson(baseUrl, "GET", `/api/experiments/matrix/artifacts/${artifactSetId}/files/manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.contentType).toMatch(/application\/json/);
    expect(manifest.body).toMatchObject({
      artifactVersion: "harness.experiment-matrix-artifact.v1",
      kind: "experiment-matrix",
      matrixId: "server-matrix-artifacts",
      files: exported.body.artifacts.files
    });
    expectNoArtifactPathLeak(manifest.body, artifactBaseDir);

    const statistics = await requestJson(baseUrl, "GET", `/api/experiments/matrix/artifacts/${artifactSetId}/files/statistics.json`);
    expect(statistics.status).toBe(200);
    expect(statistics.contentType).toMatch(/application\/json/);
    expect(statistics.body).toMatchObject({
      kind: "experiment-matrix-statistics",
      matrixId: "server-matrix-artifacts",
      denominatorPolicy: {
        superiorityClaims: false
      }
    });
    expectNoArtifactPathLeak(statistics.body, artifactBaseDir);

    const summaryMarkdown = await requestText(baseUrl, "GET", `/api/experiments/matrix/artifacts/${artifactSetId}/files/summary.md`);
    expect(summaryMarkdown.status).toBe(200);
    expect(summaryMarkdown.contentType).toMatch(/text\/markdown/);
    expect(summaryMarkdown.text).toContain("# Experiment Matrix Summary: server-matrix-artifacts");
    expect(summaryMarkdown.text).toContain("descriptive screening statistic");
    expectNoArtifactPathLeak(summaryMarkdown.text, artifactBaseDir);

    const modelStatsCsv = await requestText(baseUrl, "GET", `/api/experiments/matrix/artifacts/${artifactSetId}/files/model_stats.csv`);
    expect(modelStatsCsv.status).toBe(200);
    expect(modelStatsCsv.contentType).toMatch(/text\/csv/);
    expect(modelStatsCsv.text).toMatch(/^subject_type,subject_id,model,/);
    expectNoArtifactPathLeak(modelStatsCsv.text, artifactBaseDir);

    const nestedManifest = await requestJson(
      baseUrl,
      "GET",
      `/api/experiments/matrix/artifacts/${artifactSetId}/files/tournaments/server-matrix-alpha-beta/manifest.json`
    );
    expect(nestedManifest.status).toBe(200);
    expect(nestedManifest.body).toMatchObject({
      artifactVersion: "harness.tournament.v1",
      kind: "tournament",
      seed: "server-matrix-alpha-beta"
    });
    expectNoArtifactPathLeak(nestedManifest.body, artifactBaseDir);

    const unregisteredNested = await requestJson(
      baseUrl,
      "GET",
      `/api/experiments/matrix/artifacts/${artifactSetId}/files/tournaments/server-matrix-alpha-beta/episodes.jsonl`
    );
    expect(unregisteredNested.status).toBe(404);
    expectNoArtifactPathLeak(unregisteredNested.body, artifactBaseDir);

    const unsafePaths = ["..%2Fmanifest.json", "%2Fetc%2Fpasswd", "tournaments%2F..%2Fmanifest.json", "tournaments%5C..%5Cmanifest.json"];
    for (const unsafePath of unsafePaths) {
      const rejected = await requestJson(baseUrl, "GET", `/api/experiments/matrix/artifacts/${artifactSetId}/files/${unsafePath}`);
      expect([400, 404], unsafePath).toContain(rejected.status);
      expectNoArtifactPathLeak(rejected.body, artifactBaseDir);
    }

    clearServerStoreForTests();
    const restartedBaseUrl = await startServer({ matrixArtifactBaseDir: artifactBaseDir });
    const restoredList = await requestJson(restartedBaseUrl, "GET", "/api/experiments/matrix/artifacts");
    expect(restoredList.status).toBe(200);
    expect(restoredList.body.artifactSets).toEqual([exported.body.artifacts]);
    expectNoArtifactPathLeak(restoredList.body, artifactBaseDir);
  });

  it("uses top-level fields as base overrides when a nested matrix spec is supplied", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ matrixArtifactBaseDir: artifactBaseDir });

    const exported = await requestJson(baseUrl, "POST", "/api/experiments/matrix/run", {
      spec: {
        version: "harness.experiment-matrix.v1",
        id: "server-matrix-overrides",
        kind: "matrix",
        base: {
          models: ["stale-model"],
          games: 2,
          seed: "server-matrix-overrides",
          maxTransitions: 7
        }
      },
      models: ["override-alpha", "override-beta"],
      games: 1,
      maxTransitions: 0,
      exportArtifacts: false
    });

    expect(exported.status).toBe(200);
    expect(exported.body.summary).toMatchObject({
      kind: "experiment-matrix",
      ok: true,
      matrixId: "server-matrix-overrides",
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesTruncated: 1
    });
    expect(exported.body.cells[0]).toMatchObject({
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesTruncated: 1,
      models: ["override-alpha", "override-beta"]
    });
    expect(JSON.stringify(exported.body)).not.toContain("stale-model");
  });

  it("rejects artifact export when no matrix or tournament artifact base dir is configured", async () => {
    const previousMatrix = process.env.MATRIX_ARTIFACT_BASE_DIR;
    const previousTournament = process.env.TOURNAMENT_ARTIFACT_BASE_DIR;
    delete process.env.MATRIX_ARTIFACT_BASE_DIR;
    delete process.env.TOURNAMENT_ARTIFACT_BASE_DIR;
    try {
      const baseUrl = await startServer({});
      const rejected = await requestJson(baseUrl, "POST", "/api/experiments/matrix/run", {
        version: "harness.experiment-matrix.v1",
        id: "server-matrix-no-base",
        kind: "matrix",
        base: {
          models: ["alpha", "beta"],
          games: 1,
          maxTransitions: 0
        },
        exportArtifacts: true
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toMatch(/MATRIX_ARTIFACT_BASE_DIR|TOURNAMENT_ARTIFACT_BASE_DIR/);
    } finally {
      restoreEnv("MATRIX_ARTIFACT_BASE_DIR", previousMatrix);
      restoreEnv("TOURNAMENT_ARTIFACT_BASE_DIR", previousTournament);
    }
  });

  it("rejects filesystem control fields inside matrix base and cells", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ matrixArtifactBaseDir: artifactBaseDir });

    const baseRejected = await requestJson(baseUrl, "POST", "/api/experiments/matrix/run", {
      version: "harness.experiment-matrix.v1",
      id: "server-matrix-base-forbidden",
      kind: "matrix",
      base: {
        models: ["alpha", "beta"],
        games: 1,
        maxTransitions: 0,
        outputDir: "/tmp/unsafe"
      },
      exportArtifacts: true
    });
    expect(baseRejected.status).toBe(400);
    expect(baseRejected.body.error).toMatch(/forbidden field/);

    const cellRejected = await requestJson(baseUrl, "POST", "/api/experiments/matrix/run", {
      version: "harness.experiment-matrix.v1",
      id: "server-matrix-cell-forbidden",
      kind: "matrix",
      base: {
        models: ["alpha", "beta"],
        games: 1,
        maxTransitions: 0
      },
      cells: [
        {
          id: "bad-cell",
          spec: {
            outputDir: "/tmp/unsafe"
          }
        }
      ],
      exportArtifacts: true
    });
    expect(cellRejected.status).toBe(400);
    expect(cellRejected.body.error).toMatch(/forbidden field/);
  });
});

async function startServer(options: { matrixArtifactBaseDir?: string }): Promise<string> {
  const app = createServerApp({
    createReasoner: () => fakeReasoner,
    matrixArtifactBaseDir: options.matrixArtifactBaseDir
  });
  const server = await listen(app);
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function listen(app: ReturnType<typeof createServerApp>): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "werewolf-server-matrix-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

async function requestJson(baseUrl: string, method: string, requestPath: string, body?: unknown): Promise<{ status: number; body: any; contentType: string }> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    contentType: response.headers.get("content-type") ?? ""
  };
}

async function requestText(baseUrl: string, method: string, requestPath: string): Promise<{ status: number; text: string; contentType: string }> {
  const response = await fetch(`${baseUrl}${requestPath}`, { method });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type") ?? ""
  };
}

function expectNoArtifactPathLeak(value: unknown, artifactBaseDir: string): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toContain(artifactBaseDir);
  expect(text).not.toContain("outputDir");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
