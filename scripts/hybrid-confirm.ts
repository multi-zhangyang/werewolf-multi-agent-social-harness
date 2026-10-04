import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { RepairSandbox, studySpecSchema, trialResult, trialSpec, type StudyRecord, type TrialSummary } from "../src/runtime/studies";
import { SocietyStore } from "../src/runtime/store";
import { modelParticipantFactory } from "../src/runtime/participant";
import { loadRegistry } from "../src/society/models/registry";
import { sourceHash } from "../src/runtime/cases";

const directory = process.argv.find(a => a.startsWith("--output="))?.slice(9) ?? `data/hybrid-confirmation-${Date.now()}`; mkdirSync(directory, { recursive: true });
const store = new SocietyStore(`${directory}/study.sqlite`); const registry = loadRegistry();
if (store.studies().length) { store.close(); throw new Error("确认目录已有实验；请选择新目录，避免覆盖已有记录"); }
const profile = registry.listModelProfiles().find(p => p.enabled && p.modelId === "apodex/apodex-1.1-mini:free" && registry.providerProfile(p.providerProfileId)?.baseURL.replace(/\/$/, "") === "https://api.cardinalize.com/v1");
if (!profile) throw new Error("指定模型未配置");
const factory = modelParticipantFactory(registry);
const option = (name: string, fallback: number) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const spec = studySpecSchema.parse({ kind: "calibration", repeats: 4, context: "compact", effort: "low", modelProfileId: profile.id, requestTimeoutMs: option("request-timeout", 120000), phases: { psychology: { effort: "low" } } });
const trials: TrialSummary[] = Array.from({ length: 4 }, (_, repeat) => (["pledge", "silence", "apology", "compensation"] as const).map(condition => ({ id: randomUUID(), group: "fixed-confirmation", condition, mechanism: "hybrid" as const, agreeableness: .5, repeat, context: "compact" as const, effort: "low" as const, status: "queued" as const }))).flat();
const record: StudyRecord = { id: randomUUID(), spec, sourceHash: sourceHash(), createdAt: new Date().toISOString(), status: "running", trials };
function save() { store.saveStudy(record); writeFileSync(`${directory}/manifest.json`, JSON.stringify({ ...record, design: "Independent confirmation of compact context + low effort, four scenarios x four repetitions." }, null, 2)); }
save(); console.log(JSON.stringify({ id: record.id, trials: trials.length, output: directory }));
const queue = [...trials];
await Promise.all(Array.from({ length: 2 }, async () => {
  while (queue.length) {
    const trial = queue.shift()!; trial.status = "running"; save(); const started = Date.now();
    const runSpec = trialSpec(spec, trial);
    // This script confirms a chosen configuration; it is not the 2x2
    // factorial calibration, which intentionally ignores phase overrides.
    runSpec.cognition!.phases = { ...runSpec.cognition!.phases, ...spec.phases };
    const box = new RepairSandbox(trial.id, runSpec, .5, c => store.saveCase(c)); let error;
    try {
      box.bootstrap(); box.intervention(trial.condition === "pledge" ? "silence" : trial.condition as "silence" | "apology" | "compensation"); box.advance(); box.advance();
      if (trial.condition !== "pledge") { box.apply("self", "pledge_return", 50); box.advance(); box.apply("peer", "invest", 6); box.advance(); box.advance(); }
      await box.turn(factory(box.characters[0], runSpec, box.id), AbortSignal.timeout((spec.requestTimeoutMs ?? 120000) * 3));
    } catch (e) { error = e; }
    const result = trialResult(trial, box, started, error); store.saveTrial(record.id, result);
    const { events: _events, predictions: _predictions, receipts: _receipts, errors: _errors, ...summary } = result; Object.assign(trial, summary); save();
    console.log(JSON.stringify({ condition: trial.condition, repeat: trial.repeat, status: trial.status, calls: trial.calls, errors: trial.toolErrors }));
  }
}));
record.status = "completed"; save(); store.close();
