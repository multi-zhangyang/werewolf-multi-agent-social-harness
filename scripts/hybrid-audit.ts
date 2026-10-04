import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { EconomicScenario } from "../src/runtime/scenarios/economic";
import { psychologyForPrompt, reduceMind } from "../src/runtime/cognition";
import { isHybrid, psychologyFromEvent, type PsychologicalState } from "../src/runtime/psychology";
import { interval, summarizeTrials } from "../src/runtime/study-metrics";
import { studyCharacters, type StudyRecord, type TrialResult } from "../src/runtime/studies";
import type { DecisionCase } from "../src/runtime/cases";
import { inspectModelResponse } from "../src/runtime/model";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import type { EventDraft, WorldEvent } from "../src/runtime/types";

// Read-only: this audit cannot execute model tools or update the original database.
const option = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const database = option("database", "data/society-v5.sqlite");
const output = resolve(option("output", "data/v5-audit"));
mkdirSync(output, { recursive: true });
const db = new Database(database, { readonly: true });
const rows = <T>(sql: string, ...params: string[]) => (db.prepare(sql).all(...params) as { document: string }[]).map(r => JSON.parse(r.document) as T);
const write = (file: string, value: unknown) => writeFileSync(resolve(output, file), JSON.stringify(value, null, 2));
const allCases = rows<DecisionCase>("select document from decision_cases order by rowid");
const studies = rows<StudyRecord>("select document from studies order by rowid");
const same = (a: unknown, b: unknown) => isDeepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? { n: sorted.length, min: sorted[0], median: sorted[Math.floor((sorted.length - 1) / 2)], p90: sorted[Math.ceil(.9 * sorted.length) - 1], max: sorted.at(-1) } : null;
};
const summaries: unknown[] = [];

function ledgerAudit(t: TrialResult, fullGame = true) {
  const world = new EconomicScenario("trust-game", studyCharacters(t.agreeableness), 3, "pledge-repair");
  const generated: EventDraft[] = [];
  const append = (drafts: EventDraft[]) => generated.push(...structuredClone(drafts));
  const errors: string[] = [];
  try {
    for (const e of t.events) {
      if (e.type === "phase") {
        const stageId = e.data.stageId as string;
        while (world.stage() && world.stage()!.id !== stageId) append(world.advance());
        if (world.stage()?.id !== stageId) throw new Error(`invalid phase ${stageId}`);
        if (e.data.world && !same(e.data.world, world.publicState())) errors.push(`phase world mismatch at ${e.seq}`);
      }
      if (e.type === "action") append(world.apply(e.actorId!, String(e.data.action), { amount: e.data.amount }));
    }
    if (fullGame && t.status === "completed") while (world.stage()) append(world.advance());
    const settlements = (events: EventDraft[]) => events.filter(e => e.data.settlement || e.data.commitment || e.data.repair).map(e => { const { scripted: _scripted, ...data } = e.data; return data; });
    if (!same(settlements(generated), settlements(t.events))) errors.push("settlement/commitment/repair mismatch");
    if (t.status === "completed" && t.score !== world.publicState().scores.self) errors.push("final score mismatch");
  } catch (e) { errors.push(String(e)); }
  return { trialId: t.id, actions: t.events.filter(e => e.type === "action").length, errors };
}

function mindAudit(t: TrialResult) {
  const prior = new Map<string, PsychologicalState>();
  const errors: string[] = [];
  let states = 0;
  for (const e of t.events) {
    const state = psychologyFromEvent(e);
    if (!state || !isHybrid(state)) continue;
    const { version: _version, dynamics, ...report } = state;
    const input = { ...report, emotions: dynamics.proposalEmotions };
    const rebuilt = reduceMind(prior.get(e.actorId!), input, state.dynamics.stageId, state.dynamics.inertia, state.dynamics.decay);
    if (!same(state, rebuilt)) errors.push(`reducer mismatch ${e.id}`);
    const evidence = [...state.sourceIds, ...state.relationships.flatMap(r => r.sourceIds)];
    if (evidence.some(id => !t.events.some(s => s.id === id && s.seq < e.seq))) errors.push(`future/missing source ${e.id}`);
    prior.set(e.actorId!, state); states++;
  }
  return { trialId: t.id, states, errors };
}

