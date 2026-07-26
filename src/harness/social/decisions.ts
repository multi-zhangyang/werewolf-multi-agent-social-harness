import { cloneJson } from "./valueUtils";
import { deliverActorStepReceipt, safeSocialFailureMessage } from "./stepOutcomes";
import { validateReasonerCallReport } from "./artifactValidation";
import { SocialCommunicationBus } from "./messaging";
import { type NormalizedSocialExecutionLimits, SOCIAL_REASONER_CALL_EVIDENCE_VERSION, type SocialAction, type SocialActor, type SocialActorTurnIndexProvider, type SocialDecisionFailureStage, type SocialEnvironment, type SocialExecutionLimits, type SocialObservationAssembler, type SocialReasonerCallEvidence, type SocialReasonerCallReport, type SocialResolvedSchedulerMode, type SocialStepFailureEvidence, type SocialTraceIdProvider, type SocialTraceIdProviderContext } from "./contracts";
export type SocialDecision<TObservation, TPending, TCommand> =
  | {
      ok: true;
      actor: SocialActor<TObservation, TPending, TCommand>;
      actorId: string;
      pending: TPending;
      observation: TObservation;
      action: SocialAction<TCommand>;
      reasonerCalls?: SocialReasonerCallEvidence[];
      pendingIndex: number;
      turnIndex: number;
      transactionId: string;
    }
  | {
      ok: false;
      actor?: SocialActor<TObservation, TPending, TCommand>;
      actorId: string;
      pending: TPending;
      observation?: TObservation;
      pendingIndex: number;
      turnIndex: number;
      traceId?: string;
      transactionId?: string;
      actorTurnIndex?: number;
      failureStage: SocialDecisionFailureStage;
      error: string;
      rawError: unknown;
      reasonerCalls?: SocialReasonerCallEvidence[];
    };

export function isSuccessfulDecision<TObservation, TPending, TCommand>(
  decision: SocialDecision<TObservation, TPending, TCommand>
): decision is Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }> {
  return decision.ok;
}

interface NativeTraceIdentityFailure {
  pendingIndex: number;
  message: string;
}

/**
 * Native trace IDs bind committed/rejected execution records, snapshot frames,
 * replay evidence, and social exposure. A policy may provide an action trace
 * for evidence, but it may not reuse a previously-recorded native identity.
 * Check every collected decision before preflight/message publication or any
 * environment transition so collisions are fail-closed and mutation-free.
 */
export function findNativeTraceIdentityFailure<TObservation, TPending, TCommand>(
  decisions: readonly SocialDecision<TObservation, TPending, TCommand>[],
  usedNativeTraceIds: ReadonlySet<string>,
  optionsId: string
): NativeTraceIdentityFailure | undefined {
  const batchTraceOwners = new Map<string, number>();
  for (const decision of decisions) {
    const traceId = decision.ok
      ? decision.action.traceId
      : decision.traceId ?? `${optionsId}:social:${decision.turnIndex}:${decision.actorId}`;
    if (!traceId?.trim()) {
      return {
        pendingIndex: decision.pendingIndex,
        message: `Runner ${optionsId} received a missing native traceId for pending decision ${decision.pendingIndex + 1}.`
      };
    }
    const priorPendingIndex = batchTraceOwners.get(traceId);
    if (priorPendingIndex !== undefined) {
      return {
        pendingIndex: decision.pendingIndex,
        message: `Runner ${optionsId} received duplicate native traceId ${traceId} for pending decisions ${priorPendingIndex + 1} and ${decision.pendingIndex + 1}.`
      };
    }
    if (usedNativeTraceIds.has(traceId)) {
      return {
        pendingIndex: decision.pendingIndex,
        message: `Runner ${optionsId} received native traceId ${traceId} that was already recorded by an earlier native step.`
      };
    }
    batchTraceOwners.set(traceId, decision.pendingIndex);
  }
  return undefined;
}

