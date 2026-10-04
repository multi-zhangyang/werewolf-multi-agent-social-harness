import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StudyService, type StudyRecord } from "../src/runtime/studies";
import { SocietyStore } from "../src/runtime/store";
import { modelParticipantFactory } from "../src/runtime/participant";
import { loadRegistry } from "../src/society/models/registry";
const option = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const directory = path.resolve(option("output", `data/hybrid-${Date.now()}`)); mkdirSync(directory, { recursive: true });
const store = new SocietyStore(path.join(directory, "study.sqlite")); const registry = loadRegistry();
if (store.studies().length) { store.close(); throw new Error("输出目录已有实验；请选择新目录，避免覆盖已有清单"); }
const profile = registry.listModelProfiles().find(p => p.enabled && p.modelId === "apodex/apodex-1.1-mini:free" && registry.providerProfile(p.providerProfileId)?.baseURL.replace(/\/$/, "") === "https://api.cardinalize.com/v1");
if (!profile) throw new Error("指定的 Cardinalize Apodex 模型未配置");
const service = new StudyService(store, modelParticipantFactory(registry));
const record = service.create({ kind: option("kind", "calibration"), repeats: Number(option("repeats", "5")), modelProfileId: profile.id, effort: option("effort", "low"), context: option("context", "compact") });
console.log(JSON.stringify({ studyId: record.id, kind: record.spec.kind, trials: record.trials.length, output: directory }));
const timer = setInterval(() => { const state = store.study<StudyRecord>(record.id)!; console.log(JSON.stringify({ completed: state.trials.filter(t => t.status === "completed").length, failed: state.trials.filter(t => t.status === "failed").length, active: state.trials.find(t => t.status === "running")?.condition })); writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(state, null, 2)); }, 30000);
process.on("SIGINT", () => service.stop(record.id));
try { await service.settled(record.id); const result = store.study<StudyRecord>(record.id)!; writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ status: result.status, completed: result.trials.filter(t => t.status === "completed").length, failed: result.trials.filter(t => t.status === "failed").length })); }
finally { clearInterval(timer); store.close(); }
