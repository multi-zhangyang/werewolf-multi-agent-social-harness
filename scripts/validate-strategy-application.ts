import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { activeMemories, isWorldDecision, memoryOriginEpisode, type AgentMind, type CognitiveMemory } from "../src/agents/cognition";
import { agentSourceHash, snapshotAgentSource } from "../src/agents/provenance";
import { nativeConfiguration, nativeError } from "../src/agents/sdk";
import { modelParticipantFactory } from "../src/runtime/participant";
import { RunService, type SocietyRun } from "../src/runtime/run";
import { SocietyStore } from "../src/runtime/store";
import { runSpecSchema, type ActorObservation, type RunSpec, type WorldEvent } from "../src/runtime/types";
import type { DecisionCase } from "../src/runtime/cases";
import type { buildExperienceEvidence } from "../src/agents/experience-evidence";
import { runtimeCharacter } from "../src/server/routes/runs";
import { loadRegistry } from "../src/society/models";
import { builtinCharacter } from "../src/society/profiles";
import { importGeneralResults } from "./import-general-results";

interface Condition { id: string; scenario: RunSpec["scenario"]; seed: number; rounds: number; roster: string[]; source?: string; }
interface HttpRequest {
  instructions: string;
  model: string; stream: boolean; parallel_tool_calls: boolean; store: boolean; truncation: string; tool_choice: string;
  tools: Array<{ type: string; name: string; strict: boolean; parameters: { properties?: Record<string, unknown>; required?: string[] } }>;
  input: Array<{ role?: string; type?: string; call_id?: string; content?: string | Array<{ type: string; text: string }> }>;
}
interface InputView { actor: { id: string }; observation: ActorObservation; evidence: WorldEvent[]; cognition: AgentMind; episodeReview?: unknown;
  strategyLearning?: { assessmentRequired: boolean; assessmentCandidateIds: string[]; experienceEvidence: ReturnType<typeof buildExperienceEvidence> }; }
interface SourceRun { id: string; status: string; }
const memoryVersions = (memory: CognitiveMemory) => [...(memory.revisions ?? []).map(revision => revision.previous), memory];
const consolidatedIn = (memory: CognitiveMemory, episode: string) => memoryVersions(memory).some(version => version.consolidation?.episode === episode);
const originDirectory = process.argv[2];
if (!originDirectory) throw new Error("Usage: validate-strategy-application.ts <completed-v5-review-validation-directory>");
const origin = path.resolve(originDirectory);
const originResults = JSON.parse(readFileSync(path.join(origin, "results.json"), "utf8")) as { sourceHash: string; sourceChanged: boolean; finishedAt?: string;
  results: Array<{ id: string; runId?: string; status: string; roster: string[] }> };
