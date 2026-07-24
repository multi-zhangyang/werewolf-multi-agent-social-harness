import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { modelClientFromEnv, providerConfigSummaryFromEnv, providerDiagnosticSummaryFromEnv } from "../agents/providerRegistry";
import { assertRuntimeModelsAvailable, isProviderFailureKind, normalizeModelList } from "../agents/schema";
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
  createHarnessForkProvenance,
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
  buildReplayableSocialPrefix,
  HarnessCheckpointSelectionError as GenericHarnessCheckpointSelectionError,
  validateGenericForkProvenance
} from "../harness/episodeArtifacts";
import {
  mergeExperimentOverrides,
  normalizeTournamentExperimentSpec,
  type NormalizedTournamentExperiment,
  type TournamentExperimentSpecV1
} from "../harness/experiment";
import {
  MATRIX_ARTIFACT_VERSION,
  mergeMatrixExperimentOverrides,
  normalizeMatrixExperimentSpec,
  runExperimentMatrix,
  writeExperimentMatrixArtifactDirectory,
  type ExperimentMatrixArtifactWriteResult,
  type ExperimentMatrixCellResult,
  type ExperimentMatrixResult,
  type NormalizedMatrixExperiment
} from "../harness/experimentMatrix";
import {
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
  type HarnessExperimentRunRecord,
  type HarnessExperimentRunStoreEntry
} from "../harness/experimentRunStore";
import { legacyMetricPromotionPolicyFromSummary, summarizeEvaluationWarnings } from "../harness/evaluation";
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
import { replayWerewolfSocialEpisode } from "../harness/replay";
import { probeHarnessTurn, runHarnessMatch } from "../harness/runtime";
import { hashStableState } from "../harness/hash";
import { projectWerewolfLivePublicState } from "../harness/werewolfAdapter";
import type { WerewolfLivePublicState } from "../harness/types";
import {
  buildMatchComparisonArtifact,
  formatFilteredMatchComparisonMarkdown,
  formatMatchComparisonMarkdown,
  MATCH_COMPARISON_ARTIFACT_VERSION,
  parseComparisonMatchIdsQuery,
  projectFilteredMatchComparison,
  type MatchComparisonArtifact,
  type MatchComparisonEvidenceIdentityFilter,
  type MatchComparisonNumericDeltaFilter,
  type MatchComparisonPromotionFilter,
  type MatchComparisonRowFilter,
  type MatchComparisonRowGroup,
  type MatchComparisonView
} from "../harness/matchComparison";
import { providerFailureFromError, sanitizePersistedProviderDiagnostics } from "../harness/providerFailure";
import { harnessFailureEvidenceFromEpisode } from "../harness/executionEvidence";
import { redactSecrets } from "../harness/redaction";
import { countSocialStepCommits, countSocialStepCommitsByActor, deriveSocialExposureRecords, type SocialExposureRecord, type SocialMessage } from "../harness/social";
import {
  averageTeamRewards,
  summarizeModelRewardsWithDensity
} from "../harness/tournamentEvaluationSummary";
import type { EvidenceRef } from "../harness/socialState";
import {
  openTournamentOrchestration,
  runTournament,
  type TournamentEpisode,
  type TournamentResult
} from "../harness/tournament";
import {
  assertPublicTournamentMatchArtifact,
  summarizeTournamentExecutionTelemetry,
  summarizeTournamentMetricPromotionsFromMetrics,
  summarizeTournamentMetricPromotionsFromReports,
  PUBLIC_TOURNAMENT_ARTIFACT_VERSION,
  TOURNAMENT_ARTIFACT_VERSION,
  writeTournamentArtifactDirectory,
  type PublicTournamentArtifactFiles,
  type TournamentArtifactWriteResult
} from "../harness/tournamentArtifacts";
import type {
  AdversarialEvaluation,
  HarnessAgentConfig,
  HarnessAgentProfile,
  HarnessEvaluationReport,
  HarnessForkProvenance,
  HarnessReasoner,
  HarnessRunResult,
  HarnessTurnTrace,
  ProviderFailureSummary
} from "../harness/types";
import { DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER, WEREWOLF_PARALLEL_MIN_MAX_TRANSITIONS } from "../harness/types";
import {
  countCheckpointsForMatch,
  createMatchRecord,
  createMatchRecordFromState,
  createTournamentPublicShare,
  recordTournamentPublicShareDetailView,
  recordTournamentPublicShareDownload,
  pruneAllTournamentPublicShareEvents,
  retainDownloadEvents,
  retainTimestampEvents,
  DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION,
  deleteTournamentPublicShare,
  getCheckpoint,
  getComparison,
  getExperimentMatrixArtifactSet,
  getMatch,
  getTournamentArtifactSet,
  getTournamentPublicShare,
  listArtifactRecoveryAuditRecords,
  listCheckpoints,
  listCheckpointForkAttempts,
  listComparisons,
  listExperimentMatrixArtifactSets,
  listMatches,
  listTournamentArtifactSets,
  listTournamentPublicShares,
  saveArtifactRecoveryAuditRecord,
  saveCheckpoint,
  saveCheckpointForkAttempt,
  deleteCheckpointForkAttempt,
  saveComparison,
  saveExperimentMatrixArtifactSet,
  saveMatch,
  saveTournamentArtifactSet,
  saveTournamentPublicShare,
  type StoredArtifactRecoveryAuditRecord,
  type StoredCheckpointForkAttempt,
  type StoredExperimentMatrixArtifactFiles,
  type StoredExperimentMatrixArtifactSet,
  type StoredTournamentArtifactFiles,
  type StoredPublicTournamentArtifactFiles,
  type StoredResearchTournamentArtifactFiles,
  type StoredTournamentArtifactSet,
  type StoredTournamentPublicShare,
  type StoredMatch,
  type TournamentPublicShareEventRetentionPolicy
} from "./store";
import {
  projectSocialNetwork,
  REDACTED_DELIVERY_POLICY,
  REDACTED_PRIVATE_OBSERVATION,
  REDACTED_PRIVATE_SOCIAL_OBSERVATION,
  REDACTED_SOCIAL_STEP_FAILURE,
  type MatchArtifactView,
  type MatchArtifactViewDto,
  type PostgameMatchProjectionDto,
  type PostgameReplayFrameDto,
  type RedactedAgentStateDto,
  type RedactedAgentActionArbitrationSummaryDto,
  type RedactedCommandDto,
  type RedactedHarnessStepDto,
  type RedactedPendingActionDto,
  type RedactedSocialEpisodeDto,
  type RedactedSocialMessageDraftDto,
  type RedactedSocialMessageDto,
  type RedactedSocialStepFailureDto
} from "./artifactProjection";
import { projectWerewolfPostgameEventLedger } from "./werewolfReviewLedger";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOURNAMENT_ARTIFACT_SET_INDEX_FILE = "artifact_sets.index.json";
const MATRIX_ARTIFACT_SET_INDEX_FILE = "matrix_artifact_sets.index.json";
const TOURNAMENT_PUBLIC_SHARE_INDEX_FILE = "tournament_public_shares.index.json";
const CHECKPOINT_ARTIFACT_INDEX_FILE = "checkpoints.index.json";
const CHECKPOINT_FORK_ATTEMPT_FILE = "checkpoint_fork_attempts.json";
const CHECKPOINT_ARTIFACT_DIR = "checkpoints";
const MATCH_ARTIFACT_INDEX_FILE = "matches.index.json";
const MATCH_ARTIFACT_DIR = "matches";
const COMPARISON_ARTIFACT_INDEX_FILE = "comparisons.index.json";
const COMPARISON_ARTIFACT_DIR = "comparisons";

let activePublicShareEventRetention: TournamentPublicShareEventRetentionPolicy = {
  ...DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION
};
const ARTIFACT_RECOVERY_AUDIT_FILE = "artifact_recovery_audits.jsonl";
const ARTIFACT_RECOVERY_AUDIT_VERSION = "server.artifact-recovery-audit.v1";
const GENERATED_ARTIFACT_SET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Server-owned match file stems: UUID v4 or safe tournament/episode ids. */
const PERSISTED_MATCH_ARTIFACT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ARTIFACT_RECOVERY_AUDIT_MAX_LIMIT = 500;
const CHECKPOINT_BRANCH_TREE_MAX_DEPTH_LIMIT = 100;
const CHECKPOINT_BRANCH_TREE_MAX_NODES_LIMIT = 1000;
let checkpointForkAttemptWriteQueue: Promise<void> = Promise.resolve();

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
  /**
   * Actual listener host when embedding the app. Full artifacts remain local
   * debug-only and are denied unless this is a loopback bind target.
   */
  artifactAccessBindHost?: string;
  tournamentArtifactBaseDir?: string;
  /** Durable V2 experiment run/episode authority used by production
   * tournament and matrix execution. */
  experimentRunBaseDir?: string;
  matrixArtifactBaseDir?: string;
  checkpointArtifactBaseDir?: string;
  matchArtifactBaseDir?: string;
  comparisonArtifactBaseDir?: string;
  /**
   * Optional override for public share download rate limiting.
   * Defaults come from TOURNAMENT_PUBLIC_SHARE_DOWNLOAD_RATE_LIMIT /
   * TOURNAMENT_PUBLIC_SHARE_DOWNLOAD_RATE_WINDOW_MS.
   */
  publicShareDownloadRateLimit?: {
    maxDownloads: number;
    windowMs: number;
    now?: () => number;
  };
  /**
   * Optional override for public-share analytics event retention.
   * Defaults:
   * - TOURNAMENT_PUBLIC_SHARE_EVENT_MAX=100
   * - TOURNAMENT_PUBLIC_SHARE_EVENT_MAX_AGE_MS=2592000000 (30d)
   */
  publicShareEventRetention?: TournamentPublicShareEventRetentionPolicy;
}

interface RunningMatchLiveProjection {
  artifactVersion: "server.match-live-projection.v1";
  kind: "match-live-projection";
  matchId: string;
  lifecycle: "running";
  artifactAvailable: false;
  projection: {
    view: "live-public";
    privateEvidenceRedacted: true;
    postgameTruthRedacted: true;
  };
  publicState: WerewolfLivePublicState;
}

/**
 * Explicit acknowledgement for a browser that opts into the live spectator
 * lifecycle. This must remain separate from `serializeStoredMatch()`: the
 * latter is an operator registry summary and carries metadata that would be a
 * live timing/model side channel when rendered beside the strict table.
 */
interface LiveMatchStartResponse {
  artifactVersion: "server.match-live-start.v1";
  kind: "match-live-start";
  matchId: string;
  lifecycle: "running";
  artifactAvailable: false;
  projection: {
    view: "live-public";
    privateEvidenceRedacted: true;
    postgameTruthRedacted: true;
  };
}

interface TerminalMatchLiveProjection {
  artifactVersion: "server.match-live-projection.v1";
  kind: "match-live-projection";
  matchId: string;
  /**
   * A process restart can discard the ephemeral frame while a persisted match
   * record still says running. Report that honestly without inventing a local
   * public state or misclassifying the run as failed.
   */
  lifecycle: "running" | "completed" | "truncated" | "failed";
  artifactAvailable: boolean;
}

type MatchLiveProjection = RunningMatchLiveProjection | TerminalMatchLiveProjection;

export function createServerApp(dependencies: ServerAppDependencies = {}): express.Express {
const app = express();
// This server is local-by-default, but avoid advertising the framework even
// when an operator places it behind a deployment-specific authenticated proxy.
app.disable("x-powered-by");
const artifactAccessBindHost = dependencies.artifactAccessBindHost ?? host;
const createReasoner =
  dependencies.createReasoner ??
  ((abortSignal: AbortSignal): HarnessReasoner =>
    OpenAIHarnessReasoner.forLiveProvider(modelClientFromEnv(process.env, { abortSignal })));
const tournamentArtifactBaseDir = normalizeOptionalDirectory(dependencies.tournamentArtifactBaseDir ?? process.env.TOURNAMENT_ARTIFACT_BASE_DIR);
const experimentRunBaseDir = normalizeOptionalDirectory(
  dependencies.experimentRunBaseDir ??
    process.env.EXPERIMENT_RUN_BASE_DIR ??
    (tournamentArtifactBaseDir ? path.join(tournamentArtifactBaseDir, ".experiment-runs") : undefined)
);
/** Keep matrix directories outside the tournament root so recovery scans have one artifact schema per root. */
const matrixArtifactBaseDir = normalizeOptionalDirectory(
  dependencies.matrixArtifactBaseDir ??
    process.env.MATRIX_ARTIFACT_BASE_DIR ??
    (tournamentArtifactBaseDir ? path.join(tournamentArtifactBaseDir, "matrices") : undefined)
);
const checkpointArtifactBaseDir = normalizeOptionalDirectory(dependencies.checkpointArtifactBaseDir ?? process.env.CHECKPOINT_ARTIFACT_BASE_DIR);
const matchArtifactBaseDir = normalizeOptionalDirectory(dependencies.matchArtifactBaseDir ?? process.env.MATCH_ARTIFACT_BASE_DIR);
let matchArtifactStoreLoad: Promise<void> | undefined;
const comparisonArtifactBaseDir = normalizeOptionalDirectory(
  dependencies.comparisonArtifactBaseDir ?? process.env.COMPARISON_ARTIFACT_BASE_DIR
);
const publicShareDownloadRateLimit = resolvePublicShareDownloadRateLimit(
  dependencies.publicShareDownloadRateLimit,
  process.env
);
const publicShareEventRetention = resolvePublicShareEventRetention(
  dependencies.publicShareEventRetention,
  process.env
);
// Running-table projections are ephemeral API views. They must never become a
// match artifact, replay/checkpoint source, or store-owned canonical state.
const liveMatchProjections = new Map<string, RunningMatchLiveProjection>();

const setLiveProjection = (matchId: string, publicState: WerewolfLivePublicState): void => {
  const current = liveMatchProjections.get(matchId);
  const state = structuredClone(publicState);
  // Safe-state equality, rather than a receipt/batch counter, prevents
  // private night actions and parallel receipt fan-out becoming a cadence
  // side-channel in the public revision number.
  if (current && hashStableState(current.publicState) === hashStableState(state)) return;
  liveMatchProjections.set(matchId, {
    artifactVersion: "server.match-live-projection.v1",
    kind: "match-live-projection",
    matchId,
    lifecycle: "running",
    artifactAvailable: false,
    projection: {
      view: "live-public",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: true
    },
    publicState: state
  });
};
activePublicShareEventRetention = publicShareEventRetention;
const publicShareDownloadBuckets = new Map<string, number[]>();

app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  const provider = providerConfigSummaryFromEnv();
  res.json({
    ok: true,
    service: "werewolf-multi-agent-arena",
    provider: providerDiagnosticSummaryFromEnv(),
    models: provider.models
  });
});

app.get("/api/config", (req, res) => {
  const provider = providerConfigSummaryFromEnv();
  const localResearchAccess = hasLocalResearchArtifactAccess(req, artifactAccessBindHost);
  res.json({
    defaultConfig: DEFAULT_CONFIG,
    models: provider.models,
    policyNames: POLICY_NAMES,
    defaultProfiles: profilesFromModels(provider.models, Number(process.env.AGENT_TEMPERATURE ?? 0.7)),
    provider: providerDiagnosticSummaryFromEnv(),
    artifactExport: {
      tournamentConfigured: Boolean(tournamentArtifactBaseDir),
      matrixConfigured: Boolean(matrixArtifactBaseDir),
      checkpointConfigured: Boolean(checkpointArtifactBaseDir),
      matchConfigured: Boolean(matchArtifactBaseDir)
    },
    capabilities: {
      operatorRegistry: localResearchAccess,
      postgameArtifact: localResearchAccess,
      postgameReplay: localResearchAccess,
      checkpointCreate: localResearchAccess,
      checkpointFork: localResearchAccess,
      artifactExport: {
        // Match artifacts can be downloaded from the canonical in-process
        // registry even when an optional disk export directory is absent.
        match: localResearchAccess,
        tournament: localResearchAccess && Boolean(tournamentArtifactBaseDir),
        matrix: localResearchAccess && Boolean(matrixArtifactBaseDir)
      }
    }
  });
});

app.get("/api/artifact-recovery-audits", async (req, res, next) => {
  try {
    await loadServerArtifactStores();
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
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
    assertLocalOperatorRegistryAccess(_req, artifactAccessBindHost);
    await loadServerArtifactStores();
    res.json(listMatches().map(serializeStoredMatch));
  } catch (error) {
    next(error);
  }
});

