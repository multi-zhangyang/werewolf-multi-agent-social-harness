import { cloneJson } from "./valueUtils";
import { type SocialDecision } from "./decisions";
import { providerFailureFromError, safeProviderFailureMessage } from "../providerFailure";
import { type SocialAction, SocialActionOwnershipError, SocialActionValidationError, type SocialActor, type SocialActorStepReceipt, type SocialAfterEnvironmentStepContext, type SocialAfterEnvironmentStepHook, type SocialEnvironment, type SocialEnvironmentRollbackEvidence, type SocialHarnessStep, type SocialParallelEnvironment, SocialPreflightMutationError, type SocialResolvedSchedulerMode, type SocialSchedulerMode, type SocialSchedulerResolver, type SocialStepFailureEvidence, type SocialStepFeedback, type SocialStepResult } from "./contracts";
export function baseStep<TObservation, TPending, TCommand>(input: {
  optionsId: string;
  decision: Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }>;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  decisionStateHash?: string;
}): Omit<SocialHarnessStep<TObservation, TPending, TCommand>, "action"> {
  return {
    traceId: input.decision.action.traceId ?? `${input.optionsId}:social:${input.turnIndex}:${input.decision.actorId}`,
    turnIndex: input.turnIndex,
    batchId: input.batchId,
    batchIndex: input.batchIndex,
    batchSize: input.batchSize,
    actorId: input.decision.actorId,
    profileId: input.decision.actor.profile.id,
    schedulerMode: input.schedulerMode,
    atomic: false,
    resolutionPolicy: input.schedulerMode === "aec-batched-decision" ? "sequential-apply-from-shared-decision-state" : "sequential-apply",
    pendingAction: cloneJson(input.decision.pending),
    observation: cloneJson(input.decision.observation),
    ...(input.decision.reasonerCalls?.length
      ? { reasonerCalls: cloneJson(input.decision.reasonerCalls) }
      : {}),
    decisionStateHash: input.decisionStateHash
  };
}

function failedDecisionToStep<TObservation, TPending, TCommand>(input: {
  optionsId: string;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  decisionStateHash?: string;
  preStateHash?: string;
  postStateHash?: string;
  eventSeqRange?: [number, number];
  failure: SocialStepFailureEvidence;
  decision: Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: false }>;
}): SocialHarnessStep<TObservation, TPending, TCommand> {
  return {
    traceId: input.decision.traceId ?? `${input.optionsId}:social:${input.turnIndex}:${input.decision.actorId}`,
    turnIndex: input.turnIndex,
    batchId: input.batchId,
    batchIndex: input.batchIndex,
    batchSize: input.batchSize,
    actorId: input.decision.actorId,
    profileId: input.decision.actor?.profile.id ?? input.decision.actorId,
    schedulerMode: input.schedulerMode,
    atomic: input.schedulerMode === "parallel",
    resolutionPolicy:
      input.schedulerMode === "parallel"
        ? "parallel-stepBatch"
        : input.schedulerMode === "aec-batched-decision"
          ? "sequential-apply-from-shared-decision-state"
          : "sequential-apply",
    pendingAction: cloneJson(input.decision.pending),
    observation: cloneJson(input.decision.observation as TObservation),
    action: { actorId: input.decision.actorId, kind: "error", command: undefined as TCommand },
    ...(input.decision.reasonerCalls?.length
      ? { reasonerCalls: cloneJson(input.decision.reasonerCalls) }
      : {}),
    commitStatus: "rejected",
    decisionStateHash: input.decisionStateHash,
    preStateHash: input.preStateHash,
    postStateHash: input.postStateHash,
    eventSeqRange: input.eventSeqRange,
    error: input.decision.error,
    failure: cloneJson(input.failure)
  };
}

/**
 * Scheduler/input failures happen before any actor observes or decides. Keep
 * them as explicit rejected native records so the artifact explains why the
 * runner made no environment call without pretending a joint action existed.
 */
