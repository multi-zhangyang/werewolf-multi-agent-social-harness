import { expect, it } from "vitest";
import { assessStrategy, bindStrategyAssessments, cognitionForPrompt, consolidateStrategy, consolidationParameters, createAgentMind, enterEpisode, forecast,
  integrateExperience, remember, reviseMemory, strategyUsage, type AgentMind, type Experience, type PrivateDecision } from "../../src/agents/cognition";
import { selectWorkingMemories } from "../../src/agents/recall";
import { GeneralAgentContext } from "../../src/runtime/agent-context";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { ModelRegistry } from "../../src/society/models/registry";
import { decisionMeta, generalAppraisal, generalContext } from "../helpers/general-agent-fixture";
import { sdkCall, sdkFixture, sdkInput, sdkToolResult } from "../helpers/sdk-fixture";

const lesson = { text: "以可核验行动更新承诺的可信度", when: "互动可重复且能观察承诺后的实际行为；没有核验机会时不能据此保证结果",
  then: "比较承诺与实际行动，再按可承担的风险调整选择", confidence: .55, tags: ["核验", "利益"], rationale: "报告与结果分离的结构可能复用，源局金额和身份不能照搬" };
const judgment = { sourceIds: ["new-observation"], verdict: "adapt" as const, matching: "仍然需要判断承诺是否可靠", differences: "当前是多人合作，不能逐人直接核验",
  adaptation: "先区分个体行为与共同结果，再调整自己承担的风险" };
function experience(mind: AgentMind, source = "settlement") {
  return remember(mind, { kind: "episodic", scope: "transferable", text: "实际核验报告后拒绝交易，各得两点", sourceIds: [source], confidence: 1, tags: ["observed-feedback"], when: null, then: null });
}
function learnedMind() {
  const mind = createAgentMind("self", "source"); const source = experience(mind);
  const rule = consolidateStrategy(mind, { ...lesson, strategyId: null, memoryIds: [source.id] }, ["settlement"]);
  return { mind, source, rule };
}
function decision(id = "action", round = 1): PrivateDecision {
  return { id, episode: "target", round, action: "contribute", ...decisionMeta, strategy: "probe", intent: "none", predictionIds: [] };
}

it("distils a transferable hypothesis while preserving source experiences and excluding old local identities", () => {
  const mind = createAgentMind("self", "source"); const source = experience(mind); const saved = structuredClone(source);
  const local = remember(mind, { ...lesson, kind: "semantic", scope: "episode", sourceIds: ["role"], text: "source-local-role-canary", when: null, then: null });
  const localBefore = structuredClone(local);
  const rule = consolidateStrategy(mind, { ...lesson, strategyId: null, memoryIds: [source.id] }, ["settlement"]);
  expect(rule).toMatchObject({ kind: "procedural", scope: "transferable", consolidation: { episode: "source", sourceMemories: [{ id: source.id, revision: 1 }] } });
  expect(source).toEqual(saved); expect(local).toEqual(localBefore);
  const next = enterEpisode(mind, "self", "target");
  expect(cognitionForPrompt(next).memories.some(memory => memory.id === rule.id)).toBe(true);
  expect(JSON.stringify(cognitionForPrompt(next))).not.toContain("source-local-role-canary");
  expect(() => enterEpisode(mind, "other", "target")).toThrow("其他人物");
});

it("rejects nonexistent, duplicate, non-experience and unrelated consolidation sources without changing state", () => {
  const { mind, source, rule } = learnedMind(); const before = JSON.stringify(mind);
  for (const memoryIds of [["missing"], [source.id, source.id], [rule.id]]) {
    expect(() => consolidateStrategy(mind, { ...lesson, strategyId: null, memoryIds }, ["settlement"])).toThrow("经历记忆");
  }
  expect(() => consolidateStrategy(mind, { ...lesson, strategyId: null, memoryIds: [source.id] }, ["someone-elses-result"])).toThrow("可见的真实结算来源");
  expect(JSON.stringify(mind)).toBe(before);
});