app.get("/api/matches/:id", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
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

/**
 * Ephemeral running-table view. This deliberately cannot expose a trajectory,
 * checkpoint, command, or postgame artifact: it is only a server projection
 * of safe public facts at a committed boundary.
 */
app.get("/api/matches/:id/live", async (req, res, next) => {
  try {
    const current = liveMatchProjections.get(req.params.id);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (current) {
      res.json(structuredClone(current));
      return;
    }
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    const match = getMatch(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    const lifecycle: TerminalMatchLiveProjection["lifecycle"] =
      match.status === "running" ? "running" : match.artifact?.status === "truncated" ? "truncated" : match.status === "failed" ? "failed" : "completed";
    res.json({
      artifactVersion: "server.match-live-projection.v1",
      kind: "match-live-projection",
      matchId: match.id,
      lifecycle,
      artifactAvailable: Boolean(match.artifact)
    } satisfies TerminalMatchLiveProjection);
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
    const view = artifactViewFromQuery(req.query, req, artifactAccessBindHost);
    const projected = projectMatchArtifactForView(match.artifact, view);
    setArtifactProjectionResponseHeaders(res, view);
    if (downloadRequested(req.query)) {
      const shortId = match.id.slice(0, 8);
      res.setHeader("Content-Disposition", `attachment; filename="${shortId}-match-${view}.json"`);
    }
    res.json(projected);
  } catch (error) {
    next(error);
  }
});

app.get("/api/matches/:id/compare/:candidateId", async (req, res, next) => {
  try {
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    const view = artifactViewFromQuery(req.query, req, artifactAccessBindHost);
    const format = comparisonFormatFromQuery(req.query);
    const rowFilter = comparisonRowFilterFromQuery(req.query);
    const filteredRequested = filteredComparisonRequested(req.query, rowFilter);
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
    const baselineArtifact = projectMatchArtifactForView(baseline.artifact, view);
    const candidateArtifact = projectMatchArtifactForView(candidate.artifact, view);
    const comparison = redactSecrets(
      buildMatchComparisonArtifact({
        baseline: baselineArtifact,
        candidate: candidateArtifact,
        view,
        createdAt: new Date(0).toISOString()
      })
    );
    // Registry artifacts are an API-visible truth surface. A full/debug
    // comparison may be requested explicitly, but must remain request-local so
    // a later registry read cannot expose it without the same explicit intent.
    // Filtered projections are also request-local pure views.
    if (!filteredRequested && view !== "full") {
      saveComparison(comparison);
      await persistComparisonArtifact(comparison, comparisonArtifactBaseDir);
      await writeComparisonArtifactIndex(comparisonArtifactBaseDir);
    }
    const payload = filteredRequested
      ? redactSecrets(
          projectFilteredMatchComparison(comparison, rowFilter, {
            createdAt: new Date(0).toISOString()
          })
        )
      : comparison;
    const shortBaseline = baseline.id.slice(0, 8);
    const shortCandidate = candidate.id.slice(0, 8);
    const filenameStem = filteredRequested
      ? `${shortBaseline}-vs-${shortCandidate}-comparison-filtered`
      : `${shortBaseline}-vs-${shortCandidate}-comparison`;
    setArtifactProjectionResponseHeaders(res, view);
    if (format === "markdown") {
      const markdown = filteredRequested
        ? formatFilteredMatchComparisonMarkdown(payload as ReturnType<typeof projectFilteredMatchComparison>)
        : formatMatchComparisonMarkdown(comparison);
      if (downloadRequested(req.query)) {
        res.setHeader("Content-Disposition", `attachment; filename="${filenameStem}.md"`);
      }
      res.type("text/markdown; charset=utf-8").send(markdown);
      return;
    }
    if (downloadRequested(req.query)) {
      res.setHeader("Content-Disposition", `attachment; filename="${filenameStem}.json"`);
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/comparisons", async (req, res, next) => {
  try {
    await loadComparisonArtifactIndex(comparisonArtifactBaseDir);
    const view = artifactViewFromQuery(req.query, req, artifactAccessBindHost);
    const baselineId = typeof req.query.baselineId === "string" ? req.query.baselineId.trim() : "";
    const candidateId = typeof req.query.candidateId === "string" ? req.query.candidateId.trim() : "";
    const packMatchIds = parseComparisonMatchIdsQuery(req.query.matchIds);
    const comparisons = listComparisons({
      ...(baselineId ? { baselineId } : {}),
      ...(candidateId ? { candidateId } : {}),
      ...(packMatchIds ? { packMatchIds } : {})
    })
      .filter((comparison) => comparisonIsVisibleInRegistry(comparison, view))
      .map((comparison) => ({
      comparisonId: comparison.comparisonId,
      createdAt: comparison.createdAt,
      view: comparison.view,
      projection: comparison.projection,
      baseline: {
        matchId: comparison.baseline.matchId,
        runId: comparison.baseline.runId,
        seed: comparison.baseline.seed
      },
      candidate: {
        matchId: comparison.candidate.matchId,
        runId: comparison.candidate.runId,
        seed: comparison.candidate.seed
      },
      summary: {
        rowCount: comparison.summary.rowCount,
        changedRowCount: comparison.summary.changedRowCount,
        numericDeltaCount: comparison.summary.numericDeltaCount,
        promotionChangedMetricCount: comparison.summary.promotionChangedMetricCount,
        promotionProvenanceChangedMetricCount: comparison.summary.promotionProvenanceChangedMetricCount,
        scorecardMetricDelta: comparison.summary.scorecardMetricDelta,
        diagnosticMetricDelta: comparison.summary.diagnosticMetricDelta,
        benchmarkOnlyMetricDelta: comparison.summary.benchmarkOnlyMetricDelta,
        evidenceIdentityChangedMetricCount: comparison.summary.evidenceIdentityChangedMetricCount,
        evidenceIdentityOnlyBaselineRefCount: comparison.summary.evidenceIdentityOnlyBaselineRefCount,
        evidenceIdentityOnlyCandidateRefCount: comparison.summary.evidenceIdentityOnlyCandidateRefCount,
        metricKeysCompared: comparison.summary.metricKeysCompared,
        metricKeysEmitted: comparison.summary.metricKeysEmitted,
        metricKeysTruncated: comparison.summary.metricKeysTruncated,
        scorecardMetricKeysCompared: comparison.summary.scorecardMetricKeysCompared,
        scorecardMetricKeysEmitted: comparison.summary.scorecardMetricKeysEmitted,
        scorecardMetricKeysTruncated: comparison.summary.scorecardMetricKeysTruncated,
        diagnosticMetricKeysCompared: comparison.summary.diagnosticMetricKeysCompared,
        diagnosticMetricKeysEmitted: comparison.summary.diagnosticMetricKeysEmitted,
        diagnosticMetricKeysTruncated: comparison.summary.diagnosticMetricKeysTruncated,
        benchmarkOnlyMetricKeysCompared: comparison.summary.benchmarkOnlyMetricKeysCompared,
        benchmarkOnlyMetricKeysEmitted: comparison.summary.benchmarkOnlyMetricKeysEmitted,
        benchmarkOnlyMetricKeysTruncated: comparison.summary.benchmarkOnlyMetricKeysTruncated,
        metricRowsMax: comparison.summary.metricRowsMax,
        baselineSocialSteps: comparison.summary.baselineSocialSteps,
        candidateSocialSteps: comparison.summary.candidateSocialSteps,
        baselineCommittedSteps: comparison.summary.baselineCommittedSteps,
        candidateCommittedSteps: comparison.summary.candidateCommittedSteps,
        baselineRejectedSteps: comparison.summary.baselineRejectedSteps,
        candidateRejectedSteps: comparison.summary.candidateRejectedSteps,
        socialStepsDelta: comparison.summary.socialStepsDelta,
        committedStepsDelta: comparison.summary.committedStepsDelta,
        rejectedStepsDelta: comparison.summary.rejectedStepsDelta,
        baselineHash: comparison.summary.baselineHash,
        candidateHash: comparison.summary.candidateHash
      }
    }));
    setArtifactProjectionResponseHeaders(res, view);
    res.json({ comparisons });
  } catch (error) {
    next(error);
  }
});

app.get("/api/comparisons/:id", async (req, res, next) => {
  try {
    await loadComparisonArtifactIndex(comparisonArtifactBaseDir);
    const comparison = getComparison(req.params.id);
    if (!comparison) {
      res.status(404).json({ error: "comparison not found" });
      return;
    }
    const view = artifactViewFromQuery(req.query, req, artifactAccessBindHost);
    if (!comparisonIsVisibleInRegistry(comparison, view)) {
      // Do not disclose a legacy full comparison through the default safe
      // route. A caller that intentionally needs a locally stored full record
      // must explicitly request view=full.
      res.status(404).json({ error: "comparison not found" });
      return;
    }
    if (view === "full" && comparison.view !== "full") {
      throw new HttpError(
        409,
        "Stored comparison is not available in the requested full view; regenerate it from the match pair with view=full.",
        "comparison_view_unavailable"
      );
    }
    const format = comparisonFormatFromQuery(req.query);
    setArtifactProjectionResponseHeaders(res, view);
    if (format === "markdown") {
      if (downloadRequested(req.query)) {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${req.params.id.slice(0, 24)}-comparison.md"`
        );
      }
      res.type("text/markdown; charset=utf-8").send(formatMatchComparisonMarkdown(comparison));
      return;
    }
    if (downloadRequested(req.query)) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${req.params.id.slice(0, 24)}-comparison.json"`
      );
    }
    res.json(comparison);
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
    const view = artifactViewFromQuery(req.query, req, artifactAccessBindHost);
    const artifact = projectMatchArtifactForView(match.artifact, view);
    const shortId = match.id.slice(0, 8);
    // trajectory.jsonl is always a downloadable export surface.
    setArtifactProjectionResponseHeaders(res, view);
    res.setHeader("Content-Disposition", `attachment; filename="${shortId}-trajectory-${view}.jsonl"`);
    res.type("application/x-ndjson").send(toTrajectoryJsonl(artifact));
  } catch (error) {
    next(error);
  }
});

/**
 * Return one server-authoritative, postgame-redacted state frame after a
 * complete native scheduler boundary. This is intentionally separate from
 * full-episode replay verification: a valid prefix must never be reported as
 * proof that later canonical steps also verify.
 */
app.post("/api/matches/:id/replay/frame", async (req, res, next) => {
  try {
    // Native cursor positions and a postgame-redacted prefix state disclose
    // more than a public observation. This is a local research-review API,
    // not an alternate way to bypass the truth-redacted projection.
    assertLocalPostgameReplayAccess(req, artifactAccessBindHost);
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
    const body = requestBodyObject(req.body);
    assertAllowedBodyFields(body, ["nativeStepCount"], "server-owned replay frame");
    const nativeStepCount = requiredReplayFrameNativeStepCount(body);
    assertStoredMatchArtifactIntegrity(match.artifact);
    const prefix = buildReplayableSocialPrefix({
      episode: match.artifact.socialEpisode,
      selector: { nativeStepCount },
      replayPrefix: (episode) =>
        replayWerewolfSocialEpisode(episode, {
          // A prefix does not claim that it equals the parent final state. Its
          // state is derived solely from the recorded command prefix below.
          validateExpectedFinalState: false,
          stopOnMismatch: false,
          // Full canonical integrity was verified above. A view frame has no
          // actor restore semantics, so it deliberately does not audit or
          // expose durable actor snapshots again.
          auditAgentSnapshots: false
        })
    });
    const frame = projectPostgameReplayFrame(prefix);
    setArtifactProjectionResponseHeaders(res, "postgame-redacted");
    res.json({ frame: redactSecrets(frame) });
  } catch (error) {
    next(httpErrorFromReplayFrameError(error));
  }
});

app.post("/api/matches/:id/replay", async (req, res, next) => {
  let match: StoredMatch | undefined;
  try {
    // Full replay summaries contain native step/batch counts and deterministic
    // hashes. They are audit evidence for local postgame research only; a
    // truth-redacted client must not use them as a scheduler side channel.
    assertLocalPostgameReplayAccess(req, artifactAccessBindHost);
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
    const body = requestBodyObject(req.body);
    assertAllowedBodyFields(body, ["stopOnMismatch"], "server-owned replay");
    assertStoredMatchArtifactIntegrity(match.artifact);
    const replay = replayWerewolfSocialEpisode(match.artifact.socialEpisode, {
      stopOnMismatch: body.stopOnMismatch !== false,
      agentSnapshotFrames: match.artifact.agentSnapshotFrames
    });
    res.status(replay.ok ? 200 : 409).json(
      serializeSocialReplayResult(replay, {
        source: "server-owned-match-artifact",
        matchId: match.id,
        runId: match.artifact.runId,
        ...countSocialStepCommits(match.artifact.socialEpisode.steps),
        finalHashMatchesArtifact: replay.finalHash === replay.expectedFinalHash
      })
    );
  } catch (error) {
    if (error instanceof HttpError) {
      next(error);
      return;
    }
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
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    const body = requestBodyObject(req.body);
    assertForbiddenBodyFields(body, FORBIDDEN_CHECKPOINT_BODY_FIELDS, "checkpoint creation");
    assertAllowedBodyFields(body, ["reason", "nativeStepCount", "traceId", "nativeTurnIndex"], "checkpoint creation");
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
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    await loadServerArtifactStores();
    const match = getMatch(req.params.id);
    const attempt = listCheckpointForkAttempts().find((candidate) => candidate.childRunId === req.params.id);
    if (!match && !attempt) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!match?.artifact && attempt) {
      const checkpoint = getCheckpoint(attempt.forkOf.checkpointId);
      res.json({ summary: buildCheckpointForkAttemptLineageSummary(attempt, checkpoint) });
      return;
    }
    if (!match?.artifact) {
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
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
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
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
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
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
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
    const checkpoint = getCheckpoint(req.params.id);
    if (!checkpoint) {
      res.status(404).json({ error: "checkpoint not found" });
      return;
    }
    const artifacts = listMatches().flatMap((match) => (match.artifact ? [match.artifact] : []));
    const query = checkpointBranchTreeQueryFromRequest(req.query);
    res.json({
      summary: buildCheckpointBranchTreeSummary(
        checkpoint,
        artifacts,
        listCheckpoints(),
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
    const checkpoint = getCheckpoint(req.params.id);
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

app.get("/api/experiments/runs", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    if (!experimentRunBaseDir) throw new HttpError(404, "Experiment run authority is not configured.");
    const authority = await openTournamentOrchestration({ baseDirectory: experimentRunBaseDir });
    const entries = await authority.runStore.list();
    res.json({
      artifactVersion: "server.experiment-run-index.v1",
      kind: "experiment-run-index",
      entries: entries.map(serializeExperimentRunIndexEntry)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/runs/:runSetId", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    if (!experimentRunBaseDir) throw new HttpError(404, "Experiment run authority is not configured.");
    const authority = await openTournamentOrchestration({ baseDirectory: experimentRunBaseDir });
    const entry = await authority.runStore.get(req.params.runSetId);
    if (!entry) throw new HttpError(404, "Experiment run was not found.");
    res.json(serializeExperimentRunRecord(entry));
  } catch (error) {
    next(error);
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

app.get("/api/tournament-artifacts", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
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
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
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
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
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

app.post("/api/tournament-artifacts/:id/shares", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    const artifactSet = getTournamentArtifactSetForBaseDir(req.params.id, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "tournament artifact set not found" });
      return;
    }
    await assertVerifiedPublicTournamentArtifactSet(artifactSet, tournamentArtifactBaseDir);
    const body = requestBodyObject(req.body);
    assertForbiddenBodyFields(body, FORBIDDEN_TOURNAMENT_SHARE_BODY_FIELDS, "tournament share create");
    const label = parseOptionalString(body.label, "label");
    const expiresAt = parseOptionalShareExpiresAt(body.expiresAt);
    const relativeFiles = parseOptionalShareRelativeFiles(body.relativeFiles, artifactSet);
    const share = createTournamentPublicShare({
      artifactSetId: artifactSet.id,
      label,
      expiresAt,
      relativeFiles,
      projection: artifactSet.projection
    });
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    saveTournamentPublicShare(share);
    await writeTournamentPublicShareIndex(tournamentArtifactBaseDir);
    res.status(201).json(serializeTournamentPublicShare(share));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tournament-artifacts/:id/shares", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const artifactSet = getTournamentArtifactSetForBaseDir(req.params.id, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "tournament artifact set not found" });
      return;
    }
    res.json({
      artifactSetId: artifactSet.id,
      shares: listTournamentPublicShares(artifactSet.id).map(serializeTournamentPublicShare)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tournament-public-shares", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const shares = listTournamentPublicShares().map(serializeTournamentPublicShareInventory);
    res.json({
      count: shares.length,
      activeCount: shares.filter((share) => !share.expired).length,
      expiredCount: shares.filter((share) => share.expired).length,
      shares
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tournament-public-shares/summary", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const format = typeof req.query.format === "string" ? req.query.format.trim().toLowerCase() : "json";
    if (format !== "json" && format !== "markdown" && format !== "md") {
      res.status(400).json({ error: 'format must be "json" or "markdown"' });
      return;
    }
    const summary = buildTournamentPublicShareAnalyticsSummary();
    if (format === "markdown" || format === "md") {
      const markdown = renderTournamentPublicShareAnalyticsSummaryMarkdown(summary);
      res.setHeader("content-disposition", 'attachment; filename="tournament-public-share-analytics.md"');
      res.type("text/markdown; charset=utf-8").send(markdown);
      return;
    }
    res.setHeader("content-disposition", 'attachment; filename="tournament-public-share-analytics.json"');
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/tournament-shares/:shareId", async (req, res, next) => {
  try {
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const share = requireActiveTournamentPublicShare(req.params.shareId);
    const artifactSet = getTournamentArtifactSetForBaseDir(share.artifactSetId, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "shared tournament artifact set not found" });
      return;
    }
    await assertVerifiedPublicTournamentArtifactSet(artifactSet, tournamentArtifactBaseDir);
    const viewed = recordTournamentPublicShareDetailView(share.id, new Date().toISOString(), activePublicShareEventRetention) ?? share;
    await writeTournamentPublicShareIndex(tournamentArtifactBaseDir);
    res.json(serializeTournamentPublicShareDetail(viewed, artifactSet));
  } catch (error) {
    next(error);
  }
});

app.get(/^\/api\/public\/tournament-shares\/([^/]+)\/files\/(.+)$/, async (req, res, next) => {
  try {
    const params = req.params as unknown as string[];
    const shareId = params[0];
    const requestedPath = params[1];
    await loadTournamentArtifactSetIndex(tournamentArtifactBaseDir);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const share = requireActiveTournamentPublicShare(shareId);
    const artifactSet = getTournamentArtifactSetForBaseDir(share.artifactSetId, tournamentArtifactBaseDir);
    if (!artifactSet) {
      res.status(404).json({ error: "shared tournament artifact set not found" });
      return;
    }
    await assertVerifiedPublicTournamentArtifactSet(artifactSet, tournamentArtifactBaseDir);
    const rateKey = `${share.id}:${requestClientKey(req)}`;
    const rate = consumePublicShareDownloadRateLimit(publicShareDownloadBuckets, rateKey, publicShareDownloadRateLimit);
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSeconds));
      res.status(429).json({
        error: "public share download rate limit exceeded",
        retryAfterSeconds: rate.retryAfterSeconds,
        limit: publicShareDownloadRateLimit.maxDownloads,
        windowMs: publicShareDownloadRateLimit.windowMs
      });
      return;
    }
    const file = await resolveRegisteredTournamentArtifactFile(artifactSet, requestedPath, tournamentArtifactBaseDir);
    if (share.relativeFiles && !share.relativeFiles.includes(file.relativePath)) {
      res.status(404).json({ error: "shared tournament artifact file not found" });
      return;
    }
    let content: Buffer;
    try {
      content = await readFile(file.absolutePath);
    } catch (error) {
      if (isFileReadNotFound(error)) {
        res.status(404).json({ error: "shared tournament artifact file not found" });
        return;
      }
      throw new HttpError(500, "shared tournament artifact file could not be read");
    }
    recordTournamentPublicShareDownload(share.id, file.relativePath, new Date().toISOString(), activePublicShareEventRetention);
    await writeTournamentPublicShareIndex(tournamentArtifactBaseDir);
    res.type(contentTypeForArtifactFile(file.relativePath)).send(content);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/public/tournament-shares/:shareId", async (req, res, next) => {
  try {
    assertLocalResearchArtifactAccess(req, artifactAccessBindHost);
    await loadTournamentPublicShareIndex(tournamentArtifactBaseDir);
    const share = getTournamentPublicShare(req.params.shareId);
    if (!share) {
      res.status(404).json({ error: "tournament public share not found" });
      return;
    }
    deleteTournamentPublicShare(share.id);
    await writeTournamentPublicShareIndex(tournamentArtifactBaseDir);
    res.status(204).send();
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
    jointPhaseScheduler?: "aec-batched-decision" | "parallel";
    timeoutMs?: number;
    elapsedMs: number;
  }
): object {
  const harnessFailures = harnessFailureEvidenceFromEpisode(result.socialEpisode).map(summarizeHarnessFailure);
  const stepCounts = countSocialStepCommits(result.socialEpisode.steps);
  return {
    kind: "match",
    ok: result.status === "completed" && result.state.phase === "game_over" && harnessFailures.length === 0,
    provider: providerDiagnosticSummaryFromEnv(),
    seed: options.seed,
    rulesetId: result.initialState.config.rulesetId,
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
      timeoutMs: options.timeoutMs ?? null,
      jointPhaseScheduler: options.jointPhaseScheduler ?? DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER
    },
    elapsedMs: options.elapsedMs,
    gameOver: result.state.phase === "game_over",
    stoppedBeforeGameOver: result.state.phase !== "game_over",
    winner: result.state.winner ?? null,
    endReason: result.state.endReason ?? null,
    day: result.state.day,
    harnessTurnCount: result.metrics.harnessTurnCount,
    harnessErrorCount: result.metrics.harnessErrorCount,
    ...stepCounts,
    socialSteps: stepCounts.nativeSteps,
    trajectorySteps: result.trajectory.length,
    averageModelLatencyMs: result.metrics.averageLatencyMs,
    modelUsage: summarizeModelUsage(result.metrics),
    evaluation: summarizeEvaluation(result.evaluation, stepCounts),
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
  "socialEpisode",
  "executionPrefix",
  "channels",
  "socialMessages",
  "initialSocialMessages",
  "stateHash",
  "trajectoryHash",
  "executionPrefixHash",
  "agentsHash",
  "channelsHash",
  "messagesHash",
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

const FORBIDDEN_TOURNAMENT_SHARE_BODY_FIELDS = [
  ...FORBIDDEN_TOURNAMENT_BODY_FIELDS,
  "shareId",
  "token",
  "artifactSetId",
  "id",
  "downloads",
  "files",
  "projection",
  "publicShareSafe"
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
  if (typeof value !== "string") throw new HttpError(500, "Configured artifact base directory must be a string.");
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

function assertForbiddenMatrixRequestFields(body: Record<string, unknown>, context: string): void {
  assertForbiddenTournamentRequestFields(body, context);
  const spec = isRecord(body.spec) ? body.spec : body;
  if (isRecord(spec.base)) {
    assertForbiddenBodyFields(spec.base, FORBIDDEN_TOURNAMENT_BODY_FIELDS, `${context} base`);
  }
  if (Array.isArray(spec.cells)) {
    spec.cells.forEach((cell, index) => {
      if (!isRecord(cell)) return;
      assertForbiddenBodyFields(cell, FORBIDDEN_TOURNAMENT_BODY_FIELDS, `${context} cell ${index + 1}`);
      if (isRecord(cell.spec)) {
        assertForbiddenBodyFields(cell.spec, FORBIDDEN_TOURNAMENT_BODY_FIELDS, `${context} cell ${index + 1} spec`);
      }
    });
  }
}

function parseOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string.`);
  return value;
}

function parseOptionalBoundedString(value: unknown, name: string, maxLength: number): string | undefined {
  const parsed = parseOptionalString(value, name)?.trim();
  if (!parsed) return undefined;
  if (parsed.length > maxLength) throw new HttpError(400, `${name} must not exceed ${maxLength} characters.`);
  return parsed;
}

function checkpointPrefixSelectorFromBody(body: Record<string, unknown>): HarnessCheckpointPrefixSelector | undefined {
  const hasTraceId = body.traceId !== undefined && body.traceId !== null && body.traceId !== "";
  const hasNativeTurnIndex = body.nativeTurnIndex !== undefined && body.nativeTurnIndex !== null && body.nativeTurnIndex !== "";
  const hasNativeStepCount = body.nativeStepCount !== undefined && body.nativeStepCount !== null && body.nativeStepCount !== "";
  const selectorCount = [hasTraceId, hasNativeTurnIndex, hasNativeStepCount].filter(Boolean).length;
  if (selectorCount === 0) return undefined;
  if (selectorCount > 1) throw new HttpError(400, "checkpoint creation request must include at most one prefix selector.");
  if (hasTraceId) return { traceId: parseOptionalString(body.traceId, "traceId") };
  if (hasNativeTurnIndex) return { nativeTurnIndex: parseOptionalPositiveInteger(body.nativeTurnIndex, "nativeTurnIndex") };
  return { nativeStepCount: parseOptionalPositiveInteger(body.nativeStepCount, "nativeStepCount") };
}

function httpErrorFromCheckpointSelectionError(error: unknown): unknown {
  if (!(error instanceof HarnessCheckpointSelectionError)) return error;
  const status = error.code === "ambiguous_selector" || error.code === "selector_not_found" ? 400 : 409;
  return new HttpError(status, error.message, error.code);
}

function requiredReplayFrameNativeStepCount(body: Record<string, unknown>): number {
  if (!Object.prototype.hasOwnProperty.call(body, "nativeStepCount")) {
    throw new HttpError(400, "server-owned replay frame requires nativeStepCount.", "replay_frame_selector_required");
  }
  try {
    const value = parseOptionalPositiveInteger(body.nativeStepCount, "nativeStepCount");
    if (value === undefined) throw new Error("missing nativeStepCount");
    return value;
  } catch {
    throw new HttpError(400, "nativeStepCount must be a positive integer.", "replay_frame_selector_invalid");
  }
}

function assertStoredMatchArtifactIntegrity(artifact: MatchArtifact): void {
  try {
    assertValidMatchArtifactIntegrity(artifact);
  } catch {
    throw new HttpError(409, "Stored match artifact failed integrity validation.", "artifact_integrity_invalid");
  }
}

function httpErrorFromReplayFrameError(error: unknown): unknown {
  // Replay frames use the generic prefix selector.  The older Werewolf
  // checkpoint compatibility layer has a similarly named error class, but it
  // is a distinct runtime constructor and must not be used to classify a
  // generic replay-frame selection failure.
  if (!(error instanceof GenericHarnessCheckpointSelectionError)) return error;
  switch (error.code) {
    case "ambiguous_selector":
    case "selector_not_found":
      return new HttpError(400, "Replay frame nativeStepCount did not match a recorded native step.", "replay_frame_selector_not_found");
    case "unsafe_batch_boundary":
      return new HttpError(409, "Replay frame must end at a complete native scheduler batch boundary.", "replay_frame_unsafe_batch_boundary");
    case "prefix_replay_mismatch":
      return new HttpError(409, "Recorded replay prefix failed integrity verification.", "replay_frame_integrity_mismatch");
    default:
      return new HttpError(409, "Replay frame cannot be built from the selected native boundary.", "replay_frame_unavailable");
  }
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
      rulesetId: checkpoint.source.rulesetId,
      status: checkpoint.source.status,
      boundaryTraceRef: checkpoint.source.boundaryTraceId
        ? hashStableState({ traceId: checkpoint.source.boundaryTraceId }).slice(0, 16)
        : null,
      boundaryTurnIndex: checkpoint.source.boundaryTurnIndex ?? null,
      boundaryBatchId: checkpoint.source.boundaryBatchId ?? null,
      boundaryBatchIndex: checkpoint.source.boundaryBatchIndex ?? null,
      boundarySchedulerMode: checkpoint.source.boundarySchedulerMode ?? null,
      nativeStepCount: checkpoint.source.nativeStepCount,
      messageCount: checkpoint.source.messageCount,
      lastMessageSeq: checkpoint.source.lastMessageSeq ?? null,
      stateHash: checkpoint.source.stateHash,
      executionPrefixHash: checkpoint.source.executionPrefixHash,
      agentsHash: checkpoint.source.agentsHash,
      channelsHash: checkpoint.source.channelsHash,
      messagesHash: checkpoint.source.messagesHash,
      failureReason: checkpoint.source.failureReason ? sanitizeApiErrorText(checkpoint.source.failureReason) : null,
      truncationReason: checkpoint.source.truncationReason ?? null
    },
    counts: {
      agents: checkpoint.agents.length,
      ...countSocialStepCommits(checkpoint.executionPrefix.steps),
      socialMessages: checkpoint.executionPrefix.messages.length,
      channels: checkpoint.executionPrefix.channels.length
    }
  };
}

function buildCheckpointForksSummary(
  checkpoint: HarnessCheckpoint,
  artifacts: MatchArtifact[],
  attempts: StoredCheckpointForkAttempt[] = []
): object {
  const forks = artifacts.map((artifact) => buildForkChildSummary(artifact, checkpoint));
  const artifactRunIds = new Set(artifacts.map((artifact) => artifact.runId));
  const unresolvedAttempts = attempts
    .filter((attempt) => !artifactRunIds.has(attempt.childRunId))
    .map((attempt) => buildCheckpointForkAttemptSummary(attempt, checkpoint));
  return {
    kind: "checkpoint-forks",
    schemaVersion: "server.checkpoint-forks-summary.v3",
    ok:
      forks.every((fork) => isRecord(fork.lineage) && fork.lineage.ok === true) &&
      unresolvedAttempts.every((attempt) => isRecord(attempt.boundary) && attempt.boundary.ok === true),
    checkpoint: serializeCheckpointSummary(checkpoint),
    childCount: forks.length + unresolvedAttempts.length,
    artifactChildCount: forks.length,
    attemptCount: unresolvedAttempts.length,
    failedAttemptCount: unresolvedAttempts.filter((attempt) => attempt.status === "failed").length,
    runningAttemptCount: unresolvedAttempts.filter((attempt) => attempt.status === "running").length,
    forks,
    attempts: unresolvedAttempts
  };
}

function buildCheckpointBranchTreeSummary(
  rootCheckpoint: HarnessCheckpoint,
  artifacts: MatchArtifact[],
  checkpoints: HarnessCheckpoint[],
  attempts: StoredCheckpointForkAttempt[] = [],
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

  const artifactRunIds = new Set(artifacts.map((artifact) => artifact.runId));
  const attemptsByParentCheckpoint = new Map<string, StoredCheckpointForkAttempt[]>();
  for (const attempt of attempts) {
    if (artifactRunIds.has(attempt.childRunId)) continue;
    const current = attemptsByParentCheckpoint.get(attempt.forkOf.checkpointId) ?? [];
    current.push(attempt);
    attemptsByParentCheckpoint.set(attempt.forkOf.checkpointId, current);
  }
  for (const children of attemptsByParentCheckpoint.values()) {
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
  const attemptNodes = new Map<string, object>();
  const edges = new Map<string, object>();
  const truncationReasons = new Set<string>();
  const truncation = {
    omittedCheckpoints: 0,
    omittedMatches: 0,
    omittedAttempts: 0,
    omittedEdges: 0
  };
  const nodeCount = () => checkpointNodes.size + matchNodes.size + attemptNodes.size;
  const recordOmittedNode = (kind: "checkpoint" | "match" | "attempt", reason: "maxDepth" | "maxNodes") => {
    truncationReasons.add(reason);
    if (kind === "checkpoint") truncation.omittedCheckpoints += 1;
    else if (kind === "match") truncation.omittedMatches += 1;
    else truncation.omittedAttempts += 1;
  };
  const canIncludeNode = (kind: "checkpoint" | "match" | "attempt", alreadyIncluded: boolean, depth: number): boolean => {
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
      childForkCount:
        (artifactsByParentCheckpoint.get(checkpoint.checkpointId)?.length ?? 0) +
        (attemptsByParentCheckpoint.get(checkpoint.checkpointId)?.length ?? 0),
      artifactChildCount: artifactsByParentCheckpoint.get(checkpoint.checkpointId)?.length ?? 0,
      childAttemptCount: attemptsByParentCheckpoint.get(checkpoint.checkpointId)?.length ?? 0,
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
  const includeAttemptNode = (
    attempt: StoredCheckpointForkAttempt,
    checkpoint: HarnessCheckpoint,
    depth: number
  ): Record<string, unknown> | undefined => {
    const existing = attemptNodes.get(attempt.childRunId);
    const existingDepth = checkpointNodeDepth(existing);
    if (isRecord(existing) && existingDepth !== null && existingDepth <= depth) return existing;
    if (!canIncludeNode("attempt", Boolean(existing), depth)) return undefined;
    const node = {
      depth,
      parentCheckpointId: checkpoint.checkpointId,
      ...buildCheckpointForkAttemptSummary(attempt, checkpoint)
    };
    attemptNodes.set(attempt.childRunId, node);
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
      for (const attempt of attemptsByParentCheckpoint.get(checkpoint.checkpointId) ?? []) {
        const childDepth = item.depth + 1;
        const attemptSummary = includeAttemptNode(attempt, checkpoint, childDepth);
        if (!attemptSummary) {
          truncation.omittedEdges += 1;
          continue;
        }
        const edgeId = `checkpoint-fork-attempt:${checkpoint.checkpointId}:${attempt.childRunId}`;
        const boundary = isRecord(attemptSummary.boundary) ? attemptSummary.boundary : {};
        edges.set(edgeId, {
          id: edgeId,
          kind: "checkpoint-fork-attempt",
          fromCheckpointId: checkpoint.checkpointId,
          toRunId: attempt.childRunId,
          ok: boundary.ok === true,
          boundaryStatus: typeof boundary.status === "string" ? boundary.status : "unknown"
        });
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
  const attemptList = [...attemptNodes.values()].sort(branchNodeSort);
  const edgeList = [...edges.values()].sort((a, b) => branchNodeId(a).localeCompare(branchNodeId(b)));
  const lineageOk = matchList.every((node) => {
    if (!isRecord(node) || !isRecord(node.lineage)) return true;
    return node.lineage.ok === true;
  });
  const attemptLineageOk = attemptList.every((node) => isRecord(node) && isRecord(node.boundary) && node.boundary.ok === true);
  const maxDepth = [...checkpointList, ...matchList, ...attemptList].reduce(
    (max, node) => Math.max(max, checkpointNodeDepth(node) ?? 0),
    0
  );
  return {
    kind: "checkpoint-branch-tree",
    schemaVersion: "server.checkpoint-branch-tree-summary.v3",
    ok: lineageOk && attemptLineageOk,
    okScope: "returned",
    rootCheckpointId: rootCheckpoint.checkpointId,
    root: serializeCheckpointSummary(rootCheckpoint),
    counts: {
      checkpoints: checkpointList.length,
      matches: matchList.length,
      attempts: attemptList.length,
      failedAttempts: attemptList.filter((node) => isRecord(node) && node.status === "failed").length,
      runningAttempts: attemptList.filter((node) => isRecord(node) && node.status === "running").length,
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
      omittedAttempts: truncation.omittedAttempts,
      omittedEdges: truncation.omittedEdges
    },
    checkpoints: checkpointList,
    matches: matchList,
    attempts: attemptList,
    edges: edgeList
  };
}

function buildForkChildSummary(artifact: MatchArtifact, checkpoint: HarnessCheckpoint): Record<string, unknown> {
  const lineage = buildForkLineageSummary(artifact, checkpoint);
  const stepCounts = countSocialStepCommits(artifact.socialEpisode.steps);
  return {
    runId: artifact.runId,
    matchId: artifact.matchId ?? null,
    createdAt: artifact.createdAt,
    status: artifact.status,
    truncationReason: artifact.truncationReason ?? null,
    failureReason: artifact.failureReason ? sanitizeApiErrorText(artifact.failureReason) : null,
    nativeStepCount: stepCounts.nativeSteps,
    committedSteps: stepCounts.committedSteps,
    rejectedSteps: stepCounts.rejectedSteps,
    legacyProjectionSteps: artifact.trajectory.length,
    socialMessages: artifact.socialEpisode.messages.length,
    forkOf: artifact.forkOf ? summarizeForkProvenance(artifact.forkOf) : null,
    lineage
  };
}

function buildCheckpointForkAttemptSummary(
  attempt: StoredCheckpointForkAttempt,
  checkpoint?: HarnessCheckpoint
): Record<string, unknown> {
  const checkpointSourceMatchesForkOf = checkpoint
    ? checkpointSourceMatchesForkProvenance(checkpoint, attempt.forkOf)
    : null;
  return {
    kind: "checkpoint-fork-attempt",
    schemaVersion: attempt.schemaVersion,
    runId: attempt.childRunId,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    status: attempt.status,
    hasArtifact: false,
    forkOf: summarizeForkProvenance(attempt.forkOf),
    limits: {
      maxTransitions: attempt.limits.maxTransitions,
      timeoutMs: attempt.limits.timeoutMs
    },
    elapsedMs: attempt.elapsedMs ?? null,
    timedOut: attempt.timedOut ?? null,
    failureCode: attempt.failureCode ?? null,
    failureReason: attempt.failureReason ? sanitizeApiErrorText(attempt.failureReason) : null,
    providerFailure: attempt.providerFailure ?? null,
    boundary: {
      status: attempt.status === "failed" ? "fork_attempt_failed_before_artifact" : "fork_attempt_running_before_artifact",
      ok: false,
      provenanceOk: checkpointSourceMatchesForkOf === true,
      checkpointFound: Boolean(checkpoint),
      checkpointSourceMatchesForkOf
    }
  };
}

function buildCheckpointForkAttemptLineageSummary(
  attempt: StoredCheckpointForkAttempt,
  checkpoint?: HarnessCheckpoint
): object {
  const summary = buildCheckpointForkAttemptSummary(attempt, checkpoint);
  const boundary = isRecord(summary.boundary) ? summary.boundary : {};
  return {
    kind: "fork-lineage",
    schemaVersion: "server.fork-lineage-summary.v3",
    ok: boundary.ok === true,
    isFork: true,
    artifactAvailable: false,
    runId: attempt.childRunId,
    matchId: attempt.childRunId,
    forkOf: summary.forkOf,
    parent: {
      checkpointId: attempt.forkOf.checkpointId,
      runId: attempt.forkOf.parentRunId ?? null,
      matchId: attempt.forkOf.parentMatchId ?? null,
      checkpointFound: Boolean(checkpoint)
    },
    child: {
      runId: attempt.childRunId,
      matchId: attempt.childRunId,
      status: attempt.status,
      artifactAvailable: false,
      failureReason: summary.failureReason
    },
    boundary
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
  const firstStep = artifact.socialEpisode.steps[0];
  const finalStep = artifact.socialEpisode.steps.at(-1);
  const lastMessage = artifact.socialEpisode.messages.at(-1);
  const stepCounts = countSocialStepCommits(artifact.socialEpisode.steps);
  const childSummary = {
    runId: artifact.runId,
    matchId: artifact.matchId ?? null,
    createdAt: artifact.createdAt,
    status: artifact.status,
    truncationReason: artifact.truncationReason ?? null,
    failureReason: artifact.failureReason ? sanitizeApiErrorText(artifact.failureReason) : null,
    nativeStepCount: stepCounts.nativeSteps,
    committedSteps: stepCounts.committedSteps,
    rejectedSteps: stepCounts.rejectedSteps,
    legacyProjectionSteps: artifact.trajectory.length,
    socialMessages: artifact.socialEpisode.messages.length,
    firstStepPreStateHash: firstStep?.preStateHash ?? null,
    finalStepPostStateHash: finalStep?.postStateHash ?? null,
    finalStateHash: hashStableState(artifact.finalState),
    firstNewMessageSeq: checkpoint ? artifact.socialEpisode.messages[checkpoint.executionPrefix.messages.length]?.seq ?? null : null,
    lastMessageSeq: lastMessage?.seq ?? null
  };

  if (!forkOf) {
    return {
      kind: "fork-lineage",
      schemaVersion: "server.fork-lineage-summary.v2",
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
        newNativeSteps: stepCounts.nativeSteps,
        newCommittedSteps: stepCounts.committedSteps,
        newRejectedSteps: stepCounts.rejectedSteps,
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
  const newSocialMessages = checkpoint ? artifact.socialEpisode.messages.length - checkpoint.executionPrefix.messages.length : null;

  return {
    kind: "fork-lineage",
    schemaVersion: "server.fork-lineage-summary.v2",
    ok: boundaryStatus !== "mismatch",
    isFork: true,
    runId: artifact.runId,
    matchId: artifact.matchId ?? null,
    forkOf: summarizeForkProvenance(forkOf),
    parent: {
      checkpointId: forkOf.checkpointId,
      runId: forkOf.parentRunId ?? null,
      matchId: forkOf.parentMatchId ?? null,
      boundaryTraceRef: forkOf.parentBoundaryTraceId
        ? hashStableState({ traceId: forkOf.parentBoundaryTraceId }).slice(0, 16)
        : null,
      boundaryTurnIndex: forkOf.parentBoundaryTurnIndex ?? null,
      nativeStepCount: forkOf.parentNativeStepCount,
      messageCount: forkOf.parentMessageCount,
      lastMessageSeq: checkpoint?.source.lastMessageSeq ?? null,
      stateHash: forkOf.parentStateHash,
      executionPrefixHash: forkOf.parentExecutionPrefixHash,
      agentsHash: forkOf.parentAgentsHash,
      channelsHash: forkOf.parentChannelsHash,
      messagesHash: forkOf.parentMessagesHash,
      checkpointFound: Boolean(checkpoint)
    },
    child: childSummary,
    boundary: {
      status: boundaryStatus,
      checkpointFound: Boolean(checkpoint),
      stateHashMatches,
      checkpointSourceMatchesForkOf,
      messagePrefixMatchesCheckpoint,
      newNativeSteps: stepCounts.nativeSteps,
      newCommittedSteps: stepCounts.committedSteps,
      newRejectedSteps: stepCounts.rejectedSteps,
      newSocialMessages
    }
  };
}

function checkpointSourceMatchesForkProvenance(checkpoint: HarnessCheckpoint, forkOf: HarnessForkProvenance): boolean {
  return (
    checkpoint.checkpointId === forkOf.checkpointId &&
    checkpoint.source.runId === forkOf.parentRunId &&
    (checkpoint.source.matchId ?? null) === (forkOf.parentMatchId ?? null) &&
    checkpoint.source.rulesetId === forkOf.parentRulesetId &&
    (checkpoint.source.boundaryTraceId ?? null) === (forkOf.parentBoundaryTraceId ?? null) &&
    (checkpoint.source.boundaryTurnIndex ?? null) === (forkOf.parentBoundaryTurnIndex ?? null) &&
    checkpoint.source.stateHash === forkOf.parentStateHash &&
    checkpoint.source.executionPrefixHash === forkOf.parentExecutionPrefixHash &&
    checkpoint.source.agentsHash === forkOf.parentAgentsHash &&
    checkpoint.source.channelsHash === forkOf.parentChannelsHash &&
    checkpoint.source.messagesHash === forkOf.parentMessagesHash &&
    checkpoint.source.nativeStepCount === forkOf.parentNativeStepCount &&
    checkpoint.source.messageCount === forkOf.parentMessageCount
  );
}

function socialMessagePrefixMatchesCheckpoint(artifact: MatchArtifact, checkpoint: HarnessCheckpoint): boolean {
  if (artifact.socialEpisode.messages.length < checkpoint.executionPrefix.messages.length) return false;
  const prefix = artifact.socialEpisode.messages.slice(0, checkpoint.executionPrefix.messages.length);
  return hashStableState(prefix) === checkpoint.source.messagesHash;
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
  await loadCheckpointForkAttemptStore(checkpointArtifactBaseDir);
  await loadComparisonArtifactIndex(comparisonArtifactBaseDir);
}

async function persistMatchArtifact(artifact: MatchArtifact, baseDir: string | undefined): Promise<void> {
  assertValidMatchArtifactIntegrity(artifact);
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  const file = matchArtifactAbsoluteFile(root, matchArtifactId(artifact));
  await ensureWritableArtifactSubdirectory(root, matchArtifactDirectory(root), "Match artifact directory is not safe.");
  // Overwrite is intentional for deterministic tournament episode ids so a re-export
  // under the same seed/episode replaces the prior match store entry.
  await atomicReplaceUtf8(
    file,
    `${JSON.stringify(sanitizePersistedProviderDiagnostics(redactSecrets(artifact)), null, 2)}\n`
  );
}

async function loadMatchArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  matchArtifactStoreLoad ??= recoverMatchArtifactIndex(baseDir).catch((error) => {
    matchArtifactStoreLoad = undefined;
    throw error;
  });
  await matchArtifactStoreLoad;
}

async function recoverMatchArtifactIndex(baseDir: string): Promise<void> {
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
    if (!isPersistedMatchArtifactId(id)) continue;
    const artifact = await matchArtifactFromFile(root, id, matchArtifactRelativeFile(id));
    if (!artifact) continue;
    const stepCounts = countSocialStepCommits(artifact.socialEpisode.steps);
    matches.push({
      matchId: matchArtifactId(artifact),
      runId: artifact.runId,
      createdAt: artifact.createdAt,
      seed: artifact.seed,
      status: artifact.status,
      stateHash: hashStableState(artifact.finalState),
      trajectoryHash: hashStableState(artifact.trajectory),
      agentCount: artifact.agents.length,
      nativeSteps: stepCounts.nativeSteps,
      committedSteps: stepCounts.committedSteps,
      rejectedSteps: stepCounts.rejectedSteps,
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
  await atomicReplaceUtf8(matchArtifactIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`);
}

async function atomicReplaceUtf8(target: string, contents: string): Promise<void> {
  try {
    const current = await lstat(target);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new HttpError(500, "Artifact publication target is not a safe regular file.");
    }
  } catch (error) {
    if (!isFileReadNotFound(error)) throw error;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
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
    if (!isPersistedMatchArtifactId(matchId)) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "match",
        source: "directory",
        code: "file_name_rejected",
        relativeFile: `${MATCH_ARTIFACT_DIR}/${entry.name}`,
        message: "Match artifact file name was not a server-owned match artifact id."
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
    if (!isPersistedMatchArtifactId(matchId)) return { ok: false, code: "file_identity_mismatch" };
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
    status: artifact.status,
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
  if (!isPersistedMatchArtifactId(matchId)) throw new HttpError(500, "server-owned match artifact id is invalid");
  return `${MATCH_ARTIFACT_DIR}/${matchId}.json`;
}

function isPersistedMatchArtifactId(matchId: string): boolean {
  if (!matchId || matchId.length > 160) return false;
  if (matchId.includes("..") || matchId.startsWith(".") || matchId.endsWith(".")) return false;
  if (GENERATED_ARTIFACT_SET_ID_PATTERN.test(matchId)) return true;
  // Tournament episode ids such as tournament-<seed>-N and other safe stems.
  return PERSISTED_MATCH_ARTIFACT_ID_PATTERN.test(matchId);
}

function matchArtifactId(artifact: MatchArtifact): string {
  return artifact.matchId ?? artifact.runId;
}

async function persistCheckpointArtifact(checkpoint: HarnessCheckpoint, baseDir: string | undefined): Promise<void> {
  assertValidHarnessCheckpoint(checkpoint);
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  const file = checkpointArtifactAbsoluteFile(root, checkpoint.checkpointId);
  await ensureWritableArtifactSubdirectory(root, checkpointArtifactDirectory(root), "Checkpoint artifact directory is not safe.");
  await writeFile(file, `${JSON.stringify(sanitizePersistedProviderDiagnostics(redactSecrets(checkpoint)), null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
}

async function loadCheckpointForkAttemptStore(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  let parsed: unknown;
  try {
    const target = checkpointForkAttemptPath(root);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new HttpError(500, "Checkpoint fork-attempt store is not a safe regular file.");
    }
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (isFileReadNotFound(error)) return;
    throw new HttpError(500, "Checkpoint fork-attempt store could not be read.");
  }
  if (
    !isRecord(parsed) ||
    parsed.artifactVersion !== "server.checkpoint-fork-attempt-store.v1" ||
    parsed.kind !== "checkpoint-fork-attempt-store" ||
    !Array.isArray(parsed.attempts)
  ) {
    throw new HttpError(500, "Checkpoint fork-attempt store has invalid shape.");
  }
  let rewriteAttemptStore = false;
  for (const value of parsed.attempts) {
    const parsedAttempt = parseStoredCheckpointForkAttempt(value);
    if (!parsedAttempt) throw new HttpError(500, "Checkpoint fork-attempt store contains an invalid record.");
    const checkpoint = getCheckpoint(parsedAttempt.forkOf.checkpointId);
    if (!checkpoint || !checkpointSourceMatchesForkProvenance(checkpoint, parsedAttempt.forkOf)) {
      throw new HttpError(500, "Checkpoint fork-attempt store contains inconsistent provenance.");
    }
    const activeAttempt = listCheckpointForkAttempts().find(
      (candidate) => candidate.childRunId === parsedAttempt.childRunId && candidate.status === "running"
    );
    const artifact = getMatch(parsedAttempt.childRunId)?.artifact;
    if (artifact) {
      deleteCheckpointForkAttempt(parsedAttempt.childRunId);
      rewriteAttemptStore = true;
      continue;
    }
    const attempt =
      parsedAttempt.status === "running" && !activeAttempt && !artifact
        ? {
            ...parsedAttempt,
            updatedAt: new Date().toISOString(),
            status: "failed" as const,
            elapsedMs: Math.max(0, Date.now() - Date.parse(parsedAttempt.createdAt)),
            timedOut: false,
            failureCode: "checkpoint_fork_interrupted",
            failureReason: "Checkpoint fork execution was interrupted before an artifact was recorded.",
            providerFailure: null
          }
        : parsedAttempt;
    if (attempt !== parsedAttempt) rewriteAttemptStore = true;
    saveCheckpointForkAttempt(attempt);
  }
  if (rewriteAttemptStore) await writeCheckpointForkAttemptStore(baseDir);
}

async function writeCheckpointForkAttemptStore(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const write = async () => {
    const root = path.resolve(baseDir);
    await mkdir(root, { recursive: true });
    const target = checkpointForkAttemptPath(root);
    await assertWritableRegularFileTarget(target, "Checkpoint fork-attempt store is not a safe regular file.");
    const temporary = path.join(root, `.checkpoint-fork-attempts-${randomUUID()}.tmp`);
    const store = {
      artifactVersion: "server.checkpoint-fork-attempt-store.v1",
      kind: "checkpoint-fork-attempt-store",
      updatedAt: new Date().toISOString(),
      attempts: listCheckpointForkAttempts()
    };
    try {
      await writeFile(temporary, `${JSON.stringify(redactSecrets(store), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  const pending = checkpointForkAttemptWriteQueue.then(write, write);
  checkpointForkAttemptWriteQueue = pending.then(
    () => undefined,
    () => undefined
  );
  await pending;
}

async function assertWritableRegularFileTarget(target: string, message: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(500, message);
  } catch (error) {
    if (isFileReadNotFound(error)) return;
    throw error;
  }
}

function parseStoredCheckpointForkAttempt(value: unknown): StoredCheckpointForkAttempt | null {
  if (!isRecord(value)) return null;
  const allowedFields = new Set([
    "schemaVersion",
    "childRunId",
    "createdAt",
    "updatedAt",
    "status",
    "forkOf",
    "limits",
    "elapsedMs",
    "timedOut",
    "failureCode",
    "failureReason",
    "providerFailure"
  ]);
  if (Object.keys(value).some((key) => !allowedFields.has(key))) return null;
  if (value.schemaVersion !== "server.checkpoint-fork-attempt.v1") return null;
  const childRunId = stringField(value, "childRunId");
  const createdAt = stringField(value, "createdAt");
  const updatedAt = stringField(value, "updatedAt");
  if (!childRunId || !createdAt || !updatedAt) return null;
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(childRunId)) return null;
  if (!isSafeIsoTimestamp(createdAt) || !isSafeIsoTimestamp(updatedAt) || Date.parse(updatedAt) < Date.parse(createdAt)) return null;
  if (value.status !== "running" && value.status !== "failed") return null;
  if (!isRecord(value.forkOf) || validateGenericForkProvenance(value.forkOf).length > 0) return null;
  const allowedForkFields = new Set([
    "schemaVersion",
    "checkpointArtifactVersion",
    "checkpointId",
    "parentRunId",
    "parentArtifactId",
    "parentMatchId",
    "parentBoundaryTraceId",
    "parentEvidenceTraceIds",
    "parentBoundaryTurnIndex",
    "parentStateHash",
    "parentExecutionPrefixHash",
    "parentAgentsHash",
    "parentChannelsHash",
    "parentMessagesHash",
    "parentNativeStepCount",
    "parentMessageCount",
    "parentDomainAdapter",
    "parentRulesetId",
    "experimentLineage",
    "createdAt",
    "reason"
  ]);
  if (Object.keys(value.forkOf).some((key) => !allowedForkFields.has(key))) return null;
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(stringField(value.forkOf, "checkpointId") ?? "")) return null;
  if (typeof value.forkOf.parentRulesetId !== "string" || !value.forkOf.parentRulesetId.trim()) return null;
  if (value.forkOf.parentMatchId !== undefined && (typeof value.forkOf.parentMatchId !== "string" || !value.forkOf.parentMatchId.trim())) {
    return null;
  }
  if (value.forkOf.createdAt !== createdAt) return null;
  if (typeof value.forkOf.reason === "string" && value.forkOf.reason.length > 256) return null;
  if (!isRecord(value.limits)) return null;
  if (Object.keys(value.limits).some((key) => key !== "maxTransitions" && key !== "timeoutMs")) return null;
  const maxTransitions = value.limits.maxTransitions;
  const timeoutMs = value.limits.timeoutMs;
  if (maxTransitions !== null && (typeof maxTransitions !== "number" || !Number.isInteger(maxTransitions) || maxTransitions <= 0)) return null;
  if (timeoutMs !== null && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) return null;
  for (const field of ["failureCode", "failureReason"] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || !value[field].trim() || value[field].length > (field === "failureCode" ? 128 : 512))
    ) {
      return null;
    }
  }
  if (value.elapsedMs !== undefined && (typeof value.elapsedMs !== "number" || !Number.isInteger(value.elapsedMs) || value.elapsedMs < 0)) {
    return null;
  }
  if (value.timedOut !== undefined && typeof value.timedOut !== "boolean") return null;
  let providerFailure: PublicProviderFailureSummary | null | undefined;
  if (value.providerFailure !== undefined && value.providerFailure !== null) {
    if (!isRecord(value.providerFailure)) return null;
    const providerRecord = value.providerFailure;
    const allowedProviderFields = new Set([
      "failureKind",
      "providerStage",
      "status",
      "timeoutMs",
      "aborted",
      "retryable",
      "attempts",
      "maxAttempts"
    ]);
    if (Object.keys(providerRecord).some((key) => !allowedProviderFields.has(key))) return null;
    if (
      typeof providerRecord.failureKind !== "string" ||
      !isProviderFailureKind(providerRecord.failureKind) ||
      (providerRecord.providerStage !== undefined &&
        (typeof providerRecord.providerStage !== "string" ||
          ![
            "before_start",
            "during_request",
            "during_stream",
            "during_retry_delay",
            "http_response",
            "stream_start",
            "stream_parse",
            "stream_finish",
            "non_stream_parse"
          ].includes(providerRecord.providerStage))) ||
      ["status", "timeoutMs", "attempts", "maxAttempts"].some(
        (field) =>
          providerRecord[field] !== undefined &&
          (typeof providerRecord[field] !== "number" ||
            !Number.isInteger(providerRecord[field]) ||
            providerRecord[field] < 0)
      ) ||
      ["aborted", "retryable"].some(
        (field) => providerRecord[field] !== undefined && typeof providerRecord[field] !== "boolean"
      )
    ) {
      return null;
    }
    providerFailure = publicProviderFailureFromUnknown(providerRecord);
    if (!providerFailure) return null;
  } else if (value.providerFailure === null) {
    providerFailure = null;
  }
  if (
    value.status === "failed" &&
    (typeof value.failureReason !== "string" || typeof value.failureCode !== "string" || typeof value.elapsedMs !== "number" || typeof value.timedOut !== "boolean")
  ) {
    return null;
  }
  if (
    value.status === "running" &&
    (value.elapsedMs !== undefined ||
      value.timedOut !== undefined ||
      value.failureCode !== undefined ||
      value.failureReason !== undefined ||
      value.providerFailure !== undefined)
  ) {
    return null;
  }
  return {
    ...(value as unknown as StoredCheckpointForkAttempt),
    ...(providerFailure === undefined ? {} : { providerFailure })
  };
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
    if (
      !isRecord(parsed) ||
      parsed.artifactVersion !== "harness.checkpoint-artifact-index.v2" ||
      parsed.kind !== "checkpoint-artifact-index" ||
      !Array.isArray(parsed.checkpoints)
    ) {
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
      rulesetId: persisted.source.rulesetId,
      stateHash: persisted.source.stateHash,
      executionPrefixHash: persisted.source.executionPrefixHash,
      agentsHash: persisted.source.agentsHash,
      channelsHash: persisted.source.channelsHash,
      messagesHash: persisted.source.messagesHash,
      relativeFile: checkpointArtifactRelativeFile(persisted.checkpointId)
    });
  }
  const index = {
    artifactVersion: "harness.checkpoint-artifact-index.v2",
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

function checkpointForkAttemptPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), CHECKPOINT_FORK_ATTEMPT_FILE);
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

async function persistComparisonArtifact(
  comparison: MatchComparisonArtifact,
  baseDir: string | undefined
): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  const file = comparisonArtifactAbsoluteFile(root, comparison.comparisonId);
  await ensureWritableArtifactSubdirectory(
    root,
    comparisonArtifactDirectory(root),
    "Comparison artifact directory is not safe."
  );
  // Overwrite is intentional for deterministic comparison ids so recompute
  // under the same baseline/candidate/view replaces the prior registry entry.
  await writeFile(file, `${JSON.stringify(redactSecrets(comparison), null, 2)}\n`, {
    encoding: "utf8"
  });
}

async function loadComparisonArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  let parsed: unknown;
  let shouldRewriteIndex = false;
  const loadedIds = new Set<string>();
  let indexExists = true;
  try {
    parsed = JSON.parse(await readFile(comparisonArtifactIndexPath(root), "utf8"));
  } catch (error) {
    if (isFileReadNotFound(error)) {
      indexExists = false;
    } else if (error instanceof SyntaxError) {
      indexExists = false;
      shouldRewriteIndex = true;
    } else {
      throw new HttpError(500, "Comparison artifact index could not be read.");
    }
  }

  if (indexExists) {
    if (
      !isRecord(parsed) ||
      parsed.artifactVersion !== "harness.comparison-artifact-index.v1" ||
      parsed.kind !== "comparison-artifact-index" ||
      !Array.isArray(parsed.comparisons)
    ) {
      shouldRewriteIndex = true;
    } else {
      for (const record of parsed.comparisons) {
        const comparison = await comparisonFromIndexRecord(root, record);
        if (comparison) {
          saveComparison(comparison);
          loadedIds.add(comparison.comparisonId);
        } else {
          shouldRewriteIndex = true;
        }
      }
    }
  }

  const scannedIds = await loadComparisonArtifactsFromDirectory(root, loadedIds);
  if (scannedIds.length > 0 || shouldRewriteIndex || !indexExists) {
    await writeComparisonArtifactIndex(root);
  }
}

async function writeComparisonArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await mkdir(comparisonArtifactDirectory(root), { recursive: true });
  const comparisons = [];
  for (const comparison of listComparisons()) {
    const relativeFile = comparisonArtifactRelativeFile(comparison.comparisonId);
    const absolute = comparisonArtifactAbsoluteFile(root, comparison.comparisonId);
    try {
      await lstat(absolute);
    } catch {
      // Skip registry entries that no longer have files.
      continue;
    }
    comparisons.push({
      comparisonId: comparison.comparisonId,
      createdAt: comparison.createdAt,
      view: comparison.view,
      baselineRunId: comparison.baseline.runId,
      baselineMatchId: comparison.baseline.matchId ?? null,
      candidateRunId: comparison.candidate.runId,
      candidateMatchId: comparison.candidate.matchId ?? null,
      baselineHash: comparison.summary.baselineHash,
      candidateHash: comparison.summary.candidateHash,
      rowCount: comparison.summary.rowCount,
      changedRowCount: comparison.summary.changedRowCount,
      relativeFile
    });
  }
  const index = {
    artifactVersion: "harness.comparison-artifact-index.v1",
    kind: "comparison-artifact-index",
    updatedAt: new Date().toISOString(),
    comparisons
  };
  await writeFile(comparisonArtifactIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

async function comparisonFromIndexRecord(
  baseDir: string,
  value: unknown
): Promise<MatchComparisonArtifact | null> {
  try {
    if (!isRecord(value)) return null;
    const comparisonId = stringField(value, "comparisonId");
    const relativeFile = stringField(value, "relativeFile");
    if (!comparisonId || !relativeFile) return null;
    if (relativeFile !== comparisonArtifactRelativeFile(comparisonId)) return null;
    return comparisonArtifactFromFile(baseDir, comparisonId, relativeFile);
  } catch {
    return null;
  }
}

async function loadComparisonArtifactsFromDirectory(
  baseDir: string,
  skipIds: Set<string>
): Promise<string[]> {
  const dir = comparisonArtifactDirectory(baseDir);
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isFileReadNotFound(error)) return [];
    throw new HttpError(500, "Comparison artifact directory could not be read.");
  }
  const loadedIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fileStem = entry.name.slice(0, -".json".length);
    const comparisonId = `match-comparison:${fileStem}`;
    if (skipIds.has(comparisonId)) continue;
    const comparison = await comparisonArtifactFromFile(
      baseDir,
      comparisonId,
      comparisonArtifactRelativeFile(comparisonId)
    );
    if (!comparison) continue;
    saveComparison(comparison);
    skipIds.add(comparison.comparisonId);
    loadedIds.push(comparison.comparisonId);
  }
  return loadedIds;
}