/** Reserve a trace only for a runner-owned system/scheduler record. */
export function allocateRunnerTraceId(usedNativeTraceIds: ReadonlySet<string>, baseTraceId: string): string {
  if (!usedNativeTraceIds.has(baseTraceId)) return baseTraceId;
  let suffix = 2;
  let traceId = `${baseTraceId}:runner:${suffix}`;
  while (usedNativeTraceIds.has(traceId)) {
    suffix += 1;
    traceId = `${baseTraceId}:runner:${suffix}`;
  }
  return traceId;
}

/**
 * A batch can be abandoned after actors have observed and reasoned but before
 * their commands reach the environment. Tell each affected actor explicitly
 * so staged private/social state is discarded rather than becoming a hidden
 * side effect of an uncommitted proposal.
 */
export function rejectUncommittedDecisions<TObservation, TPending, TCommand>(
  decisions: readonly SocialDecision<TObservation, TPending, TCommand>[],
  failure: SocialStepFailureEvidence | ((decision: SocialDecision<TObservation, TPending, TCommand>) => SocialStepFailureEvidence),
  options: { receiptTraceId?: string } = {}
): void {
  for (const decision of decisions) {
    if (!decision.actor) continue;
    const resolvedFailure = typeof failure === "function" ? failure(decision) : failure;
    const proposedTraceId = decision.ok
      ? decision.action.traceId ?? `social:${decision.turnIndex}:${decision.actorId}`
      : decision.traceId ?? `social:${decision.turnIndex}:${decision.actorId}`;
    const traceId = options.receiptTraceId ?? proposedTraceId;
    deliverActorStepReceipt(decision.actor, {
      id: `${decision.transactionId ?? traceId}:rejected`,
      status: "rejected",
      traceId,
      transactionId: decision.transactionId,
      turnIndex: decision.turnIndex,
      actorId: decision.actorId,
      pendingAction: cloneJson(decision.pending),
      action: decision.ok ? cloneJson(decision.action) : undefined,
      failure: cloneJson(resolvedFailure)
    });
  }
}

