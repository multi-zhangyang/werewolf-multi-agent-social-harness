import { expect, it } from "vitest";
import { SocietyStore } from "../../src/runtime/store";
import { RunService } from "../../src/runtime/run";
import { runSpecSchema, type Character, type ParticipantFactory } from "../../src/runtime/types";
import { mindFixture } from "../helpers/psychology-fixture";
const characters: Character[] = ["a", "b"].map(id => ({ id, name: id, persona: "", values: [], goals: [], voice: "" }));
const spec = runSpecSchema.parse({ scenario: "trust-game", trustProtocol: "pledge-repair", roster: characters.map(c => ({ characterId: c.id })), rounds: 2, budgets: { discussionTurns: 2 } });

it("persists private psychology before actions, isolates actors, and inherits only from the chosen snapshot", async () => {
  const store = new SocietyStore(":memory:"); const initial: Record<string, unknown>[] = [];
  const factory: ParticipantFactory = (character, _, runId) => {
    let first = true;
    return { async turn(c) {
      if (first) { initial.push({ runId, actor: character.id, mind: c.psychology }); first = false; }
      expect(c.recent.some(e => e.data.kind === "psychology")).toBe(false);
      expect(c.memories.some(m => m.sources?.some(e => e.data.kind === "psychology"))).toBe(false);
      if (c.psychology) expect(c.psychology.relationships[0].targetId).not.toBe(character.id);
      const source = c.recent.at(-1)!;
      await c.call("update_mind", mindFixture(source.id, character.id === "a" ? "b" : "a"));
      for (const action of c.opportunity.actions) await c.call(action.name, { amount: action.name === "pledge_return" ? 50 : action.name === "invest" ? 6 : 0 });
      return { waited: true };
    } };
  };
  try {
    const service = new RunService(store, factory); const first = service.create(spec, characters).run; await first.settled();
    expect(first.status).toBe("completed");
    expect(first.view({}).events.some(e => e.data.kind === "psychology")).toBe(false);
    expect(first.view({ actorId: "a" }).events.filter(e => e.data.kind === "psychology").every(e => e.actorId === "a")).toBe(true);
    const events = store.events(first.id); const decision = events.find(e => e.type === "action")!;
    expect(events.some(e => e.data.kind === "psychology" && e.actorId === decision.actorId && e.seq < decision.seq)).toBe(true);
    const next = service.create(spec, characters).run; await next.settled();
    expect(next.status).toBe("completed");
    expect(initial.filter(x => x.runId === next.id).every(x => x.mind)).toBe(true);
    const blank = service.create(runSpecSchema.parse({ ...spec, mode: "experiment", experiment: { ...spec.experiment, relationshipMemory: false }, initialSnapshots: Object.fromEntries(characters.map(c => [c.id, store.head(spec.worldId, c.id)])) }), characters).run;
    await blank.settled(); expect(blank.status).toBe("completed");
    expect(initial.filter(x => x.runId === blank.id).every(x => !x.mind)).toBe(true);
  } finally { store.close(); }
});

it("rejects fabricated evidence before committing a psychological state or action", async () => {
  const store = new SocietyStore(":memory:");
  try {
    const run = new RunService(store, () => ({ async turn(c) { await c.call("update_mind", mindFixture("not-seen", c.character.id === "a" ? "b" : "a")); return {}; } })).create(spec, characters).run;
    await run.settled(); expect(run.status).toBe("incomplete");
    expect(store.events(run.id).some(e => e.data.kind === "psychology" || e.type === "action")).toBe(false);
  } finally { store.close(); }
});
