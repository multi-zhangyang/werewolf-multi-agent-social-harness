import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { loadRegistry } from "../src/society/models/registry";
import { agentSourceHash, snapshotAgentSource } from "../src/agents/provenance";
import { nativeConfiguration } from "../src/agents/sdk";
import { createSdkParticipant, partnerHarnessVersion } from "../src/partners/agent";
import { PartnerStore } from "../src/partners/store";
import { PartnerService } from "../src/partners/service";
import { fixtureDecision } from "../tests/partners/fixture";

const dir = path.resolve("data", `partners-live-${Date.now()}`); mkdirSync(dir, { recursive: true });
const sourceHash = snapshotAgentSource(path.join(dir, "source"));
const models = loadRegistry(); const configuration = nativeConfiguration(models);
const db = new Database(path.join(dir, "world.sqlite"));
const service = new PartnerService(new PartnerStore(db), mechanism => createSdkParticipant(models, { psychology: mechanism === "full" ? "hybrid" : mechanism === "no-mind" ? "off" : mechanism === "record-only" ? "record-only" : "no-inertia" }));
const scriptedHuman = process.env.PARTNERS_MODE === "human-scripted";
const singleStep = process.env.PARTNERS_STEP === "1";
const requestedRevision = process.env.PARTNERS_REVISION === undefined ? undefined : Number(process.env.PARTNERS_REVISION);
if (requestedRevision !== undefined && (!Number.isInteger(requestedRevision) || requestedRevision < 0 || !process.env.PARTNERS_SOURCE))
  throw new Error("PARTNERS_REVISION must be a nonnegative checkpoint revision with PARTNERS_SOURCE");
const start = Date.now();
let run;
if (process.env.PARTNERS_SOURCE) {
  const sourceDb = new Database(path.resolve(process.env.PARTNERS_SOURCE), { readonly: true });
  const stored = (process.env.PARTNERS_SOURCE_RUN ? sourceDb.prepare("SELECT document FROM partner_runs WHERE id=?").get(process.env.PARTNERS_SOURCE_RUN)
    : sourceDb.prepare("SELECT document FROM partner_runs ORDER BY rowid DESC LIMIT 1").get()) as { document: string };
  if (!stored) throw new Error("Source contains no partner run");
  const source = JSON.parse(stored.document);
  if (source.status === "running") throw new Error("Pause the source run before isolated replay");
  service.store.save(source);
  for (const row of sourceDb.prepare("SELECT id,run_id,revision,document FROM partner_checkpoints WHERE run_id=?").all(source.id) as { id: string; run_id: string; revision: number; document: string }[])
    db.prepare("INSERT INTO partner_checkpoints(id,run_id,revision,document) VALUES (?,?,?,?)").run(row.id, row.run_id, row.revision, row.document);
  const checkpoint = requestedRevision === undefined ? service.store.checkpoint(source) : service.store.getCheckpoint(`${source.id}:${requestedRevision}`);
  if (!checkpoint) throw new Error("Requested checkpoint does not exist in the source run");
  for (const row of sourceDb.prepare("SELECT document FROM partner_cases WHERE run_id=?").all(source.id) as { document: string }[]) service.store.saveCase(source.id, JSON.parse(row.document));
  sourceDb.close();
  run = service.fork(source.id, { checkpointId: checkpoint.id, autoStart: !singleStep });
} else run = service.create({ mode: scriptedHuman ? "human" : "observe", maxRounds: Number(process.env.PARTNERS_ROUNDS ?? 3), mechanism: "full", seed: 1, autoStart: !singleStep });
if (singleStep) service.control(run.id, "step");
writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ kind: "live-model-smoke", harnessVersion: partnerHarnessVersion, sourceHash, configuration, sourceDatabase: process.env.PARTNERS_SOURCE ?? null, sourceRevision: requestedRevision ?? null, singleStep, participants: scriptedHuman ? "one real model, one deterministic human-controller fixture" : service.get(run.id).spec.mode === "human" ? "isolated continuation of a human/model source; no human controller" : "two real model participants", runId: run.id, startedAt: new Date().toISOString(), model: configuration.modelId }, null, 2));
console.log(JSON.stringify({ artifact: dir, runId: run.id }));
let previous = "";
try {
  while (true) {
    const state = service.get(run.id); const status = `${state.status}:${state.world.round}:${state.world.phase}:${state.world.revision}`;
    if (status !== previous) { console.log(JSON.stringify({ status, elapsedSeconds: Math.round((Date.now() - start) / 1000), metrics: service.metrics(run.id) })); previous = status; }
    if (["completed", "failed", "stopped"].includes(state.status) || singleStep && state.status === "paused" || !scriptedHuman && state.status === "waiting-human") break;
    if (scriptedHuman && state.status === "waiting-human") {
      service.humanAction(run.id, "a", { expectedRevision: state.world.revision, commandId: `scripted-human:${state.world.revision}`, action: fixtureDecision({ world: state.world, actorId: "a" }).action });
    }
    if (Date.now() - start > 20 * 60_000) { service.control(run.id, "pause"); break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally {
  service.stopAll(); await service.settled();
  const artifact = service.exportRun(run.id);
  writeFileSync(path.join(dir, "result.json"), JSON.stringify(artifact, null, 2));
  writeFileSync(path.join(dir, "provenance.json"), JSON.stringify({ sourceHash, sourceChanged: agentSourceHash() !== sourceHash, configuration }, null, 2));
  console.log(JSON.stringify({ status: artifact.run.status, error: artifact.run.error, elapsedSeconds: (Date.now() - start) / 1000, metrics: artifact.run.research?.metrics, artifact: dir }));
  if (agentSourceHash() !== sourceHash || artifact.run.status !== "completed" && !(singleStep && artifact.run.status === "paused")) process.exitCode = 1;
  db.close();
}