export async function collectDecision<TState, TObservation, TPending extends { actorId?: string }, TCommand>(input: {
  optionsId: string;
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  actorById: Map<string, SocialActor<TObservation, TPending, TCommand>>;
  bus: SocialCommunicationBus;
  pending: TPending;
  pendingIndex: number;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  assembleObservation?: SocialObservationAssembler<TObservation, TPending>;
  traceIdForDecision?: SocialTraceIdProvider<TState, TPending>;
  actorTurnIndexForDecision?: SocialActorTurnIndexProvider<TState, TPending>;
  executionLimits: NormalizedSocialExecutionLimits;
}): Promise<SocialDecision<TObservation, TPending, TCommand>> {
  const actorId = input.pending.actorId;
  if (!actorId) {
    const error = new Error("Social pending action must expose actorId.");
    return {
      ok: false,
      actorId: "unknown",
      pending: input.pending,
      pendingIndex: input.pendingIndex,
      turnIndex: input.turnIndex,
      failureStage: "pending_actor_resolution",
      error: error.message,
      rawError: error
    };
  }
  const actor = input.actorById.get(actorId);
  if (!actor) {
    const error = new Error(`Missing social actor ${actorId}.`);
    return {
      ok: false,
      actorId,
      pending: input.pending,
      pendingIndex: input.pendingIndex,
      turnIndex: input.turnIndex,
      failureStage: "actor_lookup",
      error: error.message,
      rawError: error
    };
  }
  const transactionId = `${input.batchId}:transaction:${input.pendingIndex}:${input.turnIndex}:${actorId}`;
  let observation: TObservation | undefined;
  let traceId: string | undefined;
  let actorTurnIndex: number | undefined;
  let failureStage: SocialDecisionFailureStage = "decision_identity";
  let decisionStarted = false;
  try {
    const stateBeforeObserve = input.environment.snapshot();
    const decisionIdentityContext: SocialTraceIdProviderContext<TState, TPending> = {
      id: input.optionsId,
      state: cloneJson(stateBeforeObserve),
      pendingAction: cloneJson(input.pending),
      actorId,
      turnIndex: input.turnIndex,
      batchId: input.batchId,
      batchIndex: input.batchIndex,
      batchSize: input.batchSize,
      schedulerMode: input.schedulerMode
    };
    actorTurnIndex = input.actorTurnIndexForDecision?.(cloneJson(decisionIdentityContext));
    traceId = input.traceIdForDecision?.(cloneJson({
      ...decisionIdentityContext,
      actorTurnIndex
    })) ?? `${input.optionsId}:social:${input.turnIndex}:${actorId}`;
    failureStage = "environment_observe";
    const environmentObservation = cloneJson(input.environment.observe(actorId, cloneJson(input.pending)));
    const visibleSocial = cloneJson(input.bus.observe(actorId));
    failureStage = "observation_assembly";
    const assembledObservation = input.assembleObservation
      ? input.assembleObservation({
          agentId: actorId,
          pendingAction: cloneJson(input.pending),
          environmentObservation: cloneJson(environmentObservation),
          visibleSocial: cloneJson(visibleSocial)
        })
      : environmentObservation;
    observation = cloneJson(assembledObservation);
    failureStage = "actor_observe";
    actor.observe(cloneJson(observation), {
      traceId,
      transactionId,
      transactional: true,
      turnIndex: input.turnIndex,
      actorTurnIndex,
      batchId: input.batchId,
      batchIndex: input.batchIndex,
      batchSize: input.batchSize,
      schedulerMode: input.schedulerMode,
      pendingAction: cloneJson(input.pending)
    });
    failureStage = "actor_decide";
    decisionStarted = true;
    const action = cloneJson(await awaitActorDecisionWithinExecutionLimits(
      () => actor.decide(cloneJson(input.pending)),
      input.executionLimits
    ));
    const actionWithTraceId = action.traceId ? action : { ...action, traceId };
    const reasonerCalls = takeRunnerBoundReasonerCalls({
      actor,
      transactionId,
      traceId: actionWithTraceId.traceId!,
      turnIndex: input.turnIndex
    });
    return {
      ok: true,
      actor,
      actorId,
      pending: input.pending,
      observation,
      action: actionWithTraceId,
      ...(reasonerCalls.length ? { reasonerCalls } : {}),
      pendingIndex: input.pendingIndex,
      turnIndex: input.turnIndex,
      transactionId
    };
  } catch (error) {
    if (error instanceof SocialExecutionLimitError) failureStage = error.failureStage;
    let reasonerCalls: SocialReasonerCallEvidence[] = [];
    if (decisionStarted) {
      try {
        reasonerCalls = takeRunnerBoundReasonerCalls({
          actor,
          transactionId,
          traceId: traceId ?? `${input.optionsId}:social:${input.turnIndex}:${actorId}`,
          turnIndex: input.turnIndex
        });
      } catch (evidenceError) {
        return {
          ok: false,
          actor,
          actorId,
          pending: input.pending,
          observation,
          pendingIndex: input.pendingIndex,
          turnIndex: input.turnIndex,
          traceId,
          transactionId,
          actorTurnIndex,
          failureStage: "actor_decide",
          error: safeSocialFailureMessage(evidenceError),
          rawError: evidenceError
        };
      }
      // A harness timeout/abort proves only that the decision budget ended.
      // If the actor has not supplied a transaction-bound report, the runner
      // does not know whether a provider request started or whether a stream
      // was enabled. Keep that uncertainty in the native step's control-plane
      // failure evidence instead of fabricating a provider call lifecycle.
    }
    return {
      ok: false,
      actor,
      actorId,
      pending: input.pending,
      observation,
      pendingIndex: input.pendingIndex,
      turnIndex: input.turnIndex,
      traceId,
      transactionId,
      actorTurnIndex,
      failureStage,
      error: safeSocialFailureMessage(error),
      rawError: error,
      ...(reasonerCalls.length ? { reasonerCalls } : {})
    };
  }
}