async function comparisonArtifactFromFile(
  baseDir: string,
  comparisonId: string,
  relativeFile: string
): Promise<MatchComparisonArtifact | null> {
  try {
    const absolute = resolveUnderDirectory(baseDir, relativeFile);
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    const real = await realpath(absolute);
    const rootReal = await realpath(path.resolve(baseDir));
    if (!real.startsWith(rootReal + path.sep) && real !== rootReal) return null;
    const parsed: unknown = JSON.parse(await readFile(absolute, "utf8"));
    if (!isRecord(parsed)) return null;
    if (parsed.artifactVersion !== MATCH_COMPARISON_ARTIFACT_VERSION || parsed.kind !== "match-comparison") {
      return null;
    }
    const parsedId = stringField(parsed, "comparisonId");
    if (!parsedId || parsedId !== comparisonId) return null;
    // Store path revalidates required comparison identity fields.
    const candidate = parsed as unknown as MatchComparisonArtifact;
    saveComparison(candidate);
    return getComparison(comparisonId) ?? null;
  } catch {
    return null;
  }
}
function comparisonArtifactIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), COMPARISON_ARTIFACT_INDEX_FILE);
}

function comparisonArtifactDirectory(baseDir: string): string {
  return resolveUnderDirectory(baseDir, COMPARISON_ARTIFACT_DIR);
}

