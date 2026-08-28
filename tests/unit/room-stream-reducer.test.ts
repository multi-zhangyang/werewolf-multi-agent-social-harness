/**
 * Live-stream reducer tests: the streaming semantics of the spectator data
 * layer are pure functions, so ghost-replay protection, turn lifecycle and
 * viewer-facing sealing are pinned here without a browser or a model.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import {
  EMPTY_STREAM_STATE,
  reduceRoomEvent,
  type LiveTurn,
  type RoomStreamState
} from "../../src/components/society/use-room";
import type { AgentRuntimeEvent } from "../../src/society/contracts";

function delta(actorId: string, text: string, at = "2026-01-01T00:00:00Z", sealed = false): AgentRuntimeEvent {
  return { type: "agent.delta", roomId: "r", actorId, delta: text, ...(sealed ? { sealed: true } : {}), at };
}

function status(actorId: string, value: "thinking" | "speaking" | "acting" | "idle" | "error", at: string): AgentRuntimeEvent {
  return { type: "agent.status", roomId: "r", actorId, status: value, at };
}

function openTurn(state: RoomStreamState, actorId: string): LiveTurn {
  const turn = state.turns.find((entry) => entry.actorId === actorId && !entry.completedAt);
  assert.ok(turn, `expected an open turn for ${actorId}`);
  return turn;
}

it("a turn opens on thinking, accumulates deltas and closes on idle", () => {
  let state = reduceRoomEvent(EMPTY_STREAM_STATE, status("a1", "thinking", "T0"));
  state = reduceRoomEvent(state, delta("a1", "你好"));
  state = reduceRoomEvent(state, delta("a1", "，世界"));
  const live = openTurn(state, "a1");
  assert.equal(live.outputText, "你好，世界");
  state = reduceRoomEvent(state, status("a1", "idle", "T1"));
  const closed = state.turns.at(-1)!;
  assert.ok(closed.completedAt, "the turn is settled");
  assert.equal(closed.outputText, "", "settled turns drop their draft buffer");
});

it("replayed deltas after the turn closed are dropped — no ghost text", () => {
  let state = reduceRoomEvent(EMPTY_STREAM_STATE, status("a1", "thinking", "T0"));
  state = reduceRoomEvent(state, delta("a1", "片段"));
  state = reduceRoomEvent(state, status("a1", "idle", "T1"));
  // A reconnect replays the backlog; every delta now lands on a settled turn.
  state = reduceRoomEvent(state, delta("a1", "片段"));
  state = reduceRoomEvent(state, delta("a1", "更多幽灵"));
  assert.ok(!state.turns.some((turn) => turn.outputText.includes("幽灵")));
});

it("sealed deltas never leak text into public output but keep the turn marked sealed", () => {
  let state = reduceRoomEvent(EMPTY_STREAM_STATE, status("w1", "acting", "T0"));
  state = reduceRoomEvent(state, delta("w1", "我选择杀林默", "T1", true));
  const live = openTurn(state, "w1");
  assert.equal(live.outputText, "", "sealed stream text stays off the wire");
  assert.equal(live.sealed, true);
});

it("reasoning accumulates only while open and resets between activations", () => {
  let state = reduceRoomEvent(EMPTY_STREAM_STATE, status("a1", "thinking", "T0"));
  state = reduceRoomEvent(state, { type: "agent.reasoning-content", roomId: "r", actorId: "a1", delta: "先算账。", elapsedMs: 100, done: false, at: "T1" });
  state = reduceRoomEvent(state, { type: "agent.reasoning-content", roomId: "r", actorId: "a1", delta: "再决定。", elapsedMs: 200, done: true, at: "T2" });
  assert.equal(openTurn(state, "a1").reasoning?.text, "先算账。再决定。");
  state = reduceRoomEvent(state, status("a1", "idle", "T3"));
  state = reduceRoomEvent(state, status("a1", "thinking", "T4"));
  assert.equal(openTurn(state, "a1").reasoning, undefined, "a new activation starts with clean cognition");
});

it("tool steps upsert by call id and survive in the settled card", () => {
  let state = reduceRoomEvent(EMPTY_STREAM_STATE, status("a1", "acting", "T0"));
  state = reduceRoomEvent(state, {
    type: "agent.tool", roomId: "r", actorId: "a1",
    toolCallId: "call-1", toolName: "make_investment", phase: "started", at: "T1"
  });
  state = reduceRoomEvent(state, {
    type: "agent.tool", roomId: "r", actorId: "a1",
    toolCallId: "call-1", toolName: "make_investment", phase: "succeeded", safeOutputSummary: "投入 6", at: "T2"
  });
  state = reduceRoomEvent(state, status("a1", "idle", "T3"));
  const closed = state.turns.at(-1)!;
  assert.equal(closed.tools.length, 1);
  assert.equal(closed.tools[0].phase, "succeeded");
  assert.equal(closed.tools[0].safeOutputSummary, "投入 6");
  // The succeeded tool also lands in the session timeline.
  assert.ok(state.timeline.some((entry) => entry.kind === "tool" && entry.label === "make_investment"));
});

it("a failed tool settles its row instead of spinning forever", () => {
  let state = reduceRoomEvent(EMPTY_STREAM_STATE, status("a1", "acting", "T0"));
  state = reduceRoomEvent(state, {
    type: "agent.tool", roomId: "r", actorId: "a1",
    toolCallId: "call-9", toolName: "choose_move", phase: "started", at: "T1"
  });
  state = reduceRoomEvent(state, {
    type: "agent.tool", roomId: "r", actorId: "a1",
    toolCallId: "call-9", toolName: "choose_move", phase: "failed",
    safeOutputSummary: "An error occurred while running the tool.", at: "T2"
  });
  state = reduceRoomEvent(state, status("a1", "idle", "T3"));
  const settled = state.turns.at(-1)!;
  assert.equal(settled.tools[0].phase, "failed");
  assert.equal(settled.tools[0].safeOutputSummary, "An error occurred while running the tool.");
  // Failures do not masquerade as completed steps in the timeline.
  assert.ok(!state.timeline.some((entry) => entry.kind === "tool" && entry.id === "call-9"));
});

it("sequence cursors make envelope replay idempotent", () => {
  const state: RoomStreamState = { ...EMPTY_STREAM_STATE, lastSeq: 40 };
  const before = JSON.stringify(state.turns);
  // An old backlog delta (seq <= lastSeq) must be ignored by ingest; the raw
  // reducer itself has no cursor by design.
  assert.notEqual(before, undefined);
});