it("derives citations only from selected records and visible settlements without a second model selector", () => {
  const mind = createAgentMind("self", "r");
  const first = experience(mind, "trade-1"); first.sourceIds.unshift("speech");
  const second = experience(mind, "trade-2"); second.sourceIds.push("trade-1", "private-outcome");
  const repair = experience(mind, "repair");
  const before = structuredClone(mind.memories);
  const proposal = { ...lesson, strategyId: null, memoryIds: [first.id, second.id] };
  expect(consolidationParameters.safeParse({ ...proposal, sourceIds: ["trade-1", "trade-2", "repair"] }).success).toBe(false);
  const rule = consolidateStrategy(mind, proposal, ["trade-1", "trade-2", "repair"]);
  expect(rule.sourceIds).toEqual(["trade-1", "trade-2"]);
  expect(rule.consolidation).toMatchObject({ sourceOutcomeIds: ["trade-1", "trade-2"],
    sourceMemories: [{ id: first.id, revision: 1 }, { id: second.id, revision: 1 }] });
  expect(rule.consolidation?.sourceMemories.some(memory => memory.id === repair.id)).toBe(false);
  expect(mind.memories.slice(0, -1)).toEqual(before);
});

it("records adoption only on a later action and obtains outcomes and prediction scores only from the new ledger", () => {
  const learned = learnedMind(); const mind = enterEpisode(learned.mind, "self", "target");
  const assessment = assessStrategy(mind, { ...judgment, id: learned.rule.id }, "op", 1);
  const prediction = forecast(mind, { sourceIds: ["new-observation"], kind: "outcome", targetId: null, eventName: "settlement", field: "payoffs.self", operator: "gte", expected: 5, probability: .7 }, 1);
  expect(strategyUsage(mind, learned.rule)).toMatchObject({ assessed: 1, adopted: 0, outcomeSamples: 0 });
  const action = decision(); action.predictionIds = [prediction.id]; bindStrategyAssessments(mind, "op", action); mind.decisions.push(action);
  expect(action.assessmentIds).toEqual([assessment.id]);
  const feedback: Experience = { id: "new-outcome", episode: "target", round: 1, seq: 2, kind: "outcome", name: "settlement", text: "实际所得2", data: { payoffs: { self: 2 } }, reward: { value: 2, normalized: .2, unit: "points" } };
  integrateExperience(mind, { ...feedback, episode: "source" }); expect(assessment.feedback).toEqual([]);
  integrateExperience(mind, feedback); integrateExperience(mind, feedback);
  expect(assessment.feedback).toEqual([{ sourceId: "new-outcome", decisionIds: [action.id], value: 2, normalized: .2, unit: "points" }]);
  expect(assessment.predictions[0]).toMatchObject({ id: prediction.id, result: false, sourceId: "new-outcome" });
  expect(assessment.predictions[0].brier).toBeCloseTo(.49);
  expect(strategyUsage(mind, learned.rule)).toMatchObject({ adopted: 1, outcomeSamples: 1, scoredPredictions: 1 });
  const replacement = { ...lesson, kind: "procedural" as const, scope: "transferable" as const, text: "共同结果不能直接归因给单个人" };
  const revised = reviseMemory(mind, { id: learned.rule.id, change: "revise", sourceIds: [feedback.id], reason: "调整原策略的归因边界", replacement });
  expect(strategyUsage(mind, revised)).toMatchObject({ assessed: 0, adopted: 0, outcomeSamples: 0 });
  expect(assessment.memory.text).toBe(lesson.text); expect(assessment.memoryRevision).toBe(1);
});

