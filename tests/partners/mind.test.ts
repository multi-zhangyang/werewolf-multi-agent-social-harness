import { describe, expect, it } from "vitest";
import { applyAction, createWorld, observeWorld } from "../../src/partners/world";
import { advanceMind, assessmentTriggers, baselineEmotions, createMind, reduceMind, resolvePredictions, type MindDelta } from "../../src/partners/mind";

function delta(eventId: string, patch: Partial<MindDelta> = {}): MindDelta {
  return { eventId, sourceIds: [eventId], reason: "根据最新可见证据修订", emotions: null, needs: null, relationship: null, plan: null,
    conflict: null, regulation: null, expression: null, predictions: [], memory: null, ...patch };
}
const fresh = () => createWorld({ actors: { a: { name: "甲", kind: "ai", productivity: 2 }, b: { name: "乙", kind: "ai", productivity: 3 } }, maxRounds: 3 }, "mind-test");

describe("persistent mind reducer", () => {
  it("scores a real response-stage exit as declining continuation regardless of action alias", () => {
    let world = fresh();
    const mind = reduceMind(createMind("b", "目标"), delta(world.events[0].id, { predictions: [
      { targetActorId: "a", round: 1, action: "respond", metric: "continue", threshold: 1, probability: 0.8 },
    ] }), observeWorld(world, "b"));
    world = applyAction(world, "b", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "offer");
    const exitedBeforeResponse = applyAction(world, "a", { type: "exit" }, "early-exit");
    expect(resolvePredictions(mind, observeWorld(exitedBeforeResponse, "b")).predictions[0]).toMatchObject({ status: "unscored" });
    world = applyAction(world, "a", { type: "invest", amount: 6 }, "invest");
    world = applyAction(world, "b", { type: "settle", returnAmount: 0 }, "settle");
    world = applyAction(world, "b", { type: "repair", compensation: 0 }, "repair");
    const explicit = applyAction(world, "a", { type: "respond", choice: "exit" }, "explicit-exit");
    const shortcut = applyAction(world, "a", { type: "exit" }, "shortcut-exit");
    const expected = resolvePredictions(mind, observeWorld(explicit, "b")).predictions[0];
    const actual = resolvePredictions(mind, observeWorld(shortcut, "b")).predictions[0];
    expect(actual).toEqual(expected);
    expect(actual).toMatchObject({ status: "scored", observed: 0, outcome: false, brier: 0.64 });
    expect(mind.predictions[0].status).toBe("pending");
  });

  it("uses identical inertia regardless of personality and does not duplicate an event stimulus", () => {
    const world = fresh(); const observation = observeWorld(world, "b");
    const previous = createMind("b", "自主权衡");
    const proposal = delta(world.events[0].id, { emotions: { anger: 1, anxiety: 0.5, guilt: 0, hope: 0 } });
    const next = reduceMind(previous, proposal, observation);
    expect(next.emotions.anger).toBe(0.43);
    expect(next.version).toBe(1);
    expect(reduceMind(next, proposal, observation)).toEqual(next);
    expect(previous.emotions).toEqual(baselineEmotions);
    const contrasting = structuredClone(observation); contrasting.self.agreeableness = 0.1;
    expect(reduceMind(previous, proposal, contrasting).emotions).toEqual(next.emotions);
    expect(reduceMind(previous, proposal, observation, "no-inertia").emotions.anger).toBe(1);
  });
  it("decays by game revisions only, while plans, needs and relationship beliefs persist", () => {
    const world = fresh(); const observation = observeWorld(world, "b");
    const next = reduceMind(createMind("b", "长期收益"), delta(world.events[0].id, {
      emotions: { anger: 1, anxiety: 1, guilt: 0.5, hope: 0.4 },
      needs: { security: 0.9, fairness: 0.8, affiliation: 0.2 },
      relationship: { willingness: 0.3, capability: 0.8, interpretation: "可能不愿返还", alternative: "也可能因负担暂时周转困难" },
      plan: { aim: "保护本金", nextStep: "要求担保", continueWhen: "实际冻结担保", reviseWhen: "出现新收入证据", abandonWhen: "持续拒绝可核验条件", status: "active" },
    }), observation);
    const advanced = advanceMind(next, 1);
    expect(advanced.emotions.anger).toBe(0.392);
    expect(advanceMind(advanced, 1)).toEqual(advanced);
    expect(advanced.relationship).toEqual(next.relationship);
    expect(advanced.needs).toEqual(next.needs);
    expect(advanced.plan).toEqual(next.plan);
  });
  it("rejects invisible, invented and cross-actor evidence without mutation", () => {
    let world = applyAction(fresh(), "b", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "offer");
    world = applyAction(world, "a", { type: "invest", amount: 6 }, "invest");
    const own = createMind("a", "目标"); const before = structuredClone(own);
    const hiddenIncome = world.events.find(event => event.kind === "income")!;
    expect(() => reduceMind(own, delta(hiddenIncome.id), observeWorld(world, "a"))).toThrow(/不可见/);
    expect(() => reduceMind(own, delta("made-up"), observeWorld(world, "a"))).toThrow(/不存在/);
    expect(() => reduceMind(createMind("b", "别人"), delta(world.events[0].id), observeWorld(world, "a"))).toThrow(/不属于/);
    expect(own).toEqual(before);
  });
  it("scores only a future event in the proper role and supplies prediction error as actor feedback", () => {
    let world = fresh();
    const observation = observeWorld(world, "b");
    const state = reduceMind(createMind("b", "目标"), delta(world.events[0].id, { predictions: [
      { targetActorId: "a", round: 1, action: "invest", metric: "amount", threshold: 6, probability: 0.9 },
    ] }), observation);
    world = applyAction(world, "b", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "offer");
    world = applyAction(world, "a", { type: "invest", amount: 1 }, "invest");
    const scored = resolvePredictions(state, observeWorld(world, "b"));
    expect(scored.predictions[0]).toMatchObject({ status: "scored", observed: 1, outcome: false, brier: 0.81 });
    expect(assessmentTriggers(scored, observeWorld(world, "b"))).toContain("行为预测出现明显误差");
    expect(resolvePredictions(scored, observeWorld(world, "b"))).toEqual(scored);
  });
  it("does not score skipped opportunities as negative outcomes and rejects role confusion", () => {
    const world = fresh(); const observation = observeWorld(world, "b");
    const before = createMind("b", "目标");
    expect(() => reduceMind(before, delta(world.events[0].id, { predictions: [
      { targetActorId: "a", round: 1, action: "settle", metric: "returnAmount", threshold: 6, probability: 0.8 },
    ] }), observation)).toThrow(/角色/);
    const pending = reduceMind(before, delta(world.events[0].id, { predictions: [
      { targetActorId: "a", round: 1, action: "invest", metric: "amount", threshold: 6, probability: 0.8 },
    ] }), observation);
    const exited = applyAction(world, "b", { type: "exit" }, "exit");
    expect(resolvePredictions(pending, observeWorld(exited, "b")).predictions[0]).toMatchObject({ status: "unscored" });
    expect(resolvePredictions(pending, observeWorld(exited, "b")).predictions[0].brier).toBeUndefined();
  });
});
