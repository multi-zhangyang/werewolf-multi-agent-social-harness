import type express from "express";
import { requireGlobalOperator, isOperatorFor, tokenFromRequest } from "../auth";
import type { ServerContext } from "../context";
import { RunError } from "../../runtime/types";
import { tokenHash } from "../../runtime/store";
import type { StudyRecord, TrialResult } from "../../runtime/studies";
import { replayDecisionCase } from "../../runtime/replay-case";
import { summarizeTrials } from "../../runtime/study-metrics";
import { inspectModelResponse } from "../../runtime/model";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { nativeConfiguration } from "../../agents/sdk";

export function registerStudyRoutes(app: express.Express, context: ServerContext) {
  const store = context.runs.store;
  const study = (id: string) => { const r = store.study<StudyRecord>(id); if (!r) throw new RunError("实验不存在", 404); return r; };
  const diagnosticCache = new Map<string, { revision: number; value: { requests: number; responses: number; errors: number; truncations: number; malformedArguments: number } }>();
  app.get("/api/v2/studies", (req, res) => { if (!requireGlobalOperator(req, res, context.auth)) return; res.json({ studies: store.studies<StudyRecord>() }); });
  app.post("/api/v2/studies", (req, res) => {
    if (!requireGlobalOperator(req, res, context.auth)) return;
    let modelProfileId: string | undefined;
    try { modelProfileId = nativeConfiguration(context.models).modelProfileId; }
    catch (error) { throw new RunError((error as Error).message, 400); }
    res.status(201).json(context.studies.create({ ...req.body, modelProfileId }));
  });
  app.get("/api/v2/studies/:id", (req, res) => { if (!requireGlobalOperator(req, res, context.auth)) return; res.json(study(req.params.id)); });
  app.get("/api/v2/studies/:id/diagnostics", (req, res) => {
    if (!requireGlobalOperator(req, res, context.auth)) return;
    const r = study(req.params.id);
    const runIds = [...r.trials.map(t => t.runId ?? t.id), ...(r.prefixes ?? []).map(p => p.caseRunId)];
    const revision = (store.db.prepare(`SELECT coalesce(max(rowid),0) as revision FROM decision_cases WHERE run_id IN (${runIds.map(() => "?").join(",")})`).get(...runIds) as { revision: number }).revision;
    let cached = diagnosticCache.get(r.id);
    if (!cached || cached.revision !== revision) {
      const cases = runIds.flatMap(id => store.cases(id)).filter(c => !c.originCaseId);
      const inspected = cases.map(c => c.response ? inspectModelResponse(c.response as ModelResponse, c.request as ModelRequest) : { error: c.error });
      cached = { revision, value: { requests: cases.length, responses: cases.filter(c => c.response).length, errors: cases.filter((c, i) => c.error || inspected[i].error).length, truncations: inspected.filter(r => "outputError" in r && r.outputError === "truncated").length, malformedArguments: inspected.filter(r => r.error?.includes("不是完整 JSON")).length } };
      diagnosticCache.set(r.id, cached);
    }
    res.json(cached.value);
  });
  app.get("/api/v2/studies/:id/trials/:trialId/decision-cases", (req, res) => {
    if (!requireGlobalOperator(req, res, context.auth)) return;
    const r = study(req.params.id); const trial = r.trials.find(t => t.id === req.params.trialId);
    if (!trial) throw new RunError("该分支不属于此实验", 404);
    const prefix = r.prefixes?.find(p => p.group === trial.group)?.caseRunId;
    res.json({ cases: [trial.runId ?? trial.id, ...(prefix ? [prefix] : [])].flatMap(runId => store.cases(runId).map(c => ({ id: c.id, actorId: c.actorId, phase: c.phase, durationMs: c.durationMs, error: c.error, originCaseId: c.originCaseId, sharedPrefix: runId === prefix }))) });
  });
  app.post("/api/v2/studies/:id/stop", (req, res) => { if (!requireGlobalOperator(req, res, context.auth)) return; study(req.params.id); context.studies.stop(req.params.id); res.json({ accepted: true }); });
  app.get("/api/v2/studies/:id/trials/:trialId", (req, res) => { if (!requireGlobalOperator(req, res, context.auth)) return; study(req.params.id); const result = store.trial<TrialResult>(req.params.id, req.params.trialId); if (!result) throw new RunError("试验尚无结果", 404); res.json(result); });
  app.get("/api/v2/studies/:id/export", (req, res) => { if (!requireGlobalOperator(req, res, context.auth)) return; const r = study(req.params.id); res.json({ study: r, summary: summarizeTrials(r.trials), results: r.trials.map(t => store.trial<TrialResult>(r.id, t.id) ?? t) }); });
  function caseAccess(req: express.Request, id: string) {
    const record = store.getCase(id); if (!record) throw new RunError("决策案例不存在", 404);
    const run = store.get(record.runId); const token = tokenFromRequest(req);
    if (!isOperatorFor(context.auth, req) && !(run && token && tokenHash(token) === run.ownerHash)) throw new RunError("需要研究权限", 403);
    return record;
  }
  app.get("/api/v2/decision-cases/:id", (req, res) => res.json(caseAccess(req, req.params.id)));
  app.post("/api/v2/decision-cases/:id/replay", async (req, res) => { const result = await replayDecisionCase(caseAccess(req, req.params.id), context.models, req.body ?? {}); store.saveCase(result); res.status(201).json(result); });
  app.get("/api/v2/runs/:id/decision-cases", (req, res) => {
    const r = store.get(req.params.id); const token = tokenFromRequest(req);
    if (!r) throw new RunError("对局不存在", 404);
    if (!isOperatorFor(context.auth, req) && !(token && tokenHash(token) === r.ownerHash)) throw new RunError("需要研究权限", 403);
    res.json({ cases: store.cases(r.id).map(c => ({ id: c.id, actorId: c.actorId, phase: c.phase, durationMs: c.durationMs, error: c.error, originCaseId: c.originCaseId })) });
  });
}
