import type express from "express";
import { z } from "zod";
import { isOperatorFor, requireGlobalOperator, tokenFromRequest } from "../auth";
import type { ServerContext } from "../context";
import { PartnerError } from "../../partners/service";
import { hashToken } from "../../partners/store";
import type { ActorId } from "../../partners/contracts";
import { analyzeStudy } from "../../partners/analysis";
import { interventionSpecSchema } from "../../partners/intervention-types";

const unit = z.number().min(0).max(1);
const mechanism = z.enum(["full", "no-inertia", "no-mind", "record-only"]);
const protocol = z.literal("responses-v1").default("responses-v1");
const actorSettings = z.object({ name: z.string().trim().min(1).max(40).optional(), privateObjective: z.string().trim().min(1).max(800).optional() }).strict();
const createSchema = z.object({ mode: z.enum(["human", "observe"]), maxRounds: z.number().int().min(1).max(6).default(3),
  agreeableness: z.tuple([unit, unit]).optional(), mechanism: mechanism.default("full"), seed: z.number().int().min(0).max(2147483647).default(1), autoStart: z.boolean().optional(),
  protocol, actorSettings: z.object({ a: actorSettings.optional(), b: actorSettings.optional() }).strict().optional() }).strict();
const speech = { message: z.string().max(600).optional(), intent: z.string().max(600).optional() };
const amount = z.number().int().min(0).max(1000000);
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), promiseRatio: unit, collateral: amount, ...speech }).strict(),
  z.object({ type: z.literal("invest"), amount, ...speech }).strict(),
  z.object({ type: z.literal("settle"), returnAmount: amount, claimedIncome: amount.optional(), revealIncome: z.boolean().optional(), ...speech }).strict(),
  z.object({ type: z.literal("repair"), compensation: amount, ...speech }).strict(),
  z.object({ type: z.literal("respond"), choice: z.enum(["continue", "exit"]), ...speech }).strict(),
  z.object({ type: z.literal("exit"), ...speech }).strict(),
]);
const studySchema = z.object({ repeats: z.number().int().min(1).max(5).default(1), agreeableness: z.array(unit).min(1).max(2).default([0.2, 0.8]),
  protocol, mechanisms: z.array(mechanism).min(1).max(4).default(["full"]), maxRounds: z.number().int().min(3).max(6).default(3), seed: z.number().int().min(0).max(2147483647).default(1) }).strict();

