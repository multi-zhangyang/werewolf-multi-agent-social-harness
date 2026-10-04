import { expect, it } from "vitest";
import { createAgentMind, integrateExperience, remember } from "../../src/agents/cognition";
import { payoffFeedback, type DecisionStructure } from "../../src/agents/decision-analysis";
import { recallCognitiveMemories } from "../../src/agents/recall";
import { actionReadback, decisionStructure, payoffTool, strategicBrief } from "../../src/runtime/decision-support";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { EconomicScenario } from "../../src/runtime/scenarios/economic";
import { SignalingScenario } from "../../src/runtime/scenarios/signaling";
import { runSpecSchema, type ScenarioAdapter, type TurnContext } from "../../src/runtime/types";
import { ModelRegistry } from "../../src/society/models/registry";
import { characters, decisionMeta, generalAppraisal, generalContext } from "../helpers/general-agent-fixture";
import { sdkCall, sdkFixture, sdkInput } from "../helpers/sdk-fixture";

function contextFor(world: ScenarioAdapter, actorId: string): TurnContext {
  return { ...generalContext().context, character: characters.find(character => character.id === actorId)!,
    worldObservation: world.observation!(actorId), observation: world.observe(actorId),
    opportunity: { id: "choice", actorId, stage: world.stage()!, actions: world.actions(actorId), channel: "private", recipients: [actorId], communications: [] } };
}
const signalSpec = runSpecSchema.parse({ scenario: "signaling-game", roster: characters.slice(0, 2).map(c => ({ characterId: c.id })) });

it("compares true and false reports using known quality and evidence priors, without choosing for the sender", () => {
  const world = new SignalingScenario(characters.slice(0, 2), 2, 23);
  const context = contextFor(world, "self");
  const truth = (context.worldObservation!.facts.privateInformation as { highQuality: boolean }).highQuality;
  const proposal = { rationale: "假设高报告更可能被接受，尚未验证", options: [
    { label: "高报告", choice: { highQuality: true } },
    { label: "低报告", choice: { highQuality: false } },
  ] };
  const before = world.checkpoint();
  const compared = payoffTool(context, signalSpec)!.compare(proposal);
  expect(compared.options.map(option => option.expectedOwn)).toEqual([4, 4]);
  expect(compared.beliefSnapshot?.high).toMatchObject({ probability: .5, samples: 0, priorOnly: true });
  expect(() => payoffTool(context, signalSpec)!.compare({ ...proposal, options: proposal.options.map(o => ({ ...o, acceptanceProbability: .9 })) })).toThrow();
  expect(compared.options.map(option => option.reportAccurate)).toEqual([truth, !truth]);
  expect(actionReadback(context, "declare_quality", { highQuality: false })).toMatchObject({ reportedHighQuality: false, reportAccurate: !truth });
  expect(world.checkpoint()).toEqual(before);
  expect(payoffFeedback(compared, { highQuality: true }, { accepted: false }, 2)).toMatchObject({ expectedOwn: 4, actualOwn: 2, residual: -2, modeledOutcomeProbability: .5 });
  expect(payoffFeedback(compared, { highQuality: true }, {}, 2)?.modeledOutcomeProbability).toBeNull();
});

it("uses the same receiver belief for accept and reject and cannot inspect unrevealed quality", () => {
  const world = new SignalingScenario(characters.slice(0, 2), 2, 23);
  world.apply("self", "declare_quality", { highQuality: true }); world.advance(); world.advance();
  const context = contextFor(world, "peer");
  const proposal = { rationale: "暂用公开先验",
    options: [{ label: "接受", choice: { accept: true } }, { label: "拒绝", choice: { accept: false } }] };
  const compared = payoffTool(context, signalSpec)!.compare(proposal);
  expect(compared.options.map(option => option.expectedOwn)).toEqual([3, 2]);
  expect(strategicBrief(context, signalSpec)).toMatchObject({ receiverBreakEvenHighProbability: 1 / 3 });
  expect(context.worldObservation!.facts).not.toHaveProperty("privateInformation");
  expect(compared.beliefSnapshot).not.toHaveProperty("knownHighQuality");
  expect(() => payoffTool(context, signalSpec)!.compare({ ...proposal, highQualityProbability: .9 })).toThrow();
  const checkpoint = world.checkpoint() as unknown as { highQuality: boolean };
  world.restore({ ...checkpoint, highQuality: !checkpoint.highQuality });
  expect(payoffTool(contextFor(world, "peer"), signalSpec)!.compare(proposal)).toEqual(compared);
});

