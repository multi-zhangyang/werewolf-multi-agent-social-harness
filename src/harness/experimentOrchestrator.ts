import { compareSocialDomainAdapterManifests } from "./domainAdapter";
import {
  isSafeHarnessCheckpointBoundary,
  latestMessageSeqForHarnessPrefix,
  validateHarnessCheckpointEnvelope,
  validateHarnessEpisodeProjectionEnvelope,
  type HarnessCheckpointEnvelope,
  type HarnessEpisodeArtifactEnvelope,
  type HarnessEpisodeProjectionEnvelope,
  type HarnessEpisodeProjectionVisibility
} from "./episodeArtifacts";
import { deriveHarnessEpisodeArtifactSha256 } from "./episodeArtifactStore";
import {
  createGenericExperimentAssignmentResolution,
  createGenericExperimentExecutionAttestation,
  createGenericExperimentProvenance,
  normalizeGenericExperimentSpec,
  validateGenericExperimentExecutionAttestation,
  validateGenericExperimentExecutionEvidence,
  validateGenericExperimentProvenance,
  type GenericExperimentProvenanceV1,
  type GenericExperimentSpecV1,
  type NormalizedGenericExperimentSpecV1
} from "./experimentSpec";
import { runEvaluationRegistry, type HarnessEvaluationContext, type HarnessEvaluator } from "./evaluation";
import {
  buildGenericTournamentRunSetArtifact,
  type GenericTournamentRunSetEpisode,
  type GenericTournamentRunSetArtifact
} from "./genericTournamentArtifacts";
import {
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3,
  type HarnessExperimentRunCurrentEpisodeV3,
  type HarnessExperimentRunRecordV3,
  type HarnessExperimentRunRecord,
  type HarnessExperimentRunRecovery,
  type HarnessExperimentRunResume
} from "./experimentRunStore";
import { hashStableJsonValue, hashStableState } from "./hash";
import {
  isSocialStepCommitted,
  validateSocialEpisodeArtifact,
  type SocialAssignmentActorResolution
} from "./social";
import {
  runTournamentEpisodes,
  GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE,
  type GenericTournamentResult,
  type TournamentEpisodeContext,
  type TournamentEpisodeLifecycle
} from "./tournamentRunner";
import type { HarnessEvaluationReport } from "./types";

type GenericEpisodeEnvelope = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;
type GenericCheckpointEnvelope = HarnessCheckpointEnvelope<unknown, unknown, unknown, unknown, unknown>;
const RUN_LEASE_HELD = Symbol("generic-experiment-run-lease-held");
export const GENERIC_EXPERIMENT_PUBLICATION_VERSION = "harness.experiment-publication.v1";
export const GENERIC_EXPERIMENT_PUBLICATION_RUN_SET_VERSION = "harness.tournament-run-set-publication.v1";

export interface GenericExperimentEpisodeContext extends TournamentEpisodeContext {
  spec: NormalizedGenericExperimentSpecV1;
  experiment: GenericExperimentProvenanceV1;
  specHash: string;
  abortSignal: AbortSignal;
}

export interface GenericExperimentAttemptIdentity {
  ordinal: number;
  attemptId: string;
}

export interface GenericExperimentAttemptErrorContext {
  stage: "prepare" | "run";
  attempt: GenericExperimentAttemptIdentity;
  episode: GenericExperimentEpisodeContext;
}

export interface GenericExperimentAttemptErrorClassification {
  decision: "safe-to-retry" | "terminal";
  /** Closed machine vocabulary owned by the versioned domain retry policy. */
  code: string;
}

/** Harness-selected complete native boundary. The domain receives no mutable
 * runner state and must derive the checkpoint model-free from the immutable
 * canonical episode artifact. */
export interface GenericExperimentNativeCheckpointBoundary {
  nativeStepCount: number;
  traceId: string;
}

export interface GenericExperimentArtifactStore<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope = GenericCheckpointEnvelope
> {
  put(artifact: TArtifact, options?: {
    evaluationReport?: HarnessEvaluationReport;
    projection?: HarnessEpisodeProjectionEnvelope;
  }): Promise<unknown>;
  /** Canonical, integrity-checking read path used to hydrate durable prefixes. */
  get(runId: string): Promise<TArtifact | undefined>;
  /** Canonical evaluation sidecar read path; absence is part of immutable identity. */
  getEvaluationReport(runId: string): Promise<HarnessEvaluationReport | undefined>;
  /** Optional derived sidecar read path. Required only for redacted/public policies. */
  getProjection?(runId: string): Promise<HarnessEpisodeProjectionEnvelope | undefined>;
  /** Optional canonical checkpoint authority, required when the selected
   * experiment checkpoint policy is executable. */
  putCheckpoint?(runId: string, checkpoint: TCheckpoint): Promise<unknown>;
  getCheckpoint?(runId: string, checkpointId: string): Promise<TCheckpoint | undefined>;
}

/**
 * Durable experiment lifecycle authority. Implementations persist only
 * provenance and ordered canonical-episode references; episode content remains
 * owned by GenericExperimentArtifactStore.
 */
export interface GenericExperimentRunStore<TArtifact extends GenericEpisodeEnvelope> {
  /** Optional single-host execution lease. Durable stores use this to prevent
   * a live run from being mistaken for an interrupted run by another process. */
  withRunLease?<TResult>(runSetId: string, operation: () => Promise<TResult>): Promise<TResult>;
  beginOrResume(input: {
    runSetId: string;
    experiment: GenericExperimentProvenanceV1;
    createdAt?: string;
  }): Promise<HarnessExperimentRunResume>;
  startEpisode(input: {
    runSetId: string;
    index: number;
    seed: string;
    startedAt?: string;
  }): Promise<unknown>;
  scheduleEpisodeRetry?(input: {
    runSetId: string;
    code: string;
    scheduledAt?: string;
    backoffMs: number;
  }): Promise<unknown>;
  stageEpisode(input: {
    runSetId: string;
    episode: GenericTournamentRunSetEpisode<TArtifact> & { runId: string; artifact: TArtifact };
    stagedAt?: string;
  }): Promise<unknown>;
  recoverCurrentEpisode(runSetId: string): Promise<HarnessExperimentRunRecovery>;
  recordEpisode(input: {
    runSetId: string;
    episode: GenericTournamentRunSetEpisode<TArtifact>;
  }): Promise<unknown>;
  finalize(runSet: GenericTournamentRunSetArtifact<TArtifact>): Promise<unknown>;
}

export interface GenericExperimentEvaluationAdapter<
  TResult,
  TArtifact,
  TState,
  TMetrics,
  TSocialEpisode,
  TAgent,
  TTrajectory
> {
  /** Evaluators owned by this harness runtime. Required unless a domain
   * harness supplies its already-computed canonical report. */
  evaluators?: Array<
    HarnessEvaluator<TState, TMetrics, TSocialEpisode, unknown, TAgent, TTrajectory>
  >;
  contextForEpisode?(
    result: TResult,
    artifact: TArtifact,
    context: GenericExperimentEpisodeContext
  ): HarnessEvaluationContext<TState, TMetrics, TSocialEpisode, TAgent, TTrajectory>;
  /**
   * Reuse an evaluation report already produced by the domain harness. This
   * avoids running the same registry twice when a compatibility result (such
   * as Werewolf's HarnessRunResult) already owns the canonical report.
   */
  reportForEpisode?(
    result: TResult,
    artifact: TArtifact,
    context: GenericExperimentEpisodeContext
  ): HarnessEvaluationReport | Promise<HarnessEvaluationReport>;
}

