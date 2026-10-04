import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createServerContext } from "../../src/server/context";
import { registerPartnerRoutes } from "../../src/server/routes/partners";
import { PartnerError, PartnerService } from "../../src/partners/service";
import { WorldError } from "../../src/partners/world";
import { fixtureParticipant } from "./fixture";
import { InterventionService } from "../../src/partners/interventions";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function harness() {
  const context = createServerContext({ SOCIETY_OPERATOR_TOKEN: "test-operator", SOCIETY_DATABASE_FILE: ":memory:", SOCIETY_MODEL_SETTINGS_FILE: "data/partners-test-absent.json" });
  context.partners = new PartnerService(context.partners.store, fixtureParticipant);
  context.interventions = new InterventionService(context.partners);
  const app = express(); app.use(express.json()); registerPartnerRoutes(app, context);
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response
    .status(error instanceof PartnerError || error instanceof WorldError ? error.statusCode : error instanceof ZodError ? 400 : 500).json({ message: (error as Error).message }));
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => { context.interventions.stopAll(); context.partners.stopAll(); await context.interventions.settled(); await context.partners.settled(); context.runs.store.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  async function request(url: string, token?: string, body?: unknown) {
    const response = await fetch(base + url, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const create = async () => (await request("/api/partners", "test-operator", { mode: "human", autoStart: false })).data;
  return { request, create, context };
}
describe("Partners authority and checkpoint isolation", () => {
  it("separates spectators, player secrets, researcher cases and global model administration", async () => {
    const h = await harness(); const one = await h.create(); const two = await h.create();
    expect((await h.request("/api/partners", undefined, { mode: "human" })).status).toBe(403);
    const url = `/api/partners/${one.id}`;
    const publicView = await h.request(url);
    expect(publicView.status).toBe(200); expect(publicView.data.observation.self).toBeUndefined(); expect(publicView.data.research).toBeUndefined();
    expect(JSON.stringify(publicView.data)).not.toContain("ownerHash");
    const player = await h.request(url, one.playerToken);
    expect(player.data.observation.self.id).toBe("a"); expect(player.data.observation.actors.b.wallet).toBeUndefined();
    expect((await h.request(url + "?actor=b", one.playerToken)).status).toBe(403);
    expect((await h.request(url + "?view=research", one.playerToken)).status).toBe(403);
    expect((await h.request(url + "?view=research", two.ownerToken)).status).toBe(403);
    const researcher = await h.request(url + "?view=research", one.ownerToken);
    expect(researcher.data.research.world.actors.b.wallet).toBe(18);
    expect((await h.request(url + "/export", one.playerToken)).status).toBe(403);
    expect((await h.request(url + "/cases", two.ownerToken)).status).toBe(403);
    expect((await h.request(url + "/decisions", one.playerToken)).status).toBe(403);
    expect((await h.request(url + "/runtime/events", one.playerToken)).status).toBe(403);
    expect((await h.request(url + "/runtime/events", two.ownerToken)).status).toBe(403);
    expect((await h.request(url + "/runtime/events")).status).toBe(403);
    expect((await h.request(url + "/control", one.playerToken, { command: "resume" })).status).toBe(403);
    expect((await h.request(url + "/actions", one.ownerToken, { expectedRevision: 0, commandId: "bad", action: { type: "exit" } })).status).toBe(403);
    expect((await h.request(url + "?token=" + encodeURIComponent(one.ownerToken) + "&view=research")).status).toBe(403);
  });
  it("cannot fork another run's checkpoint or expose a research batch with a player token", async () => {
    const h = await harness(); const one = await h.create(); const two = await h.create();
    expect((await h.request(`/api/partners/${one.id}/forks`, one.ownerToken, { checkpointId: `${two.id}:0`, autoStart: false })).status).toBe(404);
    const result = await h.request(`/api/partners/${one.id}/forks`, one.ownerToken, { checkpointId: `${one.id}:0`, autoStart: false });
    expect(result.status).toBe(201); expect(result.data.id).not.toBe(one.id);
    expect((await h.request(`/api/partners/${result.data.id}?view=research`, one.ownerToken)).status).toBe(403);
    const study = await h.request("/api/partners/studies", "test-operator", { agreeableness: [0.2], repeats: 1, mechanisms: ["full"] });
    expect(study.status).toBe(201);
    expect((await h.request(`/api/partners/studies/${study.data.study.id}`, one.playerToken)).status).toBe(403);
    expect((await h.request(`/api/partners/studies/${study.data.study.id}`, study.data.ownerToken)).status).toBe(200);
  });
  it("protects intervention configuration, private cases and failure-inclusive exports with batch authority", async () => {
    const h = await harness(); const player = await h.create();
    expect((await h.request("/api/partners/interventions", player.playerToken, {})).status).toBe(403);
    const created = await h.request("/api/partners/interventions", "test-operator", { repeats: 1 });
    expect(created.status).toBe(201);
    const id = created.data.experiment.id; const url = `/api/partners/interventions/${id}`;
    for (const suffix of ["", "/analysis", "/export"]) expect((await h.request(url + suffix, player.ownerToken)).status).toBe(403);
    expect((await h.request(url, created.data.ownerToken)).status).toBe(200);
    const row = created.data.experiment.rows[0];
    expect((await h.request(`/api/partners/${row.runId}?view=research`, created.data.ownerToken)).status).toBe(200);
    expect((await h.request(url + "/control", player.playerToken, { command: "resume" })).status).toBe(403);
    expect((await h.request(url + "/control", created.data.ownerToken, { command: "resume" })).status).toBe(200);
    await h.context.interventions.settled();
    const summaries = await h.request(`/api/partners/${row.runId}/decisions`, created.data.ownerToken);
    expect(summaries.data.decisions).toHaveLength(1);
    expect(summaries.data.decisions[0].exchanges).toBeUndefined();
    expect(summaries.data.decisions[0].observation).toBeUndefined();
    expect((await h.request(url + "/export", created.data.ownerToken)).data.branches).toHaveLength(4);
  });
});
