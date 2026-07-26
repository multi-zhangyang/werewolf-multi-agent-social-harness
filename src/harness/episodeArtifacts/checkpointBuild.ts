import { cloneArtifact } from "./support";
import { cloneSocialDomainAdapterManifest } from "../domainAdapter";
import { createGenericExperimentForkLineage } from "../experimentSpec";
import { hashStableState } from "../hash";
import { SocialEpisodeArtifact, SocialHarnessStep, isSocialParallelJointStep, isSocialStepCommitted, validateSocialParallelBatchLayout } from "../social";
import { BuildHarnessCheckpointAtPrefixOptions, BuildHarnessCheckpointFromEpisodeOptions, BuildReplayableSocialPrefixOptions, CreateGenericForkProvenanceOptions, GenericForkProvenance, HARNESS_FORK_PROVENANCE_VERSION, HarnessAgentSnapshotResolver, HarnessCheckpointEnvelope, HarnessCheckpointPrefixReplayResult, HarnessCheckpointPrefixSelector, HarnessCheckpointSelectionError, HarnessCheckpointSource, ReplayableSocialPrefix, ResolvedHarnessAgentSnapshot } from "./envelopeModel";
export function buildHarnessCheckpointFromEpisode<TState, TObservation, TPending, TCommand, TAgentState>(
  options: BuildHarnessCheckpointFromEpisodeOptions<TState, TObservation, TPending, TCommand, TAgentState>
): HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand> {
  const executionPrefix = cloneArtifact(options.episode);
  const state = cloneArtifact(options.state ?? executionPrefix.finalState);
  const agents = cloneArtifact(options.agents);
  const boundary = executionPrefix.steps.at(-1);
  const lastMessage = executionPrefix.messages.at(-1);
  const runId = options.runId ?? executionPrefix.id;
  const checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand> = {
    artifactVersion: options.artifactVersion,
    kind: options.kind,
    checkpointId: options.checkpointId ?? `${runId}:checkpoint:native:${executionPrefix.steps.length}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    reason: options.reason,
    source: {
      sourceArtifactVersion: options.sourceArtifactVersion,
      runId,
      status: options.sourceStatus ?? executionPrefix.status,
      boundaryTraceId: boundary?.traceId,
      boundaryTurnIndex: boundary?.turnIndex,
      boundaryBatchId: boundary?.batchId,
      boundaryBatchIndex: boundary?.batchIndex,
      boundarySchedulerMode: boundary?.schedulerMode,
      nativeStepCount: executionPrefix.steps.length,
      messageCount: executionPrefix.messages.length,
      lastMessageSeq: lastMessage?.seq,
      stateHash: hashStableState(state),
      executionPrefixHash: hashStableState(executionPrefix),
      agentsHash: hashStableState(agents),
      channelsHash: hashStableState(executionPrefix.channels),
      messagesHash: hashStableState(executionPrefix.messages),
      domainAdapter: executionPrefix.domainAdapter ? cloneSocialDomainAdapterManifest(executionPrefix.domainAdapter) : undefined,
      experiment: options.experiment ? cloneArtifact(options.experiment) : undefined,
      agentSnapshotFrameId: options.agentSnapshotFrameId,
      failureReason: options.failureReason,
      truncationReason: options.truncationReason
    },
    state,
    agents,
    executionPrefix
  };
  return checkpoint;
}

/**
 * Select and replay a complete native prefix without checkpoint/fork actor
 * semantics. This is the generic seam for server-owned replay review frames:
 * a domain supplies deterministic replay, while the harness owns selector,
 * batch-boundary, message-prefix, and hash integrity rules.
 */
export function buildReplayableSocialPrefix<
  TState,
  TObservation,
  TPending,
  TCommand,
  TReplay extends HarnessCheckpointPrefixReplayResult<TState>
>(
  options: BuildReplayableSocialPrefixOptions<TState, TObservation, TPending, TCommand, TReplay>
): ReplayableSocialPrefix<TState, TObservation, TPending, TCommand, TReplay> {
  const selected = resolveHarnessCheckpointPrefixSelection(options.episode, options.selector);
  assertSafeHarnessCheckpointBoundary(options.episode.steps, selected.index);
  const steps = cloneArtifact(options.episode.steps.slice(0, selected.index + 1));
  const maxMessageSeq = latestMessageSeqForHarnessPrefix(options.episode, steps);
  const messages = cloneArtifact(options.episode.messages.filter((message) => message.seq <= maxMessageSeq));

  // The replay callback, not an action-text reconstruction or the parent
  // final state, is the sole source of the selected prefix state.
  const episode = cloneArtifact({
    ...options.episode,
    status: "truncated" as const,
    terminationReason: undefined,
    truncationReason: `replay review boundary after native step ${selected.index + 1}`,
    failureReason: undefined,
    error: undefined,
    finalState: options.episode.initialState,
    steps,
    messages,
    exposureRecords: undefined,
    exposureSummary: undefined,
    metrics: undefined
  });
  const replay = options.replayPrefix(episode);
  if (replay.mismatches.length) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build replay review frame at step ${selected.index + 1}: ${replay.mismatches.join(" ")}`
    );
  }
  episode.finalState = cloneArtifact(replay.finalState);
  const replayedStateHash = hashStableState(episode.finalState);
  if (replay.finalHash !== undefined && replay.finalHash !== replayedStateHash) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build replay review frame at step ${selected.index + 1}: replay final hash does not match its final state.`
    );
  }
  const replayedMessagesHash = hashStableState(episode.messages);
  if (replay.messagesHash !== undefined && replay.messagesHash !== replayedMessagesHash) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build replay review frame at step ${selected.index + 1}: replay messages hash does not match the selected prefix.`
    );
  }
  return {
    stepIndex: selected.index,
    nativeStepCount: selected.index + 1,
    step: cloneArtifact(selected.step),
    maxMessageSeq,
    episode,
    replay
  };
}

