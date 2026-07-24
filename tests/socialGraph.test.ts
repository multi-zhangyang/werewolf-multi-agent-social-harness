import { describe, expect, it } from "vitest";
import { projectSocialNetwork } from "../src/server/artifactProjection";

const projection = {
  view: "postgame-redacted" as const,
  privateEvidenceRedacted: true,
  postgameTruthRedacted: false,
  generatedAt: "1970-01-01T00:00:00.000Z"
};

describe("server social-network projection", () => {
  it("does not treat recipient envelopes as scoped-observation evidence", () => {
    const network = projectSocialNetwork({
      projection,
      agents: [],
      socialEpisode: {
        messages: [message("msg-1", 1, "p1", ["p2", "p3"])],
        exposureRecords: []
      }
    });

    expect(network.communicationEdges).toHaveLength(2);
    expect(network.exposureEdges).toEqual([]);
    expect(network.nodes.find((node) => node.id === "p2")).toMatchObject({
      receivedMessageCount: 1,
      observedMessageCount: 0,
      observationCount: 0
    });
  });

  it("aggregates only explicit server-projected exposure records by directed pair and channel", () => {
    const network = projectSocialNetwork({
      projection,
      agents: [],
      socialEpisode: {
        messages: [message("msg-1", 1, "p1", ["p2", "p3"]), message("msg-2", 2, "p1", ["p2", "p3"])],
        exposureRecords: [
          exposure("msg-1", 1, "p1", "p2", "trace-1", 3),
          exposure("msg-1", 1, "p1", "p2", "trace-2", 4),
          exposure("msg-2", 2, "p1", "p3", "trace-3", 5)
        ]
      }
    });

    expect(network.exposureEdges).toHaveLength(2);
    expect(network.exposureEdges.find((edge) => edge.targetId === "p2")).toMatchObject({
      sourceId: "p1",
      uniqueMessageCount: 1,
      observationCount: 2,
      traceIds: ["trace-1", "trace-2"],
      turnIndexes: [3, 4]
    });
    expect(network.exposureEdges.find((edge) => edge.targetId === "p3")).toMatchObject({
      uniqueMessageCount: 1,
      observationCount: 1
    });
  });

  it("keeps message, delivery, received, unique observed, and observation counts in distinct units", () => {
    const network = projectSocialNetwork({
      projection,
      agents: [],
      socialEpisode: {
        messages: [message("msg-1", 1, "p1", ["p2", "p3"])],
        exposureRecords: [
          exposure("msg-1", 1, "p1", "p2", "trace-1", 3),
          exposure("msg-1", 1, "p1", "p2", "trace-2", 4)
        ]
      }
    });

    expect(network.nodes.find((node) => node.id === "p1")).toMatchObject({ sentMessageCount: 1, deliveryCount: 2 });
    expect(network.nodes.find((node) => node.id === "p2")).toMatchObject({
      receivedMessageCount: 1,
      observedMessageCount: 1,
      observationCount: 2
    });
    expect(network.nodes.find((node) => node.id === "p3")).toMatchObject({
      receivedMessageCount: 1,
      observedMessageCount: 0,
      observationCount: 0
    });
  });

  it("deduplicates repeated recipients and ignores sender self-delivery", () => {
    const network = projectSocialNetwork({
      projection,
      agents: [],
      socialEpisode: {
        messages: [message("msg-1", 1, "p1", ["p1", "p2", "p2"])],
        exposureRecords: []
      }
    });

    expect(network.communicationEdges).toHaveLength(1);
    expect(network.communicationEdges[0]).toMatchObject({ sourceId: "p1", targetId: "p2", messageCount: 1 });
    expect(network.nodes.find((node) => node.id === "p1")).toMatchObject({ sentMessageCount: 1, deliveryCount: 1 });
    expect(network.nodes.find((node) => node.id === "p2")).toMatchObject({ receivedMessageCount: 1 });
  });

  it("keeps structured edge identities distinct when actor ids contain delimiters", () => {
    const network = projectSocialNetwork({
      projection,
      agents: [],
      socialEpisode: {
        messages: [
          message("msg-1", 1, "a::b", ["c"]),
          message("msg-2", 2, "a", ["b::c"])
        ],
        exposureRecords: []
      }
    });

    expect(network.communicationEdges).toHaveLength(2);
    expect(new Set(network.communicationEdges.map((edge) => edge.id)).size).toBe(2);
    expect(network.communicationEdges.map((edge) => [edge.sourceId, edge.targetId])).toEqual(expect.arrayContaining([
      ["a", "b::c"],
      ["a::b", "c"]
    ]));
  });

  it("publishes explicit unavailable reasons instead of reconstructing hidden topology", () => {
    const network = projectSocialNetwork({
      projection: { ...projection, view: "truth-redacted", postgameTruthRedacted: true },
      agents: [],
      socialEpisode: { messages: [message("msg-public", 1, "p1", [])], exposureRecords: [] }
    });

    expect(network.relationshipEdges).toEqual([]);
    expect(network.communicationEdges).toEqual([]);
    expect(network.exposureEdges).toEqual([]);
    expect(network.modes.relationships).toMatchObject({ available: false, reason: expect.any(String) });
    expect(network.modes.communication).toMatchObject({ available: false, reason: expect.any(String) });
    expect(network.modes.exposure).toMatchObject({ available: false, reason: expect.any(String) });
  });
});

function message(id: string, seq: number, senderId: string, recipientIds: string[]) {
  return {
    id,
    seq,
    channelId: "table",
    senderId,
    recipientIds,
    visibility: "public" as const,
    content: "recorded message",
    createdAt: `2026-01-01T00:00:0${seq}.000Z`
  };
}

function exposure(messageId: string, messageSeq: number, sourceId: string, observerId: string, traceId: string, turnIndex: number) {
  return {
    messageId,
    messageSeq,
    sourceId,
    observerId,
    observedAtTraceId: traceId,
    observedAtTurnIndex: turnIndex,
    observedAtActionKind: "speech.submit",
    channelId: "table",
    visibility: "public" as const,
    kind: "public-speech",
    evidenceRefs: [
      { artifact: "message" as const, id: messageId, seq: messageSeq },
      { artifact: "trace" as const, traceId, seq: turnIndex }
    ]
  };
}
