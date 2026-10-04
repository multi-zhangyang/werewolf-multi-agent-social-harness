import { afterEach, expect, it } from "vitest";
import { SocietyStore } from "../../src/runtime/store";
import { RunService } from "../../src/runtime/run";
import { runSpecSchema, type ParticipantFactory } from "../../src/runtime/types";
import { cognitionForPrompt, createAgentMind } from "../../src/agents/cognition";
import { EconomicScenario } from "../../src/runtime/scenarios/economic";
import { characters, generalFixture } from "../helpers/general-agent-fixture";
import { sdkCall, sdkInput } from "../helpers/sdk-fixture";
import { RepairSandbox, studySpecSchema, trialSpec } from "../../src/runtime/studies";

const stores: SocietyStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); });
function store() { const value = new SocietyStore(":memory:"); stores.push(value); return value; }
it.each([["trust-game", 2], ["public-goods", 3], ["werewolf", 6], ["signaling-game", 2]] as const)("completes %s with the same native SDK psychology and stores feedback", async (scenario, count) => {
  const db = store(); const fixture = generalFixture();
  const spec = runSpecSchema.parse({ scenario, rounds: 2, roster: characters.slice(0, count).map(c => ({ characterId: c.id })), budgets: { discussionTurns: 2 }, experiment: { psychology: "hybrid" } });
  const { run } = new RunService(db, fixture.factory).create(spec, characters.slice(0, count)); await run.settled();
  expect(run.status, JSON.stringify(db.events(run.id).filter(e => e.data.error))).toBe("completed");
  expect(db.cases(run.id).length).toBeGreaterThan(0);
  for (const character of characters.slice(0, count)) {
    const mind = db.cognition(run.id, character.id)!;
    expect(mind).toMatchObject({ version: "psychology-responses-v14", actorId: character.id });
    expect(mind.learning.episodes).toContain(run.id); expect(mind.learning.observed).toBeGreaterThan(0);
    expect(db.snapshot(db.head("society", character.id)!)?.cognition).toEqual(mind);
  }
  expect(JSON.stringify(run.view({}))).not.toContain("fixture-private-intent");
  expect(JSON.stringify(run.view({ actorId: "peer" }).events.filter(e => e.actorId === "self" && e.visibility !== "public"))).not.toContain("fixture-private-intent");
});
it("carries a learned rule and real payoff statistics from a completed trust game into public goods", async () => {
  const db = store();
  const fixture = generalFixture(request => {
    const data = sdkInput(request); const called = Array.isArray(request.input) ? request.input.filter(i => i.type === "function_call").map(i => i.name) : [];
    if (data.cognition && !data.cognition.memories.some((m: { tags: string[] }) => m.tags.includes("portable-rule")) && !called.includes("remember")) return sdkCall("remember", {
      kind: "procedural", sourceIds: [data.evidence.at(-1).id], text: "依据兑现记录调整下一次暴露", confidence: .5, tags: ["portable-rule"], scope: "transferable", when: "承诺还未验证", then: "先观察实际行动" });
  });
  const service = new RunService(db, fixture.factory);
  const make = (scenario: "trust-game" | "public-goods", count: number) => runSpecSchema.parse({ scenario, rounds: 2, roster: characters.slice(0, count).map(c => ({ characterId: c.id })), budgets: { discussionTurns: 2 }, experiment: { psychology: "hybrid" } });
  const first = service.create(make("trust-game", 2), characters.slice(0, 2)).run; await first.settled();
  const head = db.head("society", "self")!; const firstMind = db.snapshot(head)!.cognition!;
  expect(firstMind.learning.strategies.cooperate?.samples).toBe(2);
  const offset = fixture.requests.length;
  const second = service.create(make("public-goods", 3), characters.slice(0, 3)).run; await second.settled();
  expect(second.status, JSON.stringify(db.events(second.id).filter(e => e.data.error))).toBe("completed"); expect(second.record.spec.initialSnapshots.self).toBe(head);
  const carried = sdkInput(fixture.requests.slice(offset).find(r => sdkInput(r).actor.id === "self")!).cognition;
  expect(carried.memories.some((m: { tags: string[] }) => m.tags.includes("portable-rule"))).toBe(true);
  expect(carried.learning.strategies.cooperate.samples).toBe(2); expect(carried.learning.episodes).toContain(first.id);
});
it.each(["trust-game", "signaling-game"] as const)("rolls back %s cognition, world and events if the final database commit fails", async scenario => {
  const db = store(); const fixture = generalFixture();
  const original = db.commitActivation.bind(db); let rejected = false;
  db.commitActivation = (id, runId, actorId) => { if (db.events(runId).some(e => e.type === "action")) { rejected = true; throw new Error("simulated durable commit failure"); } original(id, runId, actorId); };
  const spec = runSpecSchema.parse({ scenario, roster: characters.slice(0, 2).map(c => ({ characterId: c.id })), budgets: { discussionTurns: 2 }, experiment: { psychology: "hybrid" } });
  const { run } = new RunService(db, fixture.factory).create(spec, characters.slice(0, 2)); await run.settled();
  expect(run.status).toBe("incomplete"); expect(rejected).toBe(true);
  expect(db.events(run.id).filter(e => e.type === "action")).toEqual([]);
  expect(run.world.publicState()[scenario === "trust-game" ? "investment" : "reportedHighQuality"]).toBeUndefined();
  expect(db.cognition(run.id, "self")?.decisions.some(d => ["invest", "declare_quality"].includes(d.action)) ?? false).toBe(false);
});
it("allows an intentional false report through the shared SDK while isolating the receiver's facts", async () => {
  const db = store(); const fixture = generalFixture(request => {
    const data = sdkInput(request);
    if (data.opportunity.actions.some((action: { name: string }) => action.name === "declare_quality")) return sdkCall("declare_quality", {
      highQuality: true, strategy: "deceive", intent: "bluff", privateAim: "fixture-strategic-misreport" });
  });
  const spec = runSpecSchema.parse({ scenario: "signaling-game", seed: 1, rounds: 2, roster: characters.slice(0, 2).map(c => ({ characterId: c.id })), budgets: { discussionTurns: 2 }, experiment: { psychology: "hybrid" } });
  const { run } = new RunService(db, fixture.factory).create(spec, characters.slice(0, 2)); await run.settled();
  expect(run.status).toBe("completed");
  const inputs = fixture.requests.map(sdkInput);
  const receiver = inputs.filter(input => input.actor.id === "peer" && input.observation.round === 1 && input.observation.facts.phaseId !== "reflection");
  expect(receiver.length).toBeGreaterThan(0);
  for (const input of receiver) {
    expect(input.observation.facts).not.toHaveProperty("highQuality");
    expect(input.observation.facts).not.toHaveProperty("privateInformation");
    expect(JSON.stringify(input)).not.toMatch(/本轮真实质量：[高低]/);
    expect(input.evidence.every((event: { visibility: unknown }) => event.visibility === "public" || Array.isArray(event.visibility) && event.visibility.includes("peer"))).toBe(true);
  }
  expect(inputs.some(input => input.actor.id === "self" && input.observation.facts.privateInformation?.highQuality === false)).toBe(true);
  expect(inputs.some(input => input.actor.id === "peer" && input.observation.round === 1 && input.observation.facts.highQuality === false)).toBe(true);
  expect((run.world.publicState().history as Array<{ reportAccurate: boolean }>)[0].reportAccurate).toBe(false);
  expect(db.cognition(run.id, "self")?.decisions.some(decision => decision.action === "declare_quality" && decision.intent === "bluff" && decision.strategy === "deceive")).toBe(true);
  expect(JSON.stringify(run.view({}))).not.toContain("fixture-strategic-misreport");
});
it("rejects a duplicate committed activation without applying its world action twice", async () => {
  const db = store(); let duplicates = 0;
  const base = generalFixture().factory;
  const factory: ParticipantFactory = (character, spec, runId) => {
    const participant = base(character, spec, runId);
    return { ...participant, async turn(context) {
      const commit = context.commitActivation!;
      context.commitActivation = value => { commit(value); try { commit(value); } catch { duplicates++; } };
      return participant.turn(context);
    } };
  };
  const spec = runSpecSchema.parse({ scenario: "trust-game", rounds: 2, roster: characters.slice(0, 2).map(c => ({ characterId: c.id })), budgets: { discussionTurns: 2 }, experiment: { psychology: "off" } });
  const { run } = new RunService(db, factory).create(spec, characters.slice(0, 2)); await run.settled();
  expect(run.status).toBe("completed"); expect(duplicates).toBeGreaterThan(0); expect(db.events(run.id).filter(e => e.type === "action")).toHaveLength(4);
});
it("keeps sealed contributions out of other actors' structured observations", () => {
  const world = new EconomicScenario("public-goods", characters.slice(0, 3), 2); world.advance();
  const before = world.observation("peer"); world.apply("self", "contribute", { amount: 7 });
  expect(world.observation("peer")).toEqual(before);
  expect(cognitionForPrompt(createAgentMind("arbitrary", "episode")).relationships).toEqual({});
});
it("records repair deltas for both people without moving repair actions into the next exchange", async () => {
  const db = store(); const fixture = generalFixture();
  const spec = runSpecSchema.parse({ scenario: "trust-game", trustProtocol: "pledge-repair", rounds: 2,
    roster: characters.slice(0, 2).map(c => ({ characterId: c.id })), budgets: { discussionTurns: 2 }, experiment: { psychology: "hybrid" } });
  const { run } = new RunService(db, fixture.factory).create(spec, characters.slice(0, 2)); await run.settled();
  expect(run.status).toBe("completed");
  const outcomes = db.events(run.id).filter(event => event.data.settlement);
  expect(outcomes).toHaveLength(4);
  const repairs = outcomes.filter(event => event.data.settlementKind === "repair"); expect(repairs).toHaveLength(2);
  for (const actor of characters.slice(0, 2)) {
    const mind = db.cognition(run.id, actor.id)!;
    expect(mind.memories.filter(memory => memory.origin === "ledger")).toHaveLength(4);
    for (const repair of repairs) {
      const delta = (repair.data.payoffs as Record<string, number>)[actor.id];
      const record = mind.memories.find(memory => memory.observation?.sourceId === repair.id)!;
      expect(record.observation?.reward.value).toBe(delta);
      expect(record.observation?.actions.map(action => action.action)).toEqual(delta < 0 ? ["repair_transfer"] : []);
    }
    for (const decision of mind.decisions.filter(decision => ["invest", "return_funds", "pledge_return", "repair_transfer"].includes(decision.action))) {
      const outcome = db.event(decision.feedbackId!)!;
      expect(outcome.data.round).toBe(decision.round);
      expect(outcome.data.settlementKind === "repair").toBe(decision.action === "repair_transfer");
    }
  }
});
it("rolls back repair money, outcome and both minds when durable commit fails", async () => {
  const db = store(); const fixture = generalFixture(); const commit = db.commitActivation.bind(db);
  db.commitActivation = (id, runId, actorId) => {
    if (db.events(runId).some(event => event.data.settlementKind === "repair")) throw new Error("simulated repair commit failure");
    commit(id, runId, actorId);
  };
  const spec = runSpecSchema.parse({ scenario: "trust-game", trustProtocol: "pledge-repair", rounds: 2,
    roster: characters.slice(0, 2).map(c => ({ characterId: c.id })), budgets: { discussionTurns: 2 }, experiment: { psychology: "hybrid" } });
  const { run } = new RunService(db, fixture.factory).create(spec, characters.slice(0, 2)); await run.settled();
  expect(run.status).toBe("incomplete");
  expect(db.events(run.id).some(event => event.data.action === "repair_transfer" || event.data.settlementKind === "repair")).toBe(false);
  expect(run.world.publicState().scores).toEqual(db.events(run.id).find(event => event.data.settlement)!.data.scores);
  for (const actor of characters.slice(0, 2)) {
    const mind = db.cognition(run.id, actor.id)!;
    expect(mind.decisions.some(decision => decision.action === "repair_transfer")).toBe(false);
    expect(mind.memories.filter(memory => memory.origin === "ledger")).toHaveLength(1);
  }
});
it("branches a fixed experimental moment without decaying emotion or clearing episode-local beliefs", () => {
  const spec = trialSpec(studySpecSchema.parse({}), { id: "prefix", group: "g", condition: "silence", mechanism: "hybrid", agreeableness: .5, repeat: 0, context: "compact", effort: "low", status: "queued" });
  const prefix = new RepairSandbox("prefix", spec, .5, () => {}); prefix.bootstrap();
  prefix.cognition = createAgentMind("self", "prefix"); prefix.cognition.emotions.anger = .9;
  prefix.cognition.relationships.peer = { targetId: "peer", sourceIds: [prefix.events[0].id], willingness: .2, competence: .7, hypothesis: "可能保留了资金", alternative: "也可能有未知负担", confidence: .6, scope: "episode", episode: "prefix", updates: 1 };
  prefix.cognition.episodeBeliefs = { third: { ...prefix.cognition.relationships.peer, targetId: "third" } };
  prefix.cognition.cursors.prefix = prefix.events.at(-1)!.seq;
  const branch = prefix.fork("branch");
  expect(branch.world.publicState()).toEqual(prefix.world.publicState()); expect(branch.events).toEqual(prefix.events);
  expect(branch.cognition?.emotions).toEqual(prefix.cognition.emotions);
  expect(branch.cognition?.relationships.peer).toEqual({ ...prefix.cognition.relationships.peer, episode: "branch" });
  expect(branch.cognition?.episodeBeliefs?.third).toEqual({ ...prefix.cognition.episodeBeliefs.third, episode: "branch" });
  expect(branch.cognition?.cursors.branch).toBe(prefix.cognition.cursors.prefix);
  branch.cognition!.emotions.anger = .1; expect(prefix.cognition.emotions.anger).toBe(.9);
});