export function schedulerFailureStep<TObservation, TPending, TCommand>(input: {
  optionsId: string;
  traceId?: string;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  pendingAction: TPending;
  decisionStateHash?: string;
  preStateHash?: string;
  postStateHash?: string;
  failure: SocialStepFailureEvidence;
}): SocialHarnessStep<TObservation, TPending, TCommand> {
  return {
    traceId: input.traceId ?? `${input.optionsId}:scheduler:${input.batchIndex}:rejected`,
    turnIndex: input.turnIndex,
    batchId: input.batchId,
    batchIndex: input.batchIndex,
    batchSize: input.batchSize,
    actorId: "system",
    profileId: "system",
    schedulerMode: input.schedulerMode,
    atomic: false,
    resolutionPolicy: "scheduler-validation",
    pendingAction: cloneJson(input.pendingAction),
    observation: undefined as unknown as TObservation,
    action: { actorId: "system", kind: "scheduler.error", command: undefined as TCommand },
    commitStatus: "rejected",
    decisionStateHash: input.decisionStateHash,
    preStateHash: input.preStateHash,
    postStateHash: input.postStateHash,
    error: input.failure.message,
    failure: cloneJson(input.failure)
  };
}

/**
 * AEC batched collection is concurrent only while agents form proposals. If
 * the batch is abandoned before a proposal is applied, record every affected
 * proposal as rejected so receipts and native evidence remain symmetric.
 */
export function rejectedSequentialDecisionBatchSteps<TObservation, TPending, TCommand>(input: {
  optionsId: string;
  decisions: ReadonlyArray<SocialDecision<TObservation, TPending, TCommand>>;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: Exclude<SocialResolvedSchedulerMode, "parallel">;
  decisionStateHash?: string;
  preStateHash?: string;
  postStateHash?: string;
  eventSeqRange?: [number, number];
  failureForDecision: (decision: SocialDecision<TObservation, TPending, TCommand>) => SocialStepFailureEvidence;
}): Array<SocialHarnessStep<TObservation, TPending, TCommand>> {
  return input.decisions.map((decision) => {
    const failure = input.failureForDecision(decision);
    if (!decision.ok) {
      return failedDecisionToStep({
        optionsId: input.optionsId,
        turnIndex: decision.turnIndex,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        schedulerMode: input.schedulerMode,
        decisionStateHash: input.decisionStateHash,
        preStateHash: input.preStateHash,
        postStateHash: input.postStateHash,
        eventSeqRange: input.eventSeqRange,
        failure,
        decision
      });
    }

    return {
      ...baseStep({
        optionsId: input.optionsId,
        decision,
        turnIndex: decision.turnIndex,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        schedulerMode: input.schedulerMode,
        decisionStateHash: input.decisionStateHash
      }),
      action: cloneJson(decision.action),
      commitStatus: "rejected",
      preStateHash: input.preStateHash,
      postStateHash: input.postStateHash,
      eventSeqRange: input.eventSeqRange,
      error: failure.message,
      failure: cloneJson(failure)
    };
  });
}

export function rejectedParallelDecisionBatchSteps<TObservation, TPending, TCommand>(input: {
  optionsId: string;
  decisions: ReadonlyArray<SocialDecision<TObservation, TPending, TCommand>>;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  decisionStateHash?: string;
  preStateHash?: string;
  postStateHash?: string;
  eventSeqRange?: [number, number];
  failureForDecision: (decision: SocialDecision<TObservation, TPending, TCommand>) => SocialStepFailureEvidence;
}): Array<SocialHarnessStep<TObservation, TPending, TCommand>> {
  return input.decisions.map((decision) => {
    const failure = input.failureForDecision(decision);
    if (!decision.ok) {
      return failedDecisionToStep({
        optionsId: input.optionsId,
        turnIndex: decision.turnIndex,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        schedulerMode: "parallel",
        decisionStateHash: input.decisionStateHash,
        preStateHash: input.preStateHash,
        postStateHash: input.postStateHash,
        eventSeqRange: input.eventSeqRange,
        failure,
        decision
      });
    }

    return {
      ...baseStep({
        optionsId: input.optionsId,
        decision,
        turnIndex: decision.turnIndex,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        schedulerMode: "parallel",
        decisionStateHash: input.decisionStateHash
      }),
      action: cloneJson(decision.action),
      commitStatus: "rejected",
      atomic: true,
      resolutionPolicy: "parallel-stepBatch",
      preStateHash: input.preStateHash,
      postStateHash: input.postStateHash,
      eventSeqRange: input.eventSeqRange,
      error: failure.message,
      failure: cloneJson(failure)
    };
  });
}

export function defaultFailureEvidence(stage: string, error: unknown): SocialStepFailureEvidence {
  const validation = error instanceof SocialActionValidationError ? error.result : undefined;
  return {
    stage,
    message: safeSocialFailureMessage(error),
    causeName: error instanceof Error ? error.name : undefined,
    metadata: validation
      ? {
          code: validation.code,
          ...(validation.metadata ?? {})
        }
      : undefined
  };
}

