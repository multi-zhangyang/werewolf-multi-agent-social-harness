import { expect, it } from "vitest";
import { assessStrategy, createAgentMind, enterEpisode, remember, reviseMemory } from "../../src/agents/cognition";
import { GeneralAgentContext } from "../../src/runtime/agent-context";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { ModelRegistry } from "../../src/society/models/registry";
import { decisionMeta, generalAppraisal, generalContext } from "../helpers/general-agent-fixture";
import { sdkCall, sdkFixture, sdkInput, sdkToolResult } from "../helpers/sdk-fixture";

const rule = { kind: "procedural" as const, scope: "transferable" as const, text: "把承诺可信度与收益激励分开比较", when: "有利益冲突且能观察承诺后的实际选择", then: "分别检查可核验性与自己的风险", sourceIds: ["prior"], confidence: .5, tags: ["边界"] };
function carried() {
  const base = generalContext(); base.context.cognition = createAgentMind("self", "source"); remember(base.context.cognition, rule);
  base.context.lookupEvidence = id => id === "prior" ? { id, runId: "source", seq: 1, at: "", type: "fact", visibility: ["self"], text: "来源局本人观察到的结算", data: { settlement: true } } : undefined;
  return base;
}

it.each(["apply", "adapt", "reject"] as const)("requires an explicit %s verdict and its native receipt before offering a world action", async verdict => {
  const { context, spec, activations } = carried(); const before = structuredClone(context.cognition);
  const fixture = sdkFixture((request, index) => {
    const input = sdkInput(request); const names = request.tools.filter(tool => tool.type === "function").map(tool => tool.name);
    expect(input.strategyLearning.assessmentRequired).toBe(true); expect(input.strategyLearning.assessmentCandidateIds).toEqual(["m1"]);
    if (!index) { expect(names).not.toContain("invest"); return sdkCall("appraise_event", generalAppraisal(input.newEvidenceIds[0])); }
    if (index === 1) {
      expect(names).not.toContain("invest"); expect(names).toContain("assess_strategy");
      return sdkCall("assess_strategy", { id: "m1", sourceIds: [input.newEvidenceIds[0]], verdict, matching: "都需要比较承诺与激励", differences: "当前选择和可核验条件已经变化", adaptation: verdict === "adapt" ? "按当前收益规则重新限制风险" : null });
    }
    expect(sdkToolResult(request)).toMatchObject({ verdict, memoryId: "m1" }); expect(names).toContain("invest"); expect(activations).toHaveLength(0);
    const receipt = sdkToolResult(request);
    return sdkCall("invest", { amount: 2, ...decisionMeta,
      strategyBasis: verdict === "reject" ? null : { assessmentIds: [receipt.id], reason: "检验后的风险边界决定本次投入为2" } });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(activations).toHaveLength(1); expect(context.cognition).toEqual(before);
  expect(activations[0].calls).toEqual([{ name: "invest", args: { amount: 2 } }]);
  expect(activations[0].cognition?.strategyAssessments?.[0].decisionIds).toHaveLength(verdict === "reject" ? 0 : 1);
});

it("does not impose the transfer check on new memories, retired/local memories, discussion or appraisal-only work", () => {
  for (const kind of ["fresh", "retired", "local", "discussion", "appraisal-only", "off"]) {
    const { context, spec } = carried();
    if (kind === "fresh") context.cognition!.memories[0].episode = "r";
    if (kind === "retired") context.cognition!.memories[0].status = "retired";
    if (kind === "local") context.cognition!.memories[0].scope = "episode";
    if (kind === "discussion") context.opportunity.stage.kind = "discussion";
    if (kind === "appraisal-only") context.appraisalOnly = true;
    if (kind === "off") spec.experiment.psychology = "off";
    expect(new GeneralAgentContext(context, spec, "r").needsStrategyAssessment, kind).toBe(false);
  }
});

it("does not reuse an earlier opportunity's assessment or the assessment of a superseded strategy version", () => {
  const { context, spec } = carried(); context.cognition = enterEpisode(context.cognition, "self", "r");
  const memory = context.cognition.memories[0];
  const judgment = { id: memory.id, sourceIds: ["visible"], verdict: "reject" as const, matching: "部分条件相似", differences: "本次不能直接套用", adaptation: null };
  assessStrategy(context.cognition, judgment, "prior-opportunity", 1);
  const c = new GeneralAgentContext(context, spec, "r"); expect(c.needsStrategyAssessment).toBe(true);
  assessStrategy(c.mind, judgment, context.opportunity.id, 1); expect(c.needsStrategyAssessment).toBe(false);
  reviseMemory(c.mind, { id: memory.id, change: "revise", sourceIds: ["visible"], reason: "当前证据改变适用边界", replacement: { ...rule, when: "只在可核验时尝试", scope: "transferable" } });
  // A revised inherited rule remains a retrieved candidate even though its latest content was written here.
  expect(c.needsStrategyAssessment).toBe(true);
});
