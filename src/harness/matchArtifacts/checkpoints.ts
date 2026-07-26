import { assertSafeCheckpointBoundary, cloneJson, inheritedEvidenceTraceIdsFromCheckpoint, latestMessageSeqForNativePrefix, resolveAgentSnapshotsAfterNativeStep, resolveCheckpointPrefixSelection, validateAgentEvidenceNotBeyondBoundary, validateCheckpointAgentEvidence, validateHarnessCheckpointRulesetBinding } from "./validationSupport";
import { GameState } from "../../core/types";
import { validateWerewolfAgentHarnessStateSnapshot } from "../actor";
import { createGenericForkProvenance, validateHarnessCheckpointEnvelope, validateHarnessCheckpointReplay } from "../episodeArtifacts";
import { hashStableState } from "../hash";
import { replayWerewolfSocialEpisode } from "../replay";
import { AgentHarnessState, HarnessForkProvenance, HarnessReasoner, HarnessRunOptions } from "../types";
import { assertValidMatchArtifactIntegrity } from "./integrity";
import { HARNESS_CHECKPOINT_VERSION, HarnessCheckpoint, HarnessCheckpointPrefixSelector, HarnessCheckpointSelectionError, MATCH_ARTIFACT_VERSION, MatchArtifact } from "./types";
export function buildFinalHarnessCheckpoint(options: {
  artifact: MatchArtifact;
  checkpointId?: string;
  createdAt?: string;
  reason?: string;
}): HarnessCheckpoint {
  assertValidMatchArtifactIntegrity(options.artifact);
  const executionPrefix = cloneJson(options.artifact.socialEpisode) as HarnessCheckpoint["executionPrefix"];
  delete executionPrefix.exposureRecords;
  delete executionPrefix.exposureSummary;
  const finalAgentsHash = hashStableState(options.artifact.agents);
  const finalAgentSnapshotFrameId = options.artifact.agentSnapshotFrames?.find((frame) => frame.agentsHash === finalAgentsHash)?.frameId;
  const checkpoint = buildNativeCheckpointRecord({
    artifact: options.artifact,
    checkpointId: options.checkpointId ?? `${options.artifact.runId}:checkpoint:native:${executionPrefix.steps.length}`,
    createdAt: options.createdAt,
    reason: options.reason,
    executionPrefix,
    state: cloneJson(options.artifact.finalState),
    agents: cloneJson(options.artifact.agents),
    agentSnapshotFrameId: finalAgentSnapshotFrameId
  });
  assertValidHarnessCheckpoint(checkpoint);
  return checkpoint;
}

export function buildHarnessCheckpointAtPrefix(options: {
  artifact: MatchArtifact;
  selector: HarnessCheckpointPrefixSelector;
  checkpointId?: string;
  createdAt?: string;
  reason?: string;
}): HarnessCheckpoint {
  assertValidMatchArtifactIntegrity(options.artifact);
  const selected = resolveCheckpointPrefixSelection(options.artifact, options.selector);
  assertSafeCheckpointBoundary(options.artifact, selected.index);
  const agents = resolveAgentSnapshotsAfterNativeStep(options.artifact, selected.step);
  if (!agents || !selected.step.actorSnapshotsHashAfterStep) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: agent snapshots are not recorded for this boundary.`
    );
  }
  const agentsHash = hashStableState(agents);
  if (agentsHash !== selected.step.actorSnapshotsHashAfterStep) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: agent snapshot hash mismatch.`
    );
  }
  const steps = cloneJson(options.artifact.socialEpisode.steps.slice(0, selected.index + 1));
  const messageSeq = latestMessageSeqForNativePrefix(options.artifact.socialEpisode, steps);
  const messages = cloneJson(options.artifact.socialEpisode.messages.filter((message) => message.seq <= messageSeq));
  const snapshotEvidenceErrors: string[] = [];
  const maxEventSeq = steps.reduce((max, step) => (step.eventSeqRange ? Math.max(max, step.eventSeqRange[1]) : max), 0);
  const futureTraceIds = new Set(options.artifact.socialEpisode.steps.slice(selected.index + 1).map((step) => step.traceId));
  for (const [agentIndex, agent] of agents.entries()) {
    validateAgentEvidenceNotBeyondBoundary({
      agent,
      maxMessageSeq: messageSeq,
      maxEventSeq,
      futureTraceIds,
      label: `nativeSnapshot[${agentIndex}]`,
      errors: snapshotEvidenceErrors
    });
  }
  if (snapshotEvidenceErrors.length) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: ${snapshotEvidenceErrors.join(" ")}`
    );
  }
  const executionPrefix = cloneJson({
    ...options.artifact.socialEpisode,
    status: "truncated",
    truncationReason: `checkpoint boundary after native step ${selected.index + 1}`,
    terminationReason: undefined,
    failureReason: undefined,
    error: undefined,
    finalState: options.artifact.initialState,
    steps,
    messages,
    exposureRecords: undefined,
    exposureSummary: undefined,
    metrics: undefined
  }) as HarnessCheckpoint["executionPrefix"];
  const firstReplay = replayWerewolfSocialEpisode(executionPrefix, {
    stopOnMismatch: false,
    agentSnapshotFrames: options.artifact.agentSnapshotFrames
  });
  const nonFinalHashMismatches = firstReplay.mismatches.filter((mismatch) => !mismatch.startsWith("Replay final state hash mismatch"));
  if (nonFinalHashMismatches.length) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: ${nonFinalHashMismatches.join(" ")}`
    );
  }
  executionPrefix.finalState = cloneJson(firstReplay.finalState);
  const checkpoint = buildNativeCheckpointRecord({
    artifact: options.artifact,
    checkpointId: options.checkpointId ?? `${options.artifact.runId}:checkpoint:native:${steps.length}`,
    createdAt: options.createdAt,
    reason: options.reason,
    executionPrefix,
    state: cloneJson(firstReplay.finalState),
    agents,
    agentSnapshotFrameId: selected.step.actorSnapshotFrameIdAfterStep
  });
  assertValidHarnessCheckpoint(checkpoint);
  return checkpoint;
}

