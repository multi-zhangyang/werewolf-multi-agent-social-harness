import { expect, it } from "vitest";
import { consolidateStrategy, createAgentMind, enterEpisode, integrateExperience, memoryOriginEpisode, remember, reviseMemory,
  strategyUsage, type AgentMind } from "../../src/agents/cognition";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { ModelRegistry } from "../../src/society/models/registry";
import { decisionMeta, generalAppraisal, generalContext } from "../helpers/general-agent-fixture";
import { sdkCall, sdkFixture, sdkInput, sdkToolResult } from "../helpers/sdk-fixture";

const lesson = { text: "逐步核验后再增加风险", when: "能够观察个人行为且损失可承担", then: "用可核验结果调整风险", confidence: .5, tags: ["核验"], rationale: "当前证据只支持有条件的尝试" };
function outcome(mind: AgentMind, id: string) {
  integrateExperience(mind, { id, episode: mind.episode, seq: 2, round: 1, kind: "outcome", name: "settlement", text: "本人获得两点",
    data: { payoffs: { self: 2 } }, reward: { value: 2, normalized: .2, unit: "points" } });
  return mind.memories.find(memory => memory.observation?.sourceId === id)!;
}
function learned() {
  const mind = createAgentMind("self", "source"); const experience = outcome(mind, "prior");
  const rule = consolidateStrategy(mind, { ...lesson, strategyId: null, memoryIds: [experience.id] }, ["prior"]);
  return { mind, experience, rule };
}

it("updates the selected strategy's stable ID and provenance without changing either experience or its prior version", () => {
  const old = learned(); const mind = enterEpisode(old.mind, "self", "target"); const current = outcome(mind, "current");
  const episodesBefore = structuredClone(mind.memories.filter(memory => memory.kind === "episodic"));
  const revisionBefore = mind.revision;
  const updated = consolidateStrategy(mind, { ...lesson, strategyId: old.rule.id, memoryIds: [old.experience.id, current.id],
    text: "多人共同结果不能直接当成个人可信度", when: "有个体行为可核验；只有共同收益时不能归因于单个人", confidence: .4 }, ["prior", "current"]);
  expect(updated).toMatchObject({ id: old.rule.id, revision: 2, episode: "target", confidence: .4,
    consolidation: { episode: "target", sourceOutcomeIds: ["prior", "current"] } });
  expect(updated.revisions).toHaveLength(1); expect(updated.revisions![0].previous).toEqual(old.rule);
  expect(memoryOriginEpisode(updated)).toBe("source"); expect(mind.revision).toBe(revisionBefore + 1);
  expect(mind.memories.filter(memory => memory.kind === "procedural")).toHaveLength(1);
  expect(mind.memories.filter(memory => memory.kind === "episodic")).toEqual(episodesBefore);
  const next = enterEpisode(mind, "self", "third");
  const revisedAgain = reviseMemory(next, { id: updated.id, change: "revise", sourceIds: ["third-evidence"], reason: "新情境无法观察个人行为",
    replacement: { kind: "procedural", scope: "transferable", text: "无法直接核验时控制暴露", when: "个体行为不可见", then: "限制损失", confidence: .3, tags: [] } });
  expect(memoryOriginEpisode(revisedAgain)).toBe("source"); expect(revisedAgain.revisions).toHaveLength(2);
  expect(revisedAgain.consolidation).toBeUndefined();
  expect(revisedAgain.revisions![1].previous.consolidation).toEqual(updated.consolidation);
});

it("rejects nonexistent, episodic, local, semantic and retired targets before mutating memory", () => {
  const { mind, experience, rule } = learned();
  const local = remember(mind, { kind: "procedural", scope: "episode", sourceIds: ["prior"], text: "本局限定", when: "本局", then: "只在本局使用", confidence: .4, tags: [] });
  const semantic = remember(mind, { kind: "semantic", scope: "transferable", sourceIds: ["prior"], text: "待检验命题", when: null, then: null, confidence: .4, tags: [] });
  reviseMemory(mind, { id: rule.id, change: "retire", sourceIds: ["prior"], reason: "不再适用", replacement: null });
  const before = structuredClone(mind);
  for (const strategyId of ["missing", experience.id, local.id, semantic.id, rule.id]) {
    expect(() => consolidateStrategy(mind, { ...lesson, strategyId, memoryIds: [experience.id] }, ["prior"])).toThrow("当前有效的可迁移条件策略");
    expect(mind).toEqual(before);
  }
});

