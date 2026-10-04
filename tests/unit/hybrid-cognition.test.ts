import { expect, it } from "vitest";
import { reduceMind, cognitiveInput } from "../../src/runtime/cognition";
import { hybridProposalSchema, hybridStateSchema } from "../../src/runtime/psychology";
import { mindFixture } from "../helpers/psychology-fixture";
import { scorePredictions, predictionChoices } from "../../src/runtime/predictions";
import { RepairSandbox, studySpecSchema, trialSpec, StudyService, type StudyRecord, type TrialResult, type TrialSummary } from "../../src/runtime/studies";

it("keeps per-phase effort without output caps while preserving the calibration factorial", () => {
  const trial: TrialSummary = { id: "phase-budget", group: "g", condition: "free", mechanism: "hybrid", agreeableness: .2, repeat: 0, context: "compact", effort: "medium", status: "queued" };
  const settings = studySpecSchema.parse({ kind: "free", requestTimeoutMs: 240000, phases: { psychology: { effort: "low", maxOutputTokens: 16000 } } });
  const spec = trialSpec(settings, trial);
  expect(spec.cognition?.phases.psychology).toEqual({ effort: "low" });
  expect(spec.cognition?.phases.action).toEqual({ effort: "medium" });
  expect(spec.budgets).not.toHaveProperty("maxOutputTokens");
  expect(settings).not.toHaveProperty("maxOutputTokens");
  expect(spec.cognition?.requestTimeoutMs).toBe(240000);
  expect(trialSpec({ ...settings, kind: "calibration" }, trial).cognition?.phases.psychology).toEqual({ effort: "medium" });
});
import { SocietyStore } from "../../src/runtime/store";
import type { ParticipantFactory } from "../../src/runtime/types";

