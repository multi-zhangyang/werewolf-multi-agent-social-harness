import express from "express";
import { providerDiagnosticSummaryFromEnv } from "../../agents/providerRegistry";
import { type NormalizedMatrixExperiment, runExperimentMatrix } from "../../harness/experimentMatrix";
import { publicApiFailureFromError } from "../apiFailure";
import { assertLocalResearchArtifactAccess } from "../artifactAccess";
import { contentTypeForArtifactFile, isFileReadNotFound, resolveRegisteredExperimentMatrixArtifactFile } from "../artifactFiles";
import {
  getExperimentMatrixArtifactSetForBaseDir,
  listExperimentMatrixArtifactSetsForBaseDir,
  loadExperimentMatrixArtifactSetIndex,
  persistExperimentMatrixArtifactSet
} from "../artifactSetStore";
import type { ServerContext } from "../context";
import { buildExperimentMatrixSummary, serializeExperimentMatrixArtifactSet, serializeExperimentMatrixCellSummaryForApi } from "../dto";
import {
  HttpError,
  assertForbiddenMatrixRequestFields,
  matrixExperimentTimeoutMs,
  normalizeMatrixExperimentRequest,
  parseOptionalBoolean,
  requestBodyObject
} from "../httpValidation";
import { readFile } from "node:fs/promises";

export function registerExperimentMatrixRoutes(app: express.Express, context: ServerContext): void {
const { artifactAccessBindHost, createReasoner, experimentRunBaseDir, matrixArtifactBaseDir } = context;


/**
 * Matrix execution is a control-plane API over tournament experiments.  Its
 * response deliberately contains aggregate, recorded truth only: raw
 * tournament results stay inside local/research artifact sets.
 */
app.post("/api/experiments/matrix/run", async (req, res) => {
  let experiment: NormalizedMatrixExperiment;
  let exportArtifacts = false;
  try {
    const body = requestBodyObject(req.body);
    assertForbiddenMatrixRequestFields(body, "experiment matrix run");
    exportArtifacts = parseOptionalBoolean(body.exportArtifacts, "exportArtifacts") ?? false;
    if (exportArtifacts && !matrixArtifactBaseDir) {
      throw new HttpError(
        400,
        "Experiment matrix artifact export requires configured MATRIX_ARTIFACT_BASE_DIR or TOURNAMENT_ARTIFACT_BASE_DIR."
      );
    }
    experiment = normalizeMatrixExperimentRequest(body);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    const failure = publicApiFailureFromError(error);
    res.status(status).json({
      summary: {
        kind: "experiment-matrix",
        ok: false,
        provider: providerDiagnosticSummaryFromEnv(),
        failureReason: failure.message,
        providerFailure: failure.providerFailure ?? null
      },
      error: failure.message
    });
    return;
  }

  const timeoutMs = matrixExperimentTimeoutMs(experiment);
  const abortController = new AbortController();
  const timeout = timeoutMs
    ? setTimeout(() => abortController.abort(new Error(`Matrix timeout exceeded ${timeoutMs}ms.`)), timeoutMs)
    : undefined;
  timeout?.unref();
  const startedAt = performance.now();
  try {
    const result = await runExperimentMatrix({
      experiment,
      includeArtifacts: exportArtifacts,
      reasoner: createReasoner(abortController.signal),
      executionLimits: { abortSignal: abortController.signal },
      orchestrationBaseDirectory: experimentRunBaseDir
    });
    const artifactSet = exportArtifacts
      ? await persistExperimentMatrixArtifactSet({ result, baseDir: matrixArtifactBaseDir })
      : null;
    const serializedArtifacts = artifactSet ? serializeExperimentMatrixArtifactSet(artifactSet) : null;
    res.status(result.cellsFailed || result.cellsUnstarted > 0 || result.gamesFailed || result.gamesUnstarted > 0 ? 207 : 200).json({
      summary: {
        ...buildExperimentMatrixSummary(result, {
          timeoutMs,
          elapsedMs: Math.round(performance.now() - startedAt),
          timedOut: abortController.signal.aborted
        }),
        artifacts: serializedArtifacts
      },
      artifacts: serializedArtifacts,
      cells: result.cells.map(serializeExperimentMatrixCellSummaryForApi),
      statistics: result.statistics
    });
  } catch (error) {
    const failure = publicApiFailureFromError(error);
    res.status(500).json({
      summary: {
        kind: "experiment-matrix",
        ok: false,
        provider: providerDiagnosticSummaryFromEnv(),
        matrixId: experiment.id,
        cellsRequested: experiment.cells.length,
        limits: { timeoutMs: timeoutMs ?? null },
        elapsedMs: Math.round(performance.now() - startedAt),
        timedOut: abortController.signal.aborted,
        failureReason: failure.message,
        providerFailure: failure.providerFailure ?? null
      },
      error: failure.message
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

app.get("/api/experiments/matrix/artifacts", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadExperimentMatrixArtifactSetIndex(matrixArtifactBaseDir);
    res.json({
      artifactSets: listExperimentMatrixArtifactSetsForBaseDir(matrixArtifactBaseDir).map(serializeExperimentMatrixArtifactSet)
    });
  } catch (error) {
    next(error);
  }
});

app.get(/^\/api\/experiments\/matrix\/artifacts\/([^/]+)\/files\/(.+)$/, async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    const params = req.params as unknown as string[];
    const artifactSetId = params[0];
    const requestedPath = params[1];
    await loadExperimentMatrixArtifactSetIndex(matrixArtifactBaseDir);
    const artifactSet = getExperimentMatrixArtifactSetForBaseDir(artifactSetId, matrixArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "experiment matrix artifact set not found" });
      return;
    }
    const file = await resolveRegisteredExperimentMatrixArtifactFile(artifactSet, requestedPath, matrixArtifactBaseDir);
    let content: Buffer;
    try {
      content = await readFile(file.absolutePath);
    } catch (error) {
      if (isFileReadNotFound(error)) {
        res.status(404).json({ error: "experiment matrix artifact file not found" });
        return;
      }
      throw new HttpError(500, "experiment matrix artifact file could not be read");
    }
    res.type(contentTypeForArtifactFile(file.relativePath)).send(content);
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/matrix/artifacts/:id", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadExperimentMatrixArtifactSetIndex(matrixArtifactBaseDir);
    const artifactSet = getExperimentMatrixArtifactSetForBaseDir(req.params.id, matrixArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "experiment matrix artifact set not found" });
      return;
    }
    res.json(serializeExperimentMatrixArtifactSet(artifactSet));
  } catch (error) {
    next(error);
  }
});
}
