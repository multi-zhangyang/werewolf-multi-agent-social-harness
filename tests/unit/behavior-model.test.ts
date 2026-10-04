import { expect, it } from "vitest";
import { behaviorBelief, behaviorKey, betaEstimate, createBehaviorModel, observeBehavior, scoreBehavior, type BehaviorContext, type BehaviorModel } from "../../src/agents/behavior-model";
import { createAgentMind, enterEpisode, integrateExperience } from "../../src/agents/cognition";
import { ledgerExperience } from "../../src/runtime/agent-state";
import { signalingBreakEven, signalingPayoffs } from "../../src/runtime/scenarios/payoffs";
import { runSpecSchema, type WorldEvent } from "../../src/runtime/types";

const context: BehaviorContext = { opponentId: "sender", role: "receiver", incentives: "conflicting", payoffProfile: "diagnostic", objective: "character" };
const observation = (highQuality: boolean, reportedHighQuality: boolean, accepted = false) => ({ context, highQuality, reportedHighQuality, accepted });
const spec = runSpecSchema.parse({ scenario: "signaling-game", signalingPayoffProfile: "diagnostic", roster: [{ characterId: "sender" }, { characterId: "receiver" }] });
const event: WorldEvent = { id: "settled", runId: "r", seq: 1, at: "", type: "fact", visibility: "public", text: "fixture settlement",
  data: { settlement: true, round: 1, senderId: "sender", receiverId: "receiver", incentives: "conflicting", payoffProfile: "diagnostic", highQuality: false, reportedHighQuality: true, accepted: false, payoffs: { sender: 2, receiver: 4 } } };

it("smooths from Beta(1,1), ages both rows once and deduplicates the same settlement", () => {
  const models: Record<string, BehaviorModel> = {};
  expect(betaEstimate(createBehaviorModel(context).high)).toMatchObject({ probability: .5, priorOnly: true, samples: 0, effectiveSamples: 0 });
  observeBehavior(models, observation(true, true), "a");
  observeBehavior(models, observation(false, false), "b");
  const model = models[behaviorKey(context)];
  expect(model.high).toMatchObject({ successes: .9, samples: 1, sourceIds: ["a"] });
  expect(model.low).toMatchObject({ failures: 1, samples: 1, sourceIds: ["b"] });
  expect(betaEstimate(model.high).probability).toBeCloseTo(1.9 / 2.9);
  const before = structuredClone(model); observeBehavior(models, observation(false, true), "b");
  expect(model).toEqual(before);
});

it("isolates every conditioning dimension and retains matching records across episodes", () => {
  const mind = createAgentMind("receiver", "r"); mind.behaviorModels = {};
  for (const [i, changed] of [context, { ...context, opponentId: "stranger" }, { ...context, role: "sender" as const },
    { ...context, incentives: "aligned" as const }, { ...context, payoffProfile: "legacy" as const }, { ...context, objective: "score" as const }].entries())
    observeBehavior(mind.behaviorModels, { ...observation(true, true), context: changed }, `e${i}`);
  expect(Object.keys(mind.behaviorModels)).toHaveLength(6);
  expect(Object.values(mind.behaviorModels).every(m => m.sourceIds.length === 1)).toBe(true);
  expect(enterEpisode(mind, "receiver", "next").behaviorModels).toEqual(mind.behaviorModels);
});

// Mechanism fixtures: scripted reports validate update direction, not real AI learning.
it("distinguishes honest, always-high and honest-then-false mechanism fixtures", () => {
  const run = (reports: (truth: boolean, i: number) => boolean, rounds = 20) => {
    const models: Record<string, BehaviorModel> = {};
    for (let i = 0; i < rounds; i++) { const truth = i % 2 === 0; observeBehavior(models, observation(truth, reports(truth, i)), `e${i}`); }
    return models[behaviorKey(context)];
  };
  const honest = behaviorBelief(run(truth => truth), .5, 2 / 3, true);
  const alwaysHigh = behaviorBelief(run(() => true), .5, 2 / 3, true);
  const changed = behaviorBelief(run((truth, i) => i < 20 ? truth : true, 40), .5, 2 / 3, true);
  expect(honest.highQualityProbability).toBeGreaterThan(2 / 3);
  expect(behaviorBelief(run(truth => truth), .5, 2 / 3, false).highQualityProbability).toBeLessThan(1 / 3);
  expect(alwaysHigh.highQualityProbability).toBeCloseTo(.5, 1);
  expect(changed.highQualityProbability).toBeLessThan(honest.highQualityProbability!);
  expect(changed.highQualityProbability).toBeLessThan(2 / 3);
});

