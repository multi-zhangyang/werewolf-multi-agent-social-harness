import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { modelClientFromEnv, providerConfigSummaryFromEnv } from "../agents/providerRegistry";
import { normalizeModelList } from "../agents/schema";
import { applyCommand, createGame, getPendingActions } from "../core/engine";
import { isAgentPendingAction } from "../core/pending";
import { DEFAULT_CONFIG } from "../core/roles";
import { serializePublicState } from "../core/view";
import type { GameCommand, GameConfig, GameEvent, GameState, MatchMetrics } from "../core/types";
import {
  assertValidMatchArtifactIntegrity,
  assertValidHarnessCheckpoint,
  buildFinalHarnessCheckpoint,
  buildHarnessCheckpointAtPrefix,
  buildMatchArtifact,
  forkHarnessRunOptions,
  HarnessCheckpointSelectionError,
  MATCH_ARTIFACT_VERSION,
  toTrajectoryJsonl,
  HARNESS_CHECKPOINT_VERSION,
  type HarnessCheckpoint,
  type HarnessCheckpointPrefixSelector,
  type MatchArtifact
} from "../harness/artifacts";
import {
  mergeExperimentOverrides,
  normalizeTournamentExperimentSpec,
  type NormalizedTournamentExperiment,
  type TournamentExperimentSpecV1
} from "../harness/experiment";
import { summarizeEvaluationWarnings } from "../harness/evaluation";
import {
  assertAssignmentProfileReferences,
  assignmentFromUnknown,
  describeResolvedAssignments,
  POLICY_NAMES,
  profilesFromModels,
  profilesFromUnknown,
  resolveAgentConfigs,
  type HarnessAssignmentConfig,
  type ResolvedAgentAssignment
} from "../harness/profiles";
import { OpenAIHarnessReasoner } from "../harness/reasoner";
import { replayHarnessTrajectory } from "../harness/replay";
import { probeHarnessTurn, runHarnessMatch } from "../harness/runtime";
import { hashStableState } from "../harness/hash";
import { buildMatchComparisonArtifact } from "../harness/matchComparison";
import { providerFailureFromError } from "../harness/providerFailure";
import { redactSecrets } from "../harness/redaction";
import { deriveSocialExposureRecords, type SocialExposureRecord, type SocialMessage } from "../harness/social";
import { runTournament, type TournamentEpisode, type TournamentResult } from "../harness/tournament";
import { TOURNAMENT_ARTIFACT_VERSION, writeTournamentArtifactDirectory, type TournamentArtifactWriteResult } from "../harness/tournamentArtifacts";
import type {
  AdversarialEvaluation,
  HarnessAgentConfig,
  HarnessAgentProfile,
  HarnessForkProvenance,
  HarnessReasoner,
  HarnessRunResult,
  HarnessTurnTrace,
  ProviderFailureSummary
} from "../harness/types";
import {
  countCheckpointsForMatch,
  createMatchRecord,
  createMatchRecordFromState,
  getCheckpoint,
  getMatch,
  getTournamentArtifactSet,
  listArtifactRecoveryAuditRecords,
  listCheckpoints,
  listMatches,
  listTournamentArtifactSets,
  saveArtifactRecoveryAuditRecord,
  saveCheckpoint,
  saveMatch,
  saveTournamentArtifactSet,
  type StoredArtifactRecoveryAuditRecord,
  type StoredTournamentArtifactFiles,
  type StoredTournamentArtifactSet,
  type StoredMatch
} from "./store";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOURNAMENT_ARTIFACT_SET_INDEX_FILE = "artifact_sets.index.json";
const CHECKPOINT_ARTIFACT_INDEX_FILE = "checkpoints.index.json";
const CHECKPOINT_ARTIFACT_DIR = "checkpoints";
const MATCH_ARTIFACT_INDEX_FILE = "matches.index.json";
const MATCH_ARTIFACT_DIR = "matches";
const ARTIFACT_RECOVERY_AUDIT_FILE = "artifact_recovery_audits.jsonl";
const ARTIFACT_RECOVERY_AUDIT_VERSION = "server.artifact-recovery-audit.v1";
const GENERATED_ARTIFACT_SET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARTIFACT_RECOVERY_AUDIT_MAX_LIMIT = 500;
const CHECKPOINT_BRANCH_TREE_MAX_DEPTH_LIMIT = 100;
const CHECKPOINT_BRANCH_TREE_MAX_NODES_LIMIT = 1000;

type ArtifactRecoveryReadResult<T> = { ok: true; artifact: T } | { ok: false; code: string };
interface ArtifactRecoveryAuditQuery {
  store?: StoredArtifactRecoveryAuditRecord["store"];
  source?: StoredArtifactRecoveryAuditRecord["source"];
  code?: string;
  limit?: number;
  offset: number;
}

interface CheckpointBranchTreeQuery {
  maxDepth?: number;
  maxNodes?: number;
}

export interface ServerAppDependencies {
  createReasoner?: (abortSignal: AbortSignal) => HarnessReasoner;
  tournamentArtifactBaseDir?: string;
  checkpointArtifactBaseDir?: string;
  matchArtifactBaseDir?: string;
}

export function createServerApp(dependencies: ServerAppDependencies = {}): express.Express {
const app = express();
const createReasoner =
  dependencies.createReasoner ??
  ((abortSignal: AbortSignal): HarnessReasoner => new OpenAIHarnessReasoner(modelClientFromEnv(process.env, { abortSignal })));
const tournamentArtifactBaseDir = normalizeOptionalDirectory(dependencies.tournamentArtifactBaseDir ?? process.env.TOURNAMENT_ARTIFACT_BASE_DIR);
const checkpointArtifactBaseDir = normalizeOptionalDirectory(dependencies.checkpointArtifactBaseDir ?? process.env.CHECKPOINT_ARTIFACT_BASE_DIR);
const matchArtifactBaseDir = normalizeOptionalDirectory(dependencies.matchArtifactBaseDir ?? process.env.MATCH_ARTIFACT_BASE_DIR);

app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  const provider = providerConfigSummaryFromEnv();
  res.json({
    ok: true,
    service: "werewolf-multi-agent-arena",
    provider,
    chatCompletionsUrl: provider.protocol === "openai-chat-completions" ? provider.endpoint : null,
    models: provider.models
  });
});

app.get("/api/config", (_req, res) => {
  const provider = providerConfigSummaryFromEnv();
  res.json({
    defaultConfig: DEFAULT_CONFIG,
    models: provider.models,
    policyNames: POLICY_NAMES,
    defaultProfiles: profilesFromModels(provider.models, Number(process.env.AGENT_TEMPERATURE ?? 0.7)),
    provider,
    chatCompletionsUrl: provider.protocol === "openai-chat-completions" ? provider.endpoint : null
  });
});

