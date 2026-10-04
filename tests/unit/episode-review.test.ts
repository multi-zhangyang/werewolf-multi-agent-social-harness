import { afterEach, expect, it, vi } from "vitest";
import { activeMemories, cognitionForPrompt, completeEpisodeReview, createAgentMind, enterEpisode, remember, reviseMemory } from "../../src/agents/cognition";
import { generalAppraisal, generalContext } from "../helpers/general-agent-fixture";
import { sdkCall, sdkFixture, sdkInput, sdkToolResult } from "../helpers/sdk-fixture";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { ModelRegistry } from "../../src/society/models/registry";
import { nativeCall, responsesFixture, sendResponse } from "../helpers/responses-fixture";

afterEach(() => vi.unstubAllEnvs());

const lesson = { text: "通过可核验结果调整承诺可信度", when: "有重复互动和可观察结果，且损失在可承担范围内", then: "比较承诺与兑现后再调整风险", confidence: .5, tags: ["核验"], rationale: "可观察性可能复用，但本局金额和角色不可照搬" };
const review = { status: "ready" as const, sourceIds: ["settlement"], summary: "review-private-canary：只将观察关联当成待检验假设" };
function contextForReview() {
  const base = generalContext(); const { context } = base;
  context.appraisalOnly = true; context.episodeReview = true;
  context.opportunity = { ...context.opportunity, actions: [], communications: [], stage: { ...context.opportunity.stage, id: "episode-review", kind: "discussion", actors: ["self"], channel: "private" } };
  context.cognition = createAgentMind("self", "r");
  remember(context.cognition, { kind: "episodic", scope: "transferable", text: "结算后本人得两点", sourceIds: ["settlement"], confidence: 1, tags: ["observed-feedback"], when: null, then: null });
  context.recent.unshift({ id: "settlement", runId: "r", seq: 0, at: "", type: "fact", visibility: ["self"], text: "本人可见的实际结算", data: { settlement: true, payoffs: { self: 2 } } });
  return base;
}

it("requires valid portable hypotheses for ready and preserves an honest insufficient review", () => {
  const mind = createAgentMind("self", "r");
  const local = remember(mind, { ...lesson, kind: "procedural", scope: "episode", sourceIds: ["settlement"] });
  const portable = remember(mind, { ...lesson, kind: "procedural", scope: "transferable", sourceIds: ["settlement"] });
  const before = structuredClone(mind);
  for (const strategyIds of [[], [local.id], ["absent"], [portable.id, portable.id]]) expect(() => completeEpisodeReview(mind, { ...review, strategyIds }, "op")).toThrow();
  expect(mind).toEqual(before);
  reviseMemory(mind, { id: portable.id, change: "retire", sourceIds: ["settlement"], reason: "缺少支持", replacement: null });
  expect(() => completeEpisodeReview(mind, { ...review, strategyIds: [portable.id] }, "op")).toThrow("当前有效");
  const saved = completeEpisodeReview(mind, { ...review, status: "insufficient", strategyIds: [] }, "op");
  expect(saved).toMatchObject({ status: "insufficient", strategies: [], episode: "r", opportunityId: "op" });
  expect(() => completeEpisodeReview(mind, { ...review, status: "insufficient", strategyIds: [] }, "op")).toThrow("已经完成");
  expect(mind.learning.episodes).toEqual([]);
  const next = enterEpisode(mind, "self", "next");
  expect(next.episodeReviews).toHaveLength(1);
  expect(JSON.stringify(cognitionForPrompt(next))).not.toContain("review-private-canary");
});

