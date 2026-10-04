import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { activeMemories, type AgentMind, type CognitiveMemory } from "../src/agents/cognition";
import { agentSourceHash, snapshotAgentSource } from "../src/agents/provenance";
import { nativeConfiguration, nativeError } from "../src/agents/sdk";
import { modelParticipantFactory } from "../src/runtime/participant";
import { RunService, type SocietyRun } from "../src/runtime/run";
import { SocietyStore } from "../src/runtime/store";
import { runSpecSchema, type ActorObservation, type RunSpec, type WorldEvent } from "../src/runtime/types";
import type { DecisionCase } from "../src/runtime/cases";
import { runtimeCharacter } from "../src/server/routes/runs";
import { loadRegistry } from "../src/society/models";
import { builtinCharacter } from "../src/society/profiles";

interface Condition { id: string; scenario: RunSpec["scenario"]; seed: number; rounds: number; roster: string[]; source?: string; }
interface HttpRequest {
  model: string; stream: boolean; parallel_tool_calls: boolean; store: boolean; truncation: string; tool_choice: string;
  tools: Array<{ type: string; strict: boolean }>;
  input: Array<{ role?: string; type?: string; call_id?: string; content?: string | Array<{ type: string; text: string }> }>;
}
interface InputView { actor: { id: string }; observation: ActorObservation; evidence: WorldEvent[]; cognition: AgentMind; }
const directory = path.resolve(process.env.STRATEGY_VALIDATION_DIR ?? `data/strategy-learning-validation-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
const sourceHash = snapshotAgentSource(path.join(directory, "source"));
cpSync("scripts/validate-strategy-learning.ts", path.join(directory, "source/validate-strategy-learning.ts"));
const registry = loadRegistry("data/model-settings.json"); const configuration = nativeConfiguration(registry);
const schedule: Condition[] = [
  { id: "source-23", scenario: "signaling-game", seed: 23, rounds: 4, roster: ["builtin-01", "builtin-03"] },
  { id: "transfer-trust", scenario: "trust-game", seed: 23, rounds: 3, roster: ["builtin-01", "builtin-03"], source: "source-23" },
  { id: "source-41", scenario: "signaling-game", seed: 41, rounds: 4, roster: ["builtin-03", "builtin-01"] },
  { id: "transfer-public-goods", scenario: "public-goods", seed: 41, rounds: 3, roster: ["builtin-03", "builtin-01", "builtin-02"], source: "source-41" },
  { id: "independent-werewolf", scenario: "werewolf", seed: 23, rounds: 2, roster: ["builtin-01", "builtin-02", "builtin-03", "builtin-04", "builtin-05", "builtin-06"] },
];
write("manifest.json", { sourceHash, configuration, schedule, createdAt: new Date().toISOString(),
  design: "Two fresh autonomous four-round conflicting signaling sources, each followed by its preselected held-out environment. An independent fresh werewolf episode uses the same core. No source selection by behavior, scripted opponents, seeded rules, retries or historical-result changes.",
  thresholds: { completedRuns: 5, failedCalls: 0, toolErrors: 0, privateIntentLeaks: 0, unchangedSource: true,
    sourceActorsWithConsolidation: 4, targetActorsWithRetrievedSourceStrategies: 4, targetEnvironmentsWithAssessmentAndAdoptedFeedback: 2 },
  interpretation: "Retrieval, applicability assessment, adoption, observed outcome and revision are separate measurements. This exploratory batch does not establish a causal payoff gain or reliable deception." });
console.log(JSON.stringify({ artifact: directory, sourceHash, schedule, model: configuration.modelId, api: configuration.apiMode }));
if (process.env.STRATEGY_PREFLIGHT === "1") process.exit(0);
const store = new SocietyStore(path.join(directory, "results.sqlite"));
const service = new RunService(store, modelParticipantFactory(registry));
const sourceRuns = new Map<string, SocietyRun>();
const results: Array<Record<string, unknown>> = [];
let timedOut = false;
const progress = setInterval(() => {
  const run = [...service.live.values()][0];
  if (run) console.log(JSON.stringify({ runId: run.id, scenario: run.record.spec.scenario, status: run.status, phase: run.world.stage()?.label, calls: store.cases(run.id).length }));
}, 20_000);
const timeout = setTimeout(() => { timedOut = true; service.stopAll(); }, 35 * 60_000);
function view(record: DecisionCase): InputView {
  const request = record.providerRequest as HttpRequest;
  const content = request.input.find(item => item.role === "user")?.content; assert.ok(content);
  return JSON.parse(typeof content === "string" ? content : content.filter(part => part.type === "input_text").map(part => part.text).join("")) as InputView;
}
function analyze(run: SocietyRun, condition: Condition, sourceRun?: SocietyRun) {
  const cases = store.cases(run.id); const events = store.events(run.id);
  const minds = condition.roster.flatMap(actorId => store.cognition(run.id, actorId) ?? []);
  const committed = (opportunityId: string) => Boolean(store.db.prepare("SELECT 1 FROM agent_activations WHERE id=?").get(opportunityId));
  const protocol = { actualRequests: 0, pairedToolResults: 0, evidenceChecked: 0, failedUncommitted: 0, requestsWithSourceStrategies: 0 };
  const retrievedActors = new Set<string>(); const transferSamples: unknown[] = [];
  for (const record of cases) {
    assert.equal(record.sourceHash, sourceHash); assert.equal(record.requestFormat, "native-responses");
    assert.equal(record.configuration.modelId, "gpt-6-luna"); assert.equal(record.configuration.contextWindow, 256000);
    assert.equal(record.configuration.apiMode, "responses"); assert.equal(record.configuration.modelInjected, false); assert.equal(record.configuration.retryLimit, 0);
    if (record.error) { assert.equal(committed(record.opportunityId), false); protocol.failedUncommitted++; }
    if (!record.providerRequest) { assert.ok(record.error); continue; }
    const request = record.providerRequest as HttpRequest;
    assert.equal(request.model, "gpt-6-luna"); assert.equal(request.stream, true); assert.equal(request.parallel_tool_calls, false);
    assert.equal(request.store, false); assert.equal(request.truncation, "disabled"); assert.equal(request.tool_choice, "required");
    assert.ok(request.tools.every(tool => tool.type === "function" && tool.strict)); protocol.actualRequests++;
    const ids = new Set<string>(), returned = new Set<string>();
    for (const item of request.input) {
      if (item.type === "function_call") { assert.ok(item.call_id && !ids.has(item.call_id)); ids.add(item.call_id); }
      if (item.type === "function_call_output") { assert.ok(item.call_id && ids.has(item.call_id) && !returned.has(item.call_id)); returned.add(item.call_id); protocol.pairedToolResults++; }
    }
    const input = view(record); assert.equal(input.actor.id, record.actorId);
    assert.equal(input.observation.facts.scenario, condition.scenario);
    for (const event of input.evidence) {
      assert.ok(event.visibility === "public" || Array.isArray(event.visibility) && event.visibility.includes(record.actorId));
      assert.ok(!event.data.identityScope || event.data.identityScope === run.id); protocol.evidenceChecked++;
    }
    assert.ok(Object.values(input.cognition.episodeBeliefs ?? {}).every(belief => belief.episode === run.id));
    assert.ok((input.cognition.strategyAssessments ?? []).every(item => item.episode === run.id));
    const transferred = sourceRun ? input.cognition.memories.filter(memory => memory.consolidation?.episode === sourceRun.id && memory.scope === "transferable") : [];
    if (transferred.length) {
      protocol.requestsWithSourceStrategies++;
      if (!retrievedActors.has(record.actorId)) transferSamples.push({ actorId: record.actorId, caseId: record.id, memories: transferred });
      retrievedActors.add(record.actorId);
    }
  }
  const learning = minds.map(mind => {
    const consolidated = mind.memories.filter(memory => memory.consolidation?.episode === run.id);
    for (const memory of consolidated) {
      const initial = memory.revisions?.[0]?.previous ?? memory;
      assert.ok(initial.when && initial.then && initial.consolidation?.rationale);
      for (const ref of initial.consolidation!.sourceMemories) {
        const source = mind.memories.find(item => item.id === ref.id); assert.ok(source && source.kind === "episodic");
        assert.ok(source.sourceIds.some(id => initial.sourceIds.includes(id)));
      }
      for (const id of initial.sourceIds) {
        const event = store.event(id); assert.ok(event?.data.settlement);
        assert.ok(event.visibility === "public" || Array.isArray(event.visibility) && event.visibility.includes(mind.actorId));
      }
    }
    const assessments = (mind.strategyAssessments ?? []).filter(item => item.episode === run.id);
    for (const assessment of assessments) {
      for (const id of assessment.sourceIds) {
        const event = store.event(id); assert.ok(event && event.runId === run.id);
        assert.ok(event.visibility === "public" || Array.isArray(event.visibility) && event.visibility.includes(mind.actorId));
      }
      if (assessment.verdict === "reject") assert.equal(assessment.decisionIds.length, 0);
      for (const id of assessment.decisionIds) assert.ok(mind.decisions.some(decision => decision.id === id && decision.episode === run.id && decision.assessmentIds?.includes(assessment.id)));
      for (const feedback of assessment.feedback) {
        const event = store.event(feedback.sourceId); assert.ok(event?.data.settlement && event.runId === run.id);
        const points = (event.data.payoffs as Record<string, number> | undefined)?.[mind.actorId];
        if (points !== undefined) assert.equal(feedback.value, points);
        else assert.equal(feedback.value, (event.data.winners as string[] | undefined)?.includes(mind.actorId) ? 1 : 0);
        assert.ok(feedback.decisionIds.every(id => assessment.decisionIds.includes(id)));
      }
      for (const scored of assessment.predictions) {
        const prediction = mind.predictions.find(item => item.id === scored.id);
        assert.ok(prediction && prediction.episode === run.id && prediction.sourceId === scored.sourceId);
        assert.equal(scored.result, prediction.result); assert.equal(scored.brier, prediction.brier);
      }
    }
    const transferred = assessments.filter(assessment => sourceRun && mind.memories.find(memory => memory.id === assessment.memoryId)?.consolidation?.episode === sourceRun.id);
    return { actorId: mind.actorId, consolidated: consolidated.map(memory => ({ id: memory.id, text: memory.text, when: memory.when, then: memory.then, consolidation: memory.consolidation })),
      transferableStrategies: activeMemories(mind).filter(memory => memory.kind === "procedural" && memory.scope === "transferable").length,
      assessments, sourceAssessments: transferred.length, sourceAdoptions: transferred.filter(item => item.decisionIds.length > 0).length,
      sourceAdoptionsWithFeedback: transferred.filter(item => item.feedback.length > 0).length,
      revisedMemories: mind.memories.filter(memory => memory.revisions?.some(revision => revision.episode === run.id)).length,
      predictionsScored: mind.predictions.filter(prediction => prediction.episode === run.id && prediction.result !== undefined).length };
  });
  const publicView = JSON.stringify(run.view({}));
  const privateIntentLeaks = minds.flatMap(mind => mind.decisions.filter(decision => decision.episode === run.id && decision.privateAim.length > 15 && publicView.includes(decision.privateAim))).length;
  const callsByTool: Record<string, number> = {};
  for (const record of cases.filter(record => !record.error && committed(record.opportunityId))) for (const item of record.sdkOutput as Array<{ type: string; name?: string }> ?? []) {
    if (item.type === "function_call" && item.name) callsByTool[item.name] = (callsByTool[item.name] ?? 0) + 1;
  }
  const world = run.world.publicState();
  const reportEvidence = condition.scenario === "signaling-game" ? (world.history as Array<{ round: number; senderId: string; highQuality: boolean; reportedHighQuality: boolean; accepted: boolean }>).map(round => {
    const record = cases.findLast(record => record.actorId === round.senderId && committed(record.opportunityId) && record.providerRequest &&
      view(record).observation.round === round.round && (record.sdkOutput as Array<{ type: string; name?: string }> | undefined)?.some(item => item.type === "function_call" && item.name === "declare_quality"));
    assert.ok(record);
    const quality = (view(record).observation.facts.privateInformation as { highQuality: boolean }).highQuality;
    assert.equal(quality, round.highQuality);
    const output = (record.sdkOutput as Array<{ type: string; name?: string; arguments: string }>).find(item => item.type === "function_call" && item.name === "declare_quality")!;
    const args = JSON.parse(output.arguments) as { highQuality: boolean; intent: string; privateAim: string };
    assert.equal(args.highQuality, round.reportedHighQuality);
    return { round: round.round, caseId: record.id, opportunityId: record.opportunityId, highQuality: quality, report: args.highQuality,
      falseKnownReport: quality !== args.highQuality, declaredIntent: args.intent, accepted: round.accepted, privateAim: args.privateAim };
  }) : [];
  return { ...condition, sourceRunId: sourceRun?.id, runId: run.id, status: run.status, calls: cases.length,
    failedCalls: cases.filter(record => record.error).length, toolErrors: events.filter(event => event.data.toolError).length,
    activations: (store.db.prepare("SELECT count(*) AS n FROM agent_activations WHERE run_id=?").get(run.id) as { n: number }).n,
    protocol, learning, retrievedActors: [...retrievedActors], transferSamples, callsByTool, privateIntentLeaks, reportEvidence,
    errors: cases.filter(record => record.error).map(record => ({ caseId: record.id, opportunityId: record.opportunityId, error: record.error, response: record.response })), world };
}
try {
  for (const condition of schedule) {
    if (timedOut) break;
    const sourceRun = condition.source ? sourceRuns.get(condition.source) : undefined;
    const initialSnapshots: Record<string, string> = {};
    if (condition.source) {
      const origin = schedule.find(item => item.id === condition.source)!;
      const inventory = origin.roster.map(actorId => {
        const snapshot = sourceRun?.status === "completed" ? store.snapshots(actorId).find(snapshot => snapshot.runId === sourceRun.id) : undefined;
        const memories: CognitiveMemory[] = snapshot?.cognition ? activeMemories(snapshot.cognition).filter(memory => memory.kind === "procedural" && memory.scope === "transferable" && memory.consolidation?.episode === sourceRun!.id) : [];
        if (snapshot) initialSnapshots[actorId] = snapshot.id;
        return { actorId, snapshotId: snapshot?.id, sourceStrategies: memories.length };
      });
      if (inventory.some(actor => !actor.snapshotId || !actor.sourceStrategies)) {
        results.push({ ...condition, status: "not_started", calls: 0, sourceRunId: sourceRun?.id, inventory, reason: "Preselected source did not provide completed snapshots with consolidated strategies for every original actor" });
        write("results.json", { status: "running", sourceHash, results }); continue;
      }
    }
    const characters = condition.roster.map(id => runtimeCharacter(builtinCharacter(id)!));
    const spec = runSpecSchema.parse({ scenario: condition.scenario, rounds: condition.rounds, seed: condition.seed, mode: "experiment", worldId: condition.id, initialSnapshots,
      signalingIncentives: "conflicting", trustProtocol: "pledge-repair", roster: condition.roster.map(characterId => ({ characterId, modelProfileId: "gpt-6-luna" })),
      budgets: { maxTurns: 8, discussionTurns: characters.length }, cognition: { requestTimeoutMs: 60000 },
      experiment: { psychology: "hybrid", relationshipMemory: true, speaking: "round-robin" } });
    const { run } = service.create(spec, characters); if (!condition.source) sourceRuns.set(condition.id, run);
    console.log(JSON.stringify({ starting: condition.id, runId: run.id, sourceRunId: sourceRun?.id }));
    await run.settled();
    const result = analyze(run, condition, sourceRun); results.push(result); write("results.json", { status: "running", sourceHash, results });
    console.log(JSON.stringify({ finished: condition.id, runId: run.id, status: result.status, calls: result.calls, failedCalls: result.failedCalls, toolErrors: result.toolErrors,
      consolidated: result.learning.reduce((sum, actor) => sum + actor.consolidated.length, 0), sourceAssessments: result.learning.reduce((sum, actor) => sum + actor.sourceAssessments, 0),
      sourceAdoptionsWithFeedback: result.learning.reduce((sum, actor) => sum + actor.sourceAdoptionsWithFeedback, 0) }));
  }
  const sourceChanged = agentSourceHash() !== sourceHash;
  const completed = results.filter(result => result.status === "completed").length;
  const analyzed = results.filter(result => Array.isArray(result.learning)) as Array<ReturnType<typeof analyze>>;
  const coverage = { sourceActorsWithConsolidation: analyzed.filter(result => result.id.startsWith("source-")).flatMap(result => result.learning).filter(actor => actor.consolidated.length > 0).length,
    targetActorsWithRetrievedSourceStrategies: analyzed.filter(result => result.source).reduce((sum, result) => sum + result.retrievedActors.length, 0),
    targetEnvironmentsWithAssessmentAndAdoptedFeedback: analyzed.filter(result => result.source && result.learning.some(actor => actor.sourceAdoptionsWithFeedback > 0)).length };
  const protocolPassed = !sourceChanged && !timedOut && completed === schedule.length && analyzed.every(result => result.failedCalls === 0 && result.toolErrors === 0 && result.privateIntentLeaks === 0);
  const learningPassed = coverage.sourceActorsWithConsolidation === 4 && coverage.targetActorsWithRetrievedSourceStrategies === 4 && coverage.targetEnvironmentsWithAssessmentAndAdoptedFeedback === 2;
  const passed = protocolPassed && learningPassed;
  write("results.json", { passed, protocolPassed, learningPassed, sourceHash, sourceChanged, timedOut, coverage, results, finishedAt: new Date().toISOString() });
  console.log(JSON.stringify({ passed, protocolPassed, learningPassed, completed, calls: analyzed.reduce((sum, result) => sum + result.calls, 0), coverage, sourceChanged, artifact: directory }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  write("results.json", { passed: false, sourceHash, sourceChanged: agentSourceHash() !== sourceHash, error: nativeError(error), results, finishedAt: new Date().toISOString() });
  console.log(JSON.stringify({ error: nativeError(error), artifact: directory })); process.exitCode = 1;
} finally {
  clearInterval(progress); clearTimeout(timeout); service.stopAll();
  await Promise.allSettled([...service.live.values()].map(run => run.settled())); store.close();
}
