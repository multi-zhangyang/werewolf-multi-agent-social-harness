import { expect, it } from "vitest";
import { ModelRegistry } from "../../src/society/models/registry";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { createAgentMind } from "../../src/agents/cognition";
import { generalContext, generalAppraisal, decisionMeta } from "../helpers/general-agent-fixture";
import { sdkCall, sdkFixture, sdkInput, sdkToolResult } from "../helpers/sdk-fixture";
it("honors an injected initial state and returns the inertia-adjusted canonical state to the SDK", async () => {
  const { context, spec, activations } = generalContext();
  context.cognition = createAgentMind("self", "r"); context.cognition.emotions.anxiety = .9;
  const fixture = sdkFixture((request, index) => {
    if (!index) { expect(sdkInput(request).cognition.emotions.anxiety).toBe(.9); return sdkCall("appraise_event", { ...generalAppraisal("e1"), emotions: [{ emotion: "anxiety", intensity: .1 }] }); }
    expect(sdkToolResult(request).emotions.anxiety).toBeCloseTo(.58); return sdkCall("invest", { amount: 2, ...decisionMeta });
  });
  await modelParticipantFactory(new ModelRegistry(), { model: fixture.model })(context.character, spec, "r").turn(context);
  expect(context.cognition.emotions.anxiety).toBe(.9); expect(activations[0].cognition?.emotions.anxiety).toBeCloseTo(.58);
});
