import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResponseCreateParams } from "openai/resources/responses/responses";
import { enterEpisode, remember, type CognitiveMemory } from "../src/agents/cognition";
import { agentSourceHash, snapshotAgentSource } from "../src/agents/provenance";
import { nativeConfiguration, nativeError } from "../src/agents/sdk";
import { GeneralAgentContext } from "../src/runtime/agent-context";
import { modelParticipantFactory } from "../src/runtime/participant";
import { RunService } from "../src/runtime/run";
import { SocietyStore } from "../src/runtime/store";
import { runSpecSchema, visible, type ParticipantFactory, type RunSpec, type WorldEvent } from "../src/runtime/types";
import { runtimeCharacter } from "../src/server/routes/runs";
import { loadRegistry } from "../src/society/models";
import { builtinCharacter } from "../src/society/profiles";

type Scenario = "trust-game" | "public-goods";
type Prior = "overtrust" | "distrust";
interface InputView { actor: { id: string }; cognition: { memories: CognitiveMemory[] }; evidence: WorldEvent[] }
function actualInput(request: unknown): InputView {
  const input = (request as ResponseCreateParams).input;
  const item = Array.isArray(input) ? input.find(item => "role" in item && item.role === "user") : undefined;
  const content = item && "content" in item ? item.content : input;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.flatMap(part => part.type === "input_text" ? [part.text] : []).join("") : undefined;
  assert.ok(text, "Saved Responses request must contain the actual model input");
  return JSON.parse(text);
}
function containsRevisionReceipt(request: unknown) {
  const input = (request as ResponseCreateParams).input;
  if (!Array.isArray(input)) return false;
  const ids = new Set(input.flatMap(item => item.type === "function_call" && item.name === "revise_memory" ? [item.call_id] : []));
  return input.some(item => {
    if (item.type !== "function_call_output" || !ids.has(item.call_id) || typeof item.output !== "string") return false;
    try { const receipt = JSON.parse(item.output); return receipt.id === "m1" && receipt.revision >= 2 && !receipt.revisions; }
    catch { return false; }
  });
}
function priorMemory(scenario: Scenario, prior: Prior, sourceId: string) {
  const optimistic = prior === "overtrust";
  return {
    kind: "procedural" as const, scope: "transferable" as const, confidence: .95,
    sourceIds: [sourceId], tags: ["研究设定", "互惠", scenario === "trust-game" ? "投资返还" : "公共池投入"],
    text: scenario === "trust-game"
      ? optimistic ? "只要我先投资，对方总会返还至少我投入的数额，互惠可以确信。" : "即使我先投资，对方也绝不会返还任何资源，互惠不可能发生。"
      : optimistic ? "公共池中的其他参与者总会投入至少6点，集体合作可以确信。" : "公共池中的其他参与者从不投入任何资源，集体合作不可能发生。",
    when: scenario === "trust-game" ? "先付出资源，并需要判断对方是否会返还" : "共同收益需要多个参与者自愿投入资源",
    then: optimistic ? "基于对方必会互惠的判断提高自己的投入" : "基于对方绝不互惠的判断拒绝投入",
  };
}

