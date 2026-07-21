import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerApp } from "../src/server/index";
import { clearServerStoreForTests } from "../src/server/store";
import type { HarnessAgentProfile, HarnessReasoner } from "../src/harness/types";

const fakeReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? "server artifact speech " + input.traceId
        : "server artifact memo " + input.agent.model + "/" + input.action.kind + "/" + input.policyPlan.policyName;
    return {
      content,
      completion: {
        content,
        latencyMs: 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        providerRequestId: "server-artifact-" + input.traceId,
        attempts: 1
      }
    };
  }
};

const tempDirs: string[] = [];
const servers: Server[] = [];
const ARTIFACT_SET_INDEX_FILE = "artifact_sets.index.json";

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  clearServerStoreForTests();
});

describe("tournament artifact server API", () => {
  it("accepts a bounded parallel scheduler as a recorded tournament condition and rejects an unreachable one", async () => {
    const baseUrl = await startServer({});

    const accepted = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
      models: ["alpha", "beta"],
      games: 1,
      seed: "server-parallel-tournament",
      maxTransitions: 4,
      jointPhaseScheduler: "parallel"
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.summary.limits).toMatchObject({
      maxTransitions: 4,
      jointPhaseScheduler: "parallel"
    });

    const rejected = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
      models: ["alpha"],
      games: 1,
      seed: "server-parallel-too-short",
      maxTransitions: 3,
      jointPhaseScheduler: "parallel"
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/parallel requires maxTransitions >= 4/);
  });

  it("exports exactly the strict public pack and does not register research files", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const seed = "server-public-pack-seed";
    const exported = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
      models: ["alpha", "beta"],
      games: 1,
      seed,
      maxTransitions: 0,
      exportArtifacts: true
    });

    expect(exported.status).toBe(200);
    expect(exported.body.summary).toMatchObject({
      ok: true,
      status: "truncated",
      gamesRequested: 1,
      gamesCompleted: 0,
      gamesTruncated: 1,
      gamesFailed: 0
    });
    expect(exported.body.episodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ index: 0, status: "truncated", harnessStatus: "truncated" })])
    );
    const artifacts = exported.body.artifacts;
    const artifactSetId = artifacts.artifactSetId as string;
    expect(artifacts.files).toEqual({
      manifest: "manifest.json",
      episodes: "episodes.jsonl",
      matches: ["matches/episode-1.json"]
    });
    expect(artifacts.seed).toBe("[REDACTED deterministic seed]");
    expect(artifacts.files).not.toHaveProperty("assignment");
    expect(artifacts.files).not.toHaveProperty("trajectory");
    expect(artifacts.files).not.toHaveProperty("metrics");
    expect(artifacts.files).not.toHaveProperty("leaderboard");
    expect(artifacts.files).not.toHaveProperty("matchesJsonl");

    const packDirectory = path.join(artifactBaseDir, artifactSetId);
    expect((await readdir(packDirectory)).sort()).toEqual(["episodes.jsonl", "manifest.json", "matches"]);
    expect(await readdir(path.join(packDirectory, "matches"))).toEqual(["episode-1.json"]);

    const manifest = await requestJson(baseUrl, "GET", "/api/tournament-artifacts/" + artifactSetId + "/files/manifest.json");
    expect(manifest.status).toBe(200);
    expect(manifest.body).toEqual({
      artifactVersion: "harness.tournament.public.v1",
      kind: "public-tournament",
      visibility: "public",
      createdAt: expect.any(String),
      games: { requested: 1, completed: 0, truncated: 1, failed: 0 },
      files: {
        manifest: "manifest.json",
        episodes: "episodes.jsonl",
        matches: ["matches/episode-1.json"]
      }
    });

    const episodes = await requestText(baseUrl, "GET", "/api/tournament-artifacts/" + artifactSetId + "/files/episodes.jsonl");
    expect(episodes.status).toBe(200);
    const episodeRecords = parseJsonl(episodes.text);
    expect(episodeRecords).toHaveLength(1);
    expect(episodeRecords[0]).toMatchObject({
      kind: "public-episode",
      episodeIndex: 0,
      match: "matches/episode-1.json",
      publicMessageCount: expect.any(Number)
    });
    expect(Object.keys(episodeRecords[0]).sort()).toEqual(["episodeIndex", "kind", "match", "publicMessageCount", "status"]);

    const match = await requestJson(
      baseUrl,
      "GET",
      "/api/tournament-artifacts/" + artifactSetId + "/files/matches/episode-1.json"
    );
    expect(match.status).toBe(200);
    expect(Object.keys(match.body).sort()).toEqual(["artifactVersion", "episodeIndex", "events", "kind", "messages", "state", "status"]);
    expect(match.body).toMatchObject({
      artifactVersion: "harness.match.public.v1",
      kind: "public-match",
      episodeIndex: 0,
      state: {
        phase: expect.any(String),
        day: expect.any(Number),
        pendingActionCount: expect.any(Number),
        publicEventCount: expect.any(Number),
        players: expect.any(Array)
      },
      events: expect.any(Array),
      messages: expect.any(Array)
    });
    for (const player of match.body.state.players) {
      expect(player).not.toHaveProperty("id");
      expect(player).not.toHaveProperty("role");
      expect(player).not.toHaveProperty("team");
      expect(player).not.toHaveProperty("ability");
      expect(Object.keys(player).sort()).toEqual(expect.arrayContaining(["alive", "isSheriff", "name", "seat"]));
    }
    for (const event of match.body.events) {
      expect(Object.keys(event).sort()).toEqual(["day", "seq", "type"]);
    }
    for (const message of match.body.messages) {
      expect(Object.keys(message).sort()).toEqual(["content", "senderSeat", "seq"]);
    }

    for (const relativePath of [
      "assignment.json",
      "trajectory.jsonl",
      "metrics.jsonl",
      "leaderboard.json",
      "matches/episode-1.jsonl",
      "matches/not-registered.json"
    ]) {
      const rejected = await requestJson(
        baseUrl,
        "GET",
        "/api/tournament-artifacts/" + artifactSetId + "/files/" + relativePath
      );
      expect(rejected.status).toBe(404);
    }

    expectPublicPayloadHasNoExecutionIdentity([manifest.body, episodeRecords, match.body], [
      seed,
      "alpha",
      "beta",
      '"profileId"',
      '"policyName"',
      '"providerRequestId"',
      '"traceId"',
      '"runId"',
      '"matchId"',
      '"channelId"',
      '"participantIds"',
      '"recipientIds"'
    ]);
    expectNoArtifactPathLeak([manifest.body, episodeRecords, match.body], artifactBaseDir);
  });

  it("keeps explicit profile and policy identities out of every public artifact file", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const profiles = [
      { id: "wolf-pressure-lab", model: "profile-model-a", policyName: "wolf-deceiver", temperature: 0.2 },
      { id: "village-audit-lab", model: "profile-model-b", policyName: "village-analyst", temperature: 1.1 }
    ] satisfies HarnessAgentProfile[];
    const seed = "server-explicit-profile-public-pack";
    const exported = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
      models: ["ignored-when-profiles-derive-runtime-models"],
      profiles,
      assignment: { strategy: "profile-rotation" },
      games: 1,
      seed,
      maxTransitions: 0,
      exportArtifacts: true
    });

    expect(exported.status).toBe(200);
    const artifactSetId = exported.body.artifacts.artifactSetId as string;
    const files = await readRegisteredPublicFiles(artifactBaseDir, artifactSetId);
    expectPublicPayloadHasNoExecutionIdentity(files, [
      seed,
      "wolf-pressure-lab",
      "village-audit-lab",
      "wolf-deceiver",
      "village-analyst",
      "profile-model-a",
      "profile-model-b",
      '"role"',
      '"team"',
      '"profileId"',
      '"policyName"',
      '"model"'
    ]);

    const blockedSpec = await requestJson(
      baseUrl,
      "GET",
      "/api/tournament-artifacts/" + artifactSetId + "/files/spec.normalized.json"
    );
    const blockedAssignment = await requestJson(
      baseUrl,
      "GET",
      "/api/tournament-artifacts/" + artifactSetId + "/files/assignment.json"
    );
    expect(blockedSpec.status).toBe(404);
    expect(blockedAssignment.status).toBe(404);
  });

  it("serves public shares as read-only capabilities with only allowlisted files", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const seed = "server-public-share-seed";
    const { artifactSetId } = await exportOneTournamentArtifactSet(baseUrl, seed);
    const created = await requestJson(baseUrl, "POST", "/api/tournament-artifacts/" + artifactSetId + "/shares", {
      label: "paper-pack",
      relativeFiles: ["manifest.json", "episodes.jsonl", "matches/episode-1.json"]
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      shareId: expect.any(String),
      artifactSetId,
      label: "paper-pack",
      expired: false,
      urls: {
        detail: expect.stringContaining("/api/public/tournament-shares/"),
        filesBase: expect.stringContaining("/api/public/tournament-shares/")
      }
    });
    const shareId = created.body.shareId as string;
    const detail = await requestJson(baseUrl, "GET", created.body.urls.detail);
    expect(detail.status).toBe(200);
    expect(detail.body.files).toEqual(["manifest.json", "episodes.jsonl", "matches/episode-1.json"]);
    expect(detail.body).not.toHaveProperty("seed");
    expect(detail.body).not.toHaveProperty("experimentId");
    expect(detail.body).not.toHaveProperty("packDensity");
    expect(detail.body).not.toHaveProperty("packMetricPromotion");
    expectPublicPayloadHasNoExecutionIdentity(detail.body, [seed, '"seed"', '"experimentId"', '"profileId"', '"policyName"']);

    const sharedManifest = await requestJson(
      baseUrl,
      "GET",
      "/api/public/tournament-shares/" + shareId + "/files/manifest.json"
    );
    const sharedMatch = await requestJson(
      baseUrl,
      "GET",
      "/api/public/tournament-shares/" + shareId + "/files/matches/episode-1.json"
    );
    const blocked = await requestJson(
      baseUrl,
      "GET",
      "/api/public/tournament-shares/" + shareId + "/files/assignment.json"
    );
    expect(sharedManifest.status).toBe(200);
    expect(sharedMatch.status).toBe(200);
    expect(blocked.status).toBe(404);
    expect(Object.keys(sharedMatch.body).sort()).toEqual(["artifactVersion", "episodeIndex", "events", "kind", "messages", "state", "status"]);

    const inventory = await requestJson(baseUrl, "GET", "/api/tournament-public-shares");
    expect(inventory.status).toBe(200);
    expect(inventory.body.shares).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shareId,
          artifactSetId,
          label: "paper-pack",
          packFound: true
        })
      ])
    );
    expectPublicPayloadHasNoExecutionIdentity(inventory.body, [seed, '"packSeed"', '"packExperimentId"']);
    expectNoArtifactPathLeak(inventory.body, artifactBaseDir);
  });

  it("fails closed when a public match DTO or its directory inventory is tampered", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const { artifactSetId } = await exportOneTournamentArtifactSet(baseUrl, "server-public-tamper");
    const created = await requestJson(baseUrl, "POST", "/api/tournament-artifacts/" + artifactSetId + "/shares", {});
    expect(created.status).toBe(201);
    const matchPath = path.join(artifactBaseDir, artifactSetId, "matches", "episode-1.json");
    const match = JSON.parse(await readFile(matchPath, "utf8")) as Record<string, unknown>;
    match.seed = "injected-seed";
    await writeFile(matchPath, JSON.stringify(match), "utf8");

    const detail = await requestJson(baseUrl, "GET", "/api/public/tournament-shares/" + created.body.shareId);
    const download = await requestJson(
      baseUrl,
      "GET",
      "/api/public/tournament-shares/" + created.body.shareId + "/files/matches/episode-1.json"
    );
    const secondShare = await requestJson(baseUrl, "POST", "/api/tournament-artifacts/" + artifactSetId + "/shares", {});
    expect(detail.status).toBe(409);
    expect(download.status).toBe(409);
    expect(secondShare.status).toBe(409);

    const untouched = await exportOneTournamentArtifactSet(baseUrl, "server-public-extra-file");
    await writeFile(path.join(artifactBaseDir, untouched.artifactSetId, "unexpected.json"), "{}", "utf8");
    const rejectedForExtraFile = await requestJson(
      baseUrl,
      "POST",
      "/api/tournament-artifacts/" + untouched.artifactSetId + "/shares",
      {}
    );
    expect(rejectedForExtraFile.status).toBe(409);
  });

  it("does not elevate a legacy publicShareSafe label into public-share authority", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const { artifactSetId } = await exportOneTournamentArtifactSet(baseUrl, "server-legacy-public-label");
    const manifestPath = path.join(artifactBaseDir, artifactSetId, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        artifactVersion: "harness.tournament.v1",
        kind: "tournament",
        createdAt: "2026-01-02T03:04:05.000Z",
        experimentId: "legacy-research-pack",
        seed: "legacy-private-seed",
        projection: {
          visibility: "public",
          matchArtifactView: "truth-redacted",
          assignmentTruthRedacted: true,
          publicShareSafe: true
        },
        files: {
          manifest: "manifest.json",
          episodes: "episodes.jsonl",
          matches: []
        }
      }),
      "utf8"
    );

    const created = await requestJson(baseUrl, "POST", "/api/tournament-artifacts/" + artifactSetId + "/shares", {});
    expect(created.status).toBe(409);
  });

  it("rehydrates valid public packs from disk and rejects a tampered pack after restart", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const valid = await exportOneTournamentArtifactSet(baseUrl, "server-public-rehydrate");
    await rm(path.join(artifactBaseDir, ARTIFACT_SET_INDEX_FILE), { force: true });

    const restartedBaseUrl = await restartServerWithClearedStore(artifactBaseDir);
    const restored = await requestJson(restartedBaseUrl, "GET", "/api/tournament-artifacts/" + valid.artifactSetId);
    expect(restored.status).toBe(200);
    expect(restored.body.files).toEqual({
      manifest: "manifest.json",
      episodes: "episodes.jsonl",
      matches: ["matches/episode-1.json"]
    });
    const restoredShare = await requestJson(
      restartedBaseUrl,
      "POST",
      "/api/tournament-artifacts/" + valid.artifactSetId + "/shares",
      {}
    );
    expect(restoredShare.status).toBe(201);

    const tampered = await exportOneTournamentArtifactSet(restartedBaseUrl, "server-public-rehydrate-tampered");
    await writeFile(path.join(artifactBaseDir, tampered.artifactSetId, "extra.json"), "{}", "utf8");
    await rm(path.join(artifactBaseDir, ARTIFACT_SET_INDEX_FILE), { force: true });
    const afterTamperBaseUrl = await restartServerWithClearedStore(artifactBaseDir);
    const missing = await requestJson(
      afterTamperBaseUrl,
      "GET",
      "/api/tournament-artifacts/" + tampered.artifactSetId
    );
    expect(missing.status).toBe(404);
  });

  it("exports more than one public episode without trying to seed a comparison from display DTOs", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({ artifactBaseDir });
    const exported = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
      models: ["alpha", "beta"],
      games: 2,
      seed: "server-public-two-episodes",
      maxTransitions: 0,
      exportArtifacts: true
    });

    expect(exported.status).toBe(200);
    const artifactSetId = exported.body.artifacts.artifactSetId as string;
    const manifest = await requestJson(baseUrl, "GET", "/api/tournament-artifacts/" + artifactSetId + "/files/manifest.json");
    expect(manifest.status).toBe(200);
    expect(manifest.body.files.matches).toEqual(["matches/episode-1.json", "matches/episode-2.json"]);
    const comparisonFile = await requestJson(
      baseUrl,
      "GET",
      "/api/tournament-artifacts/" + artifactSetId + "/files/tournament_comparison.json"
    );
    expect(comparisonFile.status).toBe(404);
  });

  it("rate limits public downloads while keeping usage analytics free of evaluation and seed data", async () => {
    const artifactBaseDir = await makeTempDir();
    const baseUrl = await startServer({
      artifactBaseDir,
      publicShareDownloadRateLimit: { maxDownloads: 2, windowMs: 60_000 }
    });
    const seed = "server-public-rate-limit";
    const { artifactSetId } = await exportOneTournamentArtifactSet(baseUrl, seed);
    const created = await requestJson(baseUrl, "POST", "/api/tournament-artifacts/" + artifactSetId + "/shares", {
      relativeFiles: ["manifest.json", "episodes.jsonl"]
    });
    expect(created.status).toBe(201);
    const shareId = created.body.shareId as string;

    const first = await requestJson(baseUrl, "GET", "/api/public/tournament-shares/" + shareId + "/files/manifest.json");
    const second = await requestText(baseUrl, "GET", "/api/public/tournament-shares/" + shareId + "/files/episodes.jsonl");
    const limited = await requestJson(baseUrl, "GET", "/api/public/tournament-shares/" + shareId + "/files/manifest.json");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(limited.status).toBe(429);

    const analytics = await requestJson(baseUrl, "GET", "/api/tournament-public-shares/summary?format=json");
    const markdown = await requestText(baseUrl, "GET", "/api/tournament-public-shares/summary?format=markdown");
    expect(analytics.status).toBe(200);
    expect(markdown.status).toBe(200);
    expect(analytics.body.totals).toMatchObject({
      shareCount: expect.any(Number),
      detailViewCount: expect.any(Number),
      downloadCount: expect.any(Number)
    });
    expect(analytics.body.totals).not.toHaveProperty("metricCount");
    expect(analytics.body.totals).not.toHaveProperty("nativeSteps");
    expectPublicPayloadHasNoExecutionIdentity([analytics.body, markdown.text], [
      seed,
      '"packSeed"',
      '"packExperimentId"',
      "promotion",
      "density"
    ]);
  });

  it("keeps operator inventory and revoke endpoints local while public detail stays readable", async () => {
    const artifactBaseDir = await makeTempDir();
    const localBaseUrl = await startServer({ artifactBaseDir });
    const { artifactSetId } = await exportOneTournamentArtifactSet(localBaseUrl, "server-operator-boundary");
    const created = await requestJson(localBaseUrl, "POST", "/api/tournament-artifacts/" + artifactSetId + "/shares", {});
    expect(created.status).toBe(201);
    const shareId = created.body.shareId as string;

    const restrictedBaseUrl = await startServer({
      artifactBaseDir,
      artifactAccessBindHost: "0.0.0.0"
    });
    const researchList = await requestJson(restrictedBaseUrl, "GET", "/api/tournament-artifacts");
    const inventory = await requestJson(restrictedBaseUrl, "GET", "/api/tournament-public-shares");
    const revoke = await requestJson(restrictedBaseUrl, "DELETE", "/api/public/tournament-shares/" + shareId);
    const publicDetail = await requestJson(restrictedBaseUrl, "GET", "/api/public/tournament-shares/" + shareId);
    expect(researchList.status).toBe(403);
    expect(inventory.status).toBe(403);
    expect(revoke.status).toBe(403);
    expect(publicDetail.status).toBe(200);
  });
});

