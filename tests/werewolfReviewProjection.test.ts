import { describe, expect, it } from "vitest";
import { buildWerewolfReviewModel } from "../src/components/cockpit/werewolfReviewProjection";
import type { PostgameMatchProjectionDto } from "../src/server/artifactProjection";

describe("Werewolf review projection selector", () => {
  it("fails closed for a truth-redacted input even if an upstream payload contains hidden fields", () => {
    const review = buildWerewolfReviewModel(
      artifact({
        projection: { view: "truth-redacted", postgameTruthRedacted: true },
        finalState: hiddenState()
      })
    );

    expect(review).toMatchObject({ visibility: "truth-redacted", day: 2, phase: "day_vote" });
    expect(review?.seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "p1", seat: 1, alive: true }),
        expect.objectContaining({ id: "p2", seat: 2, alive: false })
      ])
    );
    expect(review?.seats.every((seat) => seat.postgameRole === undefined)).toBe(true);
    expect(review?.speeches).toEqual([
      expect.objectContaining({ playerId: "p1", text: "我公开自称预言家", claimedRole: "seer" })
    ]);
    expect(review?.votes).toEqual([
      expect.objectContaining({ kind: "exile", voterId: "p1", targetId: "p2" }),
      expect.objectContaining({ kind: "sheriff", voterId: "p2", abstain: true })
    ]);
    expect(review?.eventLedger).toEqual([
      expect.objectContaining({ id: "ledger-public", safeLabel: "放逐投票已记录", phase: "day_vote" })
    ]);

    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain('"postgameRole"');
    expect(serialized).not.toContain("werewolves");
    expect(serialized).not.toContain("seerInspection");
    expect(serialized).not.toContain("wolfVotes");
    expect(serialized).not.toContain("wolfWhispers");
    expect(serialized).not.toContain("sourceId");
    expect(serialized).not.toContain("private-payload");
    expect(serialized).not.toContain("event-public");
  });

  it("permits only role cards in explicit postgame review and keeps team/night truth out of the model", () => {
    const review = buildWerewolfReviewModel(
      artifact({
        projection: { view: "postgame-redacted", postgameTruthRedacted: false },
        finalState: hiddenState()
      })
    );

    expect(review?.visibility).toBe("postgame-review");
    expect(review?.seats.find((seat) => seat.id === "p1")?.postgameRole).toBe("seer");
    expect(review?.seats.find((seat) => seat.id === "p2")?.postgameRole).toBe("werewolf");
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain('"team"');
    expect(serialized).not.toContain('"ability"');
    expect(serialized).not.toContain("seerInspection");
    expect(serialized).not.toContain("wolfVotes");
    expect(serialized).not.toContain("wolfWhispers");
    expect(serialized).not.toContain("winner");
  });

  it("degrades safely when a true public state lacks postgame-only fields", () => {
    const review = buildWerewolfReviewModel(
      artifact({
        projection: { view: "truth-redacted", postgameTruthRedacted: true },
        finalState: {
          day: 1,
          phase: "day_speech",
          players: [
            { id: "p9", seat: 9, name: "9号", alive: true, isSheriff: false },
            { id: "p1", seat: 1, name: "1号", alive: true, isSheriff: true }
          ],
          speeches: [],
          votes: [],
          deaths: [],
          events: []
        }
      })
    );

    expect(review).toMatchObject({ visibility: "truth-redacted", day: 1, phase: "day_speech" });
    expect(review?.seats.map((seat) => seat.seat)).toEqual([1, 9]);
    expect(review?.seats.every((seat) => seat.postgameRole === undefined)).toBe(true);
    expect(review?.eventLedger[0]?.nativeStepCount).toBeUndefined();
  });

  it("does not fall back to finalState events when the server ledger is missing or malformed", () => {
    const review = buildWerewolfReviewModel(
      artifact({
        projection: { view: "postgame-redacted", postgameTruthRedacted: false },
        finalState: hiddenState(),
        ledger: { entries: [{ id: "malformed", visibility: "public", safeLabel: "not enough fields" }] }
      })
    );

    expect(review?.eventLedger).toEqual([]);
    expect(JSON.stringify(review)).not.toContain("event-public");
    expect(JSON.stringify(review)).not.toContain("private-payload");
  });
});

function artifact(input: {
  projection: { view: "postgame-redacted" | "truth-redacted"; postgameTruthRedacted: boolean };
  finalState: unknown;
  ledger?: { entries?: unknown[] };
}) {
  return {
    projection: {
      ...input.projection,
      privateEvidenceRedacted: true,
      generatedAt: "2026-07-21T00:00:00.000Z"
    },
    finalState: input.finalState,
    werewolfReviewLedger: {
      artifactVersion: "server.werewolf-postgame-event-ledger.v1",
      kind: "werewolf-postgame-event-ledger",
      authority: "server-owned-match-artifact",
      projection: {
        view: input.projection.view,
        privateEvidenceRedacted: true,
        postgameTruthRedacted: input.projection.postgameTruthRedacted
      },
      entries:
        input.ledger?.entries ?? [
          {
            id: "ledger-public",
            seq: 1,
            day: 2,
            phase: "day_vote",
            eventType: "vote.cast",
            visibility: "public",
            safeLabel: "放逐投票已记录",
            // A deliberately malicious truth-view boundary verifies that the
            // client accepts replay linkage only in postgame review.
            nativeBoundary: { nativeStepCount: 2 }
          }
        ]
    }
  } as unknown as PostgameMatchProjectionDto;
}

function hiddenState() {
  return {
    day: 2,
    phase: "day_vote",
    currentSpeakerSeat: 1,
    pendingActionCount: 1,
    players: [
      {
        id: "p1",
        seat: 1,
        name: "1号",
        alive: true,
        isSheriff: true,
        role: "seer",
        team: "village",
        ability: { private: true }
      },
      {
        id: "p2",
        seat: 2,
        name: "2号",
        alive: false,
        isSheriff: false,
        role: "werewolf",
        team: "werewolves",
        ability: { private: true },
        eliminatedAt: { day: 2, phase: "day_vote", reason: "exile" }
      }
    ],
    speeches: [
      {
        day: 2,
        playerId: "p1",
        text: "我公开自称预言家",
        kind: "day",
        claimedRole: "seer",
        pressureTargetId: "p2",
        strategyTags: ["claim"]
      }
    ],
    votes: [
      { day: 2, voterId: "p1", targetId: "p2", abstain: false, weight: 1, kind: "exile" },
      { day: 1, voterId: "p2", abstain: true, weight: 1, kind: "sheriff" }
    ],
    deaths: [{ day: 2, playerId: "p2", reason: "exile", sourceId: "p1" }],
    events: [
      {
        id: "event-public",
        seq: 1,
        day: 2,
        phase: "day_vote",
        type: "vote.cast",
        visibility: "public",
        payload: { public: true },
        createdAt: "2026-07-21T00:01:00.000Z"
      },
      {
        id: "event-private",
        seq: 2,
        day: 2,
        phase: "night_seer",
        type: "seer.inspected",
        visibility: "private",
        payload: { note: "private-payload" },
        createdAt: "2026-07-21T00:02:00.000Z"
      }
    ],
    night: { seerInspection: { resultTeam: "werewolves" }, wolfVotes: { p2: "p1" } },
    wolfWhispers: [{ text: "private coordination" }],
    winner: "werewolves",
    endReason: "private end"
  };
}