/**
 * Domain seam used by the generic control plane. The adapter supplies domain
 * factories and artifact/evaluation projections; the orchestrator owns
 * normalization, deterministic seeds, lifecycle accounting, evaluator
 * selection, canonical persistence, and run-set materialization.
 */
export interface GenericExperimentExecutionAdapter<
  TPrepared,
  TResult,
  TArtifact extends GenericEpisodeEnvelope,
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown,
  TAgent = unknown,
  TTrajectory = unknown,
  TCheckpoint extends GenericCheckpointEnvelope = GenericCheckpointEnvelope
> {
  domainId: string;
  prepareEpisode(context: GenericExperimentEpisodeContext): TPrepared | Promise<TPrepared>;
  runEpisode(prepared: TPrepared, context: GenericExperimentEpisodeContext): TResult | Promise<TResult>;
  lifecycleOf(result: TResult): TournamentEpisodeLifecycle;
  artifactForEpisode(result: TResult, context: GenericExperimentEpisodeContext): TArtifact | Promise<TArtifact>;
  /**
   * Domain-owned assignment result for this exact episode. The control plane
   * stamps policy/configuration and episode identity, binds the rows to the
   * runtime actor roster, and persists the resulting execution evidence.
   */
  assignmentResolutionForEpisode?(
    result: TResult,
    artifact: TArtifact,
    context: GenericExperimentEpisodeContext
  ): readonly SocialAssignmentActorResolution[] | Promise<readonly SocialAssignmentActorResolution[]>;
  retrying?: {
    classifyAttemptError(
      error: unknown,
      context: GenericExperimentAttemptErrorContext
    ): GenericExperimentAttemptErrorClassification | Promise<GenericExperimentAttemptErrorClassification>;
  };
  artifactProjection?: {
    projectArtifact(
      artifact: TArtifact,
      visibility: HarnessEpisodeProjectionVisibility,
      context: GenericExperimentEpisodeContext
    ): HarnessEpisodeProjectionEnvelope | Promise<HarnessEpisodeProjectionEnvelope>;
    validateProjection(
      projection: HarnessEpisodeProjectionEnvelope,
      artifact: TArtifact,
      context: GenericExperimentEpisodeContext
    ): readonly string[] | Promise<readonly string[]>;
  };
  checkpointing?: {
    /** Deterministic, model-free derivation from an immutable canonical episode. */
    finalCheckpointForArtifact?(
      artifact: TArtifact,
      context: GenericExperimentEpisodeContext
    ): TCheckpoint | Promise<TCheckpoint>;
    /** Deterministic, model-free derivation at one harness-selected complete
     * native scheduler boundary. The harness, not the adapter, owns boundary
     * enumeration and completeness. */
    nativeCheckpointForArtifactBoundary?(
      artifact: TArtifact,
      boundary: GenericExperimentNativeCheckpointBoundary,
      context: GenericExperimentEpisodeContext
    ): TCheckpoint | Promise<TCheckpoint>;
  };
  evaluation?: GenericExperimentEvaluationAdapter<
    TResult,
    TArtifact,
    TState,
    TMetrics,
    TSocialEpisode,
    TAgent,
    TTrajectory
  >;
}

export interface ExecutedGenericExperimentEpisode<TArtifact> {
  status: TournamentEpisodeLifecycle;
  artifact: TArtifact;
  evaluationReport?: HarnessEvaluationReport;
}

export interface GenericExperimentPublicationEpisode {
  index: number;
  status: TournamentEpisodeLifecycle;
  runId?: string;
  /** Canonical manifest-bound derived sidecar. It is display/export evidence,
   * never replay, checkpoint, evaluator, or environment authority. */
  projection?: HarnessEpisodeProjectionEnvelope;
  error?: string;
}

export interface GenericExperimentPublicationResult {
  schemaVersion: typeof GENERIC_EXPERIMENT_PUBLICATION_VERSION;
  kind: "experiment-publication";
  visibility: HarnessEpisodeProjectionVisibility;
  artifactPolicy: {
    id: string;
    version: string;
  };
  domainId: string;
  runSetId: string;
  createdAt: string;
  /** Stable provenance reference without returning the normalized experiment. */
  specHash: string;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  gamesUnstarted: number;
  episodes: GenericExperimentPublicationEpisode[];
}

export interface GenericExperimentPublicationTournament {
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  gamesUnstarted: number;
  episodes: Array<Pick<GenericExperimentPublicationEpisode, "index" | "status" | "runId" | "error">>;
}

export interface GenericExperimentPublicationRunSet {
  artifactVersion: typeof GENERIC_EXPERIMENT_PUBLICATION_RUN_SET_VERSION;
  kind: "tournament-run-set-publication";
  domainId: string;
  runSetId: string;
  createdAt: string;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  gamesUnstarted: number;
  episodes: Array<Pick<GenericExperimentPublicationEpisode, "index" | "status" | "runId" | "error">>;
}

/** Runtime shape returned for public/postgame-redacted policies. It deliberately
 * has no normalized spec, experiment provenance, canonical artifact, evaluation
 * report, or seed. */
export interface GenericExperimentRestrictedExecutionResult {
  specHash: string;
  tournament: GenericExperimentPublicationTournament;
  runSet: GenericExperimentPublicationRunSet;
  publication: GenericExperimentPublicationResult;
}

export interface RunGenericExperimentOptions<
  TPrepared,
  TResult,
  TArtifact extends GenericEpisodeEnvelope,
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown,
  TAgent = unknown,
  TTrajectory = unknown,
  TCheckpoint extends GenericCheckpointEnvelope = GenericCheckpointEnvelope
> {
  spec: GenericExperimentSpecV1 | NormalizedGenericExperimentSpecV1;
  adapter: GenericExperimentExecutionAdapter<
    TPrepared,
    TResult,
    TArtifact,
    TState,
    TMetrics,
    TSocialEpisode,
    TAgent,
    TTrajectory,
    TCheckpoint
  >;
  artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  runStore: GenericExperimentRunStore<TArtifact>;
  abortSignal?: AbortSignal;
  now?: () => string;
  runSetId?: string;
}

export interface GenericExperimentExecutionResult<TArtifact> {
  normalizedSpec: NormalizedGenericExperimentSpecV1;
  experiment: GenericExperimentProvenanceV1;
  specHash: string;
  /** Safe lifecycle/result projection; runtime preparation objects and raw domain results are never exposed. */
  tournament: GenericTournamentResult<never, ExecutedGenericExperimentEpisode<TArtifact>>;
  runSet: GenericTournamentRunSetArtifact<TArtifact>;
  /** Present only for a non-research publication policy. The runtime returns the
   * restricted shape documented by GenericExperimentRestrictedExecutionResult. */
  publication?: GenericExperimentPublicationResult;
}

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

