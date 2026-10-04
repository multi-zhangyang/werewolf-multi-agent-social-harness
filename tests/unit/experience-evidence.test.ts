import { expect, it } from "vitest";
import { consolidateStrategy, createAgentMind, enterEpisode, integrateExperience, remember, type Experience } from "../../src/agents/cognition";
import { buildExperienceEvidence } from "../../src/agents/experience-evidence";
import { GeneralAgentContext } from "../../src/runtime/agent-context";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { ModelRegistry } from "../../src/society/models/registry";
import { ledgerExperience } from "../../src/runtime/agent-state";
import { decisionMeta, generalAppraisal, generalContext } from "../helpers/general-agent-fixture";
import { sdkCall, sdkFixture, sdkInput } from "../helpers/sdk-fixture";

function outcome(round: number): Experience {
  return { id: `outcome-${round}`, episode: "source", seq: round * 2, round, environment: "information-exchange",
    kind: "outcome", name: "settlement", text: `第${round}轮，实际低质量，${round === 1 ? "报告高质量" : "报告低质量"}，拒绝后双方各得2点`,
    data: { settlement: true, highQuality: false, reportedHighQuality: round === 1, payoffs: { self: 2, peer: 2 } },
    reward: { value: 2, normalized: 1 / 3, unit: "points" } };
}
function history() {
  const mind = createAgentMind("self", "source");
  for (let round = 1; round <= 4; round++) {
    mind.decisions.push({ id: `decision-${round}`, episode: "source", round, action: "accept", parameters: { accepted: false }, ...decisionMeta, strategy: "protect", intent: "truthful", predictionIds: [] });
    integrateExperience(mind, outcome(round));
  }
  remember(mind, { kind: "episodic", scope: "transferable", sourceIds: ["outcome-1"], text: "我记下了第一轮的虚假报告", confidence: 1, tags: [], when: null, then: null });
  return mind;
}

it("keeps concrete submitted actions and the actual visible outcome in a durable observation", () => {
  const mind = history(), record = mind.memories[0];
  expect(record).toMatchObject({ origin: "ledger", observation: { sourceId: "outcome-1", environment: "information-exchange", round: 1,
    actions: [{ action: "accept", parameters: { accepted: false } }], reward: { value: 2 } } });
  expect(record.text).toContain("实际低质量"); expect(record.text).toContain('"accepted":false');
  expect(mind.memories.at(-1)?.origin).toBe("agent");
  const before = structuredClone(record); mind.decisions[0].parameters!.accepted = true;
  expect(record).toEqual(before);
});

it("groups five records into four actual settlements and distinguishes a reported high value from a true high value", () => {
  const mind = history(), before = JSON.stringify(mind), events = [1, 2, 3, 4].map(outcome);
  const evidence = buildExperienceEvidence(mind, [...events, events[0]]);
  expect(evidence).toMatchObject({ distinctOutcomeCount: 4, recordCount: 5, episodeCount: 1 });
  expect(evidence.outcomes[0]).toMatchObject({ memoryIds: [mind.memories[0].id, mind.memories[4].id], facts: { highQuality: false, reportedHighQuality: true } });
  expect(evidence.outcomes.map(item => item.facts.highQuality)).toEqual([false, false, false, false]);
  expect(evidence.outcomes[0].records.map(record => record.origin)).toEqual(["ledger", "agent"]);
  const sourceIds = evidence.outcomes.map(item => item.sourceId);
  const rule = consolidateStrategy(mind, { strategyId: null, memoryIds: mind.memories.map(memory => memory.id), text: "有限证据不等于保证", confidence: .4,
    tags: [], rationale: "同一结算的重复笔记不增加样本", when: "证据存在重复解释", then: "按实际事件核对证据" }, sourceIds);
  expect(rule.consolidation).toMatchObject({ sourceOutcomeIds: sourceIds }); expect(rule.consolidation?.sourceMemories).toHaveLength(5);
  expect(JSON.stringify({ ...mind, revision: JSON.parse(before).revision, memories: mind.memories.slice(0, -1) })).toBe(before);
});

