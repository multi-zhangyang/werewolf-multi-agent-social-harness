import { expect, it } from "vitest";
import { SocietyStore } from "../../src/runtime/store";
import { RunService } from "../../src/runtime/run";
import { runSpecSchema, visible } from "../../src/runtime/types";
import { hybridProposalSchema, isHybrid } from "../../src/runtime/psychology";
import { psychologySetupSchema, setupInstructions } from "../../src/runtime/psychology-setup";
import { mindFixture } from "../helpers/psychology-fixture";
import { commitmentAudit } from "../../src/runtime/commitment-audit";

const characters = ["a", "b"].map(id => ({ id, name: id, persona: "", goals: [], values: [], voice: "" }));
const base = { scenario: "trust-game", trustProtocol: "pledge-repair", mode: "experiment", rounds: 2, roster: characters.map(c => ({ characterId: c.id })), budgets: { discussionTurns: 2 }, experiment: { psychology: "hybrid" } };
const setup = psychologySetupSchema.parse({ motivation: "gain", emotion: "anger", intensity: .8, objective: "本人私下目标", relationship: { targetId: "b", willingness: .2, competence: .9 } });

it("rejects invalid intervention ownership and incompatible modes", () => {
  for (const input of [
    { ...base, mode: "continuity", psychologySetup: { a: setup } },
    { ...base, experiment: { psychology: "off" }, psychologySetup: { a: setup } },
    { ...base, psychologySetup: { unknown: setup } },
    { ...base, roster: [{ characterId: "a", human: true }, { characterId: "b" }], psychologySetup: { a: setup } },
    { ...base, psychologySetup: { a: { ...setup, relationship: { ...setup.relationship, targetId: "a" } } } },
  ]) expect(runSpecSchema.safeParse(input).success).toBe(false);
});

it("applies the private initial state before appraisal, then reduces it and keeps it out of the opponent and public views", async () => {
  const store = new SocietyStore(":memory:");
  const spec = runSpecSchema.parse({ ...base, psychologySetup: { a: setup } });
  let checked = false; let observedReduction = false;
  const service = new RunService(store, () => ({ async turn(c) {
    if (c.character.id === "a" && !checked) {
      checked = true;
      expect(c.psychology?.emotions).toContainEqual({ emotion: "anger", intensity: .8 });
      expect(c.psychology?.relationships[0]).toMatchObject({ willingness: .2, competence: .9 });
      expect(c.worldObservation?.facts.ownScore).toBe(0);
      expect(setupInstructions(spec, "a").join()).toContain("本人私下目标");
    }
    if (c.character.id === "b") {
      expect(JSON.stringify(c)).not.toContain("本人私下目标");
      expect(setupInstructions(spec, "b")).toEqual([]);
    }
    const source = c.recent.findLast(e => e.data.identityScope) ?? c.recent.findLast(e => ["fact", "action", "message"].includes(e.type))!;
    const proposal = hybridProposalSchema.parse({ ...mindFixture(source.id, "b"), relationships: [], emotions: [{ emotion: "anger", intensity: 1 }], conflict: "收益与关系", regulation: "none", predictions: [],
      ...(c.opportunity.actions.some(a => a.name === "pledge_return") ? { commitmentIntent: { plannedReturnPercent: 20, expectedInvestment: 6, purpose: "尽量保留收益" } } : {}) });
    const canonical = await c.call("update_mind", proposal);
    if (c.character.id === "a" && c.opportunity.stage.id === "1:discussion" && !observedReduction) {
      expect(isHybrid(canonical as any) && (canonical as any).emotions.find((e: any) => e.emotion === "anger").intensity).toBe(.88);
      observedReduction = true;
    }
    for (const action of c.opportunity.actions) await c.call(action.name, { amount: action.name === "pledge_return" ? 80 : action.name === "invest" ? 6 : 0 });
    return { waited: true };
  } }));
  try {
    const { run } = service.create(spec, characters); await run.settled();
    expect(run.status, JSON.stringify(store.events(run.id).findLast(e => e.data.error))).toBe("completed"); expect(checked && observedReduction).toBe(true);
    const events = store.events(run.id);
    expect(events.filter(e => e.data.origin === "researcher-intervention")).toHaveLength(1);
    expect(JSON.stringify(events.filter(e => visible(e, {})))).not.toContain("本人私下目标");
    expect(JSON.stringify(events.filter(e => visible(e, { actorId: "b" })))).not.toContain("本人私下目标");
    const audit = commitmentAudit(events);
    expect(audit).toHaveLength(2);
    expect(audit.every(row => row.promiseAbovePlan && row.status === "breached")).toBe(true);
    const original = JSON.stringify(store.get(run.id));
    const clone = service.create(runSpecSchema.parse({ ...spec, psychologySetup: {} }), characters); await clone.run.settled();
    expect(JSON.stringify(store.get(run.id))).toBe(original);
  } finally { service.stopAll(); store.close(); }
});

it("does not backfill intent from a later state or infer deception from a low return", () => {
  const event = (id: string, seq: number, type: "action" | "fact", data: Record<string, unknown>) => ({ id, seq, type, actorId: "a", runId: "r", at: "", text: "", visibility: "public" as const, data });
  const audit = commitmentAudit([event("pledge", 1, "action", { action: "pledge_return", amount: 80, round: 1 }), event("settled", 3, "fact", { round: 1, commitment: { actorId: "a", promised: 14, returned: 0, kept: false } })]);
  expect(audit[0]).toMatchObject({ status: "breached", promiseAbovePlan: undefined, plannedPercent: undefined });
});
