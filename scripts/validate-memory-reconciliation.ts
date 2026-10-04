import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { activeMemories, memoryOriginEpisode, type AgentMind, type CognitiveMemory } from "../src/agents/cognition";
import { agentSourceHash, snapshotAgentSource } from "../src/agents/provenance";
import { nativeConfiguration, nativeError } from "../src/agents/sdk";
import { GeneralAgentContext } from "../src/runtime/agent-context";
import type { DecisionCase } from "../src/runtime/cases";
import { modelParticipantFactory } from "../src/runtime/participant";
import type { StoredRun } from "../src/runtime/store";
import { visible, type StagedActivation, type TurnContext, type WorldEvent } from "../src/runtime/types";
import { loadRegistry } from "../src/society/models";

const [originArg, outputArg, mode] = process.argv.slice(2);
if (!originArg || !outputArg || mode && mode !== "--prepare-only") throw new Error("Usage: validate-memory-reconciliation.ts <v10-directory> <new-experiment-directory> [--prepare-only]");
const origin = path.resolve(originArg), directory = path.resolve(outputArg);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fileHash = (file: string) => digest(readFileSync(file));
const originFile = path.join(origin, "results.sqlite");
const originHash = fileHash(originFile);
const originResults = JSON.parse(readFileSync(path.join(origin, "results.json"), "utf8"));
assert.equal(originResults.sourceHash, "68090d83bbe57a0e1a95076f5be339ebefa0257d0e83ce5faee6268f6a7cbac5");
assert.equal(originResults.protocolPassed, true); assert.ok(originResults.finishedAt);
assert.equal(originResults.sourceChanged, false); assert.equal(agentSourceHash(path.join(origin, "source")), originResults.sourceHash);
const db = new Database(originFile, { readonly: true, fileMustExist: true });
const readDocument = <T>(sql: string, ...args: string[]): T => {
  const row = db.prepare(sql).get(...args) as { document: string } | undefined;
  assert.ok(row); return JSON.parse(row.document) as T;
};
const sourceEvent = (id: string) => {
  const row = db.prepare("SELECT document FROM events WHERE id=?").get(id) as { document: string } | undefined;
  return row ? JSON.parse(row.document) as WorldEvent : undefined;
};
const versions = (memory: CognitiveMemory) => [...(memory.revisions ?? []).map(revision => revision.previous), memory];
const registry = loadRegistry(process.env.MODEL_SETTINGS_FILE ?? "data/model-settings.json");
const configuration = nativeConfiguration(registry, { modelProfileId: "gpt-6-luna", maxTurns: 8, requestTimeoutMs: 60000 });
const sourceHash = agentSourceHash(), validatorHash = fileHash("scripts/validate-memory-reconciliation.ts");
const schedule: Array<{ condition: string; run: StoredRun; record: DecisionCase }> = [];
for (const condition of originResults.results) {
  assert.equal(condition.status, "completed");
  const run = readDocument<StoredRun>("SELECT document FROM runs WHERE id=?", condition.runId);
  const cases = (db.prepare("SELECT document FROM decision_cases WHERE run_id=? ORDER BY rowid").all(run.id) as { document: string }[]).map(row => JSON.parse(row.document) as DecisionCase);
  for (const actorId of condition.roster) {
    const records = cases.filter(record => record.actorId === actorId && (record.context.stage as { id: string }).id === "episode-review");
    assert.ok(records.length); assert.equal(new Set(records.map(record => record.opportunityId)).size, 1);
    const record = records[0]; const mind = record.context.cognition as AgentMind;
    assert.ok(mind && mind.actorId === actorId && mind.episode === run.id);
    assert.equal(mind.episodeReviews?.some(review => review.episode === run.id), false, "Only pre-review states are eligible");
    assert.ok(!mind.learning.episodes.includes(run.id));
    schedule.push({ condition: condition.id, run, record });
  }
}
assert.equal(schedule.length, 5);
const inventory = schedule.map(({ condition, record }) => ({ condition, actorId: record.actorId, runId: record.runId, originCaseId: record.id,
  originalOpportunityId: record.opportunityId, contextSha256: digest(JSON.stringify(record.context)) }));
