import { describe, expect, it } from "vitest";
import { assertServerProjectedArtifactContract } from "../src/components/cockpit/socialNetworkContract";
import type { PostgameMatchProjectionDto, SocialNetworkProjectionDto } from "../src/server/artifactProjection";

describe("cockpit social-network runtime contract", () => {
  it("accepts a matching server-owned postgame projection", () => {
    expect(() => assertServerProjectedArtifactContract(artifactWith(network()), "fixture")).not.toThrow();
  });

  it("rejects missing modes with a contract error instead of a TypeError", () => {
    const value = network() as unknown as { modes?: SocialNetworkProjectionDto["modes"] };
    delete value.modes;
    expect(() => assertServerProjectedArtifactContract(artifactWith(value as SocialNetworkProjectionDto), "fixture"))
      .toThrow("social-network modes are malformed");
  });

  it("rejects record-count drift, unknown nodes, duplicate ids, and invalid scores", () => {
    const countDrift = network();
    countDrift.modes.relationships.recordCount = 1;
    expect(() => assertServerProjectedArtifactContract(artifactWith(countDrift), "fixture"))
      .toThrow("mode counts do not match");

    const unknownNode = network();
    unknownNode.relationshipEdges.push(relationship("p1", "missing"));
    unknownNode.modes.relationships.recordCount = 1;
    expect(() => assertServerProjectedArtifactContract(artifactWith(unknownNode), "fixture"))
      .toThrow("relationship edge references an unknown node");

    const invalidScore = network();
    invalidScore.relationshipEdges.push({ ...relationship("p1", "p2"), trust: 1.1 });
    invalidScore.modes.relationships.recordCount = 1;
    expect(() => assertServerProjectedArtifactContract(artifactWith(invalidScore), "fixture"))
      .toThrow("dimensions must be finite signed scores");

    const duplicateIds = network();
    duplicateIds.relationshipEdges.push(relationship("p1", "p2"));
    duplicateIds.communicationEdges.push({
      id: "p1::p2",
      sourceId: "p1",
      targetId: "p2",
      channelId: "table",
      visibility: "public",
      messageCount: 1,
      messageSeqs: [1]
    });
    duplicateIds.modes.relationships.recordCount = 1;
    duplicateIds.modes.communication.recordCount = 1;
    expect(() => assertServerProjectedArtifactContract(artifactWith(duplicateIds), "fixture"))
      .toThrow("communication edge is malformed");
  });

  it("rejects malformed communication and exposure counts", () => {
    const communication = network();
    communication.communicationEdges.push({
      id: "communication",
      sourceId: "p1",
      targetId: "p2",
      channelId: "table",
      visibility: "public",
      messageCount: 2,
      messageSeqs: [1]
    });
    communication.modes.communication.recordCount = 1;
    expect(() => assertServerProjectedArtifactContract(artifactWith(communication), "fixture"))
      .toThrow("communication edge is malformed");

    const exposure = network();
    exposure.exposureEdges.push({
      id: "exposure",
      sourceId: "p1",
      targetId: "p2",
      channelId: "table",
      visibility: "public",
      uniqueMessageCount: 2,
      observationCount: 1,
      messageRefs: [{ id: "message-1", seq: 1 }],
      actionKinds: ["speech.submit"],
      traceIds: ["trace-1"],
      turnIndexes: [1],
      evidenceCount: 2
    });
    exposure.modes.exposure.recordCount = 1;
    expect(() => assertServerProjectedArtifactContract(artifactWith(exposure), "fixture"))
      .toThrow("exposure edge is malformed");
  });

  it("rejects every private social topology surface in truth-redacted views", () => {
    const value = network("truth-redacted");
    value.nodes[0]!.profileId = "private-profile";
    expect(() => assertServerProjectedArtifactContract(artifactWith(value, "truth-redacted"), "fixture"))
      .toThrow("exposed private social evidence");

    const communication = network("truth-redacted");
    communication.modes.communication.available = true;
    expect(() => assertServerProjectedArtifactContract(artifactWith(communication, "truth-redacted"), "fixture"))
      .toThrow("exposed private social evidence");
  });
});

function artifactWith(
  socialNetwork: SocialNetworkProjectionDto,
  view: "postgame-redacted" | "truth-redacted" = "postgame-redacted"
): PostgameMatchProjectionDto {
  return {
    projection: {
      view,
      privateEvidenceRedacted: true,
      postgameTruthRedacted: view === "truth-redacted",
      generatedAt: "2026-07-23T00:00:00.000Z"
    },
    socialEpisode: {
      exposureSummary: {
        schemaVersion: "server.social-exposure-summary.v1",
        privateEvidenceRedacted: true,
        source: "scoped_observation"
      }
    },
    socialNetwork
  } as unknown as PostgameMatchProjectionDto;
}

function network(view: "postgame-redacted" | "truth-redacted" = "postgame-redacted"): SocialNetworkProjectionDto {
  const available = view === "postgame-redacted";
  return {
    artifactVersion: "server.social-network-projection.v1",
    kind: "social-network-projection",
    authority: "server-owned-match-artifact",
    scope: "final-agent-snapshot",
    projection: {
      view,
      privateEvidenceRedacted: true,
      postgameTruthRedacted: view === "truth-redacted",
      generatedAt: "2026-07-23T00:00:00.000Z"
    },
    modes: {
      relationships: { available, recordCount: 0 },
      communication: { available, recordCount: 0 },
      exposure: { available, recordCount: 0 }
    },
    nodes: [node("p1"), node("p2")],
    relationshipEdges: [],
    communicationEdges: [],
    exposureEdges: []
  };
}

function node(id: string): SocialNetworkProjectionDto["nodes"][number] {
  return {
    id,
    sentMessageCount: 0,
    deliveryCount: 0,
    receivedMessageCount: 0,
    observedMessageCount: 0,
    observationCount: 0,
    relationshipCount: 0
  };
}

function relationship(sourceId: string, targetId: string): SocialNetworkProjectionDto["relationshipEdges"][number] {
  return {
    id: `${sourceId}::${targetId}`,
    sourceId,
    targetId,
    trust: 0.2,
    suspicion: -0.1,
    affinity: 0,
    influence: 0.1,
    debt: 0,
    respect: 0.1,
    threat: 0,
    evidenceRefs: [{ artifact: "message", id: "message-1", seq: 1 }],
    updatedAt: "2026-07-23T00:00:00.000Z"
  };
}
