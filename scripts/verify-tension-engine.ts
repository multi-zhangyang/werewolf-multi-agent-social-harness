/**
 * Spectator presentation checks (run with `npx tsx scripts/verify-tension-engine.ts`).
 * The tension engine and cinematic director are deterministic and
 * presentation-only; these checks pin the engine's scoring, level thresholds,
 * decay behavior, and the director's derivation of duel cues from public
 * accusation facts. No model calls, no network.
 */
import { strict as assert } from "node:assert";
import { TensionEngine, levelFor, reasonLabel } from "../src/society/spectator/tension-engine";
import { CinematicDirector } from "../src/society/spectator/cinematic-director";
import { timelineContextAround } from "../src/society/spectator/projection";
import type { AgentRuntimeEvent, WorldSnapshot } from "../src/society/contracts";

let passed = 0;
const pending: Array<Promise<void>> = [];
function check(name: string, fn: () => void | Promise<void>): void {
  pending.push(Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ok  ${name}`);
  }).catch((cause) => {
    console.error(`  FAIL ${name}:`, cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }));
}

check("starts calm at zero", () => {
  const engine = new TensionEngine();
  assert.deepEqual(engine.snapshot(), { score: 0, level: "calm", reasons: [], primaryAgentIds: [] });
});

check("elimination boosts and carries the reason", () => {
  const engine = new TensionEngine();
  const result = engine.impact({ reason: "elimination", agentIds: ["a1"] }, "evt-1", 0);
  assert.ok(result, "an impact must report a state change");
  assert.equal(result!.state.level, "warm");
  assert.ok(result!.state.score >= 0.4);
  assert.ok(result!.state.reasons.includes("elimination"));
  assert.deepEqual(result!.state.primaryAgentIds, ["a1"]);
});

check("climax reached after stacking high-impact events", () => {
  const engine = new TensionEngine();
  engine.impact({ reason: "elimination" }, "e1", 0);
  engine.impact({ reason: "betrayal" }, "e2", 0);
  engine.impact({ reason: "deception-exposed" }, "e3", 0);
  const state = engine.snapshot();
  assert.equal(state.level, "climax");
  assert.ok(state.score >= 0.78);
});

check("decay lowers the score and eventually returns to calm", () => {
  const engine = new TensionEngine({ decayPerTick: 0.25 });
  engine.impact({ reason: "role-action" }, "e1", 0);
  engine.tick(1);
  engine.tick(1);
  engine.tick(1);
  assert.equal(engine.snapshot().level, "calm");
});

check("level thresholds are ordered", () => {
  assert.equal(levelFor(0), "calm");
  assert.equal(levelFor(0.25), "warm");
  assert.equal(levelFor(0.6), "tense");
  assert.equal(levelFor(0.85), "climax");
});

check("reason labels exist for every tension reason", () => {
  for (const reason of ["direct-accusation", "contradiction", "betrayal", "alliance-break", "vote-swing", "role-action", "deception-exposed", "save", "elimination", "win-condition-near", "emotional-spike"] as const) {
    assert.ok(reasonLabel(reason).length > 0, `missing label for ${reason}`);
  }
});

// --- CinematicDirector: duel cues derive from public accusation facts ---

function fakeWorld(input: { suspicion?: Array<{ kind: string; accuser: string; target: string }>; agents?: Array<{ id: string; displayName: string; alive: boolean }> }): WorldSnapshot {
  return {
    roomId: "r", scenarioId: "werewolf", title: "t", status: "running", turn: 1, totalTurns: 4,
    phase: "day", summary: "", agents: input.agents ?? [],
    messages: [], log: [],
    details: input.suspicion ? { suspicion: { scores: {}, entries: input.suspicion } } : {}
  };
}

check("director derives a duel cue from a public accusation entry", async () => {
  const emitted: AgentRuntimeEvent[] = [];
  const director = new CinematicDirector({ roomId: "r", tickSeconds: 3600, emit: (event) => emitted.push(event) });
  const world = fakeWorld({
    suspicion: [{ kind: "speech", accuser: "a1", target: "a2" }],
    agents: [{ id: "a1", displayName: "甲", alive: true }, { id: "a2", displayName: "乙", alive: true }]
  });
  director.ingest({ type: "world.updated", roomId: "r", snapshot: world, at: new Date().toISOString() }, world);
  const duel = emitted.find((event) => event.type === "cinematic.cue" && event.cue.camera === "duel");
  assert.ok(duel, "an accusation must produce a duel cue");
  assert.deepEqual(duel.cue.focusAgentIds, ["a1", "a2"]);
  assert.ok(emitted.some((event) => event.type === "tension.changed" && event.reasons.includes("direct-accusation")), "accusation must raise tension");
  director.dispose();
});

check("director ignores non-speech suspicion entries for duel cues", async () => {
  const emitted: AgentRuntimeEvent[] = [];
  const director = new CinematicDirector({ roomId: "r", tickSeconds: 3600, emit: (event) => emitted.push(event) });
  const world = fakeWorld({
    suspicion: [{ kind: "vote", accuser: "a1", target: "a2" }],
    agents: [{ id: "a1", displayName: "甲", alive: true }, { id: "a2", displayName: "乙", alive: true }]
  });
  director.ingest({ type: "world.updated", roomId: "r", snapshot: world, at: new Date().toISOString() }, world);
  assert.ok(!emitted.some((event) => event.type === "cinematic.cue" && event.cue.camera === "duel"), "votes are not accusations");
  director.dispose();
});

// ── Highlight cause-and-effect window (§8.7) ────────────────────────────────

const T0 = Date.parse("2026-08-17T20:00:00Z");
function entry(secondsFromStart: number): { at: string; label: string } {
  return { at: new Date(T0 + secondsFromStart * 1000).toISOString(), label: `e${secondsFromStart}` };
}

check("timelineContextAround returns a small window before and after the moment", () => {
  const timeline = Array.from({ length: 20 }, (_, index) => entry(index * 10));
  const window = timelineContextAround(timeline, entry(100).at);
  assert.ok(window.length >= 4 && window.length <= 6, "window is bounded");
  assert.ok(window.some((item) => item.label === "e100"), "the moment itself is inside the window");
  assert.ok(window.every((item) => Number(item.label.slice(1)) >= 60), "the cause precedes the moment");
  assert.ok(window.every((item) => Number(item.label.slice(1)) <= 110), "the aftermath is brief");
});

check("timelineContextAround keeps chronological order and survives a post-timeline moment", () => {
  const timeline = Array.from({ length: 8 }, (_, index) => entry(index * 10)).reverse(); // shuffled input
  const window = timelineContextAround(timeline, entry(100).at);
  const labels = window.map((item) => item.label);
  assert.deepEqual(labels, ["e20", "e30", "e40", "e50", "e60", "e70"], "latest entries when the moment is newer than the buffer");
  const inside = timelineContextAround(timeline, entry(40).at);
  assert.deepEqual(inside.map((item) => item.label), ["e0", "e10", "e20", "e30", "e40", "e50"], "window is chronological around the moment");
});

check("timelineContextAround tolerates empty and unparseable inputs", () => {
  assert.deepEqual(timelineContextAround([], entry(0).at), []);
  assert.deepEqual(timelineContextAround([{ at: "not-a-time", label: "x" }], entry(0).at), []);
});

void Promise.all(pending).then(() => {
  console.log(`\nTension-engine checks: ${passed} passed.`);
});
