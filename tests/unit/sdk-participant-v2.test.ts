import { expect, it } from "vitest";
import { ModelRegistry } from "../../src/society/models/registry";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { createAgentMind } from "../../src/agents/cognition";
import { generalContext, decisionMeta, generalAppraisal } from "../helpers/general-agent-fixture";
import { sdkCall, sdkFixture, sdkInput, sdkToolResult } from "../helpers/sdk-fixture";

it("uses canonical SDK tool feedback before one atomic environment commit", async () => {
  const { context, spec, activations } = generalContext();
  const fixture = sdkFixture((request, index) => {
    expect(activations).toHaveLength(0);
    if (!index) return sdkCall("appraise_event", generalAppraisal("e1"));
    expect(sdkToolResult(request).emotions.anxiety).toBeCloseTo(.38);
    return sdkCall("invest", { amount: 4, ...decisionMeta, strategyBasis: null });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(activations).toHaveLength(1); expect(activations[0].calls).toEqual([{ name: "invest", args: { amount: 4 } }]);
  expect(activations[0].cognition?.decisions[0].privateAim).toBe(decisionMeta.privateAim);
  expect(fixture.requests[1].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: "function_call_result" })]));
});
it("corrects numeric validation errors in the same SDK loop and never calls the old mutation handler", async () => {
  const { context, spec, activations } = generalContext("off");
  const fixture = sdkFixture((request, index) => {
    if (index) expect(sdkToolResult(request).error).toBeTruthy();
    return sdkCall("invest", { amount: index ? 2 : "2", ...decisionMeta, strategyBasis: null });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(fixture.requests).toHaveLength(2); expect(activations).toHaveLength(1); expect(activations[0].cognition).toBeUndefined();
});
it("keeps foreign private events, foreign memories and disabled psychology out of model input", async () => {
  const { context, spec } = generalContext("off");
  context.recent.push({ id: "foreign", seq: 2, runId: "r", type: "fact", at: "", visibility: ["peer"], text: "foreign-event-canary", data: {} });
  context.memories.push({ id: "foreign-memory", characterId: "peer", runId: "r", kind: "note", text: "foreign-memory-canary", sourceIds: [], about: [], at: "" });
  context.cognition = createAgentMind("self", "r"); context.cognition.relationships.peer = { targetId: "peer", sourceIds: ["visible"], willingness: .9, competence: .5, hypothesis: "disabled-mind-canary", alternative: "other", confidence: .7, scope: "relationship", episode: "r", updates: 1 };
  const fixture = sdkFixture(request => {
    for (const text of ["foreign-event-canary", "foreign-memory-canary", "disabled-mind-canary"]) expect(JSON.stringify(request)).not.toContain(text);
    expect(sdkInput(request).cognition).toBeUndefined(); return sdkCall("invest", { amount: 2, ...decisionMeta, strategyBasis: null });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
});
it("records unavailable tools and accepts a corrected native action", async () => {
  const { context, spec, activations } = generalContext("off"); const errors: string[] = [];
  context.recordToolError = name => errors.push(name);
  const fixture = sdkFixture((_request, index) => sdkCall(index ? "invest" : "expired_action", index ? { amount: 2, ...decisionMeta, strategyBasis: null } : {}));
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(errors).toContain("expired_action"); expect(activations).toHaveLength(1);
});
it("refuses to run a legacy environment without the atomic commit capability", async () => {
  const { context, spec } = generalContext("off"); delete context.commitActivation;
  const fixture = sdkFixture(() => sdkCall("invest", { amount: 2, ...decisionMeta, strategyBasis: null }));
  await expect(modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context)).rejects.toThrow("原子激活提交");
});
it("resolves exact short evidence references, returns usable errors and stores immutable original IDs", async () => {
  const { context, spec, activations } = generalContext(); const errors: string[] = [];
  const originalId = "a50a95ff-b04a-457d-bee0-e57084d9f29a"; context.recent[0].id = originalId;
  context.recordToolError = (_name, message) => errors.push(message);
  const fixture = sdkFixture((request, index) => {
    expect(sdkInput(request).newEvidenceIds).toEqual(["e1"]);
    if (!index) return sdkCall("appraise_event", generalAppraisal("e99"));
    if (index === 1) {
      expect(sdkToolResult(request).error).toBeTruthy(); expect(sdkToolResult(request).allowedEvidenceIds).toEqual(["e1"]);
      return sdkCall("appraise_event", { ...generalAppraisal("e1"), responsibility: "other" });
    }
    expect(sdkToolResult(request).freshSourceIds).toEqual(["e1"]);
    return sdkCall("invest", { amount: 2, ...decisionMeta, strategyBasis: null });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(errors).toHaveLength(1); expect(activations).toHaveLength(1);
  expect(activations[0].cognition?.appraisal).toMatchObject({ sourceIds: [originalId], responsibility: "other" });
  expect(activations[0].cognition?.appraised).toEqual([originalId]);
});
it("uses the SDK schema to reject person names in the responsibility enum before any state mutation", async () => {
  const { context, spec, activations } = generalContext(); const errors: string[] = [];
  context.recordToolError = (_name, message) => errors.push(message);
  const fixture = sdkFixture((request, index) => {
    if (!index) return sdkCall("appraise_event", { ...generalAppraisal("e1"), responsibility: "人物2" });
    if (index === 1) {
      expect(sdkToolResult(request).error).toBeTruthy();
      return sdkCall("appraise_event", { ...generalAppraisal("e1"), responsibility: "shared" });
    }
    return sdkCall("invest", { amount: 2, ...decisionMeta, strategyBasis: null });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(errors).toHaveLength(1);
  expect(activations[0].cognition?.appraisal?.responsibility).toBe("shared");
  expect(activations[0].cognition?.emotions.anxiety).toBeCloseTo(.38);
});
it("declares only currently permitted communication channels and recipients in the native tool schema", async () => {
  const { context, spec } = generalContext("off");
  context.opportunity.stage = { ...context.opportunity.stage, kind: "discussion" }; context.opportunity.actions = [];
  context.opportunity.communications = [{ channel: "private", recipients: ["peer"] }];
  const fixture = sdkFixture(request => {
    const schema = request.tools.find(tool => tool.type === "function" && tool.name === "send_message") as any;
    expect(schema.parameters.properties.channel.enum).toEqual(["private"]);
    expect(schema.parameters.properties.recipients.items.enum).toEqual(["peer"]);
    return sdkCall("speak", { text: "当前公开对话", ...decisionMeta });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
});
