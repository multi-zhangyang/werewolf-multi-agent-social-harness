import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { modelParticipantFactory } from "../src/runtime/participant";
import { psychologicalStateSchema, type PsychologicalState } from "../src/runtime/psychology";
import { numberAction } from "../src/runtime/scenarios/economic";
import { runSpecSchema, type TurnContext, type WorldEvent } from "../src/runtime/types";
import { runtimeCharacter } from "../src/server/routes/runs";
import { builtinCharacter } from "../src/society/profiles";
import { loadRegistry } from "../src/society/models/registry";

const option = (key: string, fallback: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const directory = path.resolve(option("output", `data/psychology-probe-${Date.now()}`));
const ids = option("characters", "builtin-01,builtin-04").split(",");
if (ids.some(id => !builtinCharacter(id))) throw new Error("Unknown character");
mkdirSync(directory, { recursive: true });
const sources = ["scripts/psychology-probe.ts", "src/runtime/psychology.ts", "src/runtime/participant.ts", "src/runtime/personality.ts", "src/runtime/types.ts", "src/runtime/model.ts", "src/society/profiles.ts", "package-lock.json"];
const sourceHash = createHash("sha256").update(sources.map(file => readFileSync(file)).join("\n")).digest("hex");
const base: WorldEvent[] = [
  { id: "promise", seq: 1, runId: "controlled-history", at: "", type: "message", actorId: "peer", visibility: "public", text: "你投6点，我会返还到账的一半，也就是9点。", data: { channel: "public", round: 1 } },
  { id: "breach", seq: 2, runId: "controlled-history", at: "", type: "fact", visibility: "public", text: "你实际投资6点，对方到账18点但返还0点。系统确认其承诺未兑现；你获得4点，对方获得18点。", data: { commitment: { promised: 9, returned: 0, kept: false }, round: 1 } },
];
const conditions = [
  { id: "breach", event: undefined },
  { id: "apology", event: { id: "apology", seq: 3, runId: "controlled-history", at: "", type: "message" as const, actorId: "peer", visibility: "public" as const, text: "刚才是我反悔了。对不起，我想继续合作。", data: { channel: "public", round: 1 } } },
  { id: "repair", event: { id: "repair", seq: 4, runId: "controlled-history", at: "", type: "action" as const, actorId: "peer", visibility: "public" as const, text: "对方从自己的18点所得中实际向你转出9点作为补偿。补偿后你累计13点，对方累计9点。", data: { action: "repair_transfer", amount: 9, round: 1 } } },
];
writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), diagnosticOnly: true, sourceHash, ids, conditions, base, design: "Within-character sequential diagnostic: the same participant observes breach, apology, then costly repair. It makes a fresh hypothetical investment decision at each observation. Those probe choices are not executed between observations. The stimulus is scripted, all psychology and choices are from the configured real model. This is not a completed game, a randomized causal comparison, or a validated psychological measurement." }, null, 2), { flag: "wx" });
for (const file of sources) { const target = path.join(directory, "source", file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, readFileSync(file)); }
const registry = loadRegistry(); const results: Record<string, unknown>[] = [];
await Promise.all(ids.map(async id => {
  const character = { ...runtimeCharacter(builtinCharacter(id)!), id: "self", name: "参与者" };
  const spec = runSpecSchema.parse({ scenario: "trust-game", mode: "experiment", roster: [{ characterId: "self" }, { characterId: "peer" }], rounds: 3, budgets: { maxTurns: 4 }, experiment: { psychology: "appraisal" } });
  const participant = modelParticipantFactory(registry)(character, spec, id);
  let previous: PsychologicalState | undefined; const events = [...base];
  for (const condition of conditions) {
    if (condition.event) events.push(condition.event);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
    let state: PsychologicalState | undefined; let amount: number | undefined; let speech: string | undefined; let error: string | undefined;
    const receipts: unknown[] = []; const actions: unknown[] = []; const action = numberAction("invest", "试探性投资", 10);
    const c: TurnContext = { character, psychology: previous, recent: [...events], inbox: [...events], memories: [], signal: controller.signal,
      observation: "你=self，对方=peer。双方继续进行三轮信任交易，当前准备进入第二轮。本次只是询问：在这些已知事实下，假如由你重新投资10点中的一部分，会投多少？资源仍会变为三倍，对方可以返还0到到账额。没有看到对方下一次真实选择。不同询问之间你的试探性选择不会实际执行，因此不能把之前的回答当作已发生的新交易。",
      opportunity: { id: condition.id, actorId: "self", channel: "private", recipients: ["self"], stage: { id: condition.id, label: "观察后的投资选择", round: 2, kind: "action", channel: "public", actors: ["self"] }, actions: [action], communications: [] },
      recordModelResponse: receipt => receipts.push(receipt),
      async call(name, args) {
        actions.push({ name, args });
        if (name === "update_mind") { state = psychologicalStateSchema.parse(args); if (state.sourceIds.some(source => !events.some(e => e.id === source)) || state.relationships.some(r => r.targetId !== "peer")) throw new Error("Invalid evidence/target in diagnostic"); return state; }
        if (name === "invest") { if (amount !== undefined) throw new Error("Already submitted"); amount = (action.parameters.parse(args) as { amount: number }).amount; return { accepted: true, diagnosticOnly: true }; }
        if (name === "wait") return {};
        if (name === "recall_memory") return [];
        if (name === "remember") return { diagnosticOnly: true };
        throw new Error("Unavailable tool");
      },
    };
    try { speech = (await participant.turn(c)).text; if (!state || amount === undefined) throw new Error("Missing state or choice"); previous = state; }
    catch (e) { error = (e instanceof Error ? e.message : String(e)).replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]"); }
    finally { clearTimeout(timer); }
    const result = { character: id, condition: condition.id, status: error ? "failed" : "completed", state, amount, speech, error, receipts, actions, configuration: participant.configuration };
    results.push(result); writeFileSync(path.join(directory, `${id}-${condition.id}.json`), JSON.stringify(result, null, 2)); writeFileSync(path.join(directory, "results.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ character: id, condition: condition.id, status: result.status, strategy: state?.strategy.kind, trust: state?.relationships[0]?.trust, amount, error }));
    if (error) break;
  }
}));
