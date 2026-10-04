import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createServerContext } from "../../src/server/context";
import { registerRunRoutes } from "../../src/server/routes/runs";
import { registerStudyRoutes } from "../../src/server/routes/studies";
import { RunError, runSpecSchema, type ParticipantFactory } from "../../src/runtime/types";
import { RunService } from "../../src/runtime/run";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function harness(factory?: ParticipantFactory) {
  const context = createServerContext({ SOCIETY_OPERATOR_TOKEN: "test-operator", SOCIETY_DATABASE_FILE: ":memory:", SOCIETY_MODEL_SETTINGS_FILE: "data/test-not-present.json" });
  if (factory) context.runs = new RunService(context.runs.store, factory);
  const app = express(); app.use(express.json()); registerRunRoutes(app, context); registerStudyRoutes(app, context);
  app.use((e: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(e instanceof RunError ? e.statusCode : e instanceof ZodError ? 400 : 500).json({ message: (e as Error).message }));
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(async () => { context.runs.stopAll(); await Promise.all([...context.runs.live.values()].map(r => r.settled())); context.runs.store.close(); await new Promise<void>(r => server.close(() => r())); });
  async function request(url: string, token?: string, body?: unknown) {
    const response = await fetch(base + url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function create(human = true) { return (await request("/api/v2/runs", "test-operator", { scenario: "trust-game", mode: "experiment", roster: ["builtin-01", "builtin-02"].map(characterId => ({ characterId, human })), rounds: 2 })).data; }
  return { request, create, context };
}
describe("v2 authority and projection", () => {
  it("restarts archived participants absent from the character catalog into a separate authorized run", async () => {
    const h = await harness(() => ({ async turn(c) { for (const action of c.opportunity.actions) await c.call(action.name, { amount: 0 }); return { waited: true }; } }));
    const characters = ["archived-a", "archived-b"].map(id => ({ id, name: id, persona: "档案人物", goals: [], values: [], voice: "" }));
    const source = h.context.runs.create(runSpecSchema.parse({ scenario: "trust-game", mode: "experiment", roster: characters.map(c => ({ characterId: c.id, human: true })) }), characters);
    const before = JSON.stringify(h.context.runs.store.events(source.run.id));
    const url = `/api/v2/runs/${source.run.id}/restart`;
    expect((await h.request(url, undefined, { play: true })).status).toBe(403);
    expect((await h.request(url, source.ownerToken, { play: true })).status).toBe(403);
    const restarted = await h.request(url, "test-operator", { play: true });
    expect(restarted.status).toBe(201);
    expect(restarted.data.run.id).not.toBe(source.run.id);
    expect(restarted.data.run.characters.map((c: { id: string }) => c.id)).toEqual(characters.map(c => c.id));
    expect(Object.keys(restarted.data.playerTokens)).toEqual(["archived-a"]);
    expect(JSON.stringify(h.context.runs.store.events(source.run.id))).toBe(before);
  });
  it("audits legacy truncation without rewriting cases and isolates controlled branch case lists", async () => {
    const h = await harness(); const a = await h.create(); const store = h.context.runs.store;
    const study = { id: "study-a", trials: [{ id: "branch-a", group: "g" }], prefixes: [{ group: "g", caseRunId: "common" }] }; store.saveStudy(study);
    const record = { id: "broken-original", runId: "branch-a", actorId: "self", opportunityId: "op", phase: "psychology", createdAt: "", sourceHash: "old", context: {}, configuration: {}, durationMs: 0, request: { modelSettings: { maxTokens: 8192 } }, response: { providerData: { choices: [{ finish_reason: "tool_calls" }] }, usage: { outputTokens: 8192 }, output: [{ type: "function_call", name: "update_mind", arguments: '{"unfinished":' }] } };
    store.saveCase(record); store.saveCase({ ...record, id: "prefix-case", runId: "common" });
    store.saveCase({ ...record, id: "outside", runId: "unrelated" });
    store.saveCase({ ...record, id: "replay", originCaseId: record.id });
    const endpoint = "/api/v2/studies/study-a/trials/branch-a/decision-cases";
    expect((await h.request(endpoint)).status).toBe(403);
    expect((await h.request(endpoint, a.ownerToken)).status).toBe(403);
    expect((await h.request(endpoint, "test-operator")).data.cases.map((c: { id: string }) => c.id).sort()).toEqual(["broken-original", "prefix-case", "replay"]);
    expect((await h.request("/api/v2/studies/study-a/trials/outside/decision-cases", "test-operator")).status).toBe(404);
    expect((await h.request("/api/v2/studies/study-a/diagnostics")).status).toBe(403);
    expect((await h.request("/api/v2/studies/study-a/diagnostics", "test-operator")).data).toMatchObject({ requests: 2, errors: 2, truncations: 2, malformedArguments: 2 });
    expect(store.getCase(record.id)).toEqual(record);
  });
  it("restricts cases to their run owner and studies to the operator", async () => {
    const h = await harness(); const a = await h.create(); const b = await h.create();
    h.context.runs.store.saveCase({ id: "private-case", runId: a.run.id, actorId: "builtin-01", opportunityId: "op", phase: "psychology", createdAt: "", sourceHash: "hash", context: { private: "private mental state" }, configuration: {}, request: {}, durationMs: 0 });
    expect((await h.request("/api/v2/studies")).status).toBe(403);
    expect((await h.request("/api/v2/studies", a.ownerToken)).status).toBe(403);
    expect((await h.request("/api/v2/studies", "test-operator")).status).toBe(200);
    expect((await h.request("/api/v2/decision-cases/private-case")).status).toBe(403);
    expect((await h.request("/api/v2/decision-cases/private-case", a.playerTokens["builtin-01"])).status).toBe(403);
    expect((await h.request("/api/v2/decision-cases/private-case", b.ownerToken)).status).toBe(403);
    expect((await h.request("/api/v2/decision-cases/private-case/replay", b.ownerToken, {})).status).toBe(403);
    expect((await h.request("/api/v2/decision-cases/private-case", a.ownerToken)).data.context.private).toBe("private mental state");
    expect((await h.request(`/api/v2/runs/${a.run.id}/decision-cases`, a.ownerToken)).data.cases).toHaveLength(1);
    expect((await h.request(`/api/v2/runs/${a.run.id}`)).data.events.some((e: { text: string }) => e.text.includes("private mental state"))).toBe(false);
  });
  it("requires operator to create and never exposes private facts or seed to public viewers", async () => {
    const h = await harness(); expect((await h.request("/api/v2/runs", undefined, {})).status).toBe(403);
    const { run, ownerToken } = await h.create();
    const publicView = await h.request(`/api/v2/runs/${run.id}`);
    expect(publicView.data.spec).toBeUndefined(); expect(publicView.data.opportunities).toEqual([]);
    expect(publicView.data.events.every((e: { visibility: string }) => e.visibility === "public")).toBe(true);
    expect((await h.request(`/api/v2/runs/${run.id}?view=research`)).status).toBe(403);
    expect((await h.request(`/api/v2/runs/${run.id}?view=research`, ownerToken)).status).toBe(200);
  });
  it("isolates player/owner credentials across runs and rejects duplicate human speech", async () => {
    const h = await harness(); const a = await h.create(); const b = await h.create();
    expect((await h.request(`/api/v2/runs/${b.run.id}/control`, a.ownerToken, { action: "pause" })).status).toBe(403);
    expect((await h.request(`/api/v2/runs/${a.run.id}?actor=builtin-02`, a.playerTokens["builtin-01"])).status).toBe(403);
    const view = await h.request(`/api/v2/runs/${a.run.id}?actor=builtin-01`, a.playerTokens["builtin-01"]);
    const opportunityId = view.data.opportunities[0].id;
    const payload = { opportunityId, action: "speak", input: { text: "先听听你的想法。" } };
    expect((await h.request(`/api/v2/runs/${a.run.id}/actions`, a.playerTokens["builtin-01"], payload)).status).toBe(200);
    expect((await h.request(`/api/v2/runs/${a.run.id}/actions`, a.playerTokens["builtin-01"], payload)).status).toBe(409);
    const current = await h.request(`/api/v2/runs/${a.run.id}`);
    expect(current.data.events.filter((e: { text: string }) => e.text === payload.input.text)).toHaveLength(1);
  });
  it("keeps private conversation outside the public stream and authenticates snapshots", async () => {
    const h = await harness(); const a = await h.create();
    const view = await h.request(`/api/v2/runs/${a.run.id}?actor=builtin-01`, a.playerTokens["builtin-01"]);
    expect((await h.request(`/api/v2/runs/${a.run.id}/actions`, a.playerTokens["builtin-01"], { opportunityId: view.data.opportunities[0].id, action: "send_message", input: { channel: "private", recipients: ["builtin-02"], text: "我想先私下谈谈。" } })).status).toBe(200);
    const publicView = await h.request(`/api/v2/runs/${a.run.id}`);
    const privateView = await h.request(`/api/v2/runs/${a.run.id}?actor=builtin-02`, a.playerTokens["builtin-02"]);
    expect(publicView.data.events.some((e: { text: string }) => e.text === "我想先私下谈谈。")).toBe(false);
    expect(privateView.data.events.some((e: { text: string }) => e.text === "我想先私下谈谈。")).toBe(true);
    expect((await h.request("/api/v2/characters/builtin-01/snapshots", a.ownerToken)).status).toBe(403);
  });
  it("projects snapshot details and never grants a room owner access to the character library", async () => {
    const h = await harness(() => {
      let sent = false;
      return { async turn(c) {
        if (c.opportunity.actions.length) { for (const a of c.opportunity.actions) await c.call(a.name, { amount: 0 }); return {}; }
        if (!sent) {
          sent = true;
          const source = c.recent.find(e => e.type === "fact")!;
          await c.call("remember", { text: "我想先观察一下。", sourceIds: [source.id], about: [c.character.id] });
          if (c.character.id === "builtin-01") await c.call("send_message", { channel: "private", recipients: ["builtin-02"], text: "只有我们知道的试探。" });
          else return { text: "我还在考虑。" };
        }
        return { waited: true };
      } };
    });
    const created = await h.create(false); await h.context.runs.live.get(created.run.id)?.settled();
    const snapshot = h.context.runs.store.snapshots("builtin-01")[0];
    expect(snapshot).toBeDefined();
    const url = `/api/v2/characters/builtin-01/snapshots/${snapshot.id}`;
    expect((await h.request(url)).status).toBe(403);
    expect((await h.request(url, created.ownerToken)).status).toBe(403);
    expect((await h.request(`/api/v2/characters/builtin-02/snapshots/${snapshot.id}`, "test-operator")).status).toBe(404);
    const normal = await h.request(url, "test-operator");
    expect(normal.data.memories.every((m: { kind: string }) => m.kind === "experience")).toBe(true);
    expect(normal.data.memories.some((m: { text: string }) => m.text === "只有我们知道的试探。")).toBe(false);
    const research = await h.request(`${url}?view=research`, "test-operator");
    expect(research.data.memories.some((m: { kind: string }) => m.kind === "note")).toBe(true);
    expect(research.data.memories.some((m: { text: string }) => m.text === "只有我们知道的试探。")).toBe(true);
  });
});