it.each([false, true])("uses a native revision receipt and rechecks the new version, with atomic rollback on failure=%s", async fail => {
  const { context, spec, activations } = generalContext(); const old = learned();
  context.cognition = enterEpisode(old.mind, "self", "r"); outcome(context.cognition, "current");
  context.lookupEvidence = id => id === "prior" ? { id, runId: "source", seq: 2, at: "", type: "fact", visibility: ["self"], text: "本人可见的原局结算", data: { settlement: true } } : undefined;
  context.recent.push({ id: "current", runId: "r", seq: 2, at: "", type: "fact", visibility: ["self"], text: "本局结算", data: { settlement: true, payoffs: { self: 2 } } });
  const before = structuredClone(context.cognition);
  const judgment = { id: "m2", verdict: "apply", matching: "仍能核验", differences: "收益规则不同", adaptation: null };
  const fixture = sdkFixture((request, index) => {
    const input = sdkInput(request); const currentRef = input.evidence.find((event: { runId: string; seq: number }) => event.runId === "r" && event.seq === 2).id;
    const names = request.tools.filter(tool => tool.type === "function").map(tool => tool.name);
    expect(activations).toHaveLength(0); expect(context.cognition).toEqual(before);
    if (!index) {
      expect(input.strategyLearning.existingStrategies).toMatchObject([{ id: "m2", originEpisode: "source", revision: 1 }]);
      return sdkCall("appraise_event", generalAppraisal(currentRef));
    }
    if (index === 1) return sdkCall("assess_strategy", { ...judgment, sourceIds: [currentRef] });
    if (index === 2) {
      const offered = request.tools.find(tool => tool.type === "function" && tool.name === "consolidate_strategy")!;
      if (offered.type !== "function") throw new Error("Expected a native tool");
      expect(offered.parameters.required).toContain("strategyId");
      return sdkCall("consolidate_strategy", { ...lesson, strategyId: "m2", memoryIds: ["m3"], when: "个人行为可核验且当前收益规则仍支持小步尝试" });
    }
    if (index === 3) {
      expect(sdkToolResult(request)).toMatchObject({ id: "m2", revision: 2, sourceIds: [currentRef], consolidation: { episode: "r", sourceOutcomeIds: [currentRef] } });
      expect(sdkToolResult(request)).not.toHaveProperty("revisions"); expect(names).not.toContain("invest");
      if (fail) throw new Error("provider failed after strategy revision");
      return sdkCall("assess_strategy", { ...judgment, sourceIds: [currentRef] });
    }
    expect(sdkToolResult(request)).toMatchObject({ memoryId: "m2", memoryRevision: 2, memoryEpisode: "r", memoryOriginEpisode: "source" });
    return sdkCall("invest", { amount: 2, ...decisionMeta });
  });
  const run = modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  if (fail) { await expect(run).rejects.toThrow("provider failed after strategy revision"); expect(activations).toEqual([]); }
  else {
    await run; expect(activations).toHaveLength(1); const saved = activations[0].cognition!;
    const current = saved.memories.find(memory => memory.id === old.rule.id)!;
    expect(current.revisions![0].previous).toEqual(old.rule);
    expect(saved.strategyAssessments!.map(item => [item.memoryRevision, item.decisionIds.length])).toEqual([[1, 0], [2, 1]]);
    expect(strategyUsage(saved, current)).toMatchObject({ assessed: 1, adopted: 1, outcomeSamples: 0 });
    integrateExperience(saved, { id: "action-result", episode: "r", seq: 3, round: 1, kind: "outcome", name: "settlement", text: "正式行动结果", data: { payoffs: { self: 3 } }, reward: { value: 3, normalized: .3, unit: "points" } });
    expect(saved.strategyAssessments![0].feedback).toEqual([]);
    expect(saved.strategyAssessments![1].feedback).toMatchObject([{ sourceId: "action-result", value: 3 }]);
    expect(strategyUsage(saved, current)).toMatchObject({ outcomeSamples: 1 });
  }
  expect(context.cognition).toEqual(before);
});
