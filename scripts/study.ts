import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SocietyStore } from "../src/runtime/store";
import { RunService } from "../src/runtime/run";
import { runSpecSchema, scenarioIds, type RunSpec } from "../src/runtime/types";
import { modelParticipantFactory } from "../src/runtime/participant";
import { loadRegistry, defaultRegistryFile } from "../src/society/models/registry";
import { builtinCharacters } from "../src/society/profiles";
import { runtimeCharacter } from "../src/server/routes/runs";
import { summarizeBehavior } from "../src/runtime/behavior";

const option = (key: string, fallback: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const directory = path.resolve(option("output", "data/study-v2"));
const analyzeOnly = process.argv.includes("--analyze-only");
if (!analyzeOnly && existsSync(path.join(directory, "manifest.json"))) throw new Error("这个目录已有研究批次。请用 --output 指定新目录，或用 --analyze-only 分析原批次。");
mkdirSync(directory, { recursive: true });
const store = new SocietyStore(path.join(directory, "runs.sqlite"));
if (!analyzeOnly) store.recoverInterrupted();
const registry = loadRegistry(defaultRegistryFile());
const service = new RunService(store, modelParticipantFactory(registry));
const count = Number(option("count", "5"));
// Appraisal and decision are separate real-model calls. Keep a common wall-time
// limit across all conditions so the default does not censor slow treatments.
const executionTimeoutMs = Number(option("timeout", "2400")) * 1000;
const selected = option("scenario", "all");
const scenarios = scenarioIds.filter(s => selected === "all" || selected === s);
const ablate = process.argv.includes("--ablate");
const personalityAblation = process.argv.includes("--personality-ablation");
const psychologyAblation = process.argv.includes("--psychology-ablation");
const baseVariants = ablate ? [
  { relationshipMemory: true, speaking: "ready-queue" as const },
  { relationshipMemory: false, speaking: "ready-queue" as const },
  { relationshipMemory: true, speaking: "round-robin" as const },
  { relationshipMemory: false, speaking: "round-robin" as const },
] : [{ relationshipMemory: true, speaking: "ready-queue" as const }];
const variants = baseVariants.flatMap(v => (personalityAblation ? ["full", "persona-only"] as const : ["full"] as const).flatMap(personality => (psychologyAblation ? ["appraisal", "off"] as const : ["appraisal"] as const).map(psychology => ({ ...v, personality, psychology }))));
const initial = existsSync(option("snapshots", "")) && option("snapshots", "") ? JSON.parse(readFileSync(option("snapshots", ""), "utf8")) as Record<string, string> : {};
const jobs = analyzeOnly ? [] : scenarios.flatMap(scenario => variants.flatMap(experiment => Array.from({ length: count }, (_, index) => ({ scenario, experiment, index }))));
const reports: Record<string, unknown>[] = analyzeOnly ? JSON.parse(readFileSync(path.join(directory, "metrics.json"), "utf8")) : [];
const sourceFiles = ["src/runtime/run.ts", "src/runtime/participant.ts", "src/runtime/personality.ts", "src/runtime/psychology.ts", "src/runtime/behavior.ts", "src/server/routes/runs.ts", "src/runtime/model.ts", "src/runtime/types.ts", "src/runtime/store.ts", "src/runtime/scenarios/economic.ts", "src/runtime/scenarios/werewolf.ts", "src/society/profiles.ts", "package.json", "package-lock.json", "scripts/study.ts"];
const sourceHash = createHash("sha256").update(sourceFiles.map(f => readFileSync(f, "utf8")).join("\n")).digest("hex");
if (!analyzeOnly) {
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ startedAt: new Date().toISOString(), sourceHash, sourceFiles, node: process.version, count, scenarios, variants, initialSnapshots: initial, executionTimeoutMs }, null, 2));
  for (const file of sourceFiles) {
    const target = path.join(directory, "source", file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, readFileSync(file));
  }
}

