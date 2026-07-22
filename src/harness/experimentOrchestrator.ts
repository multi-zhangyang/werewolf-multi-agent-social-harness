import { compareSocialDomainAdapterManifests } from "./domainAdapter";
import type { HarnessEpisodeArtifactEnvelope } from "./episodeArtifacts";
import {
  createGenericExperimentProvenance,
  normalizeGenericExperimentSpec,
  validateGenericExperimentProvenance,
  type GenericExperimentProvenanceV1,
  type GenericExperimentSpecV1,
  type NormalizedGenericExperimentSpecV1
} from "./experimentSpec";
import { runEvaluationRegistry, type HarnessEvaluationContext, type HarnessEvaluator } from "./evaluation";
import {
  buildGenericTournamentRunSetArtifact,
  type GenericTournamentRunSetArtifact
} from "./genericTournamentArtifacts";
import { hashStableJsonValue, hashStableState } from "./hash";
import {
  runTournamentEpisodes,
  type GenericTournamentResult,
  type TournamentEpisodeContext,
  type TournamentEpisodeLifecycle
} from "./tournamentRunner";
import type { HarnessEvaluationReport } from "./types";

type GenericEpisodeEnvelope = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;

export interface GenericExperimentEpisodeContext extends TournamentEpisodeContext {
  spec: NormalizedGenericExperimentSpecV1;
  experiment: GenericExperimentProvenanceV1;
  specHash: string;
  abortSignal: AbortSignal;
}

export interface GenericExperimentArtifactStore<TArtifact extends GenericEpisodeEnvelope> {
  put(artifact: TArtifact, options?: { evaluationReport?: HarnessEvaluationReport }): Promise<unknown>;
}

/**
 * Durable experiment lifecycle authority. Implementations persist only
 * provenance and ordered canonical-episode references; episode content remains
 * owned by GenericExperimentArtifactStore.
 */
export interface GenericExperimentRunStore<TArtifact extends GenericEpisodeEnvelope> {
  begin(input: {
    runSetId: string;
    experiment: GenericExperimentProvenanceV1;
    createdAt?: string;
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
  evaluators: Array<
    HarnessEvaluator<TState, TMetrics, TSocialEpisode, unknown, TAgent, TTrajectory>
  >;
  contextForEpisode(
    result: TResult,
    artifact: TArtifact,
    context: GenericExperimentEpisodeContext
  ): HarnessEvaluationContext<TState, TMetrics, TSocialEpisode, TAgent, TTrajectory>;
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
  TTrajectory = unknown
> {
  domainId: string;
  prepareEpisode(context: GenericExperimentEpisodeContext): TPrepared | Promise<TPrepared>;
  runEpisode(prepared: TPrepared, context: GenericExperimentEpisodeContext): TResult | Promise<TResult>;
  lifecycleOf(result: TResult): TournamentEpisodeLifecycle;
  artifactForEpisode(result: TResult, context: GenericExperimentEpisodeContext): TArtifact | Promise<TArtifact>;
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
  TTrajectory = unknown
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
    TTrajectory
  >;
  artifactStore: GenericExperimentArtifactStore<TArtifact>;
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
  TTrajectory = unknown
>(
  options: RunGenericExperimentOptions<
    TPrepared,
    TResult,
    TArtifact,
    TState,
    TMetrics,
    TSocialEpisode,
    TAgent,
    TTrajectory
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
    !options.runStore ||
    typeof options.runStore.begin !== "function" ||
    typeof options.runStore.finalize !== "function"
  ) {
    throw new Error("Generic experiment execution requires a durable experiment run store.");
  }
  if (options.runSetId !== undefined && !options.runSetId.trim()) {
    throw new Error("Generic experiment runSetId must be a nonempty string when present.");
  }
  const selectedEvaluators = resolveEvaluators(normalizedSpec, options.adapter.evaluation?.evaluators ?? []);
  const experiment = createGenericExperimentProvenance(normalizedSpec);
  const specHash = experiment.specHash;
  const now = options.now ?? (() => new Date().toISOString());
  const runSetId = options.runSetId ?? normalizedSpec.id;
  const runSetCreatedAt = now();
  await options.runStore.begin({ runSetId, experiment, createdAt: runSetCreatedAt });
  const deadline = createExperimentDeadline(options.abortSignal, normalizedSpec.timeoutPolicy.runTimeoutMs);
  try {
    const tournament = await runTournamentEpisodes<
      TPrepared,
      ExecutedGenericExperimentEpisode<TArtifact>
    >({
      games: normalizedSpec.episodeCount,
      seed: normalizedSpec.seed,
      abortSignal: deadline.signal,
      continueOnError: normalizedSpec.continueOnError,
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
        if (options.adapter.evaluation) {
          const evaluationContext = options.adapter.evaluation.contextForEpisode(
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
          assertEvaluationReportBinding(evaluationReport, selectedEvaluators, context);
        }
        throwIfAborted(deadline.signal);
        assertArtifactBinding(artifact, normalizedSpec, status, context);
        await options.artifactStore.put(
          artifact,
          evaluationReport === undefined ? undefined : { evaluationReport }
        );
        return {
          status,
          artifact,
          ...(evaluationReport ? { evaluationReport } : {})
        };
      },
      statusOf: (episode) => episode.status
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
    return canonical;
  }
  return {
    ...canonical,
    experiment: structuredClone(experiment)
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
  evaluators: readonly { id: string; version: string }[],
  episode: TournamentEpisodeContext
): void {
  const registry = report.evaluatorRegistry ?? [];
  if (registry.length !== evaluators.length) {
    throw new Error(`Generic experiment episode ${episode.index} evaluator registry is incomplete.`);
  }
  for (const [index, evaluator] of evaluators.entries()) {
    const recorded = registry[index];
    if (!recorded || recorded.id !== evaluator.id || recorded.version !== evaluator.version) {
      throw new Error(`Generic experiment episode ${episode.index} evaluator identity does not match its registry.`);
    }
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
