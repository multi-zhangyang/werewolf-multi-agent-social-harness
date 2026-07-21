import {
  auditRecordedSocialAgentSnapshots,
  type HarnessAgentSnapshotFrame,
  type RecordedSocialAgentStateAuditResult
} from "./episodeArtifacts";
import {
  isSocialParallelJointStep,
  isSocialStepCommitted,
  isSocialStepNonReplayableFailure,
  SocialCommunicationBus,
  validateSocialParallelBatchLayout,
  type SocialEpisodeArtifact,
  type SocialEnvironment,
  type SocialHarnessStep,
  type SocialMessage,
  type SocialParallelEnvironment
} from "./social";

/**
 * Domain-neutral replay result. Replay consumes recorded commands and a
 * deterministic environment only: it creates no actor, policy, reasoner,
 * provider client, or model request.
 */
export interface SocialEpisodeReplayResult<TState = unknown> {
  ok: boolean;
  replayedSteps: number;
  replayedBatches: number;
  rejectedSteps: number;
  finalState: TState;
  finalHash?: string;
  expectedFinalHash?: string;
  messages: SocialMessage[];
  messagesHash?: string;
  expectedMessagesHash?: string;
  /** Present when the episode contains inline snapshots or an external frame registry. */
  agentStateAudit?: RecordedSocialAgentStateAuditResult;
  mismatches: string[];
}