async function worker() {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const { scenario, index, experiment } = job;
    const characters = builtinCharacters().slice(0, scenario === "trust-game" ? 2 : scenario === "public-goods" ? 3 : 6).map(runtimeCharacter);
    const spec: RunSpec = runSpecSchema.parse({ scenario, trustProtocol: scenario === "trust-game" ? option("trust-protocol", psychologyAblation ? "pledge-repair" : "classic") : "classic", mode: "experiment", worldId: "study", roster: characters.map(c => ({ characterId: c.id, modelProfileId: registry.globalDefaults().modelProfileId })), seed: ablate ? 23 : 23 + index, rounds: 2, budgets: { discussionTurns: Number(option("turns", "6")), maxTurns: 8 }, experiment, initialSnapshots: initial });
    const run = service.create(spec, characters).run;
    const timer = setTimeout(() => { if (["running", "paused"].includes(run.status)) run.control("stop"); }, executionTimeoutMs);
    console.log(`started ${scenario} ${index + 1} ${run.id}`);
    await run.settled(); clearTimeout(timer);
    const events = store.events(run.id);
    const turns = events.filter(e => e.type === "trace" && ["turn", "missing-action"].includes(e.text));
    const receipts = events.filter(e => e.type === "trace" && e.text === "model-response");
    const usage = receipts.length ? receipts : turns;
    const messages = events.filter(e => e.type === "message" && e.visibility === "public");
    const lengths = messages.map(e => e.text.length).sort((a, b) => a - b);
    const report = { id: run.id, scenario, index, status: run.status, spec, model: registry.modelProfile(spec.roster[0].modelProfileId!)?.modelId, medianMessageCharacters: lengths[Math.floor(lengths.length / 2)] ?? 0, messages: messages.length, repeatedExactMessages: messages.length - new Set(messages.map(m => m.text)).size, inputTokens: usage.reduce((n, e) => n + Number(e.data.inputTokens ?? 0), 0), outputTokens: usage.reduce((n, e) => n + Number(e.data.outputTokens ?? 0), 0), usageScope: receipts.length ? "provider-responses" : "returned-activations", meanLatencyMs: turns.reduce((n, e) => n + Number(e.data.durationMs), 0) / Math.max(1, turns.length), errors: events.filter(e => e.data.error || e.data.toolError).map(e => e.text), toolErrors: events.filter(e => e.data.toolError).map(e => ({ seq: e.seq, tool: e.text, message: e.data.message })), outputTruncations: receipts.filter(e => e.data.finishReason === "length").length, executionTimeoutMs };
    writeFileSync(path.join(directory, `${run.id}.json`), JSON.stringify({ report, characters, modelConfigs: run.record.modelConfigs, behavior: summarizeBehavior(characters, events), events }, null, 2));
    reports.push(report); writeFileSync(path.join(directory, "metrics.json"), JSON.stringify(reports, null, 2));
    console.log(`finished ${scenario} ${index + 1}: ${run.status}; ${messages.length} messages`);
  }
}
await Promise.all(Array.from({ length: Number(option("workers", "3")) }, worker));

const groups = new Map<string, typeof reports>();
for (const report of reports) {
  const experiment = (report.spec as RunSpec).experiment;
  const key = `${report.scenario}:${experiment.relationshipMemory}:${experiment.speaking}:${experiment.personality ?? "legacy"}:${experiment.psychology ?? "legacy"}:${(report.spec as RunSpec).trustProtocol ?? "classic"}`;
  groups.set(key, [...(groups.get(key) ?? []), report]);
}
function distribution(values: number[]) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean, min: Math.min(...values), max: Math.max(...values), sampleSD: values.length > 1 ? Math.sqrt(values.reduce((n, x) => n + (x - mean) ** 2, 0) / (values.length - 1)) : null };
}
writeFileSync(path.join(directory, "summary.json"), JSON.stringify({
  usageScope: "New runs count every received provider response, including partial responses and activations that later fail. Old runs count returned SDK activations. Requests without a received response or cancelled before commit may consume additional unreported tokens.",
  groups: [...groups].map(([key, rows]) => ({ key, count: rows.length, completed: rows.filter(r => r.status === "completed").length,
    messages: distribution(rows.map(r => Number(r.messages))), latencyMs: distribution(rows.map(r => Number(r.meanLatencyMs))),
    inputTokens: rows.reduce((n, r) => n + Number(r.inputTokens), 0), outputTokens: rows.reduce((n, r) => n + Number(r.outputTokens), 0),
    failures: rows.filter(r => r.status !== "completed").map(r => ({ id: r.id, status: r.status, errors: r.errors })),
  })),
}, null, 2));

