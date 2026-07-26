import {
  validateHarnessEpisodeProjectionEnvelope,
  type HarnessEpisodeProjectionEnvelope
} from "../episodeArtifacts";
import { deriveHarnessEpisodeArtifactSha256 } from "../episodeArtifactStore";
import type { NormalizedGenericExperimentSpecV1 } from "../experimentSpec";
import type { GenericTournamentRunSetArtifact } from "../genericTournamentArtifacts";
import {
  GENERIC_EXPERIMENT_PUBLICATION_RUN_SET_VERSION,
  GENERIC_EXPERIMENT_PUBLICATION_VERSION,
  type ExecutedGenericExperimentEpisode,
  type GenericCheckpointEnvelope,
  type GenericEpisodeEnvelope,
  type GenericExperimentArtifactStore,
  type GenericExperimentEpisodeContext,
  type GenericExperimentExecutionAdapter,
  type GenericExperimentPublicationEpisode,
  type GenericExperimentPublicationResult,
  type GenericExperimentRestrictedExecutionResult,
  type GenericExperimentRunStore
} from "./types";
import { awaitWithAbort } from "./control";

export async function buildGenericExperimentPublication<TArtifact extends GenericEpisodeEnvelope>(input: {
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

export function restrictedExperimentExecutionResult(
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

export function assertControlPolicyRuntime<
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

export function assertArtifactProjectionRuntime<
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

export async function buildArtifactProjection<TArtifact extends GenericEpisodeEnvelope>(input: {
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

export async function assertCanonicalProjectionSidecars<TArtifact extends GenericEpisodeEnvelope>(input: {
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

export function assertProjectionPolicyBinding(
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

export function detachedEpisodeContext(context: GenericExperimentEpisodeContext): GenericExperimentEpisodeContext {
  return {
    ...context,
    spec: structuredClone(context.spec),
    experiment: structuredClone(context.experiment)
  };
}