mkdirSync(directory, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
const manifestFile = path.join(directory, "manifest.json");
if (!existsSync(manifestFile)) {
  assert.equal(snapshotAgentSource(path.join(directory, "source")), sourceHash);
  cpSync("scripts/validate-memory-reconciliation.ts", path.join(directory, "source/validate-memory-reconciliation.ts"), { force: false, errorOnExist: true });
  write("manifest.json", { sourceHash, validatorHash, configuration, origin, originHash, inventory, totalTimeoutMs: 10 * 60_000, createdAt: new Date().toISOString(),
    design: "All five saved v10 pre-review contexts, once each, with a fresh official SDK activation. The original episode ID identifies its existing experience; a new opportunity ID identifies this isolated alternative review. No original review, action, prediction, outcome, database row or past failure is replaced. This experiment is stored separately and is never imported as a continuation of the old runs. The new prompt and tools may update, reuse, retire or create hypotheses; no target strategy or verdict is forced.",
    thresholds: { completedReviews: 5, maxCallsPerReview: 8, failedCalls: 0, toolErrors: 0, alteredExperiences: 0, alteredPredictions: 0, alteredSourceRows: 0 },
    interpretation: "A mechanism experiment from historical terminal states. It cannot establish subsequent adoption, payoff improvement or general learning. New duplicates and factual claims require a separate content review." });
} else {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  assert.equal(manifest.sourceHash, sourceHash); assert.equal(manifest.validatorHash, validatorHash); assert.equal(manifest.originHash, originHash);
  assert.deepEqual(manifest.inventory, inventory); assert.deepEqual(manifest.configuration, configuration);
  assert.equal(agentSourceHash(path.join(directory, "source")), sourceHash);
}

interface HttpRequest {
  model: string; stream: boolean; parallel_tool_calls: boolean; store: boolean; truncation: string; tool_choice: string;
  tools: Array<{ type: string; name: string; strict: boolean; parameters: { required?: string[]; properties?: Record<string, unknown> } }>;
  input: Array<{ type?: string; role?: string; call_id?: string; output?: string; content?: string | Array<{ type: string; text: string }> }>;
}
function audit(records: DecisionCase[], before: AgentMind, after: AgentMind, context: TurnContext) {
  assert.ok(records.length > 0 && records.length <= 8); const inputContext = new GeneralAgentContext(context, schedule.find(item => item.run.id === before.episode)!.run.spec, before.episode);
  const originalInput = JSON.parse(inputContext.modelInput());
  const aliases = new Map<string, string>(originalInput.evidence.map((event: WorldEvent) => {
    const actual = readDocument<WorldEvent>("SELECT document FROM events WHERE run_id=? AND seq=?", event.runId, String(event.seq));
    assert.ok(visible(actual, { actorId: before.actorId })); return [event.id, actual.id];
  }));
  const outcomes = new Set<string>(originalInput.evidence.filter((event: WorldEvent) => event.data.settlement === true).map((event: WorldEvent) => aliases.get(event.id)!));
  const consolidations: unknown[] = [];
  for (const record of records) {
    assert.equal(record.sourceHash, sourceHash); assert.equal(record.requestFormat, "native-responses"); assert.equal(record.error, undefined);
    assert.equal(record.configuration.modelId, "gpt-6-luna"); assert.equal(record.configuration.contextWindow, 256000);
    assert.equal(record.configuration.modelInjected, false); assert.equal(record.configuration.retryLimit, 0);
    const request = record.providerRequest as HttpRequest; assert.ok(request);
    assert.equal(request.model, "gpt-6-luna"); assert.equal(request.stream, true); assert.equal(request.parallel_tool_calls, false);
    assert.equal(request.store, false); assert.equal(request.truncation, "disabled"); assert.equal(request.tool_choice, "required");
    assert.ok(request.tools.every(tool => tool.type === "function" && tool.strict));
    assert.ok(request.tools.every(tool => !["speak", "wait", "send_message", "forecast", "invest", "contribute", "finish_record"].includes(tool.name)));
    const content = request.input.find(item => item.role === "user")?.content; assert.ok(content);
    const input = JSON.parse(typeof content === "string" ? content : content.filter(part => part.type === "input_text").map(part => part.text).join(""));
    assert.deepEqual(input, originalInput);
    const pending = new Set<string>();
    for (const item of request.input) {
      if (item.type === "function_call") { assert.ok(item.call_id && !pending.has(item.call_id)); pending.add(item.call_id); }
      if (item.type === "function_call_output") { assert.ok(item.call_id && pending.delete(item.call_id)); }
    }
    assert.equal(pending.size, 0);
    const offered = request.tools.find(tool => tool.name === "consolidate_strategy");
    if (offered) { assert.ok(offered.parameters.required?.includes("strategyId")); assert.equal(offered.parameters.properties?.sourceIds, undefined); }
    for (const call of record.sdkOutput as Array<{ type: string; name?: string; arguments?: string; callId?: string }>) {
      if (call.type !== "function_call" || call.name !== "consolidate_strategy") continue;
      const args = JSON.parse(call.arguments!) as { strategyId: string | null; memoryIds: string[] };
      const output = records.flatMap(item => (item.providerRequest as HttpRequest).input).find(item => item.type === "function_call_output" && item.call_id === call.callId);
      assert.ok(output?.output); const receipt = JSON.parse(output.output);
      const memory = after.memories[Number(receipt.id.slice(1)) - 1]; assert.ok(memory);
      const version = versions(memory).find(version => (version.revision ?? 1) === (receipt.revision ?? 1)); assert.ok(version?.consolidation);
      const selected = args.memoryIds.map(ref => before.memories[Number(ref.slice(1)) - 1]);
      assert.ok(selected.every(memory => memory?.kind === "episodic"));
      const sourceIds = [...new Set(selected.flatMap(memory => memory.sourceIds.filter(id => outcomes.has(id))))];
      assert.deepEqual(version.sourceIds, sourceIds); assert.deepEqual(version.consolidation.sourceOutcomeIds, sourceIds);
      assert.deepEqual(version.consolidation.sourceMemories, selected.map(memory => ({ id: memory.id, revision: memory.revision ?? 1 })));
      assert.deepEqual(receipt.sourceIds.map((ref: string) => aliases.get(ref)), sourceIds);
      if (args.strategyId !== null) assert.equal(memory.id, before.memories[Number(args.strategyId.slice(1)) - 1].id);
      consolidations.push({ caseId: record.id, memoryId: memory.id, revision: version.revision ?? 1, operation: args.strategyId === null ? "create" : "revise", sourceIds });
    }
  }
  for (const original of before.memories) {
    const current = after.memories.find(memory => memory.id === original.id); assert.ok(current);
    if (original.kind === "episodic") assert.deepEqual(current, original);
    else if (JSON.stringify(current) !== JSON.stringify(original)) {
      const { revisions: _history, ...previous } = original;
      assert.deepEqual(current.revisions?.find(revision => (revision.previous.revision ?? 1) === (original.revision ?? 1))?.previous, previous);
      assert.equal(memoryOriginEpisode(current), memoryOriginEpisode(original));
    }
  }
  assert.deepEqual(after.predictions, before.predictions); assert.deepEqual(after.decisions, before.decisions); assert.deepEqual(after.learning, before.learning);
  const reviews = after.episodeReviews!.filter(review => review.episode === before.episode); assert.equal(reviews.length, 1);
  const review = reviews[0], feedback = review.predictionFeedback; assert.ok(feedback);
  const predictions = before.predictions.filter(prediction => prediction.episode === before.episode);
  const scored = predictions.filter(prediction => typeof prediction.result === "boolean" && prediction.sourceId && Number.isFinite(prediction.brier));
  assert.equal(feedback.forecastCount, predictions.length); assert.equal(feedback.scoredForecastCount, scored.length);
  assert.equal(feedback.uniqueScoredEventCount, new Set(scored.map(prediction => prediction.sourceId)).size);
  assert.equal(feedback.unscoredForecastCount, predictions.length - scored.length);
  assert.ok(feedback.unscored.every(prediction => prediction.status === "unverified"));
  const reused = review.strategies.filter(ref => before.memories.some(memory => memory.id === ref.id && (memory.revision ?? 1) === ref.revision));
  const revised = after.memories.filter(memory => before.memories.some(original => original.id === memory.id && (original.revision ?? 1) < (memory.revision ?? 1)));
  const created = after.memories.filter(memory => !before.memories.some(original => original.id === memory.id));
  return { consolidations, reusedStrategyIds: reused.map(ref => ref.id), revisedMemoryIds: revised.map(memory => memory.id), newMemoryIds: created.map(memory => memory.id), review,
    beforeStrategies: activeMemories(before).filter(memory => memory.kind === "procedural"), afterStrategies: activeMemories(after).filter(memory => memory.kind === "procedural") };
}

if (mode === "--prepare-only") { db.close(); console.log(JSON.stringify({ prepared: true, modelCalls: 0, sourceHash, directory, inventory })); }
else {
  assert.equal(existsSync(path.join(directory, "results.json")), false, "An attempted experiment is immutable; use a new directory for another experiment");
  const results: Array<Record<string, unknown>> = []; const signal = AbortSignal.timeout(10 * 60_000);
  write("results.json", { status: "running", sourceHash, results, startedAt: new Date().toISOString() });
  const progress = setInterval(() => console.log(JSON.stringify({ completed: results.length, total: schedule.length, sourceHash })), 20_000);
  try {
    for (const [index, item] of schedule.entries()) {
      const { run, record } = item; const saved = structuredClone(record.context); const cognition = saved.cognition as AgentMind;
      const before = structuredClone(cognition); const records: DecisionCase[] = [], activations: StagedActivation[] = [], toolErrors: unknown[] = [];
      const context: TurnContext = { character: saved.character as TurnContext["character"], observation: saved.observation as string,
        worldObservation: saved.worldObservation as TurnContext["worldObservation"], cognition, psychology: saved.previousState as TurnContext["psychology"],
        recent: saved.recent as WorldEvent[], inbox: saved.inbox as WorldEvent[], memories: saved.memories as TurnContext["memories"],
        opportunity: { id: randomUUID(), actorId: record.actorId, stage: saved.stage as TurnContext["opportunity"]["stage"], channel: "private", recipients: [record.actorId], actions: [], communications: [] },
        signal, appraisalOnly: true, episodeReview: true,
        lookupEvidence: id => { const event = sourceEvent(id); return event && visible(event, { actorId: record.actorId }) ? event : undefined; },
        call: async () => { throw new Error("Historical review cannot execute world actions"); },
        recordDecisionCase: value => { records.push({ ...value, originCaseId: record.id }); write(`case-${index + 1}.json`, { originCaseId: record.id, records }); },
        recordToolError: (toolName, message) => toolErrors.push({ toolName, message }),
        recordHarnessEvent: value => { if (value.kind !== "model_delta") appendFileSync(path.join(directory, `activity-${index + 1}.jsonl`), `${JSON.stringify(value)}\n`); },
        commitActivation: value => { assert.equal(activations.length, 0); assert.deepEqual(value.calls, []); assert.equal(value.text, undefined); assert.equal(value.waited, true); activations.push(structuredClone(value)); } };
      console.log(JSON.stringify({ starting: index + 1, actorId: record.actorId, condition: item.condition, originCaseId: record.id }));
      let details: ReturnType<typeof audit> | undefined, error: string | undefined;
      try {
        signal.throwIfAborted();
        await modelParticipantFactory(registry)(context.character, run.spec, run.id).turn(context);
        assert.equal(activations.length, 1); assert.equal(toolErrors.length, 0); assert.deepEqual(context.cognition, before);
        details = audit(records, before, activations[0].cognition!, context);
      } catch (cause) { error = nativeError(cause); }
      write(`review-${index + 1}.json`, { originCaseId: record.id, before, activations, toolErrors, error, details });
      results.push({ ...inventory[index], opportunityId: context.opportunity.id, completed: Boolean(details) && !error, calls: records.length,
        failedCalls: records.filter(record => record.error).length, toolErrors: toolErrors.length, error, details });
      write("results.json", { status: "running", sourceHash, results });
      console.log(JSON.stringify({ finished: index + 1, calls: records.length, completed: Boolean(details) && !error, error,
        reused: details?.reusedStrategyIds.length, revised: details?.revisedMemoryIds.length, created: details?.newMemoryIds.length }));
    }
  } finally {
    clearInterval(progress); db.close();
    const sourceChanged = agentSourceHash() !== sourceHash, originChanged = fileHash(originFile) !== originHash;
    const mechanismPassed = !sourceChanged && !originChanged && results.length === schedule.length && results.every(result => result.completed);
    write("results.json", { mechanismPassed, contentQualityPassed: null, sourceHash, sourceChanged, originChanged, results, finishedAt: new Date().toISOString(),
      interpretation: "This isolated mechanism test does not establish subsequent action adoption or general learning. Original completed episodes are unchanged." });
    console.log(JSON.stringify({ mechanismPassed, sourceChanged, originChanged, directory }));
    if (!mechanismPassed) process.exitCode = 1;
  }
}