function comparisonArtifactAbsoluteFile(baseDir: string, comparisonId: string): string {
  return resolveUnderDirectory(baseDir, comparisonArtifactRelativeFile(comparisonId));
}

function comparisonArtifactRelativeFile(comparisonId: string): string {
  const prefix = "match-comparison:";
  if (!comparisonId.startsWith(prefix)) {
    throw new HttpError(500, "comparison artifact id is invalid");
  }
  const stem = comparisonId.slice(prefix.length);
  if (!/^[a-f0-9]{24}$/i.test(stem)) {
    throw new HttpError(500, "comparison artifact id is invalid");
  }
  return `${COMPARISON_ARTIFACT_DIR}/${stem}.json`;
}


function serializeStoredMatch(match: StoredMatch): object {
  const steps = match.socialEpisode?.steps ?? match.artifact?.socialEpisode.steps ?? [];
  const { nativeSteps, committedSteps, rejectedSteps } = countSocialStepCommits(steps);
  const legacyProjectionSteps = match.trajectory?.length ?? match.artifact?.trajectory.length ?? 0;
  const failure = publicStoredMatchFailure(match);
  return {
    id: match.id,
    createdAt: match.createdAt,
    state: serializePublicState(match.state),
    models: match.models,
    status: match.status,
    harnessStatus: match.artifact?.status ?? null,
    truncationReason: match.artifact?.truncationReason ?? null,
    error: failure?.message,
    ...(failure?.providerFailure ? { providerFailure: failure.providerFailure } : {}),
    hasArtifact: Boolean(match.artifact),
    checkpointCount: countCheckpointsForMatch(match.id),
    profileCount: match.profiles?.length ?? 0,
    /** Native socialEpisode.steps length; authoritative execution progress. */
    nativeSteps,
    /** Native steps with commitStatus committed (or legacy no-error). */
    committedSteps,
    /** Native steps that are rejected/failed and not part of committed replay. */
    rejectedSteps,
    /** Legacy committed-command projection length; not native authority. */
    trajectorySteps: legacyProjectionSteps,
    legacyProjectionSteps
  };
}

function serializeLiveMatchStart(matchId: string): LiveMatchStartResponse {
  return {
    artifactVersion: "server.match-live-start.v1",
    kind: "match-live-start",
    matchId,
    lifecycle: "running",
    artifactAvailable: false,
    projection: {
      view: "live-public",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: true
    }
  };
}

/**
 * A finished artifact can retain raw failure evidence for deterministic audit
 * and explicit local debugging. Match list/detail responses are cockpit
 * summaries, though, so never relay that raw error text as their `error`.
 */
function publicStoredMatchFailure(match: StoredMatch): PublicApiFailure | undefined {
  if (!match.artifact) {
    return match.error ? { message: sanitizeApiErrorText(match.error) } : undefined;
  }

  const providerFailure = harnessFailureEvidenceFromEpisode(match.artifact.socialEpisode)
    .map((evidence) => evidence.payload?.providerFailure)
    .find((candidate): candidate is ProviderFailureSummary => candidate !== undefined);
  if (providerFailure) {
    const safeProviderFailure = publicProviderFailureSummary(providerFailure);
    return {
      message: providerFailureApiMessage(safeProviderFailure),
      providerFailure: safeProviderFailure
    };
  }

  if (match.artifact.status === "failed" || match.artifact.failureReason || match.error) {
    return {
      message: "Harness execution failed. Inspect the redacted artifact for structured failure-stage evidence."
    };
  }
  return undefined;
}

function artifactViewFromQuery(
  query: unknown,
  request: express.Request,
  artifactAccessBindHost: string
): MatchArtifactView {
  const record = isRecord(query) ? query : {};
  const view = optionalSingleQueryString(record, "view");
  // `postgame-redacted` is a local research projection: it retains final
  // roles, teams, and night truth while removing private cognition evidence.
  // A remotely reachable default must therefore degrade to the strict public
  // projection rather than silently treating an omitted query as research
  // authorization. Cockpit requests against the default loopback server keep
  // their existing postgame-review default.
  if (view === undefined) {
    return hasLocalResearchArtifactAccess(request, artifactAccessBindHost) ? "postgame-redacted" : "truth-redacted";
  }
  if (view === "full") {
    assertLocalFullArtifactAccess(request, artifactAccessBindHost);
    return "full";
  }
  if (view === "postgame-redacted") {
    assertLocalPostgameArtifactAccess(request, artifactAccessBindHost);
    return "postgame-redacted";
  }
  if (view === "truth-redacted") return "truth-redacted";
  throw new HttpError(400, `Unsupported artifact view: ${view}`);
}

function checkpointArtifactViewFromQuery(
  query: unknown,
  request: express.Request,
  artifactAccessBindHost: string
): MatchArtifactView {
  const record = isRecord(query) ? query : {};
  if (optionalSingleQueryString(record, "view") === undefined) return "truth-redacted";
  return artifactViewFromQuery(query, request, artifactAccessBindHost);
}

function assertLocalFullArtifactAccess(request: express.Request, artifactAccessBindHost: string): void {
  if (isLoopbackBindHost(artifactAccessBindHost) && isLoopbackAddress(request.socket.remoteAddress)) return;
  throw new HttpError(
    403,
    "Full artifact view is available only through a loopback-only local debug server.",
    "full_artifact_view_local_only"
  );
}

function assertLocalResearchArtifactAccess(request: express.Request, artifactAccessBindHost: string): void {
  if (hasLocalResearchArtifactAccess(request, artifactAccessBindHost)) return;
  throw new HttpError(
    403,
    "Tournament research artifacts are available only through a loopback-only local debug server.",
    "tournament_research_artifacts_local_only"
  );
}

/**
 * `/api/matches` is the local research operator registry. Its summaries
 * intentionally include model/profile and execution-progress metadata, so a
 * remotely reachable spectator must use the strict `/live` route instead.
 */
function assertLocalOperatorRegistryAccess(request: express.Request, artifactAccessBindHost: string): void {
  if (hasLocalResearchArtifactAccess(request, artifactAccessBindHost)) return;
  throw new HttpError(
    403,
    "Match registry access is available only through a loopback-only local operator server.",
    "operator_match_registry_local_only"
  );
}

function hasLocalResearchArtifactAccess(request: express.Request, artifactAccessBindHost: string): boolean {
  return isLoopbackBindHost(artifactAccessBindHost) && isLoopbackAddress(request.socket.remoteAddress);
}

function assertLocalPostgameArtifactAccess(request: express.Request, artifactAccessBindHost: string): void {
  if (hasLocalResearchArtifactAccess(request, artifactAccessBindHost)) return;
  throw new HttpError(
    403,
    "Postgame-redacted artifact views are available only through a loopback-only local research server.",
    "postgame_artifact_view_local_only"
  );
}

/**
 * Native replay is more sensitive than a truth-redacted match projection:
 * exact scheduler progress, batch density, and deterministic hashes can leak
 * hidden role/action cadence. Keep both replay endpoints local even when the
 * normal match list and truth-redacted artifact APIs are externally served.
 */
function assertLocalPostgameReplayAccess(request: express.Request, artifactAccessBindHost: string): void {
  if (hasLocalResearchArtifactAccess(request, artifactAccessBindHost)) return;
  throw new HttpError(
    403,
    "Native replay review is available only through a loopback-only local research server.",
    "postgame_replay_local_only"
  );
}

function isLoopbackBindHost(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function setArtifactProjectionResponseHeaders(res: express.Response, view: MatchArtifactView): void {
  // Even the redacted research projection may contain postgame truth. Do not
  // leave any artifact projection in browser or intermediary caches.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (view === "full") res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
}

/**
 * The comparison registry is a discoverable API surface. Safe projections can
 * be listed together because truth-redacted is strictly narrower than the
 * default postgame-redacted research view; full/debug records require an
 * explicit view=full request and are never newly persisted by this server.
 */
function comparisonIsVisibleInRegistry(comparison: MatchComparisonArtifact, requestedView: MatchComparisonView): boolean {
  if (requestedView === "full") return true;
  if (comparison.view === "full") return false;
  if (requestedView === "truth-redacted") return comparison.view === "truth-redacted";
  return true;
}

function downloadRequested(query: unknown): boolean {
  const record = isRecord(query) ? query : {};
  const raw = optionalSingleQueryString(record, "download");
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "download";
}

function comparisonFormatFromQuery(query: unknown): "json" | "markdown" {
  const record = isRecord(query) ? query : {};
  const raw = optionalSingleQueryString(record, "format");
  if (raw === undefined || raw === "json") return "json";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "markdown" || normalized === "md") return "markdown";
  throw new HttpError(400, 'format must be "json" or "markdown"');
}



function filteredComparisonRequested(
  query: unknown,
  filter: Required<MatchComparisonRowFilter>
): boolean {
  const record = isRecord(query) ? query : {};
  const raw = optionalSingleQueryString(record, "filtered");
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "filtered") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no") {
      return false;
    }
    throw new HttpError(400, 'filtered must be "1", "true", "yes", "0", "false", or "no"');
  }
  return (
    filter.group !== "all" ||
    filter.changedOnly ||
    filter.promotion !== "all" ||
    filter.evidenceIdentity !== "all" ||
    filter.numericDelta !== "all"
  );
}

function comparisonRowFilterFromQuery(query: unknown): Required<MatchComparisonRowFilter> {
  const record = isRecord(query) ? query : {};
  return {
    group: comparisonGroupFilterFromQuery(record),
    changedOnly: comparisonChangedOnlyFromQuery(record),
    promotion: comparisonPromotionFilterFromQuery(record),
    evidenceIdentity: comparisonEvidenceIdentityFilterFromQuery(record),
    numericDelta: comparisonNumericDeltaFilterFromQuery(record)
  };
}

function comparisonGroupFilterFromQuery(
  query: Record<string, unknown>
): "all" | MatchComparisonRowGroup {
  const raw = optionalSingleQueryString(query, "group");
  if (raw === undefined || raw === "all") return "all";
  if (raw === "summary" || raw === "metric" || raw === "metric_evidence") return raw;
  throw new HttpError(400, 'group must be "all", "summary", "metric", or "metric_evidence"');
}

function comparisonChangedOnlyFromQuery(query: Record<string, unknown>): boolean {
  const raw = optionalSingleQueryString(query, "changedOnly");
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  throw new HttpError(400, 'changedOnly must be "1", "true", "yes", "0", "false", or "no"');
}

function comparisonPromotionFilterFromQuery(
  query: Record<string, unknown>
): MatchComparisonPromotionFilter {
  const raw = optionalSingleQueryString(query, "promotion");
  if (raw === undefined || raw === "all") return "all";
  if (
    raw === "changed" ||
    raw === "scorecard" ||
    raw === "diagnostic" ||
    raw === "benchmark_only" ||
    raw === "missing"
  ) {
    return raw;
  }
  throw new HttpError(
    400,
    'promotion must be "all", "changed", "scorecard", "diagnostic", "benchmark_only", or "missing"'
  );
}

function comparisonEvidenceIdentityFilterFromQuery(
  query: Record<string, unknown>
): MatchComparisonEvidenceIdentityFilter {
  const raw = optionalSingleQueryString(query, "evidenceIdentity");
  if (raw === undefined || raw === "all") return "all";
  if (raw === "changed") return raw;
  throw new HttpError(400, 'evidenceIdentity must be "all" or "changed"');
}

function comparisonNumericDeltaFilterFromQuery(
  query: Record<string, unknown>
): MatchComparisonNumericDeltaFilter {
  const raw = optionalSingleQueryString(query, "numericDelta");
  if (raw === undefined || raw === "all") return "all";
  if (raw === "changed") return raw;
  throw new HttpError(400, 'numericDelta must be "all" or "changed"');
}


function projectMatchArtifactForView(artifact: MatchArtifact, view: MatchArtifactView): MatchArtifactViewDto {
  // Stored artifacts are validated on write and recovery. Revalidate at this
  // projection boundary so a future store implementation cannot turn a
  // malformed canonical record into an API-visible partial truth.
  try {
    assertValidMatchArtifactIntegrity(artifact);
  } catch {
    throw new HttpError(409, "Stored match artifact failed integrity validation.", "artifact_integrity_invalid");
  }
  if (view === "full") return sanitizePersistedProviderDiagnostics(redactSecrets(artifact));
  const privateProjected = projectPostgameRedactedArtifact(artifact);
  if (view === "postgame-redacted") return privateProjected;
  return redactSecrets(projectTruthRedactedArtifact(privateProjected));
}

/**
 * Project a deterministic native prefix for the local postgame replay
 * cockpit. A prefix is not a MatchArtifact: it deliberately omits the parent
 * trajectory, agent snapshots, actions, observations, social topology, and
 * all evaluator/provider evidence.
 */
function projectPostgameReplayFrame(prefix: {
  nativeStepCount: number;
  maxMessageSeq: number;
  step: { postStateHash?: string };
  episode: MatchArtifact["socialEpisode"];
  replay: ReturnType<typeof replayWerewolfSocialEpisode>;
}): PostgameReplayFrameDto {
  const state = redactStatePrivateEvents(prefix.replay.finalState);
  const eventCount = Array.isArray(state.events) ? state.events.length : 0;
  const werewolfReviewLedger = projectWerewolfPostgameEventLedger({
    // A replay frame can describe only its recorded native prefix. The parent
    // final artifact is deliberately not consulted here.
    events: prefix.replay.finalState.events,
    episode: prefix.episode,
    view: "postgame-redacted",
    authority: "native-social-episode"
  });
  return {
    artifactVersion: "server.match-replay-frame.v1",
    kind: "match-replay-frame",
    authority: "native-social-episode",
    source: "server-owned-match-artifact",
    cursor: {
      nativeStepCount: prefix.nativeStepCount,
      messageCount: prefix.episode.messages.length,
      eventCount,
      stateHash: prefix.replay.finalHash,
      recordedPostStateHash: prefix.step.postStateHash
    },
    projection: {
      view: "postgame-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: false,
      generatedAt: new Date(0).toISOString()
    },
    state,
    werewolfReviewLedger,
    replay: {
      ok: true,
      replayedSteps: prefix.replay.replayedSteps,
      replayedBatches: prefix.replay.replayedBatches,
      rejectedSteps: prefix.replay.rejectedSteps
    }
  };
}

/**
 * A checkpoint is execution authority for a future fork, but its raw state and
 * prefix contain the same private observations, role truth, and model evidence
 * as a match artifact. The API therefore projects it before serialization;
 * fork execution continues to read the canonical checkpoint from the store.
 */
function projectHarnessCheckpointForView(
  checkpoint: HarnessCheckpoint,
  view: MatchArtifactView
): HarnessCheckpoint | Record<string, unknown> {
  try {
    assertValidHarnessCheckpoint(checkpoint);
  } catch {
    throw new HttpError(409, "Stored checkpoint failed integrity validation.", "checkpoint_integrity_invalid");
  }
  if (view === "full") return sanitizePersistedProviderDiagnostics(redactSecrets(checkpoint));

  const source = cloneJson(checkpoint);
  const privateState = redactStatePrivateEvents(source.state);
  const privateAgents = source.agents.map((agent) => redactAgentPrivateEvidence(agent));
  const privatePrefix = redactSocialEpisodePrivateEvidence(
    source.executionPrefix as MatchArtifact["socialEpisode"]
  );
  const privateProjection = {
    ...source,
    source: {
      ...source.source,
      failureReason: source.source.failureReason ? "[REDACTED checkpoint failure detail]" : undefined
    },
    state: privateState,
    agents: privateAgents,
    executionPrefix: privatePrefix,
    projection: {
      view,
      privateEvidenceRedacted: true,
      postgameTruthRedacted: view === "truth-redacted",
      generatedAt: new Date(0).toISOString()
    }
  };
  if (view === "postgame-redacted") return redactSecrets(privateProjection);

  const truthExecutionPrefix = redactSocialTopologyForTruthView({
    ...privatePrefix,
    initialState: redactPostgameTruthFromState(privatePrefix.initialState as GameState),
    finalState: redactPostgameTruthFromState(privatePrefix.finalState as GameState)
  });
  return redactSecrets({
    artifactVersion: source.artifactVersion,
    kind: source.kind,
    checkpointId: source.checkpointId,
    createdAt: source.createdAt,
    source: redactHarnessCheckpointSourceForTruthView(source.source),
    state: redactPostgameTruthFromState(privateState),
    // Agent snapshots and native steps are fork authority, not public game
    // observations. Keeping them would expose role-specific scheduling and
    // policy identity even after role/team fields have been removed.
    agents: [],
    executionPrefix: truthExecutionPrefix,
    projection: {
      view: "truth-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: true,
      generatedAt: new Date(0).toISOString()
    }
  });
}

function projectPostgameRedactedArtifact(artifact: MatchArtifact): PostgameMatchProjectionDto {
  const exposureRecords = projectSocialExposureRecords(deriveSocialExposureRecords(artifact.socialEpisode));
  const exposureSummary = summarizeProjectedSocialExposureRecords(exposureRecords);
  const source = cloneJson(artifact);
  const socialEpisode: RedactedSocialEpisodeDto = {
    ...redactSocialEpisodePrivateEvidence(source.socialEpisode),
    exposureRecords,
    exposureSummary
  };
  const werewolfReviewLedger = projectWerewolfPostgameEventLedger({
    events: artifact.finalState.events,
    episode: artifact.socialEpisode,
    view: "postgame-redacted",
    authority: "server-owned-match-artifact"
  });
  const projection: PostgameMatchProjectionDto["projection"] = {
    view: "postgame-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: false,
    generatedAt: new Date(0).toISOString()
  };
  const agents = source.agents.map(redactAgentPrivateEvidence);
  return {
    ...source,
    failureReason: source.failureReason ? "[REDACTED harness failure detail]" : undefined,
    projection,
    trajectory: source.trajectory.map(redactHarnessStepPrivateEvidence),
    socialEpisode,
    initialState: redactStatePrivateEvents(source.initialState),
    finalState: redactStatePrivateEvents(source.finalState),
    events: redactGameEventsPrivateEvidence(source.events),
    evaluation: {
      ...source.evaluation,
      trajectory: source.evaluation.trajectory.map((step) => ({
        ...step,
        intent: "[REDACTED private evaluation intent]",
        targetId: undefined
      }))
    },
    agents,
    agentSnapshotFrames: source.agentSnapshotFrames?.map((frame) => ({
      ...frame,
      agents: frame.agents.map(redactAgentPrivateEvidence)
    })),
    socialNetwork: projectSocialNetwork({ projection, agents, socialEpisode }),
    werewolfReviewLedger
  };
}

function projectTruthRedactedArtifact(artifact: PostgameMatchProjectionDto): PostgameMatchProjectionDto {
  const source = cloneJson(artifact);
  const initialState = redactPostgameTruthFromState(source.initialState);
  const finalState = redactPostgameTruthFromState(source.finalState);
  const werewolfReviewLedger = projectWerewolfPostgameEventLedger({
    // The strict public state is already the truth-redacted domain boundary.
    // Never pass native execution rows here: scheduler cadence is private.
    events: ((finalState as unknown as { events?: GameEvent[] }).events ?? []),
    view: "truth-redacted",
    authority: "server-owned-match-artifact"
  });
  const socialEpisode = redactSocialTopologyForTruthView({
    ...source.socialEpisode,
    initialState: redactPostgameTruthFromState(source.socialEpisode.initialState as MatchArtifact["finalState"]) as RedactedSocialEpisodeDto["initialState"],
    finalState: redactPostgameTruthFromState(source.socialEpisode.finalState as MatchArtifact["finalState"]) as RedactedSocialEpisodeDto["finalState"]
  });
  const projection: PostgameMatchProjectionDto["projection"] = {
    view: "truth-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: true,
    generatedAt: new Date(0).toISOString()
  };
  // This is a public observation DTO, not a replay/fork record.  Omit ids and
  // deterministic seeds rather than replacing them with stable aliases: the
  // current Werewolf run ids are derived from the seed and can reconstruct a
  // hidden role assignment.
  return {
    artifactVersion: source.artifactVersion,
    kind: source.kind,
    createdAt: source.createdAt,
    config: cloneJson(source.config),
    models: [],
    profiles: [],
    resolvedAssignments: redactTruthResolvedAssignments(source.resolvedAssignments),
    status: source.status,
    truncationReason: undefined,
    failureReason: undefined,
    failureStateHash: undefined,
    initialState,
    finalState,
    // Policy/trace trajectories contain private action kinds and model-backed
    // agent state. Public messages and domain events below are the allowed
    // public record instead.
    trajectory: [],
    socialEpisode,
    events: cloneJson((finalState as unknown as { events?: GameEvent[] }).events ?? []),
    // Evaluation/reward records are derived from canonical postgame truth.
    // They are intentionally absent from a public in-progress observation.
    evaluation: {} as MatchArtifact["evaluation"],
    evaluationReport: {} as MatchArtifact["evaluationReport"],
    metrics: {} as MatchArtifact["metrics"],
    agents: [],
    agentSnapshotFrames: undefined,
    socialNetwork: projectSocialNetwork({ projection, agents: [], socialEpisode }),
    werewolfReviewLedger,
    projection
  } as unknown as PostgameMatchProjectionDto;
}

/**
 * A public tournament pack does not reuse the broad MatchArtifact DTO.  This
 * is a domain-owned observation record with table-seat identities only; it
 * has no canonical run identity, assignment, execution trace, evaluator
 * result, channel topology, or provider evidence.
 */
function projectPublicTournamentMatchArtifact(artifact: MatchArtifact, episodeIndex: number): Record<string, unknown> {
  const projected = projectMatchArtifactForView(artifact, "truth-redacted") as PostgameMatchProjectionDto;
  const finalState = projected.finalState as unknown as {
    phase?: string;
    day?: number;
    players?: Array<{
      id?: string;
      seat?: number;
      name?: string;
      alive?: boolean;
      isSheriff?: boolean;
      eliminatedAt?: { day?: number; reason?: string };
    }>;
    currentSpeakerSeat?: number;
    pendingActionCount?: number;
    publicEventCount?: number;
  };
  const seatByPlayerId = new Map<string, number>();
  for (const player of finalState.players ?? []) {
    if (typeof player.id === "string" && typeof player.seat === "number") {
      seatByPlayerId.set(player.id, player.seat);
    }
  }
  const socialEpisode = projected.socialEpisode as unknown as {
    messages?: Array<{ seq?: number; senderId?: string; content?: string }>;
  };
  return {
    artifactVersion: "harness.match.public.v1",
    kind: "public-match",
    episodeIndex,
    status: projected.status,
    state: {
      phase: finalState.phase ?? "unknown",
      day: finalState.day ?? 0,
      players: (finalState.players ?? [])
        .filter((player) => typeof player.seat === "number" && typeof player.alive === "boolean")
        .map((player) => ({
          seat: player.seat as number,
          name: player.name ?? `Seat ${player.seat as number}`,
          alive: player.alive as boolean,
          isSheriff: Boolean(player.isSheriff),
          ...(player.eliminatedAt
            ? {
                eliminatedAt: {
                  day: player.eliminatedAt.day,
                  reason: player.eliminatedAt.reason
                }
              }
            : {})
        }))
        .sort((left, right) => left.seat - right.seat),
      ...(typeof finalState.currentSpeakerSeat === "number" ? { currentSpeakerSeat: finalState.currentSpeakerSeat } : {}),
      pendingActionCount: finalState.pendingActionCount ?? 0,
      publicEventCount: finalState.publicEventCount ?? 0
    },
    events: (projected.events ?? []).map((event) => ({
      seq: event.seq,
      day: event.day,
      type: event.type
    })),
    messages: (socialEpisode.messages ?? [])
      .filter((message) => typeof message.seq === "number" && typeof message.content === "string")
      .map((message) => ({
        seq: message.seq,
        senderSeat: message.senderId ? seatByPlayerId.get(message.senderId) ?? null : null,
        content: message.content
      }))
  };
}

/**
 * A truth-redacted artifact is suitable for an untrusted/public reader.  It
 * must not retain a private or team communication topology, because channel
 * membership and delivery metadata can reveal hidden factions even after role
 * fields have been removed from game state.
 */