async function buildGenericExperimentPublication<TArtifact extends GenericEpisodeEnvelope>(input: {
  runSet: GenericTournamentRunSetArtifact<TArtifact>;
  spec: NormalizedGenericExperimentSpecV1;
  specHash: string;
  artifactStore: GenericExperimentArtifactStore<TArtifact>;
  abortSignal: AbortSignal;
}): Promise<GenericExperimentPublicationResult> {
  const visibility = input.spec.artifactPolicy.visibility;
  if (visibility === "research-full") {
    throw new Error("Research-full execution must not materialize a redacted publication result.");
  }
  const getProjection = input.artifactStore.getProjection?.bind(input.artifactStore);
  if (!getProjection) throw new Error("Canonical projection read authority disappeared after finalization.");
  const episodes: GenericExperimentPublicationEpisode[] = [];
  for (const episode of input.runSet.episodes) {
    let projection: HarnessEpisodeProjectionEnvelope | undefined;
    if (episode.artifact) {
      projection = await awaitWithAbort(
        () => getProjection(episode.artifact!.runId),
        input.abortSignal
      );
      if (!projection) throw new Error("Finalized episode is missing its canonical artifact projection sidecar.");
      const errors = validateHarnessEpisodeProjectionEnvelope(projection);
      if (errors.length) throw new Error(`Canonical artifact projection is invalid: ${errors.join(" ")}`);
      assertProjectionPolicyBinding(projection, episode.artifact, input.spec);
    }
    episodes.push({
      index: episode.index,
      status: episode.status,
      ...(episode.runId === undefined ? {} : { runId: episode.runId }),
      ...(projection === undefined ? {} : { projection: structuredClone(projection) }),
      ...(episode.error === undefined ? {} : { error: episode.error })
    });
  }
  return {
    schemaVersion: GENERIC_EXPERIMENT_PUBLICATION_VERSION,
    kind: "experiment-publication",
    visibility,
    artifactPolicy: {
      id: input.spec.artifactPolicy.id,
      version: input.spec.artifactPolicy.version
    },
    domainId: input.runSet.domainId,
    runSetId: input.runSet.runSetId,
    createdAt: input.runSet.createdAt,
    specHash: input.specHash,
    gamesRequested: input.runSet.gamesRequested,
    gamesCompleted: input.runSet.gamesCompleted,
    gamesTruncated: input.runSet.gamesTruncated,
    gamesFailed: input.runSet.gamesFailed,
    gamesUnstarted: input.runSet.gamesUnstarted ?? 0,
    episodes
  };
}

function restrictedExperimentExecutionResult(
  publication: GenericExperimentPublicationResult
): GenericExperimentRestrictedExecutionResult {
  const episodes = publication.episodes.map(({ projection: _projection, ...episode }) => structuredClone(episode));
  const lifecycle = {
    gamesRequested: publication.gamesRequested,
    gamesCompleted: publication.gamesCompleted,
    gamesTruncated: publication.gamesTruncated,
    gamesFailed: publication.gamesFailed,
    gamesUnstarted: publication.gamesUnstarted
  };
  return {
    specHash: publication.specHash,
    tournament: {
      ...lifecycle,
      episodes: structuredClone(episodes)
    },
    runSet: {
      artifactVersion: GENERIC_EXPERIMENT_PUBLICATION_RUN_SET_VERSION,
      kind: "tournament-run-set-publication",
      domainId: publication.domainId,
      runSetId: publication.runSetId,
      createdAt: publication.createdAt,
      ...lifecycle,
      episodes: structuredClone(episodes)
    },
    publication: structuredClone(publication)
  };
}

function assertControlPolicyRuntime<
  TArtifact extends GenericEpisodeEnvelope
>(
  options: {
    adapter: Pick<GenericExperimentExecutionAdapter<unknown, unknown, TArtifact>, "retrying">;
    runStore: Pick<GenericExperimentRunStore<TArtifact>, "scheduleEpisodeRetry">;
  },
  spec: NormalizedGenericExperimentSpecV1
): void {
  if (spec.retryPolicy.maxAttempts === 1) return;
  if (typeof options.adapter.retrying?.classifyAttemptError !== "function") {
    throw new Error("Generic experiment multi-attempt retry requires a domain-owned attempt error classifier.");
  }
  if (typeof options.runStore.scheduleEpisodeRetry !== "function") {
    throw new Error("Generic experiment multi-attempt retry requires durable retry scheduling authority.");
  }
}

function assertArtifactProjectionRuntime<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(
  options: {
    adapter: Pick<GenericExperimentExecutionAdapter<unknown, unknown, TArtifact>, "artifactProjection">;
    artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  },
  spec: NormalizedGenericExperimentSpecV1
): void {
  if (spec.artifactPolicy.visibility === "research-full") return;
  if (typeof options.adapter.artifactProjection?.projectArtifact !== "function") {
    throw new Error(
      `Generic experiment artifactPolicy ${spec.artifactPolicy.visibility} requires a domain artifact projector.`
    );
  }
  if (typeof options.adapter.artifactProjection.validateProjection !== "function") {
    throw new Error(
      `Generic experiment artifactPolicy ${spec.artifactPolicy.visibility} requires a domain projection validator.`
    );
  }
  if (typeof options.artifactStore.getProjection !== "function") {
    throw new Error(
      `Generic experiment artifactPolicy ${spec.artifactPolicy.visibility} requires canonical projection read authority.`
    );
  }
}

async function buildArtifactProjection<TArtifact extends GenericEpisodeEnvelope>(input: {
  artifact: TArtifact;
  context: GenericExperimentEpisodeContext;
  adapter: Pick<GenericExperimentExecutionAdapter<unknown, unknown, TArtifact>, "artifactProjection">;
  spec: NormalizedGenericExperimentSpecV1;
  abortSignal: AbortSignal;
}): Promise<HarnessEpisodeProjectionEnvelope> {
  const projectionAdapter = input.adapter.artifactProjection;
  if (!projectionAdapter) throw new Error("Generic experiment artifact projection runtime disappeared after preflight.");
  const visibility = input.spec.artifactPolicy.visibility;
  if (visibility === "research-full") throw new Error("Research-full artifacts must not create a derived projection sidecar.");
  const context = detachedEpisodeContext(input.context);
  const candidate = await awaitWithAbort(
    () => projectionAdapter.projectArtifact(
      structuredClone(input.artifact),
      visibility,
      structuredClone(context)
    ),
    input.abortSignal
  );
  const envelopeErrors = validateHarnessEpisodeProjectionEnvelope(candidate);
  if (envelopeErrors.length) {
    throw new Error(`Domain artifact projector returned an invalid projection: ${envelopeErrors.join(" ")}`);
  }
  const projection = structuredClone(candidate);
  assertProjectionPolicyBinding(projection, input.artifact, input.spec);
  const validation = await awaitWithAbort(
    () => projectionAdapter.validateProjection(
      structuredClone(projection),
      structuredClone(input.artifact),
      structuredClone(context)
    ),
    input.abortSignal
  );
  if (!Array.isArray(validation) || validation.some((error) => typeof error !== "string")) {
    throw new Error("Domain projection validator must return an array of error strings.");
  }
  if (validation.length) {
    throw new Error(`Domain projection validator rejected the projection: ${validation.join(" ")}`);
  }
  return projection;
}

async function assertCanonicalProjectionSidecars<TArtifact extends GenericEpisodeEnvelope>(input: {
  episodes: Array<{ result?: ExecutedGenericExperimentEpisode<TArtifact> }>;
  artifactStore: GenericExperimentArtifactStore<TArtifact>;
  spec: NormalizedGenericExperimentSpecV1;
  abortSignal: AbortSignal;
}): Promise<void> {
  if (input.spec.artifactPolicy.visibility === "research-full") return;
  const getProjection = input.artifactStore.getProjection?.bind(input.artifactStore);
  if (!getProjection) throw new Error("Canonical projection read authority disappeared after preflight.");
  for (const episode of input.episodes) {
    if (!episode.result) continue;
    const projection = await awaitWithAbort(
      () => getProjection(episode.result!.artifact.runId),
      input.abortSignal
    );
    if (!projection) throw new Error("Committed episode is missing its canonical artifact projection sidecar.");
    const errors = validateHarnessEpisodeProjectionEnvelope(projection);
    if (errors.length) throw new Error(`Canonical artifact projection is invalid: ${errors.join(" ")}`);
    assertProjectionPolicyBinding(projection, episode.result.artifact, input.spec);
  }
}

