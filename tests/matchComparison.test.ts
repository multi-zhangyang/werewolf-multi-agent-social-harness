import { describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import type { AgentPendingAction } from "../src/core/pending";
import type { GameCommand, GameState, PlayerView } from "../src/core/types";
import type { MatchArtifact } from "../src/harness/artifacts";
import {
  buildMatchComparisonArtifact,
  MATCH_COMPARISON_ARTIFACT_VERSION,
  type MatchComparisonProjection
} from "../src/harness/matchComparison";
import type { SocialEpisodeArtifact, SocialExposureRecord, SocialMessage } from "../src/harness/social";
import type { SocialHarnessStep } from "../src/harness/social";
import { createAgentSocialState } from "../src/harness/socialState";
import type { AgentHarnessState, HarnessPlayerView, HarnessStepRecord, PolicyPlan } from "../src/harness/types";

const PRIVATE_SENTINEL = "PRIVATE_SENTINEL_DO_NOT_LEAK_MATCH_COMPARISON";
const BASE_CREATED_AT = "2026-01-02T03:04:05.000Z";
const CANDIDATE_CREATED_AT = "2026-01-03T03:04:05.000Z";
const COMPARISON_CREATED_AT = "2026-01-04T03:04:05.000Z";
const PROJECTION_GENERATED_AT = "2026-01-01T00:00:00.000Z";

describe("buildMatchComparisonArtifact", () => {
  it("builds a deterministic redacted comparison artifact without leaking private evidence", () => {
    const baselineState = createGame({ id: "comparison-baseline-state", seed: "comparison-baseline-seed" });
    const candidateState = createGame({ id: "comparison-candidate-state", seed: "comparison-candidate-seed" });
    const baseline = matchArtifactFixture({
      state: baselineState,
      runId: "run-baseline",
      matchId: "match-baseline",
      seed: "comparison-baseline-seed",
      createdAt: BASE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 2,
      evaluationWarningCount: 1,
      evaluatorCount: 2,
      modelCalls: 2,
      promptTokens: 40,
      completionTokens: 10,
      latencyMs: 120,
      winner: "village"
    });
    const candidate = matchArtifactFixture({
      state: candidateState,
      runId: "run-candidate",
      matchId: "match-candidate",
      seed: "comparison-candidate-seed",
      createdAt: CANDIDATE_CREATED_AT,
      trajectoryCount: 2,
      socialMessageCount: 3,
      evaluationMetricCount: 4,
      evaluationWarningCount: 2,
      evaluatorCount: 3,
      modelCalls: 5,
      promptTokens: 100,
      completionTokens: 25,
      latencyMs: 300,
      winner: "werewolves"
    });

    const comparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT
    });
    const repeatedComparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: "2030-01-01T00:00:00.000Z"
    });

    expect(comparison).toMatchObject({
      artifactVersion: MATCH_COMPARISON_ARTIFACT_VERSION,
      kind: "match-comparison",
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT,
      projection: {
        view: "postgame-redacted",
        privateEvidenceRedacted: true,
        postgameTruthRedacted: true,
        generatedAt: PROJECTION_GENERATED_AT
      }
    });
    expect(comparison.comparisonId).toMatch(/^match-comparison:[a-f0-9]{24}$/);
    expect(repeatedComparison.comparisonId).toBe(comparison.comparisonId);

    expect(comparison.baseline).toMatchObject({
      matchId: "match-baseline",
      runId: "run-baseline",
      seed: "comparison-baseline-seed",
      createdAt: BASE_CREATED_AT,
      status: "completed",
      models: ["comparison-model"],
      profileCount: 1,
      resolvedAssignmentCount: baselineState.players.length,
      agentCount: 1,
      trajectorySteps: 1,
      socialSteps: 1,
      socialMessages: 1,
      socialSpeechActs: 1,
      socialDeliveryReceipts: baselineState.players.length,
      socialChannels: 1,
      gameEvents: baseline.finalState.events.length,
      evaluationMetricCount: 2,
      evaluationWarningCount: 1,
      evaluatorCount: 2,
      projection: baseline.projection
    });
    expect(comparison.candidate).toMatchObject({
      matchId: "match-candidate",
      runId: "run-candidate",
      seed: "comparison-candidate-seed",
      createdAt: CANDIDATE_CREATED_AT,
      status: "completed",
      models: ["comparison-model"],
      profileCount: 1,
      resolvedAssignmentCount: candidateState.players.length,
      agentCount: 1,
      trajectorySteps: 2,
      socialSteps: 2,
      socialMessages: 3,
      socialSpeechActs: 3,
      socialDeliveryReceipts: candidateState.players.length * 3,
      socialChannels: 1,
      gameEvents: candidate.finalState.events.length,
      evaluationMetricCount: 4,
      evaluationWarningCount: 2,
      evaluatorCount: 3,
      projection: candidate.projection
    });
    expect(comparison.baseline.artifactHash).toBe(comparison.summary.baselineHash);
    expect(comparison.candidate.artifactHash).toBe(comparison.summary.candidateHash);
    expect(comparison.baseline.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(comparison.candidate.stateHash).toMatch(/^[a-f0-9]{64}$/);

    const rowsById = new Map(comparison.rows.map((row) => [row.id, row]));
    expect([...rowsById.keys()]).toEqual(
      expect.arrayContaining([
        "status",
        "winner",
        "trajectory_steps",
        "social_steps",
        "social_messages",
        "social_speech_acts",
        "social_delivery_receipts",
        "social_channels",
        "model_calls",
        "prompt_tokens",
        "completion_tokens",
        "evaluation_metrics",
        "evaluation_warnings",
        "evaluators",
        "social_exposures"
      ])
    );
    expect(rowsById.get("winner")).toMatchObject({ baseline: "village", candidate: "werewolves", changed: true });
    expect(rowsById.get("trajectory_steps")).toMatchObject({ baseline: 1, candidate: 2, delta: 1, changed: true });
    expect(rowsById.get("social_messages")).toMatchObject({ baseline: 1, candidate: 3, delta: 2, changed: true });
    expect(rowsById.get("social_speech_acts")).toMatchObject({ baseline: 1, candidate: 3, delta: 2, changed: true });
    expect(rowsById.get("social_delivery_receipts")).toMatchObject({
      baseline: baselineState.players.length,
      candidate: candidateState.players.length * 3,
      delta: candidateState.players.length * 3 - baselineState.players.length,
      changed: true
    });
    expect(rowsById.get("model_calls")).toMatchObject({ baseline: 2, candidate: 5, delta: 3, changed: true });
    expect(rowsById.get("evaluation_metrics")).toMatchObject({ baseline: 2, candidate: 4, delta: 2, changed: true });
    expect(rowsById.get("social_exposures")).toMatchObject({ baseline: 0, candidate: 0, delta: 0, changed: false });

    expect(comparison.summary).toEqual({
      rowCount: comparison.rows.length,
      changedRowCount: comparison.rows.filter((row) => row.changed).length,
      numericDeltaCount: comparison.rows.filter((row) => row.delta !== undefined).length,
      baselineHash: comparison.baseline.artifactHash,
      candidateHash: comparison.candidate.artifactHash
    });
    expect(JSON.stringify(comparison)).not.toContain(PRIVATE_SENTINEL);
  });

  it("prefers projected social exposure counts before deriving from redacted observations", () => {
    const baselineState = createGame({ id: "comparison-projected-baseline-state", seed: "comparison-projected-baseline-seed" });
    const candidateState = createGame({ id: "comparison-projected-candidate-state", seed: "comparison-projected-candidate-seed" });
    const baseline = matchArtifactFixture({
      state: baselineState,
      runId: "run-projected-baseline",
      matchId: "match-projected-baseline",
      seed: "comparison-projected-baseline-seed",
      createdAt: BASE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 20,
      winner: "village"
    });
    const candidate = matchArtifactFixture({
      state: candidateState,
      runId: "run-projected-candidate",
      matchId: "match-projected-candidate",
      seed: "comparison-projected-candidate-seed",
      createdAt: CANDIDATE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 20,
      winner: "werewolves"
    });
    attachProjectedExposureRecords(baseline, 2);
    attachProjectedExposureRecords(candidate, 5);

    const comparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT
    });
    const rowsById = new Map(comparison.rows.map((row) => [row.id, row]));

    expect(rowsById.get("social_exposures")).toMatchObject({ baseline: 2, candidate: 5, delta: 3, changed: true });
  });
});

