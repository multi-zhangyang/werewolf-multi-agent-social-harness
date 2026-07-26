import path from "node:path";
import express from "express";
import { providerDiagnosticSummaryFromEnv } from "../../agents/providerRegistry";
import type { NormalizedTournamentExperiment } from "../../harness/experiment";
import { hashStableState } from "../../harness/hash";
import { type TournamentResult, openTournamentOrchestration, runTournament } from "../../harness/tournament";
import {
  type PublicTournamentArtifactFiles,
  type TournamentArtifactWriteResult,
  writeTournamentArtifactDirectory
} from "../../harness/tournamentArtifacts";
import { DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER } from "../../harness/types";
import { publicApiFailureFromError } from "../apiFailure";
import { relativeTournamentArtifactFiles, resolveGeneratedArtifactDirectory } from "../artifactFiles";
import { loadTournamentArtifactSetIndex, tournamentDensityFromManifestFile, writeTournamentArtifactSetIndex } from "../artifactSetStore";
import { projectPublicTournamentMatchArtifact } from "../artifactViews";
import type { ServerContext } from "../context";
import {
  buildTournamentSummary,
  serializeTournamentArtifactSet,
  serializeTournamentEpisodeSummaryForApi,
  summarizePublicAssignmentConfig
} from "../dto";
import {
  HttpError,
  assertForbiddenTournamentRequestFields,
  normalizeTournamentExperimentRequest,
  parseOptionalBoolean,
  requestBodyObject
} from "../httpValidation";
import { type StoredTournamentArtifactSet, saveTournamentArtifactSet } from "../store";
import { randomUUID } from "node:crypto";