export function forkHarnessRunOptions(options: {
  checkpoint: HarnessCheckpoint;
  reasoner: HarnessReasoner;
  agents?: HarnessRunOptions["agents"];
  maxTransitions?: number;
  createdAt?: string;
  reason?: string;
}): HarnessRunOptions {
  const forkOf = createHarnessForkProvenance(options.checkpoint, {
    createdAt: options.createdAt,
    reason: options.reason
  });
  return {
    initialState: cloneJson(options.checkpoint.state),
    initialAgentStates: cloneJson(options.checkpoint.agents),
    initialSocialChannels: cloneJson(options.checkpoint.executionPrefix.channels),
    initialSocialMessages: cloneJson(options.checkpoint.executionPrefix.messages),
    agents: cloneJson(options.agents ?? agentConfigsFromCheckpoint(options.checkpoint)),
    reasoner: options.reasoner,
    maxTransitions: options.maxTransitions,
    forkOf
  };
}

/**
 * Build the single canonical Werewolf fork provenance record before optional
 * reasoner construction. Server control-plane attempt records and the eventual
 * harness run therefore bind to exactly the same checkpoint evidence.
 */
export function createHarnessForkProvenance(
  checkpoint: HarnessCheckpoint,
  options: { createdAt?: string; reason?: string } = {}
): HarnessForkProvenance {
  assertValidHarnessCheckpoint(checkpoint);
  assertForkableWerewolfCheckpointBoundary(checkpoint);
  const genericFork = createGenericForkProvenance(checkpoint, {
    createdAt: options.createdAt,
    reason: options.reason,
    parentArtifactId: checkpoint.source.matchId ?? checkpoint.source.runId,
    parentEvidenceTraceIds: inheritedEvidenceTraceIdsFromCheckpoint(checkpoint)
  });
  return {
    ...genericFork,
    parentMatchId: checkpoint.source.matchId,
    parentRulesetId: checkpoint.source.rulesetId
  };
}

export function validateHarnessCheckpoint(checkpoint: HarnessCheckpoint): string[] {
  const errors = validateHarnessCheckpointEnvelope(checkpoint);
  if (checkpoint.artifactVersion !== HARNESS_CHECKPOINT_VERSION) {
    errors.push(`artifactVersion must be ${HARNESS_CHECKPOINT_VERSION}.`);
  }
  if (checkpoint.kind !== "checkpoint") {
    errors.push("kind must be checkpoint.");
  }
  if (checkpoint.source.sourceArtifactVersion !== MATCH_ARTIFACT_VERSION) {
    errors.push(`source.sourceArtifactVersion must be ${MATCH_ARTIFACT_VERSION}.`);
  }
  if (checkpoint.source.seed !== checkpoint.state.seed) {
    errors.push(`source.seed mismatch: expected ${checkpoint.state.seed}, received ${checkpoint.source.seed}.`);
  }
  validateHarnessCheckpointRulesetBinding(checkpoint, errors);

  const playerIds = new Set(checkpoint.state.players.map((player) => player.id));
  const seenAgentIds = new Set<string>();
  for (const agent of checkpoint.agents) {
    if (seenAgentIds.has(agent.playerId)) {
      errors.push(`Duplicate restored agent state for ${agent.playerId}.`);
    }
    seenAgentIds.add(agent.playerId);
    if (!playerIds.has(agent.playerId)) {
      errors.push(`Restored agent state references unknown player ${agent.playerId}.`);
    }
    for (const error of validateWerewolfAgentHarnessStateSnapshot(agent, {
      requireSocialState: true,
      requireSocialStateHash: true
    })) {
      errors.push(`Restored agent state ${agent.playerId}: ${error}`);
    }
  }
  for (const playerId of playerIds) {
    if (!seenAgentIds.has(playerId)) {
      errors.push(`Missing restored agent state for ${playerId}.`);
    }
  }
  errors.push(
    ...validateHarnessCheckpointReplay(checkpoint, (executionPrefix) =>
      replayWerewolfSocialEpisode(executionPrefix, { stopOnMismatch: false })
    )
  );
  validateCheckpointAgentEvidence(checkpoint, errors);

  return errors;
}