function matchArtifactFixture(options: {
  state: GameState;
  runId: string;
  matchId: string;
  seed: string;
  createdAt: string;
  trajectoryCount: number;
  socialMessageCount: number;
  evaluationMetricCount: number;
  evaluationWarningCount: number;
  evaluatorCount: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  winner: "village" | "werewolves";
}): MatchArtifact & { projection: MatchComparisonProjection } {
  const state = {
    ...options.state,
    seed: options.seed,
    winner: options.winner,
    events: [
      ...options.state.events,
      {
        id: `${options.runId}:postgame-private-event`,
        seq: options.state.events.length + 1,
        day: 1,
        phase: "game_over" as const,
        type: "game.ended" as const,
        visibility: "postgame" as const,
        payload: { privateNote: PRIVATE_SENTINEL },
        createdAt: options.createdAt
      }
    ]
  };
  const channels = [
    {
      id: `${options.runId}:public`,
      kind: "public" as const,
      participantIds: state.players.map((player) => player.id),
      readableBy: "all" as const
    }
  ];
  const messages = Array.from({ length: options.socialMessageCount }, (_, index): SocialMessage => ({
    id: `${options.runId}:message:${index + 1}`,
    seq: index + 1,
    channelId: channels[0].id,
    senderId: state.players[0].id,
    recipientIds: state.players.slice(1).map((player) => player.id),
    visibility: index === 0 ? "private" : "public",
    content: index === 0 ? PRIVATE_SENTINEL : `public comparison message ${index + 1}`,
    speechActs: [
      {
        id: `${options.runId}:message:${index + 1}:act:1`,
        kind: index === 0 ? "private_note" : "claim",
        subjectId: state.players[0].id,
        value: `comparison-act-${index + 1}`,
        confidence: 1,
        evidenceRefs: [{ artifact: "message", id: `${options.runId}:message:${index + 1}`, seq: index + 1 }]
      }
    ],
    deliveryReceipts: state.players.map((player, receiptIndex) => ({
      id: `${options.runId}:message:${index + 1}:delivery:${receiptIndex + 1}:${player.id}`,
      messageId: `${options.runId}:message:${index + 1}`,
      messageSeq: index + 1,
      channelId: channels[0].id,
      senderId: state.players[0].id,
      observerId: player.id,
      visibility: index === 0 ? "private" : "public",
      deliveredAtTurn: index + 1,
      redactionPolicy: `runtime-visible:${index === 0 ? "private" : "public"}`
    })),
    createdAt: options.createdAt,
    metadata: { traceId: `${options.runId}:trace:${index + 1}`, kind: "comparison-fixture" }
  }));
  const steps = Array.from({ length: options.trajectoryCount }, (_, index) =>
    harnessStepFixture({
      state,
      runId: options.runId,
      turnIndex: index,
      observedMessages: messages.slice(0, Math.min(messages.length, index + 1))
    })
  );
  const socialEpisode: SocialEpisodeArtifact<GameState, HarnessPlayerView, AgentPendingAction, GameCommand> = {
    id: `${options.runId}:social`,
    status: "completed",
    schedulerMode: "aec",
    profiles: [{ id: "profile-comparison", model: "comparison-model", temperature: 0 }],
    channels,
    initialState: state,
    finalState: state,
    steps,
    messages
  };
  const metrics = Array.from({ length: options.evaluationMetricCount }, (_, index) => ({
    id: `${options.runId}:metric:${index + 1}`,
    label: `Metric ${index + 1}`,
    scope: "episode" as const,
    value: index + 1,
    source: "matchComparison.test"
  }));
  const evaluatorIds = Array.from({ length: options.evaluatorCount }, (_, index) => `${options.runId}:evaluator:${index + 1}`);
  const warnings = Array.from({ length: options.evaluationWarningCount }, (_, index) => ({
    code: `comparison.warning.${index + 1}`,
    severity: "warning" as const,
    message: `comparison warning ${index + 1}`
  }));
  const agent = agentFixture(state, options.runId);
  const projection: MatchComparisonProjection = {
    view: "postgame-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: true,
    generatedAt: PROJECTION_GENERATED_AT
  };

  return {
    artifactVersion: "harness.match.v1",
    kind: "match",
    runId: options.runId,
    matchId: options.matchId,
    createdAt: options.createdAt,
    seed: options.seed,
    config: state.config,
    models: ["comparison-model"],
    profiles: [{ id: "profile-comparison", model: "comparison-model", temperature: 0, policyName: "balanced" }],
    assignment: { strategy: "profile-rotation" },
    resolvedAssignments: state.players.map((player) => ({
      playerId: player.id,
      seat: player.seat,
      role: player.role,
      team: player.team,
      profileId: "profile-comparison",
      model: "comparison-model",
      temperature: 0,
      policyName: "balanced"
    })),
    status: "completed",
    initialState: state,
    finalState: state,
    trajectory: steps,
    socialEpisode,
    events: state.events,
    evaluation: {
      winner: options.winner,
      teamRewards: { village: options.winner === "village" ? 1 : 0, werewolves: options.winner === "werewolves" ? 1 : 0 },
      agentRewards: [],
      voteAccuracyByAgent: {},
      influenceByAgent: {},
      deceptionByAgent: {},
      trajectory: []
    },
    evaluationReport: {
      id: `${options.runId}:evaluation`,
      createdAt: options.createdAt,
      evaluatorIds,
      evaluatorRegistry: [],
      metricCount: metrics.length,
      metrics,
      outputs: {},
      warnings,
      summary: { teamScores: {}, agentScores: {}, profileScores: {}, modelScores: {} }
    },
    metrics: {
      winner: options.winner,
      days: 1,
      totalDeaths: 0,
      totalSpeeches: options.trajectoryCount,
      totalVotes: options.socialMessageCount,
      harnessTurnCount: options.trajectoryCount,
      harnessErrorCount: 0,
      averageLatencyMs: options.latencyMs / Math.max(options.modelCalls, 1),
      wolfVoteAccuracy: 0,
      villageVoteAccuracy: 0,
      deceptionSurvivalScore: 0,
      modelUsage: {
        "comparison-model": {
          calls: options.modelCalls,
          promptTokens: options.promptTokens,
          completionTokens: options.completionTokens,
          latencyMs: options.latencyMs
        }
      }
    },
    agents: [agent],
    projection
  };
}

