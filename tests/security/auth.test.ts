/**
 * API security checks (AGENTS.md §18 / P0-05): anonymous viewers stay PUBLIC,
 * omniscient / agent-pov need real authority, control ops need owner or
 * operator tokens, archives split public from forensic, and global writes are
 * operator-gated with the dual-track owner fallback. HTTP-level tests against
 * the real route stack — no model calls, no network.
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
    SOCIETY_SEASON_FILE: path.join(dir, "season.json"),
    SOCIETY_CHARACTERS_FILE: path.join(dir, "characters.json"),
    SOCIETY_TEMPLATES_FILE: path.join(dir, "templates.json"),
    OPENAI_API_KEY: undefined,
    ...env
  };
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const context = createServerContext();
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

  const create = async (scenarioId: string, extra: Record<string, unknown> = {}): Promise<{ id: string; ownerToken: string }> => {
    const response = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId, mode: "ai", ...extra })
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
  rmSync(path.resolve("data", "rooms", harness.roomA), { recursive: true, force: true });
  rmSync(path.resolve("data", "rooms", harness.roomB), { recursive: true, force: true });
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

describe("room control authority", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness({}); });
  afterAll(async () => { await stopHarness(harness); });

  it("anonymous control requests are forbidden", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}/pause`, { method: "POST" });
    assert.equal(response.status, 403);
  });

  it("a room's own owner token may pause it", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}/pause`, {
      method: "POST",
      headers: withBearer(harness.roomAToken)
    });
    assert.equal(response.status, 200);
  });

  it("another room's owner token cannot control this room", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}/resume`, {
      method: "POST",
      headers: withBearer(harness.roomBToken)
    });
    assert.equal(response.status, 403, "owner tokens are scoped to their room");
  });

  it("removing a room needs the owner token too", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomB}`, { method: "DELETE" });
    assert.equal(response.status, 403);
  });
});

describe("archive layering", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness({}); });
  afterAll(async () => { await stopHarness(harness); });

  it("the public archive carries no minds, session files or world internals", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}/archive`);
    assert.equal(response.status, 200);
    const archive = await response.json() as Record<string, unknown>;
    assert.equal(archive.agentMinds, undefined, "minds never leave via the public archive");
    assert.equal(archive.sessionFiles, undefined);
    const snapshot = archive.snapshot as { world: { details: Record<string, unknown> } };
    assert.deepEqual(snapshot.world.details, {}, "world internals (roles etc.) are stripped");
  });

  it("the operator's forensic archive keeps minds but never file paths", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}/archive`, {
      headers: withBearer(harness.roomAToken) // dual-track fallback: owner acts as operator
    });
    assert.equal(response.status, 200);
    const archive = await response.json() as Record<string, unknown>;
    assert.ok(archive.agentMinds, "the forensic archive keeps minds");
    assert.equal(archive.sessionFiles, undefined, "session file paths never cross the wire");
    assert.ok(typeof archive.sessionCount === "number");
  });
});

describe("global operations under the dual-track fallback", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness({}); });
  afterAll(async () => { await stopHarness(harness); });

  it("anonymous writes to season, settings and characters are forbidden", async () => {
    assert.equal((await fetch(`${harness.base}/api/season`, { method: "DELETE" })).status, 403);
    assert.equal((await fetch(`${harness.base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseURL: "https://example.invalid" })
    })).status, 403);
    assert.equal((await fetch(`${harness.base}/api/characters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "入侵者", persona: "一位试图越权创建人物的测试。", traits: ["测试"], values: ["验证"], goals: ["破坏"] })
    })).status, 403);
  });

  it("without an operator token configured, an owner token acts as operator", async () => {
    assert.equal((await fetch(`${harness.base}/api/season`, {
      method: "DELETE",
      headers: withBearer(harness.roomAToken)
    })).status, 200, "season reset via owner fallback");
    const characters = await fetch(`${harness.base}/api/characters`, {
      method: "POST",
      headers: { ...withBearer(harness.roomAToken), "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "房主自建", persona: "一位通过房主回退权限创建的人物。", traits: ["测试"], values: ["验证"], goals: ["通过"] })
    });
    assert.equal(characters.status, 201, "character creation via owner fallback");
    const templates = await fetch(`${harness.base}/api/room-templates`, {
      method: "POST",
      headers: { ...withBearer(harness.roomAToken), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tpl", scenarioId: "trust-game" })
    });
    assert.ok(templates.status === 201 || templates.status === 400, "template write gate passes (schema may reject the stub body)");
  });
});

describe("strict operator mode (SOCIETY_OPERATOR_TOKEN configured)", () => {
  const OPERATOR = "operator-secret-token";
  let harness: Harness;
  beforeAll(async () => { harness = await startHarness({ SOCIETY_OPERATOR_TOKEN: OPERATOR }); });
  afterAll(async () => { await stopHarness(harness); });

  it("an owner token alone no longer grants global operations", async () => {
    const response = await fetch(`${harness.base}/api/season`, {
      method: "DELETE",
      headers: withBearer(harness.roomAToken)
    });
    assert.equal(response.status, 403, "owner ≠ operator when an operator token exists");
  });

  it("the configured operator token grants global operations", async () => {
    const response = await fetch(`${harness.base}/api/season`, {
      method: "DELETE",
      headers: withBearer(OPERATOR)
    });
    assert.equal(response.status, 200);
  });

  it("the operator token also unlocks the forensic archive", async () => {
    const response = await fetch(`${harness.base}/api/rooms/${harness.roomA}/archive`, {
      headers: withBearer(OPERATOR)
    });
    assert.equal(response.status, 200);
    const archive = await response.json() as Record<string, unknown>;
    assert.ok(archive.agentMinds, "operator archive includes minds");
  });
});