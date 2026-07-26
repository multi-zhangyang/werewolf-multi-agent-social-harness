import { providerDiagnosticSummaryFromEnv } from "../agents/providerRegistry";
import type { GameState, MatchMetrics } from "../core/types";
import { serializePublicState } from "../core/view";
import { legacyMetricPromotionPolicyFromSummary, summarizeEvaluationWarnings } from "../harness/evaluation";
import { harnessFailureEvidenceFromEpisode } from "../harness/executionEvidence";
import type { ExperimentMatrixCellResult, ExperimentMatrixResult } from "../harness/experimentMatrix";
import {
  HARNESS_EXPERIMENT_RUN_RECORD_VERSION_V2,
  type HarnessExperimentRunRecord,
  type HarnessExperimentRunStoreEntry
} from "../harness/experimentRunStore";
import { hashStableState } from "../harness/hash";
import type { HarnessAssignmentConfig, ResolvedAgentAssignment } from "../harness/profiles";
import { replayWerewolfSocialEpisode } from "../harness/replay";
import { probeHarnessTurn } from "../harness/runtime";
import { countSocialStepCommits, countSocialStepCommitsByActor } from "../harness/social";
import { type TournamentResult, runTournament } from "../harness/tournament";
import {
  summarizeTournamentExecutionTelemetry,
  summarizeTournamentMetricPromotionsFromMetrics,
  summarizeTournamentMetricPromotionsFromReports
} from "../harness/tournamentArtifacts";
import { averageTeamRewards, summarizeModelRewardsWithDensity } from "../harness/tournamentEvaluationSummary";
import {
  type AdversarialEvaluation,
  DEFAULT_WEREWOLF_JOINT_PHASE_SCHEDULER,
  type HarnessAgentProfile,
  type HarnessEvaluationReport,
  type HarnessRunResult,
  type HarnessTurnTrace,
  type ProviderFailureSummary
} from "../harness/types";
import {
  type PublicApiFailure,
  type PublicProviderFailureSummary,
  providerFailureApiMessage,
  publicHarnessFailureReason,
  publicProviderFailureFromUnknown,
  publicProviderFailureSummary,
  sanitizeApiErrorText
} from "./apiFailure";
import { mapExperimentMatrixArtifactFiles, mapTournamentArtifactFiles } from "./artifactFiles";
import { summarizeForkProvenance } from "./checkpointDto";
import type { LiveMatchStartResponse } from "./context";
import { isRecord } from "./jsonUtil";
import {
  type StoredExperimentMatrixArtifactFiles,
  type StoredExperimentMatrixArtifactSet,
  type StoredMatch,
  type StoredTournamentArtifactFiles,
  type StoredTournamentArtifactSet,
  countCheckpointsForMatch
} from "./store";