function attachProjectedExposureRecords(artifact: MatchArtifact, count: number): void {
  artifact.socialEpisode.exposureRecords = Array.from({ length: count }, (_, index) => socialExposureRecordFixture(artifact.runId, index + 1));
}

function socialExposureRecordFixture(runId: string, index: number): SocialExposureRecord {
  const messageId = `${runId}:projected-exposure-message:${index}`;
  const traceId = `${runId}:projected-exposure-trace:${index}`;
  return {
    messageId,
    messageSeq: index,
    sourceId: `${runId}:source`,
    observerId: `${runId}:observer:${index}`,
    observedAtTraceId: traceId,
    observedAtTurnIndex: index,
    observedAtActionKind: "projected",
    channelId: `${runId}:public`,
    visibility: "public",
    evidenceRefs: [
      { artifact: "message", id: messageId, seq: index },
      { artifact: "trace", traceId, seq: index }
    ]
  };
}

function harnessStepFixture(options: {
  state: GameState;
  runId: string;
  turnIndex: number;
  observedMessages: SocialMessage[];
}): HarnessStepRecord & SocialHarnessStep<HarnessPlayerView, AgentPendingAction, GameCommand> {
  const actor = options.state.players[0];
  const target = options.state.players[1];
  const pendingAction: AgentPendingAction = {
    kind: "speech",
    phase: "day_speech",
    actorId: actor.id,
    legalPressureTargetIds: [target.id]
  };
  const command: GameCommand = {
    type: "speech.submit",
    actorId: actor.id,
    text: `public fixture speech ${options.turnIndex + 1}`,
    pressureTargetId: target.id,
    strategyTags: ["comparison-fixture"]
  };
  const policyPlan: PolicyPlan = {
    policyName: "balanced",
    command,
    intent: "exercise match comparison rows",
    confidence: 0.7,
    strategyTags: ["comparison-fixture"],
    pressureTargetId: target.id,
    targetId: target.id
  };
  const traceId = `${options.runId}:trace:${options.turnIndex + 1}`;

  return {
    traceId,
    turnIndex: options.turnIndex,
    actorId: actor.id,
    profileId: "profile-comparison",
    schedulerMode: "aec",
    model: "comparison-model",
    pendingAction,
    observation: playerViewFixture(options.state, pendingAction, options.observedMessages),
    action: {
      actorId: actor.id,
      kind: "speech",
      traceId,
      command
    },
    decisionStateHash: `${options.runId}:decision:${options.turnIndex}`,
    preStateHash: `${options.runId}:pre:${options.turnIndex}`,
    policyPlan,
    reasonerOutput: {
      content: PRIVATE_SENTINEL,
      latencyMs: 5,
      promptTokens: 3,
      completionTokens: 2
    },
    command,
    turnTrace: {
      traceId,
      playerId: actor.id,
      profileId: "profile-comparison",
      model: "comparison-model",
      actionKind: "speech",
      policyName: "balanced",
      commandType: "speech.submit",
      intent: "exercise match comparison rows",
      targetId: target.id,
      confidence: 0.7,
      strategyTags: ["comparison-fixture"],
      beliefs: {},
      privateMemo: PRIVATE_SENTINEL,
      publicSpeech: `public fixture speech ${options.turnIndex + 1}`,
      latencyMs: 5,
      promptTokens: 3,
      completionTokens: 2
    },
    agentStateHash: `${options.runId}:agent:${options.turnIndex}`,
    postStateHash: `${options.runId}:post:${options.turnIndex}`,
    eventSeqRange: [1, options.state.events.length],
    messageSeqRange: options.observedMessages.length ? [1, options.observedMessages.length] : undefined
  };
}

