import {
  auditRecordedSocialAgentSnapshots,
  resolveHarnessAgentSnapshotFrame,
  validateHarnessEpisodeArtifactEnvelope,
  type HarnessAgentSnapshotFrame,
  type HarnessEpisodeArtifactEnvelope,
  type RecordedSocialAgentStateAuditResult
} from "./episodeArtifacts";
import {
  deriveSocialExposureRecords,
  isSocialParallelJointStep,
  isSocialStepCommitted,
  isSocialStepNonReplayableFailure,
  SocialCommunicationBus,
  validateSocialParallelBatchLayout,
  type SocialEpisodeArtifact,
  type SocialEnvironment,
  type SocialExposureRecord,
  type SocialHarnessStep,
  type SocialMessage,
  type SocialParallelEnvironment
} from "./social";
import {
  compareSocialDomainAdapterManifests,
  validateSocialDomainAdapterManifest,
  type SocialDomainAdapterManifest
} from "./domainAdapter";

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

/**
 * Domain adapters can bind recorded pending-action evidence to the actual
 * replay pre-state without making the generic replayer import a domain. This
 * remains a pure audit callback: replay still creates no actor, policy,
 * reasoner, or provider.
 */
export type SocialRecordedStepValidator<TState, TObservation, TPending, TCommand> = (
  step: SocialHarnessStep<TObservation, TPending, TCommand>,
  context: {
    index: number;
    state: TState;
    pendingActions: readonly TPending[];
    schedulerMode: "aec" | "aec-batched-decision" | "parallel";
    batch: readonly SocialHarnessStep<TObservation, TPending, TCommand>[];
  }
) => readonly string[];

/**
 * Pure, domain-owned validation of a durable actor-state snapshot recorded at
 * a completed receipt boundary. The generic replayer supplies only recorded
 * evidence: environment snapshots, committed messages, scoped observations,
 * and the prior durable snapshot. It never instantiates an actor, evaluates a
 * policy, parses free text, or calls a reasoner/provider.
 *
 * The callback runs once at the end of a complete native batch. For a true
 * parallel batch that means one invocation after the joint `stepBatch()` and
 * all recorded receipts, never against an invented per-member intermediary.
 */
export type SocialRecordedAgentStateValidator<TState, TObservation, TPending, TCommand, TAgentState> = (input: {
  /** Recorded prefix only; no future steps or messages are exposed. */
  episodePrefix: Pick<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>, "steps" | "messages" | "channels" | "runtimeActorIds">;
  /** Last native step in this completed receipt boundary. */
  step: SocialHarnessStep<TObservation, TPending, TCommand>;
  /** Zero-based index of `step` in the full episode. */
  stepIndex: number;
  /** One sequential step or every member of one completed parallel batch. */
  batch: readonly SocialHarnessStep<TObservation, TPending, TCommand>[];
  /** Durable actor state from the preceding captured receipt boundary, when available. */
  priorAgents?: readonly TAgentState[];
  /** Durable actor state recorded after this receipt boundary. */
  recordedAgents: readonly TAgentState[];
  /** Exact replay environment state before this native boundary. */
  stateBefore: TState;
  /** Exact replay environment state after this native boundary. */
  stateAfter: TState;
  /** All committed social messages through this boundary. */
  committedMessages: readonly SocialMessage[];
  /**
   * Canonical actor-scoped message exposures derived from observations in the
   * recorded prefix. The helper has already enforced channel/runtime-audience
   * rules; it is evidence, not an inference from message text.
   */
  scopedExposureRecords: readonly SocialExposureRecord[];
  /**
   * Channel-authorized message slices at this committed boundary. These do
   * not replace `scopedExposureRecords`: a validator that needs proof of an
   * actual observation must use the latter.
   */
  visibleMessagesByActor: Readonly<Record<string, readonly SocialMessage[]>>;
}) => readonly string[];

/**
 * Canonical artifact acceptance must make the private-state semantic policy
 * explicit. A domain may opt out only when it records no durable actor state;
 * callers can no longer silently omit a validator while still claiming that a
 * state-bearing artifact received semantic verification.
 */