function takeRunnerBoundReasonerCalls<TObservation, TPending, TCommand>(input: {
  actor: SocialActor<TObservation, TPending, TCommand>;
  transactionId: string;
  traceId: string;
  turnIndex: number;
}): SocialReasonerCallEvidence[] {
  const reports = input.actor.takeReasonerCallReports?.({
    transactionId: input.transactionId,
    traceId: input.traceId,
    turnIndex: input.turnIndex
  }) ?? [];
  if (!Array.isArray(reports)) throw new Error("Social actor reasoner call reports must be an array.");
  return reports.map((report, index) => bindReasonerCallReport({
    report,
    callIndex: index,
    traceId: input.traceId,
    actorId: input.actor.id,
    profileId: input.actor.profile.id,
    model: input.actor.profile.model
  }));
}

function bindReasonerCallReport(input: {
  report: SocialReasonerCallReport;
  callIndex: number;
  traceId: string;
  actorId: string;
  profileId: string;
  model: string;
}): SocialReasonerCallEvidence {
  const errors = validateReasonerCallReport(input.report, "reasoner call report");
  if (errors.length) throw new Error(`Invalid social actor reasoner call report: ${errors.join(" ")}`);
  return {
    schemaVersion: SOCIAL_REASONER_CALL_EVIDENCE_VERSION,
    callId: `${input.traceId}:reasoner-call:${input.callIndex + 1}`,
    traceId: input.traceId,
    actorId: input.actorId,
    profileId: input.profileId,
    model: input.model,
    ...cloneJson(input.report)
  };
}

/** A controlled runner failure which deliberately never incorporates an
 * external abort reason into persisted execution evidence. */
export class SocialExecutionLimitError extends Error {
  constructor(
    readonly failureStage: Extract<SocialDecisionFailureStage, "execution_abort" | "decision_timeout">,
    readonly timeoutMs?: number
  ) {
    super(
      failureStage === "decision_timeout"
        ? `Social actor decision exceeded the configured ${timeoutMs}ms execution budget.`
        : "Social actor decision was aborted by the harness execution control plane."
    );
    this.name = "SocialExecutionLimitError";
  }
}

export function normalizeSocialExecutionLimits(limits: SocialExecutionLimits | undefined): NormalizedSocialExecutionLimits {
  if (!limits) return {};
  if (
    limits.decisionTimeoutMs !== undefined &&
    (!Number.isInteger(limits.decisionTimeoutMs) || limits.decisionTimeoutMs <= 0)
  ) {
    throw new Error("Social execution decisionTimeoutMs must be a positive integer when provided.");
  }
  return {
    ...(limits.abortSignal ? { abortSignal: limits.abortSignal } : {}),
    ...(limits.decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs: limits.decisionTimeoutMs })
  };
}

/**
 * Bound arbitrary actor decisions without making a provider client the
 * scheduler authority. The underlying actor promise is still observed by the
 * race, so a late rejection cannot become an unhandled rejection; it simply
 * has no path back to the already-rejected scheduler transaction.
 */
async function awaitActorDecisionWithinExecutionLimits<T>(
  decide: () => Promise<T> | T,
  limits: NormalizedSocialExecutionLimits
): Promise<T> {
  if (limits.abortSignal?.aborted) throw new SocialExecutionLimitError("execution_abort");

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const contenders: Array<Promise<T>> = [Promise.resolve().then(decide)];

  if (limits.abortSignal) {
    contenders.push(
      new Promise<T>((_resolve, reject) => {
        onAbort = () => reject(new SocialExecutionLimitError("execution_abort"));
        limits.abortSignal?.addEventListener("abort", onAbort, { once: true });
      })
    );
  }
  if (limits.decisionTimeoutMs !== undefined) {
    contenders.push(
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new SocialExecutionLimitError("decision_timeout", limits.decisionTimeoutMs)),
          limits.decisionTimeoutMs
        );
      })
    );
  }

  try {
    return await Promise.race(contenders);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) limits.abortSignal?.removeEventListener("abort", onAbort);
  }
}