assert.ok(originResults.finishedAt, "Wait for the complete source batch to finish"); assert.equal(originResults.sourceChanged, false);
assert.equal(agentSourceHash(path.join(origin, "source")), originResults.sourceHash);
const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const originHash = fileHash(path.join(origin, "results.sqlite"));
const directory = path.resolve(process.env.STRATEGY_APPLICATION_DIR ?? `data/strategy-application-validation-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
const sourceHash = snapshotAgentSource(path.join(directory, "source"));
cpSync("scripts/validate-strategy-application.ts", path.join(directory, "source/validate-strategy-application.ts"));
cpSync("scripts/import-general-results.ts", path.join(directory, "source/import-general-results.ts"));
const registry = loadRegistry(process.env.MODEL_SETTINGS_FILE ?? "data/model-settings.json");
const configuration = nativeConfiguration(registry, { modelProfileId: "gpt-6-luna", maxTurns: 8, requestTimeoutMs: 60000 });
const schedule: Condition[] = [
  { id: "application-trust", scenario: "trust-game", seed: 23, rounds: 3, roster: ["builtin-01", "builtin-03"], source: "source-23" },
  { id: "application-public-goods", scenario: "public-goods", seed: 41, rounds: 3, roster: ["builtin-03", "builtin-01", "builtin-02"], source: "source-41" },
];
write("manifest.json", { sourceHash, configuration, schedule, totalTimeoutMs: 20 * 60_000, requestDeadlineMs: 60000, timingToleranceMs: 1000, createdAt: new Date().toISOString(),
  importedSource: { directory: origin, sourceHash: originResults.sourceHash, databaseSha256: originHash, conditions: ["source-23", "source-41"] },
  design: "New frozen v13 target episodes from the exact preselected v5 source snapshots. finish_episode_review selects strategyIds once; the application derives ready versus insufficient from that selection, eliminating an independent contradictory status argument. Official Agent.instructions(context) describes current prerequisites before every request, including re-assessment after revision and completion tools. Native tool arguments, original observations and SDK results remain intact. Full-response deadlines include headers and body. Consolidation preserves stable IDs and historical versions with sources derived from selected experiences and visible settlements. SDK isEnabled keeps the original eight-turn completion budget. Forecast feedback separates scored predictions, unique events and unverified items. Grounded experience and explicit applicability verdicts remain required. Rejection is legitimate. Sources, 4096 output tokens, 60000 ms requests and learning thresholds are unchanged; all previous episodes and failures remain separate.",
  thresholds: { completedRuns: 2, failedCalls: 0, toolErrors: 0, privateIntentLeaks: 0, unchangedSource: true, unchangedOrigin: true,
    targetActorsWithRetrievedSourceStrategies: 4, targetActorsWithExplicitComparisons: 4, targetEnvironmentsWithAssessmentAndAdoptedFeedback: 2, finalPrivateReviews: 5 },
  interpretation: "Retrieval, applicability assessment, adoption, observed outcome and revision are separate measurements. This exploratory batch does not establish a causal payoff gain or reliable deception." });
console.log(JSON.stringify({ artifact: directory, sourceHash, schedule, model: configuration.modelId, api: configuration.apiMode }));
const store = new SocietyStore(path.join(directory, "results.sqlite"));
const imported = importGeneralResults(path.join(origin, "results.sqlite"), path.join(directory, "results.sqlite"));
write("source-import.json", imported); assert.equal(fileHash(path.join(origin, "results.sqlite")), originHash);
const service = new RunService(store, modelParticipantFactory(registry));
const sourceRuns = new Map(originResults.results.flatMap(result => result.runId ? [[result.id, { id: result.runId, status: result.status }] as const] : []));
const results: Array<Record<string, unknown>> = [];
let timedOut = false;
const progress = setInterval(() => {
  const run = [...service.live.values()][0];
  if (run) console.log(JSON.stringify({ runId: run.id, scenario: run.record.spec.scenario, status: run.status, phase: run.world.stage()?.label, calls: store.cases(run.id).length }));
}, 20_000);
const timeout = setTimeout(() => { timedOut = true; service.stopAll(); }, 20 * 60_000);
function view(record: DecisionCase): InputView {
  const request = record.providerRequest as HttpRequest;
  const content = request.input.find(item => item.role === "user")?.content; assert.ok(content);
  return JSON.parse(typeof content === "string" ? content : content.filter(part => part.type === "input_text").map(part => part.text).join("")) as InputView;
}
function analyze(run: SocietyRun, condition: Condition, sourceRun?: SourceRun) {
  const cases = store.cases(run.id); const events = store.events(run.id);
  const sourceEvents = new Map(events.map(event => [`${event.runId}:${event.seq}`, event]));
  const sourceEvent = (runId: string, seq: number) => {
    const key = `${runId}:${seq}`, cached = sourceEvents.get(key); if (cached) return cached;
    const row = store.db.prepare("SELECT document FROM events WHERE run_id=? AND seq=?").get(runId, seq) as { document: string } | undefined;
    assert.ok(row, "Visible experience must have an original ledger row");
    const event = JSON.parse(row.document) as WorldEvent; sourceEvents.set(key, event); return event;
  };
  const minds = condition.roster.flatMap(actorId => store.cognition(run.id, actorId) ?? []);
  const committed = (opportunityId: string) => Boolean(store.db.prepare("SELECT 1 FROM agent_activations WHERE id=?").get(opportunityId));
  const protocol = { actualRequests: 0, pairedToolResults: 0, evidenceChecked: 0, failedUncommitted: 0, requestsWithSourceStrategies: 0 };
  const grounding = { requestsChecked: 0, outcomesChecked: 0, observedMemories: 0, observedActions: 0, consolidationSets: 0 };
  const requiredOpportunities = new Map<string, { actorId: string; candidates: string[] }>();
  const retrievedActors = new Set<string>(); const transferSamples: unknown[] = [];
  const steps = new Map<string, number>();
  for (const record of cases) {
    assert.equal(record.sourceHash, sourceHash); assert.equal(record.requestFormat, "native-responses");
    assert.equal(record.configuration.modelId, "gpt-6-luna"); assert.equal(record.configuration.contextWindow, 256000);
    assert.equal(record.configuration.apiMode, "responses"); assert.equal(record.configuration.modelInjected, false); assert.equal(record.configuration.retryLimit, 0);
    assert.equal(record.configuration.requestTimeoutMs, 60000); assert.equal(record.configuration.maxTurns, 8);
    assert.equal(record.configuration.requestTimeoutScope, "headers-and-body");
    assert.equal(record.configuration.instructionPolicy, "sdk-dynamic-progress");
    if (!record.error) assert.ok(record.durationMs <= 61000, "A successful response cannot silently exceed the full-response deadline beyond scheduling tolerance");
    if (record.error) { assert.equal(committed(record.opportunityId), false); protocol.failedUncommitted++; }
    if (!record.providerRequest) { assert.ok(record.error); continue; }
    const request = record.providerRequest as HttpRequest;
    const reviewTool = request.tools.find(tool => tool.name === "finish_episode_review");
    if (reviewTool) {
      assert.equal(reviewTool.parameters.properties?.status, undefined);
      assert.equal(reviewTool.parameters.required?.includes("status"), false);
    }
    for (const call of record.sdkOutput as Array<{ type: string; name?: string; arguments?: string }> ?? [])
      if (call.type === "function_call" && call.name === "finish_episode_review") assert.equal(Object.hasOwn(JSON.parse(call.arguments!), "status"), false);
    const progress = JSON.parse(request.instructions.split("当前执行状态：").at(-1)!) as {
      modelTurn: number; remainingModelTurns: number; requiredTool: string | null; completionTools: string[]; completionAvailable: boolean;
    };
    const step = (steps.get(record.opportunityId) ?? 0) + 1; steps.set(record.opportunityId, step);
    assert.equal(progress.modelTurn, step); assert.equal(progress.remainingModelTurns, 9 - step);
    const offered = request.tools as Array<{ type: string; strict: boolean; name: string }>;
    assert.equal(progress.completionAvailable, progress.requiredTool === null);
    if (progress.requiredTool) {
      assert.ok(offered.some(tool => tool.name === progress.requiredTool));
      assert.ok(progress.completionTools.every(name => !offered.some(tool => tool.name === name)));
    } else assert.ok(progress.completionTools.some(name => offered.some(tool => tool.name === name)));
    assert.equal(request.model, "gpt-6-luna"); assert.equal(request.stream, true); assert.equal(request.parallel_tool_calls, false);
    assert.equal(request.store, false); assert.equal(request.truncation, "disabled"); assert.equal(request.tool_choice, "required");
    assert.ok(request.tools.every(tool => tool.type === "function" && tool.strict)); protocol.actualRequests++;
    const ids = new Set<string>(), returned = new Set<string>();
    for (const item of request.input) {
      if (item.type === "function_call") { assert.ok(item.call_id && !ids.has(item.call_id)); ids.add(item.call_id); }
      if (item.type === "function_call_output") { assert.ok(item.call_id && ids.has(item.call_id) && !returned.has(item.call_id)); returned.add(item.call_id); protocol.pairedToolResults++; }
    }
    const input = view(record); assert.equal(input.actor.id, record.actorId);
    const grouped = input.strategyLearning?.experienceEvidence; assert.ok(grouped, "Grounded experience must reach the actual HTTP input");
    const visibleOutcomes = input.evidence.filter(event => event.data.settlement === true);
    assert.equal(grouped.distinctOutcomeCount, new Set(visibleOutcomes.map(event => event.id)).size);
    assert.equal(grouped.outcomes.length, grouped.distinctOutcomeCount);
    assert.equal(grouped.recordCount, new Set(grouped.outcomes.flatMap(outcome => outcome.memoryIds)).size);
    assert.equal(grouped.episodeCount, new Set(grouped.outcomes.map(outcome => outcome.episode)).size);
    const aliases = new Map(input.evidence.map(event => {
      const original = sourceEvent(event.runId, event.seq);
      return [event.id, original.id];
    }));
    for (const outcome of grouped.outcomes) {
      const visible = visibleOutcomes.find(event => event.id === outcome.sourceId); assert.ok(visible);
      const original = store.event(aliases.get(visible.id)!); assert.ok(original);
      assert.equal(outcome.episode, original.runId); assert.equal(outcome.round, Number(original.data.round ?? original.data.day ?? 1));
      assert.equal(outcome.text, original.text);
      const originalFacts = JSON.parse(JSON.stringify(outcome.facts, (_key, value) => typeof value === "string" ? aliases.get(value) ?? value : value));
      assert.deepEqual(originalFacts, original.data);
      if (outcome.environment) assert.equal(outcome.environment, store.get(original.runId)?.spec.scenario);
      grounding.outcomesChecked++;
    }
    grounding.requestsChecked++;
    if (input.strategyLearning?.assessmentRequired) requiredOpportunities.set(record.opportunityId, { actorId: record.actorId, candidates: input.strategyLearning.assessmentCandidateIds });
    assert.equal(input.observation.facts.scenario, condition.scenario);
    for (const event of input.evidence) {
      assert.ok(event.visibility === "public" || Array.isArray(event.visibility) && event.visibility.includes(record.actorId));
      assert.ok(!event.data.identityScope || event.data.identityScope === run.id); protocol.evidenceChecked++;
    }
    assert.ok(Object.values(input.cognition.episodeBeliefs ?? {}).every(belief => belief.episode === run.id));
    assert.ok((input.cognition.strategyAssessments ?? []).every(item => item.episode === run.id));
    const actorMind = minds.find(mind => mind.actorId === record.actorId);
    const transferred = sourceRun ? input.cognition.memories.filter(memory => {
      const original = /^m[1-9]\d*$/.test(memory.id) ? actorMind?.memories[Number(memory.id.slice(1)) - 1] : undefined;
      return memory.scope === "transferable" && original && consolidatedIn(original, sourceRun.id);
    }) : [];
    if (transferred.length) {
      protocol.requestsWithSourceStrategies++;
      if (!retrievedActors.has(record.actorId)) transferSamples.push({ actorId: record.actorId, caseId: record.id, memories: transferred });
      retrievedActors.add(record.actorId);
    }
  }
  const learning = minds.map(mind => {
    const consolidated = mind.memories.flatMap(memory => memoryVersions(memory).filter(version => version.episode === run.id &&
      version.status !== "retired" && version.consolidation?.episode === run.id));
    for (const version of consolidated) {
      assert.ok(version.when && version.then && version.consolidation?.rationale);
      assert.deepEqual(version.consolidation?.sourceOutcomeIds, [...new Set(version.sourceIds)]); grounding.consolidationSets++;
      for (const ref of version.consolidation!.sourceMemories) {
        const source = mind.memories.find(item => item.id === ref.id); assert.ok(source && source.kind === "episodic");
        assert.equal(source.revision ?? 1, ref.revision);
        assert.ok(source.sourceIds.some(id => version.sourceIds.includes(id)));
      }
      for (const id of version.sourceIds) {
        const event = store.event(id); assert.ok(event?.data.settlement);
        assert.ok(event.visibility === "public" || Array.isArray(event.visibility) && event.visibility.includes(mind.actorId));
      }
    }
    const observed = mind.memories.filter(memory => memory.episode === run.id && memory.origin === "ledger");
    assert.deepEqual(observed.map(memory => memory.observation?.sourceId).sort(), events.filter(event => event.data.settlement &&
      typeof (event.data.payoffs as Record<string, number> | undefined)?.[mind.actorId] === "number").map(event => event.id).sort(), "Every visible monetary outcome, including passive receipt, must have one observed record");
    for (const memory of observed) {
      const observation = memory.observation; assert.ok(observation && memory.kind === "episodic");
      const outcome = store.event(observation.sourceId); assert.ok(outcome?.data.settlement && outcome.runId === run.id);
      assert.equal(observation.environment, condition.scenario); assert.equal(observation.round, Number(outcome.data.round ?? outcome.data.day ?? 1));
      assert.equal(observation.reward.value, (outcome.data.payoffs as Record<string, number>)[mind.actorId]);
      assert.deepEqual(memory.sourceIds, [outcome.id]); assert.ok(memory.text.includes(outcome.text));
      for (const action of observation.actions) {
        const decision = mind.decisions.find(decision => decision.id === action.id); assert.ok(decision && isWorldDecision(decision));
        assert.equal(action.round, decision.round);
        assert.equal(action.round, observation.round, "A round payoff must not claim earlier-round actions");
        assert.equal(decision.feedbackId, outcome.id); assert.deepEqual(action.parameters, decision.parameters);
        assert.equal(outcome.data.settlementKind === "repair", action.action === "repair_transfer", "Repair must receive its own monetary delta, not the next exchange payoff");
        assert.ok(action.parameters, "New observed decisions must retain their concrete world parameters");
        assert.ok(events.some(event => event.type === "action" && event.actorId === mind.actorId && event.data.action === action.action &&
          event.data.round === observation.round && Object.entries(action.parameters!).every(([key, value]) => event.data[key] === value)), "Observed action must match the committed world ledger");
        grounding.observedActions++;
      }
      grounding.observedMemories++;
    }
    const assessments = (mind.strategyAssessments ?? []).filter(item => item.episode === run.id);
    for (const assessment of assessments) {
      const memory = mind.memories.find(memory => memory.id === assessment.memoryId); assert.ok(memory);
      assert.equal(assessment.memoryOriginEpisode, memoryOriginEpisode(memory));
      const version = memoryVersions(memory).find(version => (version.revision ?? 1) === assessment.memoryRevision); assert.ok(version);
      assert.deepEqual(assessment.memory, { text: version.text, when: version.when, then: version.then });
      for (const id of assessment.sourceIds) {
        const event = store.event(id); assert.ok(event && event.runId === run.id);
        assert.ok(event.visibility === "public" || Array.isArray(event.visibility) && event.visibility.includes(mind.actorId));
      }
      if (assessment.verdict === "reject") assert.equal(assessment.decisionIds.length, 0);
      for (const id of assessment.decisionIds) {
        const decision = mind.decisions.find(decision => decision.id === id && decision.episode === run.id && decision.assessmentIds?.includes(assessment.id));
        assert.ok(decision && isWorldDecision(decision)); assert.ok(committed(assessment.opportunityId));
        assert.ok(cases.some(record => record.actorId === mind.actorId && record.opportunityId === assessment.opportunityId && !record.error &&
          (record.sdkOutput as Array<{ type: string; name?: string }> | undefined)?.some(item => item.type === "function_call" && item.name === decision.action)));
      }
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
    const transferred = assessments.filter(assessment => {
      const memory = mind.memories.find(memory => memory.id === assessment.memoryId);
      return sourceRun && memory && consolidatedIn(memory, sourceRun.id);
    });
    const reviews = (mind.episodeReviews ?? []).filter(review => review.episode === run.id);
    if (run.status === "completed") assert.equal(reviews.length, 1);
    const lastOutcome = events.findLast(event => event.data.settlement === true);
    for (const review of reviews) {
      const saved = events.find(event => event.actorId === mind.actorId && event.data.opportunityId === review.opportunityId && event.data.episodeReview);
      assert.ok(saved && lastOutcome && saved.seq > lastOutcome.seq); assert.deepEqual(saved.visibility, [mind.actorId]); assert.ok(committed(review.opportunityId));
      assert.ok(cases.some(record => record.opportunityId === review.opportunityId && record.providerRequest && view(record).episodeReview && view(record).observation.stageId === "done"));
      for (const id of review.sourceIds) { const source = store.event(id); assert.ok(source && source.runId === run.id && source.data.settlement === true); }
      if (review.status === "ready") assert.ok(review.strategies.length > 0); else assert.equal(review.strategies.length, 0);
      for (const ref of review.strategies) assert.ok(activeMemories(mind).some(memory => memory.id === ref.id && memory.scope === "transferable" && memory.kind === "procedural" && (memory.revision ?? 1) === ref.revision));
      const forecasts = mind.predictions.filter(prediction => prediction.episode === run.id);
      const scored = forecasts.filter(prediction => typeof prediction.result === "boolean" && prediction.sourceId && Number.isFinite(prediction.brier));
      assert.ok(review.predictionFeedback);
      assert.equal(review.predictionFeedback.forecastCount, forecasts.length);
      assert.equal(review.predictionFeedback.scoredForecastCount, scored.length);
      assert.equal(review.predictionFeedback.uniqueScoredEventCount, new Set(scored.map(prediction => prediction.sourceId)).size);
      assert.equal(review.predictionFeedback.unscoredForecastCount, forecasts.length - scored.length);
      assert.ok(review.predictionFeedback.unscored.every(prediction => prediction.status === "unverified"));
    }
    return { actorId: mind.actorId, consolidated: consolidated.map(memory => ({ id: memory.id, revision: memory.revision ?? 1, text: memory.text, when: memory.when, then: memory.then, consolidation: memory.consolidation })),
      transferableStrategies: activeMemories(mind).filter(memory => memory.kind === "procedural" && memory.scope === "transferable").length,
      reviews, assessments, sourceAssessments: transferred.length, sourceAdoptions: transferred.filter(item => item.decisionIds.length > 0).length,
      sourceAdoptionsWithFeedback: transferred.filter(item => item.feedback.length > 0).length,
      revisedMemories: mind.memories.filter(memory => memory.revisions?.some(revision => revision.episode === run.id)).length,
      predictionsScored: mind.predictions.filter(prediction => prediction.episode === run.id && prediction.result !== undefined).length };
  });
  const publicView = JSON.stringify(run.view({}));
  const comparisons: Array<{ opportunityId: string; actorId: string; comparisonCalls: string[]; actionCases: string[] }> = [];
  for (const [opportunityId, required] of requiredOpportunities) {
    if (!committed(opportunityId)) continue;
    const records = cases.filter(record => record.opportunityId === opportunityId && !record.error);
    const comparisonCalls = records.flatMap(record => (record.sdkOutput as Array<{ type: string; name?: string; arguments?: string; callId?: string }> ?? [])
      .filter(item => item.type === "function_call" && ["assess_strategy", "revise_memory"].includes(item.name ?? "")).flatMap(item => {
        const args = JSON.parse(item.arguments!) as { id?: string; change?: string; replacement?: { kind?: string } };
        return item.callId && required.candidates.includes(args.id ?? "") && (item.name === "assess_strategy" || args.change === "retire" || args.replacement?.kind === "semantic") ? [item.callId] : [];
      }));
    assert.ok(comparisonCalls.length, "A committed gated action needs an explicit assessment or retirement of a retrieved candidate");
    const actionCases = records.filter(record => (record.sdkOutput as Array<{ type: string; name?: string }> ?? [])
      .some(item => item.type === "function_call" && (record.context.actions as Array<{ name: string }>).some(action => action.name === item.name)));
    assert.ok(actionCases.length);
    for (const record of actionCases) assert.ok((record.providerRequest as HttpRequest).input.some(item => item.type === "function_call_output" && comparisonCalls.includes(item.call_id ?? "")), "The world action must read the formal comparison receipt");
    comparisons.push({ opportunityId, actorId: required.actorId, comparisonCalls, actionCases: actionCases.map(record => record.id) });
  }
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
    blockedTools: events.filter(event => event.data.harness && event.data.kind === "tool_rejected").length,
    activations: (store.db.prepare("SELECT count(*) AS n FROM agent_activations WHERE run_id=?").get(run.id) as { n: number }).n,
    protocol, grounding, learning, retrievedActors: [...retrievedActors], comparisons, requiredOpportunities: requiredOpportunities.size,
    comparisonActors: [...new Set(comparisons.map(item => item.actorId))], transferSamples, callsByTool, privateIntentLeaks, reportEvidence,
    errors: cases.filter(record => record.error).map(record => ({ caseId: record.id, opportunityId: record.opportunityId, error: record.error, response: record.response })), world };
}
try {
  for (const condition of schedule) {
    if (timedOut) break;
    const sourceRun = condition.source ? sourceRuns.get(condition.source) : undefined;
    const initialSnapshots: Record<string, string> = {};
    if (condition.source) {
      const sourceCondition = originResults.results.find(item => item.id === condition.source);
      assert.ok(sourceCondition, "The preselected source condition is required; do not choose a substitute");
      const inventory = sourceCondition.roster.map(actorId => {
        const snapshot = sourceRun?.status === "completed" ? store.snapshots(actorId).find(snapshot => snapshot.runId === sourceRun.id) : undefined;
        const memories: CognitiveMemory[] = snapshot?.cognition ? activeMemories(snapshot.cognition).filter(memory => memory.kind === "procedural" && memory.scope === "transferable" && consolidatedIn(memory, sourceRun!.id)) : [];
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
    const { run } = service.create(spec, characters);
    console.log(JSON.stringify({ starting: condition.id, runId: run.id, sourceRunId: sourceRun?.id }));
    await run.settled();
    const result = analyze(run, condition, sourceRun); results.push(result); write("results.json", { status: "running", sourceHash, results });
    console.log(JSON.stringify({ finished: condition.id, runId: run.id, status: result.status, calls: result.calls, failedCalls: result.failedCalls, toolErrors: result.toolErrors,
      consolidated: result.learning.reduce((sum, actor) => sum + actor.consolidated.length, 0), sourceAssessments: result.learning.reduce((sum, actor) => sum + actor.sourceAssessments, 0),
      sourceAdoptionsWithFeedback: result.learning.reduce((sum, actor) => sum + actor.sourceAdoptionsWithFeedback, 0) }));
  }
  const sourceChanged = agentSourceHash() !== sourceHash;
  const originChanged = fileHash(path.join(origin, "results.sqlite")) !== originHash;
  const completed = results.filter(result => result.status === "completed").length;
  const analyzed = results.filter(result => Array.isArray(result.learning)) as Array<ReturnType<typeof analyze>>;
  const coverage = { targetActorsWithRetrievedSourceStrategies: analyzed.reduce((sum, result) => sum + result.retrievedActors.length, 0),
    targetActorsWithExplicitComparisons: analyzed.reduce((sum, result) => sum + result.comparisonActors.length, 0),
    targetEnvironmentsWithAssessmentAndAdoptedFeedback: analyzed.filter(result => result.source && result.learning.some(actor => actor.sourceAdoptionsWithFeedback > 0)).length,
    finalPrivateReviews: analyzed.flatMap(result => result.learning).reduce((sum, actor) => sum + actor.reviews.length, 0) };
  const protocolPassed = !sourceChanged && !originChanged && !timedOut && completed === schedule.length && analyzed.every(result => result.failedCalls === 0 && result.toolErrors === 0 && result.privateIntentLeaks === 0);
  const comparisonPassed = coverage.targetActorsWithExplicitComparisons === 4 && analyzed.every(result => result.comparisons.length === result.requiredOpportunities);
  const learningPassed = coverage.targetActorsWithRetrievedSourceStrategies === 4 && coverage.targetEnvironmentsWithAssessmentAndAdoptedFeedback === 2 && coverage.finalPrivateReviews === 5;
  const groundingPassed = analyzed.length === schedule.length && analyzed.every(result => result.grounding.requestsChecked === result.protocol.actualRequests && result.grounding.observedMemories > 0);
  const passed = protocolPassed && comparisonPassed && learningPassed && groundingPassed;
  write("results.json", { passed, protocolPassed, comparisonPassed, learningPassed, groundingPassed, sourceHash, sourceChanged, originChanged, timedOut, coverage, results, finishedAt: new Date().toISOString() });
  console.log(JSON.stringify({ passed, protocolPassed, comparisonPassed, learningPassed, groundingPassed, completed, calls: analyzed.reduce((sum, result) => sum + result.calls, 0), coverage, sourceChanged, originChanged, artifact: directory }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  write("results.json", { passed: false, sourceHash, sourceChanged: agentSourceHash() !== sourceHash, error: nativeError(error), results, finishedAt: new Date().toISOString() });
  console.log(JSON.stringify({ error: nativeError(error), artifact: directory })); process.exitCode = 1;
} finally {
  clearInterval(progress); clearTimeout(timeout); service.stopAll();
  await Promise.allSettled([...service.live.values()].map(run => run.settled())); store.close();
}
