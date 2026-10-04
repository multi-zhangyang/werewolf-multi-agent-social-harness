import { afterEach, expect, it } from "vitest";
import { RunService } from "../../src/runtime/run";
import { SocietyStore } from "../../src/runtime/store";
import { runSpecSchema, type ParticipantFactory, type TurnContext } from "../../src/runtime/types";
import { characters, generalFixture } from "../helpers/general-agent-fixture";
import { sdkInput } from "../helpers/sdk-fixture";

const stores: SocietyStore[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
function store() { const db = new SocietyStore(":memory:"); stores.push(db); return db; }
function spec() {
  return runSpecSchema.parse({ scenario: "trust-game", rounds: 2, roster: characters.slice(0, 2).map(character => ({ characterId: character.id })),
    budgets: { discussionTurns: 2 }, experiment: { psychology: "hybrid" } });
}

it("reviews each AI sequentially after all settlements, privately and without changing the world", async () => {
  const db = store(); const fixture = generalFixture(); const reviews: TurnContext[] = [];
  let inReview = 0; let maxConcurrent = 0; let finalWorld: unknown;
  const factory: ParticipantFactory = (character, input, id) => {
    const participant = fixture.factory(character, input, id);
    return { ...participant, async turn(context) {
      if (!context.episodeReview) return participant.turn(context);
      expect(run.world.stage()).toBeUndefined();
      expect(context).toMatchObject({ appraisalOnly: true, opportunity: { channel: "private", recipients: [character.id], actions: [], communications: [] } });
      expect(context.worldObservation?.stageId).toBe("done"); expect(context.observation).not.toContain("undefined");
      expect(context.recent.filter(event => event.data.settlement === true)).toHaveLength(2);
      expect(db.snapshots(character.id)).toEqual([]);
      finalWorld ??= structuredClone(run.world.publicState());
      expect(run.world.publicState()).toEqual(finalWorld);
      reviews.push(context); inReview++; maxConcurrent = Math.max(maxConcurrent, inReview);
      try { return await participant.turn(context); } finally { inReview--; }
    } };
  };
  const run = new RunService(db, factory).create(spec(), characters.slice(0, 2)).run; await run.settled();
  expect(run.status).toBe("completed"); expect(reviews.map(context => context.character.id)).toEqual(["self", "peer"]); expect(maxConcurrent).toBe(1);
  expect(run.world.publicState()).toEqual(finalWorld);
  const events = db.events(run.id); const lastOutcome = events.findLast(event => event.data.settlement === true)!;
  const notes = events.filter(event => event.type === "note" && event.data.episodeReview);
  expect(notes).toHaveLength(2);
  for (const note of notes) {
    expect(note.seq).toBeGreaterThan(lastOutcome.seq); expect(note.visibility).toEqual([note.actorId]);
    expect(run.view({}).events.some(event => event.id === note.id)).toBe(false);
    expect(run.view({ actorId: note.actorId === "self" ? "peer" : "self" }).events.some(event => event.id === note.id)).toBe(false);
  }
  for (const context of reviews) {
    expect(db.activationCommitted(context.opportunity.id)).toBe(true);
    const mind = db.cognition(run.id, context.character.id)!;
    expect(mind.episodeReviews).toHaveLength(1); expect(mind.episodeReviews![0].status).toBe("insufficient");
    expect(db.snapshot(db.head("society", context.character.id)!)?.cognition).toEqual(mind);
  }
});

it.each(["uncommitted", "world-call", "forged-action", "forged-message", "wrong-actor", "commit-failure", "provider-failure", "cancel"])("does not advance snapshots or leak review state on %s", async failure => {
  const db = store(); let beforeMind: unknown; let beforeWorld: unknown; let opportunityId = "";
  const fixture = generalFixture(request => { if (failure === "provider-failure" && sdkInput(request).episodeReview) throw new Error("review provider failure"); });
  const factory: ParticipantFactory = (character, input, id) => {
    const participant = fixture.factory(character, input, id);
    return { ...participant, async turn(context) {
      if (!context.episodeReview) return participant.turn(context);
      beforeMind = structuredClone(db.cognition(id, character.id)); beforeWorld = structuredClone(run.world.publicState()); opportunityId = context.opportunity.id;
      if (failure === "uncommitted") return {};
      if (failure === "cancel") { run.control("stop"); return {}; }
      if (failure === "world-call") { await context.call("remember", { text: "illegal-review-write", sourceIds: [], about: [] }); return {}; }
      if (failure === "commit-failure") db.commitActivation = () => { throw new Error("review durable commit failure"); };
      if (["forged-action", "forged-message", "wrong-actor"].includes(failure)) {
        const commit = context.commitActivation!;
        context.commitActivation = activation => commit({ ...activation,
          ...(failure === "forged-action" ? { calls: [{ name: "invest", args: { amount: 10 } }] } : {}),
          ...(failure === "forged-message" ? { text: "illegal-review-public-message" } : {}),
          ...(failure === "wrong-actor" ? { actorId: "peer" } : {}),
        });
      }
      return participant.turn(context);
    } };
  };
  const run = new RunService(db, factory).create(spec(), characters.slice(0, 2)).run; await run.settled();
  expect(opportunityId).not.toBe(""); expect(run.status).toBe(failure === "cancel" ? "stopped" : "incomplete");
  expect(db.activationCommitted(opportunityId)).toBe(false); expect(db.cognition(run.id, "self")).toEqual(beforeMind);
  expect(run.world.publicState()).toEqual(beforeWorld);
  expect(db.events(run.id).filter(event => event.type === "note" && event.data.episodeReview)).toEqual([]);
  for (const character of characters.slice(0, 2)) { expect(db.head("society", character.id)).toBeUndefined(); expect(db.snapshots(character.id)).toEqual([]); }
  expect(JSON.stringify(run.view({}))).not.toMatch(/illegal-review|review-private/);
});

it("keeps legacy participants compatible and skips review when psychology is off", async () => {
  const db = store(); const seen: TurnContext[] = [];
  const legacy: ParticipantFactory = () => ({ async turn(context) {
    seen.push(context); for (const action of context.opportunity.actions) await context.call(action.name, { amount: 0 }); return { waited: !context.opportunity.actions.length };
  } });
  const legacyRun = new RunService(db, legacy).create(spec(), characters.slice(0, 2)).run; await legacyRun.settled();
  expect(legacyRun.status).toBe("completed"); expect(seen.some(context => context.episodeReview)).toBe(false);
  const fixture = generalFixture(); const input = spec(); input.experiment.psychology = "off"; input.mode = "experiment";
  const off = new RunService(db, fixture.factory).create(input, characters.slice(0, 2)).run; await off.settled();
  expect(off.status).toBe("completed"); expect(fixture.requests.some(request => sdkInput(request).episodeReview)).toBe(false);
});

it("does not create a terminal human opportunity or wait for a human review", async () => {
  const db = store(); const fixture = generalFixture(); const input = spec(); input.roster[1].human = true;
  const run = new RunService(db, fixture.factory).create(input, characters.slice(0, 2)).run;
  for (let step = 0; step < 200 && run.status === "running"; step++) {
    const opportunity = run.view({ actorId: "peer" }).opportunities[0];
    if (opportunity) {
      expect(opportunity.stage.id).not.toBe("episode-review");
      const action = opportunity.actions[0];
      await run.humanAction("peer", { opportunityId: opportunity.id, action: action?.name ?? "wait", input: action ? { amount: 0 } : {} });
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  if (run.status === "running") run.control("stop");
  await run.settled(); expect(run.status).toBe("completed");
  expect(db.cognition(run.id, "self")?.episodeReviews).toHaveLength(1); expect(db.cognition(run.id, "peer")?.episodeReviews).toHaveLength(0);
});
