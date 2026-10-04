import { expect, it } from "vitest";
import { summarizeTrials } from "../../src/runtime/study-metrics";
import type { TrialSummary } from "../../src/runtime/studies";

function trial(id: string, values: Partial<TrialSummary>): TrialSummary {
  return { id, group: "g", condition: "silence", mechanism: "hybrid", agreeableness: .2, repeat: 0, context: "compact", effort: "low", status: "completed", ...values };
}
it("reports failed and missing observations without converting them into zero actions", () => {
  const result = summarizeTrials([
    trial("one", { returnedShare: .25 }), trial("two", { repeat: 1, returnedShare: .75 }),
    trial("failed", { repeat: 2, status: "failed", returnedShare: 0 }), trial("missing", { repeat: 3 }),
  ]);
  expect(result.groups[0]).toMatchObject({ planned: 4, completed: 3, failed: 1, returnedShare: { n: 2, mean: .5 }, investment: null });
});
it("computes trait differences only from completed pairs with the same repeat and configuration", () => {
  const result = summarizeTrials([
    trial("low0", { returnedShare: .2 }), trial("high0", { agreeableness: .8, returnedShare: .7 }),
    trial("low1", { repeat: 1, returnedShare: .1 }), trial("high1-failed", { repeat: 1, agreeableness: .8, returnedShare: .9, status: "failed" }),
    trial("low2", { repeat: 2, returnedShare: .1 }), trial("high2-context", { repeat: 2, agreeableness: .8, returnedShare: .9, context: "expanded" }),
  ]);
  expect(result.effects[0].highMinusLowReturnedShare).toMatchObject({ n: 1, low: null, high: null });
  expect(result.effects[0].highMinusLowReturnedShare!.mean).toBeCloseTo(.5);
});
