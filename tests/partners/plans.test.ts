import { describe, expect, it } from "vitest";
import { createMind } from "../../src/partners/mind";
import { applyPlanOperation, assessPlan, evaluatePlanCondition, reconcilePlan, type PlanOperation } from "../../src/partners/plans";
import { applyAction, createWorld, observeWorld } from "../../src/partners/world";

const fresh = () => createWorld({ maxRounds: 3, actors: { a: { name: "甲", kind: "ai" }, b: { name: "乙", kind: "ai" } } }, "plans");
const draft = { aim: "建立合作", nextStep: "报价", continueWhen: "履约", reviseWhen: "条件变化", abandonWhen: "主动退出", conditions: [], success: null,
  scope: { role: "trustee" as const, fromRound: 1, throughRound: 1, phases: ["offer" as const] } };
function setup() {
  const world = fresh(); const observation = observeWorld(world, "b"); const initial = createMind("b", observation.self.privateObjective);
  const mind = applyPlanOperation(initial, { kind: "create", plan: draft }, observation, "首次计划", [world.events[0].id]);
  return { world, observation, initial, mind, evidence: [world.events[0].id] };
}
describe("Versioned executable plans", () => {
  it("expires a spent opportunity without inventing voluntary abandonment", () => {
    const { world, mind } = setup();
    const next = applyAction(world, "b", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "offer");
    const reconciled = reconcilePlan(mind, observeWorld(next, "b"));
    expect(reconciled.plan?.status).toBe("expired");
    expect(reconciled.planEvents?.at(-1)).toMatchObject({ origin: "rules", from: "active", to: "expired" });
    expect(reconcilePlan(reconciled, observeWorld(next, "b"))).toEqual(reconciled);
    expect(mind.plan?.status).toBe("active");
  });
  it("rejects stale versions and impossible future roles without touching the old plan", () => {
    const { mind, observation, evidence } = setup(); const saved = structuredClone(mind);
    expect(() => applyPlanOperation(mind, { kind: "abandon", version: 0 }, observation, "旧版本", evidence)).toThrow("版本");
    expect(() => applyPlanOperation(mind, { kind: "revise", version: 1, plan: { ...draft, scope: { role: "investor", fromRound: 1, throughRound: 1, phases: ["settle"] } } }, observation, "角色错误", evidence)).toThrow("合法机会");
    expect(() => applyPlanOperation(mind, { kind: "revise", version: 1, plan: { ...draft, scope: { ...draft.scope, throughRound: 4 } } }, observation, "不存在轮次", evidence)).toThrow("不存在");
    expect(mind).toEqual(saved);
  });
  it("requires evidence for objective completion and keeps active plans during one-off choices", () => {
    const { observation, evidence, initial } = setup();
    const mind = applyPlanOperation(initial, { kind: "create", plan: { ...draft, success: { kind: "own-wallet-at-least", amount: 10000 } } }, observation, "目标", evidence);
    expect(() => applyPlanOperation(mind, { kind: "satisfy", version: 1 }, observation, "口头宣布完成", evidence)).toThrow("尚未");
    expect(applyPlanOperation(mind, { kind: "act-once" }, observation, "只做本次选择", evidence)).toEqual(mind);
    const completed = reconcilePlan(mind, { ...observation, self: { ...observation.self, wallet: 10000 } });
    expect(completed.plan?.status).toBe("satisfied");
  });
  it("does not let claims establish financial preconditions", () => {
    const { observation } = setup();
    expect(evaluatePlanCondition({ kind: "visible-return-at-least", round: 1, amount: 1 }, observation)).toBe("unknown");
    expect(evaluatePlanCondition({ kind: "collateral-at-least", round: 1, amount: 1 }, observation)).toBe("unknown");
    expect(evaluatePlanCondition({ kind: "own-wallet-at-least", amount: observation.self.wallet + 1 }, observation)).toBe("false");
  });
  it("requires an actor acknowledgment before reactivating a reviewable plan and preserves its history", () => {
    const { mind, observation, evidence } = setup();
    const reviewable = { ...mind, plan: { ...mind.plan!, status: "needs-review" as const } };
    expect(assessPlan(reviewable.plan, observation).applicable).toBe(false);
    const resumed = applyPlanOperation(reviewable, { kind: "keep", version: 1 }, observation, "条件仍适用", evidence);
    expect(resumed.plan).toMatchObject({ status: "active", version: 2 });
    const revised = applyPlanOperation(resumed, { kind: "revise", version: 2, plan: { ...draft, nextStep: "提高担保" } }, observation, "调整金额策略", evidence);
    expect(revised.planHistory?.at(-1)?.version).toBe(2);
    expect(revised.plan?.id).toBe(resumed.plan?.id);
  });
  it("does not reopen terminal plans or overwrite live ones with create", () => {
    const { mind, observation, evidence } = setup();
    expect(() => applyPlanOperation(mind, { kind: "create", plan: draft }, observation, "覆盖", evidence)).toThrow("无声覆盖");
    const abandoned = applyPlanOperation(mind, { kind: "abandon", version: 1 }, observation, "明确放弃", evidence);
    for (const kind of ["keep", "abandon", "satisfy"] as const) expect(() => applyPlanOperation(abandoned, { kind, version: 2 } as PlanOperation, observation, "旧计划", evidence)).toThrow("已经结束");
    const next = applyPlanOperation(abandoned, { kind: "create", plan: draft }, observation, "新的计划", evidence);
    expect(next.plan?.id).not.toBe(abandoned.plan?.id);
  });
});
