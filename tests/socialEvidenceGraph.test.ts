import { describe, expect, it } from "vitest";
import { projectSocialNetwork, type RedactedAgentStateDto } from "../src/server/artifactProjection";

const projection = {
  view: "postgame-redacted" as const,
  privateEvidenceRedacted: true,
  postgameTruthRedacted: false,
  generatedAt: "1970-01-01T00:00:00.000Z"
};

describe("social evidence matrix view model", () => {
  it("keeps relationship, delivery, and observed-message units separate", () => {
    const network = projectSocialNetwork({
      projection,
      agents: [agent("p2"), agent("p1", "p2")],
      socialEpisode: {
        messages: [
          {
            id: "msg-1",
            seq: 1,
            channelId: "table",
            senderId: "p1",
            recipientIds: ["p2"],
            visibility: "public",
            content: "recorded public message",
            createdAt: "2026-01-01T00:00:01.000Z"
          }
        ],
        exposureRecords: [
          {
            messageId: "msg-1",
            messageSeq: 1,
            sourceId: "p1",
            observerId: "p2",
            observedAtTraceId: "trace-p2",
            observedAtTurnIndex: 2,
            observedAtActionKind: "speech.submit",
            channelId: "table",
            visibility: "public",
            evidenceRefs: [{ artifact: "message", id: "msg-1", seq: 1 }]
          }
        ]
      }
    });

    expect(network.nodes.map((node) => node.id)).toEqual(["p1", "p2"]);
    expect(network.nodes.find((node) => node.id === "p1")).toMatchObject({
      sentMessageCount: 1,
      deliveryCount: 1,
      relationshipCount: 1
    });
    expect(network.nodes.find((node) => node.id === "p2")).toMatchObject({
      receivedMessageCount: 1,
      observedMessageCount: 1,
      observationCount: 1
    });
    expect(network.relationshipEdges[0]).toMatchObject({ sourceId: "p1", targetId: "p2", trust: 0.4, suspicion: 0.2 });
    expect(network.communicationEdges[0]).toMatchObject({ sourceId: "p1", targetId: "p2", messageCount: 1 });
    expect(network.exposureEdges[0]).toMatchObject({ sourceId: "p1", targetId: "p2", uniqueMessageCount: 1, observationCount: 1 });
  });

  it("marks private social modes unavailable in a truth-redacted projection", () => {
    const network = projectSocialNetwork({
      projection: { ...projection, view: "truth-redacted", postgameTruthRedacted: true },
      agents: [],
      socialEpisode: { messages: [], exposureRecords: [] }
    });

    expect(network.modes.relationships.available).toBe(false);
    expect(network.modes.exposure.available).toBe(false);
    expect(network.relationshipEdges).toEqual([]);
    expect(network.exposureEdges).toEqual([]);
  });
});

function agent(id: string, targetId?: string): RedactedAgentStateDto {
  return {
    playerId: id,
    model: "fixture-model",
    temperature: 0,
    policyName: "village-analyst",
    turns: 1,
    observations: 1,
    beliefs: {},
    privateMemos: [],
    social: {
      version: "harness.agent-social-state.v1",
      profile: { id, displayName: id },
      memory: { entries: [], nextSeq: 1, maxEntries: 64 },
      beliefs: { claims: {} },
      relationships: {
        edges: targetId
          ? {
              [targetId]: {
                targetId,
                trust: 0.4,
                suspicion: 0.2,
                affinity: 0.1,
                influence: 0.3,
                debt: 0,
                respect: 0.2,
                threat: 0.1,
                evidenceRefs: [{ artifact: "message", id: "msg-1", seq: 1 }],
                updatedAt: "2026-01-01T00:00:01.000Z"
              }
            }
          : {}
      },
      norms: { norms: {} },
      reputation: { records: {} },
      goals: { goals: [] }
    }
  } as unknown as RedactedAgentStateDto;
}
