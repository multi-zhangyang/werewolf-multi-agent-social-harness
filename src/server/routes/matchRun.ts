import express from "express";
import { providerDiagnosticSummaryFromEnv } from "../../agents/providerRegistry";
import { assertRuntimeModelsAvailable, normalizeModelList } from "../../agents/schema";
import { applyCommand, createGame, getPendingActions } from "../../core/engine";
import { isAgentPendingAction } from "../../core/pending";
import { DEFAULT_CONFIG } from "../../core/roles";
import type { GameConfig } from "../../core/types";
import { buildMatchArtifact } from "../../harness/artifacts";
import {
  type HarnessAssignmentConfig,
  assertAssignmentProfileReferences,
  assignmentFromUnknown,
  describeResolvedAssignments,
  profilesFromUnknown,
  resolveAgentConfigs
} from "../../harness/profiles";
import { probeHarnessTurn, runHarnessMatch } from "../../harness/runtime";
import {
  DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER,
  type HarnessAgentConfig,
  type HarnessAgentProfile,
  WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS
} from "../../harness/types";
import { projectWerewolfLivePublicState } from "../../harness/werewolfAdapter";
import { publicApiFailureFromError } from "../apiFailure";
import type { ServerContext } from "../context";
import {
  buildMatchSummary,
  buildProbePublicDiagnostic,
  buildProbeSummary,
  modelsFromProfiles,
  serializeLiveMatchStart,
  serializeStoredMatch,
  summarizePublicAssignmentConfig
} from "../dto";
import {
  parseOptionalDurationMs,
  parseOptionalJointPhaseScheduler,
  parseOptionalPositiveInteger,
  parseTemperature
} from "../httpValidation";
import { persistMatchArtifact, writeMatchArtifactIndex } from "../matchArtifactStore";
import { createMatchRecord, getMatch, saveMatch } from "../store";
import { randomUUID } from "node:crypto";

