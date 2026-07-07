import { describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import {
  buildFinalHarnessCheckpoint,
  buildHarnessCheckpointAtPrefix,
  buildMatchArtifact,
  forkHarnessRunOptions,
  resolveAgentSnapshotsAfterStep,
  validateHarnessCheckpoint,
  type MatchArtifact
} from "../src/harness/artifacts";
import { hashStableState } from "../src/harness/hash";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { replayHarnessTrajectory } from "../src/harness/replay";
import { runHarnessMatch } from "../src/harness/runtime";
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
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner,
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

    const replay = replayHarnessTrajectory({
      initialState: parsedArtifact.initialState,
      trajectory: parsedArtifact.trajectory,
      expectedFinalHash: hashStableState(parsedArtifact.finalState)
    });

    expect(replay.ok).toBe(true);
    expect(replay.mismatches).toEqual([]);
    expect(replay.replayedCommands).toBe(result.trajectory.length);
    expect(replay.finalHash).toBe(hashStableState(result.state));
    expect(replay.expectedFinalHash).toBe(hashStableState(parsedArtifact.finalState));
    expect(replay.finalHash).toBe(hashStableState(parsedArtifact.finalState));
    expect(replay.finalState.phase).toBe(result.state.phase);
    expect(replay.finalState.events.filter((event) => event.type === "harness.turn")).toHaveLength(result.trajectory.length);
    expect(parsedArtifact.socialEpisode.steps).toHaveLength(parsedArtifact.trajectory.length);
    expect(parsedArtifact.socialEpisode.steps.map((step) => step.traceId)).toEqual(parsedArtifact.trajectory.map((step) => step.traceId));
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

  it("creates a checkpoint and forks from restored state with provenance", async () => {
    const initialState = createGame({ id: "replay-fork", seed: "replay-fork" });
    const seer = initialState.players.find((player) => player.role === "seer");
    if (!seer) throw new Error("Expected a seer in the default Werewolf config.");
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);
    const parent = await runHarnessMatch({
      initialState,
      agents,
      reasoner,
      maxTransitions: 1
    });
    const parentArtifact = buildMatchArtifact({
      runId: "parent-run",
      matchId: "parent-match",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result: parent
    });
    const parentArtifactSeer = parentArtifact.agents.find((agent) => agent.playerId === seer.id);
    if (!parentArtifactSeer) throw new Error("Expected seer agent in parent artifact.");
    parentArtifactSeer.turns = 4;
    parentArtifactSeer.privateMemos.push("checkpoint marker memo");
    const checkpoint = buildFinalHarnessCheckpoint({
      artifact: parentArtifact,
      checkpointId: "checkpoint-after-prefix",
      createdAt: "2026-07-04T00:00:00.000Z",
      reason: "fork test checkpoint"
    });

    expect(checkpoint).toMatchObject({
      artifactVersion: "harness.checkpoint.v1",
      kind: "checkpoint",
      checkpointId: "checkpoint-after-prefix",
      reason: "fork test checkpoint",
      source: {
        runId: "parent-run",
        matchId: "parent-match",
        seed: initialState.seed,
        status: parent.status,
        trajectoryLength: parent.trajectory.length,
        stateHash: hashStableState(parent.state),
        trajectoryHash: hashStableState(parent.trajectory),
        agentsHash: hashStableState(parentArtifact.agents),
        socialMessagesHash: hashStableState(parent.socialEpisode.messages)
      }
    });
    expect(checkpoint.state).toEqual(parent.state);
    expect(checkpoint.agents).toEqual(parentArtifact.agents);
    expect(checkpoint.socialMessages).toEqual(parent.socialEpisode.messages);

    const forkReasonerCalls: Array<{ traceId: string; actorId: string; priorTurns: number; visibleParentMessageIds: string[] }> = [];
    const forkReasoner: HarnessReasoner = {
      async think(input) {
        forkReasonerCalls.push({
          traceId: input.traceId,
          actorId: input.action.actorId,
          priorTurns: input.agent.turns,
          visibleParentMessageIds: input.view.social.messages
            .filter((message) => checkpoint.socialMessages.some((parentMessage) => parentMessage.id === message.id))
            .map((message) => message.id)
        });
        const content =
          input.action.kind === "speech"
            ? "我从 checkpoint fork 后继续按公开信息发言，重点复核已经提交的行动、社交消息和当前票型。"
            : `fork-test:${input.agent.model}:${input.action.kind}:${input.policyPlan.policyName}:prior=${input.agent.turns}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `fork-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const forkOptions = forkHarnessRunOptions({
      checkpoint,
      reasoner: forkReasoner,
      maxTransitions: 1,
      createdAt: "2026-07-04T00:01:00.000Z",
      reason: "continue one action from checkpoint"
    });

    expect(forkOptions.initialState).toEqual(checkpoint.state);
    expect(forkOptions.initialAgentStates).toEqual(checkpoint.agents);
    expect(forkOptions.initialSocialMessages).toEqual(checkpoint.socialMessages);
    expect(forkOptions.forkOf).toEqual({
      checkpointId: "checkpoint-after-prefix",
      parentRunId: "parent-run",
      parentMatchId: "parent-match",
      parentTraceId: parent.trajectory.at(-1)?.traceId,
      parentEvidenceTraceIds: [],
      parentTurnIndex: parent.trajectory.at(-1)?.turnIndex,
      parentStateHash: hashStableState(parent.state),
      parentTrajectoryHash: hashStableState(checkpoint.trajectory),
      parentAgentsHash: hashStableState(checkpoint.agents),
      parentSocialMessagesHash: hashStableState(checkpoint.socialMessages),
      parentTrajectoryLength: parent.trajectory.length,
      createdAt: "2026-07-04T00:01:00.000Z",
      reason: "continue one action from checkpoint"
    });

    const checkpointBeforeFork = cloneJson(checkpoint);
    const fork = await runHarnessMatch(forkOptions);

    expect(checkpoint).toEqual(checkpointBeforeFork);
    expect(fork.initialState).toEqual(checkpoint.state);
    expect(fork.forkOf).toEqual(forkOptions.forkOf);
    expect(fork.trajectory).toHaveLength(1);
    expect(fork.trajectory[0].preStateHash).toBe(checkpoint.source.stateHash);
    expect(forkReasonerCalls).toHaveLength(1);
    const actedAgent = fork.agents.find((agent) => agent.playerId === fork.trajectory[0].actorId);
    const checkpointAgent = checkpoint.agents.find((agent) => agent.playerId === fork.trajectory[0].actorId);
    expect(actedAgent?.turns).toBe((checkpointAgent?.turns ?? 0) + 1);
    expect(actedAgent?.privateMemos).toContain("checkpoint marker memo");
    expect(forkReasonerCalls[0].priorTurns).toBe(checkpointAgent?.turns ?? 0);
    expect(forkReasonerCalls[0].visibleParentMessageIds).toEqual(expectedVisibleParentMessageIds(checkpoint.socialMessages, forkReasonerCalls[0].actorId));
    expect(fork.socialEpisode.messages.slice(0, checkpoint.socialMessages.length)).toEqual(checkpoint.socialMessages);
    expect(fork.socialEpisode.messages.length).toBeGreaterThan(checkpoint.socialMessages.length);
    expect(fork.trajectory[0].messageSeqRange?.[0]).toBe((checkpoint.source.messageSeq ?? 0) + 1);
    expect(fork.socialEpisode.messages.at(-1)?.seq).toBe(fork.trajectory[0].messageSeqRange?.[1]);

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

  it("builds a safe prefix checkpoint from recorded agent snapshots and forks without future agent state", async () => {
    const initialState = createGame({ id: "replay-prefix-fork", seed: "replay-prefix-fork" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);
    const parent = await runHarnessMatch({
      initialState,
      agents,
      reasoner,
      maxTransitions: 4
    });
    const parentArtifact = buildMatchArtifact({
      runId: "prefix-parent-run",
      matchId: "prefix-parent-match",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result: parent
    });
    const trajectoryLength = firstSafePrefixLength(parentArtifact);
    const prefixTrajectory = parentArtifact.trajectory.slice(0, trajectoryLength);
    const selectedStep = prefixTrajectory.at(-1);
    const selectedSnapshots = selectedStep ? resolveAgentSnapshotsAfterStep(parentArtifact, selectedStep) : undefined;
    if (!selectedStep || !selectedSnapshots) throw new Error("Expected selected prefix step to have agent snapshots.");

    const checkpoint = buildHarnessCheckpointAtPrefix({
      artifact: parentArtifact,
      selector: { trajectoryLength },
      checkpointId: "checkpoint-at-prefix",
      createdAt: "2026-07-04T00:00:00.000Z",
      reason: "prefix checkpoint"
    });
    const sameByTrace = buildHarnessCheckpointAtPrefix({
      artifact: parentArtifact,
      selector: { traceId: selectedStep.traceId },
      checkpointId: "checkpoint-at-prefix-trace",
      createdAt: "2026-07-04T00:00:00.000Z",
      reason: "prefix checkpoint"
    });
    const sameByTurn = buildHarnessCheckpointAtPrefix({
      artifact: parentArtifact,
      selector: { turnIndex: selectedStep.turnIndex },
      checkpointId: "checkpoint-at-prefix-turn",
      createdAt: "2026-07-04T00:00:00.000Z",
      reason: "prefix checkpoint"
    });

    const replay = replayHarnessTrajectory({
      initialState: parentArtifact.initialState,
      trajectory: prefixTrajectory,
      expectedFinalHash: selectedStep.postStateHash
    });
    expect(replay.ok).toBe(true);
    expect(validateHarnessCheckpoint(checkpoint)).toEqual([]);
    expect(checkpoint.source).toMatchObject({
      traceId: selectedStep.traceId,
      turnIndex: selectedStep.turnIndex,
      trajectoryLength,
      stateHash: replay.finalHash,
      agentsHash: hashStableState(selectedSnapshots),
      socialMessagesHash: hashStableState(checkpoint.socialMessages)
    });
    expect(sameByTrace.source.stateHash).toBe(checkpoint.source.stateHash);
    expect(sameByTurn.source.agentsHash).toBe(checkpoint.source.agentsHash);
    expect(hashStableState(checkpoint.state)).toBe(replay.finalHash);
    expect(checkpoint.state.phase).toBe(replay.finalState.phase);
    expect(checkpoint.state.day).toBe(replay.finalState.day);
    expect(checkpoint.state).not.toEqual(parentArtifact.finalState);
    expect(checkpoint.agents).toEqual(selectedSnapshots);
    expect(checkpoint.agents).not.toEqual(parentArtifact.agents);
    expect(totalAgentTurns(checkpoint.agents)).toBeLessThan(totalAgentTurns(parentArtifact.agents));
    expect(checkpoint.socialMessages).toEqual(parentArtifact.socialEpisode.messages.slice(0, checkpoint.source.messageSeq ?? 0));

    const forkReasonerCalls: Array<{ actorId: string; priorTurns: number; visibleParentMessageIds: string[] }> = [];
    const forkReasoner: HarnessReasoner = {
      async think(input) {
        forkReasonerCalls.push({
          actorId: input.action.actorId,
          priorTurns: input.agent.turns,
          visibleParentMessageIds: input.view.social.messages
            .filter((message) => checkpoint.socialMessages.some((parentMessage) => parentMessage.id === message.id))
            .map((message) => message.id)
        });
        const content =
          input.action.kind === "speech"
            ? "我从 prefix checkpoint 继续按可见信息发言，只使用 checkpoint 已提交的消息和当前状态。"
            : `prefix-fork:${input.agent.model}:${input.action.kind}:${input.policyPlan.policyName}:prior=${input.agent.turns}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `prefix-fork-${input.traceId}`,
            attempts: 1
          }
        };
      }
    };
    const forkOptions = forkHarnessRunOptions({
      checkpoint,
      reasoner: forkReasoner,
      maxTransitions: 1,
      createdAt: "2026-07-04T00:01:00.000Z",
      reason: "continue from prefix"
    });
    const fork = await runHarnessMatch(forkOptions);

    expect(fork.initialState).toEqual(checkpoint.state);
    expect(fork.forkOf?.parentTrajectoryLength).toBe(trajectoryLength);
    expect(fork.trajectory[0].preStateHash).toBe(checkpoint.source.stateHash);
    expect(forkReasonerCalls.length).toBeGreaterThan(0);
    const firstForkCall = forkReasonerCalls.find((call) => call.actorId === fork.trajectory[0].actorId) ?? forkReasonerCalls[0];
    const restoredAgent = checkpoint.agents.find((agent) => agent.playerId === firstForkCall.actorId);
    expect(firstForkCall.priorTurns).toBe(restoredAgent?.turns ?? 0);
    expect(firstForkCall.visibleParentMessageIds).toEqual(
      expectedVisibleParentMessageIds(checkpoint.socialMessages, firstForkCall.actorId)
    );
    expect(fork.socialEpisode.messages.slice(0, checkpoint.socialMessages.length)).toEqual(checkpoint.socialMessages);
    expect(fork.trajectory[0].messageSeqRange?.[0]).toBe((checkpoint.source.messageSeq ?? 0) + 1);
  });

  it("detects tampered checkpoint provenance before fork execution", async () => {
    const initialState = createGame({ id: "replay-checkpoint-tamper", seed: "replay-checkpoint-tamper" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.4);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.4);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner,
      maxTransitions: 4
    });
    const artifact = buildMatchArtifact({
      runId: "tamper-parent-run",
      matchId: "tamper-parent-match",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    const checkpoint = buildFinalHarnessCheckpoint({
      artifact,
      checkpointId: "tamper-checkpoint"
    });

    expect(validateHarnessCheckpoint(checkpoint)).toEqual([]);

    const stateTamper = cloneJson(checkpoint);
    stateTamper.state.day += 1;
    expect(validateHarnessCheckpoint(stateTamper).join(" ")).toMatch(/source\.stateHash mismatch/);
    expect(() =>
      forkHarnessRunOptions({
        checkpoint: stateTamper,
        reasoner
      })
    ).toThrow(/Invalid harness checkpoint/);

    const trajectoryTamper = cloneJson(checkpoint);
    trajectoryTamper.source.trajectoryLength += 1;
    trajectoryTamper.source.traceId = "wrong-trace";
    trajectoryTamper.source.turnIndex = -1;
    expect(validateHarnessCheckpoint(trajectoryTamper).join(" ")).toMatch(/trajectoryLength mismatch/);
    expect(validateHarnessCheckpoint(trajectoryTamper).join(" ")).toMatch(/traceId mismatch/);
    expect(validateHarnessCheckpoint(trajectoryTamper).join(" ")).toMatch(/turnIndex mismatch/);

    const trajectoryBodyTamper = cloneJson(checkpoint);
    if (trajectoryBodyTamper.trajectory.length) {
      (trajectoryBodyTamper.trajectory[0] as unknown as { command: Record<string, unknown> }).command = {
        ...trajectoryBodyTamper.trajectory[0].command,
        actorId: "tampered-agent"
      };
      expect(validateHarnessCheckpoint(trajectoryBodyTamper).join(" ")).toMatch(/source\.trajectoryHash mismatch/);
      expect(() =>
        forkHarnessRunOptions({
          checkpoint: trajectoryBodyTamper,
          reasoner
        })
      ).toThrow(/Invalid harness checkpoint/);
    }

    const messageTamper = cloneJson(checkpoint);
    messageTamper.source.messageSeq = (messageTamper.source.messageSeq ?? 0) + 100;
    expect(validateHarnessCheckpoint(messageTamper).join(" ")).toMatch(/messageSeq/);

    const messageBodyTamper = cloneJson(checkpoint);
    if (messageBodyTamper.socialMessages.length) {
      messageBodyTamper.socialMessages[0].content = "tampered social message";
      expect(validateHarnessCheckpoint(messageBodyTamper).join(" ")).toMatch(/source\.socialMessagesHash mismatch/);
    }

    const messagePrefixTamper = cloneJson(checkpoint);
    if (messagePrefixTamper.socialMessages.length > 1) {
      messagePrefixTamper.socialMessages[0].seq = 99;
      expect(validateHarnessCheckpoint(messagePrefixTamper).join(" ")).toMatch(/socialMessages sequence mismatch/);
    }

    const agentTamper = cloneJson(checkpoint);
    agentTamper.agents.push(cloneJson(agentTamper.agents[0]));
    agentTamper.agents.pop();
    agentTamper.agents[0].playerId = "unknown-player";
    expect(validateHarnessCheckpoint(agentTamper).join(" ")).toMatch(/unknown player/);
    expect(validateHarnessCheckpoint(agentTamper).join(" ")).toMatch(/Missing restored agent state/);

    const agentPrivateStateTamper = cloneJson(checkpoint);
    agentPrivateStateTamper.agents[0].privateMemos.push("tampered private memo");
    expect(validateHarnessCheckpoint(agentPrivateStateTamper).join(" ")).toMatch(/source\.agentsHash mismatch/);

    const duplicateAgentTamper = cloneJson(checkpoint);
    duplicateAgentTamper.agents.push(cloneJson(duplicateAgentTamper.agents[0]));
    expect(validateHarnessCheckpoint(duplicateAgentTamper).join(" ")).toMatch(/Duplicate restored agent state/);
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

function firstSafePrefixLength(artifact: MatchArtifact): number {
  for (const [index, step] of artifact.trajectory.entries()) {
    const socialStep = artifact.socialEpisode.steps.find((candidate) => candidate.traceId === step.traceId);
    const nextStep = artifact.trajectory[index + 1];
    const nextSocialStep = nextStep ? artifact.socialEpisode.steps.find((candidate) => candidate.traceId === nextStep.traceId) : undefined;
    if (!resolveAgentSnapshotsAfterStep(artifact, step) || !step.agentSnapshotsHashAfterStep) continue;
    if (socialStep?.schedulerMode === "parallel" || socialStep?.atomic) continue;
    if (
      socialStep?.schedulerMode === "aec-batched-decision" &&
      socialStep.batchId &&
      nextSocialStep?.batchId === socialStep.batchId
    ) {
      continue;
    }
    return index + 1;
  }
  throw new Error("Expected a safe prefix checkpoint boundary in replay fixture.");
}

function totalAgentTurns(agents: Array<{ turns: number }>): number {
  return agents.reduce((sum, agent) => sum + agent.turns, 0);
}

function expectedVisibleParentMessageIds(messages: Array<{ id: string; senderId: string; recipientIds: string[]; visibility: string }>, actorId: string): string[] {
  return messages
    .filter((message) => {
      if (message.visibility === "postgame") return false;
      if (message.visibility === "public") return true;
      return message.senderId === actorId || message.recipientIds.includes(actorId);
    })
    .map((message) => message.id);
}