/**
 * Build a checkpoint from a recorded native prefix.  A domain supplies only
 * (a) how its durable actor states are resolved and (b) a model-free replay
 * callback.  The harness constructs the prefix, validates batch safety, and
 * binds the resulting state/message/agent hashes into the common envelope.
 */
export function buildHarnessCheckpointAtPrefix<TState, TObservation, TPending, TCommand, TAgentState>(
  options: BuildHarnessCheckpointAtPrefixOptions<TState, TObservation, TPending, TCommand, TAgentState>
): HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand> {
  const selected = resolveHarnessCheckpointPrefixSelection(options.episode, options.selector);
  assertSafeHarnessCheckpointBoundary(options.episode.steps, selected.index);
  // Failure/rejection records remain valuable audit evidence and may be used
  // for model-free replay review. They are not receipt-gated durable actor
  // state, so a checkpoint must never ask a domain snapshot resolver to turn
  // one into a forkable continuation boundary.
  if (!isSocialStepCommitted(selected.step)) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: no durable agent snapshot exists after a rejected boundary.`
    );
  }
  const snapshot = resolveHarnessAgentSnapshotAtStep({
    episode: options.episode,
    step: selected.step,
    stepIndex: selected.index,
    resolver: options.resolveAgentSnapshot
  });
  if (!snapshot) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: no durable agent snapshot was recorded for this boundary.`
    );
  }
  const snapshotHash = hashStableState(snapshot.agents);
  if (snapshotHash !== snapshot.agentsHash) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: agent snapshot hash mismatch.`
    );
  }

  const steps = cloneArtifact(options.episode.steps.slice(0, selected.index + 1));
  const maxMessageSeq = latestMessageSeqForHarnessPrefix(options.episode, steps);
  const messages = cloneArtifact(options.episode.messages.filter((message) => message.seq <= maxMessageSeq));
  const agentValidationErrors: string[] = [];
  if (options.recordedAgentState.mode === "none") {
    if (!options.recordedAgentState.reason.trim()) {
      agentValidationErrors.push("recordedAgentState.mode=none requires a nonempty reason.");
    }
    if (snapshot.agents.length > 0) {
      agentValidationErrors.push(
        "recordedAgentState.mode=none is not allowed because the checkpoint records durable actor state."
      );
    }
  } else {
    agentValidationErrors.push(
      ...options.recordedAgentState.validator({
        agents: snapshot.agents,
        step: selected.step,
        stepIndex: selected.index,
        maxMessageSeq
      })
    );
  }
  if (agentValidationErrors.length) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: ${agentValidationErrors.join(" ")}`
    );
  }

  // The replay callback derives the real prefix final state.  Do not infer it
  // from command text or from the completed parent artifact.
  const executionPrefix = cloneArtifact({
    ...options.episode,
    status: "truncated" as const,
    terminationReason: undefined,
    truncationReason: `checkpoint boundary after native step ${selected.index + 1}`,
    failureReason: undefined,
    error: undefined,
    finalState: options.episode.initialState,
    steps,
    messages,
    exposureRecords: undefined,
    exposureSummary: undefined,
    metrics: undefined
  });
  const replay = options.replayPrefix(executionPrefix);
  if (replay.mismatches.length) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: ${replay.mismatches.join(" ")}`
    );
  }
  executionPrefix.finalState = cloneArtifact(replay.finalState);
  const replayedStateHash = hashStableState(executionPrefix.finalState);
  if (replay.finalHash !== undefined && replay.finalHash !== replayedStateHash) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: replay final hash does not match its final state.`
    );
  }
  const replayedMessagesHash = hashStableState(executionPrefix.messages);
  if (replay.messagesHash !== undefined && replay.messagesHash !== replayedMessagesHash) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: replay messages hash does not match the selected prefix.`
    );
  }

  return buildHarnessCheckpointFromEpisode({
    artifactVersion: options.artifactVersion,
    kind: options.kind,
    checkpointId: options.checkpointId,
    createdAt: options.createdAt,
    reason: options.reason,
    sourceArtifactVersion: options.sourceArtifactVersion,
    runId: options.runId,
    sourceStatus: options.sourceStatus ?? options.episode.status,
    failureReason: options.failureReason,
    truncationReason: options.truncationReason,
    episode: executionPrefix,
    state: executionPrefix.finalState,
    agents: snapshot.agents,
    experiment: options.experiment,
    agentSnapshotFrameId: snapshot.frameId
  });
}

export function resolveHarnessCheckpointPrefixSelection<TState, TObservation, TPending, TCommand>(
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>,
  selector: HarnessCheckpointPrefixSelector
): { index: number; step: SocialHarnessStep<TObservation, TPending, TCommand> } {
  const selectorNames = [
    selector.traceId !== undefined ? "traceId" : undefined,
    selector.nativeTurnIndex !== undefined ? "nativeTurnIndex" : undefined,
    selector.nativeStepCount !== undefined ? "nativeStepCount" : undefined
  ].filter((value): value is string => Boolean(value));
  if (selectorNames.length !== 1) {
    throw new HarnessCheckpointSelectionError(
      selectorNames.length === 0 ? "selector_not_found" : "ambiguous_selector",
      selectorNames.length === 0
        ? "Prefix checkpoint requires exactly one selector."
        : `Prefix checkpoint selector is ambiguous: ${selectorNames.join(", ")}.`
    );
  }
  const index =
    selector.traceId !== undefined
      ? episode.steps.findIndex((step) => step.traceId === selector.traceId)
      : selector.nativeTurnIndex !== undefined
        ? episode.steps.findIndex((step) => step.turnIndex === selector.nativeTurnIndex)
        : (selector.nativeStepCount ?? 0) - 1;
  const step = episode.steps[index];
  if (!step) {
    throw new HarnessCheckpointSelectionError("selector_not_found", "Prefix checkpoint selector did not match a native social execution step.");
  }
  return { index, step };
}

export function assertSafeHarnessCheckpointBoundary(
  steps: readonly SocialHarnessStep[],
  stepIndex: number
): void {
  if (!isSafeHarnessCheckpointBoundary(steps, stepIndex)) {
    throw new HarnessCheckpointSelectionError(
      "unsafe_batch_boundary",
      "Prefix checkpoint cannot be built from the middle of a native scheduler batch."
    );
  }
}

export function isSafeHarnessCheckpointBoundary(steps: readonly SocialHarnessStep[], stepIndex: number): boolean {
  if (stepIndex < 0) return steps.length === 0;
  const step = steps[stepIndex];
  if (!step) return false;

  // A true parallel transition has one atomic post-state only after every
  // member of its declared joint batch is present. Looking merely for a next
  // row with the same batch id accepts a truncated artifact whose missing
  // peers were cut off at the end of the array. Treat malformed or incomplete
  // parallel batch metadata as an unsafe replay/checkpoint boundary before a
  // domain replay callback, snapshot resolver, or restore factory can run.
  if (isSocialParallelJointStep(step)) {
    return isCompleteParallelJointBatchBoundary(steps, stepIndex);
  }

  const nextStep = steps[stepIndex + 1];
  if (!step.batchId || nextStep?.batchId !== step.batchId) return true;
  return step.schedulerMode === "aec" && !step.atomic;
}

function isCompleteParallelJointBatchBoundary(
  steps: readonly SocialHarnessStep[],
  stepIndex: number
): boolean {
  const boundary = steps[stepIndex];
  if (!boundary?.batchId) return false;

  let batchStart = stepIndex;
  while (batchStart > 0 && steps[batchStart - 1]?.batchId === boundary.batchId) {
    batchStart -= 1;
  }
  let batchEnd = stepIndex;
  while (batchEnd + 1 < steps.length && steps[batchEnd + 1]?.batchId === boundary.batchId) {
    batchEnd += 1;
  }

  // A selected prefix may end only after the entire contiguous joint batch,
  // and a batch id may not be split into disjoint regions of the trajectory.
  if (batchEnd !== stepIndex) return false;
  if (steps.some((step, index) => step.batchId === boundary.batchId && (index < batchStart || index > batchEnd))) {
    return false;
  }

  const batch = steps.slice(batchStart, batchEnd + 1);
  if (batch.length !== boundary.batchSize) return false;
  return validateSocialParallelBatchLayout(batch).length === 0;
}

export function latestMessageSeqForHarnessPrefix<TState, TObservation, TPending, TCommand>(
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>,
  steps: readonly SocialHarnessStep<TObservation, TPending, TCommand>[]
): number {
  let messageSeq = episode.execution?.initialMessageCount ?? 0;
  for (const step of steps) {
    if (step.messageSeqRange) messageSeq = Math.max(messageSeq, step.messageSeqRange[1]);
  }
  return messageSeq;
}

export function resolveHarnessAgentSnapshotAtStep<TState, TObservation, TPending, TCommand, TAgentState>(input: {
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  step: SocialHarnessStep<TObservation, TPending, TCommand>;
  stepIndex: number;
  resolver?: HarnessAgentSnapshotResolver<TState, TObservation, TPending, TCommand, TAgentState>;
}): ResolvedHarnessAgentSnapshot<TAgentState> | undefined {
  const resolved = input.resolver?.({
    episode: input.episode,
    step: input.step,
    stepIndex: input.stepIndex
  });
  if (resolved) {
    return {
      agents: cloneArtifact(resolved.agents),
      agentsHash: resolved.agentsHash,
      frameId: resolved.frameId
    };
  }
  if (!Array.isArray(input.step.actorSnapshotsAfterStep)) return undefined;
  const agents = cloneArtifact(input.step.actorSnapshotsAfterStep) as TAgentState[];
  return {
    agents,
    agentsHash: input.step.actorSnapshotsHashAfterStep ?? hashStableState(agents),
    frameId: input.step.actorSnapshotFrameIdAfterStep
  };
}

/** Build domain-neutral lineage from a validated checkpoint envelope. */
export function createGenericForkProvenance<
  TState,
  TAgentState,
  TObservation,
  TPending,
  TCommand,
  TSource extends HarnessCheckpointSource,
  TCheckpointArtifactVersion extends string = string
>(
  checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand, TSource> & {
    artifactVersion: TCheckpointArtifactVersion;
  },
  options: CreateGenericForkProvenanceOptions = {}
): GenericForkProvenance<TCheckpointArtifactVersion> {
  const parentExperiment = checkpoint.source.experiment;
  if (Boolean(parentExperiment) !== Boolean(options.childExperiment)) {
    throw new Error(
      "Experiment-bound fork provenance requires both checkpoint source.experiment and childExperiment."
    );
  }
  if (!parentExperiment && options.changedExperimentFields !== undefined) {
    throw new Error("changedExperimentFields requires experiment-bound parent and child specs.");
  }
  const experimentLineage = parentExperiment && options.childExperiment
    ? createGenericExperimentForkLineage({
        parent: parentExperiment,
        child: options.childExperiment,
        changedFields: options.changedExperimentFields ?? []
      })
    : undefined;
  return {
    schemaVersion: HARNESS_FORK_PROVENANCE_VERSION,
    checkpointArtifactVersion: checkpoint.artifactVersion,
    checkpointId: checkpoint.checkpointId,
    parentRunId: checkpoint.source.runId,
    parentArtifactId: options.parentArtifactId,
    parentBoundaryTraceId: checkpoint.source.boundaryTraceId,
    parentEvidenceTraceIds: options.parentEvidenceTraceIds,
    parentBoundaryTurnIndex: checkpoint.source.boundaryTurnIndex,
    parentStateHash: checkpoint.source.stateHash,
    parentExecutionPrefixHash: checkpoint.source.executionPrefixHash,
    parentAgentsHash: checkpoint.source.agentsHash,
    parentChannelsHash: checkpoint.source.channelsHash,
    parentMessagesHash: checkpoint.source.messagesHash,
    parentNativeStepCount: checkpoint.source.nativeStepCount,
    parentMessageCount: checkpoint.source.messageCount,
    parentDomainAdapter: checkpoint.source.domainAdapter
      ? cloneSocialDomainAdapterManifest(checkpoint.source.domainAdapter)
      : undefined,
    ...(experimentLineage === undefined ? {} : { experimentLineage }),
    createdAt: options.createdAt ?? new Date().toISOString(),
    reason: options.reason
  };
}

/**
 * Validates only invariants that every social domain shares. Domain adapters
 * add role/action/evaluator checks in their own artifact validators.
 */
