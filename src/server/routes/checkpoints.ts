import express from "express";
import { providerDiagnosticSummaryFromEnv } from "../../agents/providerRegistry";
import {
  assertValidHarnessCheckpoint,
  buildMatchArtifact,
  createHarnessForkProvenance,
  forkHarnessRunOptions
} from "../../harness/artifacts";
import { hashStableState } from "../../harness/hash";
import { describeResolvedAssignments } from "../../harness/profiles";
import { runHarnessMatch } from "../../harness/runtime";
import { providerFailureApiMessage, publicApiFailureFromError, sanitizeApiErrorText } from "../apiFailure";
import {
  assertLocalOperatorRegistryAccess,
  checkpointArtifactViewFromQuery,
  setArtifactProjectionResponseHeaders
} from "../artifactAccess";
import { projectHarnessCheckpointForView } from "../artifactViews";
import { loadCheckpointArtifactIndex, writeCheckpointForkAttemptStore } from "../checkpointArtifactStore";
import {
  buildCheckpointBranchTreeSummary,
  buildCheckpointForksSummary,
  checkpointBranchTreeQueryFromRequest,
  modelsFromCheckpoint,
  profilesFromCheckpoint,
  serializeCheckpointPublicResponse,
  serializeCheckpointSummary,
  summarizeForkProvenance
} from "../checkpointDto";
import type { ServerContext } from "../context";
import { buildMatchSummary, serializeStoredMatch } from "../dto";
import {
  FORBIDDEN_CHECKPOINT_BODY_FIELDS,
  assertAllowedBodyFields,
  assertForbiddenBodyFields,
  parseOptionalBoundedString,
  parseOptionalDurationMs,
  parseOptionalPositiveInteger,
  requestBodyObject
} from "../httpValidation";
import { persistMatchArtifact, writeMatchArtifactIndex } from "../matchArtifactStore";
import {
  type StoredCheckpointForkAttempt,
  createMatchRecordFromState,
  deleteCheckpointForkAttempt,
  getCheckpoint,
  getCheckpointForRead,
  getMatch,
  listCheckpointForkAttempts,
  listCheckpointsForRead,
  listMatchesForRead,
  saveCheckpointForkAttempt,
  saveMatch
} from "../store";