function redactSocialTopologyForTruthView(episode: RedactedSocialEpisodeDto): RedactedSocialEpisodeDto {
  const publicChannels = episode.channels
    .filter((channel) => channel.kind === "public" && channel.readableBy === "all")
    .map((channel) => ({
      id: channel.id,
      kind: channel.kind,
      readableBy: channel.readableBy
    })) as unknown as RedactedSocialEpisodeDto["channels"];
  const publicChannelIds = new Set(publicChannels.map((channel) => channel.id));
  const isPublicMessage = (message: Pick<SocialMessage, "channelId" | "visibility">): boolean =>
    message.visibility === "public" && publicChannelIds.has(message.channelId);
  const canonicalInitialMessageCount = Math.min(
    Math.max(episode.execution?.initialMessageCount ?? 0, 0),
    episode.messages.length
  );
  const initialPublicMessageIds = new Set(
    episode.messages
      .slice(0, canonicalInitialMessageCount)
      .filter(isPublicMessage)
      .map((message) => message.id)
  );
  const messages = episode.messages
    .filter(isPublicMessage)
    .map(redactPublicSocialMessageForTruthView);
  const exposureRecords: SocialExposureRecord[] = [];

  return {
    domainId: episode.domainId,
    status: episode.status,
    execution: episode.execution
      ? {
          schemaVersion: episode.execution.schemaVersion,
          started: episode.execution.started,
          initialMessageCount: messages.filter((message) => initialPublicMessageIds.has(message.id)).length,
          reasonerExecutionClass: episode.execution.reasonerExecutionClass
        }
      : undefined,
    schedulerMode: episode.schedulerMode,
    // Profiles can carry role-derived policy ids. They are not public game
    // observations, unlike the public channel/messages preserved below.
    profiles: [],
    channels: publicChannels,
    initialState: cloneJson(episode.initialState),
    finalState: cloneJson(episode.finalState),
    // A native step is private execution evidence. Even a redacted action
    // kind/actor pair identifies special roles in a hidden-information game.
    steps: [],
    messages,
    exposureRecords,
    exposureSummary: summarizeProjectedSocialExposureRecords(exposureRecords)
  } as unknown as RedactedSocialEpisodeDto;
}

function redactPublicSocialMessageForTruthView(message: RedactedSocialMessageDto): RedactedSocialMessageDto {
  return {
    id: message.id,
    seq: message.seq,
    channelId: message.channelId,
    senderId: message.senderId,
    // A public channel is already the complete audience declaration. Avoid
    // retaining per-message routing fields that a future domain may use for a
    // narrower observer subset.
    recipientIds: [],
    visibility: "public",
    content: message.content,
    speechActs: message.speechActs?.map((act) => ({
      id: act.id,
      kind: act.kind,
      subjectId: act.subjectId,
      targetId: act.targetId,
      value: cloneJson(act.value),
      confidence: act.confidence,
      evidenceRefs: []
    })),
    createdAt: message.createdAt
  };
}

function redactHarnessCheckpointSourceForTruthView(source: HarnessCheckpoint["source"]): Record<string, unknown> {
  return {
    sourceArtifactVersion: source.sourceArtifactVersion,
    runId: source.runId,
    matchId: source.matchId,
    rulesetId: source.rulesetId,
    status: source.status
  };
}

function redactTruthResolvedAssignments(
  assignments: MatchArtifact["resolvedAssignments"]
): MatchArtifact["resolvedAssignments"] {
  return assignments.map(({ playerId, seat }) => ({ playerId, seat })) as MatchArtifact["resolvedAssignments"];
}

function redactPostgameTruthFromState(state: MatchArtifact["finalState"]): MatchArtifact["finalState"] {
  const publicState = serializePublicState(cloneJson(state));
  const publicObservation: Record<string, unknown> = { ...publicState };
  for (const key of ["id", "seed", "night", "winner", "endReason"]) {
    delete publicObservation[key];
  }
  return {
    ...publicObservation,
    // `serializePublicState()` is the domain's public-state boundary. The
    // truth artifact is intentionally stricter still: it does not publish
    // postgame winner/end truth or role reveals, even if a game config would
    // reveal a role to seated players after death.
    players: publicState.players.map(({ revealedRole: _revealedRole, ...player }) => player),
    events: redactPostgameTruthFromEvents(publicState.events),
  } as unknown as MatchArtifact["finalState"];
}
function redactPostgameTruthFromEvents(events: GameEvent[]): GameEvent[] {
  return events
    .filter((event) => event.visibility === "public")
    .map((event) => {
      const cloned = cloneJson(event);
      if (!isRecord(cloned.payload)) return cloned;
      const payload = { ...cloned.payload };
      for (const key of [
        "role",
        "team",
        "resultTeam",
        "winner",
        "sourceId",
        "seerInspection",
        "wolfVotes",
        "witch",
        "ability",
        "trueRole",
        "actualRole"
      ]) {
        delete payload[key];
      }
      if (Array.isArray(payload.deaths)) {
        payload.deaths = payload.deaths.map((death) => {
          if (!isRecord(death)) return death;
          const nextDeath = { ...death };
          delete nextDeath.sourceId;
          delete nextDeath.role;
          delete nextDeath.team;
          return nextDeath;
        });
      }
      return {
        ...cloned,
        payload
      };
    });
}

function redactPostgameTruthFromEvaluation(evaluation: MatchArtifact["evaluation"]): MatchArtifact["evaluation"] {
  // Evaluation is computed from canonical final truth. Per-agent reward and
  // metric structures are therefore postgame evidence, not an observation a
  // public reader may receive while the game remains hidden-information.
  return {
    winner: undefined,
    teamRewards: {
      village: 0,
      werewolves: 0
    },
    agentRewards: [],
    voteAccuracyByAgent: {},
    influenceByAgent: {},
    deceptionByAgent: {},
    trajectory: []
  };
}

function redactPostgameTruthFromEvaluationReport(
  report: MatchArtifact["evaluationReport"]
): MatchArtifact["evaluationReport"] {
  return {
    id: report.id,
    createdAt: report.createdAt,
    evaluatorIds: [],
    evaluatorRegistry: [],
    metricCount: 0,
    metrics: [],
    outputs: {},
    warnings: [],
    summary: {
      teamScores: {},
      agentScores: {},
      profileScores: {},
      modelScores: {},
      // Catalog ids and metric ids can encode role-specific evaluator names.
      // The truth view exposes no evaluation results, so retain only a stable
      // non-authoritative placeholder that keeps the cockpit DTO shape intact.
      promotion: {
        policyId: "public-redacted",
        policyVersion: "1",
        policyHash: "public-redacted",
        catalogId: "public-redacted",
        catalogVersion: "1",
        catalogHash: "public-redacted",
        catalogDomainId: "public",
        catalogEntryCount: 0,
        catalogRuleCount: 0,
        catalogRuleIds: [],
        catalogScorecardMetricIds: [],
        catalogDiagnosticMetricIds: [],
        catalogBenchmarkOnlyMetricIds: [],
        scorecardMetricCount: 0,
        diagnosticMetricCount: 0,
        weightedMetricCount: 0,
        excludedWeightedMetricCount: 0,
        excludedWeightedMetricIds: [],
        scorecardRequiresEvidence: true,
        scorecardRequiresPositiveWeight: true,
        uncatalogedMetricPolicy: "legacy_conservative_diagnostic",
        decisionStorage: "per_metric_recorded"
      }
    }
  };
}

function redactPostgameTruthFromMetrics(metrics: MatchMetrics): MatchMetrics {
  return {
    winner: undefined,
    days: metrics.days,
    totalDeaths: metrics.totalDeaths,
    totalSpeeches: metrics.totalSpeeches,
    totalVotes: metrics.totalVotes,
    harnessTurnCount: 0,
    harnessErrorCount: 0,
    averageLatencyMs: 0,
    wolfVoteAccuracy: 0,
    villageVoteAccuracy: 0,
    deceptionSurvivalScore: 0,
    modelUsage: {}
  };
}

function redactPostgameTruthFromAgent(agent: RedactedAgentStateDto): RedactedAgentStateDto {
  const next = cloneJson(agent);
  if (next.social?.beliefs?.claims) {
    next.social.beliefs.claims = Object.fromEntries(
      Object.entries(next.social.beliefs.claims).map(([id, claim]) => {
        if (!isRecord(claim)) return [id, claim];
        const claimRecord: Record<string, unknown> = { ...claim };
        delete claimRecord.actualRole;
        delete claimRecord.trueRole;
        delete claimRecord.resultTeam;
        if (claimRecord.predicate === "role" || claimRecord.predicate === "team") {
          claimRecord.value = "[REDACTED postgame claim value]";
        }
        return [id, claimRecord as typeof claim];
      })
    );
  }
  return next;
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

function summarizeProjectedSocialExposureRecords(records: SocialExposureRecord[]): NonNullable<RedactedSocialEpisodeDto["exposureSummary"]> {
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

function redactHarnessStepPrivateEvidence(step: MatchArtifact["trajectory"][number]): RedactedHarnessStepDto {
  return {
    ...step,
    pendingAction: redactPendingAction(step.pendingAction),
    observation: REDACTED_PRIVATE_OBSERVATION,
    policyPlan: {
      policyName: step.policyPlan.policyName,
      intent: "[REDACTED private policy intent]",
      confidence: step.policyPlan.confidence,
      strategyTags: [...step.policyPlan.strategyTags],
      claimedRole: step.policyPlan.claimedRole,
      command: redactCommandPayload(step.policyPlan.command)
    },
    reasonerOutput: redactReasonerOutput(step.reasonerOutput),
    command: redactCommandPayload(step.command),
    turnTrace: {
      traceId: step.turnTrace.traceId,
      playerId: step.turnTrace.playerId,
      profileId: step.turnTrace.profileId,
      model: step.turnTrace.model,
      actionKind: step.turnTrace.actionKind,
      policyName: step.turnTrace.policyName,
      commandType: step.turnTrace.commandType,
      intent: "[REDACTED private turn intent]",
      confidence: step.turnTrace.confidence,
      strategyTags: [...step.turnTrace.strategyTags],
      beliefs: {},
      privateMemo: "[REDACTED private memo]",
      publicSpeech: step.turnTrace.publicSpeech ? "[REDACTED generated speech]" : undefined,
      cognitionSource: redactCognitionSource(step.turnTrace.cognitionSource),
      latencyMs: step.turnTrace.latencyMs,
      promptTokens: step.turnTrace.promptTokens,
      completionTokens: step.turnTrace.completionTokens,
      attempts: step.turnTrace.attempts,
      agentStateHash: step.turnTrace.agentStateHash
    },
    actionArbitration: redactActionArbitrationPrivateEvidence(step.actionArbitration),
    agentSnapshotsAfterStep: undefined
  };
}

function redactActionArbitrationPrivateEvidence(
  arbitration: MatchArtifact["trajectory"][number]["actionArbitration"]
): RedactedAgentActionArbitrationSummaryDto | undefined {
  if (!arbitration) return undefined;
  const selectedCandidateOrdinal = arbitration.candidates.findIndex(
    (candidate) => candidate.id === arbitration.selectedCandidateId
  );
  const candidates = arbitration.candidates.map((candidate, ordinal) => ({
    ordinal,
    source: safeArbitrationCandidateSource(candidate.source),
    kind: safeMetadataString(candidate.kind) ?? "unknown",
    selected: ordinal === selectedCandidateOrdinal,
    baseScore: safeMetadataNumber(candidate.baseScore),
    utilityScore: safeMetadataNumber(candidate.utilityScore),
    socialScore: safeMetadataNumber(candidate.socialScore),
    riskPenalty: safeMetadataNumber(candidate.riskPenalty),
    legalityScore: safeMetadataNumber(candidate.legalityScore),
    finalScore: safeMetadataNumber(candidate.finalScore),
    scoreContributionCount: candidate.scoreContributions?.length ?? 0,
    evidenceCount: candidate.evidenceRefs.length,
    messageCount: candidate.messageCount
  }));
  return {
    version: arbitration.version,
    arbitrator: arbitration.arbitratorId === "default-score-arbitrator" ? "default-score-arbitrator" : "custom",
    candidateCount: candidates.length,
    decisionRule:
      arbitration.decisionRule === "highest_final_score_then_candidate_id"
        ? "highest_final_score_then_candidate_id"
        : "custom",
    selectedCandidateOrdinal: selectedCandidateOrdinal >= 0 ? selectedCandidateOrdinal : undefined,
    selectedCandidateSource:
      selectedCandidateOrdinal >= 0 ? candidates[selectedCandidateOrdinal]?.source : undefined,
    candidates
  };
}

function safeArbitrationCandidateSource(value: string): string {
  return [
    "policy",
    "reasoner",
    "memory",
    "belief",
    "relationship",
    "reputation",
    "norm",
    "goal",
    "social_state"
  ].includes(value)
    ? value
    : "other";
}

function redactReasonerOutput(value: MatchArtifact["trajectory"][number]["reasonerOutput"]): RedactedHarnessStepDto["reasonerOutput"] {
  const cognitionSource = redactCognitionSource(value.cognitionSource);
  return {
    content: cognitionSource === "policy" ? "[REDACTED deterministic policy memo]" : "[REDACTED model reasoning output]",
    cognitionSource,
    latencyMs: value.latencyMs,
    promptTokens: value.promptTokens,
    completionTokens: value.completionTokens,
    attempts: value.attempts
  };
}

/**
 * Cognition provenance is a closed, non-content-bearing control-plane fact.
 * Retaining it in local postgame review prevents a deterministic policy turn
 * from being misrepresented as a provider/model invocation. Historical
 * records without the field retain their legacy reasoner-backed meaning.
 */
function redactCognitionSource(value: unknown): "reasoner" | "policy" {
  return value === "policy" ? "policy" : "reasoner";
}

function redactPendingAction(action: unknown): RedactedPendingActionDto {
  const record = isRecord(action) ? action : {};
  return {
    kind: safeMetadataString(record.kind) ?? "unknown",
    actorId: safeMetadataString(record.actorId),
    phase: safeMetadataString(record.phase),
    redacted: true
  };
}

function redactCommandPayload(command: unknown): RedactedCommandDto {
  const record = isRecord(command) ? command : {};
  return {
    type: safeMetadataString(record.type) ?? "unknown",
    actorId: safeMetadataString(record.actorId),
    redacted: true
  };
}

function redactSocialEpisodePrivateEvidence(episode: MatchArtifact["socialEpisode"]): RedactedSocialEpisodeDto {
  return {
    ...episode,
    assignmentResolution: undefined,
    failureReason: episode.failureReason ? "[REDACTED social episode failure detail]" : undefined,
    error: episode.error ? "[REDACTED social episode error]" : undefined,
    initialState: redactStatePrivateEvents(episode.initialState),
    finalState: redactStatePrivateEvents(episode.finalState),
    steps: episode.steps.map((step) => ({
      ...step,
      pendingAction: redactPendingAction(step.pendingAction),
      observation: REDACTED_PRIVATE_SOCIAL_OBSERVATION,
      action: {
        ...step.action,
        command: redactCommandPayload(step.action.command),
        messages: step.action.messages?.map(redactSocialMessageDraftPrivateEvidence),
        metadata: redactSocialActionMetadata(step.action.metadata)
      },
      failure: redactSocialStepFailure(step.failure),
      error: step.error ? "[REDACTED social step error]" : undefined,
      actorSnapshotsAfterStep: undefined,
      infosByAgent: undefined
    })),
    messages: episode.messages.map(redactSocialMessagePrivateEvidence)
  };
}

function redactSocialMessagePrivateEvidence(message: SocialMessage): RedactedSocialMessageDto {
  return {
    ...message,
    content: message.visibility === "public" ? message.content : "[REDACTED private social message]",
    speechActs: redactSocialSpeechActs(message.speechActs, message.visibility),
    metadata: redactSocialMessageMetadata(message.metadata, message.visibility),
    deliveryReceipts: message.deliveryReceipts?.map((receipt) => ({
      ...receipt,
      redactionPolicy: REDACTED_DELIVERY_POLICY
    }))
  };
}

function redactSocialMessageDraftPrivateEvidence(
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">
): RedactedSocialMessageDraftDto {
  return {
    ...message,
    content: message.visibility === "public" ? message.content : "[REDACTED private social message]",
    speechActs: redactSocialSpeechActs(message.speechActs, message.visibility),
    metadata: redactSocialMessageMetadata(message.metadata, message.visibility),
    deliveryReceipts: message.deliveryReceipts?.map((receipt) => ({
      ...receipt,
      redactionPolicy: REDACTED_DELIVERY_POLICY
    }))
  };
}

function redactSocialSpeechActs(
  speechActs: SocialMessage["speechActs"],
  visibility: SocialMessage["visibility"]
): RedactedSocialMessageDto["speechActs"] {
  if (visibility !== "public") return undefined;
  return speechActs?.map((act) => ({
    id: act.id,
    kind: act.kind,
    subjectId: act.subjectId,
    targetId: act.targetId,
    value: cloneJson(act.value),
    confidence: act.confidence,
    evidenceRefs: act.evidenceRefs.map((ref) => ({
      artifact: ref.artifact,
      id: ref.id,
      seq: ref.seq,
      traceId: ref.traceId
    }))
  }));
}

function redactSocialActionMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const trace = isRecord(value.turnTrace) ? value.turnTrace : undefined;
  const reasoner = isRecord(value.reasonerOutput) ? value.reasonerOutput : undefined;
  const policy = isRecord(value.policyPlan) ? value.policyPlan : undefined;
  return compactRecord({
    kind: safeMetadataString(value.kind),
    turnIndex: safeMetadataNumber(value.turnIndex),
    agentStateHash: safeMetadataString(value.agentStateHash),
    policyPlan: policy
      ? compactRecord({
          policyName: safeMetadataString(policy.policyName),
          intent: "[REDACTED private policy intent]",
          confidence: safeMetadataNumber(policy.confidence),
          strategyTags: safeMetadataStringArray(policy.strategyTags),
          command: isRecord(policy.command)
            ? redactCommandPayload(policy.command)
            : undefined
        })
      : undefined,
    reasonerOutput: reasoner
      ? redactReasonerMetadata(reasoner)
      : undefined,
    turnTrace: trace
      ? compactRecord({
          traceId: safeMetadataString(trace.traceId),
          playerId: safeMetadataString(trace.playerId),
          profileId: safeMetadataString(trace.profileId),
          model: safeMetadataString(trace.model),
          actionKind: safeMetadataString(trace.actionKind),
          policyName: safeMetadataString(trace.policyName),
          commandType: safeMetadataString(trace.commandType),
          intent: "[REDACTED private turn intent]",
          confidence: safeMetadataNumber(trace.confidence),
          strategyTags: safeMetadataStringArray(trace.strategyTags),
          beliefs: {},
          privateMemo: "[REDACTED private memo]",
          publicSpeech: trace.publicSpeech ? "[REDACTED generated speech]" : undefined,
          cognitionSource: redactCognitionSource(trace.cognitionSource),
          latencyMs: safeMetadataNumber(trace.latencyMs),
          promptTokens: safeMetadataNumber(trace.promptTokens),
          completionTokens: safeMetadataNumber(trace.completionTokens),
          attempts: safeMetadataNumber(trace.attempts),
          agentStateHash: safeMetadataString(trace.agentStateHash)
        })
      : undefined
  });
}

function redactReasonerMetadata(reasoner: Record<string, unknown>): Record<string, unknown> {
  const cognitionSource = redactCognitionSource(reasoner.cognitionSource);
  return compactRecord({
    content: cognitionSource === "policy" ? "[REDACTED deterministic policy memo]" : "[REDACTED model reasoning output]",
    cognitionSource,
    latencyMs: safeMetadataNumber(reasoner.latencyMs),
    promptTokens: safeMetadataNumber(reasoner.promptTokens),
    completionTokens: safeMetadataNumber(reasoner.completionTokens),
    attempts: safeMetadataNumber(reasoner.attempts)
  });
}

function redactSocialStepFailure(
  value: MatchArtifact["socialEpisode"]["steps"][number]["failure"]
): RedactedSocialStepFailureDto | undefined {
  if (!value) return undefined;
  return {
    stage: value.stage,
    message: REDACTED_SOCIAL_STEP_FAILURE,
    causeName: safeCauseName(value.causeName),
    metadata: undefined
  };
}

function safeCauseName(value: string | undefined): string | undefined {
  return value && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : undefined;
}

function redactSocialMessageMetadata(
  value: Record<string, unknown> | undefined,
  visibility: SocialMessage["visibility"]
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return compactRecord({
    kind: safeMetadataString(value.kind),
    traceId: safeMetadataString(value.traceId),
    turnIndex: safeMetadataNumber(value.turnIndex),
    actionKind: safeMetadataString(value.actionKind),
    phase: safeMetadataString(value.phase),
    day: safeMetadataNumber(value.day),
    redacted: visibility === "public" ? undefined : true
  });
}

function safeMetadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 200 ? value : undefined;
}

function safeMetadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeMetadataStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length <= 100)) return undefined;
  return value.slice(0, 50);
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function redactStatePrivateEvents<TState>(state: TState): TState {
  if (!isRecord(state) || !Array.isArray(state.events)) return state;
  return {
    ...state,
    events: redactGameEventsPrivateEvidence(state.events as GameEvent[])
  };
}

function redactGameEventsPrivateEvidence(events: GameEvent[]): GameEvent[] {
  return events.map((event) => cloneJson(event));
}

function redactAgentPrivateEvidence(agent: MatchArtifact["agents"][number]): RedactedAgentStateDto {
  const source = cloneJson(agent);
  return {
    ...source,
    beliefs: {},
    privateMemos: source.privateMemos.map(() => "[REDACTED private memo]"),
    lastIntent: source.lastIntent ? "[REDACTED private intent]" : undefined,
    social: source.social ? redactAgentSocialStatePrivateEvidence(source.social) : undefined
  };
}

function redactAgentSocialStatePrivateEvidence(
  social: NonNullable<MatchArtifact["agents"][number]["social"]>
): NonNullable<RedactedAgentStateDto["social"]> {
  const source = cloneJson(social);
  return {
    agentId: source.agentId,
    profile: {
      id: source.profile.id,
      model: source.profile.model,
      temperature: source.profile.temperature,
      policyId: source.profile.policyId
    },
    messageIngestion: source.messageIngestion
      ? {
          ...source.messageIngestion,
          seenMessageIds: []
        }
      : undefined,
    memory: {
      ...source.memory,
      entries: source.memory.entries.map((entry) => ({
        seq: entry.seq,
        kind: entry.kind,
        source: entry.source,
        visibility: entry.visibility,
        content: entry.content ? "[REDACTED private memory]" : undefined,
        salience: entry.salience,
        importance: entry.importance,
        evidenceRefs: redactEvidenceRefs(entry.evidenceRefs),
        tags: [],
        createdAt: entry.createdAt
      }))
    },
    beliefs: {
      claims: Object.fromEntries(
        Object.entries(source.beliefs.claims).map(([id, claim]) => [
          id,
          {
            id: claim.id,
            subject: "[REDACTED private belief subject]",
            predicate: "[REDACTED private belief predicate]",
            value: "[REDACTED private belief value]",
            confidence: claim.confidence,
            evidenceRefs: redactEvidenceRefs(claim.evidenceRefs),
            contradictions: [],
            updatedAt: claim.updatedAt
          }
        ])
      )
    },
    relationships: {
      edges: Object.fromEntries(
        Object.entries(source.relationships.edges).map(([id, edge]) => [
          id,
          {
            targetId: edge.targetId,
            trust: edge.trust,
            suspicion: edge.suspicion,
            affinity: edge.affinity,
            influence: edge.influence,
            debt: edge.debt,
            respect: edge.respect,
            threat: edge.threat,
            evidenceRefs: redactEvidenceRefs(edge.evidenceRefs),
            updatedAt: edge.updatedAt
          }
        ])
      )
    },
    norms: {
      norms: {}
    },
    reputation: {
      records: Object.fromEntries(
        Object.entries(source.reputation.records).map(([id, record]) => [
          id,
          {
            subjectId: record.subjectId,
            honesty: record.honesty,
            competence: record.competence,
            cooperation: record.cooperation,
            threat: record.threat,
            normCompliance: record.normCompliance,
            evidenceRefs: redactEvidenceRefs(record.evidenceRefs),
            updatedAt: record.updatedAt
          }
        ])
      )
    },
    goals: {
      goals: []
    },
    lastPlan: source.lastPlan === undefined ? undefined : "[REDACTED private plan]",
    journal: source.journal
      ? {
          ...source.journal,
          entries: source.journal.entries.map((entry) => ({
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
            evidenceRefs: redactEvidenceRefs(entry.evidenceRefs),
            messageSeqRange: entry.messageSeqRange,
            eventSeqRange: entry.eventSeqRange,
            redactionClass: entry.redactionClass,
            hiddenTruthUsed: entry.hiddenTruthUsed,
            createdAt: entry.createdAt
          }))
        }
      : undefined
  };
}

function redactEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  return refs.map((ref) =>
    ref.artifact === "delivery_receipt"
      ? {
          artifact: ref.artifact,
          // Receipt ids encode observer identity and audience ordering. Public
          // projections retain only the parent message sequence.
          seq: ref.seq
        }
      : {
          artifact: ref.artifact,
          id: ref.id,
          seq: ref.seq,
          traceId: ref.traceId
        }
  );
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
    if (code === "file_name_rejected") return "Match artifact file name was not a server-owned match artifact id.";
    if (code === "file_not_regular") return "Match artifact file was not a safe regular server-owned file.";
    if (code === "file_invalid_json") return "Match artifact file contained invalid JSON.";
    if (code === "file_invalid_shape") return "Match artifact file shape or version was invalid.";
    if (code === "file_identity_mismatch") return "Match artifact file identity did not match its server-owned match artifact id.";
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
  return isPersistedMatchArtifactId(artifactId) || GENERATED_ARTIFACT_SET_ID_PATTERN.test(artifactId)
    ? artifactId
    : "<rejected>";
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
      return isPersistedMatchArtifactId(matchId) ? relativeFile : "<rejected>";
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
    provider: providerDiagnosticSummaryFromEnv(),
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
      environmentValidated: options.probe.environmentValidated,
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