function assertProjectionPolicyBinding(
  projection: HarnessEpisodeProjectionEnvelope,
  artifact: GenericEpisodeEnvelope,
  spec: NormalizedGenericExperimentSpecV1
): void {
  if (
    projection.source.runId !== artifact.runId ||
    projection.source.artifactSha256 !== deriveHarnessEpisodeArtifactSha256(artifact)
  ) {
    throw new Error("Artifact projection source does not match the canonical full artifact.");
  }
  if (
    projection.source.visibility !== spec.artifactPolicy.visibility ||
    projection.source.policyId !== spec.artifactPolicy.id ||
    projection.source.policyVersion !== spec.artifactPolicy.version
  ) {
    throw new Error("Artifact projection policy binding does not match the normalized experiment spec.");
  }
}

function detachedEpisodeContext(context: GenericExperimentEpisodeContext): GenericExperimentEpisodeContext {
  return {
    ...context,
    spec: structuredClone(context.spec),
    experiment: structuredClone(context.experiment)
  };
}

function assertCheckpointPolicyRuntime<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(
  options: {
    adapter: { checkpointing?: GenericCheckpointingAdapter<TArtifact, TCheckpoint> };
    artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  },
  spec: NormalizedGenericExperimentSpecV1
): void {
  if (spec.checkpointPolicy.mode === "none") return;
  if (
    spec.checkpointPolicy.mode === "final" &&
    !options.adapter.checkpointing?.finalCheckpointForArtifact
  ) {
    throw new Error("Generic experiment checkpointPolicy final requires a deterministic final checkpoint builder.");
  }
  if (
    spec.checkpointPolicy.mode === "native-boundaries" &&
    !options.adapter.checkpointing?.nativeCheckpointForArtifactBoundary
  ) {
    throw new Error(
      "Generic experiment checkpointPolicy native-boundaries requires a deterministic native-boundary checkpoint builder."
    );
  }
  if (
    typeof options.artifactStore.putCheckpoint !== "function" ||
    typeof options.artifactStore.getCheckpoint !== "function"
  ) {
    throw new Error(
      `Generic experiment checkpointPolicy ${spec.checkpointPolicy.mode} requires canonical checkpoint read/write authority.`
    );
  }
}

interface GenericCheckpointingAdapter<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
> {
  finalCheckpointForArtifact?(
    artifact: TArtifact,
    context: GenericExperimentEpisodeContext
  ): TCheckpoint | Promise<TCheckpoint>;
  nativeCheckpointForArtifactBoundary?(
    artifact: TArtifact,
    boundary: GenericExperimentNativeCheckpointBoundary,
    context: GenericExperimentEpisodeContext
  ): TCheckpoint | Promise<TCheckpoint>;
}

async function ensurePolicyCheckpointsForEpisodes<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(input: {
  episodes: Array<{
    index: number;
    seed: string;
    result?: ExecutedGenericExperimentEpisode<TArtifact>;
  }>;
  options: {
    adapter: { checkpointing?: GenericCheckpointingAdapter<TArtifact, TCheckpoint> };
    artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  };
  spec: NormalizedGenericExperimentSpecV1;
  experiment: GenericExperimentProvenanceV1;
  abortSignal: AbortSignal;
}): Promise<void> {
  if (input.spec.checkpointPolicy.mode === "none") return;
  for (const episode of input.episodes) {
    if (!episode.result) continue;
    await ensurePolicyCheckpointsForArtifact({
      artifact: episode.result.artifact,
      context: createEpisodeContext(episode, input.spec, input.experiment, input.abortSignal),
      options: input.options,
      spec: input.spec
    });
  }
}

async function ensurePolicyCheckpointsForArtifact<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(input: {
  artifact: TArtifact;
  context: GenericExperimentEpisodeContext;
  options: {
    adapter: { checkpointing?: GenericCheckpointingAdapter<TArtifact, TCheckpoint> };
    artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  };
  spec: NormalizedGenericExperimentSpecV1;
}): Promise<void> {
  if (input.spec.checkpointPolicy.mode === "none") return;
  const getCheckpoint = input.options.artifactStore.getCheckpoint?.bind(input.options.artifactStore);
  const putCheckpoint = input.options.artifactStore.putCheckpoint?.bind(input.options.artifactStore);
  if (!getCheckpoint || !putCheckpoint) {
    throw new Error("Generic experiment checkpoint authority disappeared after preflight validation.");
  }
  const expectedExperiment = structuredClone(input.context.experiment);
  const checkpointContext: GenericExperimentEpisodeContext = {
    ...input.context,
    spec: structuredClone(input.context.spec),
    experiment: structuredClone(expectedExperiment)
  };

  if (input.spec.checkpointPolicy.mode === "final") {
    const builder = input.options.adapter.checkpointing?.finalCheckpointForArtifact;
    if (!builder) throw new Error("Generic experiment final checkpoint builder disappeared after preflight validation.");
    const checkpoint = structuredClone(await awaitWithAbort(
      () => builder(structuredClone(input.artifact), structuredClone(checkpointContext)),
      input.context.abortSignal
    ));
    assertFinalCheckpointBinding(checkpoint, input.artifact, expectedExperiment);
    await publishCheckpointCandidate({
      checkpoint,
      artifact: input.artifact,
      experiment: expectedExperiment,
      getCheckpoint,
      putCheckpoint,
      abortSignal: input.context.abortSignal,
      assertBinding: assertFinalCheckpointBinding,
      policyLabel: "final"
    });
    return;
  }

  const builder = input.options.adapter.checkpointing?.nativeCheckpointForArtifactBoundary;
  if (!builder) throw new Error("Generic experiment native-boundary checkpoint builder disappeared after preflight validation.");
  for (const [stepIndex, step] of input.artifact.socialEpisode.steps.entries()) {
    if (!isSocialStepCommitted(step) || !isSafeHarnessCheckpointBoundary(input.artifact.socialEpisode.steps, stepIndex)) {
      continue;
    }
    const boundary: GenericExperimentNativeCheckpointBoundary = {
      nativeStepCount: stepIndex + 1,
      traceId: step.traceId
    };
    const checkpoint = structuredClone(await awaitWithAbort(
      () => builder(
        structuredClone(input.artifact),
        structuredClone(boundary),
        structuredClone(checkpointContext)
      ),
      input.context.abortSignal
    ));
    assertNativeCheckpointBinding(checkpoint, input.artifact, expectedExperiment, boundary);
    await publishCheckpointCandidate({
      checkpoint,
      artifact: input.artifact,
      experiment: expectedExperiment,
      getCheckpoint,
      putCheckpoint,
      abortSignal: input.context.abortSignal,
      assertBinding: (candidate, artifact, experiment) =>
        assertNativeCheckpointBinding(candidate, artifact, experiment, boundary),
      policyLabel: "native-boundary"
    });
  }
}

