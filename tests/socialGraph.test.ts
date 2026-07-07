import { describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import { MATCH_ARTIFACT_VERSION, type MatchArtifact } from "../src/harness/artifacts";
import { buildSocialGraph } from "../src/App";
import type { SocialExposureRecord, SocialMessage } from "../src/harness/social";

describe("artifact social graph", () => {
  it("derives message exposure edges from scoped observations, not recipient envelopes", () => {
    const artifact = createExposureArtifact({
      directObservedBy: ["p3"],
      wrappedObservedBy: []
    });

    const graph = buildSocialGraph(artifact);

    expect(graph.messageEdges.map((edge) => [edge.sourceId, edge.targetId, edge.messages])).toEqual([
      ["p1", "p2", 1],
      ["p1", "p3", 1]
    ]);
    expect(graph.exposureEdges).toHaveLength(1);
    expect(graph.exposureEdges[0]).toMatchObject({
      sourceId: "p1",
      targetId: "p3",
      channelId: "table",
      visibility: "public",
      kind: "public-speech",
      messages: 1,
      observations: 1,
      actionKinds: ["speech.submit"],
      traceIds: ["trace-direct-p3"],
      turnIndexes: [3],
      evidenceCount: 1,
      evidenceLabels: ["msg#1 observed@turn3 speech.submit trace-direct-p3"]
    });
    expect(graph.exposureEdges.some((edge) => edge.targetId === "p2")).toBe(false);
    expect(graph.nodes.find((node) => node.id === "p2")).toMatchObject({ received: 1, observed: 0 });
    expect(graph.nodes.find((node) => node.id === "p3")).toMatchObject({ received: 1, observed: 1 });
  });

  it("also reads wrapped generic social adapter observations", () => {
    const artifact = createExposureArtifact({
      directObservedBy: [],
      wrappedObservedBy: ["p2"]
    });

    const graph = buildSocialGraph(artifact);

    expect(graph.exposureEdges).toHaveLength(1);
    expect(graph.exposureEdges[0]).toMatchObject({
      sourceId: "p1",
      targetId: "p2",
      channelId: "table",
      visibility: "public",
      kind: "public-speech",
      messages: 1,
      observations: 1,
      actionKinds: ["speech.submit"],
      traceIds: ["trace-wrapped-p2"],
      turnIndexes: [3],
      evidenceCount: 1,
      evidenceLabels: ["msg#1 observed@turn3 speech.submit trace-wrapped-p2"]
    });
  });

  it("uses server-projected exposureRecords before observation-derived exposure", () => {
    const artifact = createExposureArtifact({
      directObservedBy: ["p3"],
      wrappedObservedBy: [],
      exposureRecords: [projectedExposure("p2", "trace-projected-p2", 4)]
    });

    const graph = buildSocialGraph(artifact);

    expect(graph.exposureEdges).toHaveLength(1);
    expect(graph.exposureEdges[0]).toMatchObject({
      sourceId: "p1",
      targetId: "p2",
      channelId: "table",
      visibility: "public",
      kind: "public-speech",
      messages: 1,
      observations: 1,
      actionKinds: ["speech.submit"],
      traceIds: ["trace-projected-p2"],
      turnIndexes: [4],
      evidenceCount: 1,
      evidenceLabels: ["msg#1 observed@turn4 speech.submit trace-projected-p2"]
    });
    expect(graph.exposureEdges.some((edge) => edge.targetId === "p3")).toBe(false);
    expect(graph.nodes.find((node) => node.id === "p2")).toMatchObject({ received: 1, observed: 1 });
    expect(graph.nodes.find((node) => node.id === "p3")).toMatchObject({ received: 1, observed: 0 });
  });

  it("does not derive exposure from redacted postgame projections without server records", () => {
    const artifact = createExposureArtifact({
      directObservedBy: ["p3"],
      wrappedObservedBy: [],
      projection: true
    });

    const graph = buildSocialGraph(artifact);

    expect(graph.exposureEdges).toEqual([]);
    expect(graph.nodes.find((node) => node.id === "p3")).toMatchObject({ received: 1, observed: 0 });
  });

  it("uses server-projected exposureRecords when social observations are redacted", () => {
    const artifact = createExposureArtifact({
      directObservedBy: ["p3"],
      wrappedObservedBy: [],
      exposureRecords: [projectedExposure("p2", "trace-redacted-projected-p2", 5)],
      projection: true,
      redactSocialObservations: true
    });

    const graph = buildSocialGraph(artifact);

    expect(graph.exposureEdges).toHaveLength(1);
    expect(graph.exposureEdges[0]).toMatchObject({
      sourceId: "p1",
      targetId: "p2",
      traceIds: ["trace-redacted-projected-p2"],
      turnIndexes: [5]
    });
  });
});

function createExposureArtifact(options: {
  directObservedBy: string[];
  wrappedObservedBy: string[];
  exposureRecords?: SocialExposureRecord[];
  projection?: boolean;
  redactSocialObservations?: boolean;
}): MatchArtifact & {
  projection?: {
    view: "postgame-redacted";
    privateEvidenceRedacted: boolean;
    postgameTruthRedacted: boolean;
    generatedAt: string;
  };
} {
  const state = createGame({ id: "social-graph-exposure", seed: "social-graph-exposure" });
  const publicSpeech: SocialMessage = {
    id: "msg-1",
    seq: 1,
    channelId: "table",
    senderId: "p1",
    recipientIds: ["p2", "p3"],
    visibility: "public",
    content: "p1 made a public claim that only recorded scoped observations can turn into exposure evidence.",
    createdAt: "2026-01-01T00:00:01.000Z",
    metadata: { kind: "public-speech" }
  };
  const privateMemo: SocialMessage = {
    id: "msg-2",
    seq: 2,
    channelId: "private-p1",
    senderId: "p1",
    recipientIds: ["p1"],
    visibility: "private",
    content: "private memo must remain self-only envelope flow unless a scoped observation records it.",
    createdAt: "2026-01-01T00:00:02.000Z",
    metadata: { kind: "private-reasoner-memo" }
  };

  const directSteps = options.directObservedBy.map((observerId, index) => ({
    traceId: `trace-direct-${observerId}`,
    turnIndex: index + 3,
    actorId: observerId,
    profileId: `profile-${observerId}`,
    schedulerMode: "aec" as const,
    pendingAction: { kind: "speech", actorId: observerId },
    observation: {
      gameId: state.id,
      phase: "day_speech",
      day: 1,
      you: { id: observerId },
      pendingAction: { kind: "speech", actorId: observerId },
      social: { channels: [], messages: [publicSpeech] }
    },
    action: { actorId: observerId, kind: "speech.submit", command: { type: "speech.submit", actorId: observerId, text: "observed message" } }
  }));
  const wrappedSteps = options.wrappedObservedBy.map((observerId, index) => ({
    traceId: `trace-wrapped-${observerId}`,
    turnIndex: index + 3,
    actorId: observerId,
    profileId: `profile-${observerId}`,
    schedulerMode: "aec" as const,
    pendingAction: { kind: "speech", actorId: observerId },
    observation: {
      kind: "player",
      agentId: observerId,
      view: {
        gameId: state.id,
        phase: "day_speech",
        day: 1,
        you: { id: observerId },
        pendingAction: { kind: "speech", actorId: observerId },
        social: { channels: [], messages: [publicSpeech] }
      }
    },
    action: { actorId: observerId, kind: "speech.submit", command: { type: "speech.submit", actorId: observerId, text: "observed message" } }
  }));

  const steps = [...directSteps, ...wrappedSteps];
  const artifact: MatchArtifact & {
    projection?: {
      view: "postgame-redacted";
      privateEvidenceRedacted: boolean;
      postgameTruthRedacted: boolean;
      generatedAt: string;
    };
  } = {
    artifactVersion: MATCH_ARTIFACT_VERSION,
    kind: "match",
    runId: "social-graph-exposure-run",
    createdAt: "2026-01-01T00:00:00.000Z",
    seed: state.seed,
    config: state.config,
    models: ["stub-model"],
    profiles: [{ id: "profile-p1", model: "stub-model", temperature: 0 }],
    resolvedAssignments: [
      { playerId: "p1", seat: 1, model: "stub-model", temperature: 0 },
      { playerId: "p2", seat: 2, model: "stub-model", temperature: 0 },
      { playerId: "p3", seat: 3, model: "stub-model", temperature: 0 }
    ],
    status: "completed",
    initialState: state,
    finalState: state,
    trajectory: [],
    socialEpisode: {
      id: "social-graph-exposure-episode",
      status: "completed",
      schedulerMode: "aec",
      profiles: [],
      channels: [
        { id: "table", kind: "public", participantIds: ["p1", "p2", "p3"], readableBy: "all" },
        { id: "private-p1", kind: "private", participantIds: ["p1"], readableBy: "participants" }
      ],
      initialState: state,
      finalState: state,
      steps: options.redactSocialObservations
        ? steps.map((step) => ({
            ...step,
            observation: "[REDACTED private social observation]"
          }))
        : steps,
      messages: [publicSpeech, privateMemo],
      exposureRecords: options.exposureRecords,
      exposureSummary: options.exposureRecords
        ? {
            schemaVersion: "server.social-exposure-summary.v1",
            source: "scoped_observation",
            privateEvidenceRedacted: true,
            recordCount: options.exposureRecords.length,
            messageCount: new Set(options.exposureRecords.map((record) => record.messageId)).size,
            sourceCount: new Set(options.exposureRecords.map((record) => record.sourceId)).size,
            observerCount: new Set(options.exposureRecords.map((record) => record.observerId)).size,
            byVisibility: {
              private: options.exposureRecords.filter((record) => record.visibility === "private").length,
              team: options.exposureRecords.filter((record) => record.visibility === "team").length,
              public: options.exposureRecords.filter((record) => record.visibility === "public").length,
              postgame: options.exposureRecords.filter((record) => record.visibility === "postgame").length
            }
          }
        : undefined
    },
    events: [],
    evaluation: {
      teamRewards: { village: 0, werewolves: 0 },
      agentRewards: [],
      voteAccuracyByAgent: {},
      influenceByAgent: {},
      deceptionByAgent: {},
      trajectory: []
    },
    evaluationReport: {
      id: "empty-report",
      createdAt: "2026-01-01T00:00:00.000Z",
      evaluatorIds: [],
      metricCount: 0,
      metrics: [],
      outputs: {},
      summary: { teamScores: {}, agentScores: {}, profileScores: {}, modelScores: {} }
    },
    metrics: {
      days: 1,
      totalDeaths: 0,
      totalSpeeches: 0,
      totalVotes: 0,
      harnessTurnCount: 0,
      harnessErrorCount: 0,
      averageLatencyMs: 0,
      wolfVoteAccuracy: 0,
      villageVoteAccuracy: 0,
      deceptionSurvivalScore: 0,
      modelUsage: {}
    },
    agents: [
      {
        playerId: "p1",
        model: "stub-model",
        temperature: 0,
        policyName: "balanced",
        turns: 0,
        observations: 0,
        beliefs: {},
        privateMemos: []
      },
      {
        playerId: "p2",
        model: "stub-model",
        temperature: 0,
        policyName: "balanced",
        turns: 0,
        observations: 0,
        beliefs: {},
        privateMemos: []
      },
      {
        playerId: "p3",
        model: "stub-model",
        temperature: 0,
        policyName: "balanced",
        turns: 0,
        observations: 0,
        beliefs: {},
        privateMemos: []
      }
    ]
  };
  if (options.projection) {
    artifact.projection = {
      view: "postgame-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: false,
      generatedAt: "2026-01-01T00:00:00.000Z"
    };
  }
  return artifact;
}

function projectedExposure(observerId: string, traceId: string, turnIndex: number): SocialExposureRecord {
  return {
    messageId: "msg-1",
    messageSeq: 1,
    sourceId: "p1",
    observerId,
    observedAtTraceId: traceId,
    observedAtTurnIndex: turnIndex,
    observedAtActionKind: "speech.submit",
    channelId: "table",
    visibility: "public",
    kind: "public-speech",
    evidenceRefs: [
      { artifact: "message", id: "msg-1", seq: 1 },
      { artifact: "trace", traceId, seq: turnIndex },
      { artifact: "observation", traceId, seq: turnIndex }
    ]
  };
}
