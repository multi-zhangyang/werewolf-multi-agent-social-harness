import { describe, expect, it } from "vitest";
import { readLiveMatchProjection } from "../src/components/cockpit/werewolfLiveProjection";

describe("Werewolf live-public Cockpit projection", () => {
  it("copies only the strict server public table fields", () => {
    const projection = readLiveMatchProjection(
      {
        artifactVersion: "server.match-live-projection.v1",
        kind: "match-live-projection",
        matchId: "live-ui-001",
        lifecycle: "running",
        artifactAvailable: false,
        projection: {
          view: "live-public",
          privateEvidenceRedacted: true,
          postgameTruthRedacted: true,
          revision: 98
        },
        publicState: {
          phase: "night",
          day: 2,
          players: [
            {
              id: "p2",
              seat: 2,
              name: "2号",
              alive: false,
              isSheriff: false,
              eliminatedAt: { day: 1, reason: "night_kill", phase: "night_resolve" },
              role: "seer",
              team: "villagers",
              ability: { used: true }
            },
            {
              id: "p1",
              seat: 1,
              name: "1号",
              alive: true,
              isSheriff: true,
              privateMemo: "private-live-memo"
            }
          ],
          speeches: [
            {
              day: 1,
              playerId: "p1",
              text: "公开发言",
              kind: "day",
              claimedRole: "seer",
              strategyTags: ["deception"]
            }
          ],
          votes: [{ day: 1, voterId: "p1", targetId: "p2", abstain: false, weight: 2, kind: "sheriff" }],
          deaths: [{ day: 1, playerId: "p2", reason: "night_kill", traceId: "secret-trace" }],
          currentSpeakerSeat: 1,
          pendingActionCount: 4,
          night: { seerInspection: { targetId: "p2" } },
          providerRequestId: "private-request-id"
        }
      },
      "live-ui-001"
    );

    expect(projection).toMatchObject({ lifecycle: "running", matchId: "live-ui-001" });
    if (projection.lifecycle !== "running") throw new Error("Expected running projection.");
    expect(projection.publicState).toEqual({
      phase: "night",
      day: 2,
      players: [
        { id: "p1", seat: 1, name: "1号", alive: true, isSheriff: true },
        { id: "p2", seat: 2, name: "2号", alive: false, isSheriff: false, eliminatedAt: { day: 1, reason: "night_kill" } }
      ],
      speeches: [{ day: 1, playerId: "p1", text: "公开发言", kind: "day" }],
      votes: [{ day: 1, voterId: "p1", targetId: "p2", abstain: false }],
      deaths: [{ day: 1, playerId: "p2", reason: "night_kill" }],
      currentSpeakerSeat: 1
    });
    const serialized = JSON.stringify(projection);
    for (const forbidden of [
      "revision",
      "night_resolve",
      "role",
      "team",
      "ability",
      "private-live-memo",
      "claimedRole",
      "strategyTags",
      "weight",
      "kind\":\"sheriff",
      "secret-trace",
      "pendingActionCount",
      "seerInspection",
      "providerRequestId"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("accepts an honest process-restart running marker without inventing a table", () => {
    const projection = readLiveMatchProjection({
      artifactVersion: "server.match-live-projection.v1",
      kind: "match-live-projection",
      matchId: "live-restart-001",
      lifecycle: "running",
      artifactAvailable: false
    });
    expect(projection).toMatchObject({ lifecycle: "running", artifactAvailable: false });
    if (projection.lifecycle === "running") expect(projection.publicState).toBeUndefined();
  });

  it("rejects a live table that is not explicitly marked as strictly redacted", () => {
    expect(() =>
      readLiveMatchProjection({
        artifactVersion: "server.match-live-projection.v1",
        kind: "match-live-projection",
        matchId: "live-unsafe-001",
        lifecycle: "running",
        artifactAvailable: false,
        projection: { view: "live-public", privateEvidenceRedacted: false, postgameTruthRedacted: true },
        publicState: { phase: "day", day: 1, players: [], speeches: [], votes: [], deaths: [] }
      })
    ).toThrow(/unsafe projection policy/);
  });
});