export function registerTournamentRunRoutes(app: express.Express, context: ServerContext): void {
const { createReasoner, tournamentArtifactBaseDir, experimentRunBaseDir, registerTournamentMatchArtifacts } = context;

app.post("/api/tournaments/run", async (req, res) => {
  let experiment: NormalizedTournamentExperiment;
  let exportArtifacts = false;
  try {
    const body = requestBodyObject(req.body);
    assertForbiddenTournamentRequestFields(body, "tournament run");
    exportArtifacts = parseOptionalBoolean(body.exportArtifacts, "exportArtifacts") ?? false;
    if (exportArtifacts && !tournamentArtifactBaseDir) {
      throw new HttpError(400, "Tournament artifact export requires configured TOURNAMENT_ARTIFACT_BASE_DIR.");
    }
    experiment = normalizeTournamentExperimentRequest(body);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    const failure = publicApiFailureFromError(error);
    res.status(status).json({
      summary: {
        kind: "tournament",
        ok: false,
        provider: providerDiagnosticSummaryFromEnv(),
        evaluation: null,
        failureReason: failure.message,
        providerFailure: failure.providerFailure ?? null
      },
      error: failure.message
    });
    return;
  }
  const abortController = new AbortController();
  const timeout = experiment.timeoutMs
    ? setTimeout(() => abortController.abort(new Error(`Tournament timeout exceeded ${experiment.timeoutMs}ms.`)), experiment.timeoutMs)
    : undefined;
  timeout?.unref();
  const startedAt = performance.now();

  try {
    const orchestration = experimentRunBaseDir
      ? await openTournamentOrchestration({
          baseDirectory: experimentRunBaseDir,
          runSetId: `${experiment.id}:${hashStableState(experiment).slice(0, 16)}`
        })
      : undefined;
    const result = await runTournament({
      models: experiment.models,
      profiles: experiment.profiles,
      assignment: experiment.assignment,
      games: experiment.games,
      seed: experiment.seed,
      maxTransitions: experiment.maxTransitions,
      jointPhaseScheduler: experiment.jointPhaseScheduler,
      config: experiment.config,
      temperature: experiment.temperature,
      continueOnError: experiment.continueOnError,
      experiment,
      includeArtifacts: exportArtifacts,
      reasoner: createReasoner(abortController.signal),
      executionLimits: { abortSignal: abortController.signal },
      orchestration
    });
    const artifactSet = exportArtifacts
      ? await persistTournamentArtifactSet({
          result,
          experimentId: experiment.id,
          seed: experiment.seed,
          baseDir: tournamentArtifactBaseDir
        })
      : null;
    res.status(result.gamesFailed || (result.gamesUnstarted ?? 0) > 0 ? 207 : 200).json({
      summary: {
        ...buildTournamentSummary(result, {
          experimentId: experiment.id,
          seed: experiment.seed,
          models: result.models,
          profiles: result.profiles,
          assignment: result.assignment,
          games: experiment.games,
          maxTransitions: experiment.maxTransitions,
          jointPhaseScheduler: experiment.jointPhaseScheduler,
          timeoutMs: experiment.timeoutMs,
          elapsedMs: Math.round(performance.now() - startedAt),
          timedOut: abortController.signal.aborted
        }),
        artifacts: artifactSet ? serializeTournamentArtifactSet(artifactSet) : null
      },
      artifacts: artifactSet ? serializeTournamentArtifactSet(artifactSet) : null,
      episodes: result.episodes.map(serializeTournamentEpisodeSummaryForApi)
    });
  } catch (error) {
    const failure = publicApiFailureFromError(error);
    res.status(500).json({
      summary: {
        kind: "tournament",
        ok: false,
        provider: providerDiagnosticSummaryFromEnv(),
        experimentId: experiment.id,
        seed: experiment.seed,
        models: experiment.models,
        profileCount: experiment.profiles.length,
        modelCount: experiment.models.length,
        assignment: summarizePublicAssignmentConfig(experiment.assignment),
        games: experiment.games,
        limits: {
          maxTransitions: experiment.maxTransitions ?? null,
          jointPhaseScheduler: experiment.jointPhaseScheduler ?? DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER,
          timeoutMs: experiment.timeoutMs ?? null
        },
        elapsedMs: Math.round(performance.now() - startedAt),
        timedOut: abortController.signal.aborted,
        evaluation: null,
        failureReason: failure.message,
        providerFailure: failure.providerFailure ?? null
      },
      error: failure.message
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

async function persistTournamentArtifactSet(options: {
  result: TournamentResult;
  experimentId: string;
  seed: string;
  baseDir: string | undefined;
}): Promise<StoredTournamentArtifactSet> {
  if (!options.baseDir) {
    throw new HttpError(400, "Tournament artifact export requires configured TOURNAMENT_ARTIFACT_BASE_DIR.");
  }
  const id = randomUUID();
  const baseDir = path.resolve(options.baseDir);
  const outputDir = resolveGeneratedArtifactDirectory(baseDir, id);
  const createdAt = new Date().toISOString();
  let written: TournamentArtifactWriteResult<PublicTournamentArtifactFiles>;
  try {
    written = await writeTournamentArtifactDirectory(options.result, {
      outputDir,
      experimentId: options.experimentId,
      createdAt,
      overwrite: false,
      // Server-exported tournament packs are downloadable through the public API.
      // Match files and trajectory streams use truth-redacted projections; assignment
      // role/team truth is stripped. The public writer has an independent
      // allowlist schema; research CLI exports keep full artifacts by default.
      visibility: "public",
      matchArtifactView: "truth-redacted",
      redactAssignmentTruth: true,
      projectPublicMatchArtifact: (artifact, episodeIndex) => projectPublicTournamentMatchArtifact(artifact, episodeIndex)
    });
  } catch {
    throw new HttpError(500, "Tournament artifact export failed.");
  }
  const density = await tournamentDensityFromManifestFile(written.files.manifest);
  const set: StoredTournamentArtifactSet = {
    id,
    createdAt,
    // The store/index is queryable through the same public artifact surface.
    // Do not let it reintroduce canonical experiment identity or a seed that
    // the on-disk public manifest intentionally omitted.
    experimentId: id,
    seed: "[REDACTED deterministic seed]",
    outputDir: written.outputDir,
    files: written.files,
    relativeFiles: relativeTournamentArtifactFiles(written),
    nativeSteps: density?.nativeSteps,
    committedSteps: density?.committedSteps,
    rejectedSteps: density?.rejectedSteps,
    metricCount: density?.metricCount,
    scorecardEligibleMetricCount: density?.scorecardEligibleMetricCount,
    metricPromotionClassCounts: density?.metricPromotionClassCounts,
    scorecardEligibleMetricClassCounts: density?.scorecardEligibleMetricClassCounts,
    projection: {
      visibility: "public",
      matchArtifactView: "truth-redacted",
      assignmentTruthRedacted: true,
      publicShareSafe: true
    }
  };
  await loadTournamentArtifactSetIndex(baseDir);
  saveTournamentArtifactSet(set);
  await writeTournamentArtifactSetIndex(baseDir);
  // Register episode match artifacts into the match store so seeded pairwise
  // comparisons can hydrate baseline/candidate artifacts through /api/matches.
  await registerTournamentMatchArtifacts(options.result);
  // A public tournament bundle is intentionally not a comparison bundle.
  // Comparison construction needs canonical evaluation and identity records;
  // feeding it truth-redacted display DTOs either fails or pressures the public
  // projection to retain forbidden fields. Operators can build a scoped
  // comparison from registered canonical matches through the local route.
  return set;
}
}
