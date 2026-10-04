import type express from "express";
import { z } from "zod";
import { isOperatorFor, requireGlobalOperator, setTokenCookie, tokenFromRequest } from "../auth";
import type { ServerContext } from "../context";
import { humanActionSchema, replayView } from "../../runtime/run";
import { tokenHash, type StoredRun } from "../../runtime/store";
import { RunError, runSpecSchema, scenarioIds, type Character, type Viewer } from "../../runtime/types";
import { SCENARIO_METADATA } from "../../society/scenarios/metadata";
import type { CharacterDefinition } from "../../society/contracts";

export function runtimeCharacter(c: CharacterDefinition): Character {
  return structuredClone({
    id: c.id, name: c.displayName, persona: c.persona, values: c.values, goals: c.goals,
    voice: c.voice ?? "用自己的方式自然表达", traits: c.traits,
    temperament: c.temperament, decisionBiases: c.decisionBiases,
    regulation: c.regulation, autobiographicalAnchors: c.autobiographicalAnchors,
  });
}
export function registerRunRoutes(app: express.Express, context: ServerContext) {
  const service = context.runs;
  function record(id: string) { const run = service.store.get(id); if (!run) throw new RunError("对局不存在", 404); return run; }
  function authority(request: express.Request, run: StoredRun) {
    const token = tokenFromRequest(request);
    const hash = token ? tokenHash(token) : "";
    const owner = hash === run.ownerHash || isOperatorFor(context.auth, request);
    const actorId = Object.entries(run.playerHashes).find(([, v]) => v === hash)?.[0];
    return { owner, actorId };
  }
  function viewer(request: express.Request, run: StoredRun): Viewer {
    const auth = authority(request, run);
    const actorId = typeof request.query.actor === "string" ? request.query.actor : auth.actorId;
    if (actorId && !run.characters.some(c => c.id === actorId)) throw new RunError("人物不在本局", 400);
    if (actorId && actorId !== auth.actorId && !auth.owner) throw new RunError("无权查看该人物的私有视角", 403);
    if (request.query.view === "research" && !auth.owner) throw new RunError("研究视角需要房主权限", 403);
    return { actorId, research: request.query.view === "research" && auth.owner };
  }
  app.get("/api/v2/catalog", (_request, response) => {
    const library = context.characters.list();
    response.json({ scenarios: scenarioIds.map(id => SCENARIO_METADATA[id]), characters: [...library.builtins, ...library.customs].map(runtimeCharacter), customCharacterIds: library.customs.map(c => c.id), models: context.models.listModelProfiles().filter(p => p.enabled && context.models.providerProfile(p.providerProfileId)?.enabled).map(p => ({ id: p.id, name: p.name })), defaultModel: context.models.globalDefaults().modelProfileId });
  });
  app.get("/api/v2/runs", (_request, response) => {
    response.json({ runs: service.store.list().map(r => ({ id: r.id, scenario: r.spec.scenario, status: r.status, createdAt: r.createdAt, characters: r.characters, mode: r.spec.mode, worldId: r.spec.worldId })) });
  });
  app.post("/api/v2/runs", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    const spec = runSpecSchema.parse(request.body);
    if (spec.scenario === "werewolf" && spec.rounds > 8) throw new RunError("狼人杀最多8天", 400);
    const characters = spec.roster.map(s => { const c = context.characters.resolve(s.characterId); if (!c) throw new RunError("人物不存在", 400); return runtimeCharacter(c); });
    const { run, ownerToken, playerTokens } = service.create(spec, characters);
    setTokenCookie(response, ownerToken);
    response.status(201).json({ run: run.view({}), ownerToken, playerTokens });
  });
  app.get("/api/v2/runs/:id", (request, response) => {
    const r = record(request.params.id); const v = viewer(request, r);
    response.json(service.live.get(r.id)?.view(v) ?? replayView(r, service.store, v));
  });
  app.post("/api/v2/runs/:id/restart", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    const source = record(request.params.id);
    const { play } = z.object({ play: z.boolean().default(false) }).strict().parse(request.body);
    const roster = source.spec.roster.map((seat, i) => ({ ...seat, human: play && i === 0 }));
    const psychologySetup = Object.fromEntries(Object.entries(source.spec.psychologySetup ?? {}).filter(([id]) => !roster.some(s => s.characterId === id && s.human)));
    const spec = runSpecSchema.parse({ ...source.spec, mode: "experiment", roster, psychologySetup });
    const created = service.create(spec, structuredClone(source.characters));
    setTokenCookie(response, created.ownerToken);
    response.status(201).json({ run: created.run.view({}), ownerToken: created.ownerToken, playerTokens: created.playerTokens });
  });
  app.get("/api/v2/runs/:id/events", (request, response) => {
    const r = record(request.params.id); const v = viewer(request, r);
    response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-cache"); response.setHeader("Connection", "keep-alive"); response.flushHeaders();
    let previousPayload = "";
    const send = () => {
      if (response.writableEnded) return;
      const payload = JSON.stringify(service.live.get(r.id)?.view(v) ?? replayView(record(r.id), service.store, v));
      if (payload === previousPayload) return;
      previousPayload = payload; response.write(`data: ${payload}\n\n`);
    };
    send(); const unsubscribe = service.live.get(r.id)?.subscribe(send);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20000);
    const untrack = context.liveConnections.track(response);
    request.on("close", () => { clearInterval(heartbeat); unsubscribe?.(); untrack(); });
  });
  app.post("/api/v2/runs/:id/actions", async (request, response) => {
    const r = record(request.params.id); const auth = authority(request, r);
    if (!auth.actorId) throw new RunError("需要该人物的参与令牌", 403);
    const run = service.live.get(r.id); if (!run) throw new RunError("该对局只支持回放");
    await run.humanAction(auth.actorId, humanActionSchema.parse(request.body)); response.json({ accepted: true });
  });
  app.post("/api/v2/runs/:id/control", (request, response) => {
    const r = record(request.params.id); if (!authority(request, r).owner) throw new RunError("需要房主权限", 403);
    const { action } = z.object({ action: z.enum(["pause", "resume", "stop"]) }).strict().parse(request.body);
    const run = service.live.get(r.id); if (!run) throw new RunError("该对局只支持回放，请从初始快照重开");
    run.control(action); response.json({ status: run.status });
  });
  app.get("/api/v2/characters/:id/snapshots", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    response.json({ snapshots: service.store.snapshots(request.params.id) });
  });
  app.get("/api/v2/characters/:id/snapshots/:snapshotId", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    const snapshot = service.store.snapshot(request.params.snapshotId);
    if (!snapshot || snapshot.characterId !== request.params.id) throw new RunError("人物快照不存在", 404);
    const memories = service.store.memories(snapshot.memoryIds).filter(m => request.query.view === "research" || m.kind === "experience" && m.sourceIds.some(id => service.store.event(id)?.visibility === "public"));
    response.json({ snapshot, memories });
  });
  app.get("/api/v2/runs/:id/annotations", (request, response) => {
    const r = record(request.params.id); if (!authority(request, r).owner) throw new RunError("需要研究权限", 403);
    response.json({ annotations: service.store.annotations(r.id) });
  });
  app.post("/api/v2/runs/:id/annotations", (request, response) => {
    const r = record(request.params.id); if (!authority(request, r).owner) throw new RunError("需要研究权限", 403);
    const annotation = z.object({ sourceId: z.string(), outcomeId: z.string(), fulfillment: z.enum(["fulfilled", "violated", "indeterminate"]), note: z.string().max(2000) }).strict().parse(request.body);
    const events = service.store.events(r.id);
    if (!events.some(e => e.id === annotation.sourceId && e.type === "message") || !events.some(e => e.id === annotation.outcomeId && (e.type === "action" || e.data.settlement))) throw new RunError("请选择承诺原话和行动结果", 400);
    response.status(201).json(service.store.annotate(r.id, annotation));
  });
}