export function buildMatchSummary(
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

export function serializeStoredMatch(match: StoredMatch): object {
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

export function serializeLiveMatchStart(matchId: string): LiveMatchStartResponse {
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
export function publicStoredMatchFailure(match: StoredMatch): PublicApiFailure | undefined {
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

export function buildProbeSummary(options: {
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

export function buildProbePublicDiagnostic(trace: HarnessTurnTrace): object {
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

export function serializeSocialReplayResult(
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

export function sanitizeReplayMismatch(message: string, index: number): string {
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

export function summarizeReplayMismatchCodes(mismatches: string[]): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const mismatch of mismatches) {
    const code = classifyReplayMismatch(mismatch);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

export function classifyReplayMismatch(message: string): string {
  if (message.includes("pending action")) return "pending_unavailable";
  if (message.includes("preStateHash mismatch")) return "pre_state_hash";
  if (message.includes("does not match pending")) return "command_kind";
  if (message.includes("command application failed")) return "command_application";
  if (message.includes("eventSeqRange mismatch")) return "event_seq_range";
  if (message.includes("postStateHash mismatch")) return "post_state_hash";
  if (message.includes("finalHash mismatch")) return "final_hash";
  return "unknown";
}

export function buildTournamentSummary(
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

export function buildExperimentMatrixSummary(
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

export function serializeTournamentArtifactSet(set: StoredTournamentArtifactSet): object {
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

export function tournamentArtifactDownloads(set: StoredTournamentArtifactSet): StoredTournamentArtifactFiles {
  return mapTournamentArtifactFiles(set.relativeFiles, (relativePath) => tournamentArtifactDownloadUrl(set.id, relativePath));
}

export function serializeExperimentMatrixArtifactSet(set: StoredExperimentMatrixArtifactSet): object {
  return {
    artifactSetId: set.id,
    id: set.id,
    createdAt: set.createdAt,
    matrixId: set.matrixId,
    files: set.relativeFiles,
    downloads: experimentMatrixArtifactDownloads(set)
  };
}

export function experimentMatrixArtifactDownloads(set: StoredExperimentMatrixArtifactSet): StoredExperimentMatrixArtifactFiles {
  return mapExperimentMatrixArtifactFiles(set.relativeFiles, (relativePath) => experimentMatrixArtifactDownloadUrl(set.id, relativePath));
}

export function tournamentArtifactDownloadUrl(artifactSetId: string, relativePath: string): string {
  return `/api/tournament-artifacts/${encodeURIComponent(artifactSetId)}/files/${relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function experimentMatrixArtifactDownloadUrl(artifactSetId: string, relativePath: string): string {
  return `/api/experiments/matrix/artifacts/${encodeURIComponent(artifactSetId)}/files/${relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function serializeExperimentRunIndexEntry(entry: HarnessExperimentRunStoreEntry): object {
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

export function serializeExperimentRunRecord(record: HarnessExperimentRunRecord): object {
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

export function serializeTournamentEpisodeSummaryForApi(episode: TournamentEpisode): object {
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

export type TournamentEpisodes = Awaited<ReturnType<typeof runTournament>>["episodes"];

export type TournamentEpisode = TournamentEpisodes[number];

export function summarizeTournamentEvaluation(episodes: TournamentEpisodes): object {
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

export function getEpisodeEvaluation(episode: TournamentEpisode): AdversarialEvaluation | undefined {
  const evaluation = (episode as TournamentEpisode & { evaluation?: unknown }).evaluation;
  return isAdversarialEvaluation(evaluation) ? evaluation : undefined;
}

export function isAdversarialEvaluation(value: unknown): value is AdversarialEvaluation {
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

export function summarizeEvaluation(
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

export function summarizeEvaluationReport(report: HarnessEvaluationReport | undefined): object | null {
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

export function summarizeTournamentEvaluationReports(episodes: TournamentEpisodes): object {
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

export function summarizePublicAssignmentConfig(assignment: HarnessAssignmentConfig | undefined): object | null {
  if (!assignment) return null;
  return {
    strategy: assignment.strategy ?? null,
    fallback: assignment.fallback ?? null,
    seatAssignmentCount: assignment.seats ? Object.keys(assignment.seats).length : 0,
    roleAssignmentCount: assignment.roles ? Object.keys(assignment.roles).length : 0,
    teamAssignmentCount: assignment.teams ? Object.keys(assignment.teams).length : 0
  };
}

export function summarizePublicAssignment(assignment: ResolvedAgentAssignment): object {
  return {
    playerId: assignment.playerId,
    seat: assignment.seat
  };
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function summarizeModelUsage(metrics: MatchMetrics): Record<string, object> {
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

export function summarizeHarnessFailure(failure: ReturnType<typeof harnessFailureEvidenceFromEpisode>[number]): {
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

export function modelsFromProfiles(profiles: HarnessAgentProfile[]): string[] {
  return Array.from(new Set(profiles.map((profile) => profile.model.trim()).filter(Boolean)));
}

export function matrixGamesTruncated(cell: ExperimentMatrixCellResult): number {
  return cell.tournament?.gamesTruncated ?? cell.tournament?.episodes.filter((episode) => episode.status === "truncated").length ?? 0;
}

export function serializeExperimentMatrixCellSummaryForApi(cell: ExperimentMatrixCellResult): object {
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