export function registerPartnerRoutes(app: express.Express, context: ServerContext): void {
  const service = context.partners;
  const authority = (request: express.Request, id: string) => {
    const run = service.get(id); const token = tokenFromRequest(request); const hash = token ? hashToken(token) : "";
    return { owner: hash === run.ownerHash || isOperatorFor(context.auth, request), actorId: (Object.entries(run.playerHashes).find(([, value]) => value === hash)?.[0]) as ActorId | undefined };
  };
  const owner = (request: express.Request, id: string): void => { if (!authority(request, id).owner) throw new PartnerError("需要本局研究权限", 403); };
  const studyOwner = (request: express.Request, id: string): void => {
    const token = tokenFromRequest(request);
    if (!(token && hashToken(token) === service.getStudy(id).ownerHash) && !isOperatorFor(context.auth, request)) throw new PartnerError("需要本实验研究权限", 403);
  };
  const interventionOwner = (request: express.Request, id: string): void => {
    const token = tokenFromRequest(request);
    if (!(token && hashToken(token) === context.interventions.get(id).ownerHash) && !isOperatorFor(context.auth, request)) throw new PartnerError("需要本心理干预实验的研究权限", 403);
  };
  app.get("/api/partners", (_request, response) => response.json({ runs: service.list() }));
  app.post("/api/partners", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    response.status(201).json(service.create(createSchema.parse(request.body)));
  });
  app.get("/api/partners/interventions", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    response.json({ experiments: context.interventions.list() });
  });
  app.post("/api/partners/interventions", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    const spec = interventionSpecSchema.parse(request.body);
    if (spec.sourceRunId) owner(request, spec.sourceRunId);
    response.status(201).json(context.interventions.create(spec));
  });
  app.get("/api/partners/interventions/:id", (request, response) => {
    interventionOwner(request, request.params.id); response.json(context.interventions.view(request.params.id));
  });
  app.post("/api/partners/interventions/:id/control", (request, response) => {
    interventionOwner(request, request.params.id);
    const { command } = z.object({ command: z.enum(["pause", "resume", "stop"]) }).strict().parse(request.body);
    context.interventions.control(request.params.id, command); response.json(context.interventions.view(request.params.id));
  });
  app.get("/api/partners/interventions/:id/analysis", (request, response) => {
    interventionOwner(request, request.params.id); response.json(context.interventions.analysis(request.params.id));
  });
  app.get("/api/partners/interventions/:id/export", (request, response) => {
    interventionOwner(request, request.params.id); response.attachment(`partners-intervention-${request.params.id}.json`).json(context.interventions.export(request.params.id));
  });
  app.get("/api/partners/studies", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    response.json({ studies: service.store.studies().map(study => service.studyView(study.id)) });
  });
  app.post("/api/partners/studies", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    response.status(201).json(service.createStudy(studySchema.parse(request.body)));
  });
  app.get("/api/partners/studies/:id", (request, response) => { studyOwner(request, request.params.id); response.json(service.studyView(request.params.id)); });
  app.post("/api/partners/studies/:id/control", (request, response) => {
    studyOwner(request, request.params.id); const { command } = z.object({ command: z.enum(["pause", "resume", "stop"]) }).strict().parse(request.body);
    service.studyControl(request.params.id, command); response.json(service.studyView(request.params.id));
  });
  app.get("/api/partners/studies/:id/export", (request, response) => {
    studyOwner(request, request.params.id);
    response.attachment(`partners-study-${request.params.id}.json`).json({ study: service.studyView(request.params.id),
      analysis: analyzeStudy(service.studyView(request.params.id), service.getStudy(request.params.id).rows.map(row => service.get(row.runId))),
      branches: service.getStudy(request.params.id).rows.map(row => service.exportRun(row.runId)) });
  });
  app.get("/api/partners/studies/:id/analysis", (request, response) => {
    studyOwner(request, request.params.id);
    response.json(analyzeStudy(service.studyView(request.params.id), service.getStudy(request.params.id).rows.map(row => service.get(row.runId))));
  });
  app.get("/api/partners/:id", (request, response) => {
    const auth = authority(request, request.params.id);
    const actorId = request.query.actor === undefined ? auth.actorId : z.enum(["a", "b"]).parse(request.query.actor);
    if (actorId && actorId !== auth.actorId && !auth.owner) throw new PartnerError("无权查看另一人物的私有信息", 403);
    const snapshot = service.snapshot(request.params.id, { ...auth, actorId, research: request.query.view === "research" });
    response.setHeader("Cache-Control", "no-store"); response.json(snapshot);
  });
  app.post("/api/partners/:id/actions", (request, response) => {
    const auth = authority(request, request.params.id);
    if (!auth.actorId) throw new PartnerError("需要对应玩家的参与令牌", 403);
    const body = z.object({ expectedRevision: z.number().int().min(0), commandId: z.string().min(1).max(100), action }).strict().parse(request.body);
    service.humanAction(request.params.id, auth.actorId, body); response.json({ accepted: true });
  });
  app.post("/api/partners/:id/control", (request, response) => {
    owner(request, request.params.id); const { command } = z.object({ command: z.enum(["pause", "resume", "step", "stop"]) }).strict().parse(request.body);
    service.control(request.params.id, command); response.json({ status: service.get(request.params.id).status });
  });
  app.get("/api/partners/:id/checkpoints", (request, response) => {
    owner(request, request.params.id); response.json({ checkpoints: service.store.checkpoints(request.params.id).map(({ id, revision, round, phase, createdAt }) => ({ id, revision, round, phase, createdAt })) });
  });
  app.get("/api/partners/:id/checkpoints/:checkpointId", (request, response) => {
    owner(request, request.params.id);
    const checkpoint = service.store.getCheckpoint(request.params.checkpointId);
    if (!checkpoint || checkpoint.runId !== request.params.id) throw new PartnerError("检查点不属于本局", 404);
    const { id, revision, round, phase, createdAt } = checkpoint;
    response.json({ checkpoint: { id, revision, round, phase, createdAt }, world: checkpoint.state.world, minds: checkpoint.state.minds });
  });
  app.post("/api/partners/:id/forks", (request, response) => {
    owner(request, request.params.id);
    const body = z.object({ checkpointId: z.string().min(1), intervention: z.object({ kind: z.enum(["none", "apology", "compensation"]), amount: amount.optional() }).strict().optional(), autoStart: z.boolean().optional() }).strict().parse(request.body);
    response.status(201).json(service.fork(request.params.id, body));
  });
  app.get("/api/partners/:id/cases", (request, response) => { owner(request, request.params.id); response.json({ cases: service.store.cases(request.params.id) }); });
  app.get("/api/partners/:id/runtime/events", (request, response) => {
    const id = request.params.id; owner(request, id);
    response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "keep-alive"); response.setHeader("X-Accel-Buffering", "no"); response.flushHeaders();
    const send = (activities: ReturnType<typeof service.runtimeActivities>, reset = false) => {
      if (response.writableEnded || response.destroyed) return;
      if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
      response.write(`data: ${JSON.stringify({ activities, reset })}\n\n`);
    };
    send(service.runtimeActivities(id), true);
    const unsubscribe = service.subscribeRuntime(id, activities => send(activities));
    const heartbeat = setInterval(() => { if (!response.writableEnded) response.write(": heartbeat\n\n"); }, 20000);
    const untrack = context.liveConnections.track(response);
    response.on("close", () => { clearInterval(heartbeat); unsubscribe(); untrack(); });
  });
  app.get("/api/partners/:id/decisions", (request, response) => { owner(request, request.params.id); response.json({ decisions: service.store.decisionSummaries(request.params.id) }); });
  app.post("/api/partners/:id/cases/:caseId/replay", (request, response) => {
    owner(request, request.params.id);
    const decision = service.store.cases(request.params.id).find(c => c.id === request.params.caseId);
    if (!decision) throw new PartnerError("决策案例不存在", 404);
    const fork = service.fork(request.params.id, { checkpointId: `${request.params.id}:${decision.revision}`, autoStart: false });
    service.control(fork.id, "step"); response.status(201).json(fork);
  });
  app.get("/api/partners/:id/export", (request, response) => {
    owner(request, request.params.id); response.attachment(`partners-${request.params.id}.json`).json(service.exportRun(request.params.id));
  });
}