function serializeSocialReplayResult(
  replay: ReturnType<typeof replayWerewolfSocialEpisode>,
  metadata: Record<string, unknown> = {}
): object {
  return {
    summary: {
      kind: "replay",
      authority: "native-social-episode",
      ok: replay.ok,
      ...metadata,
      replayedSteps: replay.replayedSteps,
      replayedBatches: replay.replayedBatches,
      rejectedSteps: replay.rejectedSteps,
      finalHash: replay.finalHash,
      expectedFinalHash: replay.expectedFinalHash,
      finalHashMatchesExpected: replay.finalHash === replay.expectedFinalHash,
      messagesHash: replay.messagesHash,
      expectedMessagesHash: replay.expectedMessagesHash,
      messagesHashMatchesExpected: replay.messagesHash === replay.expectedMessagesHash,
      mismatchCount: replay.mismatches.length,
      mismatchCodes: summarizeReplayMismatchCodes(replay.mismatches)
    },
    replay: {
      ok: replay.ok,
      replayedSteps: replay.replayedSteps,
      replayedBatches: replay.replayedBatches,
      rejectedSteps: replay.rejectedSteps,
      finalHash: replay.finalHash,
      expectedFinalHash: replay.expectedFinalHash,
      messagesHash: replay.messagesHash,
      expectedMessagesHash: replay.expectedMessagesHash,
      mismatches: replay.mismatches.map(sanitizeReplayMismatch),
      mismatchCodes: summarizeReplayMismatchCodes(replay.mismatches),
      redaction: {
        finalStateRedacted: true,
        messagesRedacted: true,
        mismatchDetailsRedacted: true,
        rawHashesRedacted: true
      }
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
    jointPhaseScheduler?: "aec-batched-decision" | "parallel";
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
  const stepTotals = result.episodes.reduce(
    (totals, episode) => {
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? []);
      totals.nativeSteps += stepCounts.nativeSteps;
      totals.committedSteps += stepCounts.committedSteps;
      totals.rejectedSteps += stepCounts.rejectedSteps;
      return totals;
    },
    { nativeSteps: 0, committedSteps: 0, rejectedSteps: 0 }
  );
  const gamesTruncated = result.gamesTruncated ?? result.episodes.filter((episode) => episode.status === "truncated").length;
  const gamesUnstarted = result.gamesUnstarted ?? Math.max(0, result.gamesRequested - result.episodes.length);
  const status = result.gamesFailed > 0 ? "failed" : gamesUnstarted > 0 ? "partial" : gamesTruncated > 0 ? "truncated" : "completed";
  return {
    kind: "tournament",
    status,
    ok: status === "completed",
    provider: providerDiagnosticSummaryFromEnv(),
    experimentId: options.experimentId ?? null,
    seed: options.seed,
    models: options.models,
    profileCount: options.profiles.length,
    modelCount: options.models.length,
    assignment: summarizePublicAssignmentConfig(options.assignment),
    gamesRequested: options.games,
    gamesCompleted: result.gamesCompleted,
    gamesFailed: result.gamesFailed,
    gamesTruncated,
    gamesUnstarted,
    nativeSteps: stepTotals.nativeSteps,
    committedSteps: stepTotals.committedSteps,
    rejectedSteps: stepTotals.rejectedSteps,
    limits: {
      maxTransitions: options.maxTransitions ?? null,
      jointPhaseScheduler: options.jointPhaseScheduler ?? DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER,
      timeoutMs: options.timeoutMs ?? null
    },
    elapsedMs: options.elapsedMs,
    timedOut: options.timedOut,
    executionTelemetry: summarizeTournamentExecutionTelemetry(result),
    evaluation: summarizeTournamentEvaluation(result.episodes),
    evaluationReports: summarizeTournamentEvaluationReports(result.episodes),
    failures,
    failureReason: failures.length ? failures.map((failure) => `${failure.seed}: ${failure.error}`).join(" | ") : null
  };
}

function buildExperimentMatrixSummary(
  result: ExperimentMatrixResult,
  options: { timeoutMs?: number; elapsedMs: number; timedOut: boolean }
): object {
  const failures = result.cells
    .filter((cell) => cell.status === "failed")
    .map((cell) => ({
      index: cell.index,
      id: cell.id,
      label: cell.label,
      group: cell.group,
      error: sanitizeApiErrorText(cell.error ?? "Experiment matrix cell failed."),
      gamesFailed: cell.tournament?.gamesFailed ?? 0
    }));
  return {
    kind: "experiment-matrix",
    // Matrix status reports control-plane execution health. Truncation remains
    // visible in counters and cells but does not turn a bounded study into an
    // API failure.
    ok: result.status === "completed",
    provider: providerDiagnosticSummaryFromEnv(),
    matrixId: result.experiment.id,
    status: result.status,
    cellsRequested: result.cellsRequested,
    cellsUnstarted: result.cellsUnstarted,
    cellsCompleted: result.cellsCompleted,
    cellsTruncated: result.cellsTruncated,
    cellsFailed: result.cellsFailed,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesTruncated: result.gamesTruncated,
    gamesFailed: result.gamesFailed,
    gamesUnstarted: result.gamesUnstarted,
    limits: { timeoutMs: options.timeoutMs ?? null },
    elapsedMs: options.elapsedMs,
    timedOut: options.timedOut,
    denominatorPolicy: result.statistics.denominatorPolicy,
    statisticStatus: result.statistics.status,
    modelStats: result.statistics.modelStats,
    profileStats: result.statistics.profileStats,
    pairwiseModelComparisons: result.statistics.pairwiseModelComparisons,
    failures,
    failureReason: failures.length ? failures.map((failure) => `${failure.id}: ${failure.error}`).join(" | ") : null
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

async function registerTournamentMatchArtifacts(result: TournamentResult): Promise<void> {
  const records = result.artifacts ?? [];
  if (!records.length) return;
  let wroteDiskArtifact = false;
  for (const record of records) {
    const artifact = record.artifact;
    saveMatch(storedMatchFromMatchArtifact(artifact));
    const id = matchArtifactId(artifact);
    if (!matchArtifactBaseDir || !isPersistedMatchArtifactId(id)) continue;
    try {
      await persistMatchArtifact(artifact, matchArtifactBaseDir);
      wroteDiskArtifact = true;
    } catch {
      // Keep memory registration even if disk persistence is unavailable.
    }
  }
  if (wroteDiskArtifact) {
    await writeMatchArtifactIndex(matchArtifactBaseDir);
  }
}

/** Matrix bundles contain research-full nested tournament artifacts. They have
 * their own registry/root and are never eligible for the public-share API. */
async function persistExperimentMatrixArtifactSet(options: {
  result: ExperimentMatrixResult;
  baseDir: string | undefined;
}): Promise<StoredExperimentMatrixArtifactSet> {
  if (!options.baseDir) {
    throw new HttpError(
      400,
      "Experiment matrix artifact export requires configured MATRIX_ARTIFACT_BASE_DIR or TOURNAMENT_ARTIFACT_BASE_DIR."
    );
  }
  const id = randomUUID();
  const baseDir = path.resolve(options.baseDir);
  const outputDir = resolveGeneratedArtifactDirectory(baseDir, id);
  const createdAt = new Date().toISOString();
  let written: ExperimentMatrixArtifactWriteResult;
  try {
    written = await writeExperimentMatrixArtifactDirectory(options.result, { outputDir, createdAt, overwrite: false });
  } catch {
    throw new HttpError(500, "Experiment matrix artifact export failed.");
  }
  const set: StoredExperimentMatrixArtifactSet = {
    id,
    createdAt,
    matrixId: options.result.experiment.id,
    outputDir: written.outputDir,
    files: written.files,
    relativeFiles: relativeExperimentMatrixArtifactFiles(written)
  };
  await loadExperimentMatrixArtifactSetIndex(baseDir);
  saveExperimentMatrixArtifactSet(set);
  await writeExperimentMatrixArtifactSetIndex(baseDir);
  return set;
}

async function loadExperimentMatrixArtifactSetIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  let parsed: unknown;
  let rewrite = false;
  const loadedIds = new Set<string>();
  try {
    parsed = JSON.parse(await readFile(experimentMatrixArtifactSetIndexPath(root), "utf8")) as unknown;
  } catch (error) {
    if (!isFileReadNotFound(error) && !(error instanceof SyntaxError)) {
      throw new HttpError(500, "Experiment matrix artifact set index could not be read.");
    }
    rewrite = error instanceof SyntaxError;
  }
  if (parsed !== undefined) {
    if (!isRecord(parsed) || parsed.kind !== "experiment-matrix-artifact-set-index" || !Array.isArray(parsed.artifactSets)) {
      rewrite = true;
    } else {
      for (const record of parsed.artifactSets) {
        const set = await storedExperimentMatrixArtifactSetFromIndexRecord(root, record);
        if (!set) {
          rewrite = true;
          continue;
        }
        saveExperimentMatrixArtifactSet(set);
        loadedIds.add(set.id);
      }
    }
  }
  const scanned = await loadExperimentMatrixArtifactSetsFromManifests(root, loadedIds);
  if (rewrite || scanned.length) await writeExperimentMatrixArtifactSetIndex(root);
}

async function writeExperimentMatrixArtifactSetIndex(baseDir: string): Promise<void> {
  const root = path.resolve(baseDir);
  await mkdir(root, { recursive: true });
  const index = {
    artifactVersion: "harness.experiment-matrix-artifact-set-index.v1",
    kind: "experiment-matrix-artifact-set-index",
    updatedAt: new Date().toISOString(),
    artifactSets: listExperimentMatrixArtifactSetsForBaseDir(root).map((set) => ({
      id: set.id,
      createdAt: set.createdAt,
      matrixId: set.matrixId,
      relativeFiles: set.relativeFiles
    }))
  };
  await writeFile(experimentMatrixArtifactSetIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

function experimentMatrixArtifactSetIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), MATRIX_ARTIFACT_SET_INDEX_FILE);
}

async function storedExperimentMatrixArtifactSetFromIndexRecord(
  baseDir: string,
  value: unknown
): Promise<StoredExperimentMatrixArtifactSet | null> {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const indexedFiles = experimentMatrixArtifactFilesFromUnknown(value.relativeFiles);
  if (!indexedFiles) return null;
  const restored = await storedExperimentMatrixArtifactSetFromManifestDirectory(baseDir, value.id);
  return restored && equalExperimentMatrixArtifactFiles(restored.relativeFiles, indexedFiles) ? restored : null;
}

async function loadExperimentMatrixArtifactSetsFromManifests(baseDir: string, skipIds: Set<string>): Promise<string[]> {
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(path.resolve(baseDir), { withFileTypes: true });
  } catch (error) {
    if (isFileReadNotFound(error)) return [];
    throw new HttpError(500, "Experiment matrix artifact set directory could not be read.");
  }
  const loaded: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !GENERATED_ARTIFACT_SET_ID_PATTERN.test(entry.name) || skipIds.has(entry.name)) continue;
    const restored = await storedExperimentMatrixArtifactSetFromManifestDirectory(baseDir, entry.name);
    if (!restored) continue;
    saveExperimentMatrixArtifactSet(restored);
    skipIds.add(restored.id);
    loaded.push(restored.id);
  }
  return loaded;
}

async function storedExperimentMatrixArtifactSetFromManifestDirectory(
  baseDir: string,
  id: string
): Promise<StoredExperimentMatrixArtifactSet | null> {
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(id)) return null;
  try {
    const root = path.resolve(baseDir);
    const outputDir = resolveGeneratedArtifactDirectory(root, id);
    await assertExistingArtifactSetDirectoryInsideBase(root, outputDir);
    const manifestPath = resolveUnderDirectory(outputDir, "manifest.json");
    await assertRegularFileInsideArtifactSet({ baseDir: root, outputDir, absolutePath: manifestPath });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!isRecord(manifest) || manifest.artifactVersion !== MATRIX_ARTIFACT_VERSION || manifest.kind !== "experiment-matrix") return null;
    const createdAt = stringField(manifest, "createdAt");
    const matrixId = stringField(manifest, "matrixId");
    const relativeFiles = experimentMatrixArtifactFilesFromUnknown(manifest.files);
    if (!createdAt || !matrixId || !relativeFiles) return null;
    for (const relativeFile of flattenExperimentMatrixArtifactFiles(relativeFiles)) {
      const absolutePath = resolveUnderDirectory(
        outputDir,
        normalizeRequestedArtifactPath(relativeFile)
      );
      await assertRegularFileInsideArtifactSet({
        baseDir: root,
        outputDir,
        absolutePath
      });
    }
    return {
      id,
      createdAt,
      matrixId,
      outputDir,
      files: absoluteExperimentMatrixArtifactFiles(outputDir, relativeFiles),
      relativeFiles
    };
  } catch {
    return null;
  }
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
    relativeFiles: set.relativeFiles,
    nativeSteps: set.nativeSteps ?? null,
    committedSteps: set.committedSteps ?? null,
    rejectedSteps: set.rejectedSteps ?? null,
    metricCount: set.metricCount ?? null,
    scorecardEligibleMetricCount: set.scorecardEligibleMetricCount ?? null,
    metricPromotionClassCounts: set.metricPromotionClassCounts ?? null,
    scorecardEligibleMetricClassCounts: set.scorecardEligibleMetricClassCounts ?? null,
    projection: set.projection ?? null
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
    if (
      manifest.artifactVersion === PUBLIC_TOURNAMENT_ARTIFACT_VERSION &&
      manifest.kind === "public-tournament" &&
      manifest.visibility === "public"
    ) {
      return readPublicTournamentArtifactSetFromManifest({ root, outputDir, id, manifest });
    }
    if (manifest.artifactVersion !== TOURNAMENT_ARTIFACT_VERSION || manifest.kind !== "tournament") {
      return { ok: false, code: "manifest_invalid_shape" };
    }
    const createdAt = stringField(manifest, "createdAt");
    const experimentId = stringField(manifest, "experimentId");
    const seed = stringField(manifest, "seed");
    const relativeFiles = researchTournamentArtifactFileShapeFromUnknown(manifest.files);
    if (!createdAt || !experimentId || !seed || !relativeFiles) return { ok: false, code: "manifest_invalid_shape" };
    if (!isExpectedTournamentArtifactFileSet(relativeFiles)) return { ok: false, code: "manifest_file_set_invalid" };
    const density = tournamentDensityFromUnknown(manifest);
    return {
      ok: true,
      artifact: {
        id,
        createdAt,
        experimentId,
        seed,
        outputDir,
        files: absoluteTournamentArtifactFiles(outputDir, relativeFiles),
        relativeFiles,
        nativeSteps: density?.nativeSteps,
        committedSteps: density?.committedSteps,
        rejectedSteps: density?.rejectedSteps,
        metricCount: density?.metricCount,
        scorecardEligibleMetricCount: density?.scorecardEligibleMetricCount,
        metricPromotionClassCounts: density?.metricPromotionClassCounts,
        scorecardEligibleMetricClassCounts: density?.scorecardEligibleMetricClassCounts,
        projection: tournamentProjectionFromUnknown(manifest.projection)
      }
    };
  } catch {
    return { ok: false, code: "manifest_identity_mismatch" };
  }
}

async function readPublicTournamentArtifactSetFromManifest(input: {
  root: string;
  outputDir: string;
  id: string;
  manifest: Record<string, unknown>;
}): Promise<ArtifactRecoveryReadResult<StoredTournamentArtifactSet>> {
  const createdAt = stringField(input.manifest, "createdAt");
  const relativeFiles = publicTournamentArtifactFileShapeFromUnknown(input.manifest.files);
  if (!createdAt || !relativeFiles || !isExpectedPublicTournamentArtifactFileSet(relativeFiles)) {
    return { ok: false, code: "manifest_invalid_shape" };
  }
  const validated = await validatePublicTournamentArtifactDirectory({
    baseDir: input.root,
    outputDir: input.outputDir,
    manifest: input.manifest,
    files: relativeFiles
  });
  if (!validated) return { ok: false, code: "public_projection_invalid" };
  return {
    ok: true,
    artifact: {
      id: input.id,
      createdAt,
      experimentId: input.id,
      seed: "[REDACTED deterministic seed]",
      outputDir: input.outputDir,
      files: absolutePublicTournamentArtifactFiles(input.outputDir, relativeFiles),
      relativeFiles,
      projection: {
        visibility: "public",
        matchArtifactView: "truth-redacted",
        assignmentTruthRedacted: true,
        publicShareSafe: true
      }
    }
  };
}