export type SocialRecordedAgentStateValidationPolicy<
  TState,
  TObservation,
  TPending,
  TCommand,
  TAgentState
> =
  | {
      mode: "validate";
      validator: SocialRecordedAgentStateValidator<TState, TObservation, TPending, TCommand, TAgentState>;
    }
  | {
      mode: "none";
      reason: string;
    };

export interface SocialArtifactVerificationRuntime<
  TState,
  TObservation,
  TPending,
  TCommand,
  TAgentState
> {
  domainAdapter: SocialDomainAdapterManifest;
  createEnvironment(initialState: TState): SocialEnvironment<TState, TObservation, TPending, TCommand>;
  hashState: (state: TState) => string;
  hashMessages: (messages: SocialMessage[]) => string;
  eventSeq?: (state: TState) => number;
  validateRecordedStep: SocialRecordedStepValidator<TState, TObservation, TPending, TCommand>;
  recordedAgentState: SocialRecordedAgentStateValidationPolicy<TState, TObservation, TPending, TCommand, TAgentState>;
}

export interface HarnessEpisodeArtifactVerificationResult<TState> {
  ok: boolean;
  validationMode: "validate" | "none" | "invalid";
  structureErrors: string[];
  configurationErrors: string[];
  replay?: SocialEpisodeReplayResult<TState>;
  mismatches: string[];
}

/**
 * Strong, model-free acceptance boundary for a canonical generic episode
 * artifact. Structural validation remains separately available for parsers and
 * migrations, but persistence/fork/evaluation authorities should use this
 * verifier before accepting a domain artifact as replayable truth.
 */
export function verifyHarnessEpisodeArtifact<
  TState,
  TObservation,
  TPending,
  TCommand,
  TAgentState,
  TForkProvenance extends import("./episodeArtifacts").GenericForkProvenance | undefined
