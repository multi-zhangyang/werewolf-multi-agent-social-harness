import { describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import {
  buildFinalHarnessCheckpoint,
  buildHarnessCheckpointAtPrefix,
  buildMatchArtifact,
  forkHarnessRunOptions,
  validateHarnessCheckpoint,
  type MatchArtifact
} from "../src/harness/artifacts";
import { buildReplayableSocialPrefix } from "../src/harness/episodeArtifacts";
import { hashStableState } from "../src/harness/hash";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { replayHarnessTrajectory, replaySocialEpisode, replayWerewolfSocialEpisode } from "../src/harness/replay";
import { runHarnessMatch } from "../src/harness/runtime";
import {
  isSocialStepCommitted,
  SocialCommunicationBus,
  type SocialChannel,
  type SocialEnvironment,
  type SocialEpisodeArtifact,
  type SocialMessage,
  type SocialParallelEnvironment
} from "../src/harness/social";
import type { HarnessReasoner, HarnessRunResult, HarnessStepRecord } from "../src/harness/types";

const reasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? "我按公开信息发言，重点看夜晚死亡、发言压力和票型关系，今天先统一视角，不急着扩大身份对跳。"
        : `replay-test:${input.agent.model}:${input.action.kind}:${input.policyPlan.policyName}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        providerRequestId: `replay-${input.traceId}`,
        attempts: 1
      }
    };
  }
};

describe("harness trajectory replay", () => {
  it("round-trips a real run artifact without calling a reasoner", async () => {
    const initialState = createGame({ id: "replay-roundtrip", seed: "replay-roundtrip" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);
    let reasonerCalls = 0;
    const countingReasoner: HarnessReasoner = {
      async think(input) {
        reasonerCalls += 1;
        return reasoner.think(input);
      }
    };
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: countingReasoner,
      maxTransitions: 8
    });
    const artifact = buildMatchArtifact({
      runId: "replay-roundtrip",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    const parsedArtifact = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
    const reasonerCallsBeforeReplay = reasonerCalls;

    const replay = replayWerewolfSocialEpisode(parsedArtifact.socialEpisode, {
      agentSnapshotFrames: parsedArtifact.agentSnapshotFrames
    });

    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.replayedSteps).toBe(parsedArtifact.socialEpisode.steps.filter((step) => isSocialStepCommitted(step)).length);
    expect(replay.finalHash).toBe(hashStableState(result.state));
    expect(replay.expectedFinalHash).toBe(hashStableState(parsedArtifact.finalState));
    expect(replay.finalHash).toBe(hashStableState(parsedArtifact.finalState));
    expect(replay.finalState.phase).toBe(result.state.phase);
    expect(replay.agentStateAudit).toMatchObject({ ok: true });
    expect(parsedArtifact.socialEpisode.steps.length).toBeGreaterThan(parsedArtifact.trajectory.length);
    for (const legacyStep of parsedArtifact.trajectory) {
      expect(parsedArtifact.socialEpisode.steps.find((step) => step.traceId === legacyStep.traceId)?.commitStatus).toBe("committed");
    }
    expect(reasonerCalls).toBe(reasonerCallsBeforeReplay);
  });

  it("rejects missing or tampered native system steps and tampered committed player commands", async () => {
    const result = await buildReplayableRun("replay-native-authority-tamper");
    const systemStepIndex = result.socialEpisode.steps.findIndex(
      (step) => step.actorId === "system" && step.commitStatus === "committed"
    );
    if (systemStepIndex < 0) throw new Error("Expected an explicit committed system step.");

    const missingSystemStep = cloneJson(result.socialEpisode);
    missingSystemStep.steps.splice(systemStepIndex, 1);
    const missingSystemReplay = replayWerewolfSocialEpisode(missingSystemStep, { stopOnMismatch: false });
    expect(missingSystemReplay.ok).toBe(false);
    expect(missingSystemReplay.mismatches.join("\n")).toMatch(
      /preStateHash mismatch|committed step failed|Replay final state hash mismatch/
    );

    const systemHashTamper = cloneJson(result.socialEpisode);
    systemHashTamper.steps[systemStepIndex].postStateHash = "tampered-system-post-state-hash";
    const systemHashReplay = replayWerewolfSocialEpisode(systemHashTamper, { stopOnMismatch: false });
    expect(systemHashReplay.ok).toBe(false);
    expect(systemHashReplay.mismatches.join("\n")).toMatch(/postStateHash mismatch/);

    const commandTamper = cloneJson(result.socialEpisode);
    const killStep = commandTamper.steps.find((step) => step.action.command.type === "werewolf.killVote");
    if (!killStep || killStep.action.command.type !== "werewolf.killVote") throw new Error("Expected a committed wolf kill step.");
    if (killStep.pendingAction.kind !== "kill") throw new Error("Expected a wolf kill pending action.");
    const originalTargetId = killStep.action.command.targetId;
    const alternateTargetId = killStep.pendingAction.legalTargetIds.find(
      (targetId) => targetId !== originalTargetId
    );
    if (!alternateTargetId) throw new Error("Expected an alternate legal wolf target.");
    killStep.action.command.targetId = alternateTargetId;

    const commandReplay = replayWerewolfSocialEpisode(commandTamper, { stopOnMismatch: false });
    expect(commandReplay.ok).toBe(false);
    expect(commandReplay.mismatches.join("\n")).toMatch(/postStateHash mismatch/);
  });

  it("rejects a canonical Werewolf artifact whose recorded pending authorization was forged", async () => {
    const result = await buildReplayableRun("replay-pending-evidence-tamper");
    const forged = cloneJson(result.socialEpisode);
    const inspectStep = forged.steps.find(
      (step) => step.commitStatus === "committed" && step.action.command.type === "seer.inspect"
    );
    if (!inspectStep) throw new Error("Expected a committed seer inspect native step.");

    inspectStep.pendingAction = {
      kind: "vote",
      phase: "day_vote",
      actorId: inspectStep.actorId,
      legalTargetIds: []
    };

    const replay = replayWerewolfSocialEpisode(forged, { stopOnMismatch: false });
    expect(replay.ok).toBe(false);
    expect(replay.mismatches.join("\n")).toMatch(/recorded pending\/action evidence mismatch|recorded pending/i);
  });

  it("does not apply a rejected command or publish its message draft", () => {
    const draft = counterMessageDraft("rejected message must remain a draft");
    const episode = counterEpisode({
      commitStatus: "rejected",
      command: { delta: 1 },
      messages: [draft],
      finalValue: 0
    });
    let stepCalls = 0;
    const replay = replaySocialEpisode({
      episode,
      environment: counterEnvironment(() => {
        stepCalls += 1;
      }),
      hashState: hashStableState,
      hashMessages: hashStableState
    });

    expect(replay.ok).toBe(true);
    expect(replay.replayedSteps).toBe(0);
    expect(replay.rejectedSteps).toBe(1);
    expect(replay.finalState).toEqual({ value: 0 });
    expect(replay.messages).toEqual([]);
    expect(stepCalls).toBe(0);

    const forgedCommit = cloneJson(episode);
    forgedCommit.steps[0].commitStatus = "committed";
    const forgedReplay = replaySocialEpisode({
      episode: forgedCommit,
      environment: counterEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      stopOnMismatch: false
    });
    expect(forgedReplay.ok).toBe(false);
    expect(forgedReplay.mismatches.join("\n")).toMatch(
      /postStateHash mismatch|messageSeqRange mismatch|Replay final state hash mismatch|Replay messages hash mismatch/
    );
  });

  it("rejects a forged rejected parallel batch whose recorded state or event range changed", () => {
    const episode = counterEpisode({
      commitStatus: "rejected",
      command: { delta: 1 },
      finalValue: 0
    });
    episode.schedulerMode = "parallel";
    const first = episode.steps[0];
    first.schedulerMode = "parallel";
    first.atomic = true;
    first.resolutionPolicy = "parallel-stepBatch";
    first.batchId = "counter-parallel-rejected";
    first.batchSize = 2;

    const forgedSecond = cloneJson(first);
    forgedSecond.traceId = "counter-parallel-rejected-2";
    forgedSecond.turnIndex = 2;
    forgedSecond.batchIndex = 1;
    forgedSecond.actorId = "counter-agent-2";
    forgedSecond.profileId = "counter-profile-2";
    forgedSecond.action.actorId = forgedSecond.actorId;
    forgedSecond.postStateHash = hashStableState({ value: 9 });
    forgedSecond.eventSeqRange = [1, 1];
    episode.steps.push(forgedSecond);

    const replay = replaySocialEpisode({
      episode,
      environment: counterEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      stopOnMismatch: false
    });

    expect(replay.ok).toBe(false);
    expect(replay.replayedSteps).toBe(0);
    expect(replay.rejectedSteps).toBe(2);
    expect(replay.mismatches.join("\n")).toMatch(/rejected step changed domain state|rejected step changed event range/);
  });

  it("detects tampered initial message prefixes and committed message envelopes", () => {
    const draft: Omit<SocialMessage, "id" | "seq" | "createdAt"> = {
      ...counterMessageDraft("committed message"),
      speechActs: [
        {
          id: "",
          kind: "claim",
          subjectId: "counter-agent",
          value: "counter increment",
          confidence: 1,
          evidenceRefs: [],
          metadata: { topic: "counter" }
        }
      ]
    };
    const bus = new SocialCommunicationBus([COUNTER_CHANNEL]);
    const committedMessage = bus.publish(draft);
    const committedEpisode = counterEpisode({
      commitStatus: "committed",
      command: { delta: 1 },
      messages: [draft],
      finalValue: 1,
      recordedMessages: [committedMessage],
      messageSeqRange: [1, 1]
    });
    const validReplay = replaySocialEpisode({
      episode: committedEpisode,
      environment: counterEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState
    });
    expect(validReplay.ok).toBe(true);

    const envelopeTamper = cloneJson(committedEpisode);
    envelopeTamper.messages[0].content = "tampered committed envelope";
    const envelopeReplay = replaySocialEpisode({
      episode: envelopeTamper,
      environment: counterEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      stopOnMismatch: false
    });
    expect(envelopeReplay.ok).toBe(false);
    expect(envelopeReplay.mismatches.join("\n")).toMatch(/committed message envelopes do not match recorded messages/);
    expect(envelopeReplay.mismatches.join("\n")).toMatch(/Replay messages hash mismatch/);

    const speechActTamper = cloneJson(committedEpisode);
    const speechAct = speechActTamper.messages[0].speechActs?.[0];
    if (!speechAct) throw new Error("Expected a committed typed speech act.");
    speechAct.value = "tampered typed semantics";
    const speechActReplay = replaySocialEpisode({
      episode: speechActTamper,
      environment: counterEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState,
      stopOnMismatch: false
    });
    expect(speechActReplay.ok).toBe(false);
    expect(speechActReplay.mismatches.join("\n")).toMatch(/committed message envelopes do not match recorded messages/);
    expect(speechActReplay.mismatches.join("\n")).toMatch(/Replay messages hash mismatch/);

    const initialMessage = cloneJson(committedMessage);
    const initialPrefixEpisode: SocialEpisodeArtifact<CounterState, null, null, CounterCommand> = {
      id: "counter-initial-prefix",
      status: "completed",
      execution: {
        schemaVersion: "harness.social-execution.v1",
        started: true,
        initialMessageCount: 1,
        initialMessagesHash: hashStableState([initialMessage])
      },
      schedulerMode: "aec",
      profiles: [],
      channels: [COUNTER_CHANNEL],
      initialState: { value: 0 },
      finalState: { value: 0 },
      steps: [],
      messages: [initialMessage]
    };
    const initialHashTamper = cloneJson(initialPrefixEpisode);
    initialHashTamper.messages[0].content = "tampered initial message";
    const initialReplay = replaySocialEpisode({
      episode: initialHashTamper,
      environment: counterEnvironment(),
      hashState: hashStableState,
      hashMessages: hashStableState
    });
    expect(initialReplay.ok).toBe(false);
    expect(initialReplay.mismatches.join("\n")).toMatch(/Initial messages hash mismatch/);
  });

  it("fails clearly when a native parallel batch is replayed without stepBatch authority", () => {
    const episode = counterEpisode({
      commitStatus: "committed",
      command: { delta: 1 },
      finalValue: 1
    });
    episode.schedulerMode = "parallel";
    episode.steps[0].schedulerMode = "parallel";
    episode.steps[0].atomic = true;
    episode.steps[0].resolutionPolicy = "parallel-stepBatch";

    let sequentialStepCalls = 0;
    const replay = replaySocialEpisode({
      episode,
      environment: counterEnvironment(() => {
        sequentialStepCalls += 1;
      }),
      hashState: hashStableState,
      hashMessages: hashStableState,
      stopOnMismatch: false
    });

    expect(replay.ok).toBe(false);
    expect(replay.mismatches.join("\n")).toMatch(/environment does not implement stepBatch\(\)/);
    expect(replay.replayedSteps).toBe(0);
    expect(replay.replayedBatches).toBe(0);
    expect(sequentialStepCalls).toBe(0);
  });

  it("fails closed before any environment transition for malformed parallel batch layouts", () => {
    const cases: Array<{
      name: string;
      mutate: (episode: SocialEpisodeArtifact<CounterState, null, null, CounterCommand>) => void;
      expected: RegExp;
    }> = [
      {
        name: "atomic downgrade",
        mutate: (episode) => {
          episode.steps[0].atomic = false;
        },
        expected: /parallel step must be atomic/
      },
      {
        name: "resolution policy downgrade",
        mutate: (episode) => {
          episode.steps[0].resolutionPolicy = "sequential-apply";
        },
        expected: /must use resolutionPolicy parallel-stepBatch/
      },
      {
        name: "truncated batch",
        mutate: (episode) => {
          for (const step of episode.steps) step.batchSize = 3;
        },
        expected: /parallel batch counter-parallel is incomplete/
      },
      {
        name: "duplicate actor",
        mutate: (episode) => {
          const duplicate = episode.steps[1];
          duplicate.actorId = episode.steps[0].actorId;
          duplicate.action.actorId = duplicate.actorId;
        },
        expected: /duplicates actor counter-agent/
      }
    ];

    for (const testCase of cases) {
      const episode = parallelCounterEpisode();
      testCase.mutate(episode);
      let sequentialStepCalls = 0;
      let parallelBatchCalls = 0;
      const replay = replaySocialEpisode({
        episode,
        environment: counterParallelEnvironment({
          onStep() {
            sequentialStepCalls += 1;
          },
          onStepBatch() {
            parallelBatchCalls += 1;
          }
        }),
        hashState: hashStableState,
        hashMessages: hashStableState,
        stopOnMismatch: false
      });

      expect(replay.ok, testCase.name).toBe(false);
      expect(replay.replayedSteps, testCase.name).toBe(0);
      expect(replay.replayedBatches, testCase.name).toBe(0);
      expect(replay.mismatches.join("\n"), testCase.name).toMatch(testCase.expected);
      expect(sequentialStepCalls, testCase.name).toBe(0);
      expect(parallelBatchCalls, testCase.name).toBe(0);
    }
  });

  it("detects tampered command, hash, and event sequence range", async () => {
    const result = await buildReplayableRun("replay-tamper");
    const commandTamper = cloneSteps(result.trajectory);
    const killStep = commandTamper.find((step) => step.command.type === "werewolf.killVote");
    if (!killStep || killStep.command.type !== "werewolf.killVote") throw new Error("Expected a wolf kill step.");
    if (!("legalTargetIds" in killStep.pendingAction)) throw new Error("Expected legal target ids on wolf kill step.");
    const originalTargetId = killStep.command.targetId;
    const alternateTarget = killStep.pendingAction.legalTargetIds.find((targetId) => targetId !== originalTargetId);
    if (!alternateTarget) throw new Error("Expected an alternate legal wolf target.");
    killStep.command.targetId = alternateTarget;

    const commandReplay = replayHarnessTrajectory({
      initialState: result.initialState,
      trajectory: commandTamper
    });
    expect(commandReplay.ok).toBe(false);
    expect(commandReplay.mismatches.join("\n")).toMatch(/postStateHash mismatch/);

    const hashTamper = cloneSteps(result.trajectory);
    hashTamper[0].preStateHash = "tampered";
    const hashReplay = replayHarnessTrajectory({
      initialState: result.initialState,
      trajectory: hashTamper,
      stopOnMismatch: false
    });
    expect(hashReplay.ok).toBe(false);
    expect(hashReplay.mismatches.join("\n")).toMatch(/preStateHash mismatch/);

    const rangeTamper = cloneSteps(result.trajectory);
    rangeTamper[0].eventSeqRange = [999, 1000];
    const rangeReplay = replayHarnessTrajectory({
      initialState: result.initialState,
      trajectory: rangeTamper,
      stopOnMismatch: false
    });
    expect(rangeReplay.ok).toBe(false);
    expect(rangeReplay.mismatches.join("\n")).toMatch(/eventSeqRange mismatch/);
  });

  it("creates a native checkpoint and forks from restored harness state with provenance", async () => {
    const initialState = createGame({ id: "replay-fork", seed: "replay-fork" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);
    const parent = await runHarnessMatch({ initialState, agents, reasoner, maxTransitions: 3 });
    const artifact = buildMatchArtifact({
      runId: "parent-run",
      matchId: "parent-match",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result: parent
    });
    const checkpoint = buildFinalHarnessCheckpoint({
      artifact,
      checkpointId: "checkpoint-after-native-prefix",
      createdAt: "2026-07-04T00:00:00.000Z",
      reason: "native fork checkpoint"
    });

    expect(checkpoint).toMatchObject({
      artifactVersion: "harness.checkpoint.v2",
      kind: "checkpoint",
      source: {
        sourceArtifactVersion: "harness.match.v2",
        runId: "parent-run",
        matchId: "parent-match",
        nativeStepCount: artifact.socialEpisode.steps.length,
        messageCount: artifact.socialEpisode.messages.length,
        stateHash: hashStableState(parent.state),
        executionPrefixHash: hashStableState(checkpoint.executionPrefix),
        agentsHash: hashStableState(artifact.agents),
        channelsHash: hashStableState(artifact.socialEpisode.channels),
        messagesHash: hashStableState(artifact.socialEpisode.messages)
      }
    });
    expect(validateHarnessCheckpoint(checkpoint)).toEqual([]);
    expect(checkpoint.executionPrefix.steps).toEqual(artifact.socialEpisode.steps);
    expect(checkpoint.executionPrefix.messages).toEqual(artifact.socialEpisode.messages);

    const forkOptions = forkHarnessRunOptions({
      checkpoint,
      reasoner,
      maxTransitions: 1,
      createdAt: "2026-07-04T00:01:00.000Z",
      reason: "continue one native action"
    });
    expect(forkOptions.initialState).toEqual(checkpoint.state);
    expect(forkOptions.initialAgentStates).toEqual(checkpoint.agents);
    expect(forkOptions.initialSocialChannels).toEqual(checkpoint.executionPrefix.channels);
    expect(forkOptions.initialSocialMessages).toEqual(checkpoint.executionPrefix.messages);
    expect(forkOptions.forkOf).toMatchObject({
      schemaVersion: "harness.fork-provenance.v2",
      checkpointArtifactVersion: "harness.checkpoint.v2",
      checkpointId: checkpoint.checkpointId,
      parentBoundaryTraceId: checkpoint.source.boundaryTraceId,
      parentBoundaryTurnIndex: checkpoint.source.boundaryTurnIndex,
      parentStateHash: checkpoint.source.stateHash,
      parentExecutionPrefixHash: checkpoint.source.executionPrefixHash,
      parentChannelsHash: checkpoint.source.channelsHash,
      parentMessagesHash: checkpoint.source.messagesHash,
      parentNativeStepCount: checkpoint.source.nativeStepCount,
      parentMessageCount: checkpoint.source.messageCount
    });

    const fork = await runHarnessMatch(forkOptions);
    expect(fork.initialState).toEqual(checkpoint.state);
    expect(fork.forkOf).toEqual(forkOptions.forkOf);
    expect(fork.socialEpisode.messages.slice(0, checkpoint.source.messageCount)).toEqual(checkpoint.executionPrefix.messages);
    const firstCommitted = fork.socialEpisode.steps.find((step) => step.commitStatus === "committed");
    expect(firstCommitted?.preStateHash).toBe(checkpoint.source.stateHash);
    const forkArtifact = buildMatchArtifact({
      runId: "fork-run",
      matchId: "fork-match",
      seed: fork.initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(fork.initialState.players, forkOptions.agents),
      result: fork
    });
    expect(forkArtifact.forkOf).toEqual(forkOptions.forkOf);
  });

  it("builds a native prefix checkpoint including explicit system steps", async () => {
    const initialState = createGame({ id: "replay-prefix-fork", seed: "replay-prefix-fork" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);
    const parent = await runHarnessMatch({ initialState, agents, reasoner, maxTransitions: 4 });
    const artifact = buildMatchArtifact({
      runId: "prefix-parent-run",
      matchId: "prefix-parent-match",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result: parent
    });
    const boundaryIndex = firstSafeNativeBoundaryIndex(artifact);
    const boundary = artifact.socialEpisode.steps[boundaryIndex];
    const checkpoint = buildHarnessCheckpointAtPrefix({
      artifact,
      selector: { nativeStepCount: boundaryIndex + 1 },
      checkpointId: "checkpoint-at-native-prefix"
    });
    const sameByTrace = buildHarnessCheckpointAtPrefix({
      artifact,
      selector: { traceId: boundary.traceId },
      checkpointId: "checkpoint-at-native-prefix-trace"
    });
    const sameByTurn = buildHarnessCheckpointAtPrefix({
      artifact,
      selector: { nativeTurnIndex: boundary.turnIndex },
      checkpointId: "checkpoint-at-native-prefix-turn"
    });

    expect(validateHarnessCheckpoint(checkpoint)).toEqual([]);
    expect(checkpoint.executionPrefix.steps).toEqual(artifact.socialEpisode.steps.slice(0, boundaryIndex + 1));
    expect(checkpoint.executionPrefix.steps[0].actorId).toBe("system");
    expect(checkpoint.source).toMatchObject({
      boundaryTraceId: boundary.traceId,
      boundaryTurnIndex: boundary.turnIndex,
      nativeStepCount: boundaryIndex + 1,
      stateHash: hashStableState(checkpoint.state),
      executionPrefixHash: hashStableState(checkpoint.executionPrefix),
      messagesHash: hashStableState(checkpoint.executionPrefix.messages)
    });
    expect(sameByTrace.source.stateHash).toBe(checkpoint.source.stateHash);
    expect(sameByTurn.source.agentsHash).toBe(checkpoint.source.agentsHash);
    expect(checkpoint.state).not.toEqual(artifact.finalState);
    expect(checkpoint.agents).not.toEqual(artifact.agents);

    const playback = replayWerewolfSocialEpisode(checkpoint.executionPrefix, { stopOnMismatch: false });
    expect(playback.ok).toBe(true);
    expect(playback.finalHash).toBe(checkpoint.source.stateHash);
    expect(playback.messagesHash).toBe(checkpoint.source.messagesHash);

    const fork = await runHarnessMatch(forkHarnessRunOptions({ checkpoint, reasoner, maxTransitions: 1 }));
    expect(fork.socialEpisode.messages.slice(0, checkpoint.source.messageCount)).toEqual(checkpoint.executionPrefix.messages);
    const firstCommitted = fork.socialEpisode.steps.find((step) => step.commitStatus === "committed");
    expect(firstCommitted?.preStateHash).toBe(checkpoint.source.stateHash);
  });

  it("derives a complete native replay-review prefix without restoring actors or calling a reasoner", async () => {
    const initialState = createGame({ id: "replay-review-prefix", seed: "replay-review-prefix" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);
    let reasonerCalls = 0;
    const countingReasoner: HarnessReasoner = {
      async think(input) {
        reasonerCalls += 1;
        return reasoner.think(input);
      }
    };
    const parent = await runHarnessMatch({ initialState, agents, reasoner: countingReasoner, maxTransitions: 4 });
    const artifact = buildMatchArtifact({
      runId: "replay-review-prefix-run",
      matchId: "replay-review-prefix-match",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result: parent
    });
    const boundaryIndex = artifact.socialEpisode.steps.findIndex((step, index) => {
      const next = artifact.socialEpisode.steps[index + 1];
      return !step.batchId || next?.batchId !== step.batchId || (step.schedulerMode === "aec" && !step.atomic);
    });
    expect(boundaryIndex).toBeGreaterThanOrEqual(0);
    const beforeReplay = reasonerCalls;
    const prefix = buildReplayableSocialPrefix({
      episode: artifact.socialEpisode,
      selector: { nativeStepCount: boundaryIndex + 1 },
      replayPrefix: (episode) =>
        replayWerewolfSocialEpisode(episode, {
          stopOnMismatch: false,
          validateExpectedFinalState: false,
          auditAgentSnapshots: false
        })
    });

    expect(reasonerCalls).toBe(beforeReplay);
    expect(prefix.nativeStepCount).toBe(boundaryIndex + 1);
    expect(prefix.episode.steps).toEqual(artifact.socialEpisode.steps.slice(0, boundaryIndex + 1));
    expect(prefix.episode.messages.every((message) => message.seq <= prefix.maxMessageSeq)).toBe(true);
    expect(prefix.replay.ok).toBe(true);
    expect(prefix.replay.finalHash).toBe(prefix.step.postStateHash);
    expect(prefix.replay.messagesHash).toBe(hashStableState(prefix.episode.messages));
  });

  it("detects tampered native checkpoint provenance before fork execution", async () => {
    const initialState = createGame({ id: "replay-checkpoint-tamper", seed: "replay-checkpoint-tamper" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);
    const result = await runHarnessMatch({ initialState, agents, reasoner, maxTransitions: 4 });
    const artifact = buildMatchArtifact({
      runId: "tamper-parent-run",
      matchId: "tamper-parent-match",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    const checkpoint = buildFinalHarnessCheckpoint({ artifact, checkpointId: "tamper-checkpoint" });
    expect(validateHarnessCheckpoint(checkpoint)).toEqual([]);

    const stateTamper = cloneJson(checkpoint);
    stateTamper.state.day += 1;
    expect(validateHarnessCheckpoint(stateTamper).join(" ")).toMatch(/source\.stateHash mismatch/);

    const prefixTamper = cloneJson(checkpoint);
    prefixTamper.executionPrefix.steps[0].postStateHash = "tampered-native-hash";
    expect(validateHarnessCheckpoint(prefixTamper).join(" ")).toMatch(/executionPrefixHash mismatch|replay/);

    const countTamper = cloneJson(checkpoint);
    countTamper.source.nativeStepCount += 1;
    countTamper.source.boundaryTraceId = "wrong-trace";
    expect(validateHarnessCheckpoint(countTamper).join(" ")).toMatch(/nativeStepCount mismatch/);
    expect(validateHarnessCheckpoint(countTamper).join(" ")).toMatch(/boundaryTraceId mismatch/);

    const messageTamper = cloneJson(checkpoint);
    messageTamper.executionPrefix.messages[0].content = "tampered message";
    expect(validateHarnessCheckpoint(messageTamper).join(" ")).toMatch(/messagesHash mismatch|executionPrefixHash mismatch/);

    const channelTamper = cloneJson(checkpoint);
    channelTamper.executionPrefix.channels[0].id = "tampered-channel";
    expect(validateHarnessCheckpoint(channelTamper).join(" ")).toMatch(/channelsHash mismatch|executionPrefixHash mismatch/);

    const agentTamper = cloneJson(checkpoint);
    agentTamper.agents[0].privateMemos.push("tampered memo");
    expect(validateHarnessCheckpoint(agentTamper).join(" ")).toMatch(/agentsHash mismatch/);
    expect(() => forkHarnessRunOptions({ checkpoint: agentTamper, reasoner })).toThrow(/Invalid harness checkpoint/);
  });
});

async function buildReplayableRun(id: string): Promise<HarnessRunResult> {
  const initialState = createGame({ id, seed: id });
  return runHarnessMatch({
    initialState,
    agents: initialState.players.map((player) => ({
      playerId: player.id,
      model: "stub-model",
      temperature: 0
    })),
    reasoner,
    maxTransitions: 8
  });
}

function cloneSteps(steps: HarnessStepRecord[]): HarnessStepRecord[] {
  return JSON.parse(JSON.stringify(steps)) as HarnessStepRecord[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function firstSafeNativeBoundaryIndex(artifact: MatchArtifact): number {
  for (const [index, step] of artifact.socialEpisode.steps.entries()) {
    const nextStep = artifact.socialEpisode.steps[index + 1];
    if (!step.actorSnapshotFrameIdAfterStep || !step.actorSnapshotsHashAfterStep) continue;
    if (step.batchId && nextStep?.batchId === step.batchId && (step.schedulerMode !== "aec" || step.atomic)) continue;
    return index;
  }
  throw new Error("Expected a safe prefix checkpoint boundary in replay fixture.");
}

interface CounterState {
  value: number;
}

interface CounterCommand {
  delta: number;
}

const COUNTER_CHANNEL: SocialChannel = {
  id: "counter-public",
  kind: "public",
  participantIds: ["counter-agent"],
  readableBy: "all"
};

function counterEnvironment(onStep?: () => void): SocialEnvironment<CounterState, null, null, CounterCommand> {
  let state: CounterState = { value: 0 };
  return {
    snapshot: () => cloneJson(state),
    pendingActions: () => [],
    observe: () => null,
    step(command) {
      onStep?.();
      state = { value: state.value + command.delta };
      return cloneJson(state);
    },
    done: () => false
  };
}

function counterParallelEnvironment(options: {
  onStep?: () => void;
  onStepBatch?: () => void;
} = {}): SocialParallelEnvironment<CounterState, null, null, CounterCommand> {
  let state: CounterState = { value: 0 };
  return {
    snapshot: () => cloneJson(state),
    pendingActions: () => [],
    observe: () => null,
    step(command) {
      options.onStep?.();
      state = { value: state.value + command.delta };
      return cloneJson(state);
    },
    stepBatch(commandsByAgent) {
      options.onStepBatch?.();
      state = {
        value: state.value + Object.values(commandsByAgent).reduce((sum, command) => sum + command.delta, 0)
      };
      return cloneJson(state);
    },
    done: () => false
  };
}

function counterMessageDraft(content: string): Omit<SocialMessage, "id" | "seq" | "createdAt"> {
  return {
    channelId: COUNTER_CHANNEL.id,
    senderId: "counter-agent",
    recipientIds: ["counter-agent"],
    visibility: "public",
    content
  };
}

function counterEpisode(options: {
  commitStatus: "committed" | "rejected";
  command: CounterCommand;
  messages?: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">>;
  finalValue: number;
  recordedMessages?: SocialMessage[];
  messageSeqRange?: [number, number];
}): SocialEpisodeArtifact<CounterState, null, null, CounterCommand> {
  const initialState: CounterState = { value: 0 };
  const finalState: CounterState = { value: options.finalValue };
  return {
    id: "counter-replay",
    status: options.commitStatus === "committed" ? "completed" : "failed",
    execution: {
      schemaVersion: "harness.social-execution.v1",
      started: true,
      initialMessageCount: 0,
      initialMessagesHash: hashStableState([])
    },
    schedulerMode: "aec",
    profiles: [],
    channels: [COUNTER_CHANNEL],
    initialState,
    finalState,
    steps: [
      {
        traceId: "counter-trace-1",
        turnIndex: 1,
        batchId: "counter-batch-1",
        batchIndex: 1,
        batchSize: 1,
        actorId: "counter-agent",
        profileId: "counter-profile",
        schedulerMode: "aec",
        atomic: false,
        resolutionPolicy: "sequential-apply",
        pendingAction: null,
        observation: null,
        action: {
          actorId: "counter-agent",
          kind: "counter.increment",
          command: options.command,
          messages: options.messages
        },
        commitStatus: options.commitStatus,
        preStateHash: hashStableState(initialState),
        postStateHash: hashStableState(finalState),
        messageSeqRange: options.messageSeqRange,
        error: options.commitStatus === "rejected" ? "planned rejection" : undefined,
        failure:
          options.commitStatus === "rejected"
            ? { stage: "environment_step", message: "planned rejection" }
            : undefined
      }
    ],
    messages: options.recordedMessages ?? []
  };
}

function parallelCounterEpisode(): SocialEpisodeArtifact<CounterState, null, null, CounterCommand> {
  const episode = counterEpisode({
    commitStatus: "committed",
    command: { delta: 1 },
    finalValue: 2
  });
  episode.schedulerMode = "parallel";
  const first = episode.steps[0];
  first.traceId = "counter-parallel-1";
  first.batchId = "counter-parallel";
  first.batchIndex = 1;
  first.batchSize = 2;
  first.schedulerMode = "parallel";
  first.atomic = true;
  first.resolutionPolicy = "parallel-stepBatch";
  first.postStateHash = hashStableState({ value: 2 });

  const second = cloneJson(first);
  second.traceId = "counter-parallel-2";
  second.turnIndex = 2;
  second.actorId = "counter-agent-2";
  second.profileId = "counter-profile-2";
  second.action = {
    ...second.action,
    actorId: second.actorId,
    command: { delta: 1 }
  };
  episode.steps.push(second);
  return episode;
}