export function safeSocialFailureMessage(error: unknown): string {
  if (providerFailureFromError(error)) {
    return safeProviderFailureMessage(error, "Model provider execution failed before a social action could be committed.");
  }
  return error instanceof Error ? error.message : String(error);
}

export function failureStageForError(error: unknown, fallback: string): string {
  if (error instanceof SocialActionValidationError) return "environment_validation";
  if (error instanceof SocialActionOwnershipError) return "action_ownership";
  return fallback;
}

interface EnvironmentRollbackResult<TState> {
  state: TState;
  stateHash?: string;
  eventSeq?: number;
  evidence: SocialEnvironmentRollbackEvidence;
}

export function attemptEnvironmentRollback<TState, TObservation, TPending, TCommand>(input: {
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  preState: TState;
  failureState: TState;
  hashState?: (state: TState) => string;
  eventSeq?: (state: TState) => number;
  preStateHash?: string;
  beforeEventSeq?: number;
}): EnvironmentRollbackResult<TState> {
  const mutationDetected = fingerprintState(input.preState) !== fingerprintState(input.failureState);
  if (!mutationDetected) {
    return {
      state: input.failureState,
      stateHash: input.hashState?.(input.failureState),
      eventSeq: input.eventSeq?.(input.failureState),
      evidence: { mutationDetected: false, attempted: false, succeeded: false }
    };
  }
  if (!input.environment.restore) {
    return {
      state: input.failureState,
      stateHash: input.hashState?.(input.failureState),
      eventSeq: input.eventSeq?.(input.failureState),
      evidence: { mutationDetected: true, attempted: false, succeeded: false }
    };
  }

  let restoreThrew = false;
  try {
    input.environment.restore(cloneJson(input.preState));
  } catch {
    restoreThrew = true;
  }
  const state = input.environment.snapshot();
  const stateHash = input.hashState?.(state);
  const eventSeq = input.eventSeq?.(state);
  let failureCode: SocialEnvironmentRollbackEvidence["failureCode"];
  if (restoreThrew) failureCode = "restore_threw";
  else if (fingerprintState(state) !== fingerprintState(input.preState)) failureCode = "state_mismatch";
  else if (input.preStateHash !== undefined && stateHash !== input.preStateHash) failureCode = "hash_mismatch";
  else if (input.beforeEventSeq !== undefined && eventSeq !== input.beforeEventSeq) failureCode = "event_sequence_mismatch";
  return {
    state,
    stateHash,
    eventSeq,
    evidence: {
      mutationDetected: true,
      attempted: true,
      succeeded: failureCode === undefined,
      ...(failureCode ? { failureCode } : {})
    }
  };
}

export function environmentFailureEvidence(input: {
  error: unknown;
  fallbackStage: string;
  adapterFailure?: SocialStepFailureEvidence;
  environmentStepStarted: boolean;
  preStateHash?: string;
  failureStateHash?: string;
  rollback: SocialEnvironmentRollbackEvidence;
}): SocialStepFailureEvidence {
  const base = input.adapterFailure ?? defaultFailureEvidence(input.fallbackStage, input.error);
  if (input.rollback.mutationDetected && input.rollback.succeeded) {
    return {
      ...base,
      metadata: {
        ...(base.metadata ? cloneJson(base.metadata) : {}),
        rollbackAttempted: true,
        rollbackSucceeded: true,
        ...(input.error instanceof SocialPreflightMutationError ? {
          preflightBeforeFingerprint: input.error.beforeFingerprint,
          preflightAfterFingerprint: input.error.afterFingerprint
        } : {})
      }
    };
  }
  if (input.error instanceof SocialPreflightMutationError || input.rollback.mutationDetected) {
    return {
      stage: "environment_non_atomic_failure",
      message: input.error instanceof SocialPreflightMutationError
        ? "Environment validateAction() mutated domain state; the failure is not replayable."
        : "Environment transition threw after mutating domain state; the failure is not replayable.",
      causeName: input.error instanceof Error ? input.error.name : base.causeName,
      metadata: {
        originalStage: base.stage,
        rollbackAttempted: input.rollback.attempted,
        rollbackSucceeded: false,
        ...(input.rollback.failureCode ? { rollbackFailureCode: input.rollback.failureCode } : {}),
        ...(input.error instanceof SocialPreflightMutationError ? {
          preflightBeforeFingerprint: input.error.beforeFingerprint,
          preflightAfterFingerprint: input.error.afterFingerprint
        } : {}),
        ...(input.preStateHash !== undefined ? { preStateHash: input.preStateHash } : {}),
        ...(input.failureStateHash !== undefined ? { failureStateHash: input.failureStateHash } : {}),
        ...(base.metadata ? { originalMetadata: cloneJson(base.metadata) } : {})
      }
    };
  }
  return base;
}

