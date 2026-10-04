import { afterEach, describe, expect, it } from "vitest";
import { SocietyStore } from "../../src/runtime/store";
import { RunService, replayView } from "../../src/runtime/run";
import { runSpecSchema, type Character, type ParticipantFactory, type TurnContext } from "../../src/runtime/types";
import { EconomicScenario } from "../../src/runtime/scenarios/economic";
import { WerewolfScenario } from "../../src/runtime/scenarios/werewolf";

const characters: Character[] = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `人物${i}`, persona: "愿意合作但重视边界", values: ["公平"], goals: ["彼此了解"], voice: "自然简短" }));
const stores: SocietyStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function setup(factory: ParticipantFactory) { const store = new SocietyStore(":memory:"); stores.push(store); return new RunService(store, factory); }
function spec(scenario: "trust-game" | "public-goods" | "werewolf" = "trust-game", n = 2) {
  return runSpecSchema.parse({ scenario, roster: characters.slice(0, n).map(c => ({ characterId: c.id })), rounds: 2, budgets: { discussionTurns: 8 } });
}
async function act(context: TurnContext) {
  for (const a of context.opportunity.actions) {
    const field = a.fields[0];
    const value = field.type === "number" ? Math.min(field.max!, 5) : field.options!.find(o => o.value === false || o.value === null)?.value ?? field.options![0].value;
    await context.call(a.name, { [field.name]: value });
  }
  return {};
}
const quiet: ParticipantFactory = () => ({ turn: context => context.opportunity.actions.length ? act(context) : Promise.resolve({ waited: true }) });

