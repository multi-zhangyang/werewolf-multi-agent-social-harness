import { cloneJson } from "./valueUtils";
import { applyOptionalSystemTransition, applyParallelBatch, applySequentialDecision } from "./stepApplication";
import { allocateRunnerTraceId, collectDecision, findNativeTraceIdentityFailure, isSuccessfulDecision, normalizeSocialExecutionLimits, rejectUncommittedDecisions, type SocialDecision, SocialExecutionLimitError } from "./decisions";
import { defaultFailureEvidence, eventSeqRange, findDuplicatePendingActorId, isParallelEnvironment, normalizeSchedulerMode, rejectedParallelDecisionBatchSteps, rejectedSequentialDecisionBatchSteps, resolveSchedulerMode, schedulerFailureStep, selectPendingBatch } from "./stepOutcomes";
import { SocialCommunicationBus } from "./messaging";
import { cloneSocialDomainAdapterManifest, type SocialDomainAdapterManifest, validateSocialDomainAdapterManifest } from "../domainAdapter";
import { type SocialActor, type SocialActorTurnIndexProvider, type SocialAfterEnvironmentStepHook, type SocialChannel, type SocialDecisionFailureHook, type SocialEnvironment, type SocialEnvironmentStepFailureHook, type SocialEpisodeArtifact, type SocialEpisodeStatus, type SocialExecutionLimits, type SocialHarnessStep, type SocialMessage, type SocialObservationAssembler, type SocialParallelEnvironment, type SocialRuntimeActorBinding, type SocialSchedulerMode, type SocialSchedulerResolver, type SocialStepFailureEvidence, type SocialSystemTransitionProvider, type SocialTraceIdProvider } from "./contracts";
/**
 * The runner's actor registry is an identity boundary, not a convenience map.
 * Reject ambiguity before any environment observation, decision, message, or
 * transition can occur; a later Map overwrite would make profile attribution
 * and recorded social evidence irrecoverably ambiguous.
 */
function assertUniqueSocialActorRegistry<TObservation, TPending, TCommand>(
  actors: readonly SocialActor<TObservation, TPending, TCommand>[]
): string[] {
  const ids = new Set<string>();
  for (const [index, actor] of actors.entries()) {
    const actorId = actor.id?.trim();
    if (!actorId) throw new Error(`Social actor registry contains an empty actor id at index ${index}.`);
    if (ids.has(actorId)) throw new Error(`Social actor registry contains duplicate actor id ${actorId}.`);
    ids.add(actorId);
  }
  return [...ids].sort();
}


export interface SocialEpisodeOptions<TState, TObservation, TPending extends { actorId?: string }, TCommand> {
  id: string;
  domainId?: string;
  /** Safe execution identity for a new domain adapter run. */
  domainAdapter?: SocialDomainAdapterManifest;
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  actors: Array<SocialActor<TObservation, TPending, TCommand>>;
  channels?: SocialChannel[];
  initialMessages?: SocialMessage[];
  schedulerMode?: SocialSchedulerMode;
  maxTransitions?: number;
  /** Optional generic decision-cancellation boundary. Defaults preserve the
   * historical unlimited decision behavior. */
  executionLimits?: SocialExecutionLimits;
  hashState?: (state: TState) => string;
  hashMessages?: (messages: SocialMessage[]) => string;
  eventSeq?: (state: TState) => number;
	  afterEnvironmentStep?: SocialAfterEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
  assembleObservation?: SocialObservationAssembler<TObservation, TPending>;
  systemTransition?: SocialSystemTransitionProvider<TState, TObservation, TPending, TCommand>;
  traceIdForDecision?: SocialTraceIdProvider<TState, TPending>;
	  actorTurnIndexForDecision?: SocialActorTurnIndexProvider<TState, TPending>;
	  schedulerModeForBatch?: SocialSchedulerResolver<TState, TPending>;
	  onDecisionFailure?: SocialDecisionFailureHook<TState, TObservation, TPending, TCommand>;
	  onEnvironmentStepFailure?: SocialEnvironmentStepFailureHook<TState, TObservation, TPending, TCommand>;
}

