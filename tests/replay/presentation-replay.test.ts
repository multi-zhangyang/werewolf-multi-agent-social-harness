/**
 * Replay determinism checks (AGENTS.md §16.5 / §19.2): the presentation
 * stream (tension + director cues) must replay to identical state from the
 * same event sequence, and room event envelopes must carry a strictly
 * increasing sequence number with unique ids so a client can dedupe and
 * re-apply them in order.
 */
import { describe, expect, it } from "vitest";
import { ScriptedModel } from "@openai/agents/testing";
import { CinematicDirector } from "../../src/society/spectator/cinematic-director";
import { TensionEngine, type TensionImpact } from "../../src/society/spectator/tension-engine";
import type { AgentRuntimeEvent, StoryBeatKind, WorldSnapshot } from "../../src/society/contracts";
import { ActivationLimiter } from "../../src/society/activation-limiter";
import { clearFastTurns, installFastTurns, testRoom, twoRoundScript, waitFor } from "../helpers/scripted-room";
import type { SocietyRoom } from "../../src/society/room";

function logEntry(text: string, beat: StoryBeatKind): WorldSnapshot["log"][number] {
  return { id: `log-${text}`, text, turn: 1, phase: "结算", at: new Date().toISOString(), beat };
}

function worldAt(turn: number, totalTurns: number, log: WorldSnapshot["log"], alive: string[], suspicion: Array<{ kind: string; accuser: string; target: string }>): WorldSnapshot {
  return {
    roomId: "r-replay",
    scenarioId: "trust-game",
    title: "replay",
    status: "running",
    turn,
    totalTurns,
    phase: "协商",
    summary: "replay",
    agents: [
      { id: "agent-01", displayName: "苏遥", characterId: "c-1", status: "idle", alive: alive.includes("agent-01") },
      { id: "agent-02", displayName: "林默", characterId: "c-2", status: "idle", alive: alive.includes("agent-02") }
    ],
    messages: [],
    log,
    details: { suspicion: { entries: suspicion } }
  };
}

function updatedEvent(snapshot: WorldSnapshot): AgentRuntimeEvent {
  return { type: "world.updated", roomId: snapshot.roomId, snapshot };
}

/** Cue/tension payloads with wall-clock noise (ids, timestamps) stripped. */
function normalized(events: AgentRuntimeEvent[]): Array<Record<string, unknown>> {
  return events.map((event) => {
    if (event.type === "tension.changed") {
      return { type: "tension.changed", score: event.score, level: event.level, reasons: event.reasons };
    }
    if (event.type === "cinematic.cue") {
      const cue = event.cue;
      return {
        type: "cinematic.cue",
        camera: cue.camera,
        focusAgentIds: cue.focusAgentIds,
        priority: cue.priority,
        title: cue.title,
        subtitle: cue.subtitle,
        effect: cue.effect,
        skippable: cue.skippable,
        minimumDurationMs: cue.minimumDurationMs,
        maximumDurationMs: cue.maximumDurationMs
      };
    }
    return { type: event.type };
  });
}

describe("presentation replay (§16.5)", () => {
  it("two TensionEngines replay identical impacts to identical state", () => {
    const impacts: TensionImpact[] = [
      { reason: "direct-accusation", agentIds: ["agent-01", "agent-02"] },
      { reason: "role-action" },
      { reason: "elimination" },
      { reason: "win-condition-near" },
      { reason: "role-action" },
      { reason: "role-action" }
    ];
    const left = new TensionEngine({ tickSeconds: 10 });
    const right = new TensionEngine({ tickSeconds: 10 });
    for (const impact of impacts) {
      left.impact(impact, []);
      right.impact(impact, []);
      expect(right.snapshot()).toEqual(left.snapshot());
    }
  });

  it("two CinematicDirectors replay one event sequence into identical presentation", () => {
    const sequence: Array<{ event: AgentRuntimeEvent; world: WorldSnapshot }> = [
      { event: updatedEvent(worldAt(1, 2, [logEntry("双方达成一致。", "agreement-reached")], ["agent-01", "agent-02"], [])), world: worldAt(1, 2, [logEntry("双方达成一致。", "agreement-reached")], ["agent-01", "agent-02"], []) },
      { event: updatedEvent(worldAt(1, 2, [logEntry("双方达成一致。", "agreement-reached")], ["agent-01", "agent-02"], [{ kind: "speech", accuser: "agent-01", target: "agent-02" }])), world: worldAt(1, 2, [logEntry("双方达成一致。", "agreement-reached")], ["agent-01", "agent-02"], [{ kind: "speech", accuser: "agent-01", target: "agent-02" }]) },
      { event: updatedEvent(worldAt(2, 2, [logEntry("双方达成一致。", "agreement-reached"), logEntry("一人退出合作。", "unilateral-defection")], ["agent-02"], [{ kind: "speech", accuser: "agent-01", target: "agent-02" }])), world: worldAt(2, 2, [logEntry("双方达成一致。", "agreement-reached"), logEntry("一人退出合作。", "unilateral-defection")], ["agent-02"], [{ kind: "speech", accuser: "agent-01", target: "agent-02" }]) },
      { event: updatedEvent(worldAt(2, 2, [logEntry("双方达成一致。", "agreement-reached"), logEntry("一人退出合作。", "unilateral-defection"), logEntry("终局。", "win")], ["agent-02"], [{ kind: "speech", accuser: "agent-01", target: "agent-02" }])), world: worldAt(2, 2, [logEntry("双方达成一致。", "agreement-reached"), logEntry("一人退出合作。", "unilateral-defection"), logEntry("终局。", "win")], ["agent-02"], [{ kind: "speech", accuser: "agent-01", target: "agent-02" }]) }
    ];
    const leftOut: AgentRuntimeEvent[] = [];
    const rightOut: AgentRuntimeEvent[] = [];
    const left = new CinematicDirector({ roomId: "r-left", emit: (event) => leftOut.push(event) });
    const right = new CinematicDirector({ roomId: "r-right", emit: (event) => rightOut.push(event) });
    try {
      for (const step of sequence) {
        left.ingest(step.event, step.world);
        right.ingest(step.event, step.world);
      }
      expect(normalized(rightOut)).toEqual(normalized(leftOut));
      expect(rightOut.length).toBeGreaterThan(0);
    } finally {
      left.dispose();
      right.dispose();
    }
  });
});

describe("room event envelopes", () => {
  it("sequence numbers strictly increase and envelope ids stay unique", async () => {
    installFastTurns();
    const model = new ScriptedModel(twoRoundScript());
    const limiter = new ActivationLimiter(1);
    const { room, cleanup } = testRoom(model, limiter);
    try {
      void room.start();
      await waitFor(() => room.currentStatus() === "finished", 8_000);
      const events = (room as SocietyRoom & { events: Array<{ id: string; seq: number }> }).events;
      expect(events.length).toBeGreaterThan(10);
      for (let index = 1; index < events.length; index += 1) {
        expect(events[index].seq).toBeGreaterThan(events[index - 1].seq);
      }
      expect(new Set(events.map((entry) => entry.id)).size).toBe(events.length);
    } finally {
      clearFastTurns();
      cleanup();
    }
  });
});