import type {
  GenericExperimentProvenanceV1,
  NormalizedGenericExperimentSpecV1
} from "../experimentSpec";
import {
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V3,
  type HarnessExperimentRunRecord
} from "../experimentRunStore";
import { hashStableJsonValue } from "../hash";
import {
  GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE,
  type GenericTournamentResult,
  type TournamentEpisodeLifecycle
} from "../tournamentRunner";
import type {
  ExecutedGenericExperimentEpisode,
  GenericEpisodeEnvelope,
  GenericExperimentArtifactStore
} from "./types";
import { assertArtifactBinding } from "./bindings";
import { awaitWithAbort } from "./control";

export function tournamentFromDurableRecord<TArtifact>(
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

export function assertResumedExperiment(
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

export async function hydrateCommittedEpisodes<TArtifact extends GenericEpisodeEnvelope>(
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

export function stripRuntimeTournamentState<TPrepared, TArtifact>(
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
