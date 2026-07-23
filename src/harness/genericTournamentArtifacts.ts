import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HarnessEvaluationReport, HarnessMetricRecord } from "./types";
import type {
  GenericTournamentEpisode,
  GenericTournamentResult,
  TournamentEpisodeContext,
  TournamentEpisodeLifecycle
} from "./tournamentRunner";
import { GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE } from "./tournamentRunner";
import {
  validateGenericExperimentProvenance,
  type GenericExperimentProvenanceV1
} from "./experimentSpec";
import { hashStableJsonValue } from "./hash";
import { publishNewLocalArtifactDirectory } from "./localArtifactDirectory";

/**
 * A small, domain-neutral research artifact set.  This intentionally stops at
 * ordered lifecycle evidence, canonical episode payloads, and evaluator
 * metrics.  Rich team/role leaderboards, comparison reports, public shares,
 * and UI projections stay in domain adapters such as Werewolf.
 */
export const GENERIC_TOURNAMENT_RUN_SET_ARTIFACT_VERSION = "harness.tournament-run-set.v1";

export interface GenericTournamentRunSetEpisode<TArtifact = unknown> {
  index: number;
  seed: string;
  status: TournamentEpisodeLifecycle;
  runId?: string;
  artifact?: TArtifact;
  evaluationReport?: HarnessEvaluationReport;
  error?: string;
}

export interface GenericTournamentRunSetArtifact<TArtifact = unknown> {
  artifactVersion: typeof GENERIC_TOURNAMENT_RUN_SET_ARTIFACT_VERSION;
  kind: "tournament-run-set";
  domainId: string;
  runSetId: string;
  createdAt: string;
  seed: string;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  /** Full normalized control-plane authority; absent only for legacy/direct run sets. */
  experiment?: GenericExperimentProvenanceV1;
  /** Present on new run sets; optional only for legacy v1 artifacts. */
  gamesUnstarted?: number;
  episodes: GenericTournamentRunSetEpisode<TArtifact>[];
}

export interface GenericTournamentArtifactAdapter<TResult, TArtifact> {
  /** Stable domain identifier, for example `werewolf` or `ledger`. */
  domainId: string;
  artifactForEpisode(result: TResult, context: TournamentEpisodeContext): TArtifact | Promise<TArtifact>;
  validateArtifact(artifact: TArtifact, context: TournamentEpisodeContext): readonly string[];
  runIdOf?(artifact: TArtifact, context: TournamentEpisodeContext): string | undefined;
  evaluationReportOf?(result: TResult, context: TournamentEpisodeContext): HarnessEvaluationReport | undefined;
}

export interface BuildGenericTournamentRunSetOptions<TPrepared, TResult, TArtifact> {
  runSetId: string;
  createdAt?: string;
  result: GenericTournamentResult<TPrepared, TResult>;
  adapter: GenericTournamentArtifactAdapter<TResult, TArtifact>;
  experiment?: GenericExperimentProvenanceV1;
}

export interface GenericTournamentArtifactDirectory {
  directory: string;
  manifestPath: string;
  episodesJsonlPath: string;
  metricsJsonlPath: string;
  episodePaths: string[];
}

/**
 * Convert the generic tournament lifecycle record into a serializable research
 * artifact.  Deliberately never serializes `TPrepared`: preparation objects
 * may contain scenario factories, model clients, or private runtime state.
 */
export async function buildGenericTournamentRunSetArtifact<TPrepared, TResult, TArtifact>(
  options: BuildGenericTournamentRunSetOptions<TPrepared, TResult, TArtifact>
): Promise<GenericTournamentRunSetArtifact<TArtifact>> {
  const { result, adapter } = options;
  assertIdentifier(options.runSetId, "runSetId");
  assertIdentifier(adapter.domainId, "domainId");
  const episodes: GenericTournamentRunSetEpisode<TArtifact>[] = [];

  for (const episode of result.episodes) {
    episodes.push(await materializeEpisodeArtifact(episode, adapter));
  }
  const artifact: GenericTournamentRunSetArtifact<TArtifact> = {
    artifactVersion: GENERIC_TOURNAMENT_RUN_SET_ARTIFACT_VERSION,
    kind: "tournament-run-set",
    domainId: adapter.domainId,
    runSetId: options.runSetId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    seed: result.seed,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesTruncated: result.gamesTruncated,
    gamesFailed: result.gamesFailed,
    ...(options.experiment ? { experiment: structuredClone(options.experiment) } : {}),
    gamesUnstarted: result.gamesUnstarted,
    episodes
  };
  const errors = validateGenericTournamentRunSetArtifact(artifact);
  if (errors.length) throw new Error(`Invalid generic tournament run set ${artifact.runSetId}: ${errors.join(" ")}`);
  return artifact;
}

/**
 * Persist only the domain-neutral common layout.  The caller selects a new
 * directory owned by its artifact store; this writer refuses to reuse an
 * existing directory and never accepts episode-provided file paths.
 */