app.get("/api/artifact-recovery-audits", async (req, res, next) => {
  try {
    await loadServerArtifactStores();
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    const query = artifactRecoveryAuditQueryFromRequest(req.query);
    const filteredRecords = listArtifactRecoveryAuditRecords()
      .filter((record) => artifactRecoveryAuditRecordMatchesQuery(record, query))
      .map(serializeArtifactRecoveryAuditRecord);
    const records = filteredRecords.slice(query.offset, query.limit === undefined ? undefined : query.offset + query.limit);
    res.json({
      records,
      filters: {
        store: query.store ?? null,
        source: query.source ?? null,
        code: query.code ?? null
      },
      page: {
        total: filteredRecords.length,
        offset: query.offset,
        limit: query.limit ?? null,
        returned: records.length,
        hasMore: query.offset + records.length < filteredRecords.length
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/matches", async (_req, res, next) => {
  try {
    await loadServerArtifactStores();
    res.json(listMatches().map(serializeStoredMatch));
  } catch (error) {
    next(error);
  }
});

app.post("/api/matches", (req, res, next) => {
  try {
    const models = normalizeModelList(req.body?.models?.join?.(",") ?? process.env.LLM_MODELS);
    const record = createMatchRecord({
      seed: req.body?.seed,
      config: req.body?.config as Partial<GameConfig> | undefined,
      models
    });
    res.status(201).json(serializeStoredMatch(record));
  } catch (error) {
    next(error);
  }
});

app.get("/api/matches/:id", async (req, res, next) => {
  try {
    await loadServerArtifactStores();
    const match = getMatch(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    res.json(serializeStoredMatch(match));
  } catch (error) {
    next(error);
  }
});

app.get("/api/matches/:id/artifact", async (req, res, next) => {
  try {
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    const match = getMatch(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!match.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    res.json(projectMatchArtifactForView(match.artifact, artifactViewFromQuery(req.query)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/matches/:id/compare/:candidateId", async (req, res, next) => {
  try {
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    const view = artifactViewFromQuery(req.query);
    const baseline = getMatch(req.params.id);
    const candidate = getMatch(req.params.candidateId);
    if (!baseline || !candidate) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!baseline.artifact || !candidate.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    const baselineArtifact = projectMatchArtifactForView(baseline.artifact, view) as MatchArtifact;
    const candidateArtifact = projectMatchArtifactForView(candidate.artifact, view) as MatchArtifact;
    res.json(
      redactSecrets(
        buildMatchComparisonArtifact({
          baseline: baselineArtifact,
          candidate: candidateArtifact,
          view,
          createdAt: new Date(0).toISOString()
        })
      )
    );
  } catch (error) {
    next(error);
  }
});

app.get("/api/matches/:id/trajectory.jsonl", async (req, res, next) => {
  try {
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    const match = getMatch(req.params.id);
    if (!match) {
      res.status(404).send("match not found");
      return;
    }
    if (!match.artifact) {
      res.status(404).send("match artifact not available");
      return;
    }
    const artifact = projectMatchArtifactForView(match.artifact, artifactViewFromQuery(req.query)) as MatchArtifact;
    res.type("application/x-ndjson").send(toTrajectoryJsonl(artifact));
  } catch (error) {
    next(error);
  }
});

app.post("/api/matches/:id/replay", async (req, res, next) => {
  let match: StoredMatch | undefined;
  try {
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    match = getMatch(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!match.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    const expectedFinalHash = hashStableState(match.artifact.finalState);
    const replay = replayHarnessTrajectory({
      initialState: match.artifact.initialState,
      trajectory: match.artifact.trajectory,
      stopOnMismatch: req.body?.stopOnMismatch !== false,
      expectedFinalHash
    });
    res.status(replay.ok ? 200 : 409).json(
      serializeReplayResult(replay, {
        source: "server-owned-match-artifact",
        matchId: match.id,
        runId: match.artifact.runId,
        trajectorySteps: match.artifact.trajectory.length,
        expectedFinalHash,
        finalHashMatchesArtifact: replay.finalHash === expectedFinalHash
      }, { includeFinalState: false })
    );
  } catch (error) {
    if (!match?.artifact) {
      next(error);
      return;
    }
    const failure = publicApiFailureFromError(error);
    res.status(500).json({
      summary: {
        kind: "replay",
        ok: false,
        source: "server-owned-match-artifact",
        matchId: match.id,
        runId: match.artifact.runId,
        failureReason: failure.message,
        providerFailure: failure.providerFailure ?? null
      },
      error: failure.message
    });
  }
});

app.post("/api/matches/:id/checkpoints", async (req, res, next) => {
  try {
    const body = requestBodyObject(req.body);
    assertForbiddenBodyFields(body, FORBIDDEN_CHECKPOINT_BODY_FIELDS, "checkpoint creation");
    assertAllowedBodyFields(body, ["reason", "trajectoryLength", "traceId", "turnIndex"], "checkpoint creation");
    await loadServerArtifactStores();
    const match = getMatch(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!match.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    const reason = parseOptionalString(body.reason, "reason");
    const selector = checkpointPrefixSelectorFromBody(body);
    const checkpoint = selector
      ? buildHarnessCheckpointAtPrefix({
          artifact: match.artifact,
          selector,
          checkpointId: randomUUID(),
          reason
        })
      : buildFinalHarnessCheckpoint({
          artifact: match.artifact,
          checkpointId: randomUUID(),
          reason
        });
    assertValidHarnessCheckpoint(checkpoint);
    await persistCheckpointArtifact(checkpoint, checkpointArtifactBaseDir);
    saveCheckpoint(checkpoint);
    await writeCheckpointArtifactIndex(checkpointArtifactBaseDir);
    res.status(201).json(serializeCheckpointPublicResponse(checkpoint));
  } catch (error) {
    next(httpErrorFromCheckpointSelectionError(error));
  }
});

app.get("/api/matches/:id/fork-lineage", async (req, res, next) => {
  try {
    await loadServerArtifactStores();
    const match = getMatch(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!match.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    const checkpoint = match.artifact.forkOf ? getCheckpoint(match.artifact.forkOf.checkpointId) : undefined;
    res.json({
      summary: buildForkLineageSummary(match.artifact, checkpoint)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/checkpoints", async (req, res, next) => {
  try {
    await loadCheckpointArtifactIndex(checkpointArtifactBaseDir);
    const matchId = typeof req.query.matchId === "string" ? req.query.matchId : undefined;
    res.json({
      checkpoints: listCheckpoints(matchId).map(serializeCheckpointSummary)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/checkpoints/:id", async (req, res, next) => {
  try {
    await loadCheckpointArtifactIndex(checkpointArtifactBaseDir);
    const checkpoint = getCheckpoint(req.params.id);
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
    await loadServerArtifactStores();
    const checkpoint = getCheckpoint(req.params.id);
    if (!checkpoint) {
      res.status(404).json({ error: "checkpoint not found" });
      return;
    }
    const forkArtifacts = listMatches()
      .flatMap((match) => (match.artifact?.forkOf?.checkpointId === checkpoint.checkpointId ? [match.artifact] : []))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({
      summary: buildCheckpointForksSummary(checkpoint, forkArtifacts)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/checkpoints/:id/branch-tree", async (req, res, next) => {
  try {
    await loadServerArtifactStores();
    const checkpoint = getCheckpoint(req.params.id);
    if (!checkpoint) {
      res.status(404).json({ error: "checkpoint not found" });
      return;
    }
    const artifacts = listMatches().flatMap((match) => (match.artifact ? [match.artifact] : []));
    const query = checkpointBranchTreeQueryFromRequest(req.query);
    res.json({
      summary: buildCheckpointBranchTreeSummary(checkpoint, artifacts, listCheckpoints(), query)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/checkpoints/:id/artifact", async (req, res, next) => {
  try {
    await loadCheckpointArtifactIndex(checkpointArtifactBaseDir);
    const checkpoint = getCheckpoint(req.params.id);
    if (!checkpoint) {
      res.status(404).json({ error: "checkpoint not found" });
      return;
    }
    res.json(redactSecrets(checkpoint));
  } catch (error) {
    next(error);
  }
});

app.post("/api/checkpoints/:id/fork", async (req, res, next) => {
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
    reason = parseOptionalString(body.reason, "reason");
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
  saveMatch(record);

  const startedAt = performance.now();
  const abortController = new AbortController();
  const timeout = timeoutMs
    ? setTimeout(() => abortController.abort(new Error(`Fork timeout exceeded ${timeoutMs}ms.`)), timeoutMs)
    : undefined;
  timeout?.unref();

  try {
    const forkOptions = forkHarnessRunOptions({
      checkpoint,
      reasoner: createReasoner(abortController.signal),
      maxTransitions,
      reason
    });
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
    record.status = result.status === "failed" ? "failed" : "completed";
    record.error = result.status === "failed" ? result.failureReason : undefined;
    record.state = result.state;
    record.metrics = result.metrics;
    record.artifact = artifact;
    record.initialState = result.initialState;
    record.trajectory = result.trajectory;
    record.socialEpisode = result.socialEpisode;
    record.evaluation = result.evaluation;
    record.evaluationReport = result.evaluationReport;
    record.profiles = profiles;
    record.resolvedAssignments = resolvedAssignments;
    saveMatch(record);
    await writeMatchArtifactIndex(matchArtifactBaseDir);
    res.status(result.status === "failed" ? 207 : 200).json({
      ...serializeStoredMatch(record),
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
    const failure = publicApiFailureFromError(error);
    record.status = "failed";
    record.error = failure.message;
    clearMatchArtifactFields(record);
    saveMatch(record);
    res.status(500).json({
      ...serializeStoredMatch(record),
      summary: {
        kind: "fork",
        ok: false,
        endpoint: providerConfigSummaryFromEnv().endpoint,
        checkpointId: checkpoint.checkpointId,
        forkOf: null,
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
        failureReason: failure.message,
        providerFailure: failure.providerFailure ?? null
      },
      error: failure.message
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

app.post("/api/matches/:id/command", (req, res, next) => {
  try {
    const match = getMatch(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    match.state = applyCommand(match.state, req.body as GameCommand);
    saveMatch(match);
    res.json(serializeStoredMatch(match));
  } catch (error) {
    next(error);
  }
});

app.post("/api/matches/run", async (req, res, next) => {
  const startedAt = performance.now();
  let models: string[] = [];
  let temperature = 0.7;
  let profiles: HarnessAgentProfile[] = [];
  let assignment: HarnessAssignmentConfig | undefined;
  let maxTransitions: number | undefined;
  let timeoutMs: number | undefined;
  try {
    models = normalizeModelList(Array.isArray(req.body?.models) ? req.body.models.join(",") : process.env.LLM_MODELS);
    temperature = parseTemperature(process.env.AGENT_TEMPERATURE ?? req.body?.temperature ?? 0.7);
    profiles = profilesFromUnknown(req.body?.profiles ?? process.env.AGENT_PROFILES, models, temperature);
    models = modelsFromProfiles(profiles);
    assignment = assignmentFromUnknown(req.body?.assignment ?? process.env.AGENT_ASSIGNMENT);
    assertAssignmentProfileReferences(assignment, profiles);
    maxTransitions = parseOptionalPositiveInteger(req.body?.maxTransitions, "maxTransitions");
    timeoutMs = parseOptionalDurationMs(req.body?.timeoutMs ?? req.body?.timeout, "timeoutMs");
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
        endpoint: providerConfigSummaryFromEnv().endpoint,
        seed: typeof req.body?.seed === "string" && req.body.seed.trim() ? req.body.seed : null,
        models,
        profileCount: profiles.length,
        modelCount: models.length,
        assignment: summarizePublicAssignmentConfig(assignment),
        resolvedAssignments: [],
        limits: {
          maxTransitions: maxTransitions ?? null,
          timeoutMs: timeoutMs ?? null
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

  try {
    const agents: HarnessAgentConfig[] = resolveAgentConfigs(record.state.players, profiles, 0, temperature, assignment);
    const resolvedAssignments = describeResolvedAssignments(record.state.players, agents);
    const result = await runHarnessMatch({
      initialState: record.state,
      agents,
      reasoner: createReasoner(abortController.signal),
      maxTransitions
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
    record.status = result.status === "failed" ? "failed" : "completed";
    record.error = result.status === "failed" ? result.failureReason : undefined;
    record.state = result.state;
    record.metrics = result.metrics;
    record.artifact = artifact;
    record.initialState = result.initialState;
    record.trajectory = result.trajectory;
    record.socialEpisode = result.socialEpisode;
    record.evaluation = result.evaluation;
    record.evaluationReport = result.evaluationReport;
    record.profiles = profiles;
    record.assignment = assignment;
    record.resolvedAssignments = resolvedAssignments;
    saveMatch(record);
    await writeMatchArtifactIndex(matchArtifactBaseDir);
    res.status(result.status === "failed" ? 207 : 200).json({
      ...serializeStoredMatch(record),
      summary: buildMatchSummary(result, {
        seed: record.state.seed,
        models,
        profiles,
        assignment,
        resolvedAssignments,
        maxTransitions,
        timeoutMs,
        elapsedMs: Math.round(performance.now() - startedAt)
      })
    });
  } catch (error) {
    const failure = publicApiFailureFromError(error);
    record.status = "failed";
    record.error = failure.message;
    clearMatchArtifactFields(record);
    saveMatch(record);
    res.status(500).json({
      ...serializeStoredMatch(record),
      summary: {
        kind: "match",
        ok: false,
        endpoint: providerConfigSummaryFromEnv().endpoint,
        seed: record.state.seed,
        models,
        profileCount: profiles.length,
        modelCount: models.length,
        assignment: summarizePublicAssignmentConfig(assignment),
        resolvedAssignments: [],
        limits: {
          maxTransitions: maxTransitions ?? null,
          timeoutMs: timeoutMs ?? null
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

app.post("/api/replay", (req, res) => {
  try {
    const initialState = req.body?.initialState ?? req.body?.artifact?.initialState;
    const trajectory = req.body?.trajectory ?? req.body?.artifact?.trajectory;
    if (!initialState || !Array.isArray(trajectory)) {
      res.status(400).json({ error: "Replay requires initialState and trajectory, or artifact with those fields." });
      return;
    }
    const expectedFinalHash =
      typeof req.body?.expectedFinalHash === "string"
        ? req.body.expectedFinalHash
        : req.body?.artifact?.finalState
          ? hashStableState(req.body.artifact.finalState as GameState)
          : undefined;
    const replay = replayHarnessTrajectory({
      initialState: initialState as GameState,
      trajectory,
      stopOnMismatch: req.body?.stopOnMismatch !== false,
      expectedFinalHash
    });
    res.status(replay.ok ? 200 : 409).json(
      serializeReplayResult(replay, { source: "client-submitted-diagnostic", expectedFinalHash }, { includeFinalState: false })
    );
  } catch (error) {
    const failure = publicApiFailureFromError(error);
    res.status(500).json({
      summary: {
        kind: "replay",
        ok: false,
        source: "client-submitted-diagnostic",
        failureReason: failure.message,
        providerFailure: failure.providerFailure ?? null
      },
      error: failure.message
    });
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
        endpoint: providerConfigSummaryFromEnv().endpoint,
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
        endpoint: providerConfigSummaryFromEnv().endpoint,
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
    const result = await runTournament({
      models: experiment.models,
      profiles: experiment.profiles,
      assignment: experiment.assignment,
      games: experiment.games,
      seed: experiment.seed,
      maxTransitions: experiment.maxTransitions,
      config: experiment.config,
      temperature: experiment.temperature,
      continueOnError: experiment.continueOnError,
      experiment,
      includeArtifacts: exportArtifacts,
      reasoner: createReasoner(abortController.signal)
    });
    const artifactSet = exportArtifacts
      ? await persistTournamentArtifactSet({
          result,
          experimentId: experiment.id,
          seed: experiment.seed,
          baseDir: tournamentArtifactBaseDir
        })
      : null;
    res.status(result.gamesFailed ? 207 : 200).json({
      summary: {
        ...buildTournamentSummary(result, {
          experimentId: experiment.id,
          seed: experiment.seed,
          models: result.models,
          profiles: result.profiles,
          assignment: result.assignment,
          games: experiment.games,
          maxTransitions: experiment.maxTransitions,
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
        endpoint: providerConfigSummaryFromEnv().endpoint,
        experimentId: experiment.id,
        seed: experiment.seed,
        models: experiment.models,
        profileCount: experiment.profiles.length,
        modelCount: experiment.models.length,
        assignment: summarizePublicAssignmentConfig(experiment.assignment),
        games: experiment.games,
        limits: {
          maxTransitions: experiment.maxTransitions ?? null,
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

app.get("/api/tournament-artifacts", async (_req, res, next) => {
  try {
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    res.json({
      artifactSets: listTournamentArtifactSetsForBaseDir(tournamentArtifactBaseDir).map(serializeTournamentArtifactSet)
    });
  } catch (error) {
    next(error);
  }
});

app.get(/^\/api\/tournament-artifacts\/([^/]+)\/files\/(.+)$/, async (req, res, next) => {
  try {
    const params = req.params as unknown as string[];
    const artifactSetId = params[0];
    const requestedPath = params[1];
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    const artifactSet = getTournamentArtifactSetForBaseDir(artifactSetId, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "tournament artifact set not found" });
      return;
    }
    const file = await resolveRegisteredTournamentArtifactFile(artifactSet, requestedPath, tournamentArtifactBaseDir);
    let content: Buffer;
    try {
      content = await readFile(file.absolutePath);
    } catch (error) {
      if (isFileReadNotFound(error)) {
        res.status(404).json({ error: "tournament artifact file not found" });
        return;
      }
      throw new HttpError(500, "tournament artifact file could not be read");
    }
    res.type(contentTypeForArtifactFile(file.relativePath)).send(content);
  } catch (error) {
    next(error);
  }
});

app.get("/api/tournament-artifacts/:id", async (req, res, next) => {
  try {
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    const artifactSet = getTournamentArtifactSetForBaseDir(req.params.id, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "tournament artifact set not found" });
      return;
    }
    res.json(serializeTournamentArtifactSet(artifactSet));
  } catch (error) {
    next(error);
  }
});

function buildMatchSummary(
  result: HarnessRunResult,
  options: {
    seed: string;
    models: string[];
    profiles: HarnessAgentProfile[];
    assignment?: HarnessAssignmentConfig;
    resolvedAssignments: ResolvedAgentAssignment[];
    maxTransitions?: number;
    timeoutMs?: number;
    elapsedMs: number;
  }
): object {
  const harnessFailures = result.state.events.filter((event) => event.type === "harness.error").map(summarizeHarnessFailure);
  return {
    kind: "match",
    ok: result.status !== "failed" && harnessFailures.length === 0,
    endpoint: providerConfigSummaryFromEnv().endpoint,
    seed: options.seed,
    models: options.models,
    profileCount: options.profiles.length,
    modelCount: options.models.length,
    assignment: summarizePublicAssignmentConfig(options.assignment),
    resolvedAssignments: options.resolvedAssignments.map(summarizePublicAssignment),
    status: result.status,
    truncationReason: result.truncationReason ?? null,
    failureStateHash: result.failureStateHash ?? null,
    limits: {
      maxTransitions: options.maxTransitions ?? null,
      timeoutMs: options.timeoutMs ?? null
    },
    elapsedMs: options.elapsedMs,
    gameOver: result.state.phase === "game_over",
    stoppedBeforeGameOver: result.state.phase !== "game_over",
    winner: result.state.winner ?? null,
    endReason: result.state.endReason ?? null,
    day: result.state.day,
    phase: result.state.phase,
    harnessTurnCount: result.metrics.harnessTurnCount,
    harnessErrorCount: result.metrics.harnessErrorCount,
    trajectorySteps: result.trajectory.length,
    socialSteps: result.socialEpisode.steps.length,
    averageModelLatencyMs: result.metrics.averageLatencyMs,
    modelUsage: summarizeModelUsage(result.metrics),
    evaluation: summarizeEvaluation(result.evaluation),
    evaluationReport: summarizeEvaluationReport(result.evaluationReport),
    harnessFailureCount: harnessFailures.length,
    failureReason: publicHarnessFailureReason(result.failureReason, harnessFailures)
  };
}

const FORBIDDEN_CHECKPOINT_BODY_FIELDS = [
  "checkpointId",
  "path",
  "file",
  "artifactPath",
  "checkpointPath",
  "outputDir",
  "artifact",
  "checkpoint",
  "state",
  "initialState",
  "agents",
  "initialAgentStates",
  "trajectory",
  "socialMessages",
  "initialSocialMessages",
  "stateHash",
  "trajectoryHash",
  "agentsHash",
  "socialMessagesHash",
  "agentSnapshots",
  "agentSnapshotFrames",
  "agentSnapshotsAfterStep",
  "actorSnapshotsAfterStep",
  "agentSnapshotsHashAfterStep",
  "actorSnapshotsHashAfterStep",
  "agentSnapshotFrameIdAfterStep",
  "actorSnapshotFrameIdAfterStep"
];

const FORBIDDEN_TOURNAMENT_BODY_FIELDS = [
  "path",
  "file",
  "artifactPath",
  "outputDir",
  "exportDir",
  "checkpointPath",
  "artifact",
  "artifacts",
  "checkpoint",
  "overwrite",
  "baseDir",
  "manifestPath",
  "registryPath"
];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

function requestBodyObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) throw new HttpError(400, "Request body must be a JSON object.");
  return body;
}

function normalizeOptionalDirectory(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(500, "Configured tournament artifact base directory must be a string.");
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

function assertAllowedBodyFields(body: Record<string, unknown>, allowed: string[], context: string): void {
  const allowedSet = new Set(allowed);
  const unknownFields = Object.keys(body).filter((field) => !allowedSet.has(field));
  if (unknownFields.length) {
    throw new HttpError(400, `${context} request contains unsupported field(s): ${unknownFields.join(", ")}.`);
  }
}

function assertForbiddenBodyFields(body: Record<string, unknown>, forbidden: string[], context: string): void {
  const forbiddenFields = forbidden.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (forbiddenFields.length) {
    throw new HttpError(400, `${context} request contains forbidden field(s): ${forbiddenFields.join(", ")}.`);
  }
}

function assertForbiddenTournamentRequestFields(body: Record<string, unknown>, context: string): void {
  assertForbiddenBodyFields(body, FORBIDDEN_TOURNAMENT_BODY_FIELDS, context);
  if (isRecord(body.spec)) {
    assertForbiddenBodyFields(body.spec, FORBIDDEN_TOURNAMENT_BODY_FIELDS, `${context} spec`);
  }
}

function parseOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string.`);
  return value;
}

function checkpointPrefixSelectorFromBody(body: Record<string, unknown>): HarnessCheckpointPrefixSelector | undefined {
  const hasTraceId = body.traceId !== undefined && body.traceId !== null && body.traceId !== "";
  const hasTurnIndex = body.turnIndex !== undefined && body.turnIndex !== null && body.turnIndex !== "";
  const hasTrajectoryLength = body.trajectoryLength !== undefined && body.trajectoryLength !== null && body.trajectoryLength !== "";
  const selectorCount = [hasTraceId, hasTurnIndex, hasTrajectoryLength].filter(Boolean).length;
  if (selectorCount === 0) return undefined;
  if (selectorCount > 1) throw new HttpError(400, "checkpoint creation request must include at most one prefix selector.");
  if (hasTraceId) return { traceId: parseOptionalString(body.traceId, "traceId") };
  if (hasTurnIndex) return { turnIndex: parseOptionalPositiveInteger(body.turnIndex, "turnIndex") };
  return { trajectoryLength: parseOptionalPositiveInteger(body.trajectoryLength, "trajectoryLength") };
}

function httpErrorFromCheckpointSelectionError(error: unknown): unknown {
  if (!(error instanceof HarnessCheckpointSelectionError)) return error;
  const status = error.code === "ambiguous_selector" || error.code === "selector_not_found" ? 400 : 409;
  return new HttpError(status, error.message, error.code);
}

function parseOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new HttpError(400, `${name} must be a boolean.`);
}

function serializeCheckpointPublicResponse(checkpoint: HarnessCheckpoint): object {
  return {
    summary: serializeCheckpointSummary(checkpoint),
    artifactUrl: checkpointArtifactUrl(checkpoint.checkpointId)
  };
}

function serializeCheckpointSummary(checkpoint: HarnessCheckpoint): object {
  return {
    kind: "checkpoint",
    ok: true,
    checkpointId: checkpoint.checkpointId,
    createdAt: checkpoint.createdAt,
    reason: checkpoint.reason ?? null,
    source: {
      runId: checkpoint.source.runId,
      matchId: checkpoint.source.matchId ?? null,
      seed: checkpoint.source.seed,
      status: checkpoint.source.status,
      traceRef: checkpoint.source.traceId ? hashStableState({ traceId: checkpoint.source.traceId }).slice(0, 16) : null,
      turnIndex: checkpoint.source.turnIndex ?? null,
      trajectoryLength: checkpoint.source.trajectoryLength,
      messageSeq: checkpoint.source.messageSeq ?? null,
      stateHash: checkpoint.source.stateHash,
      trajectoryHash: checkpoint.source.trajectoryHash,
      agentsHash: checkpoint.source.agentsHash,
      socialMessagesHash: checkpoint.source.socialMessagesHash,
      failureReason: checkpoint.source.failureReason ? sanitizeApiErrorText(checkpoint.source.failureReason) : null,
      truncationReason: checkpoint.source.truncationReason ?? null
    },
    counts: {
      agents: checkpoint.agents.length,
      trajectorySteps: checkpoint.trajectory.length,
      socialMessages: checkpoint.socialMessages.length
    }
  };
}

function buildCheckpointForksSummary(checkpoint: HarnessCheckpoint, artifacts: MatchArtifact[]): object {
  const forks = artifacts.map((artifact) => buildForkChildSummary(artifact, checkpoint));
  return {
    kind: "checkpoint-forks",
    schemaVersion: "server.checkpoint-forks-summary.v1",
    ok: forks.every((fork) => isRecord(fork.lineage) && fork.lineage.ok === true),
    checkpoint: serializeCheckpointSummary(checkpoint),
    childCount: forks.length,
    forks
  };
}

function buildCheckpointBranchTreeSummary(
  rootCheckpoint: HarnessCheckpoint,
  artifacts: MatchArtifact[],
  checkpoints: HarnessCheckpoint[],
  limits: CheckpointBranchTreeQuery = {}
): object {
  const checkpointById = new Map<string, HarnessCheckpoint>();
  for (const checkpoint of checkpoints) checkpointById.set(checkpoint.checkpointId, checkpoint);
  checkpointById.set(rootCheckpoint.checkpointId, rootCheckpoint);

  const artifactsByParentCheckpoint = new Map<string, MatchArtifact[]>();
  for (const artifact of artifacts) {
    const checkpointId = artifact.forkOf?.checkpointId;
    if (!checkpointId) continue;
    const current = artifactsByParentCheckpoint.get(checkpointId) ?? [];
    current.push(artifact);
    artifactsByParentCheckpoint.set(checkpointId, current);
  }
  for (const children of artifactsByParentCheckpoint.values()) {
    children.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const checkpointsBySourceRun = new Map<string, HarnessCheckpoint[]>();
  for (const checkpoint of checkpointById.values()) {
    const sourceIds = new Set([checkpoint.source.runId, checkpoint.source.matchId].filter((id): id is string => Boolean(id)));
    for (const sourceId of sourceIds) {
      const current = checkpointsBySourceRun.get(sourceId) ?? [];
      current.push(checkpoint);
      checkpointsBySourceRun.set(sourceId, current);
    }
  }
  for (const sourceCheckpoints of checkpointsBySourceRun.values()) {
    sourceCheckpoints.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const checkpointNodes = new Map<string, object>();
  const matchNodes = new Map<string, object>();
  const edges = new Map<string, object>();
  const truncationReasons = new Set<string>();
  const truncation = {
    omittedCheckpoints: 0,
    omittedMatches: 0,
    omittedEdges: 0
  };
  const nodeCount = () => checkpointNodes.size + matchNodes.size;
  const recordOmittedNode = (kind: "checkpoint" | "match", reason: "maxDepth" | "maxNodes") => {
    truncationReasons.add(reason);
    if (kind === "checkpoint") truncation.omittedCheckpoints += 1;
    else truncation.omittedMatches += 1;
  };
  const canIncludeNode = (kind: "checkpoint" | "match", alreadyIncluded: boolean, depth: number): boolean => {
    if (limits.maxDepth !== undefined && depth > limits.maxDepth) {
      recordOmittedNode(kind, "maxDepth");
      return false;
    }
    if (!alreadyIncluded && limits.maxNodes !== undefined && nodeCount() >= limits.maxNodes) {
      recordOmittedNode(kind, "maxNodes");
      return false;
    }
    return true;
  };
  const includeCheckpointNode = (checkpoint: HarnessCheckpoint, depth: number): boolean => {
    const existing = checkpointNodes.get(checkpoint.checkpointId);
    const existingDepth = checkpointNodeDepth(existing);
    if (existingDepth !== null && existingDepth <= depth) return true;
    if (!canIncludeNode("checkpoint", Boolean(existing), depth)) return false;
    checkpointNodes.set(checkpoint.checkpointId, {
      depth,
      checkpointId: checkpoint.checkpointId,
      createdAt: checkpoint.createdAt,
      childForkCount: artifactsByParentCheckpoint.get(checkpoint.checkpointId)?.length ?? 0,
      summary: serializeCheckpointSummary(checkpoint)
    });
    return true;
  };
  const includeMatchNode = (artifact: MatchArtifact, checkpoint: HarnessCheckpoint, depth: number): Record<string, unknown> | undefined => {
    const existing = matchNodes.get(artifact.runId);
    const existingDepth = checkpointNodeDepth(existing);
    if (isRecord(existing) && existingDepth !== null && existingDepth <= depth) return existing;
    if (!canIncludeNode("match", Boolean(existing), depth)) return undefined;
    const childSummary = buildForkChildSummary(artifact, checkpoint);
    const node = {
      depth,
      parentCheckpointId: checkpoint.checkpointId,
      ...childSummary
    };
    matchNodes.set(artifact.runId, node);
    return node;
  };
  const queue: Array<{ kind: "checkpoint"; checkpoint: HarnessCheckpoint; depth: number } | { kind: "match"; artifact: MatchArtifact; depth: number }> = [
    { kind: "checkpoint", checkpoint: rootCheckpoint, depth: 0 }
  ];
  const processedCheckpoints = new Set<string>();
  const processedMatches = new Set<string>();

  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    if (item.kind === "checkpoint") {
      const checkpoint = item.checkpoint;
      if (!includeCheckpointNode(checkpoint, item.depth)) continue;
      if (processedCheckpoints.has(checkpoint.checkpointId)) continue;
      processedCheckpoints.add(checkpoint.checkpointId);

      for (const artifact of artifactsByParentCheckpoint.get(checkpoint.checkpointId) ?? []) {
        const childDepth = item.depth + 1;
        const childSummary = includeMatchNode(artifact, checkpoint, childDepth);
        if (!childSummary) {
          truncation.omittedEdges += 1;
          continue;
        }
        const edgeId = `checkpoint-fork:${checkpoint.checkpointId}:${artifact.runId}`;
        const lineage = isRecord(childSummary.lineage) ? childSummary.lineage : {};
        const boundary = isRecord(lineage.boundary) ? lineage.boundary : {};
        edges.set(edgeId, {
          id: edgeId,
          kind: "checkpoint-fork",
          fromCheckpointId: checkpoint.checkpointId,
          toRunId: artifact.runId,
          ok: lineage.ok === true,
          boundaryStatus: typeof boundary.status === "string" ? boundary.status : "unknown"
        });
        if (!processedMatches.has(artifact.runId)) queue.push({ kind: "match", artifact, depth: childDepth });
      }
    } else {
      const artifact = item.artifact;
      if (processedMatches.has(artifact.runId)) continue;
      processedMatches.add(artifact.runId);
      const sourceCheckpoints = checkpointsBySourceRun.get(artifact.runId) ?? [];
      for (const checkpoint of sourceCheckpoints) {
        if (checkpoint.checkpointId === rootCheckpoint.checkpointId) continue;
        const childDepth = item.depth + 1;
        if (!includeCheckpointNode(checkpoint, childDepth)) {
          truncation.omittedEdges += 1;
          continue;
        }
        const edgeId = `match-checkpoint:${artifact.runId}:${checkpoint.checkpointId}`;
        edges.set(edgeId, {
          id: edgeId,
          kind: "match-checkpoint",
          fromRunId: artifact.runId,
          toCheckpointId: checkpoint.checkpointId
        });
        if (!processedCheckpoints.has(checkpoint.checkpointId)) {
          queue.push({ kind: "checkpoint", checkpoint, depth: childDepth });
        }
      }
    }
  }

  const checkpointList = [...checkpointNodes.values()].sort(branchNodeSort);
  const matchList = [...matchNodes.values()].sort(branchNodeSort);
  const edgeList = [...edges.values()].sort((a, b) => branchNodeId(a).localeCompare(branchNodeId(b)));
  const lineageOk = matchList.every((node) => {
    if (!isRecord(node) || !isRecord(node.lineage)) return true;
    return node.lineage.ok === true;
  });
  const maxDepth = [...checkpointList, ...matchList].reduce((max, node) => Math.max(max, checkpointNodeDepth(node) ?? 0), 0);
  return {
    kind: "checkpoint-branch-tree",
    schemaVersion: "server.checkpoint-branch-tree-summary.v1",
    ok: lineageOk,
    okScope: "returned",
    rootCheckpointId: rootCheckpoint.checkpointId,
    root: serializeCheckpointSummary(rootCheckpoint),
    counts: {
      checkpoints: checkpointList.length,
      matches: matchList.length,
      edges: edgeList.length,
      maxDepth
    },
    limits: {
      maxDepth: limits.maxDepth ?? null,
      maxNodes: limits.maxNodes ?? null
    },
    truncation: {
      isTruncated: truncationReasons.size > 0,
      reasons: [...truncationReasons].sort(),
      omittedCheckpoints: truncation.omittedCheckpoints,
      omittedMatches: truncation.omittedMatches,
      omittedEdges: truncation.omittedEdges
    },
    checkpoints: checkpointList,
    matches: matchList,
    edges: edgeList
  };
}

function buildForkChildSummary(artifact: MatchArtifact, checkpoint: HarnessCheckpoint): Record<string, unknown> {
  const lineage = buildForkLineageSummary(artifact, checkpoint);
  return {
    runId: artifact.runId,
    matchId: artifact.matchId ?? null,
    createdAt: artifact.createdAt,
    status: artifact.status,
    truncationReason: artifact.truncationReason ?? null,
    failureReason: artifact.failureReason ? sanitizeApiErrorText(artifact.failureReason) : null,
    trajectoryLength: artifact.trajectory.length,
    socialMessages: artifact.socialEpisode.messages.length,
    forkOf: artifact.forkOf ? summarizeForkProvenance(artifact.forkOf) : null,
    lineage
  };
}

function branchNodeSort(a: object, b: object): number {
  const depthDelta = (checkpointNodeDepth(a) ?? 0) - (checkpointNodeDepth(b) ?? 0);
  if (depthDelta !== 0) return depthDelta;
  const aCreatedAt = isRecord(a) && typeof a.createdAt === "string" ? a.createdAt : "";
  const bCreatedAt = isRecord(b) && typeof b.createdAt === "string" ? b.createdAt : "";
  return bCreatedAt.localeCompare(aCreatedAt);
}

function checkpointNodeDepth(value: unknown): number | null {
  return isRecord(value) && typeof value.depth === "number" ? value.depth : null;
}

function branchNodeId(value: unknown): string {
  return isRecord(value) && typeof value.id === "string" ? value.id : "";
}

function buildForkLineageSummary(artifact: MatchArtifact, checkpoint?: HarnessCheckpoint): object {
  const forkOf = artifact.forkOf;
  const firstStep = artifact.trajectory[0];
  const finalStep = artifact.trajectory.at(-1);
  const lastMessage = artifact.socialEpisode.messages.at(-1);
  const childSummary = {
    runId: artifact.runId,
    matchId: artifact.matchId ?? null,
    createdAt: artifact.createdAt,
    status: artifact.status,
    truncationReason: artifact.truncationReason ?? null,
    failureReason: artifact.failureReason ? sanitizeApiErrorText(artifact.failureReason) : null,
    trajectoryLength: artifact.trajectory.length,
    socialSteps: artifact.socialEpisode.steps.length,
    socialMessages: artifact.socialEpisode.messages.length,
    firstStepPreStateHash: firstStep?.preStateHash ?? null,
    finalStepPostStateHash: finalStep?.postStateHash ?? null,
    finalStateHash: hashStableState(artifact.finalState),
    firstNewMessageSeq: checkpoint ? artifact.socialEpisode.messages[checkpoint.socialMessages.length]?.seq ?? null : null,
    lastMessageSeq: lastMessage?.seq ?? null
  };

  if (!forkOf) {
    return {
      kind: "fork-lineage",
      schemaVersion: "server.fork-lineage-summary.v1",
      ok: true,
      isFork: false,
      runId: artifact.runId,
      matchId: artifact.matchId ?? null,
      forkOf: null,
      parent: null,
      child: childSummary,
      boundary: {
        status: "not_fork",
        checkpointFound: false,
        stateHashMatches: null,
        checkpointSourceMatchesForkOf: null,
        messagePrefixMatchesCheckpoint: null,
        newTrajectorySteps: artifact.trajectory.length,
        newSocialMessages: null
      }
    };
  }

  const checkpointSourceMatchesForkOf = checkpoint ? checkpointSourceMatchesForkProvenance(checkpoint, forkOf) : null;
  const messagePrefixMatchesCheckpoint = checkpoint ? socialMessagePrefixMatchesCheckpoint(artifact, checkpoint) : null;
  const stateHashMatches = firstStep ? firstStep.preStateHash === forkOf.parentStateHash : null;
  const boundaryStatus = forkBoundaryStatus({
    checkpoint,
    checkpointSourceMatchesForkOf,
    messagePrefixMatchesCheckpoint,
    stateHashMatches,
    hasChildStep: Boolean(firstStep)
  });
  const newSocialMessages = checkpoint ? artifact.socialEpisode.messages.length - checkpoint.socialMessages.length : null;

  return {
    kind: "fork-lineage",
    schemaVersion: "server.fork-lineage-summary.v1",
    ok: boundaryStatus !== "mismatch",
    isFork: true,
    runId: artifact.runId,
    matchId: artifact.matchId ?? null,
    forkOf: summarizeForkProvenance(forkOf),
    parent: {
      checkpointId: forkOf.checkpointId,
      runId: forkOf.parentRunId ?? null,
      matchId: forkOf.parentMatchId ?? null,
      traceRef: forkOf.parentTraceId ? hashStableState({ traceId: forkOf.parentTraceId }).slice(0, 16) : null,
      turnIndex: forkOf.parentTurnIndex ?? null,
      trajectoryLength: forkOf.parentTrajectoryLength,
      messageSeq: checkpoint?.source.messageSeq ?? null,
      stateHash: forkOf.parentStateHash,
      trajectoryHash: forkOf.parentTrajectoryHash ?? null,
      agentsHash: forkOf.parentAgentsHash ?? null,
      socialMessagesHash: forkOf.parentSocialMessagesHash ?? null,
      checkpointFound: Boolean(checkpoint)
    },
    child: childSummary,
    boundary: {
      status: boundaryStatus,
      checkpointFound: Boolean(checkpoint),
      stateHashMatches,
      checkpointSourceMatchesForkOf,
      messagePrefixMatchesCheckpoint,
      newTrajectorySteps: artifact.trajectory.length,
      newSocialMessages
    }
  };
}

function checkpointSourceMatchesForkProvenance(checkpoint: HarnessCheckpoint, forkOf: HarnessForkProvenance): boolean {
  return (
    checkpoint.checkpointId === forkOf.checkpointId &&
    checkpoint.source.runId === forkOf.parentRunId &&
    (checkpoint.source.matchId ?? null) === (forkOf.parentMatchId ?? null) &&
    (checkpoint.source.traceId ?? null) === (forkOf.parentTraceId ?? null) &&
    (checkpoint.source.turnIndex ?? null) === (forkOf.parentTurnIndex ?? null) &&
    checkpoint.source.stateHash === forkOf.parentStateHash &&
    (checkpoint.source.trajectoryHash ?? null) === (forkOf.parentTrajectoryHash ?? null) &&
    (checkpoint.source.agentsHash ?? null) === (forkOf.parentAgentsHash ?? null) &&
    (checkpoint.source.socialMessagesHash ?? null) === (forkOf.parentSocialMessagesHash ?? null) &&
    checkpoint.source.trajectoryLength === forkOf.parentTrajectoryLength
  );
}

function socialMessagePrefixMatchesCheckpoint(artifact: MatchArtifact, checkpoint: HarnessCheckpoint): boolean {
  if (artifact.socialEpisode.messages.length < checkpoint.socialMessages.length) return false;
  const prefix = artifact.socialEpisode.messages.slice(0, checkpoint.socialMessages.length);
  return hashStableState(prefix) === checkpoint.source.socialMessagesHash;
}

function forkBoundaryStatus(input: {
  checkpoint: HarnessCheckpoint | undefined;
  checkpointSourceMatchesForkOf: boolean | null;
  messagePrefixMatchesCheckpoint: boolean | null;
  stateHashMatches: boolean | null;
  hasChildStep: boolean;
}): string {
  if (
    input.stateHashMatches === false ||
    input.checkpointSourceMatchesForkOf === false ||
    input.messagePrefixMatchesCheckpoint === false
  ) {
    return "mismatch";
  }
  if (!input.hasChildStep) return "no_child_steps";
  if (!input.checkpoint) return "checkpoint_unavailable";
  return "verified";
}

function checkpointArtifactUrl(checkpointId: string): string {
  return `/api/checkpoints/${encodeURIComponent(checkpointId)}/artifact`;
}

function modelsFromCheckpoint(checkpoint: HarnessCheckpoint): string[] {
  return Array.from(new Set(checkpoint.agents.map((agent) => agent.model)));
}

function profilesFromCheckpoint(checkpoint: HarnessCheckpoint): HarnessAgentProfile[] {
  const profiles = new Map<string, HarnessAgentProfile>();
  for (const agent of checkpoint.agents) {
    const id = agent.profileId ?? agent.playerId;
    if (profiles.has(id)) continue;
    profiles.set(id, {
      id,
      model: agent.model,
      temperature: agent.temperature,
      policyName: agent.policyName
    });
  }
  return [...profiles.values()];
}

async function loadServerArtifactStores(): Promise<void> {
  await loadMatchArtifactIndex(matchArtifactBaseDir);
  await loadCheckpointArtifactIndex(checkpointArtifactBaseDir);
}

async function persistMatchArtifact(artifact: MatchArtifact, baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  assertValidMatchArtifactIntegrity(artifact);
  const root = path.resolve(baseDir);
  const file = matchArtifactAbsoluteFile(root, matchArtifactId(artifact));
  await ensureWritableArtifactSubdirectory(root, matchArtifactDirectory(root), "Match artifact directory is not safe.");
  await writeFile(file, `${JSON.stringify(redactSecrets(artifact), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function loadMatchArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await loadArtifactRecoveryAuditSidecar(root, "match");
  let parsed: unknown;
  let shouldRewriteIndex = false;
  const loadedIds = new Set<string>();
  let indexExists = true;
  try {
    parsed = JSON.parse(await readFile(matchArtifactIndexPath(root), "utf8"));
  } catch (error) {
    if (isFileReadNotFound(error)) {
      indexExists = false;
    } else if (error instanceof SyntaxError) {
      indexExists = false;
      await recordArtifactRecoveryAudit(root, {
        store: "match",
        source: "index",
        code: "index_invalid_json",
        relativeFile: MATCH_ARTIFACT_INDEX_FILE,
        message: "Match artifact index contained invalid JSON and will be repaired."
      });
      shouldRewriteIndex = true;
    } else {
      throw new HttpError(500, "Match artifact index could not be read.");
    }
  }

  if (indexExists) {
    if (!isRecord(parsed) || parsed.kind !== "match-artifact-index" || !Array.isArray(parsed.matches)) {
      await recordArtifactRecoveryAudit(root, {
        store: "match",
        source: "index",
        code: "index_invalid_shape",
        relativeFile: MATCH_ARTIFACT_INDEX_FILE,
        message: "Match artifact index shape was invalid and will be repaired."
      });
      shouldRewriteIndex = true;
    } else {
      for (const record of parsed.matches) {
        const artifact = await matchArtifactFromIndexRecord(root, record);
        if (artifact) {
          saveMatch(storedMatchFromMatchArtifact(artifact));
          loadedIds.add(matchArtifactId(artifact));
        } else {
          await recordArtifactRecoveryAudit(root, {
            store: "match",
            source: "index",
            code: "index_record_rejected",
            artifactId: isRecord(record) ? stringField(record, "matchId") ?? undefined : undefined,
            relativeFile: isRecord(record) ? stringField(record, "relativeFile") ?? undefined : undefined,
            message: "Match artifact index record did not resolve to a valid server-owned artifact."
          });
          shouldRewriteIndex = true;
        }
      }
    }
  }

  const scannedIds = await loadMatchArtifactsFromDirectory(root, loadedIds);
  if (scannedIds.length > 0 || shouldRewriteIndex || !indexExists) {
    await writeMatchArtifactIndex(root);
  }
}

async function writeMatchArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await mkdir(matchArtifactDirectory(root), { recursive: true });
  const matches = [];
  for (const match of listMatches()) {
    if (!match.artifact) continue;
    const id = matchArtifactId(match.artifact);
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(id)) continue;
    const artifact = await matchArtifactFromFile(root, id, matchArtifactRelativeFile(id));
    if (!artifact) continue;
    matches.push({
      matchId: matchArtifactId(artifact),
      runId: artifact.runId,
      createdAt: artifact.createdAt,
      seed: artifact.seed,
      status: artifact.status,
      stateHash: hashStableState(artifact.finalState),
      trajectoryHash: hashStableState(artifact.trajectory),
      agentCount: artifact.agents.length,
      trajectorySteps: artifact.trajectory.length,
      socialMessages: artifact.socialEpisode.messages.length,
      relativeFile: matchArtifactRelativeFile(matchArtifactId(artifact))
    });
  }
  const index = {
    artifactVersion: "harness.match-artifact-index.v1",
    kind: "match-artifact-index",
    updatedAt: new Date().toISOString(),
    matches
  };
  await writeFile(matchArtifactIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

async function matchArtifactFromIndexRecord(baseDir: string, value: unknown): Promise<MatchArtifact | null> {
  try {
    if (!isRecord(value)) return null;
    const matchId = stringField(value, "matchId");
    const relativeFile = stringField(value, "relativeFile");
    if (!matchId || !relativeFile) return null;
    if (relativeFile !== matchArtifactRelativeFile(matchId)) return null;
    return matchArtifactFromFile(baseDir, matchId, relativeFile);
  } catch {
    return null;
  }
}

async function loadMatchArtifactsFromDirectory(baseDir: string, skipIds: Set<string>): Promise<string[]> {
  const dir = matchArtifactDirectory(baseDir);
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isFileReadNotFound(error)) return [];
    throw new HttpError(500, "Match artifact directory could not be read.");
  }
  const loadedIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const matchId = entry.name.slice(0, -".json".length);
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(matchId)) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "match",
        source: "directory",
        code: "file_name_rejected",
        relativeFile: `${MATCH_ARTIFACT_DIR}/${entry.name}`,
        message: "Match artifact file name was not a generated UUID JSON artifact."
      });
      continue;
    }
    if (skipIds.has(matchId)) continue;
    const artifactResult = await readMatchArtifactFromFile(baseDir, matchId, matchArtifactRelativeFile(matchId));
    if (!artifactResult.ok) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "match",
        source: "directory",
        code: artifactResult.code,
        artifactId: matchId,
        relativeFile: matchArtifactRelativeFile(matchId),
        message: artifactRecoveryAuditMessageForCode("match", "directory", artifactResult.code) ?? "Match artifact file failed recovery validation."
      });
      continue;
    }
    const artifact = artifactResult.artifact;
    saveMatch(storedMatchFromMatchArtifact(artifact));
    const id = matchArtifactId(artifact);
    skipIds.add(id);
    loadedIds.push(id);
  }
  return loadedIds;
}

async function matchArtifactFromFile(baseDir: string, matchId: string, relativeFile: string): Promise<MatchArtifact | null> {
  const result = await readMatchArtifactFromFile(baseDir, matchId, relativeFile);
  return result.ok ? result.artifact : null;
}

async function readMatchArtifactFromFile(baseDir: string, matchId: string, relativeFile: string): Promise<ArtifactRecoveryReadResult<MatchArtifact>> {
  try {
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(matchId)) return { ok: false, code: "file_identity_mismatch" };
    const normalized = normalizeRequestedArtifactPath(relativeFile);
    if (normalized !== matchArtifactRelativeFile(matchId)) return { ok: false, code: "file_identity_mismatch" };
    const absolutePath = resolveUnderDirectory(baseDir, normalized);
    try {
      await assertRegularFileInsideDirectory(baseDir, absolutePath, "match artifact file not found");
    } catch {
      return { ok: false, code: "file_not_regular" };
    }
    let artifact: unknown;
    try {
      artifact = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
    } catch (error) {
      return { ok: false, code: error instanceof SyntaxError ? "file_invalid_json" : "file_not_regular" };
    }
    if (!isRecord(artifact)) return { ok: false, code: "file_invalid_shape" };
    if (artifact.artifactVersion !== MATCH_ARTIFACT_VERSION || artifact.kind !== "match") return { ok: false, code: "file_invalid_shape" };
    const restored = artifact as unknown as MatchArtifact;
    if (matchArtifactId(restored) !== matchId) return { ok: false, code: "file_identity_mismatch" };
    try {
      assertValidMatchArtifactIntegrity(restored);
    } catch {
      return { ok: false, code: "file_integrity_invalid" };
    }
    return { ok: true, artifact: restored };
  } catch {
    return { ok: false, code: "file_identity_mismatch" };
  }
}

function storedMatchFromMatchArtifact(artifact: MatchArtifact): StoredMatch {
  const id = matchArtifactId(artifact);
  return {
    id,
    createdAt: artifact.createdAt,
    state: artifact.finalState,
    metrics: artifact.metrics,
    artifact,
    initialState: artifact.initialState,
    trajectory: artifact.trajectory,
    socialEpisode: artifact.socialEpisode,
    evaluation: artifact.evaluation,
    evaluationReport: artifact.evaluationReport,
    profiles: artifact.profiles,
    assignment: artifact.assignment,
    resolvedAssignments: artifact.resolvedAssignments,
    models: artifact.models,
    status: artifact.status === "failed" ? "failed" : "completed",
    error: artifact.failureReason
  };
}

function matchArtifactIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), MATCH_ARTIFACT_INDEX_FILE);
}

function matchArtifactDirectory(baseDir: string): string {
  return resolveUnderDirectory(baseDir, MATCH_ARTIFACT_DIR);
}

function matchArtifactAbsoluteFile(baseDir: string, matchId: string): string {
  return resolveUnderDirectory(baseDir, matchArtifactRelativeFile(matchId));
}

function matchArtifactRelativeFile(matchId: string): string {
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(matchId)) throw new HttpError(500, "generated match artifact id is invalid");
  return `${MATCH_ARTIFACT_DIR}/${matchId}.json`;
}

function matchArtifactId(artifact: MatchArtifact): string {
  return artifact.matchId ?? artifact.runId;
}

async function persistCheckpointArtifact(checkpoint: HarnessCheckpoint, baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  assertValidHarnessCheckpoint(checkpoint);
  const root = path.resolve(baseDir);
  const file = checkpointArtifactAbsoluteFile(root, checkpoint.checkpointId);
  await ensureWritableArtifactSubdirectory(root, checkpointArtifactDirectory(root), "Checkpoint artifact directory is not safe.");
  await writeFile(file, `${JSON.stringify(redactSecrets(checkpoint), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function loadCheckpointArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await loadArtifactRecoveryAuditSidecar(root, "checkpoint");
  let parsed: unknown;
  let shouldRewriteIndex = false;
  const loadedIds = new Set<string>();
  let indexExists = true;
  try {
    parsed = JSON.parse(await readFile(checkpointArtifactIndexPath(root), "utf8"));
  } catch (error) {
    if (isFileReadNotFound(error)) {
      indexExists = false;
    } else if (error instanceof SyntaxError) {
      indexExists = false;
      await recordArtifactRecoveryAudit(root, {
        store: "checkpoint",
        source: "index",
        code: "index_invalid_json",
        relativeFile: CHECKPOINT_ARTIFACT_INDEX_FILE,
        message: "Checkpoint artifact index contained invalid JSON and will be repaired."
      });
      shouldRewriteIndex = true;
    } else {
      throw new HttpError(500, "Checkpoint artifact index could not be read.");
    }
  }

  if (indexExists) {
    if (!isRecord(parsed) || parsed.kind !== "checkpoint-artifact-index" || !Array.isArray(parsed.checkpoints)) {
      await recordArtifactRecoveryAudit(root, {
        store: "checkpoint",
        source: "index",
        code: "index_invalid_shape",
        relativeFile: CHECKPOINT_ARTIFACT_INDEX_FILE,
        message: "Checkpoint artifact index shape was invalid and will be repaired."
      });
      shouldRewriteIndex = true;
    } else {
      for (const record of parsed.checkpoints) {
        const checkpoint = await checkpointFromIndexRecord(root, record);
        if (checkpoint) {
          saveCheckpoint(checkpoint);
          loadedIds.add(checkpoint.checkpointId);
        } else {
          await recordArtifactRecoveryAudit(root, {
            store: "checkpoint",
            source: "index",
            code: "index_record_rejected",
            artifactId: isRecord(record) ? stringField(record, "checkpointId") ?? undefined : undefined,
            relativeFile: isRecord(record) ? stringField(record, "relativeFile") ?? undefined : undefined,
            message: "Checkpoint artifact index record did not resolve to a valid server-owned checkpoint."
          });
          shouldRewriteIndex = true;
        }
      }
    }
  }

  const scannedIds = await loadCheckpointArtifactsFromDirectory(root, loadedIds);
  if (scannedIds.length > 0 || shouldRewriteIndex || !indexExists) {
    await writeCheckpointArtifactIndex(root);
  }
}

async function writeCheckpointArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await mkdir(checkpointArtifactDirectory(root), { recursive: true });
  const checkpoints = [];
  for (const checkpoint of listCheckpoints()) {
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(checkpoint.checkpointId)) continue;
    const persisted = await checkpointFromFile(root, checkpoint.checkpointId, checkpointArtifactRelativeFile(checkpoint.checkpointId));
    if (!persisted) continue;
    checkpoints.push({
      checkpointId: persisted.checkpointId,
      createdAt: persisted.createdAt,
      sourceRunId: persisted.source.runId,
      sourceMatchId: persisted.source.matchId ?? null,
      seed: persisted.source.seed,
      stateHash: persisted.source.stateHash,
      trajectoryHash: persisted.source.trajectoryHash,
      agentsHash: persisted.source.agentsHash,
      socialMessagesHash: persisted.source.socialMessagesHash,
      relativeFile: checkpointArtifactRelativeFile(persisted.checkpointId)
    });
  }
  const index = {
    artifactVersion: "harness.checkpoint-artifact-index.v1",
    kind: "checkpoint-artifact-index",
    updatedAt: new Date().toISOString(),
    checkpoints
  };
  await writeFile(checkpointArtifactIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

async function checkpointFromIndexRecord(baseDir: string, value: unknown): Promise<HarnessCheckpoint | null> {
  try {
    if (!isRecord(value)) return null;
    const checkpointId = stringField(value, "checkpointId");
    const relativeFile = stringField(value, "relativeFile");
    if (!checkpointId || !relativeFile) return null;
    if (relativeFile !== checkpointArtifactRelativeFile(checkpointId)) return null;
    return checkpointFromFile(baseDir, checkpointId, relativeFile);
  } catch {
    return null;
  }
}

async function loadCheckpointArtifactsFromDirectory(baseDir: string, skipIds: Set<string>): Promise<string[]> {
  const dir = checkpointArtifactDirectory(baseDir);
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isFileReadNotFound(error)) return [];
    throw new HttpError(500, "Checkpoint artifact directory could not be read.");
  }
  const loadedIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const checkpointId = entry.name.slice(0, -".json".length);
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(checkpointId)) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "checkpoint",
        source: "directory",
        code: "file_name_rejected",
        relativeFile: `${CHECKPOINT_ARTIFACT_DIR}/${entry.name}`,
        message: "Checkpoint artifact file name was not a generated UUID JSON artifact."
      });
      continue;
    }
    if (skipIds.has(checkpointId)) continue;
    const checkpointResult = await readCheckpointFromFile(baseDir, checkpointId, checkpointArtifactRelativeFile(checkpointId));
    if (!checkpointResult.ok) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "checkpoint",
        source: "directory",
        code: checkpointResult.code,
        artifactId: checkpointId,
        relativeFile: checkpointArtifactRelativeFile(checkpointId),
        message:
          artifactRecoveryAuditMessageForCode("checkpoint", "directory", checkpointResult.code) ??
          "Checkpoint artifact file failed recovery validation."
      });
      continue;
    }
    const checkpoint = checkpointResult.artifact;
    saveCheckpoint(checkpoint);
    skipIds.add(checkpoint.checkpointId);
    loadedIds.push(checkpoint.checkpointId);
  }
  return loadedIds;
}

async function checkpointFromFile(baseDir: string, checkpointId: string, relativeFile: string): Promise<HarnessCheckpoint | null> {
  const result = await readCheckpointFromFile(baseDir, checkpointId, relativeFile);
  return result.ok ? result.artifact : null;
}

async function readCheckpointFromFile(
  baseDir: string,
  checkpointId: string,
  relativeFile: string
): Promise<ArtifactRecoveryReadResult<HarnessCheckpoint>> {
  try {
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(checkpointId)) return { ok: false, code: "file_identity_mismatch" };
    const normalized = normalizeRequestedArtifactPath(relativeFile);
    if (normalized !== checkpointArtifactRelativeFile(checkpointId)) return { ok: false, code: "file_identity_mismatch" };
    const absolutePath = resolveUnderDirectory(baseDir, normalized);
    try {
      await assertRegularFileInsideDirectory(baseDir, absolutePath, "checkpoint artifact file not found");
    } catch {
      return { ok: false, code: "file_not_regular" };
    }
    let checkpoint: unknown;
    try {
      checkpoint = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
    } catch (error) {
      return { ok: false, code: error instanceof SyntaxError ? "file_invalid_json" : "file_not_regular" };
    }
    if (!isRecord(checkpoint)) return { ok: false, code: "file_invalid_shape" };
    if (checkpoint.artifactVersion !== HARNESS_CHECKPOINT_VERSION || checkpoint.kind !== "checkpoint") {
      return { ok: false, code: "file_invalid_shape" };
    }
    if (checkpoint.checkpointId !== checkpointId) return { ok: false, code: "file_identity_mismatch" };
    const restored = checkpoint as unknown as HarnessCheckpoint;
    try {
      assertValidHarnessCheckpoint(restored);
    } catch {
      return { ok: false, code: "file_provenance_invalid" };
    }
    return { ok: true, artifact: restored };
  } catch {
    return { ok: false, code: "file_identity_mismatch" };
  }
}

function checkpointArtifactIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), CHECKPOINT_ARTIFACT_INDEX_FILE);
}

function checkpointArtifactDirectory(baseDir: string): string {
  return resolveUnderDirectory(baseDir, CHECKPOINT_ARTIFACT_DIR);
}

function checkpointArtifactAbsoluteFile(baseDir: string, checkpointId: string): string {
  return resolveUnderDirectory(baseDir, checkpointArtifactRelativeFile(checkpointId));
}

function checkpointArtifactRelativeFile(checkpointId: string): string {
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(checkpointId)) throw new HttpError(500, "generated checkpoint id is invalid");
  return `${CHECKPOINT_ARTIFACT_DIR}/${checkpointId}.json`;
}

function clearMatchArtifactFields(record: StoredMatch): void {
  delete record.metrics;
  delete record.artifact;
  delete record.initialState;
  delete record.trajectory;
  delete record.socialEpisode;
  delete record.evaluation;
  delete record.evaluationReport;
  delete record.profiles;
  delete record.assignment;
  delete record.resolvedAssignments;
}

function serializeStoredMatch(match: StoredMatch): object {
  return {
    id: match.id,
    createdAt: match.createdAt,
    state: serializePublicState(match.state),
    models: match.models,
    status: match.status,
    harnessStatus: match.artifact?.status ?? null,
    truncationReason: match.artifact?.truncationReason ?? null,
    error: match.error ? sanitizeApiErrorText(match.error) : undefined,
    hasArtifact: Boolean(match.artifact),
    checkpointCount: countCheckpointsForMatch(match.id),
    profileCount: match.profiles?.length ?? 0,
    trajectorySteps: match.trajectory?.length ?? 0
  };
}

type MatchArtifactView = "full" | "postgame-redacted";

function artifactViewFromQuery(query: unknown): MatchArtifactView {
  const record = isRecord(query) ? query : {};
  const view = optionalSingleQueryString(record, "view");
  if (view === undefined || view === "full") return "full";
  if (view === "postgame-redacted") return "postgame-redacted";
  throw new HttpError(400, `Unsupported artifact view: ${view}`);
}

function projectMatchArtifactForView(artifact: MatchArtifact, view: MatchArtifactView): unknown {
  if (view === "full") return redactSecrets(artifact);
  const exposureRecords = projectSocialExposureRecords(deriveSocialExposureRecords(artifact.socialEpisode));
  const exposureSummary = summarizeProjectedSocialExposureRecords(exposureRecords);
  const projected = cloneJson(artifact) as MatchArtifact & {
    projection?: {
      view: MatchArtifactView;
      privateEvidenceRedacted: boolean;
      postgameTruthRedacted: boolean;
      generatedAt: string;
    };
  };
  projected.projection = {
    view,
    privateEvidenceRedacted: true,
    postgameTruthRedacted: false,
    generatedAt: new Date(0).toISOString()
  };
  projected.trajectory = projected.trajectory.map(redactHarnessStepPrivateEvidence);
  projected.socialEpisode = redactSocialEpisodePrivateEvidence(projected.socialEpisode);
  projected.socialEpisode.exposureRecords = exposureRecords;
  projected.socialEpisode.exposureSummary = exposureSummary;
  projected.initialState = redactStatePrivateEvents(projected.initialState);
  projected.finalState = redactStatePrivateEvents(projected.finalState);
  projected.events = redactGameEventsPrivateEvidence(projected.events);
  projected.evaluation = {
    ...projected.evaluation,
    trajectory: projected.evaluation.trajectory.map((step) => ({
      ...step,
      intent: "[REDACTED private evaluation intent]",
      targetId: undefined
    }))
  };
  projected.agents = projected.agents.map(redactAgentPrivateEvidence);
  if (projected.agentSnapshotFrames) {
    projected.agentSnapshotFrames = projected.agentSnapshotFrames.map((frame) => ({
      ...frame,
      agents: frame.agents.map(redactAgentPrivateEvidence)
    }));
  }
  return redactSecrets(projected);
}

function projectSocialExposureRecords(records: SocialExposureRecord[]): SocialExposureRecord[] {
  return records.map((record) => ({
    messageId: record.messageId,
    messageSeq: record.messageSeq,
    sourceId: record.sourceId,
    observerId: record.observerId,
    observedAtTraceId: record.observedAtTraceId,
    observedAtTurnIndex: record.observedAtTurnIndex,
    observedAtActionKind: record.observedAtActionKind,
    channelId: record.channelId,
    visibility: record.visibility,
    kind: sanitizeSocialExposureKind(record.kind),
    evidenceRefs: record.evidenceRefs.map((ref) => ({
      artifact: ref.artifact,
      id: ref.id,
      seq: ref.seq,
      traceId: ref.traceId
    }))
  }));
}

function summarizeProjectedSocialExposureRecords(records: SocialExposureRecord[]): NonNullable<MatchArtifact["socialEpisode"]["exposureSummary"]> {
  const byVisibility: Record<SocialMessage["visibility"], number> = {
    private: 0,
    team: 0,
    public: 0,
    postgame: 0
  };
  for (const record of records) {
    byVisibility[record.visibility] += 1;
  }
  return {
    schemaVersion: "server.social-exposure-summary.v1",
    source: "scoped_observation",
    privateEvidenceRedacted: true,
    recordCount: records.length,
    messageCount: new Set(records.map((record) => record.messageId)).size,
    sourceCount: new Set(records.map((record) => record.sourceId)).size,
    observerCount: new Set(records.map((record) => record.observerId)).size,
    byVisibility
  };
}

function sanitizeSocialExposureKind(kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(kind) ? kind : undefined;
}

function redactHarnessStepPrivateEvidence(step: MatchArtifact["trajectory"][number]): MatchArtifact["trajectory"][number] {
  return {
    ...step,
    pendingAction: redactPendingAction(step.pendingAction),
    observation: {
      ...step.observation,
      privateNotes: undefined,
      legalActions: undefined
    } as typeof step.observation,
    policyPlan: {
      ...step.policyPlan,
      intent: "[REDACTED private policy intent]",
      targetId: undefined,
      pressureTargetId: undefined,
      arbitration: undefined,
      command: redactCommandPayload(step.policyPlan.command)
    },
    reasonerOutput: {
      ...step.reasonerOutput,
      content: "[REDACTED model reasoning output]"
    },
    command: redactCommandPayload(step.command),
    turnTrace: {
      ...step.turnTrace,
      intent: "[REDACTED private turn intent]",
      targetId: undefined,
      beliefs: {},
      privateMemo: "[REDACTED private memo]",
      publicSpeech: step.turnTrace.publicSpeech ? "[REDACTED generated speech]" : undefined
    } as typeof step.turnTrace,
    agentSnapshotsAfterStep: undefined
  };
}

function redactPendingAction<T extends { kind: string; actorId?: string; phase?: string }>(action: T): T {
  return {
    kind: action.kind,
    actorId: action.actorId,
    phase: action.phase,
    redacted: true
  } as unknown as T;
}

function redactCommandPayload<T extends { type: string; actorId?: string }>(command: T): T {
  return {
    type: command.type,
    actorId: command.actorId,
    redacted: true
  } as unknown as T;
}

function redactSocialEpisodePrivateEvidence(episode: MatchArtifact["socialEpisode"]): MatchArtifact["socialEpisode"] {
  return {
    ...episode,
    initialState: redactStatePrivateEvents(episode.initialState as GameState),
    finalState: redactStatePrivateEvents(episode.finalState as GameState),
    steps: episode.steps.map((step) => ({
      ...step,
      observation: "[REDACTED private social observation]",
      action: {
        ...step.action,
        command: redactCommandPayload(step.action.command as { type: string; actorId?: string }),
        messages: step.action.messages?.map(redactSocialMessagePrivateEvidence)
      }
    })),
    messages: episode.messages.map(redactSocialMessagePrivateEvidence)
  };
}

function redactSocialMessagePrivateEvidence<T extends { visibility: SocialMessage["visibility"]; content: string; deliveryReceipts?: SocialMessage["deliveryReceipts"] }>(
  message: T
): T {
  return {
    ...message,
    content: message.visibility === "public" ? message.content : "[REDACTED private social message]",
    deliveryReceipts: message.deliveryReceipts?.map((receipt) => ({
      ...receipt,
      redactionPolicy: "[REDACTED delivery redaction policy]"
    }))
  };
}

function redactStatePrivateEvents<TState>(state: TState): TState {
  if (!isRecord(state) || !Array.isArray(state.events)) return state;
  return {
    ...state,
    events: redactGameEventsPrivateEvidence(state.events as GameEvent[])
  };
}

function redactGameEventsPrivateEvidence(events: GameEvent[]): GameEvent[] {
  return events.map((event) => {
    if (event.type !== "harness.turn" && event.type !== "harness.error") return event;
    return {
      ...event,
      payload: redactHarnessEventPayload(event.payload)
    };
  });
}

function redactHarnessEventPayload(payload: unknown): Record<string, unknown> {
  const record = isRecord(payload) ? payload : {};
  return {
    traceId: stringField(record, "traceId"),
    playerId: stringField(record, "playerId"),
    actorId: stringField(record, "actorId"),
    model: stringField(record, "model"),
    actionKind: stringField(record, "actionKind"),
    policyName: stringField(record, "policyName"),
    commandType: stringField(record, "commandType"),
    confidence: numberField(record, "confidence"),
    latencyMs: numberField(record, "latencyMs"),
    promptTokens: numberField(record, "promptTokens"),
    completionTokens: numberField(record, "completionTokens"),
    agentStateHash: stringField(record, "agentStateHash"),
    providerFailure: redactSecrets(record.providerFailure ?? null),
    redacted: true
  };
}

function redactAgentPrivateEvidence(agent: MatchArtifact["agents"][number]): MatchArtifact["agents"][number] {
  const next = cloneJson(agent) as MatchArtifact["agents"][number];
  next.beliefs = {};
  next.privateMemos = next.privateMemos.map(() => "[REDACTED private memo]");
  next.lastIntent = next.lastIntent ? "[REDACTED private intent]" : undefined;
  if (next.social) next.social = redactAgentSocialStatePrivateEvidence(next.social);
  return next;
}

function redactAgentSocialStatePrivateEvidence<T extends NonNullable<MatchArtifact["agents"][number]["social"]>>(social: T): T {
  const next = cloneJson(social) as T;
  next.memory.entries = next.memory.entries.map((entry) => ({
    ...entry,
    observation: undefined,
    pendingAction: undefined,
    action: undefined,
    content: entry.content ? "[REDACTED private memory]" : undefined
  }));
  next.beliefs.claims = Object.fromEntries(
    Object.entries(next.beliefs.claims).map(([id, claim]) => [
      id,
      {
        ...claim,
        predicate: "[REDACTED private belief predicate]",
        value: "[REDACTED private belief value]",
        contradictions: []
      }
    ])
  );
  next.goals.goals = next.goals.goals.map((goal) => ({
    ...goal,
    description: "[REDACTED private goal]"
  }));
  next.lastPlan = next.lastPlan === undefined ? undefined : "[REDACTED private plan]";
  if (next.journal) {
    next.journal.entries = next.journal.entries.map((entry) => ({
      journalSeq: entry.journalSeq,
      agentId: entry.agentId,
      profileId: entry.profileId,
      traceId: entry.traceId,
      turnIndex: entry.turnIndex,
      phase: entry.phase,
      day: entry.day,
      store: entry.store,
      mutationKind: entry.mutationKind,
      subjectId: entry.subjectId,
      evidenceRefs: entry.evidenceRefs,
      messageSeqRange: entry.messageSeqRange,
      eventSeqRange: entry.eventSeqRange,
      redactionClass: entry.redactionClass,
      hiddenTruthUsed: entry.hiddenTruthUsed,
      createdAt: entry.createdAt,
      metadata: entry.metadata
    }));
  }
  return next;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function serializeArtifactRecoveryAuditRecord(record: StoredArtifactRecoveryAuditRecord): object {
  return {
    id: record.id,
    createdAt: record.createdAt,
    store: record.store,
    source: record.source,
    code: sanitizeApiErrorText(record.code),
    artifactId: record.artifactId ? normalizeAuditArtifactId(record.artifactId) : null,
    relativeFile: record.relativeFile ? normalizeAuditRelativeFile(record.store, record.source, record.relativeFile) : null,
    message: sanitizeApiErrorText(record.message)
  };
}

function artifactRecoveryAuditQueryFromRequest(query: unknown): ArtifactRecoveryAuditQuery {
  const record = isRecord(query) ? query : {};
  const storeValue = optionalSingleQueryString(record, "store");
  const sourceValue = optionalSingleQueryString(record, "source");
  const codeValue = optionalSingleQueryString(record, "code");
  const store = storeValue === undefined ? undefined : artifactRecoveryAuditStoreFromUnknown(storeValue);
  const source = sourceValue === undefined ? undefined : artifactRecoveryAuditSourceFromUnknown(sourceValue);
  if (storeValue !== undefined && !store) throw new HttpError(400, "Artifact recovery audit store filter is invalid.");
  if (sourceValue !== undefined && !source) throw new HttpError(400, "Artifact recovery audit source filter is invalid.");
  if (codeValue !== undefined && !/^[a-z][a-z0-9_]{0,80}$/.test(codeValue)) {
    throw new HttpError(400, "Artifact recovery audit code filter is invalid.");
  }
  return {
    store: store ?? undefined,
    source: source ?? undefined,
    code: codeValue,
    limit: optionalIntegerQuery(record, "limit", { min: 1, max: ARTIFACT_RECOVERY_AUDIT_MAX_LIMIT }),
    offset: optionalIntegerQuery(record, "offset", { min: 0, max: 1_000_000 }) ?? 0
  };
}

function artifactRecoveryAuditRecordMatchesQuery(record: StoredArtifactRecoveryAuditRecord, query: ArtifactRecoveryAuditQuery): boolean {
  if (query.store && record.store !== query.store) return false;
  if (query.source && record.source !== query.source) return false;
  if (query.code && record.code !== query.code) return false;
  return true;
}

function checkpointBranchTreeQueryFromRequest(query: unknown): CheckpointBranchTreeQuery {
  const record = isRecord(query) ? query : {};
  return {
    maxDepth: optionalIntegerQuery(record, "maxDepth", {
      min: 0,
      max: CHECKPOINT_BRANCH_TREE_MAX_DEPTH_LIMIT,
      label: "Checkpoint branch tree"
    }),
    maxNodes: optionalIntegerQuery(record, "maxNodes", {
      min: 1,
      max: CHECKPOINT_BRANCH_TREE_MAX_NODES_LIMIT,
      label: "Checkpoint branch tree"
    })
  };
}

function optionalSingleQueryString(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Artifact recovery audit ${key} filter is invalid.`);
  }
  return value.trim();
}

function optionalIntegerQuery(query: Record<string, unknown>, key: string, options: { min: number; max: number; label?: string }): number | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  const label = options.label ?? "Artifact recovery audit";
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new HttpError(400, `${label} ${key} parameter is invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new HttpError(400, `${label} ${key} parameter is out of range.`);
  }
  return parsed;
}

async function loadArtifactRecoveryAuditSidecar(baseDir: string, store: StoredArtifactRecoveryAuditRecord["store"]): Promise<void> {
  const root = path.resolve(baseDir);
  const file = artifactRecoveryAuditSidecarPath(root);
  const status = await artifactRecoveryAuditSidecarStatus(root, file);
  if (status === "missing") return;
  if (status === "unsafe") {
    recordArtifactRecoverySidecarDiagnostic(store, "sidecar_file_rejected", 0, "unsafe-sidecar-file");
    return;
  }
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (isFileReadNotFound(error)) return;
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "Artifact recovery audit sidecar could not be read.");
  }

  let lineNumber = 0;
  for (const line of content.split("\n")) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      recordArtifactRecoverySidecarDiagnostic(store, "sidecar_invalid_jsonl_line", lineNumber, trimmed);
      continue;
    }
    const record = artifactRecoveryAuditRecordFromUnknown(parsed);
    if (record) {
      saveArtifactRecoveryAuditRecord(record);
    } else {
      recordArtifactRecoverySidecarDiagnostic(store, "sidecar_invalid_record_shape", lineNumber, trimmed);
    }
  }
}

async function recordArtifactRecoveryAudit(
  baseDir: string,
  record: Omit<StoredArtifactRecoveryAuditRecord, "id" | "createdAt">
): Promise<void> {
  const stored = saveArtifactRecoveryAuditRecord(sanitizeArtifactRecoveryAuditRecord(record));
  if (!stored) return;
  await appendArtifactRecoveryAuditSidecar(baseDir, stored);
}

function artifactRecoveryAuditRecordFromUnknown(
  value: unknown
): (Omit<StoredArtifactRecoveryAuditRecord, "id" | "createdAt"> & { createdAt?: string }) | null {
  if (!isRecord(value)) return null;
  const store = artifactRecoveryAuditStoreFromUnknown(value.store);
  const source = artifactRecoveryAuditSourceFromUnknown(value.source);
  const code = stringField(value, "code");
  const createdAt = stringField(value, "createdAt");
  const message = store && source && code ? artifactRecoveryAuditMessageForCode(store, source, code) : null;
  const detailKey = source === "sidecar" ? safeArtifactRecoveryAuditDetailKey(stringField(value, "detailKey")) : undefined;
  if (
    value.artifactVersion !== ARTIFACT_RECOVERY_AUDIT_VERSION ||
    !store ||
    !source ||
    !code ||
    !message ||
    !createdAt ||
    !isSafeIsoTimestamp(createdAt) ||
    (source === "sidecar" && !detailKey)
  ) {
    return null;
  }
  return sanitizeArtifactRecoveryAuditRecord({
    store,
    source,
    code,
    artifactId: stringField(value, "artifactId") ?? undefined,
    relativeFile: stringField(value, "relativeFile") ?? undefined,
    detailKey,
    message,
    createdAt
  });
}

function recordArtifactRecoverySidecarDiagnostic(
  store: StoredArtifactRecoveryAuditRecord["store"],
  code: "sidecar_invalid_jsonl_line" | "sidecar_invalid_record_shape" | "sidecar_file_rejected",
  lineNumber: number,
  rawLine: string
): void {
  const message = artifactRecoveryAuditMessageForCode(store, "sidecar", code);
  if (!message) return;
  saveArtifactRecoveryAuditRecord(
    sanitizeArtifactRecoveryAuditRecord({
      store,
      source: "sidecar",
      code,
      relativeFile: ARTIFACT_RECOVERY_AUDIT_FILE,
      detailKey: sidecarDiagnosticDetailKey(lineNumber, rawLine),
      message
    })
  );
}

function sidecarDiagnosticDetailKey(lineNumber: number, rawLine: string): string {
  const digest = createHash("sha256").update(rawLine).digest("hex").slice(0, 16);
  return `line:${lineNumber}:${digest}`;
}

function sanitizeArtifactRecoveryAuditRecord(
  record: Omit<StoredArtifactRecoveryAuditRecord, "id" | "createdAt"> & { createdAt?: string }
): Omit<StoredArtifactRecoveryAuditRecord, "id" | "createdAt"> & { createdAt?: string } {
  return {
    ...record,
    code: sanitizeApiErrorText(record.code),
    artifactId: record.artifactId ? normalizeAuditArtifactId(record.artifactId) : undefined,
    relativeFile: record.relativeFile ? normalizeAuditRelativeFile(record.store, record.source, record.relativeFile) : undefined,
    detailKey: record.detailKey ? safeArtifactRecoveryAuditDetailKey(record.detailKey) : undefined,
    message: sanitizeApiErrorText(record.message)
  };
}

async function appendArtifactRecoveryAuditSidecar(baseDir: string, record: StoredArtifactRecoveryAuditRecord): Promise<void> {
  const root = path.resolve(baseDir);
  await mkdir(root, { recursive: true });
  const file = artifactRecoveryAuditSidecarPath(root);
  const status = await artifactRecoveryAuditSidecarStatus(root, file);
  if (status === "unsafe") return;
  await appendFile(
    file,
    `${JSON.stringify(
      redactSecrets({
        artifactVersion: ARTIFACT_RECOVERY_AUDIT_VERSION,
        ...record
      })
    )}\n`,
    "utf8"
  );
}

function artifactRecoveryAuditSidecarPath(baseDir: string): string {
  return resolveUnderDirectory(baseDir, ARTIFACT_RECOVERY_AUDIT_FILE);
}

async function artifactRecoveryAuditSidecarStatus(rootDir: string, absolutePath: string): Promise<"missing" | "safe" | "unsafe"> {
  try {
    const root = path.resolve(rootDir);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) return "unsafe";
    const realRoot = await realpath(root);
    const realFile = await realpath(absolutePath);
    if (!isPathStrictlyInsideDirectory(realFile, realRoot)) {
      return "unsafe";
    }
    return "safe";
  } catch (error) {
    if (isFileReadNotFound(error)) return "missing";
    return "unsafe";
  }
}

function artifactRecoveryAuditStoreFromUnknown(value: unknown): StoredArtifactRecoveryAuditRecord["store"] | null {
  return value === "match" || value === "checkpoint" || value === "tournament" ? value : null;
}

function artifactRecoveryAuditSourceFromUnknown(value: unknown): StoredArtifactRecoveryAuditRecord["source"] | null {
  return value === "index" || value === "directory" || value === "manifest" || value === "sidecar" ? value : null;
}

function artifactRecoveryAuditMessageForCode(
  store: StoredArtifactRecoveryAuditRecord["store"],
  source: StoredArtifactRecoveryAuditRecord["source"],
  code: string
): string | null {
  if (source === "sidecar") {
    if (code === "sidecar_invalid_jsonl_line") return "Artifact recovery audit sidecar contained an invalid JSONL line that was ignored.";
    if (code === "sidecar_invalid_record_shape") return "Artifact recovery audit sidecar contained an invalid record shape that was ignored.";
    if (code === "sidecar_file_rejected") return "Artifact recovery audit sidecar file was not a safe regular file and was ignored.";
    return null;
  }
  if (source === "index") {
    if (code === "index_invalid_json") {
      if (store === "match") return "Match artifact index contained invalid JSON and will be repaired.";
      if (store === "checkpoint") return "Checkpoint artifact index contained invalid JSON and will be repaired.";
      return "Tournament artifact set index contained invalid JSON and will be repaired from child manifests.";
    }
    if (code === "index_invalid_shape") {
      if (store === "match") return "Match artifact index shape was invalid and will be repaired.";
      if (store === "checkpoint") return "Checkpoint artifact index shape was invalid and will be repaired.";
      return "Tournament artifact set index shape was invalid and will be repaired from child manifests.";
    }
    if (code === "index_record_rejected") {
      if (store === "match") return "Match artifact index record did not resolve to a valid server-owned artifact.";
      if (store === "checkpoint") return "Checkpoint artifact index record did not resolve to a valid server-owned checkpoint.";
      return "Tournament artifact set index record did not resolve to a valid manifest directory.";
    }
    return null;
  }
  if (store === "match" && source === "directory") {
    if (code === "file_name_rejected") return "Match artifact file name was not a generated UUID JSON artifact.";
    if (code === "file_not_regular") return "Match artifact file was not a safe regular server-owned file.";
    if (code === "file_invalid_json") return "Match artifact file contained invalid JSON.";
    if (code === "file_invalid_shape") return "Match artifact file shape or version was invalid.";
    if (code === "file_identity_mismatch") return "Match artifact file identity did not match its generated artifact id.";
    if (code === "file_integrity_invalid") return "Match artifact file failed structural integrity validation.";
    if (code === "file_rejected") return "Match artifact file failed version, identity, filesystem, or integrity validation.";
  }
  if (store === "checkpoint" && source === "directory") {
    if (code === "file_name_rejected") return "Checkpoint artifact file name was not a generated UUID JSON artifact.";
    if (code === "file_not_regular") return "Checkpoint artifact file was not a safe regular server-owned file.";
    if (code === "file_invalid_json") return "Checkpoint artifact file contained invalid JSON.";
    if (code === "file_invalid_shape") return "Checkpoint artifact file shape or version was invalid.";
    if (code === "file_identity_mismatch") return "Checkpoint artifact file identity did not match its generated checkpoint id.";
    if (code === "file_provenance_invalid") return "Checkpoint artifact file failed provenance or structural validation.";
    if (code === "file_rejected") return "Checkpoint artifact file failed version, identity, filesystem, or provenance validation.";
  }
  if (store === "tournament" && source === "directory" && code === "directory_entry_rejected") {
    return "Tournament artifact set entry was not a generated artifact directory.";
  }
  if (store === "tournament" && source === "manifest" && code === "manifest_rejected") {
    return "Tournament artifact set manifest failed version, identity, registered-file, or filesystem validation.";
  }
  if (store === "tournament" && source === "manifest") {
    if (code === "manifest_directory_rejected") return "Tournament artifact set directory was not a safe generated directory.";
    if (code === "manifest_file_not_regular") return "Tournament artifact set manifest was not a safe regular server-owned file.";
    if (code === "manifest_invalid_json") return "Tournament artifact set manifest contained invalid JSON.";
    if (code === "manifest_invalid_shape") return "Tournament artifact set manifest shape or version was invalid.";
    if (code === "manifest_identity_mismatch") return "Tournament artifact set manifest identity did not match its generated artifact id.";
    if (code === "manifest_file_set_invalid") return "Tournament artifact set manifest registered an unexpected file set.";
  }
  return null;
}

function isSafeIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function safeArtifactRecoveryAuditDetailKey(value: string | null): string | undefined {
  return value && /^line:[0-9]+:[0-9a-f]{16}$/.test(value) ? value : undefined;
}

function normalizeAuditArtifactId(artifactId: string): string {
  return GENERATED_ARTIFACT_SET_ID_PATTERN.test(artifactId) ? artifactId : "<rejected>";
}

function normalizeAuditRelativeFile(store: StoredArtifactRecoveryAuditRecord["store"], source: StoredArtifactRecoveryAuditRecord["source"], relativeFile: string): string {
  if (!relativeFile || relativeFile.includes("\0") || relativeFile.includes("\\") || relativeFile.startsWith("/") || /^[A-Za-z]:\//.test(relativeFile)) {
    return "<rejected>";
  }
  const segments = relativeFile.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "<rejected>";
  }
  if (source === "sidecar") {
    return relativeFile === ARTIFACT_RECOVERY_AUDIT_FILE ? relativeFile : "<rejected>";
  }
  if (store === "match") {
    if (source === "index" && relativeFile === MATCH_ARTIFACT_INDEX_FILE) return relativeFile;
    if (relativeFile.startsWith(`${MATCH_ARTIFACT_DIR}/`)) {
      if (!relativeFile.endsWith(".json")) return "<rejected>";
      const matchId = relativeFile.slice(MATCH_ARTIFACT_DIR.length + 1, -".json".length);
      return GENERATED_ARTIFACT_SET_ID_PATTERN.test(matchId) ? relativeFile : "<rejected>";
    }
    return "<rejected>";
  }
  if (store === "checkpoint") {
    if (source === "index" && relativeFile === CHECKPOINT_ARTIFACT_INDEX_FILE) return relativeFile;
    if (relativeFile.startsWith(`${CHECKPOINT_ARTIFACT_DIR}/`)) {
      if (!relativeFile.endsWith(".json")) return "<rejected>";
      const checkpointId = relativeFile.slice(CHECKPOINT_ARTIFACT_DIR.length + 1, -".json".length);
      return GENERATED_ARTIFACT_SET_ID_PATTERN.test(checkpointId) ? relativeFile : "<rejected>";
    }
    return "<rejected>";
  }
  if (store === "tournament") {
    if (source === "index" && relativeFile === TOURNAMENT_ARTIFACT_SET_INDEX_FILE) return relativeFile;
    if (source === "manifest" && relativeFile === "manifest.json") return relativeFile;
    return "<rejected>";
  }
  return relativeFile;
}

interface PublicProviderFailureSummary {
  failureKind: string;
  providerStage?: string;
  status?: number;
  timeoutMs?: number;
  aborted?: boolean;
  retryable?: boolean;
  attempts?: number;
  maxAttempts?: number;
  providerRequestId?: string;
}

interface PublicApiFailure {
  message: string;
  code?: string;
  providerFailure?: PublicProviderFailureSummary;
}

function publicApiFailureFromError(error: unknown): PublicApiFailure {
  const providerFailure = providerFailureFromError(error);
  if (providerFailure) {
    const safeProviderFailure = publicProviderFailureSummary(providerFailure);
    return {
      message: providerFailureApiMessage(safeProviderFailure),
      providerFailure: safeProviderFailure
    };
  }
  return {
    message: sanitizeApiErrorText(error instanceof Error ? error.message : String(error)),
    ...(error instanceof HttpError && error.code ? { code: sanitizeApiErrorText(error.code) } : {})
  };
}

function publicProviderFailureSummary(failure: ProviderFailureSummary): PublicProviderFailureSummary {
  const summary: PublicProviderFailureSummary = {
    failureKind: sanitizeApiErrorText(failure.failureKind)
  };
  if (failure.providerStage) summary.providerStage = sanitizeApiErrorText(failure.providerStage);
  if (failure.status !== undefined) summary.status = failure.status;
  if (failure.timeoutMs !== undefined) summary.timeoutMs = failure.timeoutMs;
  if (failure.aborted !== undefined) summary.aborted = failure.aborted;
  if (failure.retryable !== undefined) summary.retryable = failure.retryable;
  if (failure.attempts !== undefined) summary.attempts = failure.attempts;
  if (failure.maxAttempts !== undefined) summary.maxAttempts = failure.maxAttempts;
  if (failure.providerRequestId) summary.providerRequestId = sanitizeApiErrorText(failure.providerRequestId);
  return summary;
}

function publicProviderFailureFromUnknown(value: unknown): PublicProviderFailureSummary | undefined {
  if (!isRecord(value) || typeof value.failureKind !== "string") return undefined;
  return publicProviderFailureSummary(value as unknown as ProviderFailureSummary);
}

function providerFailureApiMessage(failure: PublicProviderFailureSummary): string {
  const details = [
    `kind=${failure.failureKind}`,
    failure.providerStage ? `stage=${failure.providerStage}` : null,
    failure.status !== undefined ? `status=${failure.status}` : null,
    failure.timeoutMs !== undefined ? `timeoutMs=${failure.timeoutMs}` : null,
    failure.attempts !== undefined
      ? `attempts=${failure.attempts}${failure.maxAttempts !== undefined ? `/${failure.maxAttempts}` : ""}`
      : null
  ].filter(Boolean);
  return `Model provider failure (${details.join(", ")}).`;
}

function sanitizeApiErrorText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z][A-Za-z0-9]*_(?:v\d+_)?(?=[A-Za-z0-9_:-]*\d)[A-Za-z0-9_:-]{24,}\b/g, "<provider-token:redacted>")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-<redacted>")
    .replace(/\b[A-Za-z0-9][A-Za-z0-9_-]{2,}:(?:harness|social|probe):[A-Za-z0-9:_-]+/g, "<trace:redacted>");
}

function publicHarnessFailureReason(
  rawFailureReason: string | undefined,
  harnessFailures: Array<{ failureReason: string }>
): string | null {
  if (harnessFailures.length) {
    return harnessFailures.map((failure) => failure.failureReason).join(" | ");
  }
  return rawFailureReason ? sanitizeApiErrorText(rawFailureReason) : null;
}

function buildProbeSummary(options: {
  model: string;
  state: GameState;
  action: { actorId: string; kind: string };
  probe: Awaited<ReturnType<typeof probeHarnessTurn>>;
  elapsedMs: number;
  timeoutMs?: number;
}): object {
  return {
    kind: "probe",
    ok: true,
    endpoint: providerConfigSummaryFromEnv().endpoint,
    source: "diagnostic-probe",
    applied: false,
    model: options.model,
    timeoutMs: options.timeoutMs ?? null,
    elapsedMs: options.elapsedMs,
    harnessTurn: {
      traceRef: hashStableState({ traceId: options.probe.trace.traceId }).slice(0, 16),
      day: options.state.day,
      actionRecorded: Boolean(options.action.kind),
      policyRecorded: Boolean(options.probe.trace.policyName),
      commandRecorded: Boolean(options.probe.command.type),
      confidence: options.probe.trace.confidence
    },
    modelLatencyMs: options.probe.trace.latencyMs,
    promptTokens: options.probe.trace.promptTokens ?? null,
    completionTokens: options.probe.trace.completionTokens ?? null,
    stream: options.probe.trace.stream
      ? {
          enabled: options.probe.trace.stream.enabled,
          completed: options.probe.trace.stream.completed,
          completedBy: options.probe.trace.stream.completedBy ?? null
        }
      : null,
    redaction: {
      actorRedacted: true,
      targetRedacted: true,
      privateReasoningRedacted: true,
      privateStateRedacted: true,
      generatedSpeechRedacted: Boolean(options.probe.trace.publicSpeech),
      providerTelemetryRedacted: true
    },
    failureReason: null
  };
}

function buildProbePublicDiagnostic(trace: HarnessTurnTrace): object {
  return {
    schema: "probe-public-diagnostic.v1",
    evidence: {
      traceRecorded: Boolean(trace.traceId),
      policyRecorded: Boolean(trace.policyName),
      modelUsageRecorded: Boolean(trace.latencyMs || trace.promptTokens || trace.completionTokens),
      streamRecorded: Boolean(trace.stream)
    },
    redaction: {
      rawActionRedacted: true,
      rawCommandRedacted: true,
      rawTraceRedacted: true,
      actorRedacted: true,
      targetRedacted: true,
      privateReasoningRedacted: true,
      privateStateRedacted: true,
      generatedSpeechRedacted: Boolean(trace.publicSpeech),
      providerTelemetryRedacted: true
    },
    counts: {
      strategyTags: trace.strategyTags.length,
      retries: trace.retryHistory?.length ?? 0,
      attempts: trace.attempts ?? null
    }
  };
}

function serializeReplayResult(
  replay: ReturnType<typeof replayHarnessTrajectory>,
  metadata: Record<string, unknown> = {},
  options: { includeFinalState?: boolean } = {}
): object {
  const replayPayload = options.includeFinalState === false ? omitReplayFinalState(replay) : replay;
  return {
    summary: {
      kind: "replay",
      ok: replay.ok,
      ...metadata,
      replayedCommands: replay.replayedCommands,
      finalHash: replay.finalHash,
      expectedFinalHash: replay.expectedFinalHash,
      finalHashMatchesExpected: replay.expectedFinalHash ? replay.finalHash === replay.expectedFinalHash : undefined,
      mismatchCount: replay.mismatches.length,
      mismatchCodes: summarizeReplayMismatchCodes(replay.mismatches)
    },
    replay: replayPayload
  };
}

function omitReplayFinalState(replay: ReturnType<typeof replayHarnessTrajectory>): object {
  const { finalState: _finalState, mismatches, ...summary } = replay;
  return {
    ...summary,
    mismatches: mismatches.map(sanitizeReplayMismatch),
    mismatchCodes: summarizeReplayMismatchCodes(mismatches),
    redaction: {
      finalStateRedacted: true,
      mismatchDetailsRedacted: true,
      traceIdsRedacted: true,
      actorIdsRedacted: true,
      commandPayloadsRedacted: true,
      rawHashesRedacted: true
    }
  };
}

function sanitizeReplayMismatch(message: string, index: number): string {
  const detailByCode: Record<string, string> = {
    pending_unavailable: "expected pending action was not available",
    pre_state_hash: "pre-state hash did not match",
    command_kind: "recorded command did not match the pending action family",
    command_application: "recorded command could not be applied by the environment",
    event_seq_range: "event sequence range did not match",
    post_state_hash: "post-state hash did not match",
    final_hash: "final state hash did not match the expected artifact hash",
    unknown: "replay validator reported a mismatch"
  };
  return `Mismatch ${index + 1}: ${detailByCode[classifyReplayMismatch(message)]}.`;
}

function summarizeReplayMismatchCodes(mismatches: string[]): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const mismatch of mismatches) {
    const code = classifyReplayMismatch(mismatch);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

function classifyReplayMismatch(message: string): string {
  if (message.includes("pending action")) return "pending_unavailable";
  if (message.includes("preStateHash mismatch")) return "pre_state_hash";
  if (message.includes("does not match pending")) return "command_kind";
  if (message.includes("command application failed")) return "command_application";
  if (message.includes("eventSeqRange mismatch")) return "event_seq_range";
  if (message.includes("postStateHash mismatch")) return "post_state_hash";
  if (message.includes("finalHash mismatch")) return "final_hash";
  return "unknown";
}

function buildTournamentSummary(
  result: TournamentResult,
  options: {
    experimentId?: string;
    seed: string;
    models: string[];
    profiles: HarnessAgentProfile[];
    assignment?: HarnessAssignmentConfig;
    games: number;
    maxTransitions?: number;
    timeoutMs?: number;
    elapsedMs: number;
    timedOut: boolean;
  }
): object {
  const failures = result.episodes
    .filter((episode) => episode.status === "failed")
    .map((episode) => ({
      index: episode.index,
      seed: episode.seed,
      error: sanitizeApiErrorText(episode.error ?? "Tournament episode failed.")
    }));
  return {
    kind: "tournament",
    ok: result.gamesFailed === 0,
    endpoint: providerConfigSummaryFromEnv().endpoint,
    experimentId: options.experimentId ?? null,
    seed: options.seed,
    models: options.models,
    profileCount: options.profiles.length,
    modelCount: options.models.length,
    assignment: summarizePublicAssignmentConfig(options.assignment),
    gamesRequested: options.games,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    limits: {
      maxTransitions: options.maxTransitions ?? null,
      timeoutMs: options.timeoutMs ?? null
    },
    elapsedMs: options.elapsedMs,
    timedOut: options.timedOut,
    evaluation: summarizeTournamentEvaluation(result.episodes),
    evaluationReports: summarizeTournamentEvaluationReports(result.episodes),
    failures,
    failureReason: failures.length ? failures.map((failure) => `${failure.seed}: ${failure.error}`).join(" | ") : null
  };
}

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
  let written: TournamentArtifactWriteResult;
  try {
    written = await writeTournamentArtifactDirectory(options.result, {
      outputDir,
      experimentId: options.experimentId,
      createdAt,
      overwrite: false
    });
  } catch {
    throw new HttpError(500, "Tournament artifact export failed.");
  }
  const set: StoredTournamentArtifactSet = {
    id,
    createdAt,
    experimentId: options.experimentId,
    seed: options.seed,
    outputDir: written.outputDir,
    files: written.files,
    relativeFiles: relativeTournamentArtifactFiles(written)
  };
  await loadTournamentArtifactSetIndex(baseDir);
  saveTournamentArtifactSet(set);
  await writeTournamentArtifactSetIndex(baseDir);
  return set;
}

async function loadTournamentArtifactSetIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await loadArtifactRecoveryAuditSidecar(root, "tournament");
  let parsed: unknown;
  let shouldRewriteIndex = false;
  const loadedIds = new Set<string>();
  try {
    const content = await readFile(tournamentArtifactSetIndexPath(root), "utf8");
    parsed = JSON.parse(content);
  } catch (error) {
    if (isFileReadNotFound(error)) {
      const scannedIds = await loadTournamentArtifactSetsFromManifests(root, loadedIds);
      if (scannedIds.length > 0) await writeTournamentArtifactSetIndex(root);
      return;
    }
    if (error instanceof SyntaxError) {
      await recordArtifactRecoveryAudit(root, {
        store: "tournament",
        source: "index",
        code: "index_invalid_json",
        relativeFile: TOURNAMENT_ARTIFACT_SET_INDEX_FILE,
        message: "Tournament artifact set index contained invalid JSON and will be repaired from child manifests."
      });
      shouldRewriteIndex = true;
    } else {
      throw new HttpError(500, "Tournament artifact set index could not be read.");
    }
  }
  if (parsed !== undefined && (!isRecord(parsed) || parsed.kind !== "tournament-artifact-set-index" || !Array.isArray(parsed.artifactSets))) {
    await recordArtifactRecoveryAudit(root, {
      store: "tournament",
      source: "index",
      code: "index_invalid_shape",
      relativeFile: TOURNAMENT_ARTIFACT_SET_INDEX_FILE,
      message: "Tournament artifact set index shape was invalid and will be repaired from child manifests."
    });
    shouldRewriteIndex = true;
  } else if (isRecord(parsed) && Array.isArray(parsed.artifactSets)) {
    for (const record of parsed.artifactSets) {
      const set = await storedTournamentArtifactSetFromIndexRecord(root, record);
      if (set) {
        saveTournamentArtifactSet(set);
        loadedIds.add(set.id);
      } else {
        await recordArtifactRecoveryAudit(root, {
          store: "tournament",
          source: "index",
          code: "index_record_rejected",
          artifactId: isRecord(record) ? stringField(record, "id") ?? undefined : undefined,
          message: "Tournament artifact set index record did not resolve to a valid manifest directory."
        });
        shouldRewriteIndex = true;
      }
    }
  }
  const scannedIds = await loadTournamentArtifactSetsFromManifests(root, loadedIds);
  if (scannedIds.length > 0 || shouldRewriteIndex) {
    await writeTournamentArtifactSetIndex(root);
  }
}

async function writeTournamentArtifactSetIndex(baseDir: string): Promise<void> {
  const root = path.resolve(baseDir);
  await mkdir(root, { recursive: true });
  const artifactSets = listTournamentArtifactSetsForBaseDir(root).map((set) => ({
    id: set.id,
    createdAt: set.createdAt,
    experimentId: set.experimentId,
    seed: set.seed,
    relativeFiles: set.relativeFiles
  }));
  const index = {
    artifactVersion: "harness.tournament-artifact-set-index.v1",
    kind: "tournament-artifact-set-index",
    updatedAt: new Date().toISOString(),
    artifactSets
  };
  await writeFile(tournamentArtifactSetIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

function tournamentArtifactSetIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), TOURNAMENT_ARTIFACT_SET_INDEX_FILE);
}

async function storedTournamentArtifactSetFromIndexRecord(baseDir: string, value: unknown): Promise<StoredTournamentArtifactSet | null> {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const relativeFiles = tournamentArtifactFilesFromUnknown(value.relativeFiles);
  if (!id || !relativeFiles) return null;
  try {
    const set = await storedTournamentArtifactSetFromManifestDirectory(baseDir, id);
    if (!set) return null;
    return equalTournamentArtifactFiles(set.relativeFiles, relativeFiles) ? set : null;
  } catch {
    return null;
  }
}

async function loadTournamentArtifactSetsFromManifests(baseDir: string, skipIds: Set<string>): Promise<string[]> {
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(path.resolve(baseDir), { withFileTypes: true });
  } catch (error) {
    if (isFileReadNotFound(error)) return [];
    throw new HttpError(500, "Tournament artifact set directory could not be read.");
  }
  const loadedIds: string[] = [];
  for (const entry of entries) {
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(entry.name)) continue;
    if (!entry.isDirectory()) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "tournament",
        source: "directory",
        code: "directory_entry_rejected",
        artifactId: entry.name,
        message: "Tournament artifact set entry was not a generated artifact directory."
      });
      continue;
    }
    if (skipIds.has(entry.name)) continue;
    const setResult = await readTournamentArtifactSetFromManifestDirectory(baseDir, entry.name);
    if (!setResult.ok) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "tournament",
        source: "manifest",
        code: setResult.code,
        artifactId: entry.name,
        relativeFile: "manifest.json",
        message:
          artifactRecoveryAuditMessageForCode("tournament", "manifest", setResult.code) ??
          "Tournament artifact set manifest failed recovery validation."
      });
      continue;
    }
    const set = setResult.artifact;
    saveTournamentArtifactSet(set);
    skipIds.add(set.id);
    loadedIds.push(set.id);
  }
  return loadedIds;
}

async function storedTournamentArtifactSetFromManifestDirectory(baseDir: string, id: string): Promise<StoredTournamentArtifactSet | null> {
  const result = await readTournamentArtifactSetFromManifestDirectory(baseDir, id);
  return result.ok ? result.artifact : null;
}

async function readTournamentArtifactSetFromManifestDirectory(
  baseDir: string,
  id: string
): Promise<ArtifactRecoveryReadResult<StoredTournamentArtifactSet>> {
  try {
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(id)) return { ok: false, code: "manifest_identity_mismatch" };
    const root = path.resolve(baseDir);
    const outputDir = resolveGeneratedArtifactDirectory(root, id);
    try {
      await assertExistingArtifactSetDirectoryInsideBase(root, outputDir);
    } catch {
      return { ok: false, code: "manifest_directory_rejected" };
    }
    const manifestPath = resolveUnderDirectory(outputDir, "manifest.json");
    try {
      await assertRegularFileInsideArtifactSet({ baseDir: root, outputDir, absolutePath: manifestPath });
    } catch {
      return { ok: false, code: "manifest_file_not_regular" };
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    } catch (error) {
      return { ok: false, code: error instanceof SyntaxError ? "manifest_invalid_json" : "manifest_file_not_regular" };
    }
    if (!isRecord(manifest)) return { ok: false, code: "manifest_invalid_shape" };
    if (manifest.artifactVersion !== TOURNAMENT_ARTIFACT_VERSION || manifest.kind !== "tournament") {
      return { ok: false, code: "manifest_invalid_shape" };
    }
    const createdAt = stringField(manifest, "createdAt");
    const experimentId = stringField(manifest, "experimentId");
    const seed = stringField(manifest, "seed");
    const relativeFiles = tournamentArtifactFileShapeFromUnknown(manifest.files);
    if (!createdAt || !experimentId || !seed || !relativeFiles) return { ok: false, code: "manifest_invalid_shape" };
    if (!isExpectedTournamentArtifactFileSet(relativeFiles)) return { ok: false, code: "manifest_file_set_invalid" };
    return {
      ok: true,
      artifact: {
        id,
        createdAt,
        experimentId,
        seed,
        outputDir,
        files: absoluteTournamentArtifactFiles(outputDir, relativeFiles),
        relativeFiles
      }
    };
  } catch {
    return { ok: false, code: "manifest_identity_mismatch" };
  }
}

function tournamentArtifactFilesFromUnknown(value: unknown): StoredTournamentArtifactFiles | null {
  const files = tournamentArtifactFileShapeFromUnknown(value);
  return files && isExpectedTournamentArtifactFileSet(files) ? files : null;
}

function tournamentArtifactFileShapeFromUnknown(value: unknown): StoredTournamentArtifactFiles | null {
  if (!isRecord(value)) return null;
  const manifest = stringField(value, "manifest");
  const registry = stringField(value, "registry");
  const specNormalized = stringField(value, "specNormalized");
  const assignment = stringField(value, "assignment");
  const episodes = stringField(value, "episodes");
  const trajectory = stringField(value, "trajectory");
  const metrics = stringField(value, "metrics");
  const integrity = stringField(value, "integrity");
  const failures = stringField(value, "failures");
  const costLatency = stringField(value, "costLatency");
  const leaderboard = stringField(value, "leaderboard");
  const benchmarkStatistics = stringField(value, "benchmarkStatistics");
  const matches = stringArrayField(value, "matches");
  const matchesJsonl = stringArrayField(value, "matchesJsonl");
  if (
    !manifest ||
    !registry ||
    !specNormalized ||
    !assignment ||
    !episodes ||
    !trajectory ||
    !metrics ||
    !integrity ||
    !failures ||
    !costLatency ||
    !leaderboard ||
    !benchmarkStatistics ||
    !matches ||
    !matchesJsonl
  ) {
    return null;
  }
  const files = {
    manifest,
    registry,
    specNormalized,
    assignment,
    episodes,
    trajectory,
    metrics,
    integrity,
    failures,
    costLatency,
    leaderboard,
    benchmarkStatistics,
    matches,
    matchesJsonl
  };
  return files;
}

function isExpectedTournamentArtifactFileSet(files: StoredTournamentArtifactFiles): boolean {
  return (
    files.manifest === "manifest.json" &&
    files.registry === "registry.json" &&
    files.specNormalized === "spec.normalized.json" &&
    files.assignment === "assignment.json" &&
    files.episodes === "episodes.jsonl" &&
    files.trajectory === "trajectory.jsonl" &&
    files.metrics === "metrics.jsonl" &&
    files.integrity === "integrity.jsonl" &&
    files.failures === "failures.jsonl" &&
    files.costLatency === "cost_latency.json" &&
    files.leaderboard === "leaderboard.json" &&
    files.benchmarkStatistics === "benchmark_statistics.json" &&
    files.matches.every((file) => isWriterTournamentMatchArtifactFile(file, ".json")) &&
    files.matchesJsonl.every((file) => isWriterTournamentMatchArtifactFile(file, ".jsonl"))
  );
}

function isWriterTournamentMatchArtifactFile(file: string, extension: ".json" | ".jsonl"): boolean {
  if (!file.startsWith("matches/") || !file.endsWith(extension)) return false;
  const matchStem = file.slice("matches/".length, -extension.length);
  return /^tournament-[A-Za-z0-9_.-]+-[1-9][0-9]*$/.test(matchStem);
}

function absoluteTournamentArtifactFiles(outputDir: string, files: StoredTournamentArtifactFiles): TournamentArtifactWriteResult["files"] {
  const resolve = (relativePath: string) => resolveUnderDirectory(outputDir, normalizeRequestedArtifactPath(relativePath));
  return {
    manifest: resolve(files.manifest),
    registry: resolve(files.registry),
    specNormalized: resolve(files.specNormalized),
    assignment: resolve(files.assignment),
    episodes: resolve(files.episodes),
    trajectory: resolve(files.trajectory),
    metrics: resolve(files.metrics),
    integrity: resolve(files.integrity),
    failures: resolve(files.failures),
    costLatency: resolve(files.costLatency),
    leaderboard: resolve(files.leaderboard),
    benchmarkStatistics: resolve(files.benchmarkStatistics),
    matchesDir: resolveUnderDirectory(outputDir, "matches"),
    matches: files.matches.map(resolve),
    matchesJsonl: files.matchesJsonl.map(resolve)
  };
}

function equalTournamentArtifactFiles(left: StoredTournamentArtifactFiles, right: StoredTournamentArtifactFiles): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function listTournamentArtifactSetsForBaseDir(baseDir: string | undefined): StoredTournamentArtifactSet[] {
  if (!baseDir) return listTournamentArtifactSets();
  return listTournamentArtifactSets().filter((set) => isTournamentArtifactSetInsideBaseDir(set, baseDir));
}

function getTournamentArtifactSetForBaseDir(id: string, baseDir: string | undefined): StoredTournamentArtifactSet | undefined {
  const set = getTournamentArtifactSet(id);
  if (!set) return undefined;
  if (baseDir && !isTournamentArtifactSetInsideBaseDir(set, baseDir)) return undefined;
  return set;
}

function isTournamentArtifactSetInsideBaseDir(set: StoredTournamentArtifactSet, baseDir: string): boolean {
  const root = path.resolve(baseDir);
  const outputDir = path.resolve(set.outputDir);
  return outputDir !== root && outputDir.startsWith(root + path.sep);
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayField(source: Record<string, unknown>, key: string): string[] | null {
  const value = source[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) return null;
  return [...value] as string[];
}

function serializeTournamentArtifactSet(set: StoredTournamentArtifactSet): object {
  return {
    artifactSetId: set.id,
    id: set.id,
    createdAt: set.createdAt,
    experimentId: set.experimentId,
    seed: set.seed,
    files: set.relativeFiles,
    downloads: tournamentArtifactDownloads(set)
  };
}

function tournamentArtifactDownloads(set: StoredTournamentArtifactSet): StoredTournamentArtifactFiles {
  return mapTournamentArtifactFiles(set.relativeFiles, (relativePath) => tournamentArtifactDownloadUrl(set.id, relativePath));
}

function tournamentArtifactDownloadUrl(artifactSetId: string, relativePath: string): string {
  return `/api/tournament-artifacts/${encodeURIComponent(artifactSetId)}/files/${relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function relativeTournamentArtifactFiles(written: TournamentArtifactWriteResult): StoredTournamentArtifactFiles {
  return {
    manifest: relativeArtifactPath(written.outputDir, written.files.manifest),
    registry: relativeArtifactPath(written.outputDir, written.files.registry),
    specNormalized: relativeArtifactPath(written.outputDir, written.files.specNormalized),
    assignment: relativeArtifactPath(written.outputDir, written.files.assignment),
    episodes: relativeArtifactPath(written.outputDir, written.files.episodes),
    trajectory: relativeArtifactPath(written.outputDir, written.files.trajectory),
    metrics: relativeArtifactPath(written.outputDir, written.files.metrics),
    integrity: relativeArtifactPath(written.outputDir, written.files.integrity),
    failures: relativeArtifactPath(written.outputDir, written.files.failures),
    costLatency: relativeArtifactPath(written.outputDir, written.files.costLatency),
    leaderboard: relativeArtifactPath(written.outputDir, written.files.leaderboard),
    benchmarkStatistics: relativeArtifactPath(written.outputDir, written.files.benchmarkStatistics),
    matches: written.files.matches.map((file) => relativeArtifactPath(written.outputDir, file)),
    matchesJsonl: written.files.matchesJsonl.map((file) => relativeArtifactPath(written.outputDir, file))
  };
}

function relativeArtifactPath(rootDir: string, absolutePath: string): string {
  const relativePath = path.relative(path.resolve(rootDir), path.resolve(absolutePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new HttpError(500, "Tournament artifact writer returned a file outside the artifact directory.");
  }
  return relativePath.split(path.sep).join("/");
}

function mapTournamentArtifactFiles(
  files: StoredTournamentArtifactFiles,
  mapFile: (relativePath: string) => string
): StoredTournamentArtifactFiles {
  return {
    manifest: mapFile(files.manifest),
    registry: mapFile(files.registry),
    specNormalized: mapFile(files.specNormalized),
    assignment: mapFile(files.assignment),
    episodes: mapFile(files.episodes),
    trajectory: mapFile(files.trajectory),
    metrics: mapFile(files.metrics),
    integrity: mapFile(files.integrity),
    failures: mapFile(files.failures),
    costLatency: mapFile(files.costLatency),
    leaderboard: mapFile(files.leaderboard),
    benchmarkStatistics: mapFile(files.benchmarkStatistics),
    matches: files.matches.map(mapFile),
    matchesJsonl: files.matchesJsonl.map(mapFile)
  };
}

async function resolveRegisteredTournamentArtifactFile(
  set: StoredTournamentArtifactSet,
  requestedPath: string | undefined,
  baseDir: string | undefined
): Promise<{ relativePath: string; absolutePath: string }> {
  const relativePath = normalizeRequestedArtifactPath(requestedPath);
  const registered = registeredTournamentArtifactFiles(set);
  if (!registered.has(relativePath)) {
    throw new HttpError(404, "tournament artifact file not found");
  }
  const absolutePath = resolveUnderDirectory(set.outputDir, relativePath);
  await assertRegularFileInsideArtifactSet({ baseDir, outputDir: set.outputDir, absolutePath });
  return { relativePath, absolutePath };
}

function registeredTournamentArtifactFiles(set: StoredTournamentArtifactSet): Set<string> {
  return new Set(flattenTournamentArtifactFiles(set.relativeFiles));
}

function flattenTournamentArtifactFiles(files: StoredTournamentArtifactFiles): string[] {
  return [
    files.manifest,
    files.registry,
    files.specNormalized,
    files.assignment,
    files.episodes,
    files.trajectory,
    files.metrics,
    files.integrity,
    files.failures,
    files.costLatency,
    files.leaderboard,
    files.benchmarkStatistics,
    ...files.matches,
    ...files.matchesJsonl
  ];
}

function normalizeRequestedArtifactPath(requestedPath: string | undefined): string {
  if (!requestedPath) throw new HttpError(400, "artifact file path is required");
  let decoded = requestedPath;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    throw new HttpError(400, "artifact file path is not valid URL encoding");
  }
  if (!decoded || decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("/") || /^[A-Za-z]:\//.test(decoded)) {
    throw new HttpError(400, "artifact file path must be relative");
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new HttpError(400, "artifact file path must not contain traversal");
  }
  const normalized = path.posix.normalize(decoded);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    throw new HttpError(400, "artifact file path must stay inside the artifact set");
  }
  return normalized;
}

function resolveUnderDirectory(rootDir: string, relativePath: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath.split("/").join(path.sep));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HttpError(400, "artifact file path must stay inside the artifact set");
  }
  return resolved;
}

function resolveGeneratedArtifactDirectory(baseDir: string, artifactSetId: string): string {
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(artifactSetId)) throw new HttpError(500, "generated artifact set id is invalid");
  return resolveUnderDirectory(baseDir, artifactSetId);
}

async function ensureWritableArtifactSubdirectory(rootDir: string, subdirectory: string, message: string): Promise<void> {
  try {
    const root = path.resolve(rootDir);
    await mkdir(subdirectory, { recursive: true });
    const info = await lstat(subdirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(500, message);
    const realRoot = await realpath(root);
    const realSubdirectory = await realpath(subdirectory);
    if (!isPathStrictlyInsideDirectory(realSubdirectory, realRoot)) {
      throw new HttpError(500, message);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, message);
  }
}

async function assertRegularFileInsideDirectory(rootDir: string, absolutePath: string, message: string): Promise<void> {
  try {
    const root = path.resolve(rootDir);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(404, message);
    const realRoot = await realpath(root);
    const realFile = await realpath(absolutePath);
    if (!isPathStrictlyInsideDirectory(realFile, realRoot)) {
      throw new HttpError(404, message);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, message);
  }
}

async function assertExistingArtifactSetDirectoryInsideBase(baseDir: string | undefined, outputDir: string): Promise<void> {
  try {
    const info = await lstat(outputDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(404, "tournament artifact set not found");
    const realOutputDir = await realpath(outputDir);
    if (baseDir) {
      const realBaseDir = await realpath(path.resolve(baseDir));
      if (!isPathStrictlyInsideDirectory(realOutputDir, realBaseDir)) {
        throw new HttpError(404, "tournament artifact set not found");
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "tournament artifact set not found");
  }
}

async function assertRegularFileInsideArtifactSet(options: {
  baseDir: string | undefined;
  outputDir: string;
  absolutePath: string;
}): Promise<void> {
  try {
    await assertExistingArtifactSetDirectoryInsideBase(options.baseDir, options.outputDir);
    const info = await lstat(options.absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(404, "tournament artifact file not found");
    const realOutputDir = await realpath(options.outputDir);
    const realFile = await realpath(options.absolutePath);
    if (!isPathStrictlyInsideDirectory(realFile, realOutputDir)) {
      throw new HttpError(404, "tournament artifact file not found");
    }
    if (options.baseDir) {
      const realBaseDir = await realpath(path.resolve(options.baseDir));
      if (!isPathStrictlyInsideDirectory(realFile, realBaseDir)) {
        throw new HttpError(404, "tournament artifact file not found");
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "tournament artifact file not found");
  }
}

function isPathStrictlyInsideDirectory(candidate: string, directory: string): boolean {
  const relativePath = path.relative(path.resolve(directory), path.resolve(candidate));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function contentTypeForArtifactFile(relativePath: string): string {
  if (relativePath.endsWith(".jsonl")) return "application/x-ndjson";
  if (relativePath.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function isFileReadNotFound(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR");
}

function serializeTournamentEpisodeSummaryForApi(episode: TournamentEpisode): object {
  return {
    index: episode.index,
    seed: episode.seed,
    runId: episode.runId,
    matchId: episode.matchId,
    status: episode.status,
    harnessStatus: episode.harnessStatus,
    winner: episode.winner ?? null,
    phase: episode.phase ?? null,
    day: episode.day ?? null,
    forkOf: episode.forkOf ? summarizeForkProvenance(episode.forkOf) : null,
    metricSummary: episode.metrics
      ? {
          harnessTurnCount: episode.metrics.harnessTurnCount,
          harnessErrorCount: episode.metrics.harnessErrorCount,
          totalSpeeches: episode.metrics.totalSpeeches,
          totalVotes: episode.metrics.totalVotes,
          totalDeaths: episode.metrics.totalDeaths,
          averageLatencyMs: episode.metrics.averageLatencyMs
        }
      : null,
    evaluationSummary: episode.evaluation
      ? {
          winner: episode.evaluation.winner ?? null,
          trajectorySteps: episode.evaluation.trajectory.length,
          agentRewardCount: episode.evaluation.agentRewards.length
        }
      : null,
    evaluationReportSummary: episode.evaluationReport
      ? {
          id: episode.evaluationReport.id,
          evaluatorIds: episode.evaluationReport.evaluatorIds,
          metricCount: episode.evaluationReport.metricCount,
          ...summarizeEvaluationWarnings(episode.evaluationReport.warnings)
        }
      : null,
    agentCount: episode.agents.length,
    agents: episode.agents.map((agent) => ({
      playerId: agent.playerId,
      seat: agent.seat
    })),
    error: episode.error ? sanitizeApiErrorText(episode.error) : undefined,
    hasArtifact: Boolean(episode.artifact)
  };
}

function summarizeForkProvenance(forkOf: HarnessForkProvenance): object {
  return {
    checkpointId: forkOf.checkpointId,
    parentRunId: forkOf.parentRunId,
    parentMatchId: forkOf.parentMatchId,
    parentTraceRef: forkOf.parentTraceId ? hashStableState({ traceId: forkOf.parentTraceId }).slice(0, 16) : null,
    parentTurnIndex: forkOf.parentTurnIndex,
    parentStateHash: forkOf.parentStateHash,
    parentTrajectoryHash: forkOf.parentTrajectoryHash ?? null,
    parentAgentsHash: forkOf.parentAgentsHash ?? null,
    parentSocialMessagesHash: forkOf.parentSocialMessagesHash ?? null,
    parentTrajectoryLength: forkOf.parentTrajectoryLength,
    createdAt: forkOf.createdAt,
    reason: forkOf.reason
  };
}

type TournamentEpisodes = Awaited<ReturnType<typeof runTournament>>["episodes"];
type TournamentEpisode = TournamentEpisodes[number];

function summarizeTournamentEvaluation(episodes: TournamentEpisodes): object {
  const completed = episodes.filter((episode) => episode.status === "completed");
  const evaluated = completed.flatMap((episode) => {
    const evaluation = getEpisodeEvaluation(episode);
    return evaluation ? [{ episode, evaluation }] : [];
  });
  const evaluations = evaluated.map((item) => item.evaluation);

  return {
    gamesEvaluated: evaluations.length,
    gamesWithoutEvaluation: completed.length - evaluations.length,
    teamRewards: averageTeamRewards(evaluations),
    modelRewards: summarizeModelRewards(evaluations),
    episodes: evaluated.map(({ episode, evaluation }) => ({
      index: episode.index,
      seed: episode.seed,
      winner: evaluation.winner ?? episode.winner ?? null,
      teamRewards: evaluation.teamRewards,
      agentRewardCount: evaluation.agentRewards.length,
      trajectorySteps: evaluation.trajectory.length
    }))
  };
}

function getEpisodeEvaluation(episode: TournamentEpisode): AdversarialEvaluation | undefined {
  const evaluation = (episode as TournamentEpisode & { evaluation?: unknown }).evaluation;
  return isAdversarialEvaluation(evaluation) ? evaluation : undefined;
}

function isAdversarialEvaluation(value: unknown): value is AdversarialEvaluation {
  return (
    isRecord(value) &&
    isRecord(value.teamRewards) &&
    Array.isArray(value.agentRewards) &&
    Array.isArray(value.trajectory) &&
    isRecord(value.voteAccuracyByAgent) &&
    isRecord(value.influenceByAgent) &&
    isRecord(value.deceptionByAgent)
  );
}

function summarizeEvaluation(evaluation: AdversarialEvaluation | undefined): object | null {
  if (!evaluation) return null;
  return {
    winner: evaluation.winner ?? null,
    teamRewards: evaluation.teamRewards,
    trajectorySteps: evaluation.trajectory.length,
    agentRewardCount: evaluation.agentRewards.length,
    voteAccuracyAgentCount: Object.keys(evaluation.voteAccuracyByAgent).length,
    influenceAgentCount: Object.keys(evaluation.influenceByAgent).length,
    deceptionAgentCount: Object.keys(evaluation.deceptionByAgent).length
  };
}

function summarizeEvaluationReport(report: import("../harness/types").HarnessEvaluationReport | undefined): object | null {
  if (!report) return null;
  return {
    id: report.id,
    evaluatorIds: report.evaluatorIds,
    metricCount: report.metricCount,
    ...summarizeEvaluationWarnings(report.warnings)
  };
}

function summarizeTournamentEvaluationReports(episodes: TournamentEpisodes): object {
  const reports = episodes.flatMap((episode) => (episode.evaluationReport ? [episode.evaluationReport] : []));
  const warningSummary = summarizeEvaluationWarnings(reports.flatMap((report) => report.warnings ?? []));
  return {
    reports: reports.length,
    metricCount: reports.reduce((sum, report) => sum + report.metricCount, 0),
    ...warningSummary,
    reportsWithWarnings: reports.filter((report) => (report.warnings?.length ?? 0) > 0).length,
    evaluatorIds: Array.from(new Set(reports.flatMap((report) => report.evaluatorIds))),
    episodeScores: reports.map((report) => report.summary.episodeScore ?? null)
  };
}

function averageTeamRewards(evaluations: AdversarialEvaluation[]): AdversarialEvaluation["teamRewards"] | null {
  if (!evaluations.length) return null;
  return {
    village: round3(evaluations.reduce((sum, evaluation) => sum + evaluation.teamRewards.village, 0) / evaluations.length),
    werewolves: round3(evaluations.reduce((sum, evaluation) => sum + evaluation.teamRewards.werewolves, 0) / evaluations.length)
  };
}

function summarizeModelRewards(evaluations: AdversarialEvaluation[]): Record<string, object> {
  const byModel = new Map<string, { games: number; wins: number; reward: number }>();
  for (const evaluation of evaluations) {
    for (const agentReward of evaluation.agentRewards) {
      const stats = byModel.get(agentReward.model) ?? { games: 0, wins: 0, reward: 0 };
      stats.games += 1;
      if (agentReward.won) stats.wins += 1;
      stats.reward += agentReward.reward;
      byModel.set(agentReward.model, stats);
    }
  }
  return Object.fromEntries(
    [...byModel.entries()].map(([model, stats]) => [
      model,
      {
        agentGames: stats.games,
        wins: stats.wins,
        winRate: stats.games ? round3(stats.wins / stats.games) : 0,
        averageReward: stats.games ? round3(stats.reward / stats.games) : 0
      }
    ])
  );
}

function summarizePublicAssignmentConfig(assignment: HarnessAssignmentConfig | undefined): object | null {
  if (!assignment) return null;
  return {
    strategy: assignment.strategy ?? null,
    fallback: assignment.fallback ?? null,
    seatAssignmentCount: assignment.seats ? Object.keys(assignment.seats).length : 0,
    roleAssignmentCount: assignment.roles ? Object.keys(assignment.roles).length : 0,
    teamAssignmentCount: assignment.teams ? Object.keys(assignment.teams).length : 0
  };
}

function summarizePublicAssignment(assignment: ResolvedAgentAssignment): object {
  return {
    playerId: assignment.playerId,
    seat: assignment.seat
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarizeModelUsage(metrics: MatchMetrics): Record<string, object> {
  return Object.fromEntries(
    Object.entries(metrics.modelUsage).map(([model, usage]) => [
      model,
      {
        calls: usage.calls,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalLatencyMs: usage.latencyMs,
        averageLatencyMs: usage.calls ? Math.round(usage.latencyMs / usage.calls) : 0
      }
    ])
  );
}

function summarizeHarnessTurn(event: GameEvent): {
  seq: number;
  harnessTurn: string;
  day: number;
  phase: string;
  actorId: string | null;
  model: string | null;
  actionKind: string | null;
  policy: string | null;
  command: string | null;
  intent: string | null;
  targetId: string | null;
  confidence: number | null;
  modelLatencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  providerRequestId: string | null;
} {
  const trace = event.payload as Partial<HarnessTurnTrace>;
  return {
    seq: event.seq,
    harnessTurn: trace.traceId ?? String(event.seq),
    day: event.day,
    phase: event.phase,
    actorId: trace.playerId ?? event.actorId ?? null,
    model: trace.model ?? null,
    actionKind: trace.actionKind ?? null,
    policy: trace.policyName ?? null,
    command: trace.commandType ?? null,
    intent: trace.intent ?? null,
    targetId: trace.targetId ?? null,
    confidence: trace.confidence ?? null,
    modelLatencyMs: trace.latencyMs ?? null,
    promptTokens: trace.promptTokens ?? null,
    completionTokens: trace.completionTokens ?? null,
    providerRequestId: trace.providerRequestId ?? null
  };
}

function summarizeHarnessFailure(event: GameEvent): {
  seq: number;
  day: number;
  phase: string;
  actorId: string | null;
  model: string | null;
  actionKind: string | null;
  failureReason: string;
  providerFailure?: PublicProviderFailureSummary;
} {
  const payload = isRecord(event.payload) ? event.payload : {};
  const providerFailure = publicProviderFailureFromUnknown(payload.providerFailure);
  const rawMessage = typeof payload.message === "string" ? payload.message : JSON.stringify(event.payload);
  return {
    seq: event.seq,
    day: event.day,
    phase: event.phase,
    actorId: event.actorId ?? null,
    model: typeof payload.model === "string" ? payload.model : null,
    actionKind: typeof payload.actionKind === "string" ? payload.actionKind : null,
    failureReason: providerFailure ? providerFailureApiMessage(providerFailure) : sanitizeApiErrorText(rawMessage),
    ...(providerFailure ? { providerFailure } : {})
  };
}

function parseOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseTemperature(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) throw new Error("temperature must be between 0 and 2.");
  return parsed;
}

function modelsFromProfiles(profiles: HarnessAgentProfile[]): string[] {
  return Array.from(new Set(profiles.map((profile) => profile.model.trim()).filter(Boolean)));
}

function parseOptionalDurationMs(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer number of milliseconds.`);
    return value;
  }
  const match = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) throw new Error(`${name} must be a duration like 60000, 60s, or 5m.`);
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "ms";
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  const ms = amount * multiplier;
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`${name} must resolve to a positive integer number of milliseconds.`);
  return ms;
}

function normalizeTournamentExperimentRequest(body: unknown): NormalizedTournamentExperiment {
  const record = isRecord(body) ? body : {};
  const spec = record.spec ?? record;
  const overrides: Partial<TournamentExperimentSpecV1> = record.spec
    ? (removeUndefined({
        models: record.models,
        profiles: record.profiles,
        assignment: record.assignment as TournamentExperimentSpecV1["assignment"],
        seed: typeof record.seed === "string" ? record.seed : undefined,
        games: record.games,
        maxTransitions: record.maxTransitions ?? record.steps,
        timeout: record.timeoutMs ?? record.timeout,
        temperature: record.temperature,
        json: record.json as TournamentExperimentSpecV1["json"],
        continueOnError: record.continueOnError,
        config: record.config as TournamentExperimentSpecV1["config"]
      }) as Partial<TournamentExperimentSpecV1>)
    : {};
  return normalizeTournamentExperimentSpec(mergeExperimentOverrides(spec, overrides), {
    models: normalizeModelList(process.env.LLM_MODELS),
    profiles: process.env.AGENT_PROFILES,
    assignment: process.env.AGENT_ASSIGNMENT,
    games: 3,
    maxTransitions: process.env.MATCH_MAX_TRANSITIONS,
    timeout: process.env.TOURNAMENT_TIMEOUT_MS,
    temperature: process.env.AGENT_TEMPERATURE ?? 0.7
  });
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

app.use(express.static(path.resolve(__dirname, "../../dist")));

app.use((_req, res) => {
  res.sendFile(path.resolve(__dirname, "../../dist/index.html"));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const failure = publicApiFailureFromError(error);
  const status = error instanceof HttpError ? error.status : 500;
  res.status(status).json({
    error: failure.message,
    ...(failure.code ? { code: failure.code } : {}),
    ...(failure.providerFailure ? { providerFailure: failure.providerFailure } : {})
  });
});

return app;
}

const app = createServerApp();

if (isMainModule()) {
  app.listen(port, host, () => {
    console.log(`Werewolf API listening on http://${host}:${port}`);
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const current = fileURLToPath(import.meta.url);
  const resolvedEntry = path.resolve(entry);
  return resolvedEntry === current || resolvedEntry.endsWith(path.normalize("src/server/index.ts"));
}