export function assertValidHarnessCheckpoint(checkpoint: HarnessCheckpoint): void {
  const errors = validateHarnessCheckpoint(checkpoint);
  if (errors.length) {
    throw new Error(`Invalid harness checkpoint ${checkpoint.checkpointId}: ${errors.join(" ")}`);
  }
}

function assertForkableWerewolfCheckpointBoundary(checkpoint: HarnessCheckpoint): void {
  const boundary = checkpoint.executionPrefix.steps.at(-1);
  if (!boundary?.actorSnapshotsHashAfterStep) {
    throw new Error(
      `Checkpoint ${checkpoint.checkpointId} is not forkable: final native boundary has no recorded durable actor snapshot.`
    );
  }
  if (boundary.actorSnapshotsHashAfterStep !== checkpoint.source.agentsHash) {
    throw new Error(
      `Checkpoint ${checkpoint.checkpointId} is not forkable: final boundary actor snapshot hash does not match source.agentsHash.`
    );
  }
  if (boundary.actorSnapshotFrameIdAfterStep !== checkpoint.source.agentSnapshotFrameId) {
    throw new Error(
      `Checkpoint ${checkpoint.checkpointId} is not forkable: final boundary actor snapshot frame id does not match source.agentSnapshotFrameId.`
    );
  }
}

function agentConfigsFromCheckpoint(checkpoint: HarnessCheckpoint): HarnessRunOptions["agents"] {
  return checkpoint.agents.map((agent) => ({
    playerId: agent.playerId,
    profileId: agent.profileId,
    model: agent.model,
    temperature: agent.temperature,
    policyName: agent.policyName
  }));
}

function buildNativeCheckpointRecord(options: {
  artifact: MatchArtifact;
  checkpointId: string;
  createdAt?: string;
  reason?: string;
  executionPrefix: HarnessCheckpoint["executionPrefix"];
  state: GameState;
  agents: AgentHarnessState[];
  agentSnapshotFrameId?: string;
}): HarnessCheckpoint {
  const boundary = options.executionPrefix.steps.at(-1);
  const lastMessage = options.executionPrefix.messages.at(-1);
  return {
    artifactVersion: HARNESS_CHECKPOINT_VERSION,
    kind: "checkpoint",
    checkpointId: options.checkpointId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    reason: options.reason,
    source: {
      sourceArtifactVersion: MATCH_ARTIFACT_VERSION,
      runId: options.artifact.runId,
      matchId: options.artifact.matchId,
      seed: options.artifact.seed,
      rulesetId: options.artifact.rulesetId,
      status: options.artifact.status,
      boundaryTraceId: boundary?.traceId,
      boundaryTurnIndex: boundary?.turnIndex,
      boundaryBatchId: boundary?.batchId,
      boundaryBatchIndex: boundary?.batchIndex,
      boundarySchedulerMode: boundary?.schedulerMode,
      nativeStepCount: options.executionPrefix.steps.length,
      messageCount: options.executionPrefix.messages.length,
      lastMessageSeq: lastMessage?.seq,
      stateHash: hashStableState(options.state),
      executionPrefixHash: hashStableState(options.executionPrefix),
      agentsHash: hashStableState(options.agents),
      channelsHash: hashStableState(options.executionPrefix.channels),
      messagesHash: hashStableState(options.executionPrefix.messages),
      domainAdapter: options.executionPrefix.domainAdapter ? cloneJson(options.executionPrefix.domainAdapter) : undefined,
      experiment: options.artifact.experiment ? cloneJson(options.artifact.experiment) : undefined,
      agentSnapshotFrameId: options.agentSnapshotFrameId,
      failureReason: options.artifact.failureReason,
      truncationReason: options.artifact.truncationReason
    },
    state: cloneJson(options.state),
    agents: cloneJson(options.agents),
    executionPrefix: cloneJson(options.executionPrefix)
  };
}
