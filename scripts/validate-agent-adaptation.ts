import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResponseCreateParams } from "openai/resources/responses/responses";
import { importGeneralResults } from "./import-general-results";
import { SocietyStore } from "../src/runtime/store";
import { RunService } from "../src/runtime/run";
import { modelParticipantFactory } from "../src/runtime/participant";
import { runSpecSchema, type CharacterSnapshot } from "../src/runtime/types";
import { createAgentMind } from "../src/agents/cognition";
import { nativeConfiguration, nativeError } from "../src/agents/sdk";
import { agentSourceHash, snapshotAgentSource } from "../src/agents/provenance";
import { loadRegistry } from "../src/society/models";

function initialInput(providerRequest: unknown) {
  const request = providerRequest as ResponseCreateParams | undefined;
  const message = Array.isArray(request?.input) ? request.input.find(item => "role" in item && item.role === "user") : undefined;
  const content = message && "content" in message ? message.content : request?.input;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.flatMap(part => part.type === "input_text" ? [part.text] : []).join("") : undefined;
  assert.ok(text, "The saved native request must contain a user input");
  return JSON.parse(text);
}

// This is a small descriptive intervention pilot, not a claim of improved or human-like intelligence.
const directory = path.resolve(process.env.AGENT_ADAPTATION_DIR ?? `data/general-adaptation-validation-${Date.now()}`);
const sourceFile = path.resolve(process.env.AGENT_ADAPTATION_SOURCE ?? "data/general-responses-validation-1791057075396/results.sqlite");
mkdirSync(directory, { recursive: true });
const sourceHash = snapshotAgentSource(path.join(directory, "source"));
cpSync("scripts/validate-agent-adaptation.ts", path.join(directory, "source/validate-agent-adaptation.ts"));
const store = new SocietyStore(path.join(directory, "results.sqlite"));
importGeneralResults(sourceFile, path.join(directory, "results.sqlite"));
const source = store.list().find(run => run.status === "completed" && run.spec.scenario === "public-goods" && run.spec.experiment.psychology === "hybrid");
assert.ok(source, "A completed real source episode is required");
const characters = source.characters;
const focalId = characters[0].id;
// Check the analyzer against an existing real request before starting paid model work.
assert.equal(initialInput(store.cases(source.id).find(record => record.actorId === focalId)?.providerRequest).actor?.id, focalId);
const originalSnapshots = Object.fromEntries(characters.map(character => {
  const snapshot = store.snapshots(character.id).find(snapshot => snapshot.runId === source.id);
  assert.ok(snapshot?.cognition); return [character.id, snapshot];
}));
const before = JSON.stringify(originalSnapshots);
const cold: CharacterSnapshot = { ...structuredClone(originalSnapshots[focalId]), id: randomUUID(), parentId: originalSnapshots[focalId].id,
  memoryIds: [], cognition: createAgentMind(focalId, originalSnapshots[focalId].cognition!.episode) };
store.db.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?)").run(cold.id, cold.characterId, cold.worldId, cold.runId, JSON.stringify(cold));
store.annotate(source.id, { kind: "experience-ablation", snapshotId: cold.id, originSnapshotId: originalSnapshots[focalId].id,
  removed: ["memoryIds", "cognition memories", "learned relationships", "plans", "predictions", "feedback statistics", "experienced emotion and need state"],
  unchanged: ["character identity", "persona", "traits", "environment rules", "other agents' source snapshots"] });
const registry = loadRegistry("data/model-settings.json");
const service = new RunService(store, modelParticipantFactory(registry));
const configuration = nativeConfiguration(registry);
const schedule = ["trust-game", "public-goods"].flatMap(scenario => [0, 1].map(repeat => ({ scenario: scenario as "trust-game" | "public-goods", repeat })));
const manifest = { sourceHash, sourceFile, sourceRunId: source.id, focalId, configuration, schedule,
  intervention: "Only the focal agent receives either its actual prior experience or an empty experience state. Persona, rules and other actors' initial states stay fixed.",
  conditionsNotIncludedInModelPrompt: true, purpose: "Verify transfer reaches real model input and measure any subsequent action differences. Small stochastic pilot; no improvement or single-mechanism causal claim.", createdAt: new Date().toISOString() };
writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ artifact: directory, sourceHash, focalId }));
const results: Array<Record<string, unknown>> = [];
const pairs: Array<Record<string, unknown>> = [];
const progress = setInterval(() => console.log(JSON.stringify({ running: [...service.live.values()].map(run => ({ id: run.id, scenario: run.record.spec.scenario, phase: run.world.stage()?.label, cases: store.cases(run.id).length })) })), 30_000);
const timeout = setTimeout(() => service.stopAll(), 20 * 60_000);
try {
  for (const pair of schedule) {
    const settledPair = await Promise.allSettled((["experienced", "empty-experience"] as const).map(async condition => {
      const roster = characters.slice(0, pair.scenario === "trust-game" ? 2 : 3);
      const initialSnapshots = Object.fromEntries(roster.map(character => [character.id, condition === "empty-experience" && character.id === focalId ? cold.id : originalSnapshots[character.id].id]));
      const spec = runSpecSchema.parse({ scenario: pair.scenario, rounds: 2, seed: 31 + pair.repeat, mode: "experiment", worldId: `adaptation-${pair.scenario}-${pair.repeat}`, initialSnapshots,
        roster: roster.map(character => ({ characterId: character.id, modelProfileId: "gpt-6-luna" })),
        budgets: { discussionTurns: roster.length, maxTurns: 8 }, cognition: { requestTimeoutMs: 60000 },
        experiment: { psychology: "hybrid", speaking: "round-robin", relationshipMemory: true } });
      const { run } = service.create(spec, structuredClone(roster)); await run.settled();
      const events = store.events(run.id), cases = store.cases(run.id);
      const first = cases.find(record => record.actorId === focalId)!;
      const initial = initialInput(first?.providerRequest);
      assert.equal(initial.actor?.id, focalId, "Capture the actual first HTTP input, not reconstructed intentions");
      const mind = store.cognition(run.id, focalId);
      const actions = events.filter(event => event.actorId === focalId && event.type === "action").map(event => ({ action: event.data.action, amount: event.data.amount, input: event.data.input }));
      const result = { ...pair, condition, runId: run.id, status: run.status, calls: cases.length, failedCalls: cases.filter(record => record.error).length,
        toolErrors: events.filter(event => event.data.toolError).length, initialMemories: initial.cognition?.memories?.length ?? 0,
        initialLearnedEpisodes: initial.cognition?.learning?.episodes?.length ?? 0,
        initialActor: initial.actor, initialObservation: initial.observation,
        actions, strategies: mind?.decisions.map(decision => ({ action: decision.action, strategy: decision.strategy, intent: decision.intent })),
        callsToRecall: events.filter(event => event.data.harness && event.data.kind === "tool_end" && event.data.toolName === "recall").length,
        finalWorld: run.world.publicState() };
      results.push(result); writeFileSync(path.join(directory, "results.json"), JSON.stringify({ status: "running", sourceHash, results, pairs }, null, 2));
      console.log(JSON.stringify({ ...pair, condition, runId: run.id, status: run.status, calls: cases.length, actions, initialMemories: result.initialMemories }));
      return result;
    }));
    // A reporting error in one condition must not abort the other real run.
    const failure = settledPair.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const pairResults = settledPair.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const [experienced, empty] = pairResults;
    assert.deepEqual(experienced.initialActor, empty.initialActor);
    assert.deepEqual(experienced.initialObservation, empty.initialObservation);
    assert.ok(experienced.initialMemories > 0); assert.equal(empty.initialMemories, 0);
    assert.ok(experienced.initialLearnedEpisodes > 0); assert.equal(empty.initialLearnedEpisodes, 0);
    pairs.push({ ...pair, experienced: experienced.runId, empty: empty.runId, samePersonaAndInitialWorld: true,
      actionsDiffer: JSON.stringify(experienced.actions) !== JSON.stringify(empty.actions) });
  }
  for (const snapshot of Object.values(originalSnapshots)) assert.deepEqual(store.snapshot(snapshot.id), snapshot);
  assert.equal(JSON.stringify(originalSnapshots), before);
  const sourceChanged = sourceHash !== agentSourceHash();
  const passed = !sourceChanged && results.length === schedule.length * 2 && results.every(result => result.status === "completed" && result.failedCalls === 0 && result.toolErrors === 0);
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ passed, sourceHash, sourceChanged, results, pairs,
    pairsWithDifferentActions: pairs.filter(pair => pair.actionsDiffer).length, sourceSnapshotsPreserved: true,
    limitation: "An experience package changed, including emotion and relationships. Individual mechanism causality and improved strategy were not established. Failures remain in the denominator.", finishedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ passed, artifact: directory, pairsWithDifferentActions: pairs.filter(pair => pair.actionsDiffer).length }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ passed: false, sourceHash, results, pairs, error: nativeError(error) }, null, 2));
  throw error;
} finally { clearInterval(progress); clearTimeout(timeout); service.stopAll(); await Promise.allSettled([...service.live.values()].map(run => run.settled())); store.close(); }