const preflight = process.env.AGENT_REVISION_PREFLIGHT === "1";
const directory = path.resolve(process.env.AGENT_REVISION_DIR ?? `data/memory-revision-${preflight ? "preflight" : "validation"}-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const sourceHash = snapshotAgentSource(path.join(directory, "source"));
cpSync("scripts/validate-memory-revision.ts", path.join(directory, "source/validate-memory-revision.ts"));
const registry = loadRegistry("data/model-settings.json");
const configuration = nativeConfiguration(registry);
const store = new SocietyStore(path.join(directory, "results.sqlite"));
const production = modelParticipantFactory(registry);
const characters = Array.from({ length: 3 }, (_, index) => runtimeCharacter(builtinCharacter(`builtin-${String(index + 1).padStart(2, "0")}`)!));
const focalId = characters[0].id;
const schedule = (["trust-game", "public-goods"] as const).flatMap(scenario => (["overtrust", "distrust"] as const).flatMap(prior => [0, 1].map(repeat => ({ scenario, prior, repeat }))));
const manifest = { sourceHash, configuration, schedule, focalId, preflight, createdAt: new Date().toISOString(),
  protocol: "Researcher-set, explicitly labeled prior plus 20 irrelevant memories. Round 1 and peers use fixed legal policies. From round 2 only the focal participant uses the unchanged production SDK Agent.",
  actualModelEvidence: !preflight, autonomousLearning: false,
  thresholds: { completedRuns: schedule.length, failedCalls: 0, toolErrors: 0, originalRuleRetrieved: true,
    originalRuleRevisedOrRetired: true, citesActualCounterevidence: true, receiptBeforeAction: true, sourceChanged: false },
  limitation: "Directional counterevidence pilot; not an unassisted natural-learning benchmark or proof of improved payoff. Actions and revised content are not prescribed." };
writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ artifact: directory, sourceHash, preflight }));
const results: Array<Record<string, unknown>> = [];
let service: RunService | undefined;
const progress = setInterval(() => console.log(JSON.stringify({ running: [...service?.live.values() ?? []].map(run => ({ id: run.id,
  scenario: run.record.spec.scenario, phase: run.world.stage()?.id, calls: store.cases(run.id).length })) })), 30_000);
const timeout = setTimeout(() => service?.stopAll(), 20 * 60_000);
try {
  for (const item of schedule) {
    let seeded: CognitiveMemory | undefined;
    let checkedFirstInput = false;
    const scriptedOpportunities: string[] = [];
    const modelOpportunities: string[] = [];
    const factory: ParticipantFactory = (character, spec, runId) => {
      const agent = production(character, spec, runId);
      return { configuration: { ...agent.configuration, experimentPolicy: character.id === focalId ? "scripted round 1; production Agent round 2" : "fixed scripted peer" },
        async turn(context) {
          const useModel = character.id === focalId && context.opportunity.stage.round >= 2;
          if (useModel && !checkedFirstInput) {
            const input: InputView = JSON.parse(new GeneralAgentContext(context, spec, runId).modelInput());
            assert.ok(seeded);
            assert.equal(context.cognition?.memories.length, 21);
            assert.ok(input.cognition.memories.some(memory => memory.id === "m1" && memory.text === seeded!.text), "Retrieve the relevant oldest rule despite 20 later distractors");
            assert.ok(input.evidence.some(event => event.data.settlement && event.data.round === 1), "First model input must contain actual first-round feedback");
            checkedFirstInput = true;
          }
          if (useModel && !preflight) { modelOpportunities.push(context.opportunity.id); return agent.turn(context); }
          scriptedOpportunities.push(context.opportunity.id);
          const mind = enterEpisode(context.cognition, character.id, runId);
          if (character.id === focalId && !seeded) {
            const source = store.append(runId, { type: "fact", actorId: focalId, visibility: [focalId],
              text: "研究初态：旧判断与20条无关座位记忆均由研究者人为设定，可能错误；它们不是本局已经发生的账本结果。",
              data: { researchIntervention: "synthetic-memory-prior", prior: item.prior, irrelevantMemories: 20 } }, [focalId]);
            seeded = structuredClone(remember(mind, priorMemory(item.scenario, item.prior, source.id)));
            for (let index = 0; index < 20; index++) remember(mind, { kind: "episodic", scope: "transferable", confidence: 1,
              sourceIds: [source.id], tags: ["无关初态"], text: `研究设定的座位片段${index + 1}：窗边的椅子贴着蓝色标签。`, when: null, then: null });
          }
          const calls = context.opportunity.actions.map(action => {
            const amount = action.name === "invest" ? 6 : action.name === "return_funds" ? item.prior === "overtrust" ? 0 : 12
              : character.id === focalId ? 6 : item.prior === "overtrust" ? 0 : 8;
            return { name: action.name, args: action.parameters.parse({ amount }) as Record<string, unknown> };
          });
          context.commitActivation!({ id: context.opportunity.id, actorId: character.id, stageId: context.opportunity.stage.id,
            cognition: mind, calls, ...(calls.length ? {} : { waited: true }) });
          return calls.length ? {} : { waited: true };
        } };
    };
    service = new RunService(store, factory);
    const roster = characters.slice(0, item.scenario === "trust-game" ? 2 : 3);
    const spec: RunSpec = runSpecSchema.parse({ scenario: item.scenario, rounds: 2, seed: 70 + item.repeat, mode: "experiment",
      worldId: `revision-${item.scenario}-${item.prior}-${item.repeat}`, roster: roster.map(character => ({ characterId: character.id, modelProfileId: "gpt-6-luna" })),
      budgets: { discussionTurns: roster.length, maxTurns: 8 }, cognition: { requestTimeoutMs: 60000 },
      experiment: { psychology: "hybrid", speaking: "round-robin", relationshipMemory: true } });
    const { run } = service.create(spec, structuredClone(roster));
    store.annotate(run.id, { ...manifest, schedule: undefined, item });
    await run.settled();
    const events = store.events(run.id), cases = store.cases(run.id);
    assert.ok(seeded);
    const settlement = events.find(event => event.data.settlement && event.data.round === 1);
    assert.ok(settlement, "Fixed legal prefix must really settle");
    const amounts = settlement.data.amounts as Record<string, number>;
    assert.equal(amounts[focalId], 6);
    for (const peer of roster.slice(1)) assert.equal(amounts[peer.id], item.prior === "overtrust" ? 0 : item.scenario === "trust-game" ? 12 : 8);
    const mind = store.cognition(run.id, focalId)!;
    const finalRule = mind.memories.find(memory => memory.id === seeded!.id)!;
    const changes = finalRule.revisions ?? [];
    const counterevidence = new Set(events.filter(event => event.id === settlement.id || event.type === "action" &&
      event.actorId !== focalId && event.data.round === 1 && visible(event, { actorId: focalId }) && event.data.action === "return_funds").map(event => event.id));
    const initial = cases.length ? actualInput(cases[0].providerRequest) : undefined;
    const originalRuleRetrieved = Boolean(initial?.cognition.memories.some(memory => memory.id === "m1" && memory.text === seeded!.text));
    const actions = events.filter(event => event.actorId === focalId && event.type === "action" && event.data.round === 2).map(event => ({ action: event.data.action, amount: event.data.amount }));
    const actionCases = cases.filter(record => record.phase === "action");
    const receiptBeforeAction = actionCases.some(record => containsRevisionReceipt(record.providerRequest)) || actionCases.some(record => {
      const input = actualInput(record.providerRequest);
      return input.cognition.memories.some(memory => memory.id === "m1" && (memory.revision ?? 1) >= 2) ||
        finalRule.status === "retired" && !input.cognition.memories.some(memory => memory.id === "m1");
    }) && cases.some(record => containsRevisionReceipt(record.providerRequest));
    const result = { ...item, runId: run.id, status: run.status, calls: cases.length, failedCalls: cases.filter(record => record.error).length,
      toolErrors: events.filter(event => event.data.toolError).length, scriptedActivations: scriptedOpportunities.length,
      modelActivations: modelOpportunities.length, preflightInputChecked: checkedFirstInput, originalRuleRetrieved,
      originalRuleRevisedOrRetired: changes.length > 0, citesActualCounterevidence: changes.some(change => change.sourceIds.some(id => counterevidence.has(id))),
      receiptBeforeAction, actualRoundOne: { id: settlement.id, amounts, payoffs: settlement.data.payoffs },
      seededRule: seeded, finalRule, actions, predictions: mind.predictions.length,
      originalHistoryPreserved: !changes.length || JSON.stringify(changes[0].previous) === JSON.stringify(seeded),
      errors: events.filter(event => event.data.error).map(event => event.text) };
    results.push(result);
    writeFileSync(path.join(directory, "results.json"), JSON.stringify({ status: "running", sourceHash, preflight, results }, null, 2));
    console.log(JSON.stringify({ ...item, runId: run.id, status: run.status, calls: cases.length, revised: changes.length,
      originalRuleRetrieved, citesActualCounterevidence: result.citesActualCounterevidence, receiptBeforeAction, actions }));
  }
  const sourceChanged = sourceHash !== agentSourceHash();
  const protocolPassed = !sourceChanged && results.length === schedule.length && results.every(result => result.status === "completed" &&
    result.failedCalls === 0 && result.toolErrors === 0 && result.preflightInputChecked && result.originalHistoryPreserved);
  const passed = !preflight && protocolPassed && results.every(result => result.originalRuleRetrieved && result.originalRuleRevisedOrRetired &&
    result.citesActualCounterevidence && result.receiptBeforeAction);
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ passed, preflight, protocolPassed, sourceHash, sourceChanged,
    results, limitation: manifest.limitation, finishedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ passed, preflight, protocolPassed, artifact: directory }));
  if (!(preflight ? protocolPassed : passed)) process.exitCode = 1;
} catch (error) {
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ passed: false, sourceHash, preflight, results, error: nativeError(error) }, null, 2));
  console.log(JSON.stringify({ error: nativeError(error), artifact: directory })); process.exitCode = 1;
} finally { clearInterval(progress); clearTimeout(timeout); service?.stopAll(); await Promise.allSettled([...service?.live.values() ?? []].map(run => run.settled())); store.close(); }
