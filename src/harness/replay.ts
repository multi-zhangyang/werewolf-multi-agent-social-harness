import { isAgentPendingAction, type AgentPendingAction } from "../core/pending";
import type { GameCommand, GameState } from "../core/types";
import { WerewolfEnvironment } from "./environment";
import { auditRecordedSocialAgentSnapshots, type RecordedSocialAgentStateAuditResult } from "./episodeArtifacts";
import { hashStableState } from "./hash";
import {
  isSocialParallelJointStep,
  isSocialStepCommitted,
  isSocialStepNonReplayableFailure,
  SocialCommunicationBus,
  validateSocialParallelBatchLayout,
  type SocialEpisodeArtifact,
  type SocialHarnessStep,
  type SocialMessage,
  type SocialParallelEnvironment,
  type SocialEnvironment
} from "./social";
import type { HarnessStepRecord } from "./types";

export interface ReplayResult {
  ok: boolean;
  replayedCommands: number;
  finalState: GameState;
  finalHash: string;
  expectedFinalHash?: string;
  mismatches: string[];
}

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
  /** Present only when the episode contains recorded inline actor snapshots. */
  agentStateAudit?: RecordedSocialAgentStateAuditResult;
  mismatches: string[];
}

export function replaySocialEpisode<TState, TObservation, TPending, TCommand>(options: {
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
  /** Defaults to true when inline durable actor snapshots are present. */
  auditAgentSnapshots?: boolean;
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
  // replay environment; replay is a public API and cannot rely on callers to
  // have run artifact integrity validation first.
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
        addMismatch(
          `Native step ${index} ${step.traceId}: rejected step changed event range ${formatRange(undefined)} !== ${formatRange(step.eventSeqRange)}.`
        );
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
          addMismatch(
            `Native parallel step ${index} ${step.traceId}: rejected step changed domain state ${currentHash ?? "missing"} !== ${step.postStateHash}.`
          );
        }
        if (!sameOptionalRange(undefined, step.eventSeqRange)) {
          addMismatch(
            `Native parallel step ${index} ${step.traceId}: rejected step changed event range ${formatRange(undefined)} !== ${formatRange(step.eventSeqRange)}.`
          );
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
      // Publish per actor in batch order so message seq ranges match recording.
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
    const batchMessageRange =
      afterMessageSeq > beforeMessageSeq ? ([beforeMessageSeq + 1, afterMessageSeq] as [number, number]) : undefined;
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
        if (draftCount > 0) {
          actualMessageRange = [cursor + 1, cursor + draftCount];
          cursor += draftCount;
        } else {
          actualMessageRange = undefined;
        }
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

    // A domain may compact snapshots into an external frame registry (the
    // Werewolf artifact does so after execution).  Generic replay can audit
    // only inline payloads; a frame-backed domain keeps its own resolver and
    // validator rather than treating the missing inline body as corruption.
    const hasRecordedActorSnapshots = episode.steps.some((step) => step.actorSnapshotsAfterStep !== undefined);
    const agentStateAudit =
      options.auditAgentSnapshots === false || !hasRecordedActorSnapshots
        ? undefined
        : auditRecordedSocialAgentSnapshots({ episode });
    for (const mismatch of agentStateAudit?.mismatches ?? []) {
      addMismatch(`Recorded agent state audit: ${mismatch}`);
    }

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

export function replayWerewolfSocialEpisode(
  episode: SocialEpisodeArtifact,
  options: { stopOnMismatch?: boolean } = {}
): SocialEpisodeReplayResult<GameState> {
  return replaySocialEpisode({
    episode: episode as SocialEpisodeArtifact<GameState, unknown, unknown, GameCommand>,
    environment: new WerewolfEnvironment(episode.initialState as GameState) as unknown as SocialEnvironment<GameState, unknown, unknown, GameCommand>,
    hashState: hashStableState,
    hashMessages: hashStableState,
    eventSeq: (state) => state.events.at(-1)?.seq ?? 0,
    stopOnMismatch: options.stopOnMismatch
  });
}

export function replayHarnessTrajectory(options: {
  initialState: GameState;
  trajectory: HarnessStepRecord[];
  stopOnMismatch?: boolean;
  expectedFinalHash?: string;
}): ReplayResult {
  const environment = new WerewolfEnvironment(options.initialState);
  const mismatches: string[] = [];
  const stopOnMismatch = options.stopOnMismatch ?? true;
  let replayedCommands = 0;

  for (const step of options.trajectory) {
    advanceToNextAgentAction(environment);
    const pendingAction = environment.pendingActions().find((candidate) => samePendingAction(candidate, step.pendingAction));
    if (!pendingAction) {
      addMismatch(`Step ${step.turnIndex} ${step.traceId}: pending action ${step.pendingAction.kind}/${step.actorId} is not available.`);
      if (stopOnMismatch) break;
      continue;
    }

    const preHash = hashStableState(environment.snapshot());
    if (preHash !== step.preStateHash) {
      addMismatch(`Step ${step.turnIndex} ${step.traceId}: preStateHash mismatch ${preHash} !== ${step.preStateHash}.`);
      if (stopOnMismatch) break;
    }

    if (actionKindForCommand(step.command) !== step.pendingAction.kind) {
      addMismatch(`Step ${step.turnIndex} ${step.traceId}: command ${step.command.type} does not match pending ${step.pendingAction.kind}.`);
      if (stopOnMismatch) break;
    }

    const beforeSeq = environment.snapshot().events.at(-1)?.seq ?? 0;
    try {
      environment.step(step.command);
    } catch (error) {
      addMismatch(
        `Step ${step.turnIndex} ${step.traceId}: command application failed ${
          error instanceof Error ? error.message : String(error)
        }.`
      );
      break;
    }
    replayedCommands += 1;

    const afterState = environment.snapshot();
    const afterSeq = afterState.events.at(-1)?.seq ?? beforeSeq;
    const actualEventSeqRange: [number, number] = [beforeSeq + 1, afterSeq];
    if (actualEventSeqRange[0] !== step.eventSeqRange[0] || actualEventSeqRange[1] !== step.eventSeqRange[1]) {
      addMismatch(
        `Step ${step.turnIndex} ${step.traceId}: eventSeqRange mismatch ${actualEventSeqRange.join("-")} !== ${step.eventSeqRange.join("-")}.`
      );
      if (stopOnMismatch) break;
    }

    const postHash = hashStableState(afterState);
    if (postHash !== step.postStateHash) {
      addMismatch(`Step ${step.turnIndex} ${step.traceId}: postStateHash mismatch ${postHash} !== ${step.postStateHash}.`);
      if (stopOnMismatch) break;
    }
  }

  const finalState = environment.snapshot();
  const finalHash = hashStableState(finalState);
  if (options.expectedFinalHash && finalHash !== options.expectedFinalHash) {
    addMismatch(`Replay finalHash mismatch ${finalHash} !== ${options.expectedFinalHash}.`);
  }
  return {
    ok: mismatches.length === 0,
    replayedCommands,
    finalState,
    finalHash,
    expectedFinalHash: options.expectedFinalHash,
    mismatches
  };

  function addMismatch(message: string): void {
    mismatches.push(message);
  }
}

function advanceToNextAgentAction(environment: WerewolfEnvironment): void {
  let guard = 0;
  while (guard < 64) {
    const pending = environment.pending();
    if (pending.some(isAgentPendingAction)) return;
    if (pending.length !== 1 || pending[0].kind !== "advance") return;
    environment.step({ type: "system.advance", actorId: "system" });
    guard += 1;
  }
  throw new Error("Replay advance guard exceeded.");
}

function samePendingAction(left: AgentPendingAction, right: AgentPendingAction): boolean {
  return left.kind === right.kind && left.actorId === right.actorId && left.phase === right.phase;
}

function actionKindForCommand(command: GameCommand): AgentPendingAction["kind"] | "advance" {
  if (command.type === "seer.inspect") return "inspect";
  if (command.type === "werewolf.whisper") return "whisper";
  if (command.type === "werewolf.killVote") return "kill";
  if (command.type === "witch.act") return "witch";
  if (command.type === "speech.submit") return "speech";
  if (command.type === "lastWords.submit") return "last_words";
  if (command.type === "sheriff.vote") return "sheriff_vote";
  if (command.type === "vote.cast") return "vote";
  if (command.type === "hunter.shoot") return "shoot";
  return "advance";
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