>(options: {
  artifact: HarnessEpisodeArtifactEnvelope<TState, TObservation, TPending, TCommand, TAgentState, TForkProvenance>;
  runtime: SocialArtifactVerificationRuntime<TState, TObservation, TPending, TCommand, TAgentState>;
}): HarnessEpisodeArtifactVerificationResult<TState> {
  const structureErrors = validateHarnessEpisodeArtifactEnvelope(options.artifact);
  const configurationErrors: string[] = [];
  const runtimeRecord = options.runtime && typeof options.runtime === "object"
    ? options.runtime as unknown as Record<string, unknown>
    : {};
  const policyRecord = runtimeRecord.recordedAgentState && typeof runtimeRecord.recordedAgentState === "object"
    ? runtimeRecord.recordedAgentState as Record<string, unknown>
    : undefined;
  const validationMode = policyRecord?.mode === "validate" || policyRecord?.mode === "none"
    ? policyRecord.mode
    : "invalid";
  for (const field of ["createEnvironment", "hashState", "hashMessages", "validateRecordedStep"] as const) {
    if (typeof runtimeRecord[field] !== "function") {
      configurationErrors.push(`${field} must be a function.`);
    }
  }
  if (runtimeRecord.eventSeq !== undefined && typeof runtimeRecord.eventSeq !== "function") {
    configurationErrors.push("eventSeq must be a function when provided.");
  }
  if (!policyRecord || validationMode === "invalid") {
    configurationErrors.push("recordedAgentState must declare mode=validate or mode=none.");
  } else if (validationMode === "validate" && typeof policyRecord.validator !== "function") {
    configurationErrors.push("recordedAgentState.validator must be a function in validate mode.");
  }
  if (!options.artifact.socialEpisode.domainAdapter) {
    configurationErrors.push("artifact socialEpisode.domainAdapter is required for canonical verification.");
  }
  configurationErrors.push(
    ...validateSocialDomainAdapterManifest(runtimeRecord.domainAdapter, "verification runtime adapter")
  );
  for (const mismatch of compareSocialDomainAdapterManifests(
    options.artifact.socialEpisode.domainAdapter,
    runtimeRecord.domainAdapter as SocialDomainAdapterManifest | undefined,
    { recordedPath: "artifact domain adapter", runtimePath: "verification runtime adapter" }
  )) {
    configurationErrors.push(`domain adapter binding: ${mismatch}`);
  }
  const hasRecordedAgentState =
    options.artifact.agents.length > 0 ||
    Boolean(options.artifact.agentSnapshotFrames?.length) ||
    options.artifact.socialEpisode.steps.some(
      (step) =>
        step.actorSnapshotsAfterStep !== undefined ||
        step.actorSnapshotsHashAfterStep !== undefined ||
        step.actorSnapshotFrameIdAfterStep !== undefined
    );
  if (validationMode === "none" && policyRecord) {
    if (typeof policyRecord.reason !== "string" || !policyRecord.reason.trim()) {
      configurationErrors.push("recordedAgentState.mode=none requires a nonempty reason.");
    }
    if (hasRecordedAgentState) {
      configurationErrors.push(
        "recordedAgentState.mode=none is not allowed because the artifact records durable actor state."
      );
    }
  }
  if (validationMode === "validate") {
    structureErrors.push(...committedActorSnapshotBoundaryErrors(options.artifact));
  }
  if (structureErrors.length || configurationErrors.length) {
    return {
      ok: false,
      validationMode,
      structureErrors,
      configurationErrors,
      mismatches: [
        ...structureErrors.map((error) => `Artifact structure: ${error}`),
        ...configurationErrors.map((error) => `Artifact verification configuration: ${error}`)
      ]
    };
  }

  let environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  try {
    environment = options.runtime.createEnvironment(structuredClone(options.artifact.initialState));
  } catch {
    const message = "Artifact verification environment factory failed.";
    return {
      ok: false,
      validationMode,
      structureErrors,
      configurationErrors: [message],
      mismatches: [`Artifact verification configuration: ${message}`]
    };
  }
  const replay = replaySocialEpisode<TState, TObservation, TPending, TCommand, TAgentState>({
    episode: structuredClone(options.artifact.socialEpisode),
    environment,
    hashState: options.runtime.hashState,
    hashMessages: options.runtime.hashMessages,
    eventSeq: options.runtime.eventSeq,
    agentSnapshotFrames: options.artifact.agentSnapshotFrames
      ? structuredClone(options.artifact.agentSnapshotFrames)
      : undefined,
    validateRecordedStep: options.runtime.validateRecordedStep,
    validateRecordedAgentState:
      validationMode === "validate"
        ? (policyRecord!.validator as SocialRecordedAgentStateValidator<TState, TObservation, TPending, TCommand, TAgentState>)
        : undefined,
    domainAdapter: options.runtime.domainAdapter
  });
  return {
    ok: replay.ok,
    validationMode,
    structureErrors,
    configurationErrors,
    replay,
    mismatches: [...replay.mismatches]
  };
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
  /** Optional domain-owned binding of recorded action evidence to replay state. */
  validateRecordedStep?: SocialRecordedStepValidator<TState, TObservation, TPending, TCommand>;
  /**
   * Optional domain-owned semantic audit of receipt-gated durable agent state.
   * This augments structural snapshot/hash validation; it does not rerun an
   * agent or infer a belief from language.
   */
  validateRecordedAgentState?: SocialRecordedAgentStateValidator<TState, TObservation, TPending, TCommand, TAgentState>;
  /** Required when replaying an artifact that recorded adapter provenance. */
  domainAdapter?: SocialDomainAdapterManifest;
}): SocialEpisodeReplayResult<TState> {
  const { episode } = options;
  const mismatches: string[] = [];
  const stopOnMismatch = options.stopOnMismatch ?? true;
  const initialMessageCount = episode.execution?.initialMessageCount ?? 0;
  const initialMessages = episode.messages.slice(0, initialMessageCount);
  const bus = new SocialCommunicationBus(episode.channels, initialMessages, {
    runtimeActorIds: episode.runtimeActorIds
  });
  let replayedSteps = 0;
  let replayedBatches = 0;
  let rejectedSteps = 0;
  let previousAgentSnapshots: TAgentState[] | undefined;

  // This happens before the first environment snapshot/step. An environment
  // supplied by the caller must not get a chance to reinterpret a trajectory
  // bound to another domain adapter implementation.
  for (const mismatch of compareSocialDomainAdapterManifests(episode.domainAdapter, options.domainAdapter)) {
    mismatches.push(`Domain adapter binding: ${mismatch}`);
  }
  if (mismatches.length) return finalizeReplay();

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
    validateRecordedStepEvidence(step, index, [step]);
    if (stopOnMismatch && mismatches.length) return;

    const stateBefore = options.environment.snapshot();
    const beforeEventSeq = options.eventSeq?.(stateBefore);
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
    validateCommittedOutcome([step], index, stateBefore, beforeEventSeq, beforeMessageSeq);
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
    for (const [offset, step] of batch.entries()) {
      validateRecordedStepEvidence(step, startIndex + offset, batch);
    }
    if (stopOnMismatch && mismatches.length) return;
    if (!isParallelEnvironment(options.environment)) {
      addMismatch(`Native parallel batch ${batch[0]?.batchId ?? "unknown"}: environment does not implement stepBatch().`);
      return;
    }
    const stateBefore = options.environment.snapshot();
    const beforeEventSeq = options.eventSeq?.(stateBefore);
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
    validateCommittedOutcome(batch, startIndex, stateBefore, beforeEventSeq, beforeMessageSeq, { parallel: true });
  }

  function validateCommittedOutcome(
    steps: Array<SocialHarnessStep<TObservation, TPending, TCommand>>,
    startIndex: number,
    stateBefore: TState,
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
    validateRecordedAgentStateBoundary(steps, startIndex, stateBefore, afterState);
  }

  function addMismatch(message: string): void {
    mismatches.push(message);
  }

  function validateRecordedStepEvidence(
    step: SocialHarnessStep<TObservation, TPending, TCommand>,
    index: number,
    batch: readonly SocialHarnessStep<TObservation, TPending, TCommand>[]
  ): void {
    if (!options.validateRecordedStep) return;
    let errors: readonly string[];
    try {
      const result = options.validateRecordedStep(structuredClone(step), {
        index,
        state: structuredClone(options.environment.snapshot()),
        pendingActions: structuredClone(options.environment.pendingActions()),
        schedulerMode: step.schedulerMode,
        batch: structuredClone(batch)
      });
      if (!Array.isArray(result) || result.some((error) => typeof error !== "string")) {
        addMismatch(`Native step ${index} ${step.traceId}: recorded pending/action validator returned an invalid result.`);
        return;
      }
      errors = result;
    } catch {
      addMismatch(`Native step ${index} ${step.traceId}: recorded pending/action validator failed.`);
      return;
    }
    for (const error of errors) addMismatch(`Native step ${index} ${step.traceId}: recorded pending/action evidence mismatch: ${error}`);
  }

  function validateRecordedAgentStateBoundary(
    batch: Array<SocialHarnessStep<TObservation, TPending, TCommand>>,
    startIndex: number,
    stateBefore: TState,
    stateAfter: TState
  ): void {
    if (!options.validateRecordedAgentState) return;
    const stepIndex = startIndex + batch.length - 1;
    const boundaryStep = batch.at(-1);
    if (!boundaryStep) return;
    const recordedAgents = resolveRecordedAgentSnapshot(boundaryStep);
    if (!recordedAgents) return;
    const prefixSteps = structuredClone(episode.steps.slice(0, stepIndex + 1));
    const committedMessages = bus.listMessages();
    const episodePrefix = {
      steps: prefixSteps,
      messages: committedMessages,
      channels: structuredClone(episode.channels),
      runtimeActorIds: structuredClone(episode.runtimeActorIds)
    } satisfies Pick<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>, "steps" | "messages" | "channels" | "runtimeActorIds">;
    const recordedBatch = prefixSteps.slice(startIndex, stepIndex + 1);
    const step = recordedBatch.at(-1);
    if (!step) return;
    const actorIds = new Set([
      ...(episode.runtimeActorIds ?? []),
      ...episode.profiles.map((profile) => profile.id),
      ...prefixSteps.map((candidate) => candidate.actorId)
    ]);
    const visibleMessagesByActor = Object.fromEntries(
      [...actorIds]
        .filter((actorId) => actorId !== "system")
        .sort()
        .map((actorId) => [actorId, bus.observe(actorId).messages])
    ) as Record<string, readonly SocialMessage[]>;
    const scopedExposureRecords = deriveSocialExposureRecords(episodePrefix, { includeSelf: true });
    let errors: readonly string[];
    try {
      const result = options.validateRecordedAgentState({
        episodePrefix: structuredClone(episodePrefix),
        step: structuredClone(step),
        stepIndex,
        batch: structuredClone(recordedBatch),
        priorAgents: previousAgentSnapshots ? structuredClone(previousAgentSnapshots) : undefined,
        recordedAgents: structuredClone(recordedAgents),
        stateBefore: structuredClone(stateBefore),
        stateAfter: structuredClone(stateAfter),
        committedMessages: structuredClone(committedMessages),
        scopedExposureRecords: structuredClone(scopedExposureRecords),
        visibleMessagesByActor: structuredClone(visibleMessagesByActor)
      });
      if (!Array.isArray(result) || result.some((error) => typeof error !== "string")) {
        addMismatch(`Recorded agent state semantic audit at native step ${stepIndex} ${step.traceId}: validator returned an invalid result.`);
        return;
      }
      errors = result;
    } catch {
      addMismatch(`Recorded agent state semantic audit at native step ${stepIndex} ${step.traceId}: validator failed.`);
      return;
    }
    for (const error of errors) {
      addMismatch(`Recorded agent state semantic audit at native step ${stepIndex} ${step.traceId}: ${error}`);
    }
    previousAgentSnapshots = structuredClone(recordedAgents);
  }

  function resolveRecordedAgentSnapshot(step: SocialHarnessStep<TObservation, TPending, TCommand>): TAgentState[] | undefined {
    if (Array.isArray(step.actorSnapshotsAfterStep) && typeof step.actorSnapshotsHashAfterStep === "string") {
      return structuredClone(step.actorSnapshotsAfterStep as TAgentState[]);
    }
    if (!options.agentSnapshotFrames) return undefined;
    const resolved = resolveHarnessAgentSnapshotFrame({ frames: options.agentSnapshotFrames, step });
    return resolved ? resolved.agents : undefined;
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

/**
 * Canonical state-bearing artifacts must provide one resolvable durable actor
 * snapshot for every completed receipt boundary. A joint parallel transition
 * is one boundary, while environment-owned system transitions are not actor
 * receipts and therefore do not manufacture actor-state evidence.
 */
function committedActorSnapshotBoundaryErrors<
  TState,
  TObservation,
  TPending,
  TCommand,
  TAgentState,
  TForkProvenance extends import("./episodeArtifacts").GenericForkProvenance | undefined
>(
  artifact: HarnessEpisodeArtifactEnvelope<TState, TObservation, TPending, TCommand, TAgentState, TForkProvenance>
): string[] {
  const errors: string[] = [];
  const steps = artifact.socialEpisode.steps;
  for (let index = 0; index < steps.length; ) {
    const first = steps[index];
    if (!first) break;
    const batch = isSocialParallelJointStep(first) ? contiguousParallelBatch(steps, index) : [first];
    const boundary = batch.at(-1)!;
    const isCommittedActorReceipt =
      batch.every((step) => isSocialStepCommitted(step)) &&
      batch.some((step) => step.actorId !== "system" && step.resolutionPolicy !== "system-transition");
    if (isCommittedActorReceipt) {
      const hasInlineSnapshot =
        Array.isArray(boundary.actorSnapshotsAfterStep) &&
        typeof boundary.actorSnapshotsHashAfterStep === "string";
      const hasResolvedFrame = Boolean(
        artifact.agentSnapshotFrames &&
        resolveHarnessAgentSnapshotFrame({ frames: artifact.agentSnapshotFrames, step: boundary })
      );
      if (!hasInlineSnapshot && !hasResolvedFrame) {
        errors.push(
          `Native step ${index + batch.length - 1} ${boundary.traceId}: committed actor receipt boundary is missing a resolvable durable actor snapshot.`
        );
      }
    }
    index += batch.length;
  }
  return errors;
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