function playerViewFixture(state: GameState, pendingAction: AgentPendingAction, visibleMessages: SocialMessage[]): HarnessPlayerView {
  const actor = state.players[0];
  const publicPlayers: PlayerView["publicPlayers"] = state.players.map((player) => ({
    id: player.id,
    seat: player.seat,
    name: player.name,
    alive: player.alive,
    isSheriff: player.isSheriff,
    revealedRole: player.alive ? undefined : player.role,
    eliminatedAt: player.eliminatedAt
  }));

  return {
    gameId: state.id,
    seed: state.seed,
    phase: "day_speech",
    day: 1,
    you: {
      id: actor.id,
      seat: actor.seat,
      name: actor.name,
      role: actor.role,
      team: actor.team,
      alive: actor.alive,
      ability: actor.ability
    },
    publicPlayers,
    privateInfo: { werewolfAllies: [PRIVATE_SENTINEL] },
    speeches: [],
    votes: [],
    deaths: [],
    recentEvents: state.events,
    pendingAction,
    social: {
      channels: [
        {
          id: `${state.id}:public`,
          kind: "public",
          participantIds: state.players.map((player) => player.id),
          readableBy: "all"
        }
      ],
      messages: visibleMessages
    }
  };
}

function agentFixture(state: GameState, runId: string): AgentHarnessState {
  const social = createAgentSocialState<PlayerView, AgentPendingAction, GameCommand>({
    agentId: state.players[0].id,
    profile: { id: "profile-comparison", model: "comparison-model", policyId: "balanced" }
  });
  social.relationships.edges[state.players[1].id] = {
    targetId: state.players[1].id,
    trust: 0.1,
    suspicion: 0.9,
    affinity: 0,
    influence: 0,
    debt: 0,
    respect: 0,
    threat: 0.4,
    evidenceRefs: [{ artifact: "trace", traceId: `${runId}:trace:1`, description: PRIVATE_SENTINEL }],
    updatedAt: BASE_CREATED_AT
  };

  return {
    playerId: state.players[0].id,
    profileId: "profile-comparison",
    model: "comparison-model",
    temperature: 0,
    policyName: "balanced",
    turns: 1,
    observations: 1,
    beliefs: {},
    privateMemos: [PRIVATE_SENTINEL],
    lastIntent: "exercise match comparison rows",
    social,
    socialStateHash: `${runId}:social-state`
  };
}