export function registerMatchRunRoutes(app: express.Express, context: ServerContext): void {
const { createReasoner, matchArtifactBaseDir, liveMatchProjections, setLiveProjection, loadMatchArtifactIndex } = context;

app.post("/api/matches/run", async (req, res, next) => {
  const startedAt = performance.now();
  let models: string[] = [];
  let temperature = 0.7;
  let profiles: HarnessAgentProfile[] = [];
  let assignment: HarnessAssignmentConfig | undefined;
  let maxTransitions: number | undefined;
  let timeoutMs: number | undefined;
  let jointPhaseScheduler: "aec-batched-decision" | "parallel" | undefined;
  try {
    models = normalizeModelList(Array.isArray(req.body?.models) ? req.body.models.join(",") : process.env.LLM_MODELS);
    temperature = parseTemperature(process.env.AGENT_TEMPERATURE ?? req.body?.temperature ?? 0.7);
    profiles = profilesFromUnknown(req.body?.profiles ?? process.env.AGENT_PROFILES, models, temperature);
    models = modelsFromProfiles(profiles);
    assertRuntimeModelsAvailable(models, "Match request");
    assignment = assignmentFromUnknown(req.body?.assignment ?? process.env.AGENT_ASSIGNMENT);
    assertAssignmentProfileReferences(assignment, profiles);
    maxTransitions = parseOptionalPositiveInteger(req.body?.maxTransitions, "maxTransitions");
    timeoutMs = parseOptionalDurationMs(req.body?.timeoutMs ?? req.body?.timeout, "timeoutMs");
    jointPhaseScheduler = parseOptionalJointPhaseScheduler(req.body?.jointPhaseScheduler);
    if (
      jointPhaseScheduler === "parallel" &&
      maxTransitions !== undefined &&
      maxTransitions < WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS
    ) {
      throw new Error(
        `jointPhaseScheduler=parallel requires maxTransitions >= ${WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS} (system.advance + seer.inspect + joint wolf batch).`
      );
    }
    const validationState = createGame({
      id: "match-request-validation",
      seed: typeof req.body?.seed === "string" && req.body.seed.trim() ? req.body.seed : "match-request-validation",
      config: {
        ...DEFAULT_CONFIG,
        ...(req.body?.config as Partial<GameConfig> | undefined)
      }
    });
    resolveAgentConfigs(validationState.players, profiles, 0, temperature, assignment);
  } catch (error) {
    const failure = publicApiFailureFromError(error);
    res.status(400).json({
      summary: {
        kind: "match",
        ok: false,
        provider: providerDiagnosticSummaryFromEnv(),
        seed: typeof req.body?.seed === "string" && req.body.seed.trim() ? req.body.seed : null,
        models,
        profileCount: profiles.length,
        modelCount: models.length,
        assignment: summarizePublicAssignmentConfig(assignment),
        resolvedAssignments: [],
        limits: {
          maxTransitions: maxTransitions ?? null,
          timeoutMs: timeoutMs ?? null,
          jointPhaseScheduler: jointPhaseScheduler ?? DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER
        },
        elapsedMs: Math.round(performance.now() - startedAt),
        timedOut: false,
        evaluation: null,
        failureReason: failure.message,
        providerFailure: failure.providerFailure ?? null
      },
      error: failure.message
    });
    return;
  }
  try {
    await loadMatchArtifactIndex(matchArtifactBaseDir);
  } catch (error) {
    next(error);
    return;
  }
  const record = createMatchRecord({
    seed: req.body?.seed,
    config: req.body?.config as Partial<GameConfig> | undefined,
    models
  });
  record.status = "running";
  saveMatch(record);

  const abortController = new AbortController();
  const timeout = timeoutMs
    ? setTimeout(() => abortController.abort(new Error(`Match timeout exceeded ${timeoutMs}ms.`)), timeoutMs)
    : undefined;
  timeout?.unref();
  if (req.body?.live === true) {
    // Preserve the established synchronous /api/matches/run contract unless a
    // client explicitly asks for a server-owned running projection lifecycle.
    setLiveProjection(record.id, projectWerewolfLivePublicState(record.state));
    res.status(202).json(serializeLiveMatchStart(record.id));
    void (async () => {
      try {
        const agents: HarnessAgentConfig[] = resolveAgentConfigs(record.state.players, profiles, 0, temperature, assignment);
        const resolvedAssignments = describeResolvedAssignments(record.state.players, agents);
        const result = await runHarnessMatch({
          initialState: record.state,
          agents,
          reasoner: createReasoner(abortController.signal),
          maxTransitions,
          executionLimits: { abortSignal: abortController.signal },
          jointPhaseScheduler,
          onLivePublicState: (publicState) => setLiveProjection(record.id, publicState)
        });
        const artifact = buildMatchArtifact({
          runId: record.id,
          matchId: record.id,
          createdAt: record.createdAt,
          seed: record.state.seed,
          models,
          profiles,
          assignment,
          resolvedAssignments,
          result
        });
        await persistMatchArtifact(artifact, matchArtifactBaseDir);
        record.artifact = artifact;
        saveMatch(record);
        await writeMatchArtifactIndex(matchArtifactBaseDir);
      } catch (error) {
        const failure = publicApiFailureFromError(error);
        delete record.artifact;
        record.status = "failed";
        record.error = failure.message;
        saveMatch(record);
      } finally {
        liveMatchProjections.delete(record.id);
        if (timeout) clearTimeout(timeout);
      }
    })();
    return;
  }
  let artifactFinalized = false;

  try {
    const agents: HarnessAgentConfig[] = resolveAgentConfigs(record.state.players, profiles, 0, temperature, assignment);
    const resolvedAssignments = describeResolvedAssignments(record.state.players, agents);
    const result = await runHarnessMatch({
      initialState: record.state,
      agents,
      reasoner: createReasoner(abortController.signal),
      maxTransitions,
      executionLimits: { abortSignal: abortController.signal },
      jointPhaseScheduler
    });
    const artifact = buildMatchArtifact({
      runId: record.id,
      matchId: record.id,
      createdAt: record.createdAt,
      seed: record.state.seed,
      models,
      profiles,
      assignment,
      resolvedAssignments,
      result
    });
    await persistMatchArtifact(artifact, matchArtifactBaseDir);
    record.artifact = artifact;
    saveMatch(record);
    artifactFinalized = true;
    const completedRecord = getMatch(record.id);
    if (!completedRecord?.artifact) throw new Error(`Finalized match ${record.id} was not stored as an artifact-backed match.`);
    await writeMatchArtifactIndex(matchArtifactBaseDir);
    res.status(result.status === "failed" ? 207 : 200).json({
      ...serializeStoredMatch(completedRecord),
      summary: buildMatchSummary(result, {
        seed: record.state.seed,
        models,
        profiles,
        assignment,
        resolvedAssignments,
        maxTransitions,
        timeoutMs,
        jointPhaseScheduler,
        elapsedMs: Math.round(performance.now() - startedAt)
      })
    });
  } catch (error) {
    if (artifactFinalized) {
      next(error);
      return;
    }
    const failure = publicApiFailureFromError(error);
    delete record.artifact;
    record.status = "failed";
    record.error = failure.message;
    saveMatch(record);
    res.status(500).json({
      ...serializeStoredMatch(record),
      summary: {
        kind: "match",
        ok: false,
        provider: providerDiagnosticSummaryFromEnv(),
        seed: record.state.seed,
        models,
        profileCount: profiles.length,
        modelCount: models.length,
        assignment: summarizePublicAssignmentConfig(assignment),
        resolvedAssignments: [],
        limits: {
          maxTransitions: maxTransitions ?? null,
          timeoutMs: timeoutMs ?? null,
          jointPhaseScheduler: jointPhaseScheduler ?? DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER
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

app.post("/api/harness/probe", async (req, res) => {
  const model =
    typeof req.body?.model === "string" && req.body.model.trim()
      ? req.body.model.trim()
      : normalizeModelList(process.env.LLM_MODELS)[0];
  if (!model) {
    res.status(400).json({ error: "Probe requires model or LLM_MODELS." });
    return;
  }
  try {
    assertRuntimeModelsAvailable([model], "Probe request");
  } catch (error) {
    const failure = publicApiFailureFromError(error);
    res.status(400).json({
      summary: {
        kind: "probe",
        ok: false,
        provider: providerDiagnosticSummaryFromEnv(),
        model,
        timeoutMs: null,
        elapsedMs: 0,
        modelLatencyMs: null,
        timedOut: false,
        failureReason: failure.message,
        providerFailure: failure.providerFailure ?? null
      },
      error: failure.message
    });
    return;
  }
  const timeoutMs = parseOptionalDurationMs(req.body?.timeoutMs ?? req.body?.timeout, "timeoutMs");
  const abortController = new AbortController();
  const timeout = timeoutMs
    ? setTimeout(() => abortController.abort(new Error(`Probe timeout exceeded ${timeoutMs}ms.`)), timeoutMs)
    : undefined;
  timeout?.unref();
  const startedAt = performance.now();

  try {
    let state = createGame({
      id: `probe-${randomUUID()}`,
      seed: req.body?.seed ?? `probe-${model}-${Date.now()}`
    });
    while (getPendingActions(state).length === 1 && getPendingActions(state)[0].kind === "advance") {
      state = applyCommand(state, { type: "system.advance", actorId: "system" });
    }
    const action = getPendingActions(state).find(isAgentPendingAction);
    if (!action) throw new Error("No Agent action available in probe state.");
    const probe = await probeHarnessTurn({
      state,
      action,
      agent: {
        playerId: action.actorId,
        model,
        temperature: Number(process.env.AGENT_TEMPERATURE ?? 0.3)
      },
      reasoner: createReasoner(abortController.signal)
    });
    res.json({
      summary: buildProbeSummary({
        model,
        state,
        action,
        probe,
        elapsedMs: Math.round(performance.now() - startedAt),
        timeoutMs
      }),
      source: "diagnostic-probe",
      applied: false,
      model,
      diagnostic: buildProbePublicDiagnostic(probe.trace)
    });
  } catch (error) {
    const failure = publicApiFailureFromError(error);
    res.status(500).json({
      summary: {
        kind: "probe",
        ok: false,
        provider: providerDiagnosticSummaryFromEnv(),
        model,
        timeoutMs: timeoutMs ?? null,
        elapsedMs: Math.round(performance.now() - startedAt),
        modelLatencyMs: null,
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
}