export function replaySocialEpisode<TState, TObservation, TPending, TCommand, TAgentState = unknown>(options: {
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  hashState?: (state: TState) => string;
  hashMessages?: (messages: SocialMessage[]) => string;
  eventSeq?: (state: TState) => number;
  stopOnMismatch?: boolean;
  /**
   * Prefix checkpoint construction has not yet populated episode.finalState.
   * It still replays every command/message and validates their local hashes;
   * only the final expected-state comparison is intentionally deferred.
   */
  validateExpectedFinalState?: boolean;
  /** Defaults to true when durable snapshots or an external frame registry are present. */
  auditAgentSnapshots?: boolean;
  /** Optional recorded, compacted durable actor-state sidecar. */
  agentSnapshotFrames?: HarnessAgentSnapshotFrame<TAgentState>[];
}): SocialEpisodeReplayResult<TState> {
  const { episode } = options;
  const mismatches: string[] = [];
  const stopOnMismatch = options.stopOnMismatch ?? true;
  const initialMessageCount = episode.execution?.initialMessageCount ?? 0;
  const initialMessages = episode.messages.slice(0, initialMessageCount);
  const bus = new SocialCommunicationBus(episode.channels, initialMessages);
  let replayedSteps = 0;
  let replayedBatches = 0;
  let rejectedSteps = 0;

  const initialStateHash = options.hashState?.(options.environment.snapshot());
  const expectedInitialStateHash = options.hashState?.(episode.initialState);
  if (initialStateHash && expectedInitialStateHash && initialStateHash !== expectedInitialStateHash) {
    addMismatch(`Initial state hash mismatch ${initialStateHash} !== ${expectedInitialStateHash}.`);
  }
  const initialMessagesHash = options.hashMessages?.(initialMessages);
  if (episode.execution?.initialMessagesHash && initialMessagesHash !== episode.execution.initialMessagesHash) {
    addMismatch(`Initial messages hash mismatch ${initialMessagesHash ?? "missing"} !== ${episode.execution.initialMessagesHash}.`);
  }

  // A parallel artifact is only replayable as one complete joint transition.
  // Reject malformed layout before either step() or stepBatch() can mutate the
  // replay environment; callers cannot be required to have prevalidated an
  // artifact before asking a generic replay question.
  const parallelLayoutErrors = validateSocialParallelBatchLayout(episode.steps);
  for (const error of parallelLayoutErrors) addMismatch(`Parallel batch layout: ${error}`);
  if (parallelLayoutErrors.length) return finalizeReplay();

  for (let index = 0; index < episode.steps.length; ) {
    if (stopOnMismatch && mismatches.length) break;
    const step = episode.steps[index];
    if (isSocialParallelJointStep(step)) {
      const batch = contiguousParallelBatch(episode.steps, index);
      replayParallelBatch(batch, index);
      index += batch.length;
      continue;
    }
    replaySequentialStep(step, index);
    index += 1;
  }

  return finalizeReplay();

  function replaySequentialStep(step: SocialHarnessStep<TObservation, TPending, TCommand>, index: number): void {
    const committed = isSocialStepCommitted(step);
    const currentHash = options.hashState?.(options.environment.snapshot());
    if (step.preStateHash && currentHash !== step.preStateHash) {
      addMismatch(`Native step ${index} ${step.traceId}: preStateHash mismatch ${currentHash ?? "missing"} !== ${step.preStateHash}.`);
      if (stopOnMismatch) return;
    }
    if (!committed) {
      rejectedSteps += 1;
      if (step.messageSeqRange) addMismatch(`Native step ${index} ${step.traceId}: rejected step cannot commit messages.`);
      if (isSocialStepNonReplayableFailure(step)) {
        addMismatch(`Native step ${index} ${step.traceId}: environment recorded a non-atomic failure and cannot be replayed.`);
      }
      if (step.postStateHash && currentHash !== step.postStateHash) {
        addMismatch(`Native step ${index} ${step.traceId}: rejected step changed domain state ${currentHash ?? "missing"} !== ${step.postStateHash}.`);
      }
      if (!sameOptionalRange(undefined, step.eventSeqRange)) {
        addMismatch(`Native step ${index} ${step.traceId}: rejected step changed event range ${formatRange(undefined)} !== ${formatRange(step.eventSeqRange)}.`);
      }
      return;
    }

    const beforeEventSeq = options.eventSeq?.(options.environment.snapshot());
    const beforeMessageSeq = bus.listMessages().at(-1)?.seq ?? 0;
    try {
      bus.validateMessages(step.action.messages ?? []);
      options.environment.step(step.action.command);
      bus.publishMany(step.action.messages ?? []);
    } catch (error) {
      addMismatch(`Native step ${index} ${step.traceId}: committed step failed: ${error instanceof Error ? error.message : String(error)}.`);
      return;
    }
    replayedSteps += 1;
    replayedBatches += 1;
    validateCommittedOutcome([step], index, beforeEventSeq, beforeMessageSeq);
  }

  function replayParallelBatch(batch: Array<SocialHarnessStep<TObservation, TPending, TCommand>>, startIndex: number): void {
    const committed = batch.every((step) => isSocialStepCommitted(step));
    const currentHash = options.hashState?.(options.environment.snapshot());
    for (const step of batch) {
      if (step.preStateHash && currentHash !== step.preStateHash) {
        addMismatch(`Native parallel step ${step.traceId}: preStateHash mismatch ${currentHash ?? "missing"} !== ${step.preStateHash}.`);
      }
    }
    if (!committed) {
      rejectedSteps += batch.length;
      if (batch.some((step) => step.messageSeqRange)) addMismatch(`Native parallel batch ${batch[0]?.batchId ?? "unknown"}: rejected batch cannot commit messages.`);
      for (const [offset, step] of batch.entries()) {
        const index = startIndex + offset;
        if (isSocialStepNonReplayableFailure(step)) {
          addMismatch(`Native parallel step ${index} ${step.traceId}: environment recorded a non-atomic failure and cannot be replayed.`);
        }
        if (step.postStateHash && currentHash !== step.postStateHash) {
          addMismatch(`Native parallel step ${index} ${step.traceId}: rejected step changed domain state ${currentHash ?? "missing"} !== ${step.postStateHash}.`);
        }
        if (!sameOptionalRange(undefined, step.eventSeqRange)) {
          addMismatch(`Native parallel step ${index} ${step.traceId}: rejected step changed event range ${formatRange(undefined)} !== ${formatRange(step.eventSeqRange)}.`);
        }
      }
      return;
    }
    if (!isParallelEnvironment(options.environment)) {
      addMismatch(`Native parallel batch ${batch[0]?.batchId ?? "unknown"}: environment does not implement stepBatch().`);
      return;
    }
    const beforeEventSeq = options.eventSeq?.(options.environment.snapshot());
    const beforeMessageSeq = bus.listMessages().at(-1)?.seq ?? 0;
    try {
      bus.validateMessages(batch.flatMap((step) => step.action.messages ?? []));
      options.environment.stepBatch(Object.fromEntries(batch.map((step) => [step.actorId, step.action.command])));
      for (const step of batch) {
        const drafts = step.action.messages ?? [];
        if (drafts.length) bus.publishMany(drafts);
      }
    } catch (error) {
      addMismatch(`Native parallel batch ${batch[0]?.batchId ?? "unknown"}: committed batch failed: ${error instanceof Error ? error.message : String(error)}.`);
      return;
    }
    replayedSteps += batch.length;
    replayedBatches += 1;
    validateCommittedOutcome(batch, startIndex, beforeEventSeq, beforeMessageSeq, { parallel: true });
  }

  function validateCommittedOutcome(
    steps: Array<SocialHarnessStep<TObservation, TPending, TCommand>>,
    startIndex: number,
    beforeEventSeq: number | undefined,
    beforeMessageSeq: number,
    optionsMode: { parallel?: boolean } = {}
  ): void {
    const afterState = options.environment.snapshot();
    const afterHash = options.hashState?.(afterState);
    const afterEventSeq = options.eventSeq?.(afterState);
    const afterMessageSeq = bus.listMessages().at(-1)?.seq ?? beforeMessageSeq;
    const actualEventRange = numericRange(beforeEventSeq, afterEventSeq);
    const batchMessageRange = afterMessageSeq > beforeMessageSeq ? ([beforeMessageSeq + 1, afterMessageSeq] as [number, number]) : undefined;
    let cursor = beforeMessageSeq;
    for (const [offset, step] of steps.entries()) {
      const index = startIndex + offset;
      if (step.postStateHash && afterHash !== step.postStateHash) {
        addMismatch(`Native step ${index} ${step.traceId}: postStateHash mismatch ${afterHash ?? "missing"} !== ${step.postStateHash}.`);
      }
      if (!sameOptionalRange(actualEventRange, step.eventSeqRange)) {
        addMismatch(`Native step ${index} ${step.traceId}: eventSeqRange mismatch ${formatRange(actualEventRange)} !== ${formatRange(step.eventSeqRange)}.`);
      }
      let actualMessageRange: [number, number] | undefined;
      if (optionsMode.parallel) {
        const draftCount = step.action.messages?.length ?? 0;
        actualMessageRange = draftCount > 0 ? [cursor + 1, cursor + draftCount] : undefined;
        cursor += draftCount;
      } else {
        actualMessageRange = batchMessageRange;
      }
      if (!sameOptionalRange(actualMessageRange, step.messageSeqRange)) {
        addMismatch(`Native step ${index} ${step.traceId}: messageSeqRange mismatch ${formatRange(actualMessageRange)} !== ${formatRange(step.messageSeqRange)}.`);
      }
    }
    if (batchMessageRange) {
      const [start, end] = batchMessageRange;
      const replayed = bus.listMessages().filter((message) => message.seq >= start && message.seq <= end);
      const recorded = episode.messages.filter((message) => message.seq >= start && message.seq <= end);
      if (JSON.stringify(replayed) !== JSON.stringify(recorded)) {
        addMismatch(`Native steps ${startIndex}-${startIndex + steps.length - 1}: committed message envelopes do not match recorded messages.`);
      }
    }
  }

  function addMismatch(message: string): void {
    mismatches.push(message);
  }

  function finalizeReplay(): SocialEpisodeReplayResult<TState> {
    const finalState = options.environment.snapshot();
    const finalHash = options.hashState?.(finalState);
    const expectedFinalHash = options.validateExpectedFinalState === false ? undefined : options.hashState?.(episode.finalState);
    if (finalHash && expectedFinalHash && finalHash !== expectedFinalHash) {
      addMismatch(`Replay final state hash mismatch ${finalHash} !== ${expectedFinalHash}.`);
    }
    const messages = bus.listMessages();
    const messagesHash = options.hashMessages?.(messages);
    const expectedMessagesHash = options.hashMessages?.(episode.messages);
    if (messagesHash && expectedMessagesHash && messagesHash !== expectedMessagesHash) {
      addMismatch(`Replay messages hash mismatch ${messagesHash} !== ${expectedMessagesHash}.`);
    }
    const hasRecordedActorSnapshots = episode.steps.some(
      (step) => step.actorSnapshotsAfterStep !== undefined || step.actorSnapshotsHashAfterStep !== undefined || step.actorSnapshotFrameIdAfterStep !== undefined
    );
    const hasExternalFrames = options.agentSnapshotFrames !== undefined;
    const agentStateAudit =
      options.auditAgentSnapshots === false || (!hasRecordedActorSnapshots && !hasExternalFrames)
        ? undefined
        : auditRecordedSocialAgentSnapshots({ episode, snapshotFrames: options.agentSnapshotFrames });
    for (const mismatch of agentStateAudit?.mismatches ?? []) addMismatch(`Recorded agent state audit: ${mismatch}`);

    return {
      ok: mismatches.length === 0,
      replayedSteps,
      replayedBatches,
      rejectedSteps,
      finalState,
      finalHash,
      expectedFinalHash,
      messages,
      messagesHash,
      expectedMessagesHash,
      agentStateAudit,
      mismatches
    };
  }
}

function contiguousParallelBatch<TObservation, TPending, TCommand>(
  steps: Array<SocialHarnessStep<TObservation, TPending, TCommand>>,
  startIndex: number
): Array<SocialHarnessStep<TObservation, TPending, TCommand>> {
  const first = steps[startIndex];
  if (!first?.batchId) return first ? [first] : [];
  const batch: Array<SocialHarnessStep<TObservation, TPending, TCommand>> = [];
  for (let index = startIndex; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.batchId !== first.batchId) break;
    batch.push(step);
  }
  return batch;
}

function isParallelEnvironment<TState, TObservation, TPending, TCommand>(
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>
): environment is SocialParallelEnvironment<TState, TObservation, TPending, TCommand> {
  return typeof (environment as Partial<SocialParallelEnvironment<TState, TObservation, TPending, TCommand>>).stepBatch === "function";
}

function numericRange(before: number | undefined, after: number | undefined): [number, number] | undefined {
  if (before === undefined || after === undefined || after <= before) return undefined;
  return [before + 1, after];
}

function sameOptionalRange(left: [number, number] | undefined, right: [number, number] | undefined): boolean {
  if (!left || !right) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}

function formatRange(range: [number, number] | undefined): string {
  return range ? range.join("-") : "none";
}