async function publishCheckpointCandidate<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(input: {
  checkpoint: TCheckpoint;
  artifact: TArtifact;
  experiment: GenericExperimentProvenanceV1;
  getCheckpoint(runId: string, checkpointId: string): Promise<TCheckpoint | undefined>;
  putCheckpoint(runId: string, checkpoint: TCheckpoint): Promise<unknown>;
  abortSignal: AbortSignal;
  assertBinding(
    checkpoint: GenericCheckpointEnvelope,
    artifact: GenericEpisodeEnvelope,
    experiment: GenericExperimentProvenanceV1
  ): void;
  policyLabel: "final" | "native-boundary";
}): Promise<void> {
  const { checkpoint } = input;
  const candidateHash = hashStableJsonValue(checkpoint);
  const existing = await awaitWithAbort(
    () => input.getCheckpoint(input.artifact.runId, checkpoint.checkpointId),
    input.abortSignal
  );
  if (existing !== undefined) {
    input.assertBinding(existing, input.artifact, input.experiment);
    if (hashStableJsonValue(existing) !== candidateHash) {
      throw new Error(
        `Canonical ${input.policyLabel} checkpoint identity conflicts with the deterministic checkpoint candidate.`
      );
    }
    return;
  }
  throwIfAborted(input.abortSignal);
  // Canonical mutation is deliberately awaited to completion while the run
  // lease is held. Racing an irreversible store write against abort could
  // release the lease while publication is still in flight.
  await input.putCheckpoint(input.artifact.runId, checkpoint);
  const published = await awaitWithAbort(
    () => input.getCheckpoint(input.artifact.runId, checkpoint.checkpointId),
    input.abortSignal
  );
  if (published === undefined || hashStableJsonValue(published) !== candidateHash) {
    throw new Error(`Canonical ${input.policyLabel} checkpoint publication could not be verified.`);
  }
  input.assertBinding(published, input.artifact, input.experiment);
}

function assertFinalCheckpointBinding(
  checkpoint: GenericCheckpointEnvelope,
  artifact: GenericEpisodeEnvelope,
  experiment: GenericExperimentProvenanceV1
): void {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new Error("Final checkpoint builder must return a checkpoint envelope.");
  }
  if (!checkpoint.checkpointId?.trim() || !checkpoint.createdAt?.trim()) {
    throw new Error("Final checkpoint identity and createdAt are required.");
  }
  if (
    checkpoint.source.runId !== artifact.runId ||
    checkpoint.source.sourceArtifactVersion !== artifact.artifactVersion ||
    checkpoint.source.status !== artifact.status
  ) {
    throw new Error("Final checkpoint source identity does not match its canonical episode artifact.");
  }
  if (
    checkpoint.source.nativeStepCount !== artifact.socialEpisode.steps.length ||
    checkpoint.executionPrefix.steps.length !== artifact.socialEpisode.steps.length ||
    checkpoint.source.messageCount !== artifact.socialEpisode.messages.length ||
    checkpoint.executionPrefix.messages.length !== artifact.socialEpisode.messages.length
  ) {
    throw new Error("Final checkpoint is not the complete native episode boundary.");
  }
  if (
    hashStableState(checkpoint.executionPrefix.steps) !== hashStableState(artifact.socialEpisode.steps) ||
    hashStableState(checkpoint.executionPrefix.messages) !== hashStableState(artifact.socialEpisode.messages) ||
    hashStableState(checkpoint.state) !== hashStableState(artifact.finalState) ||
    hashStableState(checkpoint.agents) !== hashStableState(artifact.agents) ||
    hashStableState(checkpoint.executionPrefix.initialState) !== hashStableState(artifact.socialEpisode.initialState) ||
    hashStableState(checkpoint.executionPrefix.finalState) !== hashStableState(artifact.socialEpisode.finalState) ||
    hashStableState(checkpoint.executionPrefix.channels) !== hashStableState(artifact.socialEpisode.channels) ||
    hashStableState(checkpoint.executionPrefix.runtimeActorIds) !== hashStableState(artifact.socialEpisode.runtimeActorIds) ||
    checkpoint.executionPrefix.domainId !== artifact.socialEpisode.domainId ||
    checkpoint.executionPrefix.schedulerMode !== artifact.socialEpisode.schedulerMode
  ) {
    throw new Error("Final checkpoint state or execution prefix does not match its canonical episode artifact.");
  }
  if (
    hashStableState(normalizeFinalCheckpointPrefix(checkpoint.executionPrefix)) !==
    hashStableState(normalizeFinalCheckpointPrefix(artifact.socialEpisode))
  ) {
    throw new Error("Final checkpoint execution prefix is not an exact canonical episode projection.");
  }
  if (
    artifact.experiment === undefined ||
    hashStableJsonValue(artifact.experiment) !== hashStableJsonValue(experiment) ||
    checkpoint.source.experiment === undefined ||
    hashStableJsonValue(checkpoint.source.experiment) !== hashStableJsonValue(experiment)
  ) {
    throw new Error("Final checkpoint experiment provenance does not match its canonical episode artifact.");
  }
}

function assertNativeCheckpointBinding(
  checkpoint: GenericCheckpointEnvelope,
  artifact: GenericEpisodeEnvelope,
  experiment: GenericExperimentProvenanceV1,
  boundary: GenericExperimentNativeCheckpointBoundary
): void {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new Error("Native-boundary checkpoint builder must return a checkpoint envelope.");
  }
  const envelopeErrors = validateHarnessCheckpointEnvelope(checkpoint);
  if (envelopeErrors.length) {
    throw new Error(`Native-boundary checkpoint envelope is invalid: ${envelopeErrors.join(" ")}`);
  }
  if (!checkpoint.checkpointId?.trim() || !checkpoint.createdAt?.trim()) {
    throw new Error("Native-boundary checkpoint identity and createdAt are required.");
  }
  const stepIndex = boundary.nativeStepCount - 1;
  const sourceStep = artifact.socialEpisode.steps[stepIndex];
  if (
    !sourceStep ||
    sourceStep.traceId !== boundary.traceId ||
    !isSocialStepCommitted(sourceStep) ||
    !isSafeHarnessCheckpointBoundary(artifact.socialEpisode.steps, stepIndex)
  ) {
    throw new Error("Native-boundary checkpoint no longer matches a harness-selected committed scheduler boundary.");
  }
  if (!sourceStep.actorSnapshotsHashAfterStep) {
    throw new Error("Native-boundary checkpoint requires a durable actor snapshot at the selected boundary.");
  }

  const expectedSteps = structuredClone(artifact.socialEpisode.steps.slice(0, boundary.nativeStepCount));
  const maxMessageSeq = latestMessageSeqForHarnessPrefix(artifact.socialEpisode, expectedSteps);
  const expectedMessages = structuredClone(
    artifact.socialEpisode.messages.filter((message) => message.seq <= maxMessageSeq)
  );
  const expectedLastMessageSeq = expectedMessages.at(-1)?.seq;
  if (
    checkpoint.source.runId !== artifact.runId ||
    checkpoint.source.sourceArtifactVersion !== artifact.artifactVersion ||
    checkpoint.source.status !== artifact.status ||
    checkpoint.source.nativeStepCount !== boundary.nativeStepCount ||
    checkpoint.source.messageCount !== expectedMessages.length ||
    checkpoint.source.lastMessageSeq !== expectedLastMessageSeq ||
    checkpoint.source.boundaryTraceId !== sourceStep.traceId ||
    checkpoint.source.boundaryTurnIndex !== sourceStep.turnIndex ||
    checkpoint.source.boundaryBatchId !== sourceStep.batchId ||
    checkpoint.source.boundaryBatchIndex !== sourceStep.batchIndex ||
    checkpoint.source.boundarySchedulerMode !== sourceStep.schedulerMode
  ) {
    throw new Error("Native-boundary checkpoint source identity does not match its canonical episode prefix.");
  }
  if (
    checkpoint.executionPrefix.status !== "truncated" ||
    checkpoint.executionPrefix.truncationReason !==
      `checkpoint boundary after native step ${boundary.nativeStepCount}` ||
    checkpoint.executionPrefix.terminationReason !== undefined ||
    checkpoint.executionPrefix.failureReason !== undefined ||
    checkpoint.executionPrefix.error !== undefined
  ) {
    throw new Error("Native-boundary checkpoint lifecycle is not the canonical truncated prefix projection.");
  }

  const checkpointStateHash = hashStableState(checkpoint.state);
  const checkpointAgentsHash = hashStableState(checkpoint.agents);
  if (
    hashStableState(checkpoint.executionPrefix.steps) !== hashStableState(expectedSteps) ||
    hashStableState(checkpoint.executionPrefix.messages) !== hashStableState(expectedMessages) ||
    hashStableState(checkpoint.executionPrefix.initialState) !== hashStableState(artifact.socialEpisode.initialState) ||
    hashStableState(checkpoint.executionPrefix.finalState) !== checkpointStateHash ||
    hashStableState(checkpoint.executionPrefix.channels) !== hashStableState(artifact.socialEpisode.channels) ||
    hashStableState(checkpoint.executionPrefix.runtimeActorIds) !== hashStableState(artifact.socialEpisode.runtimeActorIds) ||
    checkpoint.executionPrefix.domainId !== artifact.socialEpisode.domainId ||
    checkpoint.executionPrefix.schedulerMode !== artifact.socialEpisode.schedulerMode ||
    checkpointAgentsHash !== sourceStep.actorSnapshotsHashAfterStep ||
    checkpoint.source.agentSnapshotFrameId !== sourceStep.actorSnapshotFrameIdAfterStep
  ) {
    throw new Error("Native-boundary checkpoint state, agents, or execution prefix drifted from canonical authority.");
  }

  const expectedPrefix = structuredClone(artifact.socialEpisode);
  expectedPrefix.status = "truncated";
  expectedPrefix.terminationReason = undefined;
  expectedPrefix.truncationReason = `checkpoint boundary after native step ${boundary.nativeStepCount}`;
  expectedPrefix.failureReason = undefined;
  expectedPrefix.error = undefined;
  expectedPrefix.finalState = structuredClone(checkpoint.state);
  expectedPrefix.steps = expectedSteps;
  expectedPrefix.messages = expectedMessages;
  expectedPrefix.exposureRecords = undefined;
  expectedPrefix.exposureSummary = undefined;
  expectedPrefix.metrics = undefined;
  if (
    hashStableState(checkpoint.executionPrefix) !== hashStableState(expectedPrefix) ||
    checkpoint.source.stateHash !== checkpointStateHash ||
    checkpoint.source.executionPrefixHash !== hashStableState(checkpoint.executionPrefix) ||
    checkpoint.source.agentsHash !== checkpointAgentsHash ||
    checkpoint.source.channelsHash !== hashStableState(checkpoint.executionPrefix.channels) ||
    checkpoint.source.messagesHash !== hashStableState(checkpoint.executionPrefix.messages) ||
    hashStableState(checkpoint.source.domainAdapter) !== hashStableState(checkpoint.executionPrefix.domainAdapter)
  ) {
    throw new Error("Native-boundary checkpoint hashes or exact canonical prefix projection are invalid.");
  }
  if (
    artifact.experiment === undefined ||
    hashStableJsonValue(artifact.experiment) !== hashStableJsonValue(experiment) ||
    checkpoint.source.experiment === undefined ||
    hashStableJsonValue(checkpoint.source.experiment) !== hashStableJsonValue(experiment)
  ) {
    throw new Error("Native-boundary checkpoint experiment provenance does not match its canonical episode artifact.");
  }
}

