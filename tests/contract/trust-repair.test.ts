import { expect, it } from "vitest";
import { EconomicScenario } from "../../src/runtime/scenarios/economic";
import type { Character } from "../../src/runtime/types";
const characters: Character[] = ["a", "b"].map(id => ({ id, name: id, persona: "", values: [], goals: [], voice: "" }));

it("records a nonbinding promise, detects breach, and transfers real resources for repair", () => {
  const game = new EconomicScenario("trust-game", characters, 2, "pledge-repair");
  game.advance(); expect(game.stage()?.actors).toEqual(["b"]);
  game.apply("b", "pledge_return", { amount: 50 });
  expect(() => game.apply("b", "pledge_return", { amount: 0 })).toThrow();
  game.advance(); game.apply("a", "invest", { amount: 6 }); game.advance(); game.advance();
  game.apply("b", "return_funds", { amount: 0 });
  const settlement = game.advance();
  expect(settlement[0].data).toMatchObject({ investorId: "a", trusteeId: "b", investment: 6, returned: 0 });
  expect(settlement.at(-1)?.data.commitment).toEqual({ actorId: "b", targetId: "a", promised: 9, returned: 0, kept: false });
  expect(game.publicState().scores).toEqual({ a: 4, b: 18 });
  game.advance(); expect(game.stage()?.label).toBe("是否付出补偿");
  expect(() => game.apply("b", "repair_transfer", { amount: 19 })).toThrow();
  const repair = game.apply("b", "repair_transfer", { amount: 5 });
  expect(repair.at(-1)?.data).toMatchObject({ round: 1, settlement: true, settlementKind: "repair", payoffs: { a: 5, b: -5 }, scores: { a: 9, b: 13 } });
  expect(game.publicState().scores).toEqual({ a: 9, b: 13 });
  expect(() => game.apply("b", "repair_transfer", { amount: 1 })).toThrow();
  game.advance(); game.advance();
  expect(game.publicState()).toMatchObject({ round: 2, investorId: "b", trusteeId: "a" });
  expect(game.publicState().pledge).toBeUndefined();
});

it("does not force betrayal or compensation, including a zero-investment round", () => {
  const game = new EconomicScenario("trust-game", characters, 2, "pledge-repair");
  game.advance(); game.apply("b", "pledge_return", { amount: 100 }); game.advance();
  game.apply("a", "invest", { amount: 0 }); game.advance(); game.advance();
  game.apply("b", "return_funds", { amount: 0 });
  expect(game.advance().at(-1)?.data.commitment).toMatchObject({ promised: 0, returned: 0, kept: true });
  game.advance(); const repair = game.apply("b", "repair_transfer", { amount: 0 });
  expect(repair.at(-1)?.data).toMatchObject({ round: 1, settlement: true, settlementKind: "repair", payoffs: { a: 0, b: 0 } });
  expect(game.publicState().scores).toEqual({ a: 10, b: 0 });
});