export function invokeAfterEnvironmentStep<TState, TObservation, TPending, TCommand>(
  hook: SocialAfterEnvironmentStepHook<TState, TObservation, TPending, TCommand> | undefined,
  context: SocialAfterEnvironmentStepContext<TState, TObservation, TPending, TCommand>
): SocialStepFailureEvidence | undefined {
  if (!hook) return undefined;
  try {
    hook(context);
    return undefined;
  } catch (error) {
    return defaultFailureEvidence("after_environment_step", error);
  }
}

export function combineStepFailureEvidence(
  ...failures: Array<SocialStepFailureEvidence | undefined>
): SocialStepFailureEvidence | undefined {
  const present = failures.filter((failure): failure is SocialStepFailureEvidence => failure !== undefined);
  if (!present.length) return undefined;
  if (present.length === 1) return present[0];
  return {
    stage: "post_commit_feedback",
    message: present.map((failure) => `${failure.stage}: ${failure.message}`).join("; "),
    metadata: {
      failures: present.map((failure) => ({
        stage: failure.stage,
        message: failure.message,
        ...(failure.causeName ? { causeName: failure.causeName } : {})
      }))
    }
  };
}

export function assertSocialActionValid<TState, TObservation, TPending, TCommand>(
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>,
  command: TCommand,
  pending: TPending
): void {
  if (!environment.validateAction) return;
  const beforeFingerprint = fingerprintState(environment.snapshot());
  const result = environment.validateAction(cloneJson(command), cloneJson(pending));
  const afterFingerprint = fingerprintState(environment.snapshot());
  if (beforeFingerprint !== afterFingerprint) {
    throw new SocialPreflightMutationError(beforeFingerprint, afterFingerprint);
  }
  if (!result.valid) throw new SocialActionValidationError(result);
}

function fingerprintState(value: unknown): string {
  return JSON.stringify(normalizeForFingerprint(value));
}

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForFingerprint);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForFingerprint(record[key])])
    );
  }
  return value;
}

export function assertSocialActionOwnership<TCommand>(action: SocialAction<TCommand>, expectedActorId: string): void {
  if (action.actorId !== expectedActorId) {
    throw new SocialActionOwnershipError(
      `Scheduled actor ${expectedActorId} returned an action owned by ${action.actorId}.`
    );
  }
  for (const [index, message] of (action.messages ?? []).entries()) {
    if (message.senderId !== expectedActorId) {
      throw new SocialActionOwnershipError(
        `Scheduled actor ${expectedActorId} returned message draft ${index} with sender ${message.senderId}.`
      );
    }
  }
}

export function assertParallelActorIdsUnique<TObservation, TPending, TCommand>(
  decisions: Array<Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }>>
): void {
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.actorId)) {
      throw new SocialActionOwnershipError(
        `Parallel batch contains multiple decisions for scheduled actor ${decision.actorId}.`
      );
    }
    seen.add(decision.actorId);
  }
}

export function deliverActorStepReceipt<TObservation, TPending, TCommand>(
  actor: SocialActor<TObservation, TPending, TCommand>,
  receipt: SocialActorStepReceipt<TObservation, TPending, TCommand>
): SocialStepFailureEvidence | undefined {
  if (!actor.onStepResult) return undefined;
  try {
    // Actor feedback is advisory lifecycle input, never a mutable handle to
    // the runner-owned proposed action that will be serialized in the native
    // artifact. Give each actor an isolated serializable receipt.
    actor.onStepResult(cloneJson(receipt));
    return undefined;
  } catch (error) {
    return defaultFailureEvidence("actor_step_feedback", error);
  }
}

export function feedbackFields<TState, TObservation>(feedback: SocialStepFeedback<TState, TObservation>): Pick<
  SocialHarnessStep<TObservation>,
  | "rewardsByAgent"
  | "terminationsByAgent"
  | "truncationsByAgent"
  | "doneByAgent"
  | "infosByAgent"
  | "episodeTerminated"
  | "episodeTruncated"
  | "terminationReason"
  | "truncationReason"
