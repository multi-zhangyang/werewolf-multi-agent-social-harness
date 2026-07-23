import { compareSocialDomainAdapterManifests } from "./domainAdapter";
import type { HarnessEpisodeArtifactEnvelope } from "./episodeArtifacts";
import type { HarnessCheckpointEnvelope } from "./episodeArtifacts";
import {
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
  type HarnessExperimentRunRecord,
  type HarnessExperimentRunRecovery,
  type HarnessExperimentRunResume
} from "./experimentRunStore";
import { hashStableJsonValue, hashStableState } from "./hash";
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

export interface GenericExperimentEpisodeContext extends TournamentEpisodeContext {
  spec: NormalizedGenericExperimentSpecV1;
  experiment: GenericExperimentProvenanceV1;
  specHash: string;
  abortSignal: AbortSignal;
}

export interface GenericExperimentArtifactStore<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope = GenericCheckpointEnvelope
> {
  put(artifact: TArtifact, options?: { evaluationReport?: HarnessEvaluationReport }): Promise<unknown>;
  /** Canonical, integrity-checking read path used to hydrate durable prefixes. */
  get(runId: string): Promise<TArtifact | undefined>;
  /** Canonical evaluation sidecar read path; absence is part of immutable identity. */
  getEvaluationReport(runId: string): Promise<HarnessEvaluationReport | undefined>;
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
  checkpointing?: {
    /** Deterministic, model-free derivation from an immutable canonical episode. */
    finalCheckpointForArtifact(
      artifact: TArtifact,
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
  const experiment = createGenericExperimentProvenance(normalizedSpec);
  const specHash = experiment.specHash;
  const now = options.now ?? (() => new Date().toISOString());
  const runSetId = options.runSetId ?? normalizedSpec.id;
  assertCheckpointPolicyRuntime(options, normalizedSpec);
  assertControlPolicyRuntime(normalizedSpec);
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
      durableRecord.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 &&
      durableRecord.state === "active" &&
      durableRecord.currentEpisode
    ) {
      durableRecord = (await options.runStore.recoverCurrentEpisode(runSetId)).record;
      throwIfAborted(deadline.signal);
    }
    const initialEpisodes = await hydrateCommittedEpisodes(
      durableRecord,
      normalizedSpec,
      options.artifactStore,
      deadline.signal
    );
    await ensureFinalCheckpointsForEpisodes({
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
        await options.runStore.startEpisode({
          runSetId,
          index: context.index,
          seed: context.seed,
          startedAt: now()
        });
      },
      async prepareEpisode(context) {
        return awaitWithAbort(
          () => options.adapter.prepareEpisode(
            createEpisodeContext(context, normalizedSpec, experiment, deadline.signal)
          ),
          deadline.signal
        );
      },
      async runEpisode(prepared, context) {
        const domainResult = await awaitWithAbort(
          () => options.adapter.runEpisode(
            prepared,
            createEpisodeContext(context, normalizedSpec, experiment, deadline.signal)
          ),
          deadline.signal
        );
        throwIfAborted(deadline.signal);
        const status = options.adapter.lifecycleOf(domainResult);
        const artifact = bindArtifactToExperiment(
          await awaitWithAbort(
            () => options.adapter.artifactForEpisode(
              domainResult,
              createEpisodeContext(context, normalizedSpec, experiment, deadline.signal)
            ),
            deadline.signal
          ),
          experiment,
          context
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
          // Canonical publication is a control-plane operation. Keeping it in
          // this terminal hook, outside the tournament's domain error boundary,
          // makes storage failure fatal even when continueOnError is enabled.
          await options.artifactStore.put(
            result.artifact,
            result.evaluationReport === undefined
              ? undefined
              : { evaluationReport: result.evaluationReport }
          );
          await ensureFinalCheckpoint({
            artifact: result.artifact,
            context: createEpisodeContext(episode, normalizedSpec, experiment, deadline.signal),
            options,
            spec: normalizedSpec
          });
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

function assertControlPolicyRuntime(spec: NormalizedGenericExperimentSpecV1): void {
  // Retry identity is already portable, but this orchestrator does not yet
  // have a durable multi-attempt episode record. Silently treating maxAttempts
  // > 1 as one attempt would make the persisted experiment claim behavior the
  // runtime never executed.
  if (spec.retryPolicy.maxAttempts !== 1) {
    throw new Error(
      "Generic experiment retryPolicy currently supports exactly one durable episode attempt."
    );
  }
  // Canonical episode persistence is research-full. Redacted/public artifacts
  // are derived projections owned by reviewed exporters and server routes; the
  // control plane must not pretend those projections are its canonical write.
  if (spec.artifactPolicy.visibility !== "research-full") {
    throw new Error(
      "Generic experiment artifactPolicy currently requires research-full canonical episode authority; redacted and public views must use a reviewed projection boundary."
    );
  }
}

function assertCheckpointPolicyRuntime<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(
  options: {
    adapter: { checkpointing?: { finalCheckpointForArtifact(artifact: TArtifact, context: GenericExperimentEpisodeContext): TCheckpoint | Promise<TCheckpoint> } };
    artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  },
  spec: NormalizedGenericExperimentSpecV1
): void {
  if (spec.checkpointPolicy.mode === "none") return;
  if (spec.checkpointPolicy.mode === "native-boundaries") {
    throw new Error(
      "Generic experiment checkpointPolicy native-boundaries requires an explicit runtime boundary publisher and is not supported by this orchestrator."
    );
  }
  if (!options.adapter.checkpointing?.finalCheckpointForArtifact) {
    throw new Error("Generic experiment checkpointPolicy final requires a deterministic final checkpoint builder.");
  }
  if (
    typeof options.artifactStore.putCheckpoint !== "function" ||
    typeof options.artifactStore.getCheckpoint !== "function"
  ) {
    throw new Error("Generic experiment checkpointPolicy final requires canonical checkpoint read/write authority.");
  }
}

async function ensureFinalCheckpointsForEpisodes<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(input: {
  episodes: Array<{
    index: number;
    seed: string;
    result?: ExecutedGenericExperimentEpisode<TArtifact>;
  }>;
  options: {
    adapter: { checkpointing?: { finalCheckpointForArtifact(artifact: TArtifact, context: GenericExperimentEpisodeContext): TCheckpoint | Promise<TCheckpoint> } };
    artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  };
  spec: NormalizedGenericExperimentSpecV1;
  experiment: GenericExperimentProvenanceV1;
  abortSignal: AbortSignal;
}): Promise<void> {
  if (input.spec.checkpointPolicy.mode !== "final") return;
  for (const episode of input.episodes) {
    if (!episode.result) continue;
    await ensureFinalCheckpoint({
      artifact: episode.result.artifact,
      context: createEpisodeContext(episode, input.spec, input.experiment, input.abortSignal),
      options: input.options,
      spec: input.spec
    });
  }
}

async function ensureFinalCheckpoint<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(input: {
  artifact: TArtifact;
  context: GenericExperimentEpisodeContext;
  options: {
    adapter: { checkpointing?: { finalCheckpointForArtifact(artifact: TArtifact, context: GenericExperimentEpisodeContext): TCheckpoint | Promise<TCheckpoint> } };
    artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  };
  spec: NormalizedGenericExperimentSpecV1;
}): Promise<void> {
  if (input.spec.checkpointPolicy.mode !== "final") return;
  const builder = input.options.adapter.checkpointing?.finalCheckpointForArtifact;
  const getCheckpoint = input.options.artifactStore.getCheckpoint?.bind(input.options.artifactStore);
  const putCheckpoint = input.options.artifactStore.putCheckpoint?.bind(input.options.artifactStore);
  if (!builder || !getCheckpoint || !putCheckpoint) {
    throw new Error("Generic experiment final checkpoint runtime disappeared after preflight validation.");
  }
  const expectedExperiment = structuredClone(input.context.experiment);
  const checkpointContext: GenericExperimentEpisodeContext = {
    ...input.context,
    spec: structuredClone(input.context.spec),
    experiment: structuredClone(expectedExperiment)
  };
  const checkpoint = structuredClone(await awaitWithAbort(
    () => builder(structuredClone(input.artifact), checkpointContext),
    input.context.abortSignal
  ));
  assertFinalCheckpointBinding(checkpoint, input.artifact, expectedExperiment);
  const candidateHash = hashStableJsonValue(checkpoint);
  const existing = await awaitWithAbort(
    () => getCheckpoint(input.artifact.runId, checkpoint.checkpointId),
    input.context.abortSignal
  );
  if (existing !== undefined) {
    assertFinalCheckpointBinding(existing, input.artifact, expectedExperiment);
    if (hashStableJsonValue(existing) !== candidateHash) {
      throw new Error("Canonical final checkpoint identity conflicts with the deterministic checkpoint candidate.");
    }
    return;
  }
  throwIfAborted(input.context.abortSignal);
  // Canonical mutation is deliberately awaited to completion while the run
  // lease is held. Racing an irreversible store write against abort could
  // release the lease while publication is still in flight.
  await putCheckpoint(input.artifact.runId, checkpoint);
  const published = await awaitWithAbort(
    () => getCheckpoint(input.artifact.runId, checkpoint.checkpointId),
    input.context.abortSignal
  );
  if (published === undefined || hashStableJsonValue(published) !== candidateHash) {
    throw new Error("Canonical final checkpoint publication could not be verified.");
  }
  assertFinalCheckpointBinding(published, input.artifact, expectedExperiment);
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
  if (record.state === "active" && record.schemaVersion !== HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2) {
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
  context: TournamentEpisodeContext
): TArtifact {
  if (!artifact || typeof artifact !== "object") {
    throw new Error("Generic experiment adapter did not return an episode artifact.");
  }
  const canonical = structuredClone(artifact);
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
    bound.socialEpisode
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
    context.socialEpisode !== undefined &&
    hashStableState(context.socialEpisode) !== hashStableState(artifact.socialEpisode)
  ) {
    throw new Error(`Generic experiment episode ${episode.index} evaluation social episode does not match its artifact.`);
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