it("summarizes alternating roles and repair transfers without counting duplicate notes as extra rounds or returns", () => {
  const { spec } = generalContext();
  const mind = createAgentMind("self", "r");
  const entries = [
    { round: 1, investorId: "self", trusteeId: "peer", payoffs: { self: 10 } },
    { round: 1, settlementKind: "repair", repair: { actorId: "peer", targetId: "self" }, payoffs: { self: 2 } },
    { round: 2, investorId: "peer", trusteeId: "self", payoffs: { self: 12 } },
    { round: 2, settlementKind: "repair", repair: { actorId: "self", targetId: "peer" }, payoffs: { self: -3 } },
  ].map((data, index) => ledgerExperience({ id: `e${index}`, runId: "r", seq: index + 1, at: "", type: "fact",
    visibility: "public", text: "结算", data: { ...data, settlement: true } }, spec, "self")!);
  for (const event of entries) integrateExperience(mind, event);
  remember(mind, { kind: "episodic", scope: "transferable", sourceIds: ["e0"], text: "另一份记录", confidence: 1, tags: [], when: null, then: null });
  const summary = buildExperienceEvidence(mind, [...entries, entries[0]]).episodes[0];
  expect(summary).toMatchObject({ settlementCount: 4, roundCount: 2,
    roleCounts: { investor: 1, trustee: 1, "repair-recipient": 1, "repair-sender": 1 },
    returns: [{ unit: "points", total: 21, settlementCount: 4 }] });
});

it("does not treat absent, unauthorized or local identity records as retrieved outcome evidence, or relabel old environments", () => {
  const { context, spec } = generalContext(); context.cognition = history();
  remember(context.cognition, { kind: "episodic", scope: "episode", sourceIds: ["hidden-role"], text: "old-role-canary", confidence: 1, tags: [], when: null, then: null });
  context.lookupEvidence = id => id.startsWith("outcome-") ? { id, runId: "source", seq: Number(id.at(-1)), at: "", type: "fact", visibility: ["self"], text: outcome(Number(id.at(-1))).text,
    data: outcome(Number(id.at(-1))).data } : undefined;
  context.recent.push({ id: "private-peer-outcome", runId: "r", seq: 9, at: "", type: "fact", visibility: ["peer"], text: "private-canary", data: { settlement: true } });
  const view = JSON.parse(new GeneralAgentContext(context, spec, "r").modelInput());
  expect(view.strategyLearning.experienceEvidence.distinctOutcomeCount).toBe(4);
  expect(view.strategyLearning.experienceEvidence.outcomes.every((item: { environment: string }) => item.environment === "information-exchange")).toBe(true);
  expect(JSON.stringify(view)).not.toContain("private-canary"); expect(JSON.stringify(view)).not.toContain("old-role-canary");
  const old = enterEpisode(context.cognition, "self", "r"); for (const memory of old.memories) { delete memory.origin; delete memory.observation; }
  context.cognition = old;
  const legacy = JSON.parse(new GeneralAgentContext(context, spec, "r").modelInput()).strategyLearning.experienceEvidence;
  expect(legacy.outcomes.every((item: { environment?: string }) => item.environment === undefined)).toBe(true);
});

it("captures parsed world parameters through the official SDK while keeping statements outside outcome actions", async () => {
  const { context, spec, activations } = generalContext();
  const fixture = sdkFixture((request, index) => index === 0 ? sdkCall("appraise_event", generalAppraisal(sdkInput(request).newEvidenceIds[0]))
    : sdkCall("invest", { amount: 3, ...decisionMeta }));
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  const saved = activations[0].cognition!; expect(saved.decisions[0]).toMatchObject({ action: "invest", parameters: { amount: 3 } });
  const observed = { ...outcome(1), episode: "r", id: "actual-settlement", data: { settlement: true }, seq: 10 };
  saved.decisions.push({ id: "speech", episode: "r", round: 1, action: "speak", ...decisionMeta, strategy: "cooperate", intent: "truthful", predictionIds: [] });
  integrateExperience(saved, observed);
  expect(saved.memories.at(-1)?.observation?.actions).toEqual([{ id: saved.decisions[0].id, action: "invest", round: 1, parameters: { amount: 3 } }]);
  expect(buildExperienceEvidence(saved, [observed]).outcomes[0].actions).toHaveLength(1);
});
