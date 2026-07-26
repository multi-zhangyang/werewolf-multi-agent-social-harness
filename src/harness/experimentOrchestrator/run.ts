import {
  createGenericExperimentAssignmentResolution,
  createGenericExperimentProvenance,
  normalizeGenericExperimentSpec
} from "../experimentSpec";
import { runEvaluationRegistry } from "../evaluation";
import { buildGenericTournamentRunSetArtifact } from "../genericTournamentArtifacts";
import {
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
} from "../experimentRunStore";
import { hashStableJsonValue } from "../hash";
import {
  runTournamentEpisodes,
  GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE,
  type TournamentEpisodeContext
} from "../tournamentRunner";
import type { HarnessEvaluationReport } from "../types";
import {
  RUN_LEASE_HELD,
  type ExecutedGenericExperimentEpisode,
  type GenericCheckpointEnvelope,
  type GenericEpisodeEnvelope,
  type GenericExperimentAttemptErrorContext,
  type GenericExperimentAttemptIdentity,
  type GenericExperimentExecutionResult,
  type RunGenericExperimentOptions
} from "./types";
import {
  assertArtifactBinding,
  assertAttemptErrorClassification,
  assertEvaluationAdapter,
  assertEvaluationContextBinding,
  assertEvaluationReportBinding,
  bindArtifactToExperiment,
  createEpisodeContext,
  resolveEvaluators
} from "./bindings";
import {
  assertCheckpointPolicyRuntime,
  ensurePolicyCheckpointsForArtifact,
  ensurePolicyCheckpointsForEpisodes
} from "./checkpoints";
import {
  awaitWithAbort,
  createExperimentDeadline,
  requireDurableAttemptIdentity,
  requireDurableRetryWait,
  throwIfAborted,
  timestampAtOrAfter,
  waitForRetryEligibility
} from "./control";
import {
  assertArtifactProjectionRuntime,
  assertCanonicalProjectionSidecars,
  assertControlPolicyRuntime,
  buildArtifactProjection,
  buildGenericExperimentPublication,
  restrictedExperimentExecutionResult
} from "./publication";
import {
  assertResumedExperiment,
  hydrateCommittedEpisodes,
  stripRuntimeTournamentState,
  tournamentFromDurableRecord
} from "./resume";

/**
 * Execute a normalized, domain-neutral experiment through existing harness
 * primitives. No provider client or model semantics live here: a domain may
 * use them inside its actor/reasoner runtime, while the control plane remains
 * responsible for reproducible input, lifecycle evidence, evaluation, and
 * canonical persistence.
 */
export async function runGenericExperiment<
  TPrepared,
  TResult,
  TArtifact extends GenericEpisodeEnvelope,
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown,
  TAgent = unknown,
  TTrajectory = unknown,
  TCheckpoint extends GenericCheckpointEnvelope = GenericCheckpointEnvelope
