import { cloneJson } from "./valueUtils";
import { type SocialDecision } from "./decisions";
import { assertParallelActorIdsUnique, assertSocialActionOwnership, assertSocialActionValid, attemptEnvironmentRollback, baseStep, combineStepFailureEvidence, defaultFailureEvidence, deliverActorStepReceipt, emptyStepFeedback, environmentFailureEvidence, eventSeqRange, failureStageForError, feedbackFields, invokeAfterEnvironmentStep, normalizeStepFeedback } from "./stepOutcomes";
import { SocialCommunicationBus } from "./messaging";
import { type SocialAfterEnvironmentStepHook, type SocialEnvironment, type SocialEnvironmentStepFailureHook, type SocialHarnessStep, type SocialParallelEnvironment, type SocialResolvedSchedulerMode, type SocialStepFailureEvidence, type SocialStepFeedback, type SocialSystemTransition, type SocialSystemTransitionProvider } from "./contracts";
export function applyOptionalSystemTransition<TState, TObservation, TPending extends { actorId?: string }, TCommand>(input: {
  optionsId: string;
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  bus: SocialCommunicationBus;
  turnIndex: number;
  batchIndex: number;
  schedulerMode: SocialResolvedSchedulerMode;
  hashState?: (state: TState) => string;
  eventSeq?: (state: TState) => number;
  afterEnvironmentStep?: SocialAfterEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
  systemTransition?: SocialSystemTransitionProvider<TState, TObservation, TPending, TCommand>;
  traceId: string;
}):
  | {
      status: "ok" | "failed";
      step: SocialHarnessStep<TObservation, TPending, TCommand>;
      feedback: SocialStepFeedback<TState, TObservation>;
      reason?: string;
    }
  | undefined {
  if (!input.systemTransition) return undefined;
  const preState = input.environment.snapshot();
  let transition: SocialSystemTransition<TObservation, TPending, TCommand> | undefined | null;
  try {
    transition = input.systemTransition({
      state: cloneJson(preState),
      turnIndex: input.turnIndex,
      schedulerMode: input.schedulerMode
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const feedback = emptyStepFeedback(input.environment.snapshot(), input.environment);
    const actorId = "system";
    return {
      status: "failed",
      reason,
      feedback,
      step: {
        traceId: input.traceId,
        turnIndex: input.turnIndex,
        batchId: `${input.optionsId}:system:${input.batchIndex}`,
        batchIndex: 1,
        batchSize: 1,
        actorId,
        profileId: actorId,
        schedulerMode: input.schedulerMode,
        atomic: false,
        resolutionPolicy: "system-transition",
        pendingAction: undefined as unknown as TPending,
        observation: undefined as unknown as TObservation,
        action: { actorId, kind: "system.error", command: undefined as TCommand },
        commitStatus: "rejected",
        decisionStateHash: input.hashState?.(preState),
        preStateHash: input.hashState?.(preState),
        error: reason,
        failure: defaultFailureEvidence("system_transition_resolution", error)
      }
    };
  }
  if (!transition) return undefined;
  const actorId = transition.actorId ?? transition.action.actorId;
  const profileId = transition.profileId ?? actorId;
  const batchId = `${input.optionsId}:system:${input.batchIndex}`;
  const preStateHash = input.hashState?.(preState);
  const beforeEventSeq = input.eventSeq?.(preState);
  const beforeSeq = input.bus.listMessages().at(-1)?.seq ?? 0;
  const action = cloneJson({ ...transition.action, traceId: input.traceId });
  const messages = action.messages ?? [];
  const base = {
    traceId: input.traceId,
    turnIndex: input.turnIndex,
    batchId,
    batchIndex: 1,
    batchSize: 1,
    actorId,
    profileId,
    schedulerMode: input.schedulerMode,
    atomic: false,
    resolutionPolicy: "system-transition",
    pendingAction: cloneJson(transition.pendingAction),
    observation: cloneJson(transition.observation),
    action: cloneJson(action),
    decisionStateHash: preStateHash,
    preStateHash
  } satisfies SocialHarnessStep<TObservation, TPending, TCommand>;
  let environmentStepStarted = false;
  let environmentCommitted = false;
  let feedback: SocialStepFeedback<TState, TObservation> | undefined;
  try {
    assertSocialActionOwnership(action, actorId);
    assertSocialActionValid(input.environment, action.command, transition.pendingAction);
    input.bus.validateMessages(cloneJson(messages));
    environmentStepStarted = true;
    const result = input.environment.step(cloneJson(action.command));
    environmentCommitted = true;
    feedback = normalizeStepFeedback(result, input.environment);
    input.bus.publishMany(cloneJson(messages));
    const afterEventSeq = input.eventSeq?.(feedback.state);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;
    const postStateHash = input.hashState?.(feedback.state);
    const committedEventSeqRange = eventSeqRange(beforeEventSeq, afterEventSeq);
    const committedMessageSeqRange = afterSeq > beforeSeq ? ([beforeSeq + 1, afterSeq] as [number, number]) : undefined;
    const afterEnvironmentFailure = invokeAfterEnvironmentStep(input.afterEnvironmentStep, {
      actor: undefined,
      actorId,
      profileId,
      turnIndex: input.turnIndex,
      batchId,
      batchIndex: 1,
      batchSize: 1,
      schedulerMode: input.schedulerMode,
      atomic: false,
      resolutionPolicy: "system-transition",
      pendingAction: cloneJson(transition.pendingAction),
      observation: cloneJson(transition.observation),
      action: cloneJson(action),
      preState: cloneJson(preState),
      preStateHash,
      decisionStateHash: preStateHash,
      feedback: cloneJson(feedback),
      postStateHash,
      eventSeqRange: committedEventSeqRange,
      messageSeqRange: committedMessageSeqRange
    });
    return {
      status: afterEnvironmentFailure ? "failed" : "ok",
      reason: afterEnvironmentFailure?.message,
      feedback,
      step: {
        ...base,
        commitStatus: "committed",
        postStateHash,
        eventSeqRange: committedEventSeqRange,
        messageSeqRange: committedMessageSeqRange,
        error: afterEnvironmentFailure?.message,
        failure: afterEnvironmentFailure,
        ...feedbackFields(feedback)
      }
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failureState = input.environment.snapshot();
    const failureStateHash = input.hashState?.(failureState);
    const afterEventSeq = input.eventSeq?.(failureState);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;
    if (environmentCommitted) {
      const committedFeedback = feedback ?? emptyStepFeedback(failureState, input.environment);
      const failure = defaultFailureEvidence("post_commit_failure", error);
      return {
        status: "failed",
        reason: failure.message,
        feedback: committedFeedback,
        step: {
          ...base,
          commitStatus: "committed",
          postStateHash: failureStateHash,
          eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
          messageSeqRange: afterSeq > beforeSeq ? [beforeSeq + 1, afterSeq] : undefined,
          error: failure.message,
          failure,
          ...feedbackFields(committedFeedback)
        }
      };
    }
    const rollback = attemptEnvironmentRollback({
      environment: input.environment,
      preState,
      failureState,
      hashState: input.hashState,
      eventSeq: input.eventSeq,
      preStateHash,
      beforeEventSeq
    });
    const rejectedFeedback = emptyStepFeedback(rollback.state, input.environment);
    const failure = environmentFailureEvidence({
      error,
      fallbackStage: failureStageForError(error, "system_environment_step"),
      environmentStepStarted,
      preStateHash,
      failureStateHash,
      rollback: rollback.evidence
    });
    return {
      status: "failed",
      reason,
      feedback: rejectedFeedback,
      step: {
        ...base,
        commitStatus: "rejected",
        postStateHash: rollback.stateHash,
        eventSeqRange: rollback.evidence.succeeded ? undefined : eventSeqRange(beforeEventSeq, rollback.eventSeq),
        error: reason,
        failure
      }
    };
  }
}

export function applySequentialDecision<TState, TObservation, TPending extends { actorId?: string }, TCommand>(input: {
  optionsId: string;
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  bus: SocialCommunicationBus;
  decision: Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }>;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
	  decisionStateHash?: string;
	  hashState?: (state: TState) => string;
	  eventSeq?: (state: TState) => number;
	  afterEnvironmentStep?: SocialAfterEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
	  onEnvironmentStepFailure?: SocialEnvironmentStepFailureHook<TState, TObservation, TPending, TCommand>;
	}): {
  status: "ok" | "failed";
  step: SocialHarnessStep<TObservation, TPending, TCommand>;
  feedback: SocialStepFeedback<TState, TObservation>;
  reason?: string;
} {
  const preState = input.environment.snapshot();
  const beforeEventSeq = input.eventSeq?.(preState);
  const beforeSeq = input.bus.listMessages().at(-1)?.seq ?? 0;
  const messages = input.decision.action.messages ?? [];
  const stepBase = baseStep(input);
  const preStateHash = input.hashState?.(preState);
  let environmentStepStarted = false;
  let environmentCommitted = false;
  let feedback: SocialStepFeedback<TState, TObservation> | undefined;
  let actorReceiptDelivered = false;
  try {
    assertSocialActionOwnership(input.decision.action, input.decision.actorId);
    assertSocialActionValid(input.environment, input.decision.action.command, input.decision.pending);
    input.bus.validateMessages(cloneJson(messages));
    environmentStepStarted = true;
    const result = input.environment.step(cloneJson(input.decision.action.command));
    environmentCommitted = true;
    feedback = normalizeStepFeedback(result, input.environment);
    input.bus.publishMany(cloneJson(messages));
    const afterEventSeq = input.eventSeq?.(feedback.state);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;
    const postStateHash = input.hashState?.(feedback.state);
    const committedEventSeqRange = eventSeqRange(beforeEventSeq, afterEventSeq);
    const committedMessageSeqRange = afterSeq > beforeSeq ? ([beforeSeq + 1, afterSeq] as [number, number]) : undefined;
    const actorFeedbackFailure = deliverActorStepReceipt(input.decision.actor, {
      id: `${stepBase.traceId}:committed`,
      status: "committed",
      traceId: stepBase.traceId,
      transactionId: input.decision.transactionId,
      turnIndex: stepBase.turnIndex,
      actorId: stepBase.actorId,
      pendingAction: cloneJson(input.decision.pending),
      action: input.decision.action,
      observation: cloneJson(feedback.observationsByAgent[stepBase.actorId]),
      reward: feedback.rewardsByAgent[stepBase.actorId],
      terminated: feedback.terminationsByAgent[stepBase.actorId],
      truncated: feedback.truncationsByAgent[stepBase.actorId],
      info: cloneJson(feedback.infosByAgent[stepBase.actorId]),
      postStateHash,
      eventSeqRange: committedEventSeqRange,
      messageSeqRange: committedMessageSeqRange
    });
    actorReceiptDelivered = true;
    const afterEnvironmentFailure = invokeAfterEnvironmentStep(input.afterEnvironmentStep, {
      actor: input.decision.actor,
      actorId: stepBase.actorId,
      profileId: stepBase.profileId,
      turnIndex: stepBase.turnIndex,
      batchId: input.batchId,
      batchIndex: input.batchIndex,
      batchSize: input.batchSize,
      schedulerMode: stepBase.schedulerMode,
      atomic: false,
      resolutionPolicy: stepBase.resolutionPolicy ?? "sequential-apply",
      pendingAction: cloneJson(input.decision.pending),
      observation: cloneJson(input.decision.observation),
      action: cloneJson(input.decision.action),
      preState: cloneJson(preState),
      preStateHash,
      decisionStateHash: input.decisionStateHash,
      feedback: cloneJson(feedback),
      postStateHash,
      eventSeqRange: committedEventSeqRange,
      messageSeqRange: committedMessageSeqRange
    });
    const postCommitFailure = combineStepFailureEvidence(actorFeedbackFailure, afterEnvironmentFailure);
    return {
      status: postCommitFailure ? "failed" : "ok",
      reason: postCommitFailure?.message,
      feedback,
      step: {
        ...stepBase,
        action: cloneJson(input.decision.action),
        commitStatus: "committed",
        receiptObservation: cloneJson(feedback.observationsByAgent[stepBase.actorId]),
        preStateHash,
        postStateHash,
        eventSeqRange: committedEventSeqRange,
        messageSeqRange: committedMessageSeqRange,
        error: postCommitFailure?.message,
        failure: postCommitFailure,
        ...feedbackFields(feedback)
      }
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failureState = input.environment.snapshot();
    const failureStateHash = input.hashState?.(failureState);
    const afterEventSeq = input.eventSeq?.(failureState);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;

    // An environment return is the commit boundary. Errors from feedback
    // normalization, bus publication, or post-step observers must not rewrite
    // a committed domain transition as a rejected proposal.
    if (environmentCommitted) {
      const committedFeedback = feedback ?? emptyStepFeedback(failureState, input.environment);
      const committedEventSeqRange = eventSeqRange(beforeEventSeq, afterEventSeq);
      const committedMessageSeqRange = afterSeq > beforeSeq ? ([beforeSeq + 1, afterSeq] as [number, number]) : undefined;
      const postCommitFailure = defaultFailureEvidence("post_commit_failure", error);
      const receiptFailure = actorReceiptDelivered
        ? undefined
        : deliverActorStepReceipt(input.decision.actor, {
            id: `${stepBase.traceId}:committed`,
            status: "committed",
            traceId: stepBase.traceId,
            transactionId: input.decision.transactionId,
            turnIndex: stepBase.turnIndex,
            actorId: stepBase.actorId,
            pendingAction: cloneJson(input.decision.pending),
            action: input.decision.action,
            observation: cloneJson(committedFeedback.observationsByAgent[stepBase.actorId]),
            reward: committedFeedback.rewardsByAgent[stepBase.actorId],
            terminated: committedFeedback.terminationsByAgent[stepBase.actorId],
            truncated: committedFeedback.truncationsByAgent[stepBase.actorId],
            info: cloneJson(committedFeedback.infosByAgent[stepBase.actorId]),
            postStateHash: failureStateHash,
            eventSeqRange: committedEventSeqRange,
            messageSeqRange: committedMessageSeqRange
          });
      const failure = combineStepFailureEvidence(postCommitFailure, receiptFailure) ?? postCommitFailure;
      return {
        status: "failed",
        reason: failure.message,
        feedback: committedFeedback,
        step: {
          ...stepBase,
          action: cloneJson(input.decision.action),
          commitStatus: "committed",
          receiptObservation: cloneJson(committedFeedback.observationsByAgent[stepBase.actorId]),
          preStateHash,
          postStateHash: failureStateHash,
          eventSeqRange: committedEventSeqRange,
          messageSeqRange: committedMessageSeqRange,
          error: failure.message,
          failure,
          ...feedbackFields(committedFeedback)
        }
      };
    }

    const failureStateBeforeHook = failureState;
    const rollback = attemptEnvironmentRollback({
      environment: input.environment,
      preState,
      failureState,
      hashState: input.hashState,
      eventSeq: input.eventSeq,
      preStateHash,
      beforeEventSeq
    });
    const adapterFailure = input.onEnvironmentStepFailure?.({
      actor: input.decision.actor,
	      actorId: stepBase.actorId,
	      profileId: stepBase.profileId,
	      turnIndex: stepBase.turnIndex,
	      batchId: input.batchId,
	      batchIndex: input.batchIndex,
	      batchSize: input.batchSize,
	      schedulerMode: stepBase.schedulerMode,
	      atomic: false,
	      resolutionPolicy: stepBase.resolutionPolicy ?? "sequential-apply",
      pendingAction: cloneJson(input.decision.pending),
      observation: cloneJson(input.decision.observation),
      action: cloneJson(input.decision.action),
      preState: cloneJson(preState),
      preStateHash,
      decisionStateHash: input.decisionStateHash,
      failureState: cloneJson(failureStateBeforeHook),
      failureStateHash,
      effectiveState: cloneJson(rollback.state),
      effectiveStateHash: rollback.stateHash,
      rollback: cloneJson(rollback.evidence),
      error
    }) ?? undefined;
    const rejectedFeedback = emptyStepFeedback(rollback.state, input.environment);
    const failure = environmentFailureEvidence({
      error,
      fallbackStage: failureStageForError(error, "environment_step"),
      adapterFailure,
      environmentStepStarted,
      preStateHash,
      failureStateHash,
      rollback: rollback.evidence
    });
    const rejectedEventSeqRange = rollback.evidence.succeeded
      ? undefined
      : eventSeqRange(beforeEventSeq, rollback.eventSeq);
    const receiptFailure = deliverActorStepReceipt(input.decision.actor, {
	      id: `${stepBase.traceId}:rejected`,
	      status: "rejected",
	      traceId: stepBase.traceId,
      transactionId: input.decision.transactionId,
	      turnIndex: stepBase.turnIndex,
	      actorId: stepBase.actorId,
      pendingAction: cloneJson(input.decision.pending),
      action: input.decision.action,
      postStateHash: rollback.stateHash,
      eventSeqRange: rejectedEventSeqRange,
      failure
    });
    return {
      status: "failed",
      reason,
      feedback: rejectedFeedback,
      step: {
        ...stepBase,
        action: cloneJson(input.decision.action),
        commitStatus: "rejected",
        preStateHash,
        postStateHash: rollback.stateHash,
        eventSeqRange: rejectedEventSeqRange,
        error: reason,
        failure: receiptFailure ?? failure
	      }
    };
  }
}

export function applyParallelBatch<TState, TObservation, TPending extends { actorId?: string }, TCommand>(input: {
  optionsId: string;
  environment: SocialParallelEnvironment<TState, TObservation, TPending, TCommand>;
  bus: SocialCommunicationBus;
  decisions: Array<Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }>>;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
	  decisionStateHash?: string;
	  hashState?: (state: TState) => string;
	  eventSeq?: (state: TState) => number;
	  afterEnvironmentStep?: SocialAfterEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
	  onEnvironmentStepFailure?: SocialEnvironmentStepFailureHook<TState, TObservation, TPending, TCommand>;
	}): {
  status: "ok" | "failed";
  steps: Array<SocialHarnessStep<TObservation, TPending, TCommand>>;
  feedback: SocialStepFeedback<TState, TObservation>;
  reason?: string;
} {
  const preState = input.environment.snapshot();
  const beforeEventSeq = input.eventSeq?.(preState);
  const beforeSeq = input.bus.listMessages().at(-1)?.seq ?? 0;
  const messages = input.decisions.flatMap((decision) => decision.action.messages ?? []);
  const preStateHash = input.hashState?.(preState);
  const messageSeqRangeByActor = new Map<string, [number, number] | undefined>();
  const receiptDeliveredByActor = new Set<string>();
  let environmentStepStarted = false;
  let environmentCommitted = false;
  let feedback: SocialStepFeedback<TState, TObservation> | undefined;
  try {
    for (const decision of input.decisions) {
      assertSocialActionOwnership(decision.action, decision.actorId);
      assertSocialActionValid(input.environment, decision.action.command, decision.pending);
    }
    assertParallelActorIdsUnique(input.decisions);
    input.bus.validateMessages(cloneJson(messages));
    const commandsByAgent = Object.fromEntries(
      input.decisions.map((decision) => [decision.actorId, cloneJson(decision.action.command)])
    );
    environmentStepStarted = true;
    const result = input.environment.stepBatch(cloneJson(commandsByAgent));
    environmentCommitted = true;
    feedback = normalizeStepFeedback(result, input.environment);
    // Publish in decision order and retain per-actor seq ranges so integrity can
    // attribute message metadata.traceId to the owning step in a joint batch.
    for (const decision of input.decisions) {
      const actorMessages = decision.action.messages ?? [];
      if (!actorMessages.length) {
        messageSeqRangeByActor.set(decision.actorId, undefined);
        continue;
      }
      const published = input.bus.publishMany(cloneJson(actorMessages));
      const firstSeq = published[0]?.seq;
      const lastSeq = published.at(-1)?.seq;
      messageSeqRangeByActor.set(
        decision.actorId,
        firstSeq !== undefined && lastSeq !== undefined ? [firstSeq, lastSeq] : undefined
      );
    }
    const afterEventSeq = input.eventSeq?.(feedback.state);
    const postStateHash = input.hashState?.(feedback.state);
    const committedEventSeqRange = eventSeqRange(beforeEventSeq, afterEventSeq);
    const receiptFailures = new Map<string, SocialStepFailureEvidence>();
    for (const [index, decision] of input.decisions.entries()) {
      const stepBase = baseStep({ ...input, decision, turnIndex: input.turnIndex + index });
      const committedMessageSeqRange = messageSeqRangeByActor.get(decision.actorId);
      const failure = deliverActorStepReceipt(decision.actor, {
        id: `${stepBase.traceId}:committed`,
        status: "committed",
        traceId: stepBase.traceId,
        transactionId: decision.transactionId,
        turnIndex: stepBase.turnIndex,
        actorId: stepBase.actorId,
        pendingAction: cloneJson(decision.pending),
        action: decision.action,
        observation: cloneJson(feedback.observationsByAgent[stepBase.actorId]),
        reward: feedback.rewardsByAgent[stepBase.actorId],
        terminated: feedback.terminationsByAgent[stepBase.actorId],
        truncated: feedback.truncationsByAgent[stepBase.actorId],
        info: cloneJson(feedback.infosByAgent[stepBase.actorId]),
        postStateHash,
        eventSeqRange: committedEventSeqRange,
        messageSeqRange: committedMessageSeqRange
      });
      receiptDeliveredByActor.add(stepBase.actorId);
      if (failure) receiptFailures.set(stepBase.actorId, failure);
    }

    // Agent-private state is part of the committed joint outcome. Run snapshot
    // hooks only after every actor has processed its receipt, so all records
    // taken for this batch describe the same post-commit agent state.
    const actorFeedbackFailures = new Map<string, SocialStepFailureEvidence>();
    for (const [index, decision] of input.decisions.entries()) {
      const stepBase = baseStep({ ...input, decision, turnIndex: input.turnIndex + index });
      const committedMessageSeqRange = messageSeqRangeByActor.get(decision.actorId);
      const afterEnvironmentFailure = invokeAfterEnvironmentStep(input.afterEnvironmentStep, {
        actor: decision.actor,
        actorId: stepBase.actorId,
        profileId: stepBase.profileId,
        turnIndex: stepBase.turnIndex,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        schedulerMode: stepBase.schedulerMode,
        atomic: true,
        resolutionPolicy: "parallel-stepBatch",
        pendingAction: cloneJson(decision.pending),
        observation: cloneJson(decision.observation),
        action: cloneJson(decision.action),
        preState: cloneJson(preState),
        preStateHash,
        decisionStateHash: input.decisionStateHash,
        feedback: cloneJson(feedback),
        postStateHash,
        eventSeqRange: committedEventSeqRange,
        messageSeqRange: committedMessageSeqRange
      });
      const postCommitFailure = combineStepFailureEvidence(receiptFailures.get(stepBase.actorId), afterEnvironmentFailure);
      if (postCommitFailure) actorFeedbackFailures.set(stepBase.actorId, postCommitFailure);
    }
    const firstActorFeedbackFailure = actorFeedbackFailures.values().next().value as SocialStepFailureEvidence | undefined;
    return {
      status: firstActorFeedbackFailure ? "failed" : "ok",
      reason: firstActorFeedbackFailure?.message,
      feedback,
      steps: input.decisions.map((decision, index) => {
        const feedbackFailure = actorFeedbackFailures.get(decision.actorId);
        return {
          ...baseStep({ ...input, decision, turnIndex: input.turnIndex + index }),
          action: cloneJson(decision.action),
          commitStatus: "committed" as const,
          receiptObservation: cloneJson(feedback!.observationsByAgent[decision.actorId]),
          atomic: true,
          resolutionPolicy: "parallel-stepBatch",
          preStateHash,
          postStateHash,
          eventSeqRange: committedEventSeqRange,
          messageSeqRange: messageSeqRangeByActor.get(decision.actorId),
          error: feedbackFailure?.message,
          failure: feedbackFailure,
          ...feedbackFields(feedback!)
        };
      })
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failureState = input.environment.snapshot();
    const failureStateHash = input.hashState?.(failureState);
    const afterEventSeq = input.eventSeq?.(failureState);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;

    if (environmentCommitted) {
      const committedFeedback = feedback ?? emptyStepFeedback(failureState, input.environment);
      const committedEventSeqRange = eventSeqRange(beforeEventSeq, afterEventSeq);
      const committedFailures = new Map<string, SocialStepFailureEvidence>();
      for (const [index, decision] of input.decisions.entries()) {
        const stepBase = baseStep({ ...input, decision, turnIndex: input.turnIndex + index });
        const postCommitFailure = defaultFailureEvidence("post_commit_failure", error);
        const receiptFailure = receiptDeliveredByActor.has(stepBase.actorId)
          ? undefined
          : deliverActorStepReceipt(decision.actor, {
              id: `${stepBase.traceId}:committed`,
              status: "committed",
              traceId: stepBase.traceId,
              transactionId: decision.transactionId,
              turnIndex: stepBase.turnIndex,
              actorId: stepBase.actorId,
              pendingAction: cloneJson(decision.pending),
              action: decision.action,
              observation: cloneJson(committedFeedback.observationsByAgent[stepBase.actorId]),
              reward: committedFeedback.rewardsByAgent[stepBase.actorId],
              terminated: committedFeedback.terminationsByAgent[stepBase.actorId],
              truncated: committedFeedback.truncationsByAgent[stepBase.actorId],
              info: cloneJson(committedFeedback.infosByAgent[stepBase.actorId]),
              postStateHash: failureStateHash,
              eventSeqRange: committedEventSeqRange,
              messageSeqRange: messageSeqRangeByActor.get(stepBase.actorId)
            });
        committedFailures.set(
          stepBase.actorId,
          combineStepFailureEvidence(postCommitFailure, receiptFailure) ?? postCommitFailure
        );
      }
      const failure = committedFailures.values().next().value as SocialStepFailureEvidence;
      return {
        status: "failed",
        reason: failure.message,
        feedback: committedFeedback,
        steps: input.decisions.map((decision, index) => ({
          ...baseStep({ ...input, decision, turnIndex: input.turnIndex + index }),
          action: cloneJson(decision.action),
          commitStatus: "committed" as const,
          receiptObservation: cloneJson(committedFeedback.observationsByAgent[decision.actorId]),
          atomic: true,
          resolutionPolicy: "parallel-stepBatch",
          preStateHash,
          postStateHash: failureStateHash,
          eventSeqRange: committedEventSeqRange,
          messageSeqRange: messageSeqRangeByActor.get(decision.actorId),
          error: committedFailures.get(decision.actorId)?.message,
          failure: committedFailures.get(decision.actorId),
          ...feedbackFields(committedFeedback)
        }))
      };
    }

    const failureStateBeforeHook = failureState;
    const rollback = attemptEnvironmentRollback({
      environment: input.environment,
      preState,
      failureState,
      hashState: input.hashState,
      eventSeq: input.eventSeq,
      preStateHash,
      beforeEventSeq
    });
    const parallelFailures = new Map<string, SocialStepFailureEvidence>();
    for (const [index, decision] of input.decisions.entries()) {
	      const stepBase = baseStep({ ...input, decision, turnIndex: input.turnIndex + index });
      const adapterFailure = input.onEnvironmentStepFailure?.({
	        actor: decision.actor,
	        actorId: stepBase.actorId,
	        profileId: stepBase.profileId,
	        turnIndex: stepBase.turnIndex,
	        batchId: input.batchId,
	        batchIndex: input.batchIndex,
	        batchSize: input.batchSize,
	        schedulerMode: stepBase.schedulerMode,
	        atomic: true,
	        resolutionPolicy: "parallel-stepBatch",
	        pendingAction: cloneJson(decision.pending),
	        observation: cloneJson(decision.observation),
        action: cloneJson(decision.action),
        preState: cloneJson(preState),
        preStateHash,
        decisionStateHash: input.decisionStateHash,
        failureState: cloneJson(failureStateBeforeHook),
        failureStateHash,
        effectiveState: cloneJson(rollback.state),
        effectiveStateHash: rollback.stateHash,
        rollback: cloneJson(rollback.evidence),
        error
      }) ?? undefined;
      const failure = environmentFailureEvidence({
        error,
        fallbackStage: failureStageForError(error, "parallel_environment_step"),
        adapterFailure,
        environmentStepStarted,
        preStateHash,
        failureStateHash,
        rollback: rollback.evidence
      });
      const receiptFailure = deliverActorStepReceipt(decision.actor, {
	        id: `${stepBase.traceId}:rejected`,
	        status: "rejected",
	        traceId: stepBase.traceId,
        transactionId: decision.transactionId,
	        turnIndex: stepBase.turnIndex,
	        actorId: stepBase.actorId,
        pendingAction: cloneJson(decision.pending),
        action: decision.action,
        postStateHash: rollback.stateHash,
        failure
      });
      parallelFailures.set(decision.actorId, receiptFailure ?? failure);
    }
    const rejectedFeedback = emptyStepFeedback(rollback.state, input.environment);
    return {
      status: "failed",
      reason,
      feedback: rejectedFeedback,
      steps: input.decisions.map((decision, index) => ({
        ...baseStep({ ...input, decision, turnIndex: input.turnIndex + index }),
	        action: cloneJson(decision.action),
	        commitStatus: "rejected",
        atomic: true,
        resolutionPolicy: "parallel-stepBatch",
        preStateHash,
        postStateHash: rollback.stateHash,
        eventSeqRange: rollback.evidence.succeeded ? undefined : eventSeqRange(beforeEventSeq, rollback.eventSeq),
	        error: reason,
	        failure: parallelFailures.get(decision.actorId) ?? defaultFailureEvidence("parallel_environment_step", error)
	      }))
    };
  }
}
