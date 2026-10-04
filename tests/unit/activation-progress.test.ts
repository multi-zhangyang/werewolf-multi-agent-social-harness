import { afterEach, expect, it, vi } from "vitest";
import { createAgentMind, remember } from "../../src/agents/cognition";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { decisionMeta, generalAppraisal, generalContext } from "../helpers/general-agent-fixture";
import { nativeCall, nativeResponse, responsesFixture, sendResponse, type ResponsesRequest } from "../helpers/responses-fixture";

afterEach(() => vi.unstubAllEnvs());
const progress = (request: ResponsesRequest) => JSON.parse(request.instructions!.split("当前执行状态：").at(-1)!);
const observation = (request: ResponsesRequest) => {
  const content = request.input.find(item => item.role === "user")!.content!;
  return JSON.parse(typeof content === "string" ? content : content.map(item => item.text).join(""));
};
const sourceRule = { kind: "procedural" as const, scope: "transferable" as const, text: "核验之后承担可承受风险", sourceIds: ["prior"],
  confidence: .5, tags: [], when: "能核验对方行动", then: "按照核验结果调整风险" };

it("updates official dynamic instructions after each native tool receipt while retaining the original observation", async () => {
  const { context, spec, activations } = generalContext(); context.cognition = createAgentMind("self", "source");
  remember(context.cognition, sourceRule); const before = structuredClone(context.cognition);
  const fixture = await responsesFixture((request, response, index) => {
    const status = progress(request), data = observation(request);
    expect(status).toMatchObject({ modelTurn: index + 1, remainingModelTurns: 8 - index, completionTools: ["invest"] });
    expect(data.appraisalRequired).toBe(true); expect(data.strategyLearning.assessmentRequired).toBe(true);
    const names = request.tools.map(tool => tool.name);
    expect(request.tool_choice).toBe("required"); expect(request.parallel_tool_calls).toBe(false);
    if (index === 0) {
      expect(status).toMatchObject({ requiredTool: "appraise_event", appraisalRequired: true, completionAvailable: false });
      expect(names).not.toContain("invest"); sendResponse(response, [nativeCall("appraise_event", generalAppraisal(data.newEvidenceIds[0]), "appraise")]);
    } else if (index === 1) {
      expect(status).toMatchObject({ requiredTool: "assess_strategy", appraisalRequired: false, assessmentRequired: true, assessmentCandidateIds: ["m1"], completionAvailable: false });
      expect(names).not.toContain("invest"); expect(names).toContain("assess_strategy");
      sendResponse(response, [nativeCall("assess_strategy", { id: "m1", sourceIds: [data.newEvidenceIds[0]], verdict: "reject", matching: "同样需要核验", differences: "原收益结构不同", adaptation: null }, "assess")]);
    } else {
      expect(index).toBe(2); expect(status).toMatchObject({ requiredTool: null, appraisalRequired: false, assessmentRequired: false, assessmentCandidateIds: [], completionAvailable: true });
      expect(names).toContain("invest"); sendResponse(response, [nativeCall("invest", { amount: 2, ...decisionMeta, strategyBasis: null }, "action")]);
    }
  });
  try {
    vi.stubEnv("RESPONSES_TEST_KEY", "local-test-credential-canary");
    await modelParticipantFactory(fixture.registry)(context.character, spec, "r").turn(context);
    expect(fixture.requests).toHaveLength(3); expect(fixture.errors).toEqual([]); expect(activations).toHaveLength(1);
    expect(context.cognition).toEqual(before); expect(activations[0].calls).toEqual([{ name: "invest", args: { amount: 2 } }]);
    expect(activations[0].cognition!.strategyAssessments![0].verdict).toBe("reject");
  } finally { await fixture.close(); }
});

it.each(["revise", "retire"] as const)("updates progress after an assessed rule is %s in a buffered SDK run", async change => {
  const { context, spec, activations } = generalContext(); context.cognition = createAgentMind("self", "source");
  remember(context.cognition, sourceRule);
  const fixture = await responsesFixture((request, response, index) => {
    const data = observation(request), status = progress(request);
    const assess = (id: string) => nativeCall("assess_strategy", { id: "m1", sourceIds: [data.newEvidenceIds[0]], verdict: "apply", matching: "可以核验行动", differences: "当前收益不同", adaptation: null }, id);
    let call;
    if (index === 0) call = nativeCall("appraise_event", generalAppraisal(data.newEvidenceIds[0]), "appraise");
    else if (index === 1) call = assess("old-version");
    else if (index === 2) {
      expect(status.assessmentRequired).toBe(false);
      call = nativeCall("revise_memory", { id: "m1", sourceIds: [data.newEvidenceIds[0]], change, reason: "依据当前条件修正适用范围",
        replacement: change === "retire" ? null : { kind: "procedural", scope: "transferable", text: "修订后的核验原则", when: "当前行动可以核验", then: "核验并调整风险", confidence: .4, tags: [] } }, "mutation");
    } else if (index === 3 && change === "revise") {
      expect(status).toMatchObject({ requiredTool: "assess_strategy", assessmentRequired: true, assessmentCandidateIds: ["m1"], completionAvailable: false });
      expect(request.tools.some(tool => tool.name === "invest")).toBe(false); call = assess("new-version");
    } else {
      expect(index).toBe(change === "revise" ? 4 : 3);
      expect(status).toMatchObject({ requiredTool: null, assessmentRequired: false, completionAvailable: true });
      call = nativeCall("invest", { amount: 2, ...decisionMeta,
        strategyBasis: change === "revise" ? { assessmentIds: status.usableAssessmentIds, reason: "使用修订后的核验原则限制投入" } : null }, "action");
    }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(nativeResponse([call])));
  });
  try {
    vi.stubEnv("RESPONSES_TEST_KEY", "local-test-credential-canary");
    await modelParticipantFactory(fixture.registry, { streamOutput: false })(context.character, spec, "r").turn(context);
    expect(fixture.errors).toEqual([]); expect(activations).toHaveLength(1);
    const assessments = activations[0].cognition!.strategyAssessments!;
    if (change === "revise") expect(assessments.map(item => [item.memoryRevision, item.decisionIds.length])).toEqual([[1, 0], [2, 1]]);
    else expect(assessments[0].decisionIds).toEqual([]);
  } finally { await fixture.close(); }
});
