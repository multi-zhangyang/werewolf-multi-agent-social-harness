import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { SocietyStore } from "../src/runtime/store";
import { RepairSandbox, studySpecSchema, trialSpec, trialResult, type TrialSummary } from "../src/runtime/studies";
import { modelParticipantFactory } from "../src/runtime/participant";
import { loadRegistry } from "../src/society/models/registry";
import { sourceHash } from "../src/runtime/cases";
import { harnessVersion } from "../src/runtime/harness";

const directory = `data/harness-probe-${Date.now()}`;
mkdirSync(directory, { recursive: true });
const store = new SocietyStore(`${directory}/study.sqlite`); const registry = loadRegistry();
const profile = registry.listModelProfiles().find(p => p.enabled && p.modelId === "apodex/apodex-1.1-mini:free" && registry.providerProfile(p.providerProfileId)?.baseURL.replace(/\/$/, "") === "https://api.cardinalize.com/v1");
if (!profile) throw new Error("指定模型未配置");
const factory = modelParticipantFactory(registry);
const study = studySpecSchema.parse({ kind: "calibration", repeats: 1, context: "compact", effort: "low", modelProfileId: profile.id, requestTimeoutMs: 120000 });
const manifest = { harnessVersion, sourceHash: sourceHash(), model: profile.modelId, createdAt: new Date().toISOString(), purpose: "Two isolated SDK integration probes; not a personality-effect or completion-rate estimate.", status: "running", trials: ["discussion", "action"].map(kind => ({ kind, id: randomUUID() })) };
writeFileSync(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ directory, sourceHash: manifest.sourceHash }));
const results = [];
for (const entry of manifest.trials) {
  const trial: TrialSummary = { id: entry.id, group: "harness-probe", condition: "compensation", mechanism: "hybrid", agreeableness: .5, repeat: 0, context: "compact", effort: "low", status: "running" };
  const spec = trialSpec(study, trial); const started = Date.now(); let error;
  const box = new RepairSandbox(entry.id, spec, .5, record => store.saveCase(record));
  try {
    box.bootstrap(); box.intervention("compensation");
    if (entry.kind === "action") { box.advance(); box.advance(); box.apply("self", "pledge_return", 50); box.advance(); box.apply("peer", "invest", 6); box.advance(); box.advance(); }
    await box.turn(factory(box.characters[0], spec, box.id), AbortSignal.timeout(480000));
  } catch (e) { error = e; }
  const result = trialResult(trial, box, started, error); results.push(result);
  store.saveTrial("harness-probe", result);
  writeFileSync(`${directory}/${entry.kind}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ kind: entry.kind, status: result.status, calls: result.calls, errors: result.errors, durationMs: result.durationMs }));
}
manifest.status = "completed";
writeFileSync(`${directory}/manifest.json`, JSON.stringify({ ...manifest, results: results.map(r => ({ id: r.id, status: r.status, error: r.error, calls: r.calls, durationMs: r.durationMs })) }, null, 2));
store.close();