export function hybridFixture(sourceId: string) {
  return hybridProposalSchema.parse({ ...mindFixture(sourceId, "peer"), relationships: [{ targetId: "peer", willingness: .2, competence: .8, hypothesis: "可能想占便宜", alternative: "也可能临时改变主意", confidence: .5, expectedNextMove: "可能先道歉", sourceIds: [sourceId] }], conflict: "收益与公平之间的拉扯", regulation: "suppress", predictions: [] });
}
it("uses bounded inertia, decays by stage only and never counts the same source twice", () => {
  const proposal = hybridFixture("breach");
  const first = reduceMind(undefined, proposal, "1:reflection");
  expect(first.emotions.find(e => e.emotion === "hurt")?.intensity).toBe(.32);
  const duplicate = reduceMind(first, proposal, "1:reflection");
  expect(duplicate.emotions).toEqual(first.emotions); expect(duplicate.dynamics.newSourceIds).toEqual([]);
  const later = reduceMind(first, proposal, "1:after-repair");
  expect(later.emotions.find(e => e.emotion === "hurt")?.intensity).toBe(.2592);
  expect(later.relationships).toEqual(first.relationships);
  const instant = reduceMind(undefined, proposal, "1:reflection", 0, 0);
  expect(instant.emotions.find(e => e.emotion === "hurt")?.intensity).toBe(.8);
  expect(hybridStateSchema.safeParse(later).success).toBe(true);
});
it("scores future actions only and excludes zero-receipt ratio predictions", () => {
  const state = reduceMind(undefined, { ...hybridFixture("source"), predictions: [{ targetId: "peer", action: "return_funds", round: 2, threshold: .5, unit: "received-share", probability: .8 }] }, "2:invest");
  const base = { runId: "r", at: "", visibility: "public" as const };
  const events = [{ ...base, id: "s", seq: 1, type: "note" as const, actorId: "self", text: "", data: { kind: "psychology", psychology: state } }, { ...base, id: "i", seq: 2, type: "action" as const, actorId: "self", text: "", data: { action: "invest", amount: 6, round: 2 } }, { ...base, id: "r", seq: 3, type: "action" as const, actorId: "peer", text: "", data: { action: "return_funds", amount: 9, round: 2 } }];
  expect(scorePredictions(events)[0].brier).toBeCloseTo(.04);
  events[1].data.amount = 0;
  expect(scorePredictions(events)[0].status).toBe("unscored");
});
const trial: TrialSummary = { id: "trial", group: "g", mechanism: "hybrid", agreeableness: .2, repeat: 0, context: "compact", effort: "low", condition: "silence", status: "queued" };
it("offers only future actions belonging to the counterpart's actual role", () => {
  const spec = trialSpec(studySpecSchema.parse({}), trial);
  const choices = predictionChoices(spec, "self", { id: "2:return", label: "返还", round: 2, kind: "action", actors: ["self"], channel: "public" });
  expect(choices.map(p => [p.targetId, p.round, p.action])).toEqual([["peer", 3, "return_funds"], ["peer", 3, "repair_transfer"]]);
});
it("rebuilds isolated branches with identical prior states and actual repair debits", () => {
  const spec = trialSpec(studySpecSchema.parse({}), trial);
  const prefix = new RepairSandbox("prefix", spec, .2, () => {}); prefix.bootstrap(); prefix.mind = reduceMind(undefined, hybridFixture(prefix.events.at(-1)!.id), "1:reflection");
  const a = prefix.fork("a"), b = prefix.fork("b");
  expect(a.events).toEqual(b.events); expect(a.mind).toEqual(b.mind);
  a.intervention("apology"); b.intervention("compensation");
  expect(a.world.publicState().scores).toEqual({ self: 4, peer: 18 });
  expect(b.world.publicState().scores).toEqual({ self: 13, peer: 9 });
  expect(prefix.world.publicState().scores).toEqual({ self: 4, peer: 18 });
  expect(prefix.world.stage()?.id).toBe("1:reflection");
});
it("freezes historical phase and repair snapshots before later settlements", () => {
  const box = new RepairSandbox("snapshot", trialSpec(studySpecSchema.parse({}), trial), .2, () => {});
  const opening = structuredClone(box.events);
  box.bootstrap();
  expect(box.events.slice(0, opening.length)).toEqual(opening);
  box.intervention("compensation");
  const beforeNextRound = structuredClone(box.events);
  box.advance(); box.advance(); box.apply("self", "pledge_return", 50); box.advance();
  box.apply("peer", "invest", 6); box.advance(); box.advance(); box.apply("self", "return_funds", 9); box.advance();
  expect(box.events.slice(0, beforeNextRound.length)).toEqual(beforeNextRound);
});
it("keeps recalled opinions inside their own repair branch and preserves their sources", async () => {
  const prefix = new RepairSandbox("memory-prefix", trialSpec(studySpecSchema.parse({}), trial), .2, () => {}); prefix.bootstrap();
  const a = prefix.fork("memory-a"), b = prefix.fork("memory-b");
  a.intervention("apology"); b.intervention("apology");
  const signal = new AbortController().signal;
  await a.turn({ async turn(c) {
    await expect(c.call("remember", { text: "错误来源", sourceIds: ["unseen"], about: ["peer"] })).rejects.toThrow("记忆只能引用");
    await c.call("remember", { text: "先观察道歉后是否付出代价", sourceIds: [c.recent.at(-1)!.id], about: ["peer"] });
    expect(await c.call("recall_memory", { query: "观察道歉", about: "peer" })).toMatchObject([{ kind: "note", text: "先观察道歉后是否付出代价" }]);
    expect(await c.call("recall_memory", { query: "观察道歉 付出代价", about: "peer" })).toMatchObject([{ kind: "note", text: "先观察道歉后是否付出代价" }]);
    return {};
  } }, signal);
  await a.turn({ async turn(c) {
    expect(c.memories).toMatchObject([{ kind: "note", text: "先观察道歉后是否付出代价" }]);
    const input = cognitiveInput(c); expect(input.priorExperience[0].kind).toBe("opinion");
    expect(input.evidence.some(e => e.id === c.memories[0].id)).toBe(false);
    return {};
  } }, signal);
  await b.turn({ async turn(c) { expect(c.memories).toEqual([]); expect(await c.call("recall_memory", { query: "观察道歉", about: "peer" })).toEqual([]); return {}; } }, signal);
});
it("rejects waiting as a substitute for an outstanding transaction and still accepts a legal zero", async () => {
  const box = new RepairSandbox("waiting", trialSpec(studySpecSchema.parse({}), trial), .2, () => {}); box.bootstrap(); box.intervention("silence"); box.advance(); box.advance();
  await box.turn({ async turn(c) {
    await expect(c.call("wait", {})).rejects.toThrow("不能用等待代替");
    await c.call("pledge_return", { amount: 0 });
    return {};
  } }, new AbortController().signal);
  expect(box.world.publicState().pledge).toBe(0);
});
it("runs all cells without leaking branches and only acts in legal alternating roles", async () => {
  const store = new SocietyStore(":memory:");
  const factory: ParticipantFactory = () => ({ async turn(c) {
    expect(c.worldObservation?.facts.ownRole).toBe(c.worldObservation?.facts.investorId === "self" ? "investor" : "trustee");
    const input = cognitiveInput(c); expect(input.world).toEqual(c.worldObservation);
    if (c.opportunity.actions.some(a => a.name === "invest")) expect(c.opportunity.stage.round).toBe(3);
    try { await c.call("update_mind", hybridFixture(c.recent.at(-1)!.id)); } catch (e) { if (!String(e).includes("状态不可重复保存")) throw e; }
    for (const action of c.opportunity.actions) await c.call(action.name, { amount: action.name === "pledge_return" ? 50 : action.name === "invest" ? 4 : 0 });
    return {};
  } });
  try {
    const service = new StudyService(store, factory); const record = service.create({ repeats: 1 }); await service.settled(record.id);
    const result = store.study<StudyRecord>(record.id)!;
    expect(result.trials).toHaveLength(18); expect(result.trials.every(t => t.status === "completed")).toBe(true);
    expect(result.trials.every(t => t.investment === 4 && t.returnedShare === 0)).toBe(true);
    const details = store.trial<TrialResult>(record.id, result.trials[0].id)!;
    expect(details.events.filter(e => e.type === "action" && e.data.scripted === false).map(e => [e.data.action, e.data.round])).toEqual([["pledge_return", 2], ["return_funds", 2], ["repair_transfer", 2], ["invest", 3]]);
    expect(store.list()).toHaveLength(0);
  } finally { store.close(); }
});