function normalizeFinalCheckpointPrefix(prefix: unknown): unknown {
  const normalized = structuredClone(prefix) as Record<string, unknown>;
  // Werewolf keeps exposure evidence in the immutable episode artifact while
  // the generic checkpoint envelope intentionally carries only replay/fork
  // execution authority. These are the only permitted projection omissions.
  delete normalized.exposureRecords;
  delete normalized.exposureSummary;
  return normalized;
}

function tournamentFromDurableRecord<TArtifact>(
  record: HarnessExperimentRunRecord,
  episodes: Array<{
    index: number;
    seed: string;
    status: TournamentEpisodeLifecycle;
    result?: ExecutedGenericExperimentEpisode<TArtifact>;
    error?: string;
  }>
): GenericTournamentResult<never, ExecutedGenericExperimentEpisode<TArtifact>> {
  if (record.state !== "finalized" || episodes.length !== record.episodes.length) {
    throw new Error("Only finalized durable experiment authority can materialize a terminal tournament projection.");
  }
  const completed = episodes.filter((episode) => episode.status === "completed").length;
  const truncated = episodes.filter((episode) => episode.status === "truncated").length;
  const failed = episodes.filter((episode) => episode.status === "failed").length;
  if (
    completed !== record.gamesCompleted ||
    truncated !== record.gamesTruncated ||
    failed !== record.gamesFailed ||
    record.gamesRequested - episodes.length !== record.gamesUnstarted
  ) {
    throw new Error("Finalized durable experiment lifecycle counts do not match its episode prefix.");
  }
  return {
    seed: record.experiment.spec.seed,
    gamesRequested: record.gamesRequested,
    gamesCompleted: completed,
    gamesTruncated: truncated,
    gamesFailed: failed,
    gamesUnstarted: record.gamesUnstarted,
    episodes: structuredClone(episodes)
  };
}

function assertResumedExperiment(
  record: HarnessExperimentRunRecord,
  runSetId: string,
  experiment: GenericExperimentProvenanceV1
): void {
  if (record.runSetId !== runSetId || hashStableJsonValue(record.experiment) !== hashStableJsonValue(experiment)) {
    throw new Error("Durable experiment run authority does not match the requested experiment.");
  }
  if (
    record.state === "active" &&
    record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 &&
    record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3
  ) {
    throw new Error("Active legacy experiment authority cannot be resumed safely.");
  }
}

async function hydrateCommittedEpisodes<TArtifact extends GenericEpisodeEnvelope>(
  record: HarnessExperimentRunRecord,
  spec: NormalizedGenericExperimentSpecV1,
  artifactStore: GenericExperimentArtifactStore<TArtifact>,
  abortSignal: AbortSignal
): Promise<Array<{
  index: number;
  seed: string;
  status: TournamentEpisodeLifecycle;
  result?: ExecutedGenericExperimentEpisode<TArtifact>;
  error?: string;
}>> {
  const hydrated: Array<{
    index: number;
    seed: string;
    status: TournamentEpisodeLifecycle;
    result?: ExecutedGenericExperimentEpisode<TArtifact>;
    error?: string;
  }> = [];
  const runIds = new Set<string>();
  for (const [index, reference] of record.episodes.entries()) {
    const expectedSeed = `${record.experiment.spec.seed}:g${index + 1}`;
    if (reference.index !== index || reference.seed !== expectedSeed) {
      throw new Error("Durable experiment episode prefix is not contiguous or seed-bound.");
    }
    if (!reference.runId) {
      hydrated.push({
        index,
        seed: reference.seed,
        status: "failed",
        error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE
      });
      continue;
    }
    const runId = reference.runId;
    if (runIds.has(runId)) {
      throw new Error("Durable experiment episode prefix contains a duplicate runId.");
    }
    runIds.add(runId);
    const artifact = await awaitWithAbort(
      () => artifactStore.get(runId),
      abortSignal
    );
    if (!artifact) throw new Error(`Canonical episode ${runId} is missing during experiment resume.`);
    if (
      artifact.runId !== runId ||
      artifact.status !== reference.status ||
      hashStableJsonValue(artifact) !== reference.artifactSha256 ||
      !artifact.experiment ||
      hashStableJsonValue(artifact.experiment) !== hashStableJsonValue(record.experiment)
    ) {
      throw new Error(`Canonical episode ${runId} drifted from durable experiment membership.`);
    }
    assertArtifactBinding(artifact, spec, reference.status, { index, seed: reference.seed });
    const evaluationReport = await awaitWithAbort(
      () => artifactStore.getEvaluationReport(runId),
      abortSignal
    );
    if (
      (evaluationReport === undefined) !== (reference.evaluationReportId === undefined) ||
      (evaluationReport !== undefined && (
        evaluationReport.id !== reference.evaluationReportId ||
        hashStableJsonValue(evaluationReport) !== reference.evaluationReportSha256
      ))
    ) {
      throw new Error(`Canonical episode ${runId} evaluation report drifted during experiment resume.`);
    }
    hydrated.push({
      index,
      seed: reference.seed,
      status: reference.status,
      result: {
        status: reference.status,
        artifact: structuredClone(artifact),
        ...(evaluationReport ? { evaluationReport: structuredClone(evaluationReport) } : {})
      },
      ...(reference.status === "failed"
        ? { error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE }
        : {})
    });
  }
  return hydrated;
}