async function startServer(options: {
  artifactBaseDir?: string;
  artifactAccessBindHost?: string;
  publicShareDownloadRateLimit?: {
    maxDownloads: number;
    windowMs: number;
    now?: () => number;
  };
}): Promise<string> {
  const app = createServerApp({
    createReasoner: () => fakeReasoner,
    artifactAccessBindHost: options.artifactAccessBindHost ?? "127.0.0.1",
    tournamentArtifactBaseDir: options.artifactBaseDir,
    publicShareDownloadRateLimit: options.publicShareDownloadRateLimit
  });
  const server = await listen(app);
  servers.push(server);
  const address = server.address() as AddressInfo;
  return "http://127.0.0.1:" + address.port;
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
  const dir = await mkdtemp(path.join(tmpdir(), "werewolf-server-tournament-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

async function exportOneTournamentArtifactSet(
  baseUrl: string,
  seed: string
): Promise<{ exported: Awaited<ReturnType<typeof requestJson>>; artifactSetId: string }> {
  const exported = await requestJson(baseUrl, "POST", "/api/tournaments/run", {
    models: ["alpha", "beta"],
    games: 1,
    seed,
    maxTransitions: 0,
    exportArtifacts: true
  });
  expect(exported.status).toBe(200);
  return {
    exported,
    artifactSetId: exported.body.artifacts.artifactSetId as string
  };
}

async function restartServerWithClearedStore(artifactBaseDir: string): Promise<string> {
  clearServerStoreForTests();
  return startServer({ artifactBaseDir });
}

async function readRegisteredPublicFiles(artifactBaseDir: string, artifactSetId: string): Promise<string[]> {
  const outputDir = path.join(artifactBaseDir, artifactSetId);
  return Promise.all(
    ["manifest.json", "episodes.jsonl", "matches/episode-1.json"].map((relativePath) =>
      readFile(path.join(outputDir, relativePath), "utf8")
    )
  );
}

function expectPublicPayloadHasNoExecutionIdentity(value: unknown, forbiddenValues: readonly string[]): void {
  const payload = Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n")
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
  for (const forbidden of forbiddenValues) {
    expect(payload).not.toContain(forbidden);
  }
}

function expectNoArtifactPathLeak(value: unknown, artifactBaseDir: string): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toContain(artifactBaseDir);
  expect(text).not.toContain("outputDir");
}

async function requestJson(
  baseUrl: string,
  method: string,
  requestPath: string,
  body?: unknown
): Promise<{ status: number; body: any; contentType: string }> {
  const response = await fetch(baseUrl + requestPath, {
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

async function requestText(
  baseUrl: string,
  method: string,
  requestPath: string
): Promise<{ status: number; text: string; contentType: string }> {
  const response = await fetch(baseUrl + requestPath, { method });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type") ?? ""
  };
}

function parseJsonl(text: string): any[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
