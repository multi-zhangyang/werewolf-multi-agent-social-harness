import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
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

const directory = path.resolve("data", `partners-cognition-${Date.now()}`); mkdirSync(directory, { recursive: true });
const sourceHash = snapshotAgentSource(path.join(directory, "source"));
const models = loadRegistry(); const configuration = nativeConfiguration(models);
const database = new Database(path.join(directory, "world.sqlite"));
const service = new PartnerService(new PartnerStore(database), mechanism => createSdkParticipant(models, {
  psychology: mechanism === "full" ? "hybrid" : mechanism === "record-only" ? "record-only" : mechanism === "no-mind" ? "off" : "no-inertia" }));
const interventions = new InterventionService(service); const started = Date.now();
const fixed: { id: string; scenario: string }[] = [];
for (const scenario of ["ordinary-offer", "betrayal-response", "private-income-settlement", "final-role-and-plan"] as const) {
  const created = service.create({ mode: "observe", maxRounds: scenario === "final-role-and-plan" ? 2 : 3, agreeableness: [0.5, 0.5], protocol: "responses-v1", autoStart: false },
    { maxRounds: scenario === "final-role-and-plan" ? 2 : 3, actors: { a: { name: "林舟", kind: "ai", agreeableness: 0.5, productivity: 3 }, b: { name: "沈言", kind: "ai", agreeableness: 0.5, productivity: 3 } } });
  const run = service.get(created.id);
  run.title = `真实模型固定情境 · ${scenario}`;
  run.experimentNote = "当前机会之前为规则引擎执行的固定实验设置，只有当前一次决定由真实模型产生。不是自由对局或人格效果验证。";
  if (scenario !== "ordinary-offer") {
    run.world = applyAction(run.world, "b", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "setup:offer");
    run.world = applyAction(run.world, "a", { type: "invest", amount: 6 }, "setup:invest");
    if (scenario !== "private-income-settlement") {
      run.world = applyAction(run.world, "b", { type: "settle", returnAmount: 0 }, "setup:betrayal");
      run.world = applyAction(run.world, "b", { type: "repair", compensation: 0 }, "setup:repair");
    }
    if (scenario === "final-role-and-plan") {
      run.world = applyAction(run.world, "a", { type: "respond", choice: "continue" }, "setup:continue");
      run.minds.a.plan = { id: "expired-investor-plan", version: 1, aim: "以小额投资观察对方是否履约", nextStep: "只投资两点", continueWhen: "有投资机会", reviseWhen: "角色变化", abandonWhen: "合作结束",
        status: "active", scope: { role: "investor", fromRound: 1, throughRound: 1, phases: ["invest"] }, conditions: [], sourceIds: [run.world.events[0].id], revision: 0 };
    }
  }
  run.version++; service.store.save(run); service.store.checkpoint(run); fixed.push({ id: run.id, scenario });
}
const batch = interventions.create(interventionSpecSchema.parse({ repeats: 1, seed: 731, horizon: "decision" }));
writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ kind: "live-cognitive-protocol-probe", harnessVersion: partnerHarnessVersion,
  startedAt: new Date().toISOString(), model: configuration.modelId, configuration, sourceHash, fixturesAreOnlyWorldPrelude: true, fixed, experimentId: batch.experiment.id,
  note: "Four fixed current decisions and four exploratory intervention branches. All failures retained. No 90-branch acceptance claim." }, null, 2));
console.log(JSON.stringify({ artifact: directory, fixed, experimentId: batch.experiment.id }));
let timer: ReturnType<typeof setInterval> | undefined;
try {
  timer = setInterval(() => console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), fixed: fixed.map(row => ({ scenario: row.scenario, status: service.get(row.id).status, metrics: service.metrics(row.id) })),
    intervention: { status: interventions.view(batch.experiment.id).status, completed: interventions.view(batch.experiment.id).completed, failed: interventions.view(batch.experiment.id).failed } })), 30000);
  for (const row of fixed) service.control(row.id, "step");
  while (fixed.some(row => service.get(row.id).status === "running")) await service.settled();
  for (const row of fixed) writeFileSync(path.join(directory, `${row.scenario}.json`), JSON.stringify(service.exportRun(row.id), null, 2));
  const fixedPassed = fixed.every(row => service.get(row.id).status === "paused" && service.store.cases(row.id).some(item => item.status === "completed"));
  if (fixedPassed) { interventions.control(batch.experiment.id, "resume"); await interventions.settled(); }
  else interventions.control(batch.experiment.id, "stop");
  writeFileSync(path.join(directory, "intervention.json"), JSON.stringify(interventions.export(batch.experiment.id), null, 2));
  for (const run of service.store.list()) assertConservation(run.world);
  const fixedResults = fixed.map(row => ({ ...row, status: service.get(row.id).status, cases: service.store.decisionSummaries(row.id) }));
  const sourceChanged = agentSourceHash() !== sourceHash;
  const passed = !sourceChanged && fixedPassed && fixedResults.every(row => row.cases.every(c => c.failures === 0)) && interventions.view(batch.experiment.id).completed === batch.experiment.rows.length &&
    interventions.view(batch.experiment.id).failed === 0 && interventions.view(batch.experiment.id).shadowFailures === 0;
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ passed, sourceHash, sourceChanged, configuration, harnessVersion: partnerHarnessVersion, elapsedMs: Date.now() - started, fixed: fixedResults,
    intervention: interventions.view(batch.experiment.id), analysis: interventions.analysis(batch.experiment.id) }, null, 2));
  console.log(JSON.stringify({ completed: true, passed, artifact: directory, elapsedMs: Date.now() - started,
    fixed: fixedResults.map(row => ({ scenario: row.scenario, status: row.status, failures: row.cases.reduce((sum, item) => sum + item.failures, 0) })),
    intervention: { completed: interventions.view(batch.experiment.id).completed, failed: interventions.view(batch.experiment.id).failed, shadowFailures: interventions.view(batch.experiment.id).shadowFailures } }));
  if (!passed) process.exitCode = 1;
} finally {
  clearInterval(timer); interventions.stopAll(); service.stopAll(); await interventions.settled(); await service.settled(); database.close();
}
