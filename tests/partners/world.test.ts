import { describe, expect, it } from "vitest";
import type { Action, WorldState } from "../../src/partners/contracts";
import {
  applyAction, assertConservation, createWorld, currentActor, legalActions,
  observeWorld, previewAction, publicObservation,
} from "../../src/partners/world";

function world(maxRounds = 3): WorldState {
  return createWorld({ maxRounds, actors: {
    a: { name: "投资人", kind: "human", productivity: 2, burden: 8, privateObjective: "A_SECRET_OBJECTIVE" },
    b: { name: "经营者", kind: "ai", productivity: 3, burden: 8, privateObjective: "B_SECRET_OBJECTIVE" },
  } }, "test-world");
}

function step(state: WorldState, action: Action): WorldState {
  return applyAction(state, currentActor(state)!, action, `command-${state.revision + 1}`);
}

function betrayed(maxRounds = 3, collateral = 4): WorldState {
  let state = world(maxRounds);
  state = step(state, { type: "offer", promiseRatio: 0.5, collateral });
  state = step(state, { type: "invest", amount: 6 });
  return step(state, { type: "settle", returnAmount: 0, claimedIncome: 0 });
}

describe("Partners authoritative world", () => {
  it("settles real income, escrow forfeiture, compensation, and terminal obligations with conservation", () => {
    let state = betrayed(1);
    expect(state.actors.a.wallet).toBe(16);
    expect(state.actors.b.wallet).toBe(32);
    expect(state.deal).toMatchObject({ grossIncome: 18, returned: 0, breached: true, collateralForfeited: 4, collateralLocked: 0 });
    expect(state.ledger).toEqual({ initialTotal: 36, minted: 12, externalCosts: 0 });
    state = step(state, { type: "repair", compensation: 9, message: "这笔补偿现在给你。" });
    expect(state.actors.a.wallet).toBe(25);
    expect(state.actors.b.wallet).toBe(23);
    expect(state.deal.breached).toBe(true);
    state = step(state, { type: "respond", choice: "continue" });
    expect(state.phase).toBe("finished");
    expect(state.actors.a.wallet).toBe(17);
    expect(state.actors.b.wallet).toBe(15);
    expect(state.ledger.externalCosts).toBe(16);
    expect(state.completedDeals).toHaveLength(1);
    expect(() => assertConservation(state)).not.toThrow();
  });

  it("returns escrow on performance and permits fulfillment using other personal resources", () => {
    let state = world();
    state = step(state, { type: "offer", promiseRatio: 0.5, collateral: 10 });
    expect(state.actors.b.wallet).toBe(8);
    state = step(state, { type: "invest", amount: 1 });
    state = step(state, { type: "settle", returnAmount: 5 });
    expect(state.deal).toMatchObject({ grossIncome: 3, returned: 5, breached: false, collateralForfeited: 0 });
    expect(state.actors.b.wallet).toBe(16);
    expect(state.actors.a.wallet).toBe(22);
    expect(() => assertConservation(state)).not.toThrow();
  });

  it("does not count a claim as income and separates peer, self, and spectator visibility", () => {
    let state = world();
    state = step(state, { type: "offer", promiseRatio: 0.5, collateral: 0, intent: "PRIVATE_INTENT_9001" });
    state = step(state, { type: "invest", amount: 6 });
    state = step(state, { type: "settle", returnAmount: 0, claimedIncome: 7, message: "我只拿到了 7。" });
    const investor = observeWorld(state, "a");
    const trustee = observeWorld(state, "b");
    const spectator = publicObservation(state);
    expect(investor.deal.grossIncome).toBeNull();
    expect(investor.deal.claimedIncome).toBe(7);
    expect(trustee.deal.grossIncome).toBe(18);
    expect(trustee.events.some(item => item.kind === "income")).toBe(true);
    expect(investor.events.some(item => item.kind === "income" || item.kind === "intent")).toBe(false);
    expect(JSON.stringify(investor)).not.toContain("B_SECRET_OBJECTIVE");
    expect(JSON.stringify(investor)).not.toContain("PRIVATE_INTENT_9001");
    expect(spectator).not.toHaveProperty("self");
    expect(spectator).not.toHaveProperty("commands");
    expect(spectator).not.toHaveProperty("ledger");
    expect(spectator.actors.b).toEqual({ id: "b", name: "经营者", kind: "ai" });
    expect(spectator.legalActions).toEqual([]);
    expect(spectator.events.every(item => item.visibility === "public")).toBe(true);
  });

  it("reveals only the volunteered transaction income, including its historical projection", () => {
    let state = step(world(), { type: "offer", promiseRatio: 0.5, collateral: 0 });
    state = step(state, { type: "invest", amount: 6 });
    state = step(state, { type: "settle", returnAmount: 9, claimedIncome: 7, revealIncome: true });
    state = step(state, { type: "repair", compensation: 0 });
    state = step(state, { type: "respond", choice: "continue" });
    const observation = publicObservation(state);
    expect(observation.completedDeals[0]).toMatchObject({ grossIncome: 18, claimedIncome: 7, incomeRevealed: true });
    expect(observation.events.find(item => item.kind === "settlement")?.data).toMatchObject({ returnAmount: 9, claimedIncome: 7, revealedIncome: 18 });
    expect(observation.actors.b).not.toHaveProperty("wallet");
    expect(observation.actors.b).not.toHaveProperty("burden");
    expect(observation.actors.b).not.toHaveProperty("productivity");
  });

  it("swaps roles after response; the previously harmed investor next chooses a promise and settlement", () => {
    let state = betrayed();
    state = step(state, { type: "repair", compensation: 0 });
    state = step(state, { type: "respond", choice: "continue" });
    expect(state).toMatchObject({ round: 2, phase: "offer", investor: "b", trustee: "a" });
    expect(currentActor(state)).toBe("a");
    expect(legalActions(state, "a").map(action => action.type)).toEqual(["offer", "exit"]);
    expect(legalActions(state, "b")).toEqual([]);
    expect(state.completedDeals).toHaveLength(1);
    expect(state.deal.grossIncome).toBeNull();
  });

  it("rejects wrong roles, overspending, fractional resources, invalid ratios, and premature exit without mutation", () => {
    const initial = world();
    const before = JSON.stringify(initial);
    expect(() => applyAction(initial, "a", { type: "offer", promiseRatio: 0.5, collateral: 0 }, "bad-role")).toThrow("尚未轮到");
    expect(() => step(initial, { type: "offer", promiseRatio: 1.1, collateral: 0 })).toThrow("承诺比例");
    expect(() => step(initial, { type: "offer", promiseRatio: 0.5, collateral: 19 })).toThrow("担保");
    expect(JSON.stringify(initial)).toBe(before);
    let state = step(initial, { type: "offer", promiseRatio: 0.5, collateral: 0 });
    expect(() => step(state, { type: "invest", amount: 1.5 })).toThrow("投资");
    state = step(state, { type: "invest", amount: 6 });
    expect(() => step(state, { type: "exit" })).toThrow("当前阶段");
    expect(() => step(state, { type: "settle", returnAmount: 37 })).toThrow("返还");
  });

  it("repeated identical commands are no-ops and conflicting reuse is rejected", () => {
    const action: Action = { type: "offer", promiseRatio: 0.5, collateral: 4 };
    const next = applyAction(world(), "b", action, "once");
    expect(applyAction(next, "b", action, "once")).toBe(next);
    expect(() => applyAction(next, "b", { ...action, collateral: 5 }, "once")).toThrow("同一行动标识");
    expect(next.commands).toHaveLength(1);
    expect(next.revision).toBe(1);
  });

  it("counterfactual preview is isolated and does not disclose the counterpart's investment proceeds", () => {
    const source = step(world(), { type: "offer", promiseRatio: 0.5, collateral: 4 });
    const saved = JSON.stringify(source);
    const preview = previewAction(source, "a", { type: "invest", amount: 6 });
    expect(preview.legal).toBe(true);
    expect(preview.walletChange).toBe(-6);
    expect(preview.observation?.deal.grossIncome).toBeNull();
    expect(preview.observation?.legalActions).toEqual([]);
    expect(preview.newEvents?.some(item => item.kind === "income")).toBe(false);
    expect(JSON.stringify(preview)).not.toContain("B_SECRET_OBJECTIVE");
    expect(JSON.stringify(source)).toBe(saved);
    expect(previewAction(source, "a", { type: "invest", amount: 99 })).toMatchObject({ legal: false });
    expect(JSON.stringify(source)).toBe(saved);
  });

  it("two repair branches share history but cannot mutate each other or their source", () => {
    const source = betrayed();
    const before = JSON.stringify(source);
    const without = applyAction(source, "b", { type: "repair", compensation: 0, message: "对不起。" }, "branch-no-transfer");
    const withFunds = applyAction(source, "b", { type: "repair", compensation: 9, message: "对不起。" }, "branch-transfer");
    expect(withFunds.actors.a.wallet - without.actors.a.wallet).toBe(9);
    expect(without.events.filter(item => item.kind === "message")[0].summary).toBe(withFunds.events.filter(item => item.kind === "message")[0].summary);
    expect(JSON.stringify(source)).toBe(before);
    withFunds.actors.a.wallet = 999;
    expect(without.actors.a.wallet).toBe(16);
    expect(source.actors.a.wallet).toBe(16);
  });

  it("exit returns unresolved collateral, enforces personal obligations, and prevents future actions", () => {
    let state = createWorld({ actors: {
      a: { name: "A", kind: "human", initialWallet: 3, burden: 8 },
      b: { name: "B", kind: "ai", initialWallet: 18, burden: 8 },
    } });
    state = step(state, { type: "offer", promiseRatio: 0.5, collateral: 18 });
    state = step(state, { type: "exit", message: "我不接受这些条件。" });
    expect(state).toMatchObject({ phase: "finished", finishReason: "exit", exitedBy: "a" });
    expect(state.actors.a).toMatchObject({ wallet: 0, obligationPaid: 3, obligationShortfall: 5 });
    expect(state.actors.b).toMatchObject({ wallet: 10, obligationPaid: 8, obligationShortfall: 0 });
    expect(state.deal.collateralLocked).toBe(0);
    expect(publicObservation(state).events.some(item => item.kind === "obligation")).toBe(false);
    expect(() => step(state, { type: "offer", promiseRatio: 0.5, collateral: 0 })).toThrow();
    expect(() => assertConservation(state)).not.toThrow();
  });

  it("zero investment satisfies any fractional promise without fabricated betrayal", () => {
    let state = step(world(), { type: "offer", promiseRatio: 1, collateral: 4 });
    state = step(state, { type: "invest", amount: 0 });
    state = step(state, { type: "settle", returnAmount: 0 });
    expect(state.deal).toMatchObject({ breached: false, grossIncome: 0, collateralForfeited: 0 });
    expect(state.actors.a.wallet).toBe(18);
    expect(state.actors.b.wallet).toBe(18);
  });

  it("records equivalent response and settlement facts for the two ways to exit at the response opportunity", () => {
    const source = step(betrayed(), { type: "repair", compensation: 0 });
    const explicit = applyAction(source, "a", { type: "respond", choice: "exit" }, "respond-exit");
    const shortcut = applyAction(source, "a", { type: "exit" }, "generic-exit");
    expect(shortcut.events).toEqual(explicit.events);
    expect(shortcut.actors).toEqual(explicit.actors);
    expect(shortcut.ledger).toEqual(explicit.ledger);
    expect(shortcut.events.filter(event => event.kind === "response")).toHaveLength(1);
    expect(shortcut.events.find(event => event.kind === "response")).toMatchObject({ actor: "a", phase: "respond", data: { choice: "exit" } });
    const early = step(step(world(), { type: "offer", promiseRatio: 0.5, collateral: 0 }), { type: "exit" });
    expect(early.events.some(event => event.kind === "response")).toBe(false);
  });

  it("event identifiers stay stable across later actions and observation callers cannot edit the source", () => {
    const source = world();
    const oldEvent = source.events[0];
    const next = step(source, { type: "offer", promiseRatio: 0.5, collateral: 0 });
    expect(next.events[0]).toEqual(oldEvent);
    expect(new Set(next.events.map(item => item.id)).size).toBe(next.events.length);
    const observation = observeWorld(next, "a");
    observation.events[0].data.maxRounds = 999;
    observation.actors.b.name = "改名";
    observation.self.wallet = 999;
    expect(next.events[0].data.maxRounds).toBe(3);
    expect(next.actors.b.name).toBe("经营者");
    expect(next.actors.a.wallet).toBe(18);
  });
});