export async function writeGenericTournamentRunSetArtifact<TArtifact>(options: {
  directory: string;
  artifact: GenericTournamentRunSetArtifact<TArtifact>;
}): Promise<GenericTournamentArtifactDirectory> {
  // A generic caller can construct this public type directly, bypassing the
  // runner. Apply the same closed failure boundary at persistence time.
  const artifact = sanitizeGenericTournamentRunSetArtifact(options.artifact);
  const errors = validateGenericTournamentRunSetArtifact(artifact);
  if (errors.length) throw new Error(`Invalid generic tournament run set ${artifact.runSetId}: ${errors.join(" ")}`);
  const directory = resolve(options.directory);
  const episodeFiles = await publishNewLocalArtifactDirectory({
    finalDirectory: directory,
    populate: (stagingDirectory) => writeGenericTournamentRunSetTree(stagingDirectory, artifact)
  });
  const episodePaths = episodeFiles.map((file) => resolve(directory, file));
  return {
    directory,
    manifestPath: join(directory, "manifest.json"),
    episodesJsonlPath: join(directory, "episodes.jsonl"),
    metricsJsonlPath: join(directory, "metrics.jsonl"),
    episodePaths
  };
}

async function writeGenericTournamentRunSetTree<TArtifact>(
  directory: string,
  artifact: GenericTournamentRunSetArtifact<TArtifact>
): Promise<string[]> {
  const episodesDirectory = join(directory, "episodes");
  await mkdir(episodesDirectory, { recursive: false });

  const episodeFiles: string[] = [];
  const episodeRows: Array<Record<string, unknown>> = [];
  const metricRows: Array<Record<string, unknown>> = [];
  for (const episode of artifact.episodes) {
    const artifactFile = episode.artifact === undefined ? undefined : `episodes/${episode.index}.json`;
    if (artifactFile) {
      const filePath = resolve(directory, artifactFile);
      assertOwnedArtifactPath(directory, filePath);
      await writeJson(filePath, episode.artifact);
      episodeFiles.push(artifactFile);
    }
    episodeRows.push({
      index: episode.index,
      seed: episode.seed,
      status: episode.status,
      runId: episode.runId ?? null,
      artifactFile: artifactFile ?? null,
      evaluationReportId: episode.evaluationReport?.id ?? null,
      error: episode.error ?? null
    });
    for (const metric of episode.evaluationReport?.metrics ?? []) {
      metricRows.push(metricRow(episode, metric));
    }
  }
  const manifestPath = join(directory, "manifest.json");
  const episodesJsonlPath = join(directory, "episodes.jsonl");
  const metricsJsonlPath = join(directory, "metrics.jsonl");
  await writeJson(manifestPath, {
    ...artifact,
    episodes: episodeRows,
    files: ["manifest.json", "episodes.jsonl", "metrics.jsonl", ...episodeFiles]
  });
  await writeJsonLines(episodesJsonlPath, episodeRows);
  await writeJsonLines(metricsJsonlPath, metricRows);
  return episodeFiles;
}

/** Validate lifecycle accounting and the domain-neutral persistent shape. */
export function validateGenericTournamentRunSetArtifact<TArtifact>(artifact: GenericTournamentRunSetArtifact<TArtifact>): string[] {
  const errors: string[] = [];
  if (artifact.artifactVersion !== GENERIC_TOURNAMENT_RUN_SET_ARTIFACT_VERSION) {
    errors.push(`artifactVersion must be ${GENERIC_TOURNAMENT_RUN_SET_ARTIFACT_VERSION}.`);
  }
  if (artifact.kind !== "tournament-run-set") errors.push("kind must be tournament-run-set.");
  if (artifact.experiment !== undefined) {
    errors.push(...validateGenericExperimentProvenance(artifact.experiment, "experiment"));
    if (artifact.experiment.spec.domainId !== artifact.domainId) {
      errors.push("experiment domainId must match the run-set domainId.");
    }
    if (artifact.experiment.spec.seed !== artifact.seed) {
      errors.push("experiment seed must match the run-set seed.");
    }
    if (artifact.experiment.spec.episodeCount !== artifact.gamesRequested) {
      errors.push("experiment episodeCount must match gamesRequested.");
    }
  }
  for (const [field, value] of [
    ["domainId", artifact.domainId],
    ["runSetId", artifact.runSetId],
    ["createdAt", artifact.createdAt],
    ["seed", artifact.seed]
  ] as const) {
    if (typeof value !== "string" || !value.trim()) errors.push(`${field} is required.`);
  }
  const expectedCounts = {
    gamesCompleted: artifact.episodes.filter((episode) => episode.status === "completed").length,
    gamesTruncated: artifact.episodes.filter((episode) => episode.status === "truncated").length,
    gamesFailed: artifact.episodes.filter((episode) => episode.status === "failed").length
  };
  for (const [field, expected] of Object.entries(expectedCounts) as Array<[keyof typeof expectedCounts, number]>) {
    if (artifact[field] !== expected) errors.push(`${field} mismatch: expected ${expected}, received ${artifact[field]}.`);
  }
  if (!Number.isInteger(artifact.gamesRequested) || artifact.gamesRequested < artifact.episodes.length) {
    errors.push("gamesRequested must be an integer at least as large as the recorded episode count.");
  }
  if (artifact.gamesUnstarted !== undefined) {
    const expectedUnstarted = artifact.gamesRequested - artifact.episodes.length;
    if (!Number.isInteger(artifact.gamesUnstarted) || artifact.gamesUnstarted < 0 || artifact.gamesUnstarted !== expectedUnstarted) {
      errors.push(`gamesUnstarted mismatch: expected ${expectedUnstarted}, received ${artifact.gamesUnstarted}.`);
    }
  }
  const indices = new Set<number>();
  for (const [position, episode] of artifact.episodes.entries()) {
    if (!Number.isInteger(episode.index) || episode.index < 0) errors.push(`episodes[${position}].index must be a non-negative integer.`);
    if (episode.index !== position) errors.push(`episodes[${position}].index must equal its canonical position ${position}.`);
    if (indices.has(episode.index)) errors.push(`episodes[${position}] duplicates index ${episode.index}.`);
    indices.add(episode.index);
    if (typeof episode.seed !== "string" || !episode.seed) errors.push(`episodes[${position}].seed is required.`);
    const expectedSeed = `${artifact.seed}:g${position + 1}`;
    if (episode.seed !== expectedSeed) errors.push(`episodes[${position}].seed must be ${expectedSeed}.`);
    if (episode.status !== "completed" && episode.status !== "truncated" && episode.status !== "failed") {
      errors.push(`episodes[${position}].status is invalid.`);
    }
    if (episode.error !== undefined && typeof episode.error !== "string") errors.push(`episodes[${position}].error must be a string when present.`);
    if (episode.artifact && artifact.experiment) {
      const candidate = episode.artifact as Record<string, unknown>;
      const episodeExperiment = candidate.experiment;
      if (
        !episodeExperiment ||
        hashStableJsonValue(episodeExperiment) !== hashStableJsonValue(artifact.experiment)
      ) {
        errors.push(`episodes[${position}].artifact experiment must match the run-set experiment.`);
      }
      if (typeof candidate.runId !== "string" || candidate.runId !== episode.runId) {
        errors.push(`episodes[${position}].artifact runId must match the run-set episode runId.`);
      }
    }
  }
  return errors;
}

