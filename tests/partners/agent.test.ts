import { afterEach, describe, expect, it, vi } from "vitest";
import { createSdkParticipant, PartnerDecisionError } from "../../src/partners/agent";
import { createMind } from "../../src/partners/mind";
import { ModelRegistry } from "../../src/society/models/registry";
import { applyAction, createWorld } from "../../src/partners/world";
import { appraisal, plan, sdkCall, sdkFixture, sdkInput, sdkToolResult } from "../helpers/sdk-fixture";
afterEach(() => vi.unstubAllEnvs());
const fresh = () => createWorld({ maxRounds: 3, actors: {
  a: { name: "甲", kind: "ai", productivity: 3, privateObjective: "peer-private-goal-canary", initialWallet: 73 },
  b: { name: "乙", kind: "ai", productivity: 3, privateObjective: "自己的收益与合作目标" },
} }, "partners-sdk-test");
function betrayal() {
  let world = applyAction(fresh(), "b", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "offer");
  world = applyAction(world, "a", { type: "invest", amount: 6 }, "invest");
  world = applyAction(world, "b", { type: "settle", returnAmount: 0, claimedIncome: 6 }, "settle");
  return applyAction(world, "b", { type: "repair", compensation: 0 }, "repair");
}
const offer = (extra: Record<string, unknown> = {}) => sdkCall("offer", { promiseRatio: 0.5, collateral: 2, message: null, intent: null, basis: "one-off", ...extra });
describe("Partners adapter on the shared native Responses executor", () => {
  it("stages an ordinary native action and records the actual SDK loop without changing the world", async () => {
    const world = fresh(); const before = structuredClone(world);
    const { model, requests } = sdkFixture(() => offer({ message: "先放两点担保。" }));
    const result = await createSdkParticipant(new ModelRegistry(), { model }).decide({ world, actorId: "b" });
    expect(result.action).toMatchObject({ type: "offer", collateral: 2 }); expect(world).toEqual(before);
    expect(requests).toHaveLength(1); expect(result.decisionCase).toMatchObject({ status: "completed", inputTokens: 10, outputTokens: 5, failures: 0, retries: 0 });
    expect(result.decisionCase.activities.map(item => item.kind)).toEqual(expect.arrayContaining(["agent_start", "model_start", "model_end", "tool_start", "tool_end", "agent_end"]));
    expect(result.sessionItems.some(item => item.type === "function_call" && item.name === "offer")).toBe(true);
  });
  it("reads canonical appraisal, plan and forecast receipts before acting", async () => {
    const world = betrayal(); const original = structuredClone(world);
    const { model, requests } = sdkFixture((request, index) => {
      const data = sdkInput(request); const eventId = data.appraisalRequired.event.id;
      expect(eventId).toMatch(/^e\d+$/);
      if (index === 0) return sdkCall("appraise_event", appraisal(eventId, { emotions: { anger: 0.8, anxiety: 0.4, guilt: 0, hope: 0.3 }, memory: "本次返还为零，动机仍未知" }));
      if (index === 1) { expect(sdkToolResult(request).canonicalMind.emotions.anger).toBeCloseTo(0.35); return sdkCall("create_plan", plan(eventId)); }
      if (index === 2) {
        expect(sdkToolResult(request).canonicalMind.plan.status).toBe("active");
        const schema = request.tools.find(tool => tool.type === "function" && tool.name === "forecast") as any;
        expect(schema.parameters.properties.eventId.enum).toContain(eventId);
        expect(schema.parameters.properties.eventId.enum.every((id: string) => /^e\d+$/.test(id))).toBe(true);
        return sdkCall("forecast", { eventId, ...data.nextCounterpartOpportunity, threshold: 0.5, probability: 0.6 });
      }
      expect(sdkToolResult(request).prediction.probability).toBe(0.6);
      return sdkCall("respond", { choice: "continue", message: "保留一次机会。", intent: "观察下一轮的行为", basis: "plan" });
    });
    const result = await createSdkParticipant(new ModelRegistry(), { model }).decide({ world, actorId: "a" });
    expect(requests).toHaveLength(4); expect(world).toEqual(original);
    expect(result.decisionCase.receipt).toMatchObject({ appraised: true, appraisalRequired: true, basis: "plan" });
    expect(result.mind.plan?.status).toBe("active"); expect(result.mind.predictions).toHaveLength(1);
    expect(result.memories).toHaveLength(1); expect(result.decisionCase.preparation).toBeUndefined();
    const source = world.events.find(event => event.kind === "settlement")!.id;
    expect(result.decisionCase.appraisal?.eventId).toBe(source);
    expect(result.memories[0].sourceIds).toEqual([source]);
  });
  it("never forwards peer secrets, foreign memories or obsolete SDK sessions", async () => {
    const world = fresh(); const { model, requests } = sdkFixture(() => offer());
    const result = await createSdkParticipant(new ModelRegistry(), { model }).decide({ world, actorId: "b",
      memories: [{ id: "foreign", actorId: "a", kind: "interpretation", text: "foreign-memory-canary", sourceIds: [world.events[0].id], revision: 0 }],
      sessionItems: [{ type: "message", role: "user", content: "obsolete-session-canary" }] });
    const wire = JSON.stringify(requests);
    for (const secret of ["peer-private-goal-canary", "foreign-memory-canary", "obsolete-session-canary"]) expect(wire).not.toContain(secret);
    expect(result.memories).toEqual([]);
  });
  it("keeps facts-only decisions independent of psychological interventions", async () => {
    const inputs: string[] = [];
    for (const willingness of [0.1, 0.9]) {
      const mind = createMind("b", "自己的收益与合作目标"); mind.relationship.willingness = willingness; mind.conflict = "mind-only-canary";
      const { model, requests } = sdkFixture(() => offer());
      await createSdkParticipant(new ModelRegistry(), { model, psychology: "off" }).decide({ world: fresh(), actorId: "b", mind });
      expect(JSON.stringify(requests[0].input)).not.toContain("mind-only-canary");
      expect(requests[0].tools.some(item => item.type === "function" && item.name === "appraise_event")).toBe(false);
      inputs.push(JSON.stringify(requests[0].input));
    }
    expect(inputs[0]).toBe(inputs[1]);
  });
  it("lets the SDK return a precise validation error and correct the call without a whole-run retry", async () => {
    const { model, requests } = sdkFixture((request, index) => {
      if (!index) return offer({ collateral: "2" });
      expect(sdkToolResult(request).error).toBeTruthy(); return offer();
    });
    const result = await createSdkParticipant(new ModelRegistry(), { model }).decide({ world: fresh(), actorId: "b" });
    expect(requests).toHaveLength(2); expect(result.decisionCase).toMatchObject({ retries: 0, toolFailures: 1 });
    expect(result.action).toMatchObject({ collateral: 2 });
  });
  it("rejects illegal financial actions and preserves their error receipts", async () => {
    const { model } = sdkFixture((request, index) => {
      if (!index) return offer({ collateral: 999999 });
      expect(sdkToolResult(request).error).toBeTruthy(); return offer();
    });
    const result = await createSdkParticipant(new ModelRegistry(), { model }).decide({ world: fresh(), actorId: "b" });
    expect(result.decisionCase.toolFailures).toBe(1); expect(result.action).toMatchObject({ collateral: 2 });
  });
  it("discards incomplete responses even if their function arguments happen to be valid JSON", async () => {
    const world = fresh(); const before = structuredClone(world);
    const { model } = sdkFixture(() => ({ ...offer(), providerData: { status: "incomplete" } }));
    const error = await createSdkParticipant(new ModelRegistry(), { model }).decide({ world, actorId: "b" }).catch(error => error);
    expect(error).toBeInstanceOf(PartnerDecisionError); expect(error.decisionCase.action).toBeUndefined(); expect(world).toEqual(before);
    expect(error.decisionCase.exchanges[0].response).toBeTruthy(); expect(error.decisionCase.retries).toBe(0);
  });
  it("rejects a multi-tool response as one failed activation", async () => {
    const world = fresh(); const before = structuredClone(world);
    const { model } = sdkFixture(() => ({ ...offer(), output: [...offer().output, ...offer({ collateral: 3 }).output] }));
    const error = await createSdkParticipant(new ModelRegistry(), { model }).decide({ world, actorId: "b" }).catch(error => error);
    expect(error).toBeInstanceOf(PartnerDecisionError); expect(error.decisionCase.error).toContain("多个工具");
    expect(world).toEqual(before); expect(error.decisionCase.action).toBeUndefined();
  });
  it("keeps shadow appraisal out of the decision input, action and SDK session", async () => {
    const mind = createMind("b", "自己的收益与合作目标"); mind.conflict = "shadow-private-canary";
    const { model, requests } = sdkFixture((request, index) => {
      if (index === 0) { expect(JSON.stringify(request.input)).not.toContain("shadow-private-canary"); return offer({ message: "已定的发言" }); }
      if (index === 1) {
        expect(JSON.stringify(request.input)).toContain("shadow-private-canary"); expect(JSON.stringify(request.input)).not.toContain("已定的发言");
        expect(request.tools.some(item => item.type === "function" && item.name === "offer")).toBe(false);
        return sdkCall("appraise_event", appraisal(sdkInput(request).appraisalRequired.event.id, { conflict: "shadow-updated-canary" }));
      }
      return sdkCall("finish_record", {});
    });
    const result = await createSdkParticipant(new ModelRegistry(), { model, psychology: "record-only" }).decide({ world: fresh(), actorId: "b", mind });
    expect(requests).toHaveLength(3); expect(result.action.message).toBe("已定的发言"); expect(result.decisionCase.shadow?.status).toBe("completed");
    expect(result.mind.conflict).toBe("shadow-updated-canary"); expect(JSON.stringify(result.sessionItems)).not.toContain("shadow-updated-canary");
  });
  it("redacts credentials before recording or presentation", async () => {
    vi.stubEnv("SDK_TEST_SECRET_KEY", "private-credential-canary");
    const { model } = sdkFixture(() => offer({ intent: "private-credential-canary" }));
    const result = await createSdkParticipant(new ModelRegistry(), { model }).decide({ world: fresh(), actorId: "b" });
    expect(JSON.stringify(result.decisionCase)).not.toContain("private-credential-canary");
  });
  it("does not call a model for someone else's opportunity", async () => {
    const { model, requests } = sdkFixture(() => offer());
    await expect(createSdkParticipant(new ModelRegistry(), { model }).decide({ world: fresh(), actorId: "a" })).rejects.toThrow("行动机会");
    expect(requests).toHaveLength(0);
  });
});
