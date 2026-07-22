import { describe, expect, it } from "vitest";
import type { GameEvent } from "../src/core/types";
import type { SocialHarnessStep } from "../src/harness/social";
import { projectWerewolfPostgameEventLedger } from "../src/server/werewolfReviewLedger";

describe("server-owned Werewolf postgame event ledger", () => {
  it("uses an allowlist and links a public event to the end of an atomic native batch", () => {
    const steps = [
      step({ traceId: "parallel-a", batchId: "batch-1", eventSeqRange: [4, 4] }),
      step({ traceId: "parallel-b", batchId: "batch-1", eventSeqRange: [4, 4] })
    ];
    const ledger = projectWerewolfPostgameEventLedger({
      events: [
        event({ id: "public-vote", seq: 4, type: "vote.cast", visibility: "public", payload: { targetId: "secret" } }),
        event({ id: "private-seer", seq: 5, type: "seer.inspected", visibility: "private", payload: { resultTeam: "werewolves" } }),
        event({ id: "postgame-created", seq: 1, type: "game.created", visibility: "postgame", payload: { roles: ["seer"] } })
      ],
      episode: { steps },
      view: "postgame-redacted",
      authority: "server-owned-match-artifact"
    });

    expect(ledger.entries).toEqual([
      expect.objectContaining({
        id: "public-vote",
        eventType: "vote.cast",
        safeLabel: "放逐投票已记录",
        nativeBoundary: { nativeStepCount: 2 }
      })
    ]);
    const serialized = JSON.stringify(ledger);
    expect(serialized).not.toContain("targetId");
    expect(serialized).not.toContain("resultTeam");
    expect(serialized).not.toContain("game.created");
  });

  it("has no native scheduler cursor in the strict truth-redacted projection", () => {
    const ledger = projectWerewolfPostgameEventLedger({
      events: [event({ id: "public-end", seq: 8, type: "game.ended", visibility: "public", payload: { winner: "werewolves" } })],
      episode: { steps: [step({ traceId: "committed", eventSeqRange: [8, 8] })] },
      view: "truth-redacted",
      authority: "server-owned-match-artifact"
    });

    expect(ledger.entries).toEqual([expect.objectContaining({ id: "public-end", safeLabel: "游戏结束" })]);
    expect(ledger.entries[0]).not.toHaveProperty("nativeBoundary");
    expect(JSON.stringify(ledger)).not.toContain("nativeBoundary");
    expect(JSON.stringify(ledger)).not.toContain("winner");
  });
});

function event(input: Partial<GameEvent> & Pick<GameEvent, "id" | "seq" | "type" | "visibility" | "payload">): GameEvent {
  return {
    id: input.id,
    seq: input.seq,
    day: input.day ?? 2,
    phase: input.phase ?? "day_vote",
    type: input.type,
    visibility: input.visibility,
    payload: input.payload,
    createdAt: "2026-07-21T00:00:00.000Z"
  };
}

function step(input: { traceId: string; batchId?: string; eventSeqRange: [number, number] }): SocialHarnessStep {
  return {
    traceId: input.traceId,
    turnIndex: input.traceId === "parallel-b" ? 1 : 0,
    actorId: input.traceId,
    profileId: "fixture",
    schedulerMode: input.batchId ? "parallel" : "aec",
    atomic: Boolean(input.batchId),
    batchId: input.batchId,
    batchSize: input.batchId ? 2 : 1,
    pendingAction: {},
    observation: {},
    action: { actorId: input.traceId, kind: "fixture", command: {} },
    commitStatus: "committed",
    eventSeqRange: input.eventSeqRange
  };
}