// Historical pairing supports experience review, not a controlled old/new causal claim.
const pairs: Record<string, unknown>[] = []; const key: Record<string, unknown>[] = [];
const speech = (runId: string) => {
  const doc = JSON.parse(readFileSync(path.join(directory, `${runId}.json`), "utf8"));
  return doc.events.filter((e: { type: string; visibility: string }) => e.type === "message" && e.visibility === "public")
    .map((e: { actorId: string; text: string }) => ({ name: doc.characters.find((c: { id: string }) => c.id === e.actorId)?.name, text: e.text }));
};
const axes = [
  { axis: "personality" as const, treatment: "full", control: "persona-only" },
  { axis: "psychology" as const, treatment: "appraisal", control: "off" },
].filter(({ axis, control }) => reports.some(r => (r.spec as RunSpec).experiment[axis] === control));
function comparisonContext(spec: RunSpec, axis: "personality" | "psychology") {
  const experiment: Record<string, unknown> = { ...spec.experiment }; delete experiment[axis];
  return JSON.stringify({ ...spec, experiment });
}
if (axes.length) {
  for (const { axis, treatment, control } of axes) for (const full of reports.filter(r => (r.spec as RunSpec).experiment[axis] === treatment)) {
    const spec = full.spec as RunSpec;
    const baseline = reports.find(r => r.scenario === full.scenario && r.index === full.index && r.model === full.model
      && (r.spec as RunSpec).experiment[axis] === control
      && comparisonContext(r.spec as RunSpec, axis) === comparisonContext(spec, axis));
    if (!baseline) continue;
    const id = `comparison-${pairs.length + 1}`;
    const swap = createHash("sha256").update(id).digest()[0] % 2 === 0;
    const a = swap ? baseline : full; const b = swap ? full : baseline;
    pairs.push({ id, scenario: full.scenario, A: speech(String(a.id)), B: speech(String(b.id)) });
    key.push({ id, axis, A: (a.spec as RunSpec).experiment[axis], B: (b.spec as RunSpec).experiment[axis],
      runA: a.id, runB: b.id, statusA: a.status, statusB: b.status });
  }
} else {
for (const scenario of scenarios) {
  const old = (existsSync("artifacts/transcripts") ? readdirSync("artifacts/transcripts") : []).filter(f => f.startsWith(scenario) && f.endsWith(".json"))
    .sort().reverse().flatMap(file => {
      const doc = JSON.parse(readFileSync(path.join("artifacts/transcripts", file), "utf8"));
      const messages = (doc.world?.messages ?? []).filter((m: { channel: string }) => m.channel === "public");
      return [{ file, messages, status: doc.status }];
    }).sort((a, b) => Number(b.messages.length > 0) - Number(a.messages.length > 0));
  const unique = [...new Map(old.map(o => [createHash("sha256").update(JSON.stringify(o.messages.map((m: { text: string }) => m.text))).digest("hex"), o])).values()].slice(0, count);
  const recent = reports.filter(r => r.scenario === scenario).sort((a, b) => Number(a.index) - Number(b.index));
  for (let i = 0; i < Math.min(unique.length, recent.length); i++) {
    const fresh = JSON.parse(readFileSync(path.join(directory, `${recent[i].id}.json`), "utf8"));
    const a = unique[i].messages.map((m: { senderName: string; text: string }) => ({ name: m.senderName, text: m.text }));
    const b = fresh.events.filter((e: { type: string; visibility: string }) => e.type === "message" && e.visibility === "public").map((e: { actorId: string; text: string }) => ({ name: fresh.characters.find((c: { id: string }) => c.id === e.actorId)?.name, text: e.text }));
    const swap = createHash("sha256").update(`${scenario}:${i}`).digest()[0] % 2 === 0;
    const id = `${scenario}-${i + 1}`;
    pairs.push({ id, scenario, A: swap ? b : a, B: swap ? a : b });
    key.push({ id, A: swap ? "v2" : "v1", B: swap ? "v1" : "v2", oldFile: unique[i].file, newRunId: recent[i].id, oldStatus: unique[i].status, newStatus: recent[i].status });
  }
}
}
writeFileSync(path.join(directory, "pair-key.json"), JSON.stringify(key, null, 2));
writeFileSync(path.join(directory, "blind-pairs.json"), JSON.stringify(pairs, null, 2));
const data = JSON.stringify(pairs).replaceAll("<", "\\u003c");
const dataset = JSON.stringify({ id: path.basename(directory), sourceHash: JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")).sourceHash, pairsHash: createHash("sha256").update(JSON.stringify(pairs)).digest("hex") }).replaceAll("<", "\\u003c");
writeFileSync(path.join(directory, "blind-review.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Society 盲评</title><style>body{font:16px/1.8 system-ui;margin:40px;background:#fafaf8;color:#25332d}main{max-width:1100px;margin:auto}.columns{display:grid;grid-template-columns:1fr 1fr;gap:36px}article{padding:12px 0;border-bottom:1px solid #ddd;white-space:pre-wrap}label{margin:16px;display:inline-block}button,select{font:inherit;padding:8px}section{margin-bottom:70px}@media(max-width:700px){.columns{grid-template-columns:1fr}body{margin:18px}}</style><main><h1>对话盲评</h1><button id="download">导出评分</button><div id="root"></div></main><script>const pairs=${data};const dataset=${dataset};const ratings={};for(const pair of pairs){const section=document.createElement('section');const title=document.createElement('h2');title.textContent=pair.id;section.append(title);const columns=document.createElement('div');columns.className='columns';for(const side of ['A','B']){const col=document.createElement('div');const h=document.createElement('h3');h.textContent=side;col.append(h);for(const m of pair[side]){const article=document.createElement('article');const name=document.createElement('b');name.textContent=m.name;const p=document.createElement('p');p.textContent=m.text;article.append(name,p);col.append(article)}for(const metric of ['接话自然度','重复程度（高分表示更少）','人物辨识度','关系连续性']){const label=document.createElement('label');label.textContent=metric;const select=document.createElement('select');for(const score of ['未评分','无法评价',1,2,3,4,5]){const option=document.createElement('option');option.textContent=score;select.append(option)}select.onchange=()=>{ratings[pair.id+':'+side+':'+metric]=select.value};label.append(select);col.append(label)}columns.append(col)}section.append(columns);document.querySelector('#root').append(section)}document.querySelector('#download').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({dataset,at:new Date().toISOString(),ratings},null,2)],{type:'application/json'}));a.download='human-ratings.json';a.click();URL.revokeObjectURL(a.href)};</script></html>`);
store.close();
console.log(`Saved ${reports.length} runs, ${pairs.length} blind pairs in ${directory}`);