export function registerCheckpointRoutes(app: express.Express, context: ServerContext): void {
const { artifactAccessBindHost, createReasoner, checkpointArtifactBaseDir, matchArtifactBaseDir, loadServerArtifactStores } = context;

app.get("/api/checkpoints", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    await loadCheckpointArtifactIndex(checkpointArtifactBaseDir);
    const matchId = typeof req.query.matchId === "string" ? req.query.matchId : undefined;
    res.json({
      checkpoints: listCheckpointsForRead(matchId).map(serializeCheckpointSummary)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/checkpoints/:id", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    await loadCheckpointArtifactIndex(checkpointArtifactBaseDir);
    const checkpoint = getCheckpointForRead(req.params.id);
    if (!checkpoint) {
      res.status(404).json({ error: "checkpoint not found" });
      return;
    }
    res.json(serializeCheckpointPublicResponse(checkpoint));
  } catch (error) {
    next(error);
  }
});

app.get("/api/checkpoints/:id/forks", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    await loadServerArtifactStores();
    const checkpoint = getCheckpointForRead(req.params.id);
    if (!checkpoint) {
      res.status(404).json({ error: "checkpoint not found" });
      return;
    }
    const forkArtifacts = listMatchesForRead()
      .flatMap((match) => (match.artifact?.forkOf?.checkpointId === checkpoint.checkpointId ? [match.artifact] : []))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({
      summary: buildCheckpointForksSummary(checkpoint, forkArtifacts, listCheckpointForkAttempts(checkpoint.checkpointId))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/checkpoints/:id/branch-tree", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    await loadServerArtifactStores();
    const checkpoint = getCheckpointForRead(req.params.id);
    if (!checkpoint) {
      res.status(404).json({ error: "checkpoint not found" });
      return;
    }
    const artifacts = listMatchesForRead().flatMap((match) => (match.artifact ? [match.artifact] : []));
    const query = checkpointBranchTreeQueryFromRequest(req.query);
    res.json({
      summary: buildCheckpointBranchTreeSummary(
        checkpoint,
        artifacts,
        listCheckpointsForRead(),
        listCheckpointForkAttempts(),
        query
      )
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/checkpoints/:id/artifact", async (req, res, next) => {
  try {
    await loadCheckpointArtifactIndex(checkpointArtifactBaseDir);
    const checkpoint = getCheckpointForRead(req.params.id);
    if (!checkpoint) {
      res.status(404).json({ error: "checkpoint not found" });
      return;
    }
    const view = checkpointArtifactViewFromQuery(req.query, req, artifactAccessBindHost);
    const projected = projectHarnessCheckpointForView(checkpoint, view);
    setArtifactProjectionResponseHeaders(res, view);
    res.json(projected);
  } catch (error) {
    next(error);
  }
});

app.post("/api/checkpoints/:id/fork", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
  } catch (error) {
    next(error);
    return;
  }
  try {
    await loadServerArtifactStores();
  } catch (error) {
    next(error);
    return;
  }
  const checkpoint = getCheckpoint(req.params.id);
  if (!checkpoint) {
    res.status(404).json({ error: "checkpoint not found" });
    return;
  }

  let body: Record<string, unknown>;
  let reason: string | undefined;
  let maxTransitions: number | undefined;
  let timeoutMs: number | undefined;
  try {
    body = requestBodyObject(req.body);
    assertForbiddenBodyFields(body, FORBIDDEN_CHECKPOINT_BODY_FIELDS, "checkpoint fork");
    assertAllowedBodyFields(body, ["reason", "maxTransitions", "timeoutMs", "timeout"], "checkpoint fork");
    assertValidHarnessCheckpoint(checkpoint);
    reason = parseOptionalBoundedString(body.reason, "reason", 256);
    maxTransitions = parseOptionalPositiveInteger(body.maxTransitions, "maxTransitions");
    timeoutMs = parseOptionalDurationMs(body.timeoutMs ?? body.timeout, "timeoutMs");
  } catch (error) {
    next(error);
    return;
  }

  const models = modelsFromCheckpoint(checkpoint);
  const profiles = profilesFromCheckpoint(checkpoint);
  const record = createMatchRecordFromState({
    state: checkpoint.state,
    models,
    status: "running"
  });

  let forkAttempt: StoredCheckpointForkAttempt;
  try {
    forkAttempt = {
      schemaVersion: "server.checkpoint-fork-attempt.v1",
      childRunId: record.id,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      status: "running",
      forkOf: createHarnessForkProvenance(checkpoint, {
        createdAt: record.createdAt,
        reason
      }),
      limits: {
        maxTransitions: maxTransitions ?? null,
        timeoutMs: timeoutMs ?? null
      }
    };
  } catch (error) {
    record.status = "failed";
    record.error = "Checkpoint fork provenance could not be created.";
    saveMatch(record);
    next(error);
    return;
  }
  saveMatch(record);
  try {
    saveCheckpointForkAttempt(forkAttempt);
    await writeCheckpointForkAttemptStore(checkpointArtifactBaseDir);
  } catch (error) {
    deleteCheckpointForkAttempt(record.id);
    record.status = "failed";
    record.error = "Checkpoint fork attempt could not be persisted before execution.";
    saveMatch(record);
    next(error);
    return;
  }

  const startedAt = performance.now();
  const abortController = new AbortController();
  const timeout = timeoutMs
    ? setTimeout(() => abortController.abort(new Error(`Fork timeout exceeded ${timeoutMs}ms.`)), timeoutMs)
    : undefined;
  timeout?.unref();
  let artifactFinalized = false;

  try {
    const forkOptions = {
      ...forkHarnessRunOptions({
        checkpoint,
        reasoner: createReasoner(abortController.signal),
        maxTransitions,
        createdAt: record.createdAt,
        reason
      }),
      executionLimits: { abortSignal: abortController.signal }
    };
    if (hashStableState(forkOptions.forkOf) !== hashStableState(forkAttempt.forkOf)) {
      throw new Error("Checkpoint fork execution provenance did not match the durable attempt record.");
    }
    const resolvedAssignments = describeResolvedAssignments(forkOptions.initialState.players, forkOptions.agents);
    const result = await runHarnessMatch(forkOptions);
    const artifact = buildMatchArtifact({
      runId: record.id,
      matchId: record.id,
      createdAt: record.createdAt,
      seed: result.initialState.seed,
      models,
      profiles,
      resolvedAssignments,
      result
    });
    await persistMatchArtifact(artifact, matchArtifactBaseDir);
    record.artifact = artifact;
    saveMatch(record);
    artifactFinalized = true;
    const completedRecord = getMatch(record.id);
    if (!completedRecord?.artifact) throw new Error(`Finalized fork ${record.id} was not stored as an artifact-backed match.`);
    await writeMatchArtifactIndex(matchArtifactBaseDir);
    deleteCheckpointForkAttempt(record.id);
    await writeCheckpointForkAttemptStore(checkpointArtifactBaseDir);
    res.status(result.status === "failed" ? 207 : 200).json({
      ...serializeStoredMatch(completedRecord),
      summary: {
        ...buildMatchSummary(result, {
          seed: result.initialState.seed,
          models,
          profiles,
          resolvedAssignments,
          maxTransitions,
          timeoutMs,
          elapsedMs: Math.round(performance.now() - startedAt)
        }),
        kind: "fork",
        checkpointId: checkpoint.checkpointId,
        forkOf: result.forkOf ? summarizeForkProvenance(result.forkOf) : null
      }
    });
  } catch (error) {
    if (artifactFinalized) {
      next(error);
      return;
    }
    const failure = publicApiFailureFromError(error);
    const persistedFailureReason = failure.providerFailure
      ? providerFailureApiMessage(failure.providerFailure)
      : failure.code
        ? sanitizeApiErrorText(failure.message).slice(0, 512)
        : "Checkpoint fork execution failed before an artifact was recorded.";
    delete record.artifact;
    record.status = "failed";
    record.error = persistedFailureReason;
    saveMatch(record);
    const failedAttempt: StoredCheckpointForkAttempt = {
      ...forkAttempt,
      updatedAt: new Date().toISOString(),
      status: "failed",
      elapsedMs: Math.round(performance.now() - startedAt),
      timedOut: abortController.signal.aborted,
      failureCode: failure.code ?? "checkpoint_fork_execution_failed",
      failureReason: persistedFailureReason,
      providerFailure: failure.providerFailure ?? null
    };
    saveCheckpointForkAttempt(failedAttempt);
    try {
      await writeCheckpointForkAttemptStore(checkpointArtifactBaseDir);
    } catch (persistenceError) {
      next(persistenceError);
      return;
    }
    res.status(500).json({
      ...serializeStoredMatch(record),
      summary: {
        kind: "fork",
        ok: false,
        provider: providerDiagnosticSummaryFromEnv(),
        checkpointId: checkpoint.checkpointId,
        forkOf: summarizeForkProvenance(failedAttempt.forkOf),
        models,
        profileCount: profiles.length,
        modelCount: models.length,
        limits: {
          maxTransitions: maxTransitions ?? null,
          timeoutMs: timeoutMs ?? null
        },
        elapsedMs: Math.round(performance.now() - startedAt),
        timedOut: abortController.signal.aborted,
        evaluation: null,
        failureReason: persistedFailureReason,
        providerFailure: failure.providerFailure ?? null
      },
      error: persistedFailureReason
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});
}