it("keeps sealed public contributions out of comparisons and shares exact settlement arithmetic", () => {
  const world = new EconomicScenario("public-goods", characters.slice(0, 3), 2); world.advance();
  const spec = runSpecSchema.parse({ scenario: "public-goods", roster: characters.slice(0, 3).map(c => ({ characterId: c.id })) });
  const proposal = { rationale: "只是假设他人总投入10", otherContributions: [{ otherTotal: 10, probability: 1 }],
    options: [{ label: "不投入", choice: { amount: 0 } }, { label: "全额投入", choice: { amount: 10 } }] };
  const before = payoffTool(contextFor(world, "self"), spec)!.compare(proposal);
  world.apply("peer", "contribute", { amount: 7 }); world.apply("third", "contribute", { amount: 3 });
  expect(payoffTool(contextFor(world, "self"), spec)!.compare(proposal)).toEqual(before);
  world.apply("self", "contribute", { amount: 10 });
  const settled = world.advance()[0].data.payoffs as Record<string, number>;
  expect(before.options[1].expectedOwn).toBe(settled.self);
  expect(before.options[0].expectedOwn).toBeGreaterThan(before.options[1].expectedOwn);
});

const investmentProposal = { rationale: "比较不投资与有限试探", options: [
  { label: "保留", choice: { amount: 0 }, returns: [{ returned: 0, probability: 1 }] },
  { label: "试探", choice: { amount: 4 }, returns: [{ returned: 0, probability: .5 }, { returned: 8, probability: .5 }] },
] };

it("executes comparison through the official SDK and durably pairs the selected parameters with actual feedback", async () => {
  const { context, spec, activations } = generalContext();
  const fixture = sdkFixture((request, index) => index === 0 ? sdkCall("appraise_event", generalAppraisal(sdkInput(request).newEvidenceIds[0]))
    : index === 1 ? sdkCall("compare_options", investmentProposal) : sdkCall("invest", { amount: 4, ...decisionMeta, strategyBasis: null }));
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(activations).toHaveLength(1);
  const mind = activations[0].cognition!;
  expect(mind.decisions[0]).toMatchObject({ parameters: { amount: 4 }, payoffComparison: { action: "invest" }, decisionStructure: { control: "entrust" } });
  integrateExperience(mind, { id: "settled", episode: "r", seq: 10, round: 1, kind: "outcome", name: "settlement", text: "返还0", data: { settlement: true, returned: 0 }, reward: { value: 6, normalized: .2, unit: "points" } });
  expect(mind.memories.at(-1)?.observation?.comparisons?.[0].feedback).toMatchObject({ expectedOwn: 10, actualOwn: 6, residual: -4, modeledOutcomeProbability: .5 });
  const invalid = structuredClone(investmentProposal); invalid.options[0].returns[0].returned = 1;
  expect(() => payoffTool(context, spec)!.compare(invalid)).toThrow("到账额");
});

it("retrieves a differently worded strategy from its ledger-linked decision structure, without declaring it applicable", () => {
  const mind = createAgentMind("self", "r");
  const structure: DecisionStructure = { information: "unverified-claim", control: "entrust", verification: "public-action", incentives: "mixed", horizon: "repeated" };
  mind.decisions.push({ id: "d", episode: "r", round: 1, action: "invest", parameters: { amount: 4 }, strategy: "probe", intent: "none", privateAim: "试探", predictionIds: [], decisionStructure: structure });
  integrateExperience(mind, { id: "outcome", episode: "r", seq: 1, round: 1, kind: "outcome", name: "settlement", text: "反馈", data: { settlement: true }, reward: { value: 6, normalized: .2, unit: "points" } });
  const rule = remember(mind, { kind: "procedural", scope: "transferable", text: "先看实际结果", sourceIds: ["outcome"], confidence: .4, when: "风险由我承担", then: "小步试探", tags: [] });
  const matches = recallCognitiveMemories(mind, "unmatched-vocabulary", 1, structure);
  expect(matches[0].id).toBe(rule.id);
  expect(mind.strategyAssessments).toEqual([]);
  const { context, spec } = generalContext(); expect(decisionStructure(context, spec)).toEqual(structure);
});