it("scores the frozen probability before updating evidence and does not score twice", () => {
  const mind = createAgentMind("receiver", "r");
  const belief = behaviorBelief(createBehaviorModel(context), .5, 2 / 3, true);
  mind.decisions.push({ id: "d", episode: "r", round: 1, action: "choose_offer", parameters: { accept: false }, strategy: "protect", intent: "none", privateAim: "fixture", predictionIds: [], beliefSnapshot: belief });
  const experience = ledgerExperience(event, spec, "receiver")!;
  expect(integrateExperience(mind, experience)).toBe(true);
  expect(mind.decisions[0].beliefFeedback).toMatchObject({ probability: .5, brier: .25, outcome: false, actualPayoff: 4 });
  expect(mind.decisions[0].beliefSnapshot?.modelRevision).toBe(0);
  expect(behaviorBelief(mind.behaviorModels![behaviorKey(context)], .5, 2 / 3, true).highQualityProbability).toBeCloseTo(3 / 7);
  expect(integrateExperience(mind, experience)).toBe(false);
  expect(mind.behaviorModels![behaviorKey(context)].revision).toBe(1);
});

it("excludes unauthorized and legacy outcomes, and never turns old notes into evidence", () => {
  expect(ledgerExperience({ ...event, visibility: ["sender"] }, spec, "receiver")).toBeUndefined();
  expect(ledgerExperience({ ...event, visibility: "research" }, spec, "receiver")).toBeUndefined();
  expect(ledgerExperience(event, spec, "stranger")?.behaviorObservation).toBeUndefined();
  const legacy = structuredClone(event); delete legacy.data.payoffProfile;
  expect(ledgerExperience(legacy, spec, "receiver")?.behaviorObservation).toBeUndefined();
  expect(ledgerExperience({ ...event, type: "note" }, spec, "receiver")).toBeUndefined();
  const mind = createAgentMind("receiver", "r");
  integrateExperience(mind, ledgerExperience(legacy, spec, "receiver")!);
  expect(mind.behaviorModels).toBeUndefined();
});

it("preserves legacy defaults and computes the diagnostic threshold from actual payoffs", () => {
  const legacy = runSpecSchema.parse({ scenario: "signaling-game", roster: spec.roster });
  expect(legacy.signalingPayoffProfile).toBe("legacy"); expect(legacy.experiment.objective).toBe("character");
  expect(signalingBreakEven("conflicting")).toBe(1 / 3);
  expect(signalingBreakEven("aligned", "diagnostic")).toBe(2 / 3);
  expect(signalingPayoffs("conflicting", false, false, "diagnostic")).toEqual({ sender: 2, receiver: 4 });
  expect(signalingPayoffs("aligned", false, true, "diagnostic")).toEqual({ sender: 0, receiver: 0 });
});

it("scores acceptance for the actual report and does not equate any false trade with persuasion", () => {
  const sender = { ...context, opponentId: "receiver", role: "sender" as const };
  const belief = { ...behaviorBelief(createBehaviorModel(sender), .5, 2 / 3), knownHighQuality: false };
  const observed = { ...observation(false, true, true), context: sender };
  const models: Record<string, BehaviorModel> = {};
  observeBehavior(models, { ...observed, accepted: false }, "rejected-high");
  observeBehavior(models, { ...observed, reportedHighQuality: false }, "accepted-low");
  const rates = behaviorBelief(models[behaviorKey(sender)], .5, 2 / 3);
  expect(rates.high.probability).toBeLessThan(.5); expect(rates.low.probability).toBeGreaterThan(.5);
  expect(scoreBehavior(belief, { highQuality: true }, observed, "e")).toMatchObject({ kind: "acceptance", brier: .25, knownFalseReport: true, falseReportAccepted: true });
  expect(scoreBehavior(belief, { highQuality: false }, observed, "e")).toBeUndefined();
  expect(scoreBehavior(behaviorBelief(createBehaviorModel(context), .5, 1 / 3, true), { accept: true }, observation(false, true, true), "e")).toMatchObject({ lowQualityAcceptedWithRaisedBelief: false });
});
