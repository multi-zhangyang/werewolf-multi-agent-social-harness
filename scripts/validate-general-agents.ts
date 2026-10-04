import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadRegistry } from "../src/society/models";
import { modelParticipantFactory } from "../src/runtime/participant";
import { SocietyStore } from "../src/runtime/store";
import { RunService } from "../src/runtime/run";
import { runSpecSchema, type RunSpec } from "../src/runtime/types";
import { builtinCharacter } from "../src/society/profiles";
import { runtimeCharacter } from "../src/server/routes/runs";
import { agentSourceHash, snapshotAgentSource } from "../src/agents/provenance";
import { nativeConfiguration, nativeError } from "../src/agents/sdk";
import { activeMemories } from "../src/agents/cognition";

const directory = path.resolve(process.env.AGENT_VALIDATION_DIR ?? `data/general-responses-validation-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const registry = loadRegistry("data/model-settings.json");
const configuration = nativeConfiguration(registry);
const sourceHash = snapshotAgentSource(path.join(directory, "source"));
cpSync("scripts/validate-general-agents.ts", path.join(directory, "source/validate-general-agents.ts"));
const store = new SocietyStore(path.join(directory, "results.sqlite"));
const factory = modelParticipantFactory(registry);
const service = new RunService(store, factory);
const characters = Array.from({ length: 6 }, (_, i) => runtimeCharacter(builtinCharacter(`builtin-${String(i + 1).padStart(2, "0")}`)!));
const schedule: Array<{ scenario: RunSpec["scenario"]; count: number; psychology: "hybrid" | "off"; worldId: string }> = [
  { scenario: "trust-game", count: 2, psychology: "hybrid", worldId: "general-learning" },
  { scenario: "public-goods", count: 3, psychology: "hybrid", worldId: "general-learning" },
  { scenario: "werewolf", count: 6, psychology: "hybrid", worldId: "general-learning" },
  { scenario: "trust-game", count: 2, psychology: "off", worldId: "facts-control" },
];
const manifest = { sourceHash, configuration, schedule, createdAt: new Date().toISOString(),
  purpose: "Real native Luna integration across environments, privacy, persistence and feedback; not an estimate of human validity or strategy improvement.",
  thresholds: { completedRuns: schedule.length, failedActivations: 0, failedCalls: 0, toolErrors: 0, publicPrivateIntentLeaks: 0, sourceChanged: false, learningCoverage: true }, status: "running" };
writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ artifact: directory, sourceHash, model: configuration.modelId, api: configuration.apiMode }));
const results: Record<string, unknown>[] = [];
const progress = setInterval(() => {
  const current = [...service.live.values()][0];
  if (current) console.log(JSON.stringify({ progress: current.record.spec.scenario, runId: current.id, status: current.status,
    phase: current.world.stage()?.label, cases: store.cases(current.id).length, activations: (store.db.prepare("SELECT count(*) AS n FROM agent_activations WHERE run_id=?").get(current.id) as { n: number }).n }));
}, 20_000);
const limit = setTimeout(() => service.stopAll(), 25 * 60_000);
try {
  for (const item of schedule) {
    const spec = runSpecSchema.parse({ scenario: item.scenario, rounds: 2, seed: 23, trustProtocol: "pledge-repair", worldId: item.worldId, mode: "continuity",
      roster: characters.slice(0, item.count).map(c => ({ characterId: c.id, modelProfileId: "gpt-6-luna" })),
      budgets: { discussionTurns: item.count, maxTurns: 8 }, cognition: { requestTimeoutMs: 60000 },
      experiment: { psychology: item.psychology, speaking: "round-robin", relationshipMemory: true } });
    const started = Date.now(); const { run } = service.create(spec, characters.slice(0, item.count));
    await run.settled();
    const events = store.events(run.id); const cases = store.cases(run.id);
    const minds = characters.slice(0, item.count).map(c => store.cognition(run.id, c.id)).filter(Boolean);
    const publicView = JSON.stringify(run.view({}));
    const privateAims = minds.flatMap(m => m!.decisions.map(d => d.privateAim)).filter(text => text.length > 15);
    const result = { ...item, runId: run.id, status: run.status, elapsedMs: Date.now() - started, inheritedSnapshots: run.record.spec.initialSnapshots,
      calls: cases.length, failedCalls: cases.filter(c => c.error).length, toolErrors: events.filter(e => e.data.toolError).length,
      failedActivations: new Set(cases.filter(c => c.error).map(c => c.opportunityId)).size,
      activations: (store.db.prepare("SELECT count(*) AS n FROM agent_activations WHERE run_id=?").get(run.id) as { n: number }).n,
      learning: minds.map(m => ({ actorId: m!.actorId, ...m!.learning, plans: m!.plans.length, proceduralMemories: activeMemories(m!).filter(x => x.kind === "procedural").length,
        revisedMemories: m!.memories.filter(memory => memory.revisions?.length).length, retiredMemories: m!.memories.filter(memory => memory.status === "retired").length,
        forecasts: m!.predictions.length, transferredMemories: activeMemories(m!).filter(memory => memory.episode !== run.id && memory.scope === "transferable").length,
        intents: [...new Set(m!.decisions.map(d => d.intent))] })), publicPrivateIntentLeaks: privateAims.filter(text => publicView.includes(text)).length,
      errors: events.filter(e => e.data.error).map(e => e.text), world: run.world.publicState() };
    results.push(result); writeFileSync(path.join(directory, "results.json"), JSON.stringify({ status: "running", sourceHash, results }, null, 2));
    console.log(JSON.stringify(result));
  }
  const sourceChanged = agentSourceHash() !== sourceHash;
  const learning = results.flatMap(result => result.learning as Array<{ plans: number; proceduralMemories: number; scored: number; transferredMemories: number }>);
  const learningCoverage = learning.some(m => m.plans > 0) && learning.some(m => m.proceduralMemories > 0) && learning.some(m => m.scored > 0) && learning.some(m => m.transferredMemories > 0);
  const passed = !sourceChanged && learningCoverage && results.length === schedule.length && results.every(r => r.status === "completed" && r.failedCalls === 0 && r.toolErrors === 0 && r.publicPrivateIntentLeaks === 0);
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ passed, sourceHash, sourceChanged, learningCoverage, results, finishedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ passed, sourceChanged, artifact: directory }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ passed: false, sourceHash, error: nativeError(error), results }, null, 2));
  console.log(JSON.stringify({ error: nativeError(error), artifact: directory })); process.exitCode = 1;
} finally { clearInterval(progress); clearTimeout(limit); service.stopAll(); await Promise.allSettled([...service.live.values()].map(run => run.settled())); store.close(); }