function inputAudit(c: DecisionCase, events: WorldEvent[]) {
  if (c.phase === "psychology") return null;
  const input = (c.request as any)?.input;
  const user = Array.isArray(input) ? input.find((i: any) => i.role === "user") : undefined;
  const raw = typeof input === "string" ? input : typeof user?.content === "string" ? user.content : user?.content?.find((i: any) => i.type === "input_text")?.text;
  let state: unknown;
  try { state = JSON.parse(raw).currentState; } catch { return { caseId: c.id, error: "missing structured decision input" }; }
  if (state === null || state === undefined) return { caseId: c.id, psychology: "off" };
  const matching = events.filter(e => e.actorId === c.actorId && (e.data.opportunityId ? e.data.opportunityId === c.opportunityId : String(e.data.stageId) === String((c.context.stage as any)?.id)) && psychologyFromEvent(e));
  return { caseId: c.id, canonicalState: matching.some(e => same(psychologyForPrompt(psychologyFromEvent(e)), state)), error: matching.some(e => same(psychologyForPrompt(psychologyFromEvent(e)), state)) ? undefined : "decision did not use a saved canonical state" };
}

for (const study of studies) {
  const artifactPrefix = studies.filter(s => s.spec.kind === study.spec.kind).length > 1 ? `${study.spec.kind}-${study.id}` : study.spec.kind;
  const results = rows<TrialResult>("select document from study_trials where study_id=? order by rowid", study.id);
  const runIds = new Set([...study.trials.map(t => t.runId ?? t.id), ...(study.prefixes ?? []).map(p => p.caseRunId)]);
  const cases = allCases.filter(c => runIds.has(c.runId) && !c.originCaseId);
  const attempts = new Map<string, DecisionCase[]>();
  for (const c of cases) { const key = `${c.runId}/${c.actorId}/${c.opportunityId}/${c.phase}`; attempts.set(key, [...(attempts.get(key) ?? []), c]); }
  const lastEventAt = Math.max(Date.parse(study.createdAt), ...cases.map(c => Date.parse(c.createdAt)), ...results.flatMap(t => t.events.flatMap(e => e.at ? [Date.parse(e.at)] : [])));
  const caseIndex = cases.map(c => ({ id: c.id, runId: c.runId, actorId: c.actorId, opportunityId: c.opportunityId, phase: c.phase, createdAt: c.createdAt, durationMs: c.durationMs, sourceHash: c.sourceHash, error: c.error, inputTokens: (c.response as any)?.usage?.inputTokens, outputTokens: (c.response as any)?.usage?.outputTokens }));
  const inspected = cases.filter(c => c.response).map(c => ({ id: c.id, ...inspectModelResponse(c.response as ModelResponse, c.request as ModelRequest) }));
  const toolCalls = cases.flatMap(c => ((c.response as ModelResponse | undefined)?.output ?? []).filter(item => item.type === "function_call"));
  const toolUse = Object.fromEntries([...new Set(toolCalls.map(c => c.name))].map(name => [name, toolCalls.filter(c => c.name === name).length]));
  const repairs = study.spec.kind === "repair";
  const ledgers = results.map(t => ledgerAudit(t, study.spec.kind !== "calibration"));
  const minds = results.map(mindAudit);
  const inputs = results.flatMap(t => cases.filter(c => c.runId === (t.runId ?? t.id)).map(c => inputAudit(c, t.events)).filter(Boolean));
  const groups = [...new Set(results.map(t => t.group))];
  const branches = repairs ? groups.map(group => {
    const family = results.filter(t => t.group === group);
    const prefix = (t: TrialResult) => t.events.slice(0, t.events.findIndex(e => e.type === "phase" && e.data.stageId === "1:repair") - (t.condition === "silence" ? 0 : 1));
    // The intervention apology is inserted immediately before the repair phase.
    const common = (t: TrialResult) => prefix(t).filter(e => !(e.type === "message" && e.data.scripted));
    const hashes = family.map(t => ({ id: t.id, condition: t.condition, hash: hash(common(t)) }));
    return { group, branches: family.length, hashes, sharedPrefix: hashes.every(h => h.hash === hashes[0].hash) };
  }) : [];
  const outcomes = results.map(t => {
    const own = t.events.filter(e => e.actorId === "self" && psychologyFromEvent(e));
    const states = own.map(e => ({ eventId: e.id, stageId: e.data.stageId, state: psychologyFromEvent(e)! }));
    const lastPerEvent = new Map<string, typeof t.predictions[number]>();
    for (const p of t.predictions) lastPerEvent.set(`${p.actorId}:${p.prediction.targetId}:${p.prediction.round}:${p.prediction.action}:${p.prediction.threshold}`, p);
    const scored = [...lastPerEvent.values()].filter(p => p.brier !== undefined);
    return { id: t.id, group: t.group, status: t.status, mechanism: t.mechanism, condition: t.condition, agreeableness: t.agreeableness, repeat: t.repeat,
      returnedShare: t.returnedShare, repair: t.repair, investment: t.investment, score: t.score,
      predictionCount: lastPerEvent.size, scoredPredictions: scored.length, brier: scored.length ? scored.reduce((sum, p) => sum + p.brier!, 0) / scored.length : undefined,
      strategyRevisions: states.length > 1 ? states.slice(1).filter((s, i) => s.state.strategy.kind !== states[i].state.strategy.kind).length : undefined,
      trajectory: states.map(s => ({ eventId: s.eventId, stageId: s.stageId, strategy: s.state.strategy.kind, regulation: isHybrid(s.state) ? s.state.regulation : undefined, relationships: s.state.relationships.map(r => ({ targetId: r.targetId, ...("willingness" in r ? { willingness: r.willingness, competence: r.competence } : { trust: r.trust }) })) })) };
  });
  const metrics = ["returnedShare", "repair", "investment", "score", "brier", "strategyRevisions"] as const;
  const distributions = [...new Set(outcomes.map(o => `${o.mechanism}:${o.condition}:${o.agreeableness}`))].map(key => {
    const selected = outcomes.filter(o => `${o.mechanism}:${o.condition}:${o.agreeableness}` === key && o.status === "completed");
    return { key, metrics: Object.fromEntries(metrics.map(metric => { const values = selected.flatMap(o => typeof o[metric] === "number" ? [o[metric]!] : []); return [metric, { values, summary: interval(values), quantiles: quantiles(values) }]; })) };
  });
  const contrasts = repairs ? [...new Set(outcomes.map(o => o.mechanism))].flatMap(mechanism => ["silence", "apology", "compensation"].map(condition => ({ mechanism, condition, contrast: "high-minus-low", metrics: Object.fromEntries(metrics.map(metric => {
    const differences = outcomes.filter(o => o.mechanism === mechanism && o.condition === condition && o.agreeableness === .2 && o.status === "completed").flatMap(low => {
      const high = outcomes.find(o => o.mechanism === mechanism && o.condition === condition && o.agreeableness === .8 && o.repeat === low.repeat && o.status === "completed");
      return high && typeof low[metric] === "number" && typeof high[metric] === "number" ? [high[metric]! - low[metric]!] : [];
    }); return [metric, interval(differences)];
  })) }))) : [];
  const conditionContrasts = repairs ? ["hybrid", "instant", "off"].flatMap(mechanism => [.2, .8].flatMap(agreeableness => [["apology", "silence"], ["compensation", "apology"], ["compensation", "silence"]].map(([after, before]) => ({ mechanism, agreeableness, contrast: `${after}-minus-${before}`, metrics: Object.fromEntries(metrics.map(metric => {
    const differences = outcomes.filter(o => o.mechanism === mechanism && o.agreeableness === agreeableness && o.condition === before && o.status === "completed").flatMap(a => {
      const b = outcomes.find(o => o.group === a.group && o.condition === after && o.status === "completed");
      return b && typeof a[metric] === "number" && typeof b[metric] === "number" ? [b[metric]! - a[metric]!] : [];
    }); return [metric, interval(differences)];
  })) })))) : [];
  const mechanismContrasts = repairs ? ["silence", "apology", "compensation"].flatMap(condition => [.2, .8].flatMap(agreeableness => ["instant", "off"].map(baseline => ({ condition, agreeableness, contrast: `hybrid-minus-${baseline}`, metrics: Object.fromEntries(metrics.map(metric => {
    const differences = outcomes.filter(o => o.condition === condition && o.agreeableness === agreeableness && o.mechanism === baseline && o.status === "completed").flatMap(a => {
      const b = outcomes.find(o => o.condition === condition && o.agreeableness === agreeableness && o.mechanism === "hybrid" && o.repeat === a.repeat && o.status === "completed");
      return b && typeof a[metric] === "number" && typeof b[metric] === "number" ? [b[metric]! - a[metric]!] : [];
    }); return [metric, interval(differences)];
  })) })))) : [];
  const trialDiagnostics = study.trials.map(trial => {
    const result = results.find(t => t.id === trial.id);
    const requests = cases.filter(c => c.runId === (trial.runId ?? trial.id));
    const ids = new Set(requests.map(c => c.id));
    const checked = inspected.filter(c => ids.has(c.id));
    return { trialId: trial.id, runId: trial.runId, status: trial.status, durationMs: trial.durationMs,
      requests: requests.length, responses: requests.filter(c => c.response).length,
      failedRequests: requests.filter(c => c.error).map(c => c.id),
      truncations: checked.filter(c => c.outputError === "truncated").length,
      malformedArguments: checked.filter(c => c.error?.includes("不是完整 JSON")).length,
      recordedCleanRetries: result?.errors.filter(error => /重试一次/.test(error)) ?? [],
      toolErrors: result?.errors ?? [], error: trial.error };
  });
  const summary = { id: study.id, artifactPrefix, kind: study.spec.kind, status: study.status, sourceHash: study.sourceHash, sourceVersions: [...new Set(cases.map(c => c.sourceHash))], createdAt: study.createdAt, lastRecordedAt: new Date(lastEventAt).toISOString(), observedAt: new Date().toISOString(), elapsedToLastRecordMs: lastEventAt - Date.parse(study.createdAt),
    planned: study.trials.length, completed: study.trials.filter(t => t.status === "completed").length, failures: study.trials.filter(t => t.status === "failed").map(t => ({ id: t.id, error: t.error })),
    attempts: { total: cases.length, phases: attempts.size, phasesWithAdditionalCalls: [...attempts.values()].filter(a => a.length > 1).length, errors: cases.filter(c => c.error).map(c => ({ id: c.id, phase: c.phase, error: c.error })), responseCount: cases.filter(c => c.response).length, inputTokens: caseIndex.reduce((n, c) => n + (c.inputTokens ?? 0), 0), outputTokens: caseIndex.reduce((n, c) => n + (c.outputTokens ?? 0), 0), latencyMs: quantiles(cases.map(c => c.durationMs)) },
    toolErrors: results.filter(t => t.errors.length).map(t => ({ trialId: t.id, messages: t.errors })),
    toolUse, trialDiagnostics, responseInspection: { truncations: inspected.filter(r => r.outputError === "truncated").length, malformedArguments: inspected.filter(r => r.error?.includes("不是完整 JSON")).length, errors: inspected.filter(r => r.error) },
    audits: { ledgers, minds, inputs, branches, persistentHeads: (db.prepare("select count(*) as n from heads").get() as { n: number }).n }, distributions, contrasts, conditionContrasts, mechanismContrasts,
    notes: ["All planned failures retained. In-flight trials are not treated as failures or zero values.", "Each Brier outcome uses the latest forecast for the same actor/event; branch averages are the units summarized. Fixed partners limit calibration generalization.", "Strategy revision counts changes in the declared strategy kind, not verified retaliation or repair motives.", "Compensation changes resources and social signals together. Bootstrap intervals are descriptive and unadjusted for multiple comparisons.", "Additional model calls include correction and multi-tool turns; they are not all transport retries. DecisionCase retains each attempt."] };
  write(`${artifactPrefix}-results.json`, { study, summary: summarizeTrials(study.trials), results });
  write(`${artifactPrefix}-audit.json`, summary);
  write(`${artifactPrefix}-outcomes.json`, outcomes);
  const columns = ["id", "group", "status", "mechanism", "condition", "agreeableness", "repeat", ...metrics, "predictionCount", "scoredPredictions"] as const;
  const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  writeFileSync(resolve(output, `${artifactPrefix}-outcomes.csv`), "\uFEFF" + [columns.join(","), ...outcomes.map(o => columns.map(key => csv(o[key])).join(","))].join("\n"));
  write(`${artifactPrefix}-case-index.json`, caseIndex);
  summaries.push(summary);
  console.log(JSON.stringify({ kind: study.spec.kind, status: study.status, completed: summary.completed, failed: summary.failures.length, attempts: cases.length, ledgerErrors: ledgers.filter(a => a.errors.length).length, reducerErrors: minds.filter(a => a.errors.length).length, inputErrors: inputs.filter(a => a?.error).length, branchMismatches: branches.filter(a => !a.sharedPrefix).length, output }));
}
write("index.json", summaries.map((s: any) => ({ id: s.id, artifactPrefix: s.artifactPrefix, kind: s.kind, status: s.status, completed: s.completed, planned: s.planned, failures: s.failures.length })));
db.close();