async function materializeEpisodeArtifact<TPrepared, TResult, TArtifact>(
  episode: GenericTournamentEpisode<TPrepared, TResult>,
  adapter: GenericTournamentArtifactAdapter<TResult, TArtifact>
): Promise<GenericTournamentRunSetEpisode<TArtifact>> {
  const context = { index: episode.index, seed: episode.seed };
  if (episode.result === undefined) {
    return {
      ...context,
      status: episode.status,
      ...safeEpisodeError(episode.status, episode.error)
    };
  }
  const artifact = await adapter.artifactForEpisode(episode.result, context);
  const validationErrors = adapter.validateArtifact(artifact, context);
  if (validationErrors.length) {
    throw new Error(`Invalid ${adapter.domainId} episode artifact ${episode.index}: ${validationErrors.join(" ")}`);
  }
  return {
    ...context,
    status: episode.status,
    runId: adapter.runIdOf?.(artifact, context),
    artifact,
    evaluationReport: adapter.evaluationReportOf?.(episode.result, context),
    ...safeEpisodeError(episode.status, episode.error)
  };
}

/**
 * Failure strings are not generic artifact evidence.  This final boundary
 * protects direct callers of the writer as well as runner-built artifacts.
 */
function sanitizeGenericTournamentRunSetArtifact<TArtifact>(
  artifact: GenericTournamentRunSetArtifact<TArtifact>
): GenericTournamentRunSetArtifact<TArtifact> {
  return {
    ...artifact,
    episodes: artifact.episodes.map((episode) => {
      const { error: _ignoredError, ...rest } = episode;
      return {
        ...rest,
        ...safeEpisodeError(episode.status, _ignoredError)
      };
    })
  };
}

function safeEpisodeError(status: TournamentEpisodeLifecycle, error: string | undefined): Pick<GenericTournamentRunSetEpisode, "error"> {
  if (status !== "failed" || !error) return {};
  return { error: GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE };
}

function metricRow<TArtifact>(episode: GenericTournamentRunSetEpisode<TArtifact>, metric: HarnessMetricRecord): Record<string, unknown> {
  return {
    episodeIndex: episode.index,
    episodeSeed: episode.seed,
    episodeStatus: episode.status,
    runId: episode.runId ?? null,
    evaluationReportId: episode.evaluationReport?.id ?? null,
    ...metric
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonLines(path: string, values: readonly unknown[]): Promise<void> {
  await writeFile(path, `${values.map((value) => JSON.stringify(value)).join("\n")}${values.length ? "\n" : ""}`, "utf8");
}

function assertIdentifier(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

function assertOwnedArtifactPath(directory: string, candidate: string): void {
  const relative = candidate.slice(directory.length + 1);
  if (!relative || relative.startsWith("..") || resolve(directory, relative) !== candidate) {
    throw new Error("Generic tournament artifact writer produced a path outside its owned directory.");
  }
}