export async function runSocialEpisode<TState, TObservation, TPending extends { actorId?: string }, TCommand>(
  options: SocialEpisodeOptions<TState, TObservation, TPending, TCommand>
): Promise<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>> {
  if (options.domainAdapter) {
    const adapterErrors = validateSocialDomainAdapterManifest(options.domainAdapter);
    if (adapterErrors.length) throw new Error(`Invalid social domain adapter manifest: ${adapterErrors.join(" ")}`);
    if (options.domainId !== undefined && options.domainId !== options.domainAdapter.domainId) {
      throw new Error("Social episode domainId must match domainAdapter.domainId.");
    }
  }
  const runtimeActorIds = assertUniqueSocialActorRegistry(options.actors);
  const runtimeActors: SocialRuntimeActorBinding[] = options.actors
    .map((actor) => ({
      actorId: actor.id,
      profileId: actor.profile.id,
      ...(actor.profile.version === undefined ? {} : { profileVersion: actor.profile.version }),
      model: actor.profile.model,
      ...(actor.profile.temperature === undefined ? {} : { temperature: actor.profile.temperature }),
      ...(actor.profile.policyId === undefined ? {} : { policyId: actor.profile.policyId }),
      ...(actor.profile.reasonerId === undefined ? {} : { reasonerId: actor.profile.reasonerId }),
      ...(actor.profile.personaId === undefined ? {} : { personaId: actor.profile.personaId })
    }))
    .sort((left, right) => left.actorId.localeCompare(right.actorId));
  const defaultSchedulerMode = normalizeSchedulerMode(options.schedulerMode ?? "aec");
  const bus = new SocialCommunicationBus(options.channels ?? [], options.initialMessages ?? [], { runtimeActorIds });
  const initialMessages = bus.listMessages();
  const executionLimits = normalizeSocialExecutionLimits(options.executionLimits);
  const maxTransitions = options.maxTransitions;
  const execution = {
    schemaVersion: "harness.social-execution.v1" as const,
    started: true,
    initialMessageCount: initialMessages.length,
    initialMessagesHash: options.hashMessages?.(initialMessages),
    ...(maxTransitions === undefined ? {} : { maxTransitions }),
    ...(executionLimits.decisionTimeoutMs === undefined
      ? {}
      : { decisionTimeoutMs: executionLimits.decisionTimeoutMs })
  };
  const actorById = new Map(options.actors.map((actor) => [actor.id, actor]));
  const initialState = cloneJson(options.environment.snapshot());
  const steps: Array<SocialHarnessStep<TObservation, TPending, TCommand>> = [];
  const usedNativeTraceIds = new Set<string>();
  const recordNativeSteps = (...records: Array<SocialHarnessStep<TObservation, TPending, TCommand>>): void => {
    steps.push(...records);
    for (const record of records) usedNativeTraceIds.add(record.traceId);
  };
  let status: SocialEpisodeStatus = "completed";
  let terminationReason: string | undefined;
  let truncationReason: string | undefined;
  let failureReason: string | undefined;
  let turnIndex = 1;
  let batchIndex = 1;
  if (defaultSchedulerMode === "parallel" && !isParallelEnvironment(options.environment)) {
    failureReason = "Parallel scheduler requires environment.stepBatch().";
    return {
      id: options.id,
      domainId: options.domainAdapter?.domainId ?? options.domainId,
      domainAdapter: options.domainAdapter ? cloneSocialDomainAdapterManifest(options.domainAdapter) : undefined,
      status: "failed",
      execution,
      schedulerMode: defaultSchedulerMode,
      runtimeActorIds,
      runtimeActors,
      profiles: options.actors.map((actor) => cloneJson(actor.profile)),
      channels: bus.listChannels(),
      initialState,
      finalState: cloneJson(options.environment.snapshot()),
      steps,
      messages: bus.listMessages(),
      failureReason,
      error: failureReason
    };
  }

  if (executionLimits.abortSignal?.aborted) {
    const stateHash = options.hashState?.(options.environment.snapshot());
    const failure = defaultFailureEvidence("execution_abort", new SocialExecutionLimitError("execution_abort"));
    failureReason = "Social episode aborted by the harness execution control plane before decision collection.";
    status = "failed";
    recordNativeSteps(
      schedulerFailureStep<TObservation, TPending, TCommand>({
        optionsId: options.id,
        traceId: allocateRunnerTraceId(usedNativeTraceIds, `${options.id}:execution-control:prestart`),
        turnIndex,
        batchId: `${options.id}:execution-control:prestart`,
        batchIndex,
        batchSize: 1,
        schedulerMode: defaultSchedulerMode,
        pendingAction: undefined as unknown as TPending,
        decisionStateHash: stateHash,
        preStateHash: stateHash,
        postStateHash: stateHash,
        failure
      })
    );
  }

  while (
    !options.environment.done() &&
    (maxTransitions === undefined || turnIndex <= maxTransitions) &&
    !executionLimits.abortSignal?.aborted
  ) {
    // Pending actions are scheduler input owned by the harness. Detach them at
    // the environment boundary so actor/adapter callbacks cannot rewrite the
    // environment's own pending registry or another actor's joint decision.
    const pendingActions = cloneJson(options.environment.pendingActions());
    const stateForScheduler = options.environment.snapshot();
    const schedulerMode = resolveSchedulerMode({
      optionsId: options.id,
      state: stateForScheduler,
      pendingActions,
      turnIndex,
      batchIndex,
      defaultSchedulerMode,
      schedulerModeForBatch: options.schedulerModeForBatch
    });
    if (schedulerMode === "parallel" && !isParallelEnvironment(options.environment)) {
      status = "failed";
      failureReason = "Parallel scheduler requires environment.stepBatch().";
      break;
    }
    const pendingBatch = selectPendingBatch(pendingActions, schedulerMode);
    if (!pendingBatch.length) {
      const systemTraceId = allocateRunnerTraceId(
        usedNativeTraceIds,
        `${options.id}:social:${turnIndex}:system`
      );
      const systemOutcome = applyOptionalSystemTransition({
        optionsId: options.id,
        environment: options.environment,
        bus,
        turnIndex,
        batchIndex,
        schedulerMode,
        hashState: options.hashState,
        eventSeq: options.eventSeq,
        afterEnvironmentStep: options.afterEnvironmentStep,
        systemTransition: options.systemTransition,
        traceId: systemTraceId
      });
      if (!systemOutcome) break;
      recordNativeSteps(systemOutcome.step);
      if (systemOutcome.status === "failed") {
        status = "failed";
        failureReason = systemOutcome.reason;
        break;
      }
      if (systemOutcome.feedback.episodeTruncated) {
        status = "truncated";
        truncationReason = systemOutcome.feedback.truncationReason;
        break;
      }
      if (systemOutcome.feedback.episodeTerminated) {
        status = "completed";
        terminationReason = systemOutcome.feedback.terminationReason;
        break;
      }
      turnIndex += 1;
      batchIndex += 1;
      continue;
    }
    const decisionState = options.environment.snapshot();
    const decisionStateHash = options.hashState?.(decisionState);
    const batchId = `${options.id}:batch:${batchIndex}`;

    const duplicateActorId = findDuplicatePendingActorId(pendingBatch);
    if (duplicateActorId) {
      const reason = `Scheduler batch ${batchId} contains multiple pending actions for actor ${duplicateActorId}.`;
      const failure = defaultFailureEvidence("scheduler_validation", reason);
      const stateHash = options.hashState?.(options.environment.snapshot());
      recordNativeSteps(
        schedulerFailureStep({
          optionsId: options.id,
          traceId: allocateRunnerTraceId(usedNativeTraceIds, `${options.id}:scheduler:${batchIndex}:rejected`),
          turnIndex,
          batchId,
          batchIndex,
          batchSize: pendingBatch.length,
          schedulerMode,
          pendingAction: pendingBatch.find((pending) => pending.actorId === duplicateActorId) ?? pendingBatch[0],
          decisionStateHash,
          preStateHash: stateHash,
          postStateHash: stateHash,
          failure
        })
      );
      status = "failed";
      failureReason = reason;
      break;
    }

    const decisions = await Promise.all(
      pendingBatch.map((pending, pendingIndex) =>
	        collectDecision({
	          optionsId: options.id,
	          environment: options.environment,
	          actorById,
	          bus,
	          pending,
	          pendingIndex,
	          turnIndex: turnIndex + pendingIndex,
	          batchId,
	          batchIndex,
	          batchSize: pendingBatch.length,
	          schedulerMode,
	          assembleObservation: options.assembleObservation,
	          traceIdForDecision: options.traceIdForDecision,
	          actorTurnIndexForDecision: options.actorTurnIndexForDecision,
            executionLimits
	        })
      )
    );

    const traceIdentityFailure = findNativeTraceIdentityFailure(decisions, usedNativeTraceIds, options.id);
    if (traceIdentityFailure) {
      const failure = defaultFailureEvidence("trace_identity", traceIdentityFailure.message);
      const rejectionStep = schedulerFailureStep<TObservation, TPending, TCommand>({
        optionsId: options.id,
        traceId: allocateRunnerTraceId(usedNativeTraceIds, `${options.id}:scheduler:${batchIndex}:trace_identity:rejected`),
        turnIndex,
        batchId,
        batchIndex,
        batchSize: pendingBatch.length,
        schedulerMode,
        pendingAction: pendingBatch[traceIdentityFailure.pendingIndex] ?? pendingBatch[0],
        decisionStateHash,
        preStateHash: decisionStateHash,
        postStateHash: decisionStateHash,
        failure
      });
      // Actions keep their policy-provided trace evidence intact. The rejected
      // runner receipt instead refers to the unique native scheduler record;
      // staged actor state is keyed by transactionId, never by traceId.
      rejectUncommittedDecisions(decisions, failure, { receiptTraceId: rejectionStep.traceId });
      recordNativeSteps(rejectionStep);
      status = "failed";
      failureReason = traceIdentityFailure.message;
      break;
    }

    // A signal can fire immediately after concurrent decision collection has
    // settled. Check again before preflight/message publication/environment
    // mutation so the generic control plane, not a provider race, owns the
    // cancellation boundary.
    if (executionLimits.abortSignal?.aborted) {
      const abortReason = "Social episode aborted by the harness execution control plane before an environment transition.";
      const abortFailure = defaultFailureEvidence("execution_abort", new SocialExecutionLimitError("execution_abort"));
      const batchAbortFailure: SocialStepFailureEvidence = {
        stage: "batch_aborted",
        message: `Batch ${batchId} was abandoned before an environment transition because the harness execution control plane aborted.`
      };
      const failureForDecision = (): SocialStepFailureEvidence => batchAbortFailure;
      rejectUncommittedDecisions(decisions, failureForDecision);
      const abortedState = options.environment.snapshot();
      const abortedStateHash = options.hashState?.(abortedState);
      const abortedEventSeqRange = eventSeqRange(options.eventSeq?.(decisionState), options.eventSeq?.(abortedState));
      const controlStep = schedulerFailureStep<TObservation, TPending, TCommand>({
        optionsId: options.id,
        traceId: allocateRunnerTraceId(usedNativeTraceIds, `${options.id}:scheduler:${batchIndex}:execution_abort`),
        turnIndex,
        // Keep the system control record outside the joint action batch so a
        // parallel batch still contains exactly its scheduled actor rows.
        batchId: `${batchId}:execution-control`,
        batchIndex,
        batchSize: 1,
        schedulerMode,
        pendingAction: pendingBatch[0],
        decisionStateHash,
        preStateHash: decisionStateHash,
        postStateHash: abortedStateHash,
        failure: abortFailure
      });
      if (schedulerMode === "parallel") {
        recordNativeSteps(
          controlStep,
          ...rejectedParallelDecisionBatchSteps({
            optionsId: options.id,
            decisions,
            batchId,
            batchIndex,
            batchSize: pendingBatch.length,
            decisionStateHash,
            preStateHash: decisionStateHash,
            postStateHash: abortedStateHash,
            eventSeqRange: abortedEventSeqRange,
            failureForDecision
          })
        );
      } else {
        recordNativeSteps(
          controlStep,
          ...rejectedSequentialDecisionBatchSteps({
            optionsId: options.id,
            decisions,
            batchId,
            batchIndex,
            batchSize: pendingBatch.length,
            schedulerMode,
            decisionStateHash,
            preStateHash: decisionStateHash,
            postStateHash: abortedStateHash,
            failureForDecision
          })
        );
      }
      status = "failed";
      failureReason = abortReason;
      break;
    }

    const failedDecision = decisions.find((decision) => !decision.ok);
    if (failedDecision) {
      status = "failed";
      failureReason = failedDecision.error;
      const failedTurnIndex = failedDecision.turnIndex;
      const adapterFailure = options.onDecisionFailure?.({
        actor: failedDecision.actor,
        actorId: failedDecision.actorId,
        profileId: failedDecision.actor?.profile.id ?? failedDecision.actorId,
        turnIndex: failedTurnIndex,
        actorTurnIndex: failedDecision.actorTurnIndex,
        batchId,
        batchIndex,
        batchSize: pendingBatch.length,
        schedulerMode,
        pendingAction: cloneJson(failedDecision.pending),
        observation: cloneJson(failedDecision.observation as TObservation | undefined),
        traceId: failedDecision.traceId,
        decisionState: cloneJson(decisionState),
        decisionStateHash,
        preStateHash: decisionStateHash,
        failureStage: failedDecision.failureStage,
        error: failedDecision.rawError
      });
      const failedPostState = options.environment.snapshot();
      const failedPostStateHash = options.hashState?.(failedPostState);
      const failedEventSeqRange = eventSeqRange(options.eventSeq?.(decisionState), options.eventSeq?.(failedPostState));
      const decisionFailure = adapterFailure ?? defaultFailureEvidence(failedDecision.failureStage, failedDecision.rawError);
      const failureForDecision = (decision: SocialDecision<TObservation, TPending, TCommand>): SocialStepFailureEvidence => {
        if (decision === failedDecision) return decisionFailure;
        // Unlike an atomic parallel batch, a batched AEC collection retains
        // independent decision failures for diagnostic and retry evidence.
        // Only the uncommitted successful peers are abandoned by the batch.
        if (schedulerMode !== "parallel" && !decision.ok) {
          return defaultFailureEvidence(decision.failureStage, decision.rawError);
        }
        return {
          stage: "batch_aborted",
          message: `Batch ${batchId} was abandoned before an environment transition because ${failedDecision.actorId} failed during ${failedDecision.failureStage}.`
        };
      };
      rejectUncommittedDecisions(decisions, failureForDecision);
      if (schedulerMode === "parallel") {
        recordNativeSteps(
          ...rejectedParallelDecisionBatchSteps({
            optionsId: options.id,
            decisions,
            batchId,
            batchIndex,
            batchSize: pendingBatch.length,
            decisionStateHash,
            preStateHash: decisionStateHash,
            postStateHash: failedPostStateHash,
            eventSeqRange: failedEventSeqRange,
            failureForDecision
          })
        );
      } else {
        recordNativeSteps(
          ...rejectedSequentialDecisionBatchSteps({
            optionsId: options.id,
            decisions,
            batchId,
            batchIndex,
            batchSize: pendingBatch.length,
            schedulerMode,
            decisionStateHash,
            preStateHash: decisionStateHash,
            postStateHash: failedPostStateHash,
            eventSeqRange: failedEventSeqRange,
            failureForDecision
          })
        );
      }
      break;
    }
    const successfulDecisions = decisions.filter(isSuccessfulDecision);

    if (schedulerMode === "parallel") {
      if (maxTransitions !== undefined && turnIndex + successfulDecisions.length - 1 > maxTransitions) {
        status = "truncated";
        truncationReason = `maxTransitions ${maxTransitions} reached before parallel batch could be applied`;
        const truncationFailure: SocialStepFailureEvidence = {
          stage: "scheduler_truncation",
          message: truncationReason
        };
        rejectUncommittedDecisions(successfulDecisions, truncationFailure);
        const truncationState = options.environment.snapshot();
        recordNativeSteps(
          ...rejectedParallelDecisionBatchSteps({
            optionsId: options.id,
            decisions: successfulDecisions,
            batchId,
            batchIndex,
            batchSize: pendingBatch.length,
            decisionStateHash,
            preStateHash: decisionStateHash,
            postStateHash: options.hashState?.(truncationState),
            eventSeqRange: eventSeqRange(options.eventSeq?.(decisionState), options.eventSeq?.(truncationState)),
            failureForDecision: () => truncationFailure
          })
        );
        break;
      }
      const outcome = applyParallelBatch({
        optionsId: options.id,
        environment: options.environment as SocialParallelEnvironment<TState, TObservation, TPending, TCommand>,
        bus,
        decisions: successfulDecisions,
        turnIndex,
        batchId,
        batchIndex,
        batchSize: pendingBatch.length,
        schedulerMode,
	        decisionStateHash,
	        hashState: options.hashState,
	        eventSeq: options.eventSeq,
	        afterEnvironmentStep: options.afterEnvironmentStep,
	        onEnvironmentStepFailure: options.onEnvironmentStepFailure
	      });
      recordNativeSteps(...outcome.steps);
      if (outcome.status === "failed") {
        status = "failed";
        failureReason = outcome.reason;
        break;
      }
      if (outcome.feedback.episodeTruncated) {
        status = "truncated";
        truncationReason = outcome.feedback.truncationReason;
        break;
      }
      if (outcome.feedback.episodeTerminated) {
        status = "completed";
        terminationReason = outcome.feedback.terminationReason;
        break;
      }
      turnIndex += successfulDecisions.length;
    } else {
      for (const [decisionIndex, decision] of successfulDecisions.entries()) {
        const outcome = applySequentialDecision({
          optionsId: options.id,
          environment: options.environment,
          bus,
          decision,
          turnIndex,
          batchId,
          batchIndex,
          batchSize: pendingBatch.length,
          schedulerMode,
	          decisionStateHash,
	          hashState: options.hashState,
	          eventSeq: options.eventSeq,
	          afterEnvironmentStep: options.afterEnvironmentStep,
	          onEnvironmentStepFailure: options.onEnvironmentStepFailure
	        });
        recordNativeSteps(outcome.step);
        if (outcome.status === "failed") {
          status = "failed";
          failureReason = outcome.reason;
          const remainingDecisions = successfulDecisions.slice(decisionIndex + 1);
          const batchAbortFailure: SocialStepFailureEvidence = {
            stage: "batch_aborted",
            message: `Batch ${batchId} stopped before this proposal reached the environment: ${outcome.reason ?? "a prior transition failed"}.`
          };
          rejectUncommittedDecisions(remainingDecisions, batchAbortFailure);
          const abortedStateHash = options.hashState?.(options.environment.snapshot());
          recordNativeSteps(
            ...rejectedSequentialDecisionBatchSteps({
              optionsId: options.id,
              decisions: remainingDecisions,
              batchId,
              batchIndex,
              batchSize: pendingBatch.length,
              schedulerMode,
              decisionStateHash,
              preStateHash: abortedStateHash,
              postStateHash: abortedStateHash,
              failureForDecision: () => batchAbortFailure
            })
          );
          break;
        }
        if (outcome.feedback.episodeTruncated) {
          status = "truncated";
          truncationReason = outcome.feedback.truncationReason;
          const remainingDecisions = successfulDecisions.slice(decisionIndex + 1);
          const batchAbortFailure: SocialStepFailureEvidence = {
            stage: "batch_aborted",
            message: truncationReason ?? `Batch ${batchId} stopped before this proposal reached the environment because the episode was truncated.`
          };
          rejectUncommittedDecisions(remainingDecisions, batchAbortFailure);
          const abortedStateHash = options.hashState?.(options.environment.snapshot());
          recordNativeSteps(
            ...rejectedSequentialDecisionBatchSteps({
              optionsId: options.id,
              decisions: remainingDecisions,
              batchId,
              batchIndex,
              batchSize: pendingBatch.length,
              schedulerMode,
              decisionStateHash,
              preStateHash: abortedStateHash,
              postStateHash: abortedStateHash,
              failureForDecision: () => batchAbortFailure
            })
          );
          break;
        }
        if (outcome.feedback.episodeTerminated) {
          status = "completed";
          terminationReason = outcome.feedback.terminationReason;
          const remainingDecisions = successfulDecisions.slice(decisionIndex + 1);
          const batchAbortFailure: SocialStepFailureEvidence = {
            stage: "batch_aborted",
            message: terminationReason ?? `Batch ${batchId} stopped before this proposal reached the environment because the episode terminated.`
          };
          rejectUncommittedDecisions(remainingDecisions, batchAbortFailure);
          const abortedStateHash = options.hashState?.(options.environment.snapshot());
          recordNativeSteps(
            ...rejectedSequentialDecisionBatchSteps({
              optionsId: options.id,
              decisions: remainingDecisions,
              batchId,
              batchIndex,
              batchSize: pendingBatch.length,
              schedulerMode,
              decisionStateHash,
              preStateHash: abortedStateHash,
              postStateHash: abortedStateHash,
              failureForDecision: () => batchAbortFailure
            })
          );
          break;
        }
        turnIndex += 1;
      }
    }

    if (status === "failed" || status === "truncated" || terminationReason) break;
    batchIndex += 1;
  }

  if (!options.environment.done() && status !== "failed" && status !== "truncated") {
    if (executionLimits.abortSignal?.aborted) {
      const abortedState = options.environment.snapshot();
      const abortedStateHash = options.hashState?.(abortedState);
      recordNativeSteps(
        schedulerFailureStep<TObservation, TPending, TCommand>({
          optionsId: options.id,
          traceId: allocateRunnerTraceId(usedNativeTraceIds, `${options.id}:execution-control:after-transition`),
          turnIndex,
          batchId: `${options.id}:execution-control:after-transition`,
          batchIndex,
          batchSize: 1,
          schedulerMode: defaultSchedulerMode,
          pendingAction: undefined as unknown as TPending,
          decisionStateHash: abortedStateHash,
          preStateHash: abortedStateHash,
          postStateHash: abortedStateHash,
          failure: defaultFailureEvidence("execution_abort", new SocialExecutionLimitError("execution_abort"))
        })
      );
      status = "failed";
      failureReason = "Social episode aborted by the harness execution control plane after a committed environment transition.";
    } else if (maxTransitions !== undefined) {
      status = "truncated";
      truncationReason = `maxTransitions ${maxTransitions} reached before terminal state`;
    } else {
      status = "failed";
      failureReason = "Social environment stopped producing transitions before reaching a terminal state.";
    }
  }
  return {
    id: options.id,
    domainId: options.domainAdapter?.domainId ?? options.domainId,
    domainAdapter: options.domainAdapter ? cloneSocialDomainAdapterManifest(options.domainAdapter) : undefined,
    status,
    execution,
    schedulerMode: defaultSchedulerMode,
    runtimeActorIds,
    runtimeActors,
    profiles: options.actors.map((actor) => cloneJson(actor.profile)),
    channels: bus.listChannels(),
    initialState,
    finalState: cloneJson(options.environment.snapshot()),
    steps,
    messages: bus.listMessages(),
    terminationReason,
    truncationReason,
    failureReason,
    error: failureReason
  };
}