function stripRuntimeTournamentState<TPrepared, TArtifact>(
  tournament: GenericTournamentResult<TPrepared, ExecutedGenericExperimentEpisode<TArtifact>>
): GenericTournamentResult<never, ExecutedGenericExperimentEpisode<TArtifact>> {
  return {
    seed: tournament.seed,
    gamesRequested: tournament.gamesRequested,
    gamesCompleted: tournament.gamesCompleted,
    gamesTruncated: tournament.gamesTruncated,
    gamesFailed: tournament.gamesFailed,
    gamesUnstarted: tournament.gamesUnstarted,
    episodes: tournament.episodes.map(({ prepared: _prepared, ...episode }) => structuredClone(episode))
  };
}

function resolveEvaluators<
  TState,
  TMetrics,
  TSocialEpisode,
  TAgent,
  TTrajectory
>(
  spec: NormalizedGenericExperimentSpecV1,
  available: Array<HarnessEvaluator<TState, TMetrics, TSocialEpisode, unknown, TAgent, TTrajectory>>
): Array<HarnessEvaluator<TState, TMetrics, TSocialEpisode, unknown, TAgent, TTrajectory>> {
  const byId = new Map<string, HarnessEvaluator<TState, TMetrics, TSocialEpisode, unknown, TAgent, TTrajectory>>();
  for (const evaluator of available) {
    if (byId.has(evaluator.id)) throw new Error(`Generic experiment evaluator registry contains duplicate id ${evaluator.id}.`);
    byId.set(evaluator.id, evaluator);
  }
  const missing = spec.evaluatorIds.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`Generic experiment evaluator registry is missing: ${missing.join(", ")}.`);
  return spec.evaluatorIds.map((id) => byId.get(id)!);
}

function assertArtifactBinding(
  artifact: GenericEpisodeEnvelope,
  spec: NormalizedGenericExperimentSpecV1,
  status: TournamentEpisodeLifecycle,
  context: TournamentEpisodeContext
): void {
  if (!artifact || typeof artifact !== "object") throw new Error("Generic experiment adapter did not return an episode artifact.");
  if (artifact.status !== status || artifact.socialEpisode.status !== status) {
    throw new Error(`Generic experiment episode ${context.index} lifecycle does not match its canonical artifact.`);
  }
  if (artifact.socialEpisode.domainId !== spec.domainId) {
    throw new Error(`Generic experiment episode ${context.index} artifact domainId does not match the normalized spec.`);
  }
  if (artifact.socialEpisode.schedulerMode !== spec.schedulerMode) {
    throw new Error(`Generic experiment episode ${context.index} scheduler does not match the normalized spec.`);
  }
  const socialStructureErrors = validateSocialEpisodeArtifact(artifact.socialEpisode);
  if (socialStructureErrors.length) {
    throw new Error(
      `Generic experiment episode ${context.index} social artifact structure failed: ${socialStructureErrors.join(" ")}`
    );
  }
  if (
    !artifact.socialEpisode.runtimeActorIds ||
    artifact.socialEpisode.runtimeActorIds.length !== spec.actorCount
  ) {
    throw new Error(`Generic experiment episode ${context.index} runtime actor count does not match the normalized spec.`);
  }
  const executionEvidenceErrors = validateGenericExperimentExecutionEvidence(
    spec,
    artifact.socialEpisode,
    `episode ${context.index} socialEpisode`
  );
  if (executionEvidenceErrors.length) {
    throw new Error(`Generic experiment episode ${context.index} execution binding failed: ${executionEvidenceErrors.join(" ")}`);
  }
  if (!artifact.executionAttestation) {
    throw new Error(`Generic experiment episode ${context.index} is missing its execution attestation.`);
  }
  const attestationErrors = validateGenericExperimentExecutionAttestation(
    artifact.executionAttestation,
    spec,
    artifact.socialEpisode,
    `episode ${context.index} executionAttestation`
  );
  if (attestationErrors.length) {
    throw new Error(`Generic experiment episode ${context.index} execution attestation failed: ${attestationErrors.join(" ")}`);
  }
  const adapterErrors = compareSocialDomainAdapterManifests(
    spec.domainAdapter,
    artifact.socialEpisode.domainAdapter,
    { recordedPath: "normalized experiment adapter", runtimePath: "episode artifact adapter" }
  );
  if (adapterErrors.length) {
    throw new Error(`Generic experiment episode ${context.index} adapter binding failed: ${adapterErrors.join(" ")}`);
  }
}

/**
 * Adapters build domain artifacts; the control plane owns experiment identity.
 * A legacy-style unbound artifact is copied and bound here. An adapter that
 * already supplied provenance must match exactly, so this never overwrites a
 * contradictory claim.
 */
function bindArtifactToExperiment<TArtifact extends GenericEpisodeEnvelope>(
  artifact: TArtifact,
  experiment: GenericExperimentProvenanceV1,
  context: TournamentEpisodeContext,
  assignmentResolution: import("./social").SocialAssignmentResolutionEvidence | undefined
): TArtifact {
  if (!artifact || typeof artifact !== "object") {
    throw new Error("Generic experiment adapter did not return an episode artifact.");
  }
  const canonical = structuredClone(artifact);
  if (
    assignmentResolution !== undefined &&
    canonical.socialEpisode.assignmentResolution !== undefined &&
    hashStableJsonValue(canonical.socialEpisode.assignmentResolution) !== hashStableJsonValue(assignmentResolution)
  ) {
    throw new Error(`Generic experiment episode ${context.index} assignment resolution contradicts control-plane evidence.`);
  }
  if (assignmentResolution !== undefined) {
    canonical.socialEpisode.assignmentResolution = structuredClone(assignmentResolution);
  } else if (canonical.socialEpisode.assignmentResolution !== undefined) {
    throw new Error(
      `Generic experiment episode ${context.index} supplied assignment resolution without a reviewed adapter resolution hook.`
    );
  }
  let bound: TArtifact;
  if (canonical.experiment !== undefined) {
    const errors = validateGenericExperimentProvenance(
      canonical.experiment,
      `episode ${context.index} artifact.experiment`
    );
    if (errors.length) {
      throw new Error(`Generic experiment episode ${context.index} provenance is invalid: ${errors.join(" ")}`);
    }
    if (hashStableJsonValue(canonical.experiment) !== hashStableJsonValue(experiment)) {
      throw new Error(`Generic experiment episode ${context.index} provenance does not match the normalized spec.`);
    }
    bound = canonical;
  } else {
    bound = {
      ...canonical,
      experiment: structuredClone(experiment)
    };
  }
  const executionAttestation = createGenericExperimentExecutionAttestation(
    experiment.spec,
    bound.socialEpisode,
    { assignmentResolutionRequired: experiment.assignmentResolutionRequired === true }
  );
  if (
    bound.executionAttestation !== undefined &&
    hashStableJsonValue(bound.executionAttestation) !== hashStableJsonValue(executionAttestation)
  ) {
    throw new Error(`Generic experiment episode ${context.index} execution attestation contradicts runner-authored evidence.`);
  }
  return {
    ...bound,
    executionAttestation
  };
}

