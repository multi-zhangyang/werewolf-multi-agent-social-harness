import { expect, it } from "vitest";
import { cognitionForPrompt, completeEpisodeReview, createAgentMind, enterEpisode, forecast, integrateExperience, predictionFeedback } from "../../src/agents/cognition";
import { GeneralAgentContext } from "../../src/runtime/agent-context";
import { generalContext } from "../helpers/general-agent-fixture";

const prediction = { sourceIds: ["visible"], kind: "action" as const, targetId: "peer", eventName: "invest", field: "amount", operator: "gte" as const, expected: 2, probability: .7 };

it("separates forecast count from unique events and does not score unresolved forecasts during review", () => {
  const old = createAgentMind("self", "old"); const prior = forecast(old, prediction, 1);
  const mind = enterEpisode(old, "self", "r");
  const first = forecast(mind, prediction, 1); const second = forecast(mind, { ...prediction, probability: .4 }, 1);
  const future = forecast(mind, { ...prediction, kind: "outcome", targetId: null, eventName: "settlement", field: "payoffs.self", expected: 5, probability: .8 }, 1);
  const unresolved = forecast(mind, { ...prediction, field: "never-observed" }, 1);
  integrateExperience(mind, { id: "one-action", episode: "r", round: 1, seq: 2, kind: "action", actorId: "peer", name: "invest", text: "投入三点", data: { amount: 3 } });
  const feedback = predictionFeedback(mind);
  expect(feedback).toMatchObject({ forecastCount: 4, actionForecastCount: 3, outcomeForecastCount: 1, scoredForecastCount: 2, uniqueScoredEventCount: 1, unscoredForecastCount: 2 });
  expect(feedback.meanBrier).toBeCloseTo(.225);
  expect(feedback.eventGroups).toEqual([{ sourceId: "one-action", predictionIds: [first.id, second.id] }]);
  expect(feedback.unscored.map(item => [item.id, item.status])).toEqual([[future.id, "pending"], [unresolved.id, "pending"]]);
  integrateExperience(mind, { id: "settlement", episode: "r", round: 1, seq: 3, kind: "outcome", name: "settlement", text: "实际得到两点", data: { payoffs: { self: 2 } } });
  const before = structuredClone(mind.predictions); const learning = structuredClone(mind.learning);
  const review = completeEpisodeReview(mind, { status: "insufficient", sourceIds: ["settlement"], strategyIds: [], summary: "两条行动预测对应同一事件；一条结算预测未实现，另一条行动预测未验证。" }, "review");
  expect(review.predictionFeedback).toMatchObject({ forecastCount: 4, scoredForecastCount: 3, uniqueScoredEventCount: 2, unscoredForecastCount: 1,
    unscored: [{ id: unresolved.id, kind: "action", status: "unverified" }] });
  expect(review.predictionFeedback!.meanBrier).toBeCloseTo((.09 + .36 + .64) / 3);
  expect(mind.predictions).toEqual(before); expect(mind.learning).toEqual(learning);
  expect(mind.predictions.some(item => item.id === prior.id)).toBe(true);
  expect(cognitionForPrompt(mind).predictions.some(item => item.id === prior.id)).toBe(false);
  expect(unresolved.result).toBeUndefined(); expect(unresolved.expired).toBeUndefined(); expect(future.result).toBe(false);
});

it("treats incomplete legacy score records as unverified and exposes terminal status before finishEpisode runs", () => {
  const { context, spec } = generalContext(); context.cognition = createAgentMind("self", "r");
  const partial = forecast(context.cognition, prediction, 1); partial.result = false;
  const expired = forecast(context.cognition, prediction, 1); expired.expired = true;
  const before = structuredClone(context.cognition);
  expect(predictionFeedback(context.cognition)).toMatchObject({ scoredForecastCount: 0, uniqueScoredEventCount: 0, meanBrier: null, unscoredForecastCount: 2 });
  context.appraisalOnly = true; context.episodeReview = true; context.opportunity.actions = []; context.opportunity.stage.kind = "discussion";
  const input = JSON.parse(new GeneralAgentContext(context, spec, "r").modelInput());
  expect(input.episodeReview.predictionFeedback.unscored.map((item: { status: string }) => item.status)).toEqual(["unverified", "unverified"]);
  expect(input.strategyLearning.predictionFeedback).toEqual(input.episodeReview.predictionFeedback);
  expect(context.cognition).toEqual(before);
});