async function validatePublicTournamentArtifactDirectory(input: {
  baseDir: string;
  outputDir: string;
  manifest: Record<string, unknown>;
  files: StoredPublicTournamentArtifactFiles;
}): Promise<boolean> {
  try {
    if (!isPublicTournamentManifest(input.manifest, input.files)) return false;
    if (!(await hasExactPublicTournamentArtifactFileSet(input))) return false;
    const episodePath = resolveUnderDirectory(input.outputDir, input.files.episodes);
    await assertRegularFileInsideArtifactSet({
      baseDir: input.baseDir,
      outputDir: input.outputDir,
      absolutePath: episodePath
    });
    const episodeRecords = (await readFile(episodePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    if (episodeRecords.length !== input.files.matches.length) return false;
    const expectedByPath = new Map<string, Record<string, unknown>>();
    for (const record of episodeRecords) {
      if (!isPublicTournamentEpisodeRecord(record)) return false;
      const value = record as Record<string, unknown>;
      const matchPath = value.match;
      if (typeof matchPath !== "string" || expectedByPath.has(matchPath)) return false;
      expectedByPath.set(matchPath, value);
    }
    for (const matchPath of input.files.matches) {
      const episode = expectedByPath.get(matchPath);
      if (!episode) return false;
      const expectedEpisodeIndex = publicEpisodeIndexFromMatchPath(matchPath);
      if (expectedEpisodeIndex === null || expectedEpisodeIndex !== episode.episodeIndex) return false;
      const absolutePath = resolveUnderDirectory(input.outputDir, matchPath);
      await assertRegularFileInsideArtifactSet({
        baseDir: input.baseDir,
        outputDir: input.outputDir,
        absolutePath
      });
      const match = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
      assertPublicTournamentMatchArtifact(match);
      const publicMatch = match as Record<string, unknown>;
      if (publicMatch.episodeIndex !== episode.episodeIndex || publicMatch.status !== episode.status) return false;
      if (!Array.isArray(publicMatch.messages) || publicMatch.messages.length !== episode.publicMessageCount) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function hasExactPublicTournamentArtifactFileSet(input: {
  baseDir: string;
  outputDir: string;
  files: StoredPublicTournamentArtifactFiles;
}): Promise<boolean> {
  try {
    await assertExistingArtifactSetDirectoryInsideBase(input.baseDir, input.outputDir);
    const rootEntries = await readdir(input.outputDir, { withFileTypes: true });
    const expectedRootEntries = new Set(["manifest.json", "episodes.jsonl", "matches"]);
    if (rootEntries.length !== expectedRootEntries.size || rootEntries.some((entry) => !expectedRootEntries.has(entry.name))) {
      return false;
    }
    const matchesDirectory = resolveUnderDirectory(input.outputDir, "matches");
    const matchesInfo = await lstat(matchesDirectory);
    if (!matchesInfo.isDirectory() || matchesInfo.isSymbolicLink()) return false;
    const expectedMatchNames = new Set(input.files.matches.map((file) => path.basename(file)));
    if (expectedMatchNames.size !== input.files.matches.length) return false;
    const matchEntries = await readdir(matchesDirectory, { withFileTypes: true });
    if (
      matchEntries.length !== expectedMatchNames.size ||
      matchEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expectedMatchNames.has(entry.name))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function publicEpisodeIndexFromMatchPath(matchPath: string): number | null {
  const match = /^matches\/episode-([1-9][0-9]*)\.json$/.exec(matchPath);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

async function assertVerifiedPublicTournamentArtifactSet(
  set: StoredTournamentArtifactSet,
  baseDir: string | undefined
): Promise<void> {
  if (!baseDir || "registry" in set.relativeFiles) {
    throw new HttpError(409, "Tournament artifact set is not a verified public publication.", "public_tournament_artifact_invalid");
  }
  const files = set.relativeFiles as StoredPublicTournamentArtifactFiles;
  if (!isExpectedPublicTournamentArtifactFileSet(files)) {
    throw new HttpError(409, "Tournament artifact set is not a verified public publication.", "public_tournament_artifact_invalid");
  }
  try {
    const manifestPath = resolveUnderDirectory(set.outputDir, files.manifest);
    await assertRegularFileInsideArtifactSet({ baseDir, outputDir: set.outputDir, absolutePath: manifestPath });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!isRecord(manifest)) throw new Error("invalid manifest");
    const valid = await validatePublicTournamentArtifactDirectory({
      baseDir,
      outputDir: set.outputDir,
      manifest,
      files
    });
    if (!valid) throw new Error("invalid public projection");
  } catch {
    throw new HttpError(409, "Tournament public publication failed verification.", "public_tournament_artifact_invalid");
  }
}

function isPublicTournamentManifest(
  manifest: Record<string, unknown>,
  files: StoredPublicTournamentArtifactFiles
): boolean {
  const keys = Object.keys(manifest).sort();
  const expected = ["artifactVersion", "createdAt", "files", "games", "kind", "visibility"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  if (
    manifest.artifactVersion !== PUBLIC_TOURNAMENT_ARTIFACT_VERSION ||
    manifest.kind !== "public-tournament" ||
    manifest.visibility !== "public" ||
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  ) {
    return false;
  }
  if (!isRecord(manifest.games)) return false;
  const gameKeys = Object.keys(manifest.games).sort();
  if (
    gameKeys.length !== 4 ||
    gameKeys[0] !== "completed" ||
    gameKeys[1] !== "failed" ||
    gameKeys[2] !== "requested" ||
    gameKeys[3] !== "truncated" ||
    !Object.values(manifest.games).every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0)
  ) {
    return false;
  }
  const manifestFiles = publicTournamentArtifactFileShapeFromUnknown(manifest.files);
  return Boolean(manifestFiles && equalTournamentArtifactFiles(manifestFiles, files));
}

function isPublicTournamentEpisodeRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["episodeIndex", "kind", "match", "publicMessageCount", "status"];
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    value.kind === "public-episode" &&
    typeof value.episodeIndex === "number" &&
    Number.isInteger(value.episodeIndex) &&
    value.episodeIndex >= 0 &&
    typeof value.status === "string" &&
    typeof value.match === "string" &&
    typeof value.publicMessageCount === "number" &&
    Number.isInteger(value.publicMessageCount) &&
    value.publicMessageCount >= 0
  );
}

function tournamentArtifactFilesFromUnknown(value: unknown): StoredTournamentArtifactFiles | null {
  const publicFiles = publicTournamentArtifactFileShapeFromUnknown(value);
  if (publicFiles && isExpectedPublicTournamentArtifactFileSet(publicFiles)) return publicFiles;
  const researchFiles = researchTournamentArtifactFileShapeFromUnknown(value);
  return researchFiles && isExpectedTournamentArtifactFileSet(researchFiles) ? researchFiles : null;
}

function researchTournamentArtifactFileShapeFromUnknown(value: unknown): StoredResearchTournamentArtifactFiles | null {
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
  const tournamentComparison = stringField(value, "tournamentComparison");
  const tournamentComparisonMarkdown = stringField(value, "tournamentComparisonMarkdown");
  const summaryMarkdown = stringField(value, "summaryMarkdown");
  const episodesCsv = stringField(value, "episodesCsv");
  const agentsCsv = stringField(value, "agentsCsv");
  const metricsCsv = stringField(value, "metricsCsv");
  const leaderboardCsv = stringField(value, "leaderboardCsv");
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
    !tournamentComparison ||
    !tournamentComparisonMarkdown ||
    !summaryMarkdown ||
    !episodesCsv ||
    !agentsCsv ||
    !metricsCsv ||
    !leaderboardCsv ||
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
    tournamentComparison,
    tournamentComparisonMarkdown,
    summaryMarkdown,
    episodesCsv,
    agentsCsv,
    metricsCsv,
    leaderboardCsv,
    matches,
    matchesJsonl
  };
  return files satisfies StoredResearchTournamentArtifactFiles;
}

function publicTournamentArtifactFileShapeFromUnknown(value: unknown): StoredPublicTournamentArtifactFiles | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = ["episodes", "manifest", "matches"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  const manifest = stringField(value, "manifest");
  const episodes = stringField(value, "episodes");
  const matches = stringArrayField(value, "matches");
  if (!manifest || !episodes || !matches) return null;
  return { manifest, episodes, matches };
}

function isExpectedTournamentArtifactFileSet(files: StoredResearchTournamentArtifactFiles): boolean {
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
    files.tournamentComparison === "tournament_comparison.json" &&
    files.tournamentComparisonMarkdown === "tournament_comparison.md" &&
    files.summaryMarkdown === "summary.md" &&
    files.episodesCsv === "episodes.csv" &&
    files.agentsCsv === "agents.csv" &&
    files.metricsCsv === "metrics.csv" &&
    files.leaderboardCsv === "leaderboard.csv" &&
    files.matches.every((file) => isWriterTournamentMatchArtifactFile(file, ".json")) &&
    files.matchesJsonl.every((file) => isWriterTournamentMatchArtifactFile(file, ".jsonl"))
  );
}

function isExpectedPublicTournamentArtifactFileSet(files: StoredPublicTournamentArtifactFiles): boolean {
  return (
    files.manifest === "manifest.json" &&
    files.episodes === "episodes.jsonl" &&
    files.matches.every((file) => /^matches\/episode-[1-9][0-9]*\.json$/.test(file))
  );
}

function experimentMatrixArtifactFilesFromUnknown(value: unknown): StoredExperimentMatrixArtifactFiles | null {
  if (!isRecord(value)) return null;
  const manifest = stringField(value, "manifest");
  const specNormalized = stringField(value, "specNormalized");
  const cells = stringField(value, "cells");
  const statistics = stringField(value, "statistics");
  const summaryMarkdown = stringField(value, "summaryMarkdown");
  const modelStatsCsv = stringField(value, "modelStatsCsv");
  const profileStatsCsv = stringField(value, "profileStatsCsv");
  const pairwiseModelComparisonsCsv = stringField(value, "pairwiseModelComparisonsCsv");
  if (
    !manifest ||
    !specNormalized ||
    !cells ||
    !statistics ||
    !summaryMarkdown ||
    !modelStatsCsv ||
    !profileStatsCsv ||
    !pairwiseModelComparisonsCsv ||
    !Array.isArray(value.tournaments)
  ) {
    return null;
  }
  const tournaments: StoredExperimentMatrixArtifactFiles["tournaments"] = [];
  for (const item of value.tournaments) {
    if (!isRecord(item)) return null;
    const cellId = stringField(item, "cellId");
    const tournamentManifest = stringField(item, "manifest");
    if (!cellId || !tournamentManifest) return null;
    tournaments.push({ cellId, manifest: tournamentManifest });
  }
  const files = {
    manifest,
    specNormalized,
    cells,
    statistics,
    summaryMarkdown,
    modelStatsCsv,
    profileStatsCsv,
    pairwiseModelComparisonsCsv,
    tournaments
  } satisfies StoredExperimentMatrixArtifactFiles;
  return isExpectedExperimentMatrixArtifactFileSet(files) ? files : null;
}

function isExpectedExperimentMatrixArtifactFileSet(files: StoredExperimentMatrixArtifactFiles): boolean {
  return (
    files.manifest === "manifest.json" &&
    files.specNormalized === "spec.normalized.json" &&
    files.cells === "cells.jsonl" &&
    files.statistics === "statistics.json" &&
    files.summaryMarkdown === "summary.md" &&
    files.modelStatsCsv === "model_stats.csv" &&
    files.profileStatsCsv === "profile_stats.csv" &&
    files.pairwiseModelComparisonsCsv === "pairwise_model_comparisons.csv" &&
    files.tournaments.every((file) => {
      if (!/^[A-Za-z0-9_.-]+$/.test(file.cellId)) return false;
      return file.manifest === `tournaments/${file.cellId}/manifest.json`;
    })
  );
}

function isWriterTournamentMatchArtifactFile(file: string, extension: ".json" | ".jsonl"): boolean {
  if (!file.startsWith("matches/") || !file.endsWith(extension)) return false;
  const matchStem = file.slice("matches/".length, -extension.length);
  return /^tournament-[A-Za-z0-9_.-]+-[1-9][0-9]*$/.test(matchStem);
}

function absoluteTournamentArtifactFiles(
  outputDir: string,
  files: StoredResearchTournamentArtifactFiles
): TournamentArtifactWriteResult["files"] {
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
    tournamentComparison: resolve(files.tournamentComparison),
    tournamentComparisonMarkdown: resolve(files.tournamentComparisonMarkdown),
    summaryMarkdown: resolve(files.summaryMarkdown),
    episodesCsv: resolve(files.episodesCsv),
    agentsCsv: resolve(files.agentsCsv),
    metricsCsv: resolve(files.metricsCsv),
    leaderboardCsv: resolve(files.leaderboardCsv),
    matchesDir: resolveUnderDirectory(outputDir, "matches"),
    matches: files.matches.map(resolve),
    matchesJsonl: files.matchesJsonl.map(resolve)
  };
}

function absolutePublicTournamentArtifactFiles(
  outputDir: string,
  files: StoredPublicTournamentArtifactFiles
): PublicTournamentArtifactFiles {
  const resolve = (relativePath: string) => resolveUnderDirectory(outputDir, normalizeRequestedArtifactPath(relativePath));
  return {
    manifest: resolve(files.manifest),
    episodes: resolve(files.episodes),
    matchesDir: resolveUnderDirectory(outputDir, "matches"),
    matches: files.matches.map(resolve)
  };
}

function absoluteExperimentMatrixArtifactFiles(
  outputDir: string,
  files: StoredExperimentMatrixArtifactFiles
): ExperimentMatrixArtifactWriteResult["files"] {
  const resolve = (relativePath: string) => resolveUnderDirectory(outputDir, normalizeRequestedArtifactPath(relativePath));
  return {
    manifest: resolve(files.manifest),
    specNormalized: resolve(files.specNormalized),
    cells: resolve(files.cells),
    statistics: resolve(files.statistics),
    summaryMarkdown: resolve(files.summaryMarkdown),
    modelStatsCsv: resolve(files.modelStatsCsv),
    profileStatsCsv: resolve(files.profileStatsCsv),
    pairwiseModelComparisonsCsv: resolve(files.pairwiseModelComparisonsCsv),
    tournamentsDir: resolveUnderDirectory(outputDir, "tournaments"),
    tournaments: files.tournaments.map((file) => ({ cellId: file.cellId, manifest: resolve(file.manifest) }))
  };
}

function equalTournamentArtifactFiles(left: StoredTournamentArtifactFiles, right: StoredTournamentArtifactFiles): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function equalExperimentMatrixArtifactFiles(
  left: StoredExperimentMatrixArtifactFiles,
  right: StoredExperimentMatrixArtifactFiles
): boolean {
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

function listExperimentMatrixArtifactSetsForBaseDir(baseDir: string | undefined): StoredExperimentMatrixArtifactSet[] {
  if (!baseDir) return listExperimentMatrixArtifactSets();
  return listExperimentMatrixArtifactSets().filter((set) => isExperimentMatrixArtifactSetInsideBaseDir(set, baseDir));
}

function getExperimentMatrixArtifactSetForBaseDir(
  id: string,
  baseDir: string | undefined
): StoredExperimentMatrixArtifactSet | undefined {
  const set = getExperimentMatrixArtifactSet(id);
  if (!set || (baseDir && !isExperimentMatrixArtifactSetInsideBaseDir(set, baseDir))) return undefined;
  return set;
}

function isExperimentMatrixArtifactSetInsideBaseDir(set: StoredExperimentMatrixArtifactSet, baseDir: string): boolean {
  const root = path.resolve(baseDir);
  const outputDir = path.resolve(set.outputDir);
  return outputDir !== root && outputDir.startsWith(root + path.sep);
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function tournamentDensityFromUnknown(
  value: unknown
): {
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  metricCount?: number;
  scorecardEligibleMetricCount?: number;
  metricPromotionClassCounts?: StoredTournamentArtifactSet["metricPromotionClassCounts"];
  scorecardEligibleMetricClassCounts?: StoredTournamentArtifactSet["scorecardEligibleMetricClassCounts"];
} | undefined {
  if (!isRecord(value)) return undefined;
  const nativeSteps = numberField(value, "nativeSteps");
  const committedSteps = numberField(value, "committedSteps");
  const rejectedSteps = numberField(value, "rejectedSteps");
  if (nativeSteps === null || committedSteps === null || rejectedSteps === null) return undefined;
  if (nativeSteps < 0 || committedSteps < 0 || rejectedSteps < 0) return undefined;
  const metricCount = numberField(value, "metricCount");
  const scorecardEligibleMetricCount = numberField(value, "scorecardEligibleMetricCount");
  const metricPromotionClassCounts = tournamentPromotionClassCountsFromUnknown(value.metricPromotionClassCounts);
  const scorecardEligibleMetricClassCounts = tournamentPromotionClassCountsFromUnknown(
    value.scorecardEligibleMetricClassCounts
  );
  return {
    nativeSteps,
    committedSteps,
    rejectedSteps,
    ...(metricCount !== null && metricCount >= 0 ? { metricCount } : {}),
    ...(scorecardEligibleMetricCount !== null && scorecardEligibleMetricCount >= 0
      ? { scorecardEligibleMetricCount }
      : {}),
    ...(metricPromotionClassCounts ? { metricPromotionClassCounts } : {}),
    ...(scorecardEligibleMetricClassCounts ? { scorecardEligibleMetricClassCounts } : {})
  };
}

function tournamentPromotionClassCountsFromUnknown(
  value: unknown
): StoredTournamentArtifactSet["metricPromotionClassCounts"] | undefined {
  if (!isRecord(value)) return undefined;
  const scorecard = numberField(value, "scorecard");
  const diagnostic = numberField(value, "diagnostic");
  const benchmarkOnly = numberField(value, "benchmark_only");
  if (scorecard === null || diagnostic === null || benchmarkOnly === null) return undefined;
  if (scorecard < 0 || diagnostic < 0 || benchmarkOnly < 0) return undefined;
  return {
    scorecard,
    diagnostic,
    benchmark_only: benchmarkOnly
  };
}

async function tournamentDensityFromManifestFile(
  manifestPath: string
): Promise<
  | {
      nativeSteps: number;
      committedSteps: number;
      rejectedSteps: number;
      metricCount?: number;
      scorecardEligibleMetricCount?: number;
      metricPromotionClassCounts?: StoredTournamentArtifactSet["metricPromotionClassCounts"];
      scorecardEligibleMetricClassCounts?: StoredTournamentArtifactSet["scorecardEligibleMetricClassCounts"];
    }
  | undefined
> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    return tournamentDensityFromUnknown(manifest);
  } catch {
    return undefined;
  }
}

function tournamentProjectionFromUnknown(
  value: unknown
): StoredTournamentArtifactSet["projection"] | undefined {
  if (!isRecord(value)) return undefined;
  const visibility = stringField(value, "visibility");
  const matchArtifactView = stringField(value, "matchArtifactView");
  if (
    matchArtifactView !== "full" &&
    matchArtifactView !== "postgame-redacted" &&
    matchArtifactView !== "truth-redacted"
  ) {
    return undefined;
  }
  if (typeof value.assignmentTruthRedacted !== "boolean") return undefined;
  if (visibility !== "research-full" && visibility !== "postgame-research" && visibility !== "public") return undefined;
  if (typeof value.publicShareSafe !== "boolean") return undefined;
  return {
    visibility,
    matchArtifactView,
    assignmentTruthRedacted: value.assignmentTruthRedacted,
    // A stored boolean is never authority for public sharing.  The public
    // manifest schema and its file set are validated during recovery.
    publicShareSafe: visibility === "public" && value.publicShareSafe
  };
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
    downloads: tournamentArtifactDownloads(set),
    nativeSteps: set.nativeSteps ?? null,
    committedSteps: set.committedSteps ?? null,
    rejectedSteps: set.rejectedSteps ?? null,
    metricCount: set.metricCount ?? null,
    scorecardEligibleMetricCount: set.scorecardEligibleMetricCount ?? null,
    metricPromotionClassCounts: set.metricPromotionClassCounts ?? null,
    scorecardEligibleMetricClassCounts: set.scorecardEligibleMetricClassCounts ?? null,
    projection: set.projection ?? null
  };
}

function serializeTournamentPublicShare(share: StoredTournamentPublicShare): object {
  return {
    shareId: share.id,
    id: share.id,
    artifactSetId: share.artifactSetId,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    label: share.label ?? null,
    relativeFiles: share.relativeFiles ?? null,
    projection: share.projection ?? null,
    expired: isTournamentPublicShareExpired(share),
    analytics: {
      detailViewCount: Math.max(0, share.detailViewCount ?? 0),
      downloadCount: Math.max(0, share.downloadCount ?? 0),
      downloadsByFile: normalizeDownloadsByFile(share.downloadsByFile),
      downloadEvents: normalizeDownloadEvents(share.downloadEvents),
      detailViewEvents: normalizeTimestampEvents(share.detailViewEvents),
      downloadsByMinute: bucketEventsByMinute(normalizeDownloadEvents(share.downloadEvents).map((event) => event.at)),
      detailViewsByMinute: bucketEventsByMinute(normalizeTimestampEvents(share.detailViewEvents)),
      lastDetailViewedAt: share.lastDetailViewedAt ?? null,
      lastDownloadedAt: share.lastDownloadedAt ?? null,
      lastDownloadedFile: share.lastDownloadedFile ?? null
    },
    urls: {
      detail: `/api/public/tournament-shares/${encodeURIComponent(share.id)}`,
      filesBase: `/api/public/tournament-shares/${encodeURIComponent(share.id)}/files`
    }
  };
}

function publicTournamentArtifactSetForShare(share: StoredTournamentPublicShare): StoredTournamentArtifactSet | undefined {
  const set = getTournamentArtifactSetForBaseDir(share.artifactSetId, tournamentArtifactBaseDir);
  return set && !("registry" in set.relativeFiles) ? set : undefined;
}

function serializeTournamentPublicShareInventory(share: StoredTournamentPublicShare): {
  expired: boolean;
  [key: string]: unknown;
} {
  const artifactSet = publicTournamentArtifactSetForShare(share);
  return {
    ...serializeTournamentPublicShare(share),
    expired: isTournamentPublicShareExpired(share),
    packFound: Boolean(artifactSet),
    packCreatedAt: artifactSet?.createdAt ?? null
  };
}

function serializeTournamentPublicShareDetail(
  share: StoredTournamentPublicShare,
  artifactSet: StoredTournamentArtifactSet
): object {
  const shareableFiles = shareableTournamentArtifactFiles(share, artifactSet);
  return {
    ...serializeTournamentPublicShare(share),
    packCreatedAt: artifactSet.createdAt,
    files: shareableFiles,
    downloads: mapTournamentArtifactFileList(shareableFiles, (relativePath) =>
      tournamentPublicShareDownloadUrl(share.id, relativePath)
    )
  };
}

function tournamentPublicShareDownloadUrl(shareId: string, relativePath: string): string {
  return `/api/public/tournament-shares/${encodeURIComponent(shareId)}/files/${relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function shareableTournamentArtifactFiles(
  share: StoredTournamentPublicShare,
  artifactSet: StoredTournamentArtifactSet
): string[] {
  const registered = flattenTournamentArtifactFiles(artifactSet.relativeFiles);
  if (!share.relativeFiles) return registered;
  const allow = new Set(share.relativeFiles);
  return registered.filter((file) => allow.has(file));
}

function mapTournamentArtifactFileList(
  files: string[],
  mapFile: (relativePath: string) => string
): string[] {
  return files.map(mapFile);
}

function resolvePublicShareDownloadRateLimit(
  override: ServerAppDependencies["publicShareDownloadRateLimit"] | undefined,
  env: NodeJS.ProcessEnv
): { maxDownloads: number; windowMs: number; now: () => number } {
  const maxDownloads =
    override?.maxDownloads ??
    parseEnvPositiveInteger(env.TOURNAMENT_PUBLIC_SHARE_DOWNLOAD_RATE_LIMIT, 60);
  const windowMs =
    override?.windowMs ??
    parseEnvPositiveInteger(env.TOURNAMENT_PUBLIC_SHARE_DOWNLOAD_RATE_WINDOW_MS, 60_000);
  return {
    maxDownloads,
    windowMs,
    now: override?.now ?? (() => Date.now())
  };
}


function resolvePublicShareEventRetention(
  override: TournamentPublicShareEventRetentionPolicy | undefined,
  env: NodeJS.ProcessEnv
): TournamentPublicShareEventRetentionPolicy {
  const maxEvents =
    override?.maxEvents ??
    parseEnvPositiveInteger(env.TOURNAMENT_PUBLIC_SHARE_EVENT_MAX, DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION.maxEvents);
  let maxAgeMs: number | null | undefined = override?.maxAgeMs;
  if (maxAgeMs === undefined) {
    const raw = env.TOURNAMENT_PUBLIC_SHARE_EVENT_MAX_AGE_MS;
    if (raw === undefined || raw === null || raw === "") {
      maxAgeMs = DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION.maxAgeMs ?? null;
    } else if (raw === "0" || raw.toLowerCase() === "none" || raw.toLowerCase() === "off") {
      maxAgeMs = null;
    } else {
      maxAgeMs = parseEnvPositiveInteger(raw, DEFAULT_TOURNAMENT_PUBLIC_SHARE_EVENT_RETENTION.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000);
    }
  }
  return {
    maxEvents,
    maxAgeMs: maxAgeMs ?? null
  };
}
function parseEnvPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function requestClientKey(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return String(forwarded[0]).split(",")[0]?.trim() || "unknown";
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

function consumePublicShareDownloadRateLimit(
  buckets: Map<string, number[]>,
  key: string,
  config: { maxDownloads: number; windowMs: number; now: () => number }
): { allowed: boolean; retryAfterSeconds: number } {
  const now = config.now();
  const windowStart = now - config.windowMs;
  const recent = (buckets.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
  if (recent.length >= config.maxDownloads) {
    const oldest = recent[0] ?? now;
    const retryAfterMs = Math.max(1, oldest + config.windowMs - now);
    buckets.set(key, recent);
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }
  recent.push(now);
  buckets.set(key, recent);
  // Bound memory for long-running processes: drop empty/stale keys opportunistically.
  if (buckets.size > 10_000) {
    for (const [bucketKey, timestamps] of buckets) {
      const kept = timestamps.filter((timestamp) => timestamp > windowStart);
      if (!kept.length) buckets.delete(bucketKey);
      else buckets.set(bucketKey, kept);
    }
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function requireActiveTournamentPublicShare(shareId: string): StoredTournamentPublicShare {
  const share = getTournamentPublicShare(shareId);
  if (!share) throw new HttpError(404, "tournament public share not found");
  if (isTournamentPublicShareExpired(share)) throw new HttpError(410, "tournament public share expired");
  return share;
}

function isTournamentPublicShareExpired(share: StoredTournamentPublicShare, now = Date.now()): boolean {
  if (!share.expiresAt) return false;
  const expiresAtMs = Date.parse(share.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
}

interface TournamentPublicShareAnalyticsSummaryShare {
  shareId: string;
  artifactSetId: string;
  label: string | null;
  expired: boolean;
  packFound: boolean;
  packCreatedAt: string | null;
  detailViewCount: number;
  downloadCount: number;
  topFiles: Array<{ file: string; count: number }>;
  lastDetailViewedAt: string | null;
  lastDownloadedAt: string | null;
  lastDownloadedFile: string | null;
}

interface TournamentPublicShareAnalyticsSummary {
  artifactVersion: "harness.tournament-public-share-analytics.v1";
  kind: "tournament-public-share-analytics";
  createdAt: string;
  totals: {
    shareCount: number;
    activeShareCount: number;
    expiredShareCount: number;
    packMissingCount: number;
    detailViewCount: number;
    downloadCount: number;
  };
  topFiles: Array<{ file: string; count: number }>;
  downloadsByMinute: Array<{ minute: string; count: number }>;
  detailViewsByMinute: Array<{ minute: string; count: number }>;
  shares: TournamentPublicShareAnalyticsSummaryShare[];
}

function buildTournamentPublicShareAnalyticsSummary(now = Date.now()): TournamentPublicShareAnalyticsSummary {
  const shares = listTournamentPublicShares().map((share) => {
    const artifactSet = publicTournamentArtifactSetForShare(share);
    const downloadsByFile = normalizeDownloadsByFile(share.downloadsByFile);
    const topFiles = Object.entries(downloadsByFile)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([file, count]) => ({ file, count }));
    return {
      shareId: share.id,
      artifactSetId: share.artifactSetId,
      label: share.label ?? null,
      expired: isTournamentPublicShareExpired(share, now),
      packFound: Boolean(artifactSet),
      packCreatedAt: artifactSet?.createdAt ?? null,
      detailViewCount: Math.max(0, share.detailViewCount ?? 0),
      downloadCount: Math.max(0, share.downloadCount ?? 0),
      topFiles,
      lastDetailViewedAt: share.lastDetailViewedAt ?? null,
      lastDownloadedAt: share.lastDownloadedAt ?? null,
      lastDownloadedFile: share.lastDownloadedFile ?? null,
      downloadEvents: normalizeDownloadEvents(share.downloadEvents),
      detailViewEvents: normalizeTimestampEvents(share.detailViewEvents)
    };
  });

  const allDownloadEvents = shares.flatMap((share) => share.downloadEvents);
  const allDetailViewEvents = shares.flatMap((share) => share.detailViewEvents);
  const topFiles = new Map<string, number>();
  for (const share of shares) {
    for (const entry of share.topFiles) {
      topFiles.set(entry.file, (topFiles.get(entry.file) ?? 0) + entry.count);
    }
  }

  return {
    artifactVersion: "harness.tournament-public-share-analytics.v1",
    kind: "tournament-public-share-analytics",
    createdAt: new Date(now).toISOString(),
    totals: {
      shareCount: shares.length,
      activeShareCount: shares.filter((share) => !share.expired).length,
      expiredShareCount: shares.filter((share) => share.expired).length,
      packMissingCount: shares.filter((share) => !share.packFound).length,
      detailViewCount: shares.reduce((sum, share) => sum + share.detailViewCount, 0),
      downloadCount: shares.reduce((sum, share) => sum + share.downloadCount, 0)
    },
    topFiles: [...topFiles.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([file, count]) => ({ file, count })),
    downloadsByMinute: bucketEventsByMinute(allDownloadEvents.map((event) => event.at)),
    detailViewsByMinute: bucketEventsByMinute(allDetailViewEvents),
    shares: shares.map(({ downloadEvents: _downloadEvents, detailViewEvents: _detailViewEvents, ...share }) => share)
  };
}


function renderTournamentPublicShareAnalyticsSummaryMarkdown(summary: TournamentPublicShareAnalyticsSummary): string {
  const lines = [
    "# Tournament Public Share Analytics",
    "",
    `- artifactVersion: \`${summary.artifactVersion}\``,
    `- createdAt: \`${summary.createdAt}\``,
    "",
    "## Totals",
    "",
    `| metric | value |`,
    `| --- | ---: |`,
    `| shares | ${summary.totals.shareCount} |`,
    `| active | ${summary.totals.activeShareCount} |`,
    `| expired | ${summary.totals.expiredShareCount} |`,
    `| pack missing | ${summary.totals.packMissingCount} |`,
    `| detail views | ${summary.totals.detailViewCount} |`,
    `| downloads | ${summary.totals.downloadCount} |`,
    "",
    "## Top Files",
    ""
  ];
  if (!summary.topFiles.length) {
    lines.push("_No downloads recorded._", "");
  } else {
    lines.push("| file | downloads |", "| --- | ---: |");
    for (const entry of summary.topFiles) {
      lines.push(`| \`${entry.file}\` | ${entry.count} |`);
    }
    lines.push("");
  }
  lines.push("## Shares", "");
  if (!summary.shares.length) {
    lines.push("_No public shares registered._", "");
  } else {
    lines.push(
      "| share | label | pack | views | downloads | last file | status |",
      "| --- | --- | --- | ---: | ---: | --- | --- |"
    );
    for (const share of summary.shares) {
      const status = share.expired ? "expired" : share.packFound ? "active" : "pack-missing";
      lines.push(
        `| \`${share.shareId.slice(0, 12)}\` | ${share.label ?? "-"} | \`${share.artifactSetId.slice(0, 12)}\` | ${share.detailViewCount} | ${share.downloadCount} | \`${share.lastDownloadedFile ?? "-"}\` | ${status} |`
      );
    }
    lines.push("");
  }
  lines.push("## Recent Download Minutes", "");
  if (!summary.downloadsByMinute.length) {
    lines.push("_No download minute buckets._", "");
  } else {
    lines.push("| minute | downloads |", "| --- | ---: |");
    for (const bucket of summary.downloadsByMinute.slice(-20)) {
      lines.push(`| \`${bucket.minute}\` | ${bucket.count} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseOptionalShareExpiresAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "expiresAt must be an ISO-8601 string or null.");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new HttpError(400, "expiresAt must be a valid ISO-8601 timestamp.");
  if (ms <= Date.now()) throw new HttpError(400, "expiresAt must be in the future.");
  return new Date(ms).toISOString();
}

function parseOptionalShareRelativeFiles(
  value: unknown,
  artifactSet: StoredTournamentArtifactSet
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const files = stringArrayField({ relativeFiles: value }, "relativeFiles");
  if (!files) throw new HttpError(400, "relativeFiles must be a non-empty string array when provided.");
  const registered = new Set(flattenTournamentArtifactFiles(artifactSet.relativeFiles));
  const unique = [...new Set(files.map((file) => normalizeRequestedArtifactPath(file)))];
  for (const file of unique) {
    if (!registered.has(file)) {
      throw new HttpError(400, "relativeFiles must only include registered tournament artifact files.");
    }
  }
  return unique;
}

async function loadTournamentPublicShareIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(tournamentPublicShareIndexPath(root), "utf8")) as unknown;
  } catch (error) {
    if (isFileReadNotFound(error)) return;
    throw new HttpError(500, "Tournament public share index could not be read.");
  }
  if (!isRecord(parsed) || parsed.kind !== "tournament-public-share-index" || !Array.isArray(parsed.shares)) {
    return;
  }
  for (const record of parsed.shares) {
    const share = tournamentPublicShareFromUnknown(record);
    if (!share) continue;
    if (!getTournamentPublicShare(share.id)) {
      saveTournamentPublicShare(share);
    }
  }
  pruneAllTournamentPublicShareEvents(activePublicShareEventRetention);
}

async function writeTournamentPublicShareIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await mkdir(root, { recursive: true });
  const shares = listTournamentPublicShares().map((share) => ({
    id: share.id,
    artifactSetId: share.artifactSetId,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    label: share.label ?? null,
    relativeFiles: share.relativeFiles ?? null,
    projection: share.projection ?? null,
    detailViewCount: Math.max(0, share.detailViewCount ?? 0),
    downloadCount: Math.max(0, share.downloadCount ?? 0),
    downloadsByFile: normalizeDownloadsByFile(share.downloadsByFile),
    downloadEvents: normalizeDownloadEvents(share.downloadEvents),
    detailViewEvents: normalizeTimestampEvents(share.detailViewEvents),
    lastDetailViewedAt: share.lastDetailViewedAt ?? null,
    lastDownloadedAt: share.lastDownloadedAt ?? null,
    lastDownloadedFile: share.lastDownloadedFile ?? null
  }));
  const index = {
    artifactVersion: "harness.tournament-public-share-index.v1",
    kind: "tournament-public-share-index",
    updatedAt: new Date().toISOString(),
    shares
  };
  await writeFile(tournamentPublicShareIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

function tournamentPublicShareIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), TOURNAMENT_PUBLIC_SHARE_INDEX_FILE);
}

function tournamentPublicShareFromUnknown(value: unknown): StoredTournamentPublicShare | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const artifactSetId = stringField(value, "artifactSetId");
  const createdAt = stringField(value, "createdAt");
  if (!id || !artifactSetId || !createdAt) return null;
  if (!/^[0-9a-f]{48}$/i.test(id)) return null;
  const expiresAtRaw = value.expiresAt;
  let expiresAt: string | null = null;
  if (expiresAtRaw !== null && expiresAtRaw !== undefined) {
    if (typeof expiresAtRaw !== "string" || !Number.isFinite(Date.parse(expiresAtRaw))) return null;
    expiresAt = expiresAtRaw;
  }
  const label = typeof value.label === "string" && value.label.length > 0 ? value.label : undefined;
  let relativeFiles: string[] | undefined;
  if (value.relativeFiles !== null && value.relativeFiles !== undefined) {
    const parsed = stringArrayField(value, "relativeFiles");
    if (!parsed) return null;
    relativeFiles = parsed;
  }
  const detailViewCount = nonNegativeIntegerField(value, "detailViewCount") ?? 0;
  const downloadCount = nonNegativeIntegerField(value, "downloadCount") ?? 0;
  const downloadsByFile = normalizeDownloadsByFile(value.downloadsByFile);
  const downloadEvents = normalizeDownloadEvents(value.downloadEvents);
  const detailViewEvents = normalizeTimestampEvents(value.detailViewEvents);
  const lastDetailViewedAt = optionalIsoTimestampField(value, "lastDetailViewedAt");
  const lastDownloadedAt = optionalIsoTimestampField(value, "lastDownloadedAt");
  const lastDownloadedFile =
    typeof value.lastDownloadedFile === "string" && value.lastDownloadedFile.length > 0
      ? value.lastDownloadedFile
      : null;
  return {
    id,
    artifactSetId,
    createdAt,
    expiresAt,
    label,
    relativeFiles,
    projection: tournamentProjectionFromUnknown(value.projection),
    detailViewCount,
    downloadCount,
    downloadsByFile,
    downloadEvents,
    detailViewEvents,
    lastDetailViewedAt,
    lastDownloadedAt,
    lastDownloadedFile
  };
}

function normalizeDownloadsByFile(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key || typeof key !== "string") continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) continue;
    out[key] = raw;
  }
  return out;
}

function normalizeDownloadEvents(value: unknown): Array<{ at: string; file: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ at: string; file: string }> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const at = typeof item.at === "string" && Number.isFinite(Date.parse(item.at)) ? item.at : null;
    const file = typeof item.file === "string" && item.file.length > 0 ? item.file : null;
    if (!at || !file) continue;
    out.push({ at, file });
  }
  return retainDownloadEvents(out, activePublicShareEventRetention);
}

function normalizeTimestampEvents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !Number.isFinite(Date.parse(item))) continue;
    out.push(item);
  }
  return retainTimestampEvents(out, activePublicShareEventRetention);
}

function bucketEventsByMinute(timestamps: string[]): Array<{ minute: string; count: number }> {
  const counts = new Map<string, number>();
  for (const timestamp of timestamps) {
    const ms = Date.parse(timestamp);
    if (!Number.isFinite(ms)) continue;
    const minute = new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
    counts.set(minute, (counts.get(minute) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([minute, count]) => ({ minute, count }));
}

function nonNegativeIntegerField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function optionalIsoTimestampField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function tournamentArtifactDownloads(set: StoredTournamentArtifactSet): StoredTournamentArtifactFiles {
  return mapTournamentArtifactFiles(set.relativeFiles, (relativePath) => tournamentArtifactDownloadUrl(set.id, relativePath));
}

function serializeExperimentMatrixArtifactSet(set: StoredExperimentMatrixArtifactSet): object {
  return {
    artifactSetId: set.id,
    id: set.id,
    createdAt: set.createdAt,
    matrixId: set.matrixId,
    files: set.relativeFiles,
    downloads: experimentMatrixArtifactDownloads(set)
  };
}

function experimentMatrixArtifactDownloads(set: StoredExperimentMatrixArtifactSet): StoredExperimentMatrixArtifactFiles {
  return mapExperimentMatrixArtifactFiles(set.relativeFiles, (relativePath) => experimentMatrixArtifactDownloadUrl(set.id, relativePath));
}

function tournamentArtifactDownloadUrl(artifactSetId: string, relativePath: string): string {
  return `/api/tournament-artifacts/${encodeURIComponent(artifactSetId)}/files/${relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function experimentMatrixArtifactDownloadUrl(artifactSetId: string, relativePath: string): string {
  return `/api/experiments/matrix/artifacts/${encodeURIComponent(artifactSetId)}/files/${relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function relativeTournamentArtifactFiles(written: TournamentArtifactWriteResult): StoredTournamentArtifactFiles {
  if (!("registry" in written.files)) {
    return {
      manifest: relativeArtifactPath(written.outputDir, written.files.manifest),
      episodes: relativeArtifactPath(written.outputDir, written.files.episodes),
      matches: written.files.matches.map((file) => relativeArtifactPath(written.outputDir, file))
    } satisfies StoredPublicTournamentArtifactFiles;
  }
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
    tournamentComparison: relativeArtifactPath(written.outputDir, written.files.tournamentComparison),
    tournamentComparisonMarkdown: relativeArtifactPath(written.outputDir, written.files.tournamentComparisonMarkdown),
    summaryMarkdown: relativeArtifactPath(written.outputDir, written.files.summaryMarkdown),
    episodesCsv: relativeArtifactPath(written.outputDir, written.files.episodesCsv),
    agentsCsv: relativeArtifactPath(written.outputDir, written.files.agentsCsv),
    metricsCsv: relativeArtifactPath(written.outputDir, written.files.metricsCsv),
    leaderboardCsv: relativeArtifactPath(written.outputDir, written.files.leaderboardCsv),
    matches: written.files.matches.map((file) => relativeArtifactPath(written.outputDir, file)),
    matchesJsonl: written.files.matchesJsonl.map((file) => relativeArtifactPath(written.outputDir, file))
  } satisfies StoredResearchTournamentArtifactFiles;
}

function relativeExperimentMatrixArtifactFiles(
  written: ExperimentMatrixArtifactWriteResult
): StoredExperimentMatrixArtifactFiles {
  return {
    manifest: relativeArtifactPath(written.outputDir, written.files.manifest),
    specNormalized: relativeArtifactPath(written.outputDir, written.files.specNormalized),
    cells: relativeArtifactPath(written.outputDir, written.files.cells),
    statistics: relativeArtifactPath(written.outputDir, written.files.statistics),
    summaryMarkdown: relativeArtifactPath(written.outputDir, written.files.summaryMarkdown),
    modelStatsCsv: relativeArtifactPath(written.outputDir, written.files.modelStatsCsv),
    profileStatsCsv: relativeArtifactPath(written.outputDir, written.files.profileStatsCsv),
    pairwiseModelComparisonsCsv: relativeArtifactPath(written.outputDir, written.files.pairwiseModelComparisonsCsv),
    // Matrix writer already returns nested tournament manifests relative to the
    // matrix root. Validate those strings rather than treating them as cwd paths.
    tournaments: written.files.tournaments.map((file) => ({
      cellId: file.cellId,
      manifest: normalizeRequestedArtifactPath(file.manifest.split(path.sep).join("/"))
    }))
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
  if (!("registry" in files)) {
    return {
      manifest: mapFile(files.manifest),
      episodes: mapFile(files.episodes),
      matches: files.matches.map(mapFile)
    } satisfies StoredPublicTournamentArtifactFiles;
  }
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
    tournamentComparison: mapFile(files.tournamentComparison),
    tournamentComparisonMarkdown: mapFile(files.tournamentComparisonMarkdown),
    summaryMarkdown: mapFile(files.summaryMarkdown),
    episodesCsv: mapFile(files.episodesCsv),
    agentsCsv: mapFile(files.agentsCsv),
    metricsCsv: mapFile(files.metricsCsv),
    leaderboardCsv: mapFile(files.leaderboardCsv),
    matches: files.matches.map(mapFile),
    matchesJsonl: files.matchesJsonl.map(mapFile)
  } satisfies StoredResearchTournamentArtifactFiles;
}

function mapExperimentMatrixArtifactFiles(
  files: StoredExperimentMatrixArtifactFiles,
  mapFile: (relativePath: string) => string
): StoredExperimentMatrixArtifactFiles {
  return {
    manifest: mapFile(files.manifest),
    specNormalized: mapFile(files.specNormalized),
    cells: mapFile(files.cells),
    statistics: mapFile(files.statistics),
    summaryMarkdown: mapFile(files.summaryMarkdown),
    modelStatsCsv: mapFile(files.modelStatsCsv),
    profileStatsCsv: mapFile(files.profileStatsCsv),
    pairwiseModelComparisonsCsv: mapFile(files.pairwiseModelComparisonsCsv),
    tournaments: files.tournaments.map((file) => ({ cellId: file.cellId, manifest: mapFile(file.manifest) }))
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

async function resolveRegisteredExperimentMatrixArtifactFile(
  set: StoredExperimentMatrixArtifactSet,
  requestedPath: string | undefined,
  baseDir: string | undefined
): Promise<{ relativePath: string; absolutePath: string }> {
  const relativePath = normalizeRequestedArtifactPath(requestedPath);
  if (!registeredExperimentMatrixArtifactFiles(set).has(relativePath)) {
    throw new HttpError(404, "experiment matrix artifact file not found");
  }
  const absolutePath = resolveUnderDirectory(set.outputDir, relativePath);
  await assertRegularFileInsideArtifactSet({ baseDir, outputDir: set.outputDir, absolutePath });
  return { relativePath, absolutePath };
}

function registeredTournamentArtifactFiles(set: StoredTournamentArtifactSet): Set<string> {
  return new Set(flattenTournamentArtifactFiles(set.relativeFiles));
}

function registeredExperimentMatrixArtifactFiles(set: StoredExperimentMatrixArtifactSet): Set<string> {
  return new Set(flattenExperimentMatrixArtifactFiles(set.relativeFiles));
}

function flattenTournamentArtifactFiles(files: StoredTournamentArtifactFiles): string[] {
  if (!("registry" in files)) {
    return [files.manifest, files.episodes, ...files.matches];
  }
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
    files.tournamentComparison,
    files.tournamentComparisonMarkdown,
    files.summaryMarkdown,
    files.episodesCsv,
    files.agentsCsv,
    files.metricsCsv,
    files.leaderboardCsv,
    ...files.matches,
    ...files.matchesJsonl
  ];
}

function flattenExperimentMatrixArtifactFiles(files: StoredExperimentMatrixArtifactFiles): string[] {
  return [
    files.manifest,
    files.specNormalized,
    files.cells,
    files.statistics,
    files.summaryMarkdown,
    files.modelStatsCsv,
    files.profileStatsCsv,
    files.pairwiseModelComparisonsCsv,
    ...files.tournaments.map((file) => file.manifest)
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
  if (relativePath.endsWith(".csv")) return "text/csv";
  if (relativePath.endsWith(".md")) return "text/markdown";
  return "application/octet-stream";
}

function isFileReadNotFound(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR");
}

function serializeExperimentRunIndexEntry(entry: HarnessExperimentRunStoreEntry): object {
  return {
    artifactVersion: "server.experiment-run-status.v1",
    kind: "experiment-run-status",
    runSetId: entry.runSetId,
    specId: entry.specId,
    specHash: entry.specHash,
    domainId: entry.domainId,
    state: entry.state,
    revision: entry.revision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    gamesRequested: entry.gamesRequested,
    gamesCompleted: entry.gamesCompleted,
    gamesTruncated: entry.gamesTruncated,
    gamesFailed: entry.gamesFailed,
    gamesInFlight: entry.gamesInFlight ?? 0,
    gamesUnstarted: entry.gamesUnstarted
  };
}

function serializeExperimentRunRecord(record: HarnessExperimentRunRecord): object {
  return {
    artifactVersion: "server.experiment-run-status.v1",
    kind: "experiment-run-status",
    runSetId: record.runSetId,
    specId: record.experiment.specId,
    specHash: record.experiment.specHash,
    domainId: record.experiment.spec.domainId,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    gamesRequested: record.gamesRequested,
    gamesCompleted: record.gamesCompleted,
    gamesTruncated: record.gamesTruncated,
    gamesFailed: record.gamesFailed,
    gamesInFlight: record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 ? record.gamesInFlight : 0,
    gamesUnstarted: record.gamesUnstarted,
    currentEpisode: record.schemaVersion === HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2 && record.currentEpisode
      ? structuredClone(record.currentEpisode)
      : null,
    episodes: record.episodes.map((episode) => ({
      index: episode.index,
      seed: episode.seed,
      status: episode.status,
      runId: episode.runId ?? null,
      artifactSha256: episode.artifactSha256 ?? null,
      metricCount: episode.metricCount,
      failureCount: episode.failureCount,
      evaluationReportId: episode.evaluationReportId ?? null,
      evaluationReportSha256: episode.evaluationReportSha256 ?? null,
      error: episode.error ?? null
    }))
  };
}

function serializeTournamentEpisodeSummaryForApi(episode: TournamentEpisode): object {
  const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? []);
  const promotionSummary = summarizeTournamentMetricPromotionsFromMetrics(
    episode.evaluationReport?.metrics ?? [],
    legacyMetricPromotionPolicyFromSummary(episode.evaluationReport?.summary.promotion)
  );
  return {
    index: episode.index,
    seed: episode.seed,
    runId: episode.runId,
    matchId: episode.matchId,
    status: episode.status,
    harnessStatus: episode.harnessStatus,
    jointPhaseScheduler: episode.jointPhaseScheduler ?? null,
    winner: episode.winner ?? null,
    phase: episode.phase ?? null,
    day: episode.day ?? null,
    forkOf: episode.forkOf ? summarizeForkProvenance(episode.forkOf) : null,
    nativeSteps: stepCounts.nativeSteps,
    committedSteps: stepCounts.committedSteps,
    rejectedSteps: stepCounts.rejectedSteps,
    metricCount: episode.evaluationReport?.metricCount ?? promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    metricSummary: episode.metrics
      ? {
          harnessTurnCount: episode.metrics.harnessTurnCount,
          harnessErrorCount: episode.metrics.harnessErrorCount,
          totalSpeeches: episode.metrics.totalSpeeches,
          totalVotes: episode.metrics.totalVotes,
          totalDeaths: episode.metrics.totalDeaths,
          averageLatencyMs: episode.metrics.averageLatencyMs,
          ...stepCounts
        }
      : episode.socialEpisode
        ? stepCounts
        : null,
    evaluationSummary: episode.evaluation
      ? {
          winner: episode.evaluation.winner ?? null,
          trajectorySteps: episode.evaluation.trajectory.length,
          agentRewardCount: episode.evaluation.agentRewards.length,
          ...stepCounts
        }
      : null,
    evaluationReportSummary: episode.evaluationReport
      ? {
          id: episode.evaluationReport.id,
          status: episode.evaluationReport.status ?? "completed",
          evaluatorFailureCount: episode.evaluationReport.failures?.length ?? 0,
          evaluatorIds: episode.evaluationReport.evaluatorIds,
          metricCount: episode.evaluationReport.metricCount,
          scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
          metricPromotionClassCounts: promotionSummary.byClass,
          scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
          ...summarizeEvaluationWarnings(episode.evaluationReport.warnings)
        }
      : null,
    agentCount: episode.agents.length,
    agents: (() => {
      const densityByActor = countSocialStepCommitsByActor(episode.socialEpisode?.steps ?? []);
      return episode.agents.map((agent) => {
        const density = densityByActor.get(agent.playerId) ?? {
          nativeSteps: 0,
          committedSteps: 0,
          rejectedSteps: 0
        };
        return {
          playerId: agent.playerId,
          seat: agent.seat,
          nativeSteps: density.nativeSteps,
          committedSteps: density.committedSteps,
          rejectedSteps: density.rejectedSteps
        };
      });
    })(),
    error: episode.error ? sanitizeApiErrorText(episode.error) : undefined,
    hasArtifact: Boolean(episode.artifact)
  };
}

function summarizeForkProvenance(forkOf: HarnessForkProvenance): object {
  return {
    schemaVersion: forkOf.schemaVersion,
    checkpointArtifactVersion: forkOf.checkpointArtifactVersion,
    checkpointId: forkOf.checkpointId,
    parentRunId: forkOf.parentRunId,
    parentMatchId: forkOf.parentMatchId,
    parentRulesetId: forkOf.parentRulesetId,
    parentBoundaryTraceRef: forkOf.parentBoundaryTraceId
      ? hashStableState({ traceId: forkOf.parentBoundaryTraceId }).slice(0, 16)
      : null,
    parentBoundaryTurnIndex: forkOf.parentBoundaryTurnIndex,
    parentStateHash: forkOf.parentStateHash,
    parentExecutionPrefixHash: forkOf.parentExecutionPrefixHash,
    parentAgentsHash: forkOf.parentAgentsHash,
    parentChannelsHash: forkOf.parentChannelsHash,
    parentMessagesHash: forkOf.parentMessagesHash,
    parentNativeStepCount: forkOf.parentNativeStepCount,
    parentMessageCount: forkOf.parentMessageCount,
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
  const stepTotals = episodes.reduce(
    (totals, episode) => {
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? []);
      totals.nativeSteps += stepCounts.nativeSteps;
      totals.committedSteps += stepCounts.committedSteps;
      totals.rejectedSteps += stepCounts.rejectedSteps;
      return totals;
    },
    { nativeSteps: 0, committedSteps: 0, rejectedSteps: 0 }
  );
  const promotionSummary = summarizeTournamentMetricPromotionsFromReports(
    episodes.flatMap((episode) => (episode.evaluationReport ? [episode.evaluationReport] : []))
  );

  return {
    gamesEvaluated: evaluations.length,
    gamesWithoutEvaluation: completed.length - evaluations.length,
    teamRewards: averageTeamRewards(evaluations),
    modelRewards: summarizeModelRewardsWithDensity(evaluated),
    // Public tournament summaries must not expose raw profile ids or policy names.
    // Profile-level density remains available through leaderboard/profileStats and CLI research exports.
    nativeSteps: stepTotals.nativeSteps,
    committedSteps: stepTotals.committedSteps,
    rejectedSteps: stepTotals.rejectedSteps,
    metricCount: promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    episodes: evaluated.map(({ episode, evaluation }) => {
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? []);
      const episodePromotion = summarizeTournamentMetricPromotionsFromMetrics(
        episode.evaluationReport?.metrics ?? [],
        legacyMetricPromotionPolicyFromSummary(episode.evaluationReport?.summary.promotion)
      );
      return {
        index: episode.index,
        seed: episode.seed,
        winner: evaluation.winner ?? episode.winner ?? null,
        teamRewards: evaluation.teamRewards,
        agentRewardCount: evaluation.agentRewards.length,
        trajectorySteps: evaluation.trajectory.length,
        metricCount: episode.evaluationReport?.metricCount ?? episodePromotion.metricCount,
        scorecardEligibleMetricCount: episodePromotion.scorecardEligibleCount,
        metricPromotionClassCounts: episodePromotion.byClass,
        scorecardEligibleMetricClassCounts: episodePromotion.scorecardEligibleByClass,
        ...stepCounts
      };
    })
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

function summarizeEvaluation(
  evaluation: AdversarialEvaluation | undefined,
  stepCounts?: { nativeSteps: number; committedSteps: number; rejectedSteps: number }
): object | null {
  if (!evaluation) return null;
  return {
    winner: evaluation.winner ?? null,
    teamRewards: evaluation.teamRewards,
    trajectorySteps: evaluation.trajectory.length,
    agentRewardCount: evaluation.agentRewards.length,
    voteAccuracyAgentCount: Object.keys(evaluation.voteAccuracyByAgent).length,
    influenceAgentCount: Object.keys(evaluation.influenceByAgent).length,
    deceptionAgentCount: Object.keys(evaluation.deceptionByAgent).length,
    ...(stepCounts ?? {})
  };
}

function summarizeEvaluationReport(report: HarnessEvaluationReport | undefined): object | null {
  if (!report) return null;
  const promotionSummary = summarizeTournamentMetricPromotionsFromMetrics(
    report.metrics ?? [],
    legacyMetricPromotionPolicyFromSummary(report.summary.promotion)
  );
  return {
    id: report.id,
    status: report.status ?? "completed",
    evaluatorFailureCount: report.failures?.length ?? 0,
    evaluatorIds: report.evaluatorIds,
    metricCount: report.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    ...summarizeEvaluationWarnings(report.warnings)
  };
}

function summarizeTournamentEvaluationReports(episodes: TournamentEpisodes): object {
  const reports = episodes.flatMap((episode) => (episode.evaluationReport ? [episode.evaluationReport] : []));
  const warningSummary = summarizeEvaluationWarnings(reports.flatMap((report) => report.warnings ?? []));
  const promotionSummary = summarizeTournamentMetricPromotionsFromReports(reports);
  return {
    reports: reports.length,
    completedReports: reports.filter((report) => (report.status ?? "completed") === "completed").length,
    incompleteReports: reports.filter((report) => (report.status ?? "completed") === "incomplete").length,
    evaluatorFailureCount: reports.reduce((sum, report) => sum + (report.failures?.length ?? 0), 0),
    metricCount: reports.reduce((sum, report) => sum + report.metricCount, 0),
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    ...warningSummary,
    reportsWithWarnings: reports.filter((report) => (report.warnings?.length ?? 0) > 0).length,
    evaluatorIds: Array.from(new Set(reports.flatMap((report) => report.evaluatorIds))),
    episodeScores: reports.map((report) => report.summary.episodeScore ?? null)
  };
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

function summarizeHarnessFailure(failure: ReturnType<typeof harnessFailureEvidenceFromEpisode>[number]): {
  seq: number;
  day: number;
  phase: string;
  actorId: string | null;
  model: string | null;
  actionKind: string | null;
  failureReason: string;
  providerFailure?: PublicProviderFailureSummary;
} {
  const payload = isRecord(failure.payload ?? failure.failure.metadata) ? (failure.payload ?? failure.failure.metadata) as Record<string, unknown> : {};
  const providerFailure = publicProviderFailureFromUnknown(payload.providerFailure);
  const rawMessage = typeof payload.message === "string" ? payload.message : failure.failure.message;
  const observation = isRecord(failure.step.observation) ? failure.step.observation : {};
  const view = isRecord(observation.view) ? observation.view : observation;
  return {
    seq: failure.turnIndex,
    day: typeof view.day === "number" ? view.day : 0,
    phase: typeof view.phase === "string" ? view.phase : "unknown",
    actorId: failure.actorId ?? null,
    model: typeof payload.model === "string" ? payload.model : null,
    actionKind: typeof payload.actionKind === "string" ? payload.actionKind : null,
    failureReason: providerFailure ? providerFailureApiMessage(providerFailure) : sanitizeApiErrorText(rawMessage),
    ...(providerFailure ? { providerFailure } : {})
  };
}

function parseOptionalJointPhaseScheduler(
  value: unknown
): "aec-batched-decision" | "parallel" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "aec-batched-decision" || value === "parallel") return value;
  throw new Error('jointPhaseScheduler must be "aec-batched-decision" or "parallel".');
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
        jointPhaseScheduler: record.jointPhaseScheduler as TournamentExperimentSpecV1["jointPhaseScheduler"],
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
    jointPhaseScheduler: process.env.WEREWOLF_JOINT_PHASE_SCHEDULER as TournamentExperimentSpecV1["jointPhaseScheduler"],
    timeout: process.env.TOURNAMENT_TIMEOUT_MS,
    temperature: process.env.AGENT_TEMPERATURE ?? 0.7
  });
}

function normalizeMatrixExperimentRequest(body: unknown): NormalizedMatrixExperiment {
  const record = isRecord(body) ? body : {};
  const specInput = record.spec ?? record;
  const overrides = removeUndefined({
    models: record.models,
    profiles: record.profiles,
    assignment: record.assignment as TournamentExperimentSpecV1["assignment"],
    seed: typeof record.seed === "string" ? record.seed : undefined,
    games: record.games,
    maxTransitions: record.maxTransitions ?? record.steps,
    jointPhaseScheduler: record.jointPhaseScheduler as TournamentExperimentSpecV1["jointPhaseScheduler"],
    timeout: record.timeoutMs ?? record.timeout,
    temperature: record.temperature,
    json: record.json as TournamentExperimentSpecV1["json"],
    continueOnError: record.continueOnError,
    config: record.config as TournamentExperimentSpecV1["config"]
  }) as Partial<TournamentExperimentSpecV1>;
  return normalizeMatrixExperimentSpec(mergeMatrixExperimentOverrides(specInput, overrides), {
    models: normalizeModelList(process.env.LLM_MODELS),
    profiles: process.env.AGENT_PROFILES,
    assignment: process.env.AGENT_ASSIGNMENT,
    games: 3,
    maxTransitions: process.env.MATCH_MAX_TRANSITIONS,
    jointPhaseScheduler: process.env.WEREWOLF_JOINT_PHASE_SCHEDULER as TournamentExperimentSpecV1["jointPhaseScheduler"],
    timeout: process.env.TOURNAMENT_TIMEOUT_MS,
    temperature: process.env.AGENT_TEMPERATURE ?? 0.7
  });
}

function matrixExperimentTimeoutMs(experiment: NormalizedMatrixExperiment): number | undefined {
  const timeouts = experiment.cells.map((cell) => cell.tournament.timeoutMs);
  if (timeouts.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) return undefined;
  return (timeouts as number[]).reduce((sum, value) => sum + value, 0);
}

function matrixGamesTruncated(cell: ExperimentMatrixCellResult): number {
  return cell.tournament?.gamesTruncated ?? cell.tournament?.episodes.filter((episode) => episode.status === "truncated").length ?? 0;
}

function serializeExperimentMatrixCellSummaryForApi(cell: ExperimentMatrixCellResult): object {
  return {
    index: cell.index,
    id: cell.id,
    label: cell.label,
    group: cell.group,
    status: cell.status,
    elapsedMs: cell.elapsedMs,
    tournamentSeed: cell.tournament?.seed ?? null,
    gamesRequested: cell.tournament?.gamesRequested ?? 0,
    gamesCompleted: cell.tournament?.gamesCompleted ?? 0,
    gamesTruncated: matrixGamesTruncated(cell),
    gamesFailed: cell.tournament?.gamesFailed ?? 0,
    jointPhaseScheduler: cell.tournament?.experiment.jointPhaseScheduler ?? null,
    models: cell.tournament?.models ?? [],
    profileCount: cell.tournament?.profiles.length ?? 0,
    episodes: cell.tournament?.episodes.map(serializeTournamentEpisodeSummaryForApi) ?? [],
    error: cell.error ? sanitizeApiErrorText(cell.error) : null,
    hasArtifacts: Boolean(cell.tournament?.artifacts?.length)
  };
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