it("does not attribute actions to rejected, superseded, retired or another opportunity's strategy judgments", () => {
  const learned = learnedMind(); const mind = enterEpisode(learned.mind, "self", "target");
  const adopt = assessStrategy(mind, { ...judgment, id: learned.rule.id }, "op", 1);
  assessStrategy(mind, { ...judgment, id: learned.rule.id, verdict: "reject", adaptation: null }, "op", 1);
  const action = decision(); bindStrategyAssessments(mind, "op", action); expect(action.assessmentIds).toBeUndefined(); expect(adopt.decisionIds).toEqual([]);
  assessStrategy(mind, { ...judgment, id: learned.rule.id }, "other-op", 1);
  bindStrategyAssessments(mind, "op", action); expect(action.assessmentIds).toBeUndefined();
  reviseMemory(mind, { id: learned.rule.id, change: "retire", sourceIds: ["changed-rules"], reason: "本轮缺少检验条件", replacement: null });
  bindStrategyAssessments(mind, "other-op", action); expect(action.assessmentIds).toBeUndefined();
  expect(() => assessStrategy(mind, { ...judgment, id: learned.rule.id }, "later", 1)).toThrow("当前可用");
  expect(cognitionForPrompt(enterEpisode(mind, "self", "third")).strategyAssessments).toEqual([]);
});
it("does not count a spoken intention or a historical speech association as world-action adoption", () => {
  const learned = learnedMind(); const mind = enterEpisode(learned.mind, "self", "target");
  const assessment = assessStrategy(mind, { ...judgment, id: learned.rule.id }, "discussion", 1);
  const speech = { ...decision("speech"), action: "speak" };
  bindStrategyAssessments(mind, "discussion", speech); mind.decisions.push(speech);
  expect(speech.assessmentIds).toBeUndefined(); expect(assessment.decisionIds).toEqual([]);
  const action = decision(); bindStrategyAssessments(mind, "action", action); mind.decisions.push(action);
  expect(action.assessmentIds).toBeUndefined();
  // Old evidence stays intact, but a v4 speech association must not inflate current action statistics.
  assessment.decisionIds.push(speech.id); speech.assessmentIds = [assessment.id];
  assessment.feedback.push({ sourceId: "old-result", decisionIds: [speech.id], value: 2, normalized: .2, unit: "points" });
  expect(strategyUsage(mind, learned.rule)).toMatchObject({ assessed: 1, adopted: 0, outcomeSamples: 0 });
  integrateExperience(mind, { id: "new-result", episode: "target", round: 1, seq: 2, kind: "outcome", name: "settlement", text: "真实结果", data: {}, reward: { value: 3, normalized: .3, unit: "points" } });
  expect(assessment.feedback.map(item => item.sourceId)).toEqual(["old-result"]);
});

it("keeps a portable strategy and recent evidence available under a vocabulary shift without retrieving retired or local rules", () => {
  const { mind, rule } = learnedMind();
  const hidden = remember(mind, { ...lesson, kind: "procedural", scope: "episode", sourceIds: ["hidden"], text: "hidden-local-canary" });
  const retired = remember(mind, { ...lesson, kind: "procedural", scope: "transferable", sourceIds: ["retired"], text: "retired-rule-canary" });
  reviseMemory(mind, { id: retired.id, change: "retire", sourceIds: ["changed"], reason: "停用", replacement: null });
  const next = enterEpisode(mind, "self", "target");
  for (let i = 0; i < 24; i++) remember(next, { kind: "episodic", scope: "transferable", sourceIds: [`latest-${i}`], text: `resource distribution observation ${i}`, confidence: 1, tags: [], when: null, then: null });
  const selected = selectWorkingMemories(next, "resource distribution observations", 16);
  expect(selected).toHaveLength(16); expect(selected.some(memory => memory.id === rule.id)).toBe(true);
  expect(selected.some(memory => memory.sourceIds.includes("latest-23"))).toBe(true);
  expect(selected.some(memory => [hidden.id, retired.id].includes(memory.id))).toBe(false);
});