describe("Society v2", () => {
  it("allows silence in discussion but requires explicit zero actions during transactions", async () => {
    const service = setup(() => ({ async turn(c) {
      if (!c.opportunity.actions.length) { await c.call("wait", {}); return {}; }
      await expect(c.call("wait", {})).rejects.toThrow("不能用等待代替");
      for (const action of c.opportunity.actions) await c.call(action.name, { amount: 0 });
      return {};
    } }));
    const input = spec(); input.mode = "experiment"; input.rounds = 1;
    const run = service.create(input, characters.slice(0, 2)).run; await run.settled();
    expect(run.status).toBe("completed");
    expect(service.store.events(run.id).filter(e => e.type === "action").map(e => e.data.amount)).toEqual([0, 0]);
  });
  it("settles exact economic rules, rejects duplicates, and seals public goods choices", () => {
    const world = new EconomicScenario("public-goods", characters.slice(0, 3), 2);
    world.advance();
    expect(world.apply("c0", "contribute", { amount: 10 })[0].visibility).toEqual(["c0"]);
    expect(() => world.apply("c0", "contribute", { amount: 1 })).toThrow();
    expect(world.publicState()).not.toHaveProperty("amounts");
    world.apply("c1", "contribute", { amount: 0 }); world.apply("c2", "contribute", { amount: 5 });
    const events = world.advance();
    expect(events[0].data.payoffs).toEqual({ c0: 8, c1: 18, c2: 13 });
    const trust = new EconomicScenario("trust-game", characters.slice(0, 2), 2);
    trust.advance(); trust.apply("c0", "invest", { amount: 10 }); trust.advance(); trust.advance();
    expect(trust.actions("c1")[0].fields[0].max).toBe(30);
    trust.apply("c1", "return_funds", { amount: 15 });
    expect(trust.advance()[0].data.payoffs).toEqual({ c0: 15, c1: 15 });
  });
  it("speaks without tools, initiates private contact, remembers evidence, and keeps sessions independent", async () => {
    const instances: string[] = [];
    const service = setup(character => {
      instances.push(character.id); let spoke = false; let contacted = false; let noted = false;
      return { async turn(c) {
        expect(c.character.id).toBe(character.id);
        if (c.opportunity.actions.length) return act(c);
        if (!contacted && character.id === "c0") {
          contacted = true; await c.call("send_message", { channel: "private", recipients: ["c1"], text: "这次我愿意先信你。" }); return {};
        }
        if (!spoke && c.opportunity.channel === "public") {
          spoke = true;
          return { text: "上次你说要慢慢来，我想先听听你的打算。" };
        }
        if (!noted && c.recent.some(e => e.type === "message")) {
          const source = c.recent.find(e => e.type === "message")!; noted = true;
          await c.call("remember", { text: "对方愿意慢慢建立信任，我想先观察。", sourceIds: [source.id], about: [character.id === "c0" ? "c1" : "c0"] });
        }
        return { waited: true };
      } };
    });
    const { run } = service.create(spec(), characters.slice(0, 2)); await run.settled();
    expect(run.status).toBe("completed"); expect(instances).toEqual(["c0", "c1"]);
    const publicEvents = run.view({}).events;
    expect(publicEvents.filter(e => e.type === "message").length).toBeGreaterThan(0);
    expect(publicEvents.some(e => e.text === "这次我愿意先信你。")).toBe(false);
    expect(run.view({ actorId: "c1" }).events.some(e => e.text === "这次我愿意先信你。")).toBe(true);
    expect(service.store.head("society", "c0")).toBeTruthy();
    expect(service.store.recall("c0", run.memories("c0"), "建立信任")).toHaveLength(1);
    expect(replayView(service.store.get(run.id)!, service.store, {}).events).toEqual(publicEvents);
  });
  it("forks immutable snapshots without writing back, and excludes other actors' memories", async () => {
    const service = setup(quiet);
    const first = service.create(spec(), characters.slice(0, 2)).run; await first.settled();
    const head = service.store.head("society", "c0")!;
    const experiment = spec(); experiment.mode = "experiment"; experiment.initialSnapshots = { c0: head };
    const fork = service.create(experiment, characters.slice(0, 2)).run; await fork.settled();
    expect(service.store.head("society", "c0")).toBe(head);
    expect(fork.memories("c0").every(m => m.characterId === "c0")).toBe(true);
    expect(fork.memories("c1").every(m => m.runId === fork.id)).toBe(true);
    const continued = service.create(spec(), characters.slice(0, 2)).run; await continued.settled();
    expect(continued.record.spec.initialSnapshots.c0).toBe(head);
  });
  it("rejects concurrent world writers and never commits late model results after cancellation", async () => {
    let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    const service = setup(() => ({ async turn(c) { await pending; await c.call("remember", { text: "迟到结果", sourceIds: [c.recent[0].id], about: [] }); return { text: "迟到发言" }; } }));
    const run = service.create(spec(), characters.slice(0, 2)).run;
    expect(() => service.create(spec(), characters.slice(0, 2))).toThrow("已有");
    run.control("stop"); const count = service.store.events(run.id).length; release(); await run.settled();
    expect(service.store.events(run.id)).toHaveLength(count);
    expect(service.store.head("society", "c0")).toBeUndefined();
  });
  it("starts continuations with observed past results and ablates their exposure without changing the snapshot", async () => {
    const seen: TurnContext[] = [];
    const service = setup(() => ({ async turn(c) { seen.push(c); return c.opportunity.actions.length ? act(c) : { waited: true }; } }));
    const first = service.create(spec(), characters.slice(0, 2)).run; await first.settled();
    const head = service.store.head("society", "c0")!; seen.length = 0;
    const next = spec(); next.mode = "experiment"; next.initialSnapshots = { c0: head };
    const second = service.create(next, characters.slice(0, 2)).run; await second.settled();
    expect(seen[0].memories.some(m => m.runId === first.id && m.kind === "experience")).toBe(true);
    expect(seen[0].memories.every(m => m.characterId === "c0")).toBe(true);
    expect(seen[0].memories.every(m => m.sources?.every(e => e.runId === first.id && (e.visibility === "public" || e.visibility.includes("c0"))))).toBe(true);
    expect(seen[0].memories.some(m => m.sources?.some(e => e.type === "action"))).toBe(true);
    next.experiment.relationshipMemory = false; seen.length = 0;
    const without = service.create(next, characters.slice(0, 2)).run; await without.settled();
    expect(seen.every(c => c.memories.length === 0)).toBe(true); expect(service.store.head("society", "c0")).toBe(head);
  });
  it("marks missing required actions incomplete without substituting a decision", async () => {
    const service = setup(() => ({ turn: async () => ({ waited: true }) }));
    const run = service.create(spec(), characters.slice(0, 2)).run; await run.settled();
    expect(run.status).toBe("incomplete");
    expect(run.view({}).events.some(e => e.type === "action")).toBe(false);
  });
  it("prioritizes an explicit public addressee and ends when everyone waits", async () => {
    const order: string[] = []; let sent = false;
    const service = setup(() => ({ async turn(c) {
      if (c.opportunity.actions.length) return act(c);
      if (c.opportunity.stage.id === "1:discussion") {
        order.push(c.character.id);
        if (!sent) { sent = true; return { text: "人物2，你怎么看？" }; }
      }
      return { waited: true };
    } }));
    const run = service.create(spec("public-goods", 3), characters.slice(0, 3)).run; await run.settled();
    expect(run.status).toBe("completed"); expect(order).toEqual(["c0", "c2", "c1", "c0"]);
  });
  it("runs disjoint private conversations concurrently, with only one activation per person", async () => {
    const active = new Set<string>(); const sent = new Set<string>(); let privateCount = 0; let overlapped = false;
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const service = setup(() => ({ async turn(c) {
      expect(active.has(c.character.id)).toBe(false); active.add(c.character.id);
      try {
        if (c.opportunity.actions.length) return await act(c);
        if (c.opportunity.stage.id !== "1:discussion") return { waited: true };
        if (c.opportunity.channel === "public" && ["c0", "c2"].includes(c.character.id) && !sent.has(c.character.id)) {
          sent.add(c.character.id); await c.call("send_message", { channel: "private", recipients: [c.character.id === "c0" ? "c1" : "c3"], text: "想单独聊聊。" });
        } else if (c.opportunity.channel === "private") {
          privateCount++; if (privateCount >= 2) { overlapped = true; release(); }
          await gate; privateCount--;
        }
        return { waited: true };
      } finally { active.delete(c.character.id); }
    } }));
    const s = spec("public-goods", 4); s.budgets.discussionTurns = 20;
    const run = service.create(s, characters.slice(0, 4)).run; await run.settled();
    expect(run.status).toBe("completed"); expect(overlapped).toBe(true);
  });
  it("wakes a private recipient while the sender's loop is still running", async () => {
    let release!: () => void; const replied = new Promise<void>(r => { release = r; }); let sent = false; let receiving = false;
    const service = setup(() => ({ async turn(c) {
      if (c.opportunity.actions.length) return act(c);
      if (!sent && c.character.id === "c0") {
        sent = true; await Promise.resolve();
        await c.call("send_message", { channel: "private", recipients: ["c1"], text: "我想先问问你。" });
        await replied;
      } else if (c.character.id === "c1" && c.opportunity.channel === "private") { receiving = true; release(); }
      return { waited: true };
    } }));
    const run = service.create(spec(), characters.slice(0, 2)).run; await run.settled();
    expect(receiving).toBe(true); expect(run.status).toBe("completed");
  });
  it.each([6, 7, 8, 9, 10, 11, 12])("runs a %i-player werewolf board with deterministic dealing and private identities", async n => {
    const a = new WerewolfScenario(characters.slice(0, n), 2, 7);
    const b = new WerewolfScenario(characters.slice(0, n), 2, 7);
    expect(a.observe("c0")).toBe(b.observe("c0"));
    expect(a.publicState()).not.toHaveProperty("roles");
    const service = setup(quiet); const run = service.create(spec("werewolf", n), characters.slice(0, n)).run; await run.settled();
    expect(run.status, JSON.stringify(run.view({ research: true }).events.slice(-3))).toBe("completed");
  });
});