function createEpisodeContext(
  context: TournamentEpisodeContext,
  spec: NormalizedGenericExperimentSpecV1,
  experiment: GenericExperimentProvenanceV1,
  abortSignal: AbortSignal
): GenericExperimentEpisodeContext {
  return {
    ...context,
    spec: structuredClone(spec),
    experiment: structuredClone(experiment),
    specHash: experiment.specHash,
    abortSignal
  };
}

function assertEvaluationContextBinding(
  context: HarnessEvaluationContext<unknown, unknown, unknown, unknown, unknown>,
  artifact: GenericEpisodeEnvelope,
  episode: TournamentEpisodeContext
): void {
  if (context.id !== artifact.runId || context.status !== artifact.status) {
    throw new Error(`Generic experiment episode ${episode.index} evaluation identity does not match its artifact.`);
  }
  if (
    hashStableState(context.initialState) !== hashStableState(artifact.initialState) ||
    hashStableState(context.finalState) !== hashStableState(artifact.finalState)
  ) {
    throw new Error(`Generic experiment episode ${episode.index} evaluation state does not match its artifact.`);
  }
  if (!Array.isArray(context.agents) || hashStableState(context.agents) !== hashStableState(artifact.agents)) {
    throw new Error(`Generic experiment episode ${episode.index} evaluation agents do not match its artifact.`);
  }
  if (
    context.socialEpisode !== undefined
  ) {
    const contextEpisode = structuredClone(context.socialEpisode) as { assignmentResolution?: unknown };
    const artifactEpisode = structuredClone(artifact.socialEpisode);
    delete contextEpisode.assignmentResolution;
    delete artifactEpisode.assignmentResolution;
    if (hashStableState(contextEpisode) !== hashStableState(artifactEpisode)) {
      throw new Error(`Generic experiment episode ${episode.index} evaluation social episode does not match its artifact.`);
    }
  }
}

function assertEvaluationReportBinding(
  report: HarnessEvaluationReport,
  evaluatorIds: readonly string[],
  episode: TournamentEpisodeContext,
  evaluators?: readonly { id: string; version: string }[]
): void {
  const registry = report.evaluatorRegistry ?? [];
  if (registry.length !== evaluatorIds.length) {
    throw new Error(`Generic experiment episode ${episode.index} evaluator registry is incomplete.`);
  }
  const registryById = new Map(registry.map((recorded) => [recorded.id, recorded]));
  if (registryById.size !== registry.length) {
    throw new Error(`Generic experiment episode ${episode.index} evaluator registry contains duplicate ids.`);
  }
  const runtimeEvaluatorById = new Map((evaluators ?? []).map((evaluator) => [evaluator.id, evaluator]));
  for (const evaluatorId of evaluatorIds) {
    const recorded = registryById.get(evaluatorId);
    const runtimeEvaluator = runtimeEvaluatorById.get(evaluatorId);
    if (
      !recorded ||
      (runtimeEvaluator !== undefined && recorded.version !== runtimeEvaluator.version)
    ) {
      throw new Error(`Generic experiment episode ${episode.index} evaluator identity does not match its registry.`);
    }
  }
}

function assertEvaluationAdapter(
  adapter: GenericExperimentExecutionAdapter<unknown, unknown, GenericEpisodeEnvelope>["evaluation"] | undefined,
  spec: NormalizedGenericExperimentSpecV1
): void {
  if (!adapter) {
    if (spec.evaluatorIds.length) {
      throw new Error("Generic experiment evaluator registry is missing for the normalized evaluator set.");
    }
    return;
  }
  const hasPrecomputedReport = typeof adapter.reportForEpisode === "function";
  const hasRuntimeRegistry = Array.isArray(adapter.evaluators) && typeof adapter.contextForEpisode === "function";
  if (hasPrecomputedReport === hasRuntimeRegistry) {
    throw new Error(
      "Generic experiment evaluation adapter must provide exactly one of reportForEpisode or evaluators/contextForEpisode."
    );
  }
}

function assertAttemptErrorClassification(
  value: GenericExperimentAttemptErrorClassification
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Domain attempt error classifier must return a closed classification record.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "code" || keys[1] !== "decision") {
    throw new Error("Domain attempt error classifier returned unsupported fields.");
  }
  if (value.decision !== "safe-to-retry" && value.decision !== "terminal") {
    throw new Error("Domain attempt error classifier decision is invalid.");
  }
  if (typeof value.code !== "string" || value.code.length > 96 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value.code)) {
    throw new Error("Domain attempt error classifier code is not a safe closed machine code.");
  }
}

function requireDurableAttemptIdentity(
  value: unknown,
  context: TournamentEpisodeContext
): GenericExperimentAttemptIdentity {
  const current = requireV3CurrentEpisode(value, context);
  if (current.phase !== "started") throw new Error("Durable retry authority did not return a started attempt.");
  return { ordinal: current.ordinal, attemptId: current.attemptId };
}

function requireDurableRetryWait(
  value: unknown,
  context: TournamentEpisodeContext
): Extract<HarnessExperimentRunCurrentEpisodeV3, { phase: "retry-wait" }> {
  const current = requireV3CurrentEpisode(value, context);
  if (current.phase !== "retry-wait") throw new Error("Durable retry authority did not return retry-wait state.");
  return current;
}

function requireV3CurrentEpisode(
  value: unknown,
  context: TournamentEpisodeContext
): HarnessExperimentRunCurrentEpisodeV3 {
  const record = value as Partial<HarnessExperimentRunRecordV3> | undefined;
  if (
    !record || record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3 ||
    record.state !== "active" || !record.currentEpisode ||
    record.currentEpisode.index !== context.index || record.currentEpisode.seed !== context.seed
  ) throw new Error("Durable retry authority returned an invalid episode attempt record.");
  return structuredClone(record.currentEpisode);
}

async function waitForRetryEligibility(eligibleAt: string, signal: AbortSignal): Promise<void> {
  const timestamp = Date.parse(eligibleAt);
  if (!Number.isFinite(timestamp)) throw new Error("Durable retry eligibility timestamp is invalid.");
  throwIfAborted(signal);
  const delay = Math.max(0, timestamp - Date.now());
  if (delay === 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("Generic experiment execution was aborted.")));
    timer = setTimeout(() => finish(resolve), Math.min(delay, 2_147_483_647));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  if (Date.now() < timestamp) await waitForRetryEligibility(eligibleAt, signal);
}

function timestampAtOrAfter(candidate: string, floor: string): string {
  const candidateTime = Date.parse(candidate);
  const floorTime = Date.parse(floor);
  if (!Number.isFinite(candidateTime) || !Number.isFinite(floorTime)) {
    throw new Error("Experiment retry timestamp is invalid.");
  }
  return new Date(Math.max(candidateTime, floorTime)).toISOString();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Generic experiment execution was aborted.");
}

function awaitWithAbort<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Generic experiment execution was aborted."));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("Generic experiment execution was aborted.")));
    signal.addEventListener("abort", onAbort, { once: true });
    let result: T | Promise<T>;
    try {
      result = operation();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    Promise.resolve(result).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function createExperimentDeadline(external: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(external?.reason);
  if (external?.aborted) abortFromExternal();
  else external?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => controller.abort(new Error("Generic experiment run deadline reached.")), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", abortFromExternal);
    }
  };
}
