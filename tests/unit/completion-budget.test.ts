import { expect, it } from "vitest";
import { createAgentMind, remember } from "../../src/agents/cognition";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { ModelRegistry } from "../../src/society/models/registry";
import { decisionMeta, generalAppraisal, generalContext } from "../helpers/general-agent-fixture";
import { sdkCall, sdkFixture, sdkInput, sdkToolResult } from "../helpers/sdk-fixture";

it.each(["action", "plan", "discussion", "review", "record", "off"] as const)("reserves completion turns when optional tools keep being selected: %s", async mode => {
  const { context, spec, activations } = generalContext(mode === "off" ? "off" : "hybrid");
  if (mode === "action" || mode === "plan") {
    context.cognition = createAgentMind("self", "source");
    remember(context.cognition, { kind: "procedural", scope: "transferable", text: "根据核验调整风险", sourceIds: ["prior"], tags: [], confidence: .5, when: "可核验", then: "核对行为" });
    const current = remember(context.cognition, { kind: "procedural", scope: "transferable", text: "本局新规则", sourceIds: ["visible"], tags: [], confidence: .5, when: "当前条件", then: "按当前规则行动" });
    current.episode = "r";
  }
  if (["discussion", "review", "record"].includes(mode)) {
    context.opportunity.stage.kind = "discussion"; context.opportunity.actions = [];
  }
  if (["review", "record"].includes(mode)) context.appraisalOnly = true;
  if (mode === "review") { context.episodeReview = true; context.recent[0].data.settlement = true; }
  const chosen: string[] = [];
  const fixture = sdkFixture(request => {
    const data = sdkInput(request);
    const names = request.tools.filter(tool => tool.type === "function").map(tool => tool.name);
    if (mode === "plan" && names.includes("set_plan")) {
      const id = chosen.includes("set_plan") ? "p1" : null; chosen.push("set_plan");
      return sdkCall("set_plan", { id, sourceIds: [data.newEvidenceIds[0]], goal: "继续检查计划", strategy: "probe", steps: ["核对现有依据"], when: "当前机会", reviseWhen: "有新证据", stopWhen: "行动完成", portable: false });
    }
    if (names.includes("recall")) { chosen.push("recall"); return sdkCall("recall", { query: "继续检查已有计划" }); }
    if (names.includes("appraise_event")) { expect(names).toEqual(["appraise_event"]); chosen.push("appraise_event"); return sdkCall("appraise_event", generalAppraisal(data.newEvidenceIds[0])); }
    if (names.includes("assess_strategy")) {
      expect(names).toEqual(["assess_strategy"]);
      const tool = request.tools.find(tool => tool.type === "function" && tool.name === "assess_strategy")!;
      if (tool.type !== "function") throw new Error("Expected a native function tool");
      expect(JSON.stringify(tool.parameters)).not.toContain('"m2"');
      chosen.push("assess_strategy"); return sdkCall("assess_strategy", { id: "m1", sourceIds: [data.newEvidenceIds[0]], verdict: "reject", matching: "都有风险", differences: "本局条件不同", adaptation: null });
    }
    if (mode === "action" || mode === "plan") expect(sdkToolResult(request)).toMatchObject({ verdict: "reject" });
    const ending = names.includes("invest") ? "invest" : names.includes("speak") ? "speak" : names[0]; chosen.push(ending);
    if (ending === "invest") return sdkCall(ending, { amount: 2, ...decisionMeta });
    if (ending === "speak") return sdkCall(ending, { text: "依据现有证据行动", ...decisionMeta });
    if (ending === "finish_record") return sdkCall(ending, {});
    return sdkCall("finish_episode_review", { sourceIds: [data.episodeReview.outcomes[0].id], strategyIds: [], summary: "证据不足，不编造策略" });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(chosen).toHaveLength(8); expect(activations).toHaveLength(1);
  if (mode === "action" || mode === "plan") expect(chosen.slice(-3)).toEqual(["appraise_event", "assess_strategy", "invest"]);
  if (mode === "off") expect(chosen.at(-1)).toBe("invest");
});

it.each([
  ["consolidate_strategy", 5], ["revise_memory", 5], ["consolidate_strategy", 6], ["revise_memory", 6],
] as const)("reserves a fresh assessment after %s at index %s within eight SDK turns", async (mutation, mutationIndex) => {
  const { context, spec, activations } = generalContext(); context.cognition = createAgentMind("self", "source");
  const replacement = { kind: "procedural" as const, scope: "transferable" as const, text: "更新核验条件", when: "存在可观察个人行为", then: "核验后控制风险", confidence: .4, tags: [] };
  remember(context.cognition, { ...replacement, sourceIds: ["prior"] });
  remember(context.cognition, { kind: "episodic", scope: "transferable", text: "本人看到实际结果", sourceIds: ["visible"], confidence: 1, tags: [], when: null, then: null });
  context.recent[0].data.settlement = true;
  const before = structuredClone(context.cognition); const chosen: string[] = [];
  const fixture = sdkFixture((request, index) => {
    const data = sdkInput(request); const sourceIds = [data.newEvidenceIds[0]];
    const names = request.tools.filter(tool => tool.type === "function").map(tool => tool.name);
    const call = (name: string, args: unknown) => { chosen.push(name); return sdkCall(name, args); };
    const assess = () => call("assess_strategy", { id: "m1", sourceIds, verdict: "apply", matching: "可以核验", differences: "当前规则不同", adaptation: null });
    if (!index) return call("appraise_event", generalAppraisal(sourceIds[0]));
    if (index === 1) return assess();
    if (index < mutationIndex) return call("recall", { query: "核验条件" });
    if (index === mutationIndex) {
      if (mutationIndex === 6) {
        expect(names).not.toContain("consolidate_strategy"); expect(names).not.toContain("revise_memory");
        return call("recall", { query: "剩余一步将提交行动" });
      }
      expect(names).toContain(mutation);
      return mutation === "consolidate_strategy"
        ? call(mutation, { strategyId: "m1", memoryIds: ["m2"], text: replacement.text, when: replacement.when, then: replacement.then, confidence: .4, tags: [], rationale: "补充当前可观察性边界" })
        : call(mutation, { id: "m1", change: "revise", sourceIds, reason: "补充当前可观察性边界", replacement });
    }
    if (index === 6) {
      expect(names).toEqual(["assess_strategy"]); expect(sdkToolResult(request)).toMatchObject({ id: "m1", revision: 2 });
      return assess();
    }
    expect(names).toEqual(["invest"]);
    return call("invest", { amount: 2, ...decisionMeta });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(chosen).toHaveLength(8); expect(activations).toHaveLength(1); expect(context.cognition).toEqual(before);
  const saved = activations[0].cognition!;
  if (mutationIndex === 5) {
    expect(chosen.slice(-3)).toEqual([mutation, "assess_strategy", "invest"]);
    expect(saved.strategyAssessments!.map(item => [item.memoryRevision, item.decisionIds.length])).toEqual([[1, 0], [2, 1]]);
  } else {
    expect(saved.memories[0].revision).toBeUndefined();
    expect(saved.strategyAssessments!.map(item => [item.memoryRevision, item.decisionIds.length])).toEqual([[1, 1]]);
  }
});
