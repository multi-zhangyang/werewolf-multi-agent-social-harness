import Database from "better-sqlite3";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSdkParticipant, partnerHarnessVersion } from "../src/partners/agent";
import { PartnerStore } from "../src/partners/store";
import { PartnerService } from "../src/partners/service";
import { InterventionService } from "../src/partners/interventions";
import { interventionSpecSchema } from "../src/partners/intervention-types";
import { applyAction, assertConservation } from "../src/partners/world";
import { loadRegistry } from "../src/society/models/registry";
import { agentSourceHash, snapshotAgentSource } from "../src/agents/provenance";
import { nativeConfiguration } from "../src/agents/sdk";

// Repeated engineering acceptance. All decisions use the configured real model;
// fixed scenarios have an explicitly labelled rule-engine prelude only.
const directory = path.resolve("data", `partners-validation-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const sourceHash = snapshotAgentSource(path.join(directory, "source"));
cpSync("scripts/partners-validation.ts", path.join(directory, "source/partners-validation.ts"));
const models = loadRegistry(); const configuration = nativeConfiguration(models);
const database = new Database(path.join(directory, "world.sqlite"));
const service = new PartnerService(new PartnerStore(database), mechanism => createSdkParticipant(models, {
  psychology: mechanism === "full" ? "hybrid" : mechanism === "record-only" ? "record-only" : mechanism === "no-mind" ? "off" : "no-inertia" }));
const interventions = new InterventionService(service);
const started = Date.now();
let stage = "fixed-decisions";
const fixed: { id: string; scenario: string; repeat: number; sourceRevision: number }[] = [];
const games: { id: string; seed: number }[] = [];
const timedOut = new Set<string>();
const scenarios = ["ordinary-offer", "betrayal-response", "private-income-settlement", "final-role-and-plan"] as const;
for (let repeat = 0; repeat < 3; repeat++) for (const scenario of scenarios) {
  const maxRounds = scenario === "final-role-and-plan" ? 2 : 3;
  const created = service.create({ mode: "observe", protocol: "responses-v1", maxRounds, agreeableness: [0.5, 0.5], autoStart: false },
    { maxRounds, actors: { a: { name: "林舟", kind: "ai", agreeableness: 0.5, productivity: 3 }, b: { name: "沈言", kind: "ai", agreeableness: 0.5, productivity: 3 } } });
  const run = service.get(created.id);
  run.title = `真实模型重复情境 · ${scenario} · ${repeat + 1}`;
  run.experimentNote = "当前机会之前为规则引擎执行的固定实验设置，仅当前一次决定由真实模型产生。重复编号不控制模型采样。";
  if (scenario !== "ordinary-offer") {
    run.world = applyAction(run.world, "b", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "setup:offer");
    run.world = applyAction(run.world, "a", { type: "invest", amount: 6 }, "setup:invest");
    if (scenario !== "private-income-settlement") {
      run.world = applyAction(run.world, "b", { type: "settle", returnAmount: 0 }, "setup:betrayal");
      run.world = applyAction(run.world, "b", { type: "repair", compensation: 0 }, "setup:repair");
    }
    if (scenario === "final-role-and-plan") {
      run.world = applyAction(run.world, "a", { type: "respond", choice: "continue" }, "setup:continue");
      run.minds.a.plan = { id: "expired-investor-plan", version: 1, aim: "以小额投资观察是否履约", nextStep: "只投资两点", continueWhen: "有投资机会", reviseWhen: "角色变化", abandonWhen: "合作结束",
        status: "active", scope: { role: "investor", fromRound: 1, throughRound: 1, phases: ["invest"] }, conditions: [], sourceIds: [run.world.events[0].id], revision: 0 };
    }
  }
  run.version++; service.store.save(run); service.store.checkpoint(run);
  fixed.push({ id: run.id, scenario, repeat, sourceRevision: run.world.revision });
}
for (let seed = 1; seed <= 6; seed++) {
  const created = service.create({ mode: "observe", protocol: "responses-v1", maxRounds: 3, mechanism: "full", seed, autoStart: false });
  const run = service.get(created.id); run.title = `真实双 AI 三轮 · 种子 ${seed}`;
  run.experimentNote = "从开场开始，双方所有决策均由真实模型产生。种子控制初始世界，不控制提供商采样。";
  run.version++; service.store.save(run); games.push({ id: run.id, seed });
}
const batch = interventions.create(interventionSpecSchema.parse({ repeats: 3, seed: 1731, horizon: "decision" }));
const sourcePrelude = JSON.stringify(service.get(batch.experiment.sourceRunId));
const thresholds = { fixed: { minimumCompleted: 12, total: 12 }, games: { minimumCompleted: 6, total: 6 }, intervention: { minimumCompleted: 12, total: 12 }, toolErrors: 0, failedDecisions: 0, sourceChanged: false };
writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ kind: "repeated-live-engineering-acceptance", harnessVersion: partnerHarnessVersion, sourceHash,
  startedAt: new Date().toISOString(), model: configuration.modelId, configuration, thresholds, fixed, games, experimentId: batch.experiment.id,
  note: "Engineering submission/completion checks, not a test of personality efficacy, psychological validity, or the separate 90-branch repair study." }, null, 2));
console.log(JSON.stringify({ artifact: directory, harnessVersion: partnerHarnessVersion, sourceHash, thresholds }));

function trial(id: string) {
  const run = service.get(id); const cases = service.store.decisionSummaries(id);
  return { id, status: run.status, round: run.world.round, revision: run.world.revision, phase: run.world.phase, finishReason: run.world.finishReason,
    timedOut: timedOut.has(id), error: run.error, completedDecisions: cases.filter(item => item.status === "completed").length,
    failedDecisions: cases.filter(item => item.status === "failed").length, ...service.metrics(id) };
}
function progress() {
  const intervention = interventions.view(batch.experiment.id);
  const snapshot = { stage, elapsedSeconds: Math.round((Date.now() - started) / 1000), fixed: fixed.map(row => ({ ...row, ...trial(row.id) })),
    games: games.map(row => ({ ...row, ...trial(row.id) })), intervention: { status: intervention.status, completed: intervention.completed, failed: intervention.failed, shadowFailures: intervention.shadowFailures } };
  writeFileSync(path.join(directory, "progress.json"), JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify({ stage: snapshot.stage, elapsedSeconds: snapshot.elapsedSeconds,
    fixed: snapshot.fixed.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {} as Record<string, number>),
    games: snapshot.games.map(row => ({ seed: row.seed, status: row.status, revision: row.revision, failures: row.failures })), intervention: snapshot.intervention }));
}
async function runPool(rows: { id: string }[], singleStep: boolean) {
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      service.control(row.id, singleStep ? "step" : "resume");
      const deadline = setTimeout(() => { timedOut.add(row.id); service.control(row.id, "pause"); }, singleStep ? 12 * 60_000 : 20 * 60_000);
      try { while (service.get(row.id).status === "running") await service.waitForRun(row.id); }
      finally { clearTimeout(deadline); }
      writeFileSync(path.join(directory, `${row.id}.json`), JSON.stringify(service.exportRun(row.id), null, 2));
      console.log(JSON.stringify({ stage, trial: trial(row.id) }));
    }
  };
  await Promise.all([worker(), worker()]);
}
const timer = setInterval(progress, 30000);
try {
  await runPool(fixed, true);
  const fixedCompleted = fixed.filter(row => service.store.decisionSummaries(row.id).some(item => item.revision === row.sourceRevision && item.status === "completed")
    && service.get(row.id).world.revision === row.sourceRevision + 1).length;
  if (fixedCompleted >= thresholds.fixed.minimumCompleted) {
    stage = "autonomous-games"; progress(); await runPool(games, false);
    stage = "psychological-interventions"; progress();
    interventions.control(batch.experiment.id, "resume"); await interventions.settled();
  } else {
    stage = "fixed-acceptance-failed";
    interventions.control(batch.experiment.id, "stop");
  }
  const intervention = interventions.view(batch.experiment.id);
  const gamesCompleted = games.filter(row => service.get(row.id).status === "completed").length;
  for (const run of service.store.list()) assertConservation(run.world);
  const caseRows = database.prepare("SELECT document FROM partner_cases").iterate() as Iterable<{ document: string }>;
  let checkedCases = 0; let appraised = 0; let toolErrors = 0; let failedDecisions = 0;
  for (const row of caseRows) {
    const record = JSON.parse(row.document); checkedCases++;
    if (record.sourceHash !== sourceHash || record.harnessVersion !== partnerHarnessVersion) throw new Error("Source provenance mismatch; acceptance is not for the frozen version");
    if (record.configuration.executionVersion !== configuration.executionVersion || record.configuration.modelId !== configuration.modelId || record.configuration.apiMode !== "responses") throw new Error("Native SDK configuration mismatch");
    if (record.exchanges.some((exchange: { providerRequest?: unknown }) => !exchange.providerRequest)) throw new Error("Native request evidence missing");
    if (record.appraisal) appraised++;
    toolErrors += record.toolFailures ?? 0;
    toolErrors += record.shadow?.activities?.filter((activity: { kind: string }) => activity.kind === "tool_error").length ?? 0;
    if (record.status === "failed") failedDecisions++;
    if (record.status === "completed" && (!record.action || !record.receipt || record.receipt.appraisalRequired && !record.receipt.appraised)) throw new Error("Completed action is missing its canonical receipt");
  }
  if (JSON.stringify(service.get(batch.experiment.sourceRunId)) !== sourcePrelude) throw new Error("Intervention modified its source prelude");
  const sourceChanged = agentSourceHash() !== sourceHash;
  const passed = !sourceChanged && timedOut.size === 0 && toolErrors === 0 && failedDecisions === 0 && fixedCompleted >= thresholds.fixed.minimumCompleted && gamesCompleted >= thresholds.games.minimumCompleted &&
    intervention.completed >= thresholds.intervention.minimumCompleted && intervention.failed === 0 && intervention.shadowFailures === 0;
  const results = { passed, harnessVersion: partnerHarnessVersion, sourceHash, elapsedMs: Date.now() - started, thresholds,
    fixedCompleted, gamesCompleted, gamesPlayedToRoundLimit: games.filter(row => service.get(row.id).world.finishReason === "completed").length,
    configuration, sourceChanged, checkedCases, appraised, toolErrors, failedDecisions, fixed: fixed.map(row => ({ ...row, ...trial(row.id), cases: service.store.decisionSummaries(row.id) })),
    games: games.map(row => ({ ...row, ...trial(row.id), cases: service.store.decisionSummaries(row.id) })),
    intervention, interventionAnalysis: interventions.analysis(batch.experiment.id),
    limitation: "Small engineering sample. Correctly submitted actions may still contain mistaken beliefs, arithmetic or explanations. No validated personality/psychology effect or 90-branch acceptance claim." };
  writeFileSync(path.join(directory, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(path.join(directory, "intervention.json"), JSON.stringify(interventions.export(batch.experiment.id), null, 2));
  console.log(JSON.stringify({ finished: true, passed, artifact: directory, fixedCompleted, gamesCompleted, interventionCompleted: intervention.completed, checkedCases }));
  if (!passed) process.exitCode = 1;
} finally {
  clearInterval(timer); interventions.stopAll(); service.stopAll(); await interventions.settled(); await service.settled(); database.close();
}