>(
  options: RunGenericExperimentOptions<
    TPrepared,
    TResult,
    TArtifact,
    TState,
    TMetrics,
    TSocialEpisode,
    TAgent,
    TTrajectory,
    TCheckpoint
  >
): Promise<GenericExperimentExecutionResult<TArtifact>> {
  const normalizedSpec = normalizeGenericExperimentSpec(options.spec);
  if (options.adapter.domainId !== normalizedSpec.domainId) {
    throw new Error("Generic experiment adapter domainId must match the normalized experiment domainId.");
  }
  if (!options.artifactStore || typeof options.artifactStore.put !== "function") {
    throw new Error("Generic experiment execution requires a canonical episode artifact store.");
  }
  if (
    typeof options.artifactStore.get !== "function" ||
    typeof options.artifactStore.getEvaluationReport !== "function"
  ) {
    throw new Error("Generic experiment execution requires canonical episode artifact read authority.");
  }
  if (
    !options.runStore ||
    typeof options.runStore.beginOrResume !== "function" ||
    typeof options.runStore.startEpisode !== "function" ||
    typeof options.runStore.stageEpisode !== "function" ||
    typeof options.runStore.recoverCurrentEpisode !== "function" ||
    typeof options.runStore.recordEpisode !== "function" ||
    typeof options.runStore.finalize !== "function"
  ) {
    throw new Error("Generic experiment execution requires a durable experiment run store.");
  }
  if (options.runSetId !== undefined && !options.runSetId.trim()) {
    throw new Error("Generic experiment runSetId must be a nonempty string when present.");
  }
  const assignmentResolutionRequired = options.adapter.assignmentResolutionForEpisode !== undefined;
  const experiment = createGenericExperimentProvenance(normalizedSpec, { assignmentResolutionRequired });
  const specHash = experiment.specHash;
  const now = options.now ?? (() => new Date().toISOString());
  const runSetId = options.runSetId ?? normalizedSpec.id;
  assertCheckpointPolicyRuntime(options, normalizedSpec);
  assertArtifactProjectionRuntime(options, normalizedSpec);
  assertControlPolicyRuntime(options, normalizedSpec);
  const internalOptions = options as typeof options & { [RUN_LEASE_HELD]?: true };
  if (options.runStore.withRunLease && !internalOptions[RUN_LEASE_HELD]) {
    return options.runStore.withRunLease(runSetId, () => runGenericExperiment({
      ...options,
      [RUN_LEASE_HELD]: true
    } as typeof internalOptions));
  }
  // One deadline owns canonical-prefix hydration, final-checkpoint repair, and
  // any executable suffix. In particular, a finalized resume must not hold the
  // run lease forever when a deterministic checkpoint builder stalls.
  const deadline = createExperimentDeadline(
    options.abortSignal,
    normalizedSpec.timeoutPolicy.runTimeoutMs
  );
  try {
    throwIfAborted(deadline.signal);
    const resumed = await options.runStore.beginOrResume({ runSetId, experiment });
    throwIfAborted(deadline.signal);
    assertResumedExperiment(resumed.record, runSetId, experiment);
    let durableRecord = resumed.record;
    if (
      (durableRecord.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 ||
        durableRecord.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3) &&
      durableRecord.state === "active" && durableRecord.currentEpisode
    ) {
      durableRecord = (await options.runStore.recoverCurrentEpisode(runSetId)).record;
      throwIfAborted(deadline.signal);
    }
    const resumedRetryWait = durableRecord.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 &&
      durableRecord.state === "active" && durableRecord.currentEpisode?.phase === "retry-wait"
      ? structuredClone(durableRecord.currentEpisode)
      : undefined;
    const initialEpisodes = await hydrateCommittedEpisodes(
      durableRecord,
      normalizedSpec,
      options.artifactStore,
      deadline.signal
    );
    await assertCanonicalProjectionSidecars({
      episodes: initialEpisodes,
      artifactStore: options.artifactStore,
      spec: normalizedSpec,
      abortSignal: deadline.signal
    });
    await ensurePolicyCheckpointsForEpisodes({
      episodes: initialEpisodes,
      options,
      spec: normalizedSpec,
      experiment,
      abortSignal: deadline.signal
    });
    const stoppedByFailure =
      !normalizedSpec.continueOnError && initialEpisodes.at(-1)?.status === "failed";
    const hasExecutableSuffix =
      durableRecord.state === "active" &&
      initialEpisodes.length < normalizedSpec.episodeCount &&
      !stoppedByFailure &&
      !deadline.signal.aborted;
    const evaluationAdapter = options.adapter.evaluation;
    if (hasExecutableSuffix) assertEvaluationAdapter(evaluationAdapter, normalizedSpec);
    const selectedEvaluators = hasExecutableSuffix && !evaluationAdapter?.reportForEpisode
      ? resolveEvaluators(normalizedSpec, evaluationAdapter?.evaluators ?? [])
      : [];
    const runSetCreatedAt = durableRecord.createdAt;
    let activeAttempt: GenericExperimentAttemptIdentity | undefined;
    let retryControlPlaneFailure: unknown;
    const startDurableAttempt = async (context: TournamentEpisodeContext): Promise<void> => {
      if (
        resumedRetryWait && resumedRetryWait.index === context.index && resumedRetryWait.seed === context.seed &&
        activeAttempt === undefined
      ) await waitForRetryEligibility(resumedRetryWait.eligibleAt, deadline.signal);
      const startedAt = resumedRetryWait && activeAttempt === undefined
        ? timestampAtOrAfter(now(), resumedRetryWait.eligibleAt)
        : now();
      const record = await options.runStore.startEpisode({
        runSetId,
        index: context.index,
        seed: context.seed,
        startedAt
      });
      if (normalizedSpec.retryPolicy.maxAttempts > 1) {
        activeAttempt = requireDurableAttemptIdentity(record, context);
      }
    };
    const scheduleRetry = async (
      error: unknown,
      stage: GenericExperimentAttemptErrorContext["stage"],
      context: TournamentEpisodeContext
    ): Promise<boolean> => {
      try {
        throwIfAborted(deadline.signal);
        if (!activeAttempt || !options.adapter.retrying || !options.runStore.scheduleEpisodeRetry) return false;
        const episode = createEpisodeContext(context, normalizedSpec, experiment, deadline.signal);
        const classification = await awaitWithAbort(
          () => options.adapter.retrying!.classifyAttemptError(error, {
            stage,
            attempt: structuredClone(activeAttempt!),
            episode
          }),
          deadline.signal
        );
        assertAttemptErrorClassification(classification);
        if (
          classification.decision === "terminal" ||
          activeAttempt.ordinal >= normalizedSpec.retryPolicy.maxAttempts
        ) return false;
        const waiting = await options.runStore.scheduleEpisodeRetry({
          runSetId,
          code: classification.code,
          scheduledAt: now(),
          backoffMs: normalizedSpec.retryPolicy.backoffMs ?? 0
        });
        const retryWait = requireDurableRetryWait(waiting, context);
        await waitForRetryEligibility(retryWait.eligibleAt, deadline.signal);
        const started = await options.runStore.startEpisode({
          runSetId,
          index: context.index,
          seed: context.seed,
          startedAt: timestampAtOrAfter(now(), retryWait.eligibleAt)
        });
        activeAttempt = requireDurableAttemptIdentity(started, context);
        return true;
      } catch (controlError) {
        retryControlPlaneFailure = controlError;
        throw controlError;
      }
    };
    const prepareWithRetry = async (context: TournamentEpisodeContext): Promise<TPrepared> => {
      for (;;) {
        try {
          return await awaitWithAbort(
            () => options.adapter.prepareEpisode(
              createEpisodeContext(context, normalizedSpec, experiment, deadline.signal)
            ),
            deadline.signal
          );
        } catch (error) {
          throwIfAborted(deadline.signal);
          if (!await scheduleRetry(error, "prepare", context)) throw error;
        }
      }
    };
    const tournament = durableRecord.state === "finalized"
      ? tournamentFromDurableRecord(durableRecord, initialEpisodes)
      : await runTournamentEpisodes<
      TPrepared,
      ExecutedGenericExperimentEpisode<TArtifact>
    >({
      games: normalizedSpec.episodeCount,
      seed: normalizedSpec.seed,
      initialEpisodes,
      abortSignal: deadline.signal,
      continueOnError: normalizedSpec.continueOnError,
      async onEpisodeStarting(context) {
        await startDurableAttempt(context);
      },
      async prepareEpisode(context) {
        return prepareWithRetry(context);
      },
      async runEpisode(prepared, context) {
        let currentPrepared = prepared;
        let domainResult: TResult;
        for (;;) {
          try {
            domainResult = await awaitWithAbort(
              () => options.adapter.runEpisode(
                currentPrepared,
                createEpisodeContext(context, normalizedSpec, experiment, deadline.signal)
              ),
              deadline.signal
            );
            break;
          } catch (error) {
            throwIfAborted(deadline.signal);
            if (!await scheduleRetry(error, "run", context)) throw error;
            currentPrepared = await prepareWithRetry(context);
          }
        }
        throwIfAborted(deadline.signal);
        const status = options.adapter.lifecycleOf(domainResult);
        const rawArtifact = await awaitWithAbort(
            () => options.adapter.artifactForEpisode(
              domainResult,
              createEpisodeContext(context, normalizedSpec, experiment, deadline.signal)
            ),
            deadline.signal
          );
        const assignmentResolution = options.adapter.assignmentResolutionForEpisode
          ? createGenericExperimentAssignmentResolution(
              normalizedSpec,
              context,
              await awaitWithAbort(
                () => options.adapter.assignmentResolutionForEpisode!(
                  domainResult,
                  structuredClone(rawArtifact),
                  createEpisodeContext(context, normalizedSpec, experiment, deadline.signal)
                ),
                deadline.signal
              )
            )
          : undefined;
        const artifact = bindArtifactToExperiment(
          rawArtifact,
          experiment,
          context,
          assignmentResolution
        );
        assertArtifactBinding(artifact, normalizedSpec, status, context);
        let evaluationReport: HarnessEvaluationReport | undefined;
        if (evaluationAdapter?.reportForEpisode) {
          evaluationReport = structuredClone(await awaitWithAbort(
            () => evaluationAdapter.reportForEpisode!(
              domainResult,
              structuredClone(artifact),
              createEpisodeContext(context, normalizedSpec, experiment, deadline.signal)
            ),
            deadline.signal
          ));
          assertEvaluationReportBinding(evaluationReport, normalizedSpec.evaluatorIds, context);
        } else if (evaluationAdapter?.contextForEpisode) {
          const evaluationContext = evaluationAdapter.contextForEpisode(
            domainResult,
            structuredClone(artifact),
            createEpisodeContext(context, normalizedSpec, experiment, deadline.signal)
          );
          assertEvaluationContextBinding(evaluationContext, artifact, context);
          if (evaluationContext.socialEpisode !== undefined) {
            evaluationContext.socialEpisode = structuredClone(artifact.socialEpisode) as typeof evaluationContext.socialEpisode;
          }
          evaluationReport = runEvaluationRegistry({
              id: `${normalizedSpec.id}:g${context.index + 1}:evaluation`,
              createdAt: now(),
              context: structuredClone(evaluationContext),
              evaluators: selectedEvaluators
            });
          assertEvaluationReportBinding(
            evaluationReport,
            normalizedSpec.evaluatorIds,
            context,
            selectedEvaluators
          );
        }
        throwIfAborted(deadline.signal);
        assertArtifactBinding(artifact, normalizedSpec, status, context);
        return {
          status,
          artifact,
          ...(evaluationReport ? { evaluationReport } : {})
        };
      },
      statusOf: (episode) => episode.status,
      async onEpisodeSettled(episode) {
        if (retryControlPlaneFailure !== undefined) throw retryControlPlaneFailure;
        const result = episode.result;
        if (result) {
          await options.runStore.stageEpisode({
            runSetId,
            episode: {
              index: episode.index,
              seed: episode.seed,
              status: episode.status,
              runId: result.artifact.runId,
              artifact: structuredClone(result.artifact),
              ...(result.evaluationReport
                ? { evaluationReport: structuredClone(result.evaluationReport) }
                : {}),
              ...(episode.status === "failed"
                ? { error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE }
                : {})
            },
            stagedAt: now()
          });
          const projection = normalizedSpec.artifactPolicy.visibility === "research-full"
            ? undefined
            : await buildArtifactProjection({
                artifact: result.artifact,
                context: createEpisodeContext(episode, normalizedSpec, experiment, deadline.signal),
                adapter: options.adapter,
                spec: normalizedSpec,
                abortSignal: deadline.signal
              });
          // Canonical publication is a control-plane operation. Keeping it in
          // this terminal hook, outside the tournament's domain error boundary,
          // makes storage failure fatal even when continueOnError is enabled.
          await options.artifactStore.put(
            result.artifact,
            result.evaluationReport === undefined && projection === undefined
              ? undefined
              : {
                  ...(result.evaluationReport === undefined ? {} : { evaluationReport: result.evaluationReport }),
                  ...(projection === undefined ? {} : { projection })
                }
          );
          if (normalizedSpec.checkpointPolicy.mode !== "none") {
            const canonicalArtifact = await awaitWithAbort(
              () => options.artifactStore.get(result.artifact.runId),
              deadline.signal
            );
            if (
              canonicalArtifact === undefined ||
              hashStableJsonValue(canonicalArtifact) !== hashStableJsonValue(result.artifact)
            ) {
              throw new Error("Canonical episode publication could not be verified before checkpoint publication.");
            }
            await ensurePolicyCheckpointsForArtifact({
              artifact: canonicalArtifact,
              context: createEpisodeContext(episode, normalizedSpec, experiment, deadline.signal),
              options,
              spec: normalizedSpec
            });
          }
        }
        await options.runStore.recordEpisode({
          runSetId,
          episode: {
            index: episode.index,
            seed: episode.seed,
            status: episode.status,
            ...(result
              ? {
                  runId: result.artifact.runId,
                  artifact: structuredClone(result.artifact),
                  ...(result.evaluationReport
                    ? { evaluationReport: structuredClone(result.evaluationReport) }
                    : {})
                }
              : {}),
            ...(episode.status === "failed"
              ? { error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE }
              : {})
          }
        });
      }
    });
    const runSet = await buildGenericTournamentRunSetArtifact({
      runSetId,
      createdAt: runSetCreatedAt,
      result: tournament,
      experiment,
      adapter: {
        domainId: normalizedSpec.domainId,
        artifactForEpisode: (episode) => episode.artifact,
        validateArtifact: (artifact) =>
          artifact.runId && artifact.socialEpisode.domainId === normalizedSpec.domainId
            ? []
            : ["episode artifact identity does not match the normalized experiment"],
        runIdOf: (artifact) => artifact.runId,
        evaluationReportOf: (episode) => episode.evaluationReport
      }
    });
    await options.runStore.finalize(runSet);
    if (normalizedSpec.artifactPolicy.visibility !== "research-full") {
      const publication = await buildGenericExperimentPublication({
        runSet,
        spec: normalizedSpec,
        specHash,
        artifactStore: options.artifactStore,
        abortSignal: deadline.signal
      });
      // Keep the full run set scoped to durable finalize above. Returning it,
      // even beside a safe projection, would let callers bypass the domain
      // projector and recover private artifact/evaluation/experiment authority.
      return restrictedExperimentExecutionResult(publication) as unknown as GenericExperimentExecutionResult<TArtifact>;
    }
    return {
      normalizedSpec,
      experiment: structuredClone(experiment),
      specHash,
      tournament: stripRuntimeTournamentState(tournament),
      runSet
    };
  } finally {
    deadline.dispose();
  }
}