> {
  return {
    rewardsByAgent: cloneJson(feedback.rewardsByAgent),
    terminationsByAgent: cloneJson(feedback.terminationsByAgent),
    truncationsByAgent: cloneJson(feedback.truncationsByAgent),
    doneByAgent: doneByAgent(feedback),
    infosByAgent: cloneJson(feedback.infosByAgent),
    episodeTerminated: feedback.episodeTerminated,
    episodeTruncated: feedback.episodeTruncated,
    terminationReason: feedback.terminationReason,
    truncationReason: feedback.truncationReason
  };
}

export function eventSeqRange(before: number | undefined, after: number | undefined): [number, number] | undefined {
  if (typeof before !== "number" || typeof after !== "number") return undefined;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return undefined;
  if (after <= before) return undefined;
  return [before + 1, after];
}

export function normalizeStepFeedback<TState, TObservation>(
  result: SocialStepResult<TState, TObservation>,
  environment: SocialEnvironment<TState, TObservation>
): SocialStepFeedback<TState, TObservation> {
  if (isStepFeedback<TState, TObservation>(result)) return cloneJson(result);
  return emptyStepFeedback(result, environment);
}

export function emptyStepFeedback<TState, TObservation>(
  state: TState,
  environment: SocialEnvironment<TState, TObservation>
): SocialStepFeedback<TState, TObservation> {
  return {
    state: cloneJson(state),
    observationsByAgent: {},
    rewardsByAgent: {},
    terminationsByAgent: {},
    truncationsByAgent: {},
    infosByAgent: {},
    episodeTerminated: environment.done(),
    episodeTruncated: false
  };
}

function isStepFeedback<TState, TObservation>(value: SocialStepResult<TState, TObservation>): value is SocialStepFeedback<TState, TObservation> {
  if (value === null || typeof value !== "object") return false;
  return "state" in value && "rewardsByAgent" in value && "terminationsByAgent" in value && "truncationsByAgent" in value;
}

function doneByAgent<TState, TObservation>(feedback: SocialStepFeedback<TState, TObservation>): Record<string, boolean> {
  const agentIds = new Set([...Object.keys(feedback.terminationsByAgent), ...Object.keys(feedback.truncationsByAgent)]);
  return Object.fromEntries([...agentIds].map((agentId) => [agentId, Boolean(feedback.terminationsByAgent[agentId] || feedback.truncationsByAgent[agentId])]));
}

export function isParallelEnvironment<TState, TObservation, TPending, TCommand>(
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>
): environment is SocialParallelEnvironment<TState, TObservation, TPending, TCommand> {
  return typeof (environment as Partial<SocialParallelEnvironment<TState, TObservation, TPending, TCommand>>).stepBatch === "function";
}

export function normalizeSchedulerMode(mode: SocialSchedulerMode): SocialResolvedSchedulerMode {
  if (mode === "simultaneous-batch") return "aec-batched-decision";
  return mode;
}

export function resolveSchedulerMode<TState, TPending>(input: {
  optionsId: string;
  state: TState;
  pendingActions: TPending[];
  turnIndex: number;
  batchIndex: number;
  defaultSchedulerMode: SocialResolvedSchedulerMode;
  schedulerModeForBatch?: SocialSchedulerResolver<TState, TPending>;
}): SocialResolvedSchedulerMode {
  const selected = input.schedulerModeForBatch?.({
    id: input.optionsId,
    state: cloneJson(input.state),
    pendingActions: cloneJson(input.pendingActions),
    turnIndex: input.turnIndex,
    batchIndex: input.batchIndex,
    defaultSchedulerMode: input.defaultSchedulerMode
  });
  return normalizeSchedulerMode(selected ?? input.defaultSchedulerMode);
}

export function selectPendingBatch<TPending>(pending: TPending[], schedulerMode: SocialResolvedSchedulerMode): TPending[] {
  if (schedulerMode === "aec-batched-decision" || schedulerMode === "parallel") return pending;
  return pending.slice(0, 1);
}

export function findDuplicatePendingActorId<TPending extends { actorId?: string }>(pendingBatch: readonly TPending[]): string | undefined {
  const actorIds = new Set<string>();
  for (const pending of pendingBatch) {
    const actorId = pending.actorId;
    if (!actorId) continue;
    if (actorIds.has(actorId)) return actorId;
    actorIds.add(actorId);
  }
  return undefined;
}
