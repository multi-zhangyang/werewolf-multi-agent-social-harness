/**
 * API security checks (AGENTS.md §18 / P0-05), against the strict operator
 * model that actually ships in src/server/auth.ts:
 *
 *  - anonymous viewers stay PUBLIC, always;
 *  - the room owner token unlocks omniscient viewing + control of THAT room
 *    only (cross-room tokens are refused);
 *  - tokenless loopback mode is the trusted local operator; configuring an
 *    operator token restores strict token checks for every global write;
 *  - private state never leaks: roles stay hidden from public seats, and the
 *    public room view strips world internals.
 *
 * HTTP-level tests against the real route stack — no model calls, no network.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, it } from "vitest";
import express from "express";
import { ZodError } from "zod";
import { registerRoomRoutes } from "../../src/server/routes/rooms";
import { registerCharacterRoutes } from "../../src/server/characters";
import { registerTemplateRoutes } from "../../src/server/templates";
import { createServerContext, type ServerContext } from "../../src/server/context";
import { defaultCapabilities, protocolCheckFingerprint, type ModelProfile, type ProviderProfile } from "../../src/society/models";

interface Harness {
  context: ServerContext;
  base: string;
  server: Server;
  dir: string;
  roomA: string;
  roomAToken: string;
  roomB: string;
  roomBToken: string;
}

async function startHarness(env: Record<string, string | undefined>): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "society-auth-"));
  const previous: Record<string, string | undefined> = {};
  const overrides: Record<string, string | undefined> = {
    SOCIETY_CHARACTERS_FILE: path.join(dir, "characters.json"),
    SOCIETY_TEMPLATES_FILE: path.join(dir, "templates.json"),
    SOCIETY_MODEL_SETTINGS_FILE: path.join(dir, "model-settings.json"),
    HOST: "127.0.0.1",
    OPENAI_API_KEY: undefined,
    ...env
  };
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const context = createServerContext();
  const now = new Date().toISOString();
  const provider: ProviderProfile = {
    id: "security-provider",
    name: "security provider",
    kind: "openai-compatible",
    baseURL: "http://127.0.0.1:9/v1",
    apiMode: "chat-completions",
    enabled: true,
    createdAt: now,
    updatedAt: now
  };
  context.models.upsertProvider(provider);
  const profile: ModelProfile = {
    id: "security-model",
    name: "security model",
    providerProfileId: provider.id,
    modelId: "security-model",
    contextWindow: 128_000,
    contextWindowSource: "manual",
    capabilities: { ...defaultCapabilities(), tools: "yes", streaming: "yes" },
    defaults: {},
    contextPolicyId: "policy-balanced-auto",
    enabled: true
  };
  profile.protocolCheck = {
    status: "passed",
    fingerprint: protocolCheckFingerprint(profile, provider),
    checkedAt: now,
    latencyMs: 1
  };
  context.models.upsertModelProfile(profile);
  const app = express();
  app.use(express.json());
  registerCharacterRoutes(app, context);
  registerTemplateRoutes(app, context);
  registerRoomRoutes(app, context);
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: "VALIDATION", message: error.issues[0]?.message ?? "invalid input" });
      return;
    }
    response.status(500).json({ error: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const create = async (scenarioId: string): Promise<{ id: string; ownerToken: string }> => {
    const response = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId, mode: "ai" })
    });
    assert.equal(response.status, 202);
    const payload = await response.json() as { room: { id: string }; ownerToken: string };
    return { id: payload.room.id, ownerToken: payload.ownerToken };
  };

  const roomA = await create("werewolf");
  const roomB = await create("prisoners-dilemma");
  return {
    context, base, server, dir,
    roomA: roomA.id, roomAToken: roomA.ownerToken,
    roomB: roomB.id, roomBToken: roomB.ownerToken
  };
}

async function stopHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  harness.context.rooms.remove(harness.roomA);
  harness.context.rooms.remove(harness.roomB);
  rmSync(harness.dir, { recursive: true, force: true });
}

function withBearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("viewer projection boundaries", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness({}); });
  afterAll(async () => { await stopHarness(harness); });

  it("an anonymous request for omniscient falls back to the public projection", async () => {
    const publicView = await fetch(`${harness.base}/api/rooms/${harness.roomA}?mode=public`).then((r) => r.json()) as { world: { agents: Array<{ observerRole?: string }> } };
    const sneaky = await fetch(`${harness.base}/api/rooms/${harness.roomA}?mode=omniscient`).then((r) => r.json()) as { world: { agents: Array<{ observerRole?: string }> } };
    assert.deepEqual(sneaky, publicView, "omniscient without authority is exactly the public seat");
    assert.ok(publicView.world.agents.every((agent) => agent.observerRole === undefined), "public seats never carry roles");
  });

  it("the owner token unlocks the omniscient seat with role reveals", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}?mode=omniscient`, {
      headers: withBearer(harness.roomAToken)
    });
    assert.equal(response.status, 200);
    const omniscient = await response.json() as { world: { agents: Array<{ observerRole?: string }> } };
    assert.ok(omniscient.world.agents.some((agent) => agent.observerRole), "the owner sees role reveals");
  });

  it("an invalid token is refused on room reads", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}`, { headers: withBearer("not-a-token") });
    assert.equal(response.status, 401);
  });
});

describe("room control authority in tokenless loopback mode", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness({}); });
  afterAll(async () => { await stopHarness(harness); });

  it("the local user can control a room without copying its owner token", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}/pause`, { method: "POST" });
    assert.equal(response.status, 200);
  });
  it("a room's own owner token may pause it", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}/pause`, {
      method: "POST",
      headers: withBearer(harness.roomAToken)
    });
    assert.equal(response.status, 200);
  });

  it("local administration remains available even when another room token is present", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}/resume`, {
      method: "POST",
      headers: withBearer(harness.roomBToken)
    });
    assert.equal(response.status, 200);
  });

  it("the local user may remove a room without an owner token", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomB}`, { method: "DELETE" });
    assert.equal(response.status, 200);
  });
});

describe("metrics authority", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness({}); });
  afterAll(async () => { await stopHarness(harness); });

  it("the loopback local operator may read metrics", async () => {
    assert.equal((await fetch(`${harness.base}/api/rooms/${harness.roomA}/metrics`)).status, 200);
    assert.equal((await fetch(`${harness.base}/api/rooms/${harness.roomA}/metrics`, {
      headers: withBearer(harness.roomBToken)
    })).status, 200);
  });

  it("the room's owner reads metrics including the quality block", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}/metrics`, {
      headers: withBearer(harness.roomAToken)
    });
    assert.equal(response.status, 200);
    const metrics = await response.json() as {
      quality: { deception: unknown[]; beliefCalibration: unknown[]; voteAccuracy?: unknown[] };
    };
    assert.ok(Array.isArray(metrics.quality.deception), "deception outcomes are present");
    assert.ok(Array.isArray(metrics.quality.beliefCalibration), "belief calibration is present");
    assert.ok(Array.isArray(metrics.quality.voteAccuracy), "werewolf publishes vote accuracy");
  });

  it("the leaderboard is public but only surfaces finished games", async () => {
    const response = await fetch(`${harness.base}/api/leaderboard`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { models: unknown[] };
    assert.ok(Array.isArray(payload.models), "standings are an array (empty until a game finishes)");
    assert.equal(payload.models.length, 0, "no finished games yet — nothing to rank");
  });
});

describe("public projection strips world internals", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness({}); });
  afterAll(async () => { await stopHarness(harness); });

  it("the public room view carries no roles, hidden dice or sealed-move bookkeeping", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}?mode=public`);
    assert.equal(response.status, 200);
    const view = await response.json() as { world: { details: Record<string, unknown> } };
    const details = view.world.details;
    assert.equal(details.roles, undefined, "roles never reach the public projection");
    assert.equal(details.hiddenDice, undefined);
    assert.equal(details.pendingVotes, undefined);
  });

  it("an owner token does not leak private bookkeeping into the public view either", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}?mode=public`, {
      headers: withBearer(harness.roomAToken)
    });
    assert.equal(response.status, 200);
    const view = await response.json() as { world: { details: Record<string, unknown> } };
    assert.equal(view.world.details.roles, undefined, "ownership never upgrades the public projection");
  });
});

describe("tokenless loopback local administration", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness({}); });
  afterAll(async () => { await stopHarness(harness); });

  it("health reports only room, protocol-readiness and path-free storage status", async () => {
    const payload = await fetch(`${harness.base}/api/health`).then((response) => response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["models", "ok", "rooms", "storage"]);
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.rooms, "number");
    assert.deepEqual(Object.keys(payload.models as Record<string, unknown>).sort(), ["enabled", "failed", "ready", "stale"]);
    const storage = payload.storage as { status: string; issues: unknown[] };
    assert.equal(["ok", "degraded"].includes(storage.status), true);
    assert.equal(Array.isArray(storage.issues), true);
    assert.equal(JSON.stringify(payload).includes("baseURL"), false);
    assert.equal(JSON.stringify(payload).includes("model-settings.json"), false);
  });

  it("the local user can manage model config, characters and templates", async () => {
    assert.equal((await fetch(`${harness.base}/api/model-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: [{ id: "intruder", name: "入侵者", kind: "openai-compatible", baseURL: "https://example.invalid", apiMode: "chat-completions", enabled: true }] })
    })).status, 200);
    assert.equal((await fetch(`${harness.base}/api/characters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "入侵者", persona: "一位试图越权创建人物的测试。", traits: ["测试"], values: ["验证"], goals: ["破坏"] })
    })).status, 201);
    assert.equal((await fetch(`${harness.base}/api/room-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "入侵模板", scenarioId: "trust-game", models: ["security-model"] })
    })).status, 201);
  });

  it("local administration does not require stripping an existing room token", async () => {
    const characters = await fetch(`${harness.base}/api/characters`, {
      method: "POST",
      headers: { ...withBearer(harness.roomAToken), "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "房主自建", persona: "一位试图通过房主令牌越权的人物。", traits: ["测试"], values: ["验证"], goals: ["越权"] })
    });
    assert.equal(characters.status, 201);

    const templates = await fetch(`${harness.base}/api/room-templates`, {
      method: "POST",
      headers: { ...withBearer(harness.roomAToken), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "房主模板", scenarioId: "trust-game", models: ["security-model"] })
    });
    assert.equal(templates.status, 201);
  });
});

describe("non-loopback startup protection", () => {
  it("refuses a tokenless non-loopback bind and accepts it with an operator token", () => {
    assert.throws(
      () => createServerContext({ ...process.env, HOST: "0.0.0.0", SOCIETY_OPERATOR_TOKEN: undefined }),
      /LOCAL_ADMIN_UNSAFE_BIND/
    );
    const context = createServerContext({
      ...process.env,
      HOST: "0.0.0.0",
      SOCIETY_OPERATOR_TOKEN: "configured",
      SOCIETY_MODEL_SETTINGS_FILE: path.join(tmpdir(), `society-safe-bind-${Date.now()}.json`)
    });
    assert.equal(context.auth.localAdministrationEnabled(), false);
  });
});

describe("strict operator mode (SOCIETY_OPERATOR_TOKEN configured)", () => {
  const OPERATOR = "operator-secret-token";
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness({ SOCIETY_OPERATOR_TOKEN: OPERATOR }); });
  afterAll(async () => { await stopHarness(harness); });

  it("an owner token alone no longer grants global operations", async () => {
    const response = await fetch(`${harness.base}/api/characters`, {
      method: "POST",
      headers: { ...withBearer(harness.roomAToken), "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "房主自建", persona: "测试。", traits: ["测试"], values: ["验证"], goals: ["越权"] })
    });
    assert.equal(response.status, 403, "owner ≠ operator when an operator token exists");
  });

  it("the configured operator token grants global operations", async () => {
    const response = await fetch(`${harness.base}/api/characters`, {
      method: "POST",
      headers: { ...withBearer(OPERATOR), "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "运营者创建", persona: "一位由运营者创建的人物。", traits: ["尽责"], values: ["秩序"], goals: ["测试"] })
    });
    assert.equal(response.status, 201);
  });

  it("the operator token unlocks room control beyond ownership", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomB}/pause`, {
      method: "POST",
      headers: withBearer(OPERATOR)
    });
    assert.equal(response.status, 200, "operator authority covers any room");
  });
});
