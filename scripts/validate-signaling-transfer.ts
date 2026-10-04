import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadRegistry } from "../src/society/models";
import { builtinCharacter } from "../src/society/profiles";
import { runtimeCharacter } from "../src/server/routes/runs";
import { RunService } from "../src/runtime/run";
import { SocietyStore } from "../src/runtime/store";
import { modelParticipantFactory } from "../src/runtime/participant";
import { runSpecSchema, type WorldEvent } from "../src/runtime/types";
import { agentSourceHash, snapshotAgentSource } from "../src/agents/provenance";
import { nativeConfiguration, nativeError } from "../src/agents/sdk";
import type { AgentMind, CognitiveMemory } from "../src/agents/cognition";
import { importGeneralResults } from "./import-general-results";

const sourceDirectory = process.argv[2];
if (!sourceDirectory) throw new Error("Usage: validate-signaling-transfer.ts <completed-signaling-validation-directory>");
const source = path.resolve(sourceDirectory);
const batch = JSON.parse(readFileSync(path.join(source, "results.json"), "utf8")) as {
  passed?: boolean; sourceHash: string; sourceChanged?: boolean; results: Array<{ id: string; runId: string; status: string; roster: string[] }>;
};
assert.equal(typeof batch.passed, "boolean", "Wait until the source batch is finished");
assert.equal(batch.sourceChanged, false); assert.equal(agentSourceHash(), batch.sourceHash);
// Chosen by its planned role/incentive condition, irrespective of whether any report was false.
const anchor = batch.results.find(result => result.id === "seed-23-sender-builtin-03-conflicting");
assert.ok(anchor && anchor.status === "completed", "The preselected source condition must have completed; do not replace it with a successful alternative");
const directory = path.resolve(process.env.SIGNALING_TRANSFER_DIR ?? `data/signaling-transfer-validation-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
const sourceHash = snapshotAgentSource(path.join(directory, "source"));
cpSync("scripts/validate-signaling-transfer.ts", path.join(directory, "source/validate-signaling-transfer.ts"));
cpSync("scripts/import-general-results.ts", path.join(directory, "source/import-general-results.ts"));
const registry = loadRegistry("data/model-settings.json"); const configuration = nativeConfiguration(registry);
const store = new SocietyStore(path.join(directory, "results.sqlite"));
const imported = importGeneralResults(path.join(source, "results.sqlite"), path.join(directory, "results.sqlite"));
const sourceMemoryInventory: Array<{ actorId: string; snapshotId: string; episodeProcedural: number; transferableProcedural: number; transferableExperiences: number }> = [];
const initialSnapshots = Object.fromEntries(anchor.roster.map(actorId => {
  const snapshot = store.snapshots(actorId).find(snapshot => snapshot.runId === anchor.runId);
  assert.ok(snapshot?.cognition);
  const memories = snapshot.cognition.memories.filter(memory => memory.status !== "retired");
  sourceMemoryInventory.push({ actorId, snapshotId: snapshot.id,
    episodeProcedural: memories.filter(memory => memory.kind === "procedural" && memory.scope === "episode").length,
    transferableProcedural: memories.filter(memory => memory.kind === "procedural" && memory.scope === "transferable").length,
    transferableExperiences: memories.filter(memory => memory.kind === "episodic" && memory.scope === "transferable").length });
  return [actorId, snapshot.id];
}));
const characters = Array.from({ length: 6 }, (_, i) => runtimeCharacter(builtinCharacter(`builtin-${String(i + 1).padStart(2, "0")}`)!));
const spec = runSpecSchema.parse({ scenario: "werewolf", rounds: 2, seed: 23, mode: "experiment", worldId: "signaling-to-hidden-roles", initialSnapshots,
  roster: characters.map(character => ({ characterId: character.id, modelProfileId: "gpt-6-luna" })),
  budgets: { discussionTurns: 6, maxTurns: 8 }, cognition: { requestTimeoutMs: 60000 },
  experiment: { psychology: "hybrid", speaking: "round-robin", relationshipMemory: true } });
write("manifest.json", { sourceHash, configuration, sourceDirectory: source, sourceRunId: anchor.runId, sourceCondition: anchor.id, imported, spec, sourceMemoryInventory,
  purpose: "One fresh hidden-role episode after an information-trading episode. Check portable memory inputs and current identity isolation with the same production Agent. This is not a replay or a retry of any prior failed episode.",
  thresholds: { completed: true, failedCalls: 0, toolErrors: 0, transferredActors: anchor.roster.length, sourceChanged: false },
  earlierFailuresRetained: true, createdAt: new Date().toISOString() });
// This check measures procedural transfer. Outcome experiences alone cannot satisfy it.
// Do not spend model calls on an impossible gate or select another source after seeing its behavior.
if (sourceMemoryInventory.some(actor => actor.transferableProcedural === 0)) {
  const result = { passed: false, protocolIntegrityPassed: null, preconditionPassed: false, sourceHash, sourceChanged: agentSourceHash() !== sourceHash,
    sourceRunId: anchor.runId, status: "not_started", calls: 0, failedCalls: 0, toolErrors: 0, sourceMemoryInventory,
    reason: "预定源局并非每位人物都有可迁移条件策略；仅本局策略保持隔离。未启动新的模型调用，也未替换源局。", finishedAt: new Date().toISOString() };
  write("results.json", result); console.log(JSON.stringify({ ...result, artifact: directory }));
  store.close(); process.exit(1);
}
const service = new RunService(store, modelParticipantFactory(registry));
const { run } = service.create(spec, characters);
console.log(JSON.stringify({ artifact: directory, runId: run.id, sourceHash, sourceRunId: anchor.runId, model: configuration.modelId, api: configuration.apiMode }));
const progress = setInterval(() => console.log(JSON.stringify({ runId: run.id, status: run.status, phase: run.world.stage()?.label, calls: store.cases(run.id).length })), 20_000);
const limit = setTimeout(() => service.stopAll(), 15 * 60_000);
try {
  await run.settled();
  const cases = store.cases(run.id); const events = store.events(run.id);
  const transferredActors = new Set<string>(); let inputsWithTransfer = 0; let evidenceChecked = 0; let toolResultPairs = 0;
  const transferSamples: unknown[] = [];
  for (const record of cases) {
    assert.equal(record.sourceHash, sourceHash); assert.equal(record.configuration.modelId, "gpt-6-luna");
    assert.equal(record.configuration.apiMode, "responses"); assert.equal(record.configuration.contextWindow, 256000);
    assert.equal(record.configuration.retryLimit, 0); assert.equal(record.configuration.modelInjected, false);
    if (record.error) assert.equal(Boolean(store.db.prepare("SELECT 1 FROM agent_activations WHERE id=?").get(record.opportunityId)), false, "Failed activations must not commit");
    if (!record.providerRequest) { assert.ok(record.error); continue; }
    const request = record.providerRequest as { model: string; stream: boolean; parallel_tool_calls: boolean; store: boolean; truncation: string;
      tools: Array<{ type: string; strict: boolean }>; input: Array<{ type?: string; role?: string; call_id?: string; content?: string | Array<{ type: string; text: string }> }> };
    assert.equal(request.model, "gpt-6-luna"); assert.equal(request.stream, true); assert.equal(request.parallel_tool_calls, false);
    assert.equal(request.store, false); assert.equal(request.truncation, "disabled"); assert.ok(request.tools.every(tool => tool.type === "function" && tool.strict));
    const calls = new Set<string>();
    for (const item of request.input) {
      if (item.type === "function_call") { assert.ok(item.call_id && !calls.has(item.call_id)); calls.add(item.call_id); }
      if (item.type === "function_call_output") { assert.ok(item.call_id && calls.has(item.call_id)); toolResultPairs++; }
    }
    const content = request.input.find(item => item.role === "user")?.content; assert.ok(content);
    const view = JSON.parse(typeof content === "string" ? content : content.filter(part => part.type === "input_text").map(part => part.text).join("")) as {
      actor: { id: string }; evidence: WorldEvent[]; cognition: AgentMind; observation: { facts: { scenario: string; ownRole: string } };
    };
    assert.equal(view.actor.id, record.actorId); assert.equal(view.observation.facts.scenario, "werewolf");
    assert.ok(!["sender", "receiver"].includes(view.observation.facts.ownRole));
    for (const event of view.evidence) {
      assert.ok(event.visibility === "public" || Array.isArray(event.visibility) && event.visibility.includes(record.actorId));
      assert.ok(!event.data.identityScope || event.data.identityScope === run.id); evidenceChecked++;
    }
    assert.ok(Object.values(view.cognition.episodeBeliefs ?? {}).every(belief => belief.episode === run.id));
    const memories: CognitiveMemory[] = view.cognition.memories.filter(memory => memory.episode === anchor.runId && memory.kind === "procedural" && memory.scope === "transferable");
    if (memories.length) {
      inputsWithTransfer++;
      if (!transferredActors.has(record.actorId)) transferSamples.push({ actorId: record.actorId, caseId: record.id, newRole: view.observation.facts.ownRole, memories });
      transferredActors.add(record.actorId);
    }
  }
  const minds = characters.flatMap(character => store.cognition(run.id, character.id) ?? []);
  const publicView = JSON.stringify(run.view({}));
  const publicPrivateIntentLeaks = minds.flatMap(mind => mind.decisions.filter(decision => decision.episode === run.id && decision.privateAim.length > 15 && publicView.includes(decision.privateAim))).length;
  const failedCalls = cases.filter(record => record.error).length; const toolErrors = events.filter(event => event.data.toolError).length;
  const sourceChanged = agentSourceHash() !== sourceHash;
  const passed = run.status === "completed" && failedCalls === 0 && toolErrors === 0 && !sourceChanged && publicPrivateIntentLeaks === 0 && transferredActors.size === anchor.roster.length;
  const result = { passed, protocolIntegrityPassed: true, sourceHash, sourceChanged, sourceRunId: anchor.runId, runId: run.id, status: run.status, calls: cases.length, failedCalls, toolErrors,
    activations: (store.db.prepare("SELECT count(*) AS n FROM agent_activations WHERE run_id=?").get(run.id) as { n: number }).n,
    transferredActors: [...transferredActors], inputsWithTransfer, evidenceChecked, toolResultPairs, publicPrivateIntentLeaks, transferSamples,
    errors: cases.filter(record => record.error).map(record => ({ caseId: record.id, opportunityId: record.opportunityId, error: record.error, finishReason: record.finishReason, response: record.response })),
    publicMessages: events.filter(event => event.type === "message" && event.visibility === "public").map(event => ({ id: event.id, seq: event.seq, actorId: event.actorId, text: event.text })),
    decisions: minds.flatMap(mind => mind.decisions.filter(decision => decision.episode === run.id).map(decision => ({ actorId: mind.actorId, ...decision }))),
    world: run.world.publicState(), finishedAt: new Date().toISOString(),
    interpretation: "A fresh transfer episode; old failed episodes remain failures. Loaded portable rules demonstrate reuse of experience, not a causal gain in performance." };
  write("results.json", result);
  console.log(JSON.stringify({ passed, protocolIntegrityPassed: true, runId: run.id, status: run.status, calls: cases.length, failedCalls, toolErrors,
    transferredActors: [...transferredActors], inputsWithTransfer, sourceChanged, artifact: directory }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  write("results.json", { passed: false, sourceHash, runId: run.id, status: run.status, error: nativeError(error), finishedAt: new Date().toISOString() });
  console.log(JSON.stringify({ error: nativeError(error), artifact: directory })); process.exitCode = 1;
} finally { clearInterval(progress); clearTimeout(limit); service.stopAll(); await run.settled(); store.close(); }