it("resolves a strategy created during the same native activation and commits only after its receipt", async () => {
  const { context, spec, activations } = contextForReview(); const before = structuredClone(context.cognition);
  const fixture = sdkFixture((request, index) => {
    const input = sdkInput(request); const names = request.tools.filter(tool => tool.type === "function").map(tool => tool.name);
    expect(names.some(name => ["speak", "wait", "send_message", "invest", "finish_record", "forecast"].includes(name))).toBe(false);
    expect(activations).toHaveLength(0);
    if (!index) return sdkCall("appraise_event", generalAppraisal(input.newEvidenceIds.at(-1)));
    if (index === 1) return sdkCall("consolidate_strategy", { ...lesson, strategyId: null, memoryIds: ["m1"] });
    expect(sdkToolResult(request)).toMatchObject({ id: "m2", scope: "transferable", kind: "procedural" });
    return sdkCall("finish_episode_review", { summary: review.summary, sourceIds: [input.episodeReview.outcomes[0].id], strategyIds: ["m2"] });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(activations).toHaveLength(1); expect(activations[0]).toMatchObject({ calls: [], waited: true }); expect(activations[0].text).toBeUndefined();
  const saved = activations[0].cognition!; const rule = activeMemories(saved).find(memory => memory.kind === "procedural")!;
  expect(saved.episodeReviews).toHaveLength(1);
  expect(saved.episodeReviews).toMatchObject([{ ...review, episode: "r", opportunityId: "op", strategies: [{ id: rule.id, revision: 1 }] }]);
  expect(context.cognition).toEqual(before);
});

it("discards staged consolidation and review on a later provider failure", async () => {
  const { context, spec, activations } = contextForReview(); const before = structuredClone(context.cognition);
  const fixture = sdkFixture((request, index) => {
    const input = sdkInput(request);
    if (!index) return sdkCall("appraise_event", generalAppraisal(input.newEvidenceIds.at(-1)));
    if (index === 1) return sdkCall("consolidate_strategy", { ...lesson, strategyId: null, memoryIds: ["m1"] });
    throw new Error("provider failed before review completed");
  });
  await expect(modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context)).rejects.toThrow("provider failed before review");
  expect(activations).toEqual([]); expect(context.cognition).toEqual(before);
});

it.each([false, true])("derives native review status from the single strategy selection (selected=%s)", async selected => {
  const { context, spec, activations } = contextForReview();
  if (selected) remember(context.cognition!, { kind: "procedural", scope: "transferable", sourceIds: ["settlement"],
    text: lesson.text, when: lesson.when, then: lesson.then, confidence: lesson.confidence, tags: lesson.tags });
  const before = structuredClone(context.cognition), toolErrors: string[] = [];
  context.recordToolError = (_name, message) => toolErrors.push(message);
  const fixture = await responsesFixture((request, response, index) => {
    const content = request.input.find(item => item.role === "user")!.content!;
    const input = JSON.parse(typeof content === "string" ? content : content.map(item => item.text).join(""));
    if (!index) { sendResponse(response, [nativeCall("appraise_event", generalAppraisal(input.newEvidenceIds.at(-1)), "appraise")]); return; }
    expect(index).toBe(1);
    const definition = request.tools.find(tool => tool.name === "finish_episode_review")!;
    expect(definition.strict).toBe(true); expect(definition.parameters.properties).not.toHaveProperty("status");
    expect(definition.parameters.required).not.toContain("status");
    sendResponse(response, [nativeCall("finish_episode_review", { sourceIds: [input.episodeReview.outcomes[0].id],
      strategyIds: selected ? ["m2"] : [], summary: selected ? "已有有边界的假设供后续检验" : "现有证据不足以形成策略" }, "review")]);
  });
  try {
    vi.stubEnv("RESPONSES_TEST_KEY", "local-test-credential-canary");
    await modelParticipantFactory(fixture.registry)(context.character, spec, "r").turn(context);
    expect(fixture.requests).toHaveLength(2); expect(fixture.errors).toEqual([]); expect(toolErrors).toEqual([]);
    expect(activations).toHaveLength(1); expect(context.cognition).toEqual(before);
    expect(activations[0].cognition!.episodeReviews![0]).toMatchObject({ status: selected ? "ready" : "insufficient" });
    expect(activations[0].cognition!.episodeReviews![0].strategies).toHaveLength(selected ? 1 : 0);
  } finally { await fixture.close(); }
});