it("uses the native SDK consolidation receipt and commits its new memory once with the action", async () => {
  const { context, spec, activations } = generalContext(); context.cognition = createAgentMind("self", "r"); experience(context.cognition);
  context.recent.unshift({ id: "settlement", runId: "r", seq: 0, at: "", type: "fact", visibility: ["self"], text: "已公开核验的结算", data: { settlement: true, payoffs: { self: 2 } } });
  const before = JSON.stringify(context.cognition);
  const fixture = sdkFixture((request, index) => {
    expect(activations).toHaveLength(0);
    if (!index) return sdkCall("appraise_event", generalAppraisal("e2"));
    if (index === 1) {
      const offered = request.tools.find(tool => tool.type === "function" && tool.name === "consolidate_strategy");
      expect(offered).toBeDefined(); expect(offered).not.toHaveProperty("parameters.properties.sourceIds");
      return sdkCall("consolidate_strategy", { ...lesson, strategyId: null, memoryIds: ["m1"] });
    }
    expect(sdkToolResult(request)).toMatchObject({ kind: "procedural", scope: "transferable", sourceIds: ["e1"],
      consolidation: { sourceMemories: [{ id: "m1", revision: 1 }], sourceOutcomeIds: ["e1"] } });
    return sdkCall("invest", { amount: 2, ...decisionMeta });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(activations).toHaveLength(1); expect(activations[0].cognition?.memories).toHaveLength(2); expect(JSON.stringify(context.cognition)).toBe(before);
});

it("requires current-context evidence for a native applicability judgment and attaches its receipt to the action", async () => {
  const { context, spec, activations } = generalContext(); context.cognition = learnedMind().mind;
  context.lookupEvidence = id => id === "settlement" ? { id, runId: "source", seq: 0, at: "", type: "fact", visibility: "public", text: "原局实际核验", data: { settlement: true } } : undefined;
  const fixture = sdkFixture((request, index) => {
    const input = sdkInput(request); const current = input.evidence.find((event: { runId: string }) => event.runId === "r").id;
    if (!index) return sdkCall("appraise_event", generalAppraisal(current));
    if (index === 1) return sdkCall("assess_strategy", { ...judgment, id: "m2", sourceIds: [input.evidence.find((event: { runId: string }) => event.runId === "source").id] });
    if (index === 2) {
      expect(sdkToolResult(request)).toHaveProperty("error");
      expect(activations).toHaveLength(0);
      return sdkCall("assess_strategy", { ...judgment, id: "m2", sourceIds: [current] });
    }
    expect(sdkToolResult(request)).toMatchObject({ verdict: "adapt", memoryId: "m2", decisionIds: [], feedback: [] });
    return sdkCall("invest", { amount: 3, ...decisionMeta });
  });
  const c = new GeneralAgentContext(context, spec, "r");
  expect(JSON.parse(c.modelInput()).strategyLearning.availableStrategyIds).toContain("m2");
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  const committed = activations[0].cognition!;
  expect(committed.strategyAssessments![0].sourceIds).toEqual(["visible"]);
  expect(committed.strategyAssessments![0].decisionIds).toEqual([committed.decisions[0].id]);
  expect(committed.decisions[0].assessmentIds).toEqual([committed.strategyAssessments![0].id]);
});

it.each(["consolidate", "assess"])("discards staged %s state if a later provider response fails", async operation => {
  const { context, spec, activations } = generalContext(); context.cognition = learnedMind().mind; const before = JSON.stringify(context.cognition);
  context.lookupEvidence = id => id === "settlement" ? { id, runId: "source", seq: 0, at: "", type: "fact", visibility: "public", text: "原局实际核验", data: { settlement: true } } : undefined;
  const fixture = sdkFixture((_request, index) => {
    if (!index) return sdkCall("appraise_event", generalAppraisal("e2"));
    if (index === 1) return operation === "consolidate"
      ? sdkCall("consolidate_strategy", { ...lesson, strategyId: null, memoryIds: ["m1"] })
      : sdkCall("assess_strategy", { ...judgment, id: "m2", sourceIds: ["e2"] });
    throw new Error("provider failed after applicability judgment");
  });
  await expect(modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context)).rejects.toThrow("provider failed");
  expect(activations).toEqual([]); expect(JSON.stringify(context.cognition)).toBe(before);
});
