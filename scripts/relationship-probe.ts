import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SocietyStore } from "../src/runtime/store";
import { RunService } from "../src/runtime/run";
import { modelParticipantFactory } from "../src/runtime/participant";
import { runSpecSchema, type ParticipantFactory, type TurnContext } from "../src/runtime/types";
import { loadRegistry, defaultRegistryFile } from "../src/society/models/registry";
import { builtinCharacters } from "../src/society/profiles";
import { runtimeCharacter } from "../src/server/routes/runs";

const directory = path.resolve(process.argv.find(a => a.startsWith("--output="))?.slice(9) ?? "data/relationship-probe");
if (existsSync(path.join(directory, "manifest.json"))) throw new Error("请为新试验指定新的 --output 目录");
mkdirSync(directory, { recursive: true });
const characters = builtinCharacters().slice(0, 2).map(runtimeCharacter);
const [focal, partner] = characters;
const registry = loadRegistry(defaultRegistryFile());
const store = new SocietyStore(path.join(directory, "runs.sqlite"));
const base = runSpecSchema.parse({ scenario: "trust-game", worldId: "controlled-stimulus", rounds: 2, seed: 23, roster: characters.map(c => ({ characterId: c.id, modelProfileId: registry.globalDefaults().modelProfileId })), budgets: { discussionTurns: 4 } });
const sourceFiles = ["src/runtime/participant.ts", "src/runtime/run.ts", "src/runtime/model.ts", "src/runtime/store.ts", "src/runtime/types.ts", "src/runtime/scenarios/economic.ts", "scripts/relationship-probe.ts", "package.json", "package-lock.json"];
const sourceHash = createHash("sha256").update(sourceFiles.map(f => readFileSync(f)).join("\n")).digest("hex");
for (const file of sourceFiles) { const target = path.join(directory, "source", file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, readFileSync(file)); }
writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ sourceHash, sourceFiles, characters, node: process.version, stimulus: "Source episode is scripted: partner promises 12 after an investment of 6, then actually returns 0. This is a controlled fixture, not model-generated behavior. Each experimental partner is also scripted; only the focal character uses the configured real model. The partner asks for recall, then offers and actually returns half of received funds. Memory-on/off variants fork the same snapshot. One sample per condition; not a causal conclusion or human rating." }, null, 2));

const stageKey = (c: TurnContext) => c.opportunity.stage.id;
const sourceFactory: ParticipantFactory = character => {
  const spoken = new Set<string>();
  return { configuration: { kind: "scripted", role: "stimulus" }, async turn(c) {
    if (c.opportunity.actions.length) {
      for (const a of c.opportunity.actions) {
        const amount = a.name === "invest" ? c.opportunity.stage.round === 1 ? 6 : 2 : c.opportunity.stage.round === 1 ? 0 : 3;
        await c.call(a.name, { amount });
      }
      return {};
    }
    if (spoken.has(stageKey(c))) return { waited: true };
    spoken.add(stageKey(c));
    if (c.opportunity.stage.round === 1) {
      if (stageKey(c).endsWith("reflection")) return { text: character.id === partner.id ? "我没返还，是我临时反悔了。" : "这次你给我的不是你答应的。" };
      return { text: character.id === partner.id ? "你投6点，我答应返你12点。" : "我愿意先投6点，但我会看你是否兑现。" };
    }
    return { text: character.id === partner.id ? "这轮轮到我来投资。我们先把这一轮做完。" : "这一轮的选择由你自己决定。" };
  } };
};
const stimulus = new RunService(store, sourceFactory).create(base, characters).run;
await stimulus.settled();
if (stimulus.status !== "completed") throw new Error("Controlled fixture did not complete");
const snapshots = Object.fromEntries(characters.map(c => [c.id, store.head(base.worldId, c.id)!]));
writeFileSync(path.join(directory, "stimulus.json"), JSON.stringify({ record: stimulus.record, events: store.events(stimulus.id), snapshots }, null, 2));

const realFactory = modelParticipantFactory(registry);
const factory: ParticipantFactory = (character, spec, runId) => {
  if (character.id === focal.id) return realFactory(character, spec, runId);
  const spoken = new Set<string>();
  return { configuration: { kind: "scripted", role: "repair-partner" }, async turn(c) {
    if (c.opportunity.actions.length) {
      for (const a of c.opportunity.actions) {
        const investment = c.recent.findLast(e => e.type === "action" && e.data.action === "invest" && e.data.round === c.opportunity.stage.round);
        await c.call(a.name, { amount: a.name === "invest" ? 5 : Math.floor(Number(investment?.data.amount ?? 0) * 3 / 2) });
      }
      return {};
    }
    if (spoken.has(stageKey(c))) return { waited: true };
    spoken.add(stageKey(c));
    if (stageKey(c) === "1:discussion") return { text: "你还记得前一局第一轮，我答应返你多少、最后给了多少吗？如果你还愿意投，这次我会返还到账的一半。" };
    if (stageKey(c) === "1:reflection") {
      const returned = c.recent.findLast(e => e.type === "action" && e.data.action === "return_funds" && e.data.round === 1);
      return { text: `这次实际返还了${returned?.data.amount}点。我知道一次兑现不能抹掉之前的事，下一轮你按自己的想法决定。` };
    }
    if (stageKey(c) === "2:discussion") return { text: "现在换我把5点交给你。你可以不按我的提议来，我想听你的真实想法。" };
    return { waited: true };
  } };
};
const service = new RunService(store, factory);
const results = await Promise.all([true, false].map(async relationshipMemory => {
  const spec = runSpecSchema.parse({ ...base, mode: "experiment", initialSnapshots: snapshots, experiment: { relationshipMemory, speaking: "ready-queue" } });
  const run = service.create(spec, characters).run;
  const timer = setTimeout(() => { if (run.status === "running") run.control("stop"); }, 900000);
  await run.settled(); clearTimeout(timer);
  const events = store.events(run.id);
  const recalls = events.filter(e => e.actorId === focal.id && e.type === "trace" && e.text === "recall_memory" && !e.data.toolError);
  const result = { id: run.id, relationshipMemory, status: run.status, recallCalls: recalls.length, recalledSourceEpisode: recalls.some(e => Array.isArray(e.data.result) && e.data.result.some(m => m.runId === stimulus.id)), focalActions: events.filter(e => e.type === "action" && e.actorId === focal.id), errors: events.filter(e => e.data.error).map(e => e.text) };
  writeFileSync(path.join(directory, `${run.id}.json`), JSON.stringify({ result, record: run.record, events }, null, 2));
  console.log(JSON.stringify(result)); return result;
}));
writeFileSync(path.join(directory, "results.json"), JSON.stringify({ sourceId: stimulus.id, snapshots, results }, null, 2));
store.close();
