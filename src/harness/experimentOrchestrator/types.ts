import type {
  HarnessCheckpointEnvelope,
  HarnessEpisodeArtifactEnvelope,
  HarnessEpisodeProjectionEnvelope,
  HarnessEpisodeProjectionVisibility
} from "../episodeArtifacts";
import type {
  GenericExperimentProvenanceV1,
  GenericExperimentSpecV1,
  NormalizedGenericExperimentSpecV1
} from "../experimentSpec";
import type { HarnessEvaluationContext, HarnessEvaluator } from "../evaluation";
import type {
  GenericTournamentRunSetEpisode,
  GenericTournamentRunSetArtifact
} from "../genericTournamentArtifacts";
import type {
  HarnessExperimentRunRecovery,
  HarnessExperimentRunResume
} from "../experimentRunStore";
import type { SocialAssignmentActorResolution } from "../social";
import type {
  GenericTournamentResult,
  TournamentEpisodeContext,
  TournamentEpisodeLifecycle
} from "../tournamentRunner";
import type { HarnessEvaluationReport } from "../types";

export type GenericEpisodeEnvelope = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;
export type GenericCheckpointEnvelope = HarnessCheckpointEnvelope<unknown, unknown, unknown, unknown, unknown>;
export const RUN_LEASE_HELD = Symbol("generic-experiment-run-lease-held");
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
