import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { modelParticipantFactory } from "../src/runtime/participant";
import { runtimeCharacter } from "../src/server/routes/runs";
import { builtinCharacter } from "../src/society/profiles";
import { loadRegistry, defaultRegistryFile } from "../src/society/models/registry";
import { numberAction } from "../src/runtime/scenarios/economic";
import { runSpecSchema, type TurnContext, type WorldEvent } from "../src/runtime/types";

// A synthetic, fixed situation for a small diagnostic. This is not a completed game
// or a psychometric test. Each cell starts a fresh SDK participant/session.
const option = (key: string, fallback: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const count = Number(option("count", "1"));
if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("count must be an integer from 1 to 20");
const directory = path.resolve(option("output", `data/personality-probe-${Date.now()}`));
mkdirSync(directory, { recursive: true });
const sources = ["scripts/personality-probe.ts", "src/runtime/personality.ts", "src/runtime/participant.ts", "src/runtime/model.ts", "src/runtime/types.ts", "src/server/routes/runs.ts", "src/society/profiles.ts", "package-lock.json"];
const sourceHash = createHash("sha256").update(sources.map(f => readFileSync(f)).join("\n")).digest("hex");
const registry = loadRegistry(defaultRegistryFile());
const effort = option("effort", "configured");
if (effort !== "configured") {
  if (effort !== "low" && effort !== "medium" && effort !== "high") throw new Error("effort must be low, medium, high, or configured");
  const defaults = registry.globalDefaults();
  registry.setGlobalDefaults({ ...defaults, tuning: { ...defaults.tuning, reasoningEffort: effort } });
}
const characterIds = option("characters", "builtin-01,builtin-03").split(",");
if (!characterIds.length || characterIds.some(id => !builtinCharacter(id))) throw new Error("Unknown built-in character");
const factory = modelParticipantFactory(registry);
const observation = "三人公共品博弈。你是参与者，另两人是季衡（peer-a）与许宁（peer-b）。每人每轮有10点，可投入0–10整数点。公共池乘1.6后由三人均分，每人保留未投入的部分。这是第2轮，也是最后一轮，之后没有新交易。所有人提交后才公开本轮金额，你尚未看到任何人本轮的实际行动。";
const events: WorldEvent[] = [
  { id: "fixture-1", seq: 1, runId: "synthetic-stimulus", at: "", type: "message", actorId: "peer-a", visibility: "public", text: "咱们每人投六点，别让认真投的人吃亏。", data: { round: 1, channel: "public" } },
  { id: "fixture-2", seq: 2, runId: "synthetic-stimulus", at: "", type: "fact", visibility: "public", text: "第1轮结算：你投入6点、季衡投入0点、许宁投入6点；你获得10.4点、季衡获得16.4点、许宁获得10.4点。", data: { round: 1, settlement: true } },
  { id: "fixture-3", seq: 3, runId: "synthetic-stimulus", at: "", type: "message", actorId: "peer-a", visibility: "public", text: "上轮我确实没投。你们这轮还投六点，我就跟，这回算我补上。", data: { round: 2, channel: "public" } },
];
writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ diagnosticOnly: true, createdAt: new Date().toISOString(), count, characterIds, effort, sourceHash, observation, events, limitations: "Synthetic single decision; no causal or psychological validity claim. World seed does not seed model sampling. Names/roles/visible evidence are held constant. Full versus persona-only isolates enriched context, not personality versus no personality." }, null, 2), { flag: "wx" });
for (const file of sources) { const target = path.join(directory, "source", file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, readFileSync(file)); }
const results: Record<string, unknown>[] = [];
const jobs = characterIds.flatMap((id, index) => Array.from({ length: count }, (_, sample) => (index + sample) % 2 ? ["persona-only", "full"] as const : ["full", "persona-only"] as const).flatMap((modes, sample) => modes.map(personality => ({ id, sample, personality }))));
async function worker() {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const character = { ...runtimeCharacter(builtinCharacter(job.id)!), name: "参与者", id: "self" };
    const spec = runSpecSchema.parse({ scenario: "public-goods", mode: "experiment", roster: ["self", "peer-a", "peer-b"].map(characterId => ({ characterId, modelProfileId: registry.globalDefaults().modelProfileId })), rounds: 2, budgets: { maxTurns: 6 }, experiment: { personality: job.personality, relationshipMemory: false, psychology: "off" } });
    const participant = factory(character, spec, `${job.id}:${job.sample}:${job.personality}`);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 150000);
    const actions: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolTrace: Record<string, unknown>[] = [];
    const receipts: Record<string, unknown>[] = [];
    const started = Date.now(); let speech: string | undefined; let error: string | undefined;
    const action = numberAction("contribute", "投入", 10);
    const context: TurnContext = {
      character, observation, inbox: events, recent: events, memories: [], signal: controller.signal,
      opportunity: { id: "speech", actorId: "self", channel: "public", recipients: [], stage: { id: "2:discussion", label: "自由交流", kind: "discussion", round: 2, actors: ["self", "peer-a", "peer-b"], channel: "public" }, actions: [], communications: [] },
      recordModelResponse: r => receipts.push({ ...r }),
      async call(name, args) {
        toolTrace.push({ name, args });
        if (name === "wait") return { waited: true };
        if (name === "recall_memory") return [];
        if (name === "remember") return { saved: true, scope: "diagnostic-only" };
        if (name !== "contribute" || context.opportunity.stage.kind !== "action" || actions.length) throw new Error("这项行动不可用或已提交");
        action.parameters.parse(args); actions.push({ name, args }); return { accepted: true };
      },
    };
    try {
      speech = (await participant.turn(context)).text;
      context.opportunity = { ...context.opportunity, id: "action", stage: { ...context.opportunity.stage, id: "2:contribute", kind: "action", label: "投入中" }, actions: [action] };
      context.recent = [...events, ...(speech ? [{ id: "self-speech", seq: 4, runId: "synthetic-stimulus", at: "", type: "message" as const, actorId: "self", visibility: "public" as const, text: speech, data: { channel: "public", round: 2 } }] : [])];
      context.inbox = [];
      await participant.turn(context);
      if (!actions.length) throw new Error("No committed action");
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { clearTimeout(timer); }
    const result = { ...job, character, status: error ? "failed" : "completed", speech, actions, error, durationMs: Date.now() - started, configuration: participant.configuration, receipts, toolTrace };
    results.push(result);
    writeFileSync(path.join(directory, `${job.id}-${job.personality}-${job.sample}.json`), JSON.stringify(result, null, 2));
    writeFileSync(path.join(directory, "results.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ character: job.id, condition: job.personality, status: result.status, speech, actions }));
  }
}
await Promise.all([worker(), worker()]);
console.log(`Saved ${results.length} diagnostic cells to ${directory}`);
