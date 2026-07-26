import { isRecord } from "./ioSupport";
import { isProviderFailureKind } from "../../agents/schema";
import { MatchArtifact, TrajectoryJsonlSource, toTrajectoryJsonl, validateMatchArtifactIntegrity } from "../artifacts";
import { resolveRecordedMetricPromotion, summarizeEvaluationWarnings } from "../evaluation";
import { harnessFailureEvidenceFromEpisode } from "../executionEvidence";
import { countSocialStepCommits, countSocialStepCommitsByActor, isSocialStepCommitted } from "../social";
import { TournamentEpisode, TournamentMatchArtifactRecord, TournamentResult } from "../tournament";
import { ProviderFailureSummary } from "../types";
import { TournamentFailureAttribution, promotionFallbackPolicyForReport } from "./model";
import { forkOfForEpisode, summarizeForkOf, summarizeTournamentMetricPromotionsFromMetrics } from "./summary";
export function episodeRecord(
  episode: TournamentEpisode,
  matchPath?: string,
  matchJsonlPath?: string,
  artifact?: MatchArtifact,
  redactTruth = false
): object {
  const resolvedAssignments = redactTruth
    ? episode.resolvedAssignments.map((assignment) => {
        const { role: _role, team: _team, ...rest } = assignment;
        return rest;
      })
    : episode.resolvedAssignments;
  const densityByActor = countSocialStepCommitsByActor(
    episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []
  );
  const profileExecution = profileExecutionRecords(episode, artifact);
  const agents = episode.agents.map((agent) => {
    const density = densityByActor.get(agent.playerId) ?? {
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0
    };
    const withDensity = {
      ...agent,
      nativeSteps: density.nativeSteps,
      committedSteps: density.committedSteps,
      rejectedSteps: density.rejectedSteps
    };
    if (!redactTruth) return withDensity;
    const { role: _role, team: _team, won: _won, ...rest } = withDensity;
    return rest;
  });
  const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
  const promotionSummary = summarizeTournamentMetricPromotionsFromMetrics(
    episode.evaluationReport?.metrics ?? [],
    promotionFallbackPolicyForReport(episode.evaluationReport)
  );
  return {
    type: "episode",
    episodeIndex: episode.index,
    tournamentEpisodeIndex: episode.index,
    index: episode.index,
    seed: episode.seed,
    runId: episode.runId ?? null,
    matchId: episode.matchId ?? null,
    status: episode.status,
    harnessStatus: episode.harnessStatus ?? null,
    jointPhaseScheduler: episode.jointPhaseScheduler ?? null,
    winner: redactTruth ? null : episode.winner ?? null,
    phase: episode.phase ?? null,
    day: episode.day ?? null,
    nativeSteps: stepCounts.nativeSteps,
    committedSteps: stepCounts.committedSteps,
    rejectedSteps: stepCounts.rejectedSteps,
    trajectorySteps: episode.trajectory?.length ?? artifact?.trajectory.length ?? 0,
    socialStatus: episode.socialEpisode?.status ?? null,
    messageCount: episode.socialEpisode?.messages.length ?? artifact?.socialEpisode.messages.length ?? 0,
    metricCount: episode.evaluationReport?.metricCount ?? promotionSummary.metricCount,
    scorecardEligibleMetricCount: promotionSummary.scorecardEligibleCount,
    metricPromotionClassCounts: promotionSummary.byClass,
    scorecardEligibleMetricClassCounts: promotionSummary.scorecardEligibleByClass,
    // Evaluation coverage is control-plane metadata, not hidden role truth.
    // Keep it in a truth-redacted research row so the persisted raw inputs can
    // distinguish a missing report from a completed report with zero failures.
    hasEvaluationReport: Boolean(episode.evaluationReport),
    evaluationStatus: episode.evaluationReport ? episode.evaluationReport.status ?? "completed" : null,
    evaluatorFailureCount: episode.evaluationReport?.failures?.length ?? 0,
    evaluationWarningCount: summarizeEvaluationWarnings(episode.evaluationReport?.warnings).warningCount,
    evaluationWarningCodes: summarizeEvaluationWarnings(episode.evaluationReport?.warnings).warningCodes.map((warning) => warning.code),
    warningSummary: summarizeEvaluationWarnings(episode.evaluationReport?.warnings),
    evaluatorIds: episode.evaluationReport?.evaluatorIds ?? [],
    forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
    assignment: episode.assignment ?? null,
    resolvedAssignments,
    agents,
    // This mirrors TournamentResult's historical profile aggregation exactly:
    // native density is attributed by step.profileId (falling back to the
    // actor's assigned profile), while harness turns are only committed
    // compatibility traces. Neither can safely be inferred from actor density.
    profileExecution,
    error: episode.error ?? null,
    matchArtifact: matchPath ?? null,
    matchJsonl: matchJsonlPath ?? null
  };
}

function profileExecutionRecords(
  episode: TournamentEpisode,
  artifact?: MatchArtifact
): Array<{
  profileId: string;
  model: string;
  harnessTurns: number;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
}> {
  const agentByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent]));
  const byProfile = new Map<
    string,
    {
      profileId: string;
      model: string;
      harnessTurns: number;
      nativeSteps: number;
      committedSteps: number;
      rejectedSteps: number;
    }
  >();
  const ensure = (profileId: string, model: string) => {
    const existing = byProfile.get(profileId);
    if (existing) return existing;
    const created = {
      profileId,
      model,
      harnessTurns: 0,
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0
    };
    byProfile.set(profileId, created);
    return created;
  };
  const steps = episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? [];
  for (const step of steps) {
    if (step.actorId === "system") continue;
    const actor = agentByPlayer.get(step.actorId);
    const profileId = step.profileId || actor?.profileId;
    if (!profileId) continue;
    const density = ensure(profileId, actor?.model ?? "unknown");
    density.nativeSteps += 1;
    if (isSocialStepCommitted(step)) density.committedSteps += 1;
    else density.rejectedSteps += 1;
  }
  for (const trace of episode.evaluation?.trajectory ?? []) {
    if (!trace.profileId) continue;
    ensure(trace.profileId, trace.model).harnessTurns += 1;
  }
  return [...byProfile.values()].sort((left, right) => left.profileId.localeCompare(right.profileId));
}

export function aggregateTrajectoryRecords(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  projectMatchArtifact?: (artifact: MatchArtifact) => unknown
): object[] {
  return artifactRecords.flatMap((record) => {
    const episode = result.episodes.find((item) => item.index === record.index);
    const sourceArtifact = projectMatchArtifact ? projectMatchArtifact(record.artifact) : record.artifact;
    return trajectoryRecordsFromArtifact(sourceArtifact).map((parsed) => {
      return {
        ...parsed,
        episodeIndex: record.index,
        tournamentEpisodeIndex: record.index,
        tournamentSeed: result.seed,
        episodeSeed: episode?.seed ?? record.seed,
        runId: typeof parsed.runId === "string" ? parsed.runId : record.runId,
        matchId: typeof parsed.matchId === "string" ? parsed.matchId : record.matchId ?? null
      };
    });
  });
}

export function trajectoryRecordsFromArtifact(artifact: unknown): Record<string, unknown>[] {
  return toTrajectoryJsonl(artifact as TrajectoryJsonlSource)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function aggregateMetricRecords(result: TournamentResult, redactTruth = false): object[] {
  return result.episodes.flatMap((episode) =>
    (episode.evaluationReport?.metrics ?? []).map((metric) => {
      const agents = episode.agents.map((agent) => {
        if (!redactTruth) {
          return {
            playerId: agent.playerId,
            profileId: agent.profileId,
            model: agent.model,
            role: agent.role,
            team: agent.team,
            seat: agent.seat
          };
        }
        return {
          playerId: agent.playerId,
          profileId: agent.profileId,
          model: agent.model,
          seat: agent.seat
        };
      });
      const subject =
        redactTruth && metric.subject && typeof metric.subject === "object"
          ? (() => {
              const { role: _role, team: _team, ...rest } = metric.subject as Record<string, unknown>;
              return rest;
            })()
          : metric.subject;
      const promotion = resolveRecordedMetricPromotion(metric, promotionFallbackPolicyForReport(episode.evaluationReport));
      return {
        type: "metric",
        episodeIndex: episode.index,
        tournamentEpisodeIndex: episode.index,
        tournamentSeed: result.seed,
        episodeSeed: episode.seed,
        runId: episode.runId ?? null,
        matchId: episode.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? null,
        agents,
        evaluationReportId: episode.evaluationReport?.id,
        ...metric,
        subject,
        promotionClass: promotion.promotionClass,
        scorecardEligible: promotion.eligibleForScorecard,
        promotionReasons: promotion.reasons,
        promotionDecisionId: promotion.catalogDecisionId ?? null,
        promotionPolicyId: promotion.policyId,
        promotionPolicyVersion: promotion.policyVersion,
        promotionPolicyHash: promotion.policyHash,
        promotionCatalogId: promotion.catalogId,
        promotionCatalogVersion: promotion.catalogVersion,
        promotionCatalogHash: promotion.catalogHash,
        promotionResolution: promotion.resolution
      };
    })
  );
}

export function aggregateIntegrityRecords(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  relativeMatchPaths: Map<number, string>,
  relativeMatchJsonlPaths: Map<number, string>
): Array<{
  type: "artifact_integrity";
  episodeIndex: number;
  tournamentEpisodeIndex: number;
  tournamentSeed: string;
  episodeSeed: string;
  runId: string;
  matchId: string | null;
  status: MatchArtifact["status"];
  ok: boolean;
  errorCount: number;
  errors: string[];
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  matchArtifact: string | null;
  matchJsonl: string | null;
}> {
  return artifactRecords.map((record) => {
    const episode = result.episodes.find((item) => item.index === record.index);
    const errors = validateMatchArtifactIntegrity(record.artifact);
    const stepCounts = countSocialStepCommits(
      episode?.socialEpisode?.steps ?? record.artifact.socialEpisode.steps ?? []
    );
    return {
      type: "artifact_integrity",
      episodeIndex: record.index,
      tournamentEpisodeIndex: record.index,
      tournamentSeed: result.seed,
      episodeSeed: episode?.seed ?? record.seed,
      runId: record.runId,
      matchId: record.matchId ?? null,
      status: record.artifact.status,
      ok: errors.length === 0,
      errorCount: errors.length,
      errors,
      nativeSteps: stepCounts.nativeSteps,
      committedSteps: stepCounts.committedSteps,
      rejectedSteps: stepCounts.rejectedSteps,
      matchArtifact: relativeMatchPaths.get(record.index) ?? null,
      matchJsonl: relativeMatchJsonlPaths.get(record.index) ?? null
    };
  });
}

export function aggregateFailureRecords(
  result: TournamentResult,
  artifactRecords: TournamentMatchArtifactRecord[],
  relativeMatchPaths: Map<number, string>,
  redactTruth = false
): object[] {
  const artifactsByIndex = new Map(artifactRecords.map((record) => [record.index, record.artifact]));
  const executionFailures = result.episodes
    .filter((episode) => episode.status === "failed" || episode.harnessStatus === "failed")
    .map((episode) => {
      const artifact = artifactsByIndex.get(episode.index);
      const failureAttributions = failureAttributionsForEpisode(episode, artifact, redactTruth);
      const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
      return {
        type: "failure",
        episodeIndex: episode.index,
        tournamentEpisodeIndex: episode.index,
        tournamentSeed: result.seed,
        episodeSeed: episode.seed,
        runId: episode.runId ?? artifact?.runId ?? null,
        matchId: episode.matchId ?? artifact?.matchId ?? null,
        status: episode.status,
        harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
        failureReason: episode.error ?? artifact?.failureReason ?? null,
        failureStateHash: artifact?.failureStateHash ?? null,
        forkOf: summarizeForkOf(forkOfForEpisode(episode, artifact)),
        nativeSteps: stepCounts.nativeSteps,
        committedSteps: stepCounts.committedSteps,
        rejectedSteps: stepCounts.rejectedSteps,
        harnessErrorCount: episode.metrics?.harnessErrorCount ?? artifact?.metrics.harnessErrorCount ?? null,
        primaryFailure: failureAttributions[0] ?? null,
        failureAttributions,
        agents: (() => {
          const densityByActor = countSocialStepCommitsByActor(
            episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []
          );
          return episode.agents.map((agent) => {
            const density = densityByActor.get(agent.playerId) ?? {
              nativeSteps: 0,
              committedSteps: 0,
              rejectedSteps: 0
            };
            const withDensity = {
              ...agent,
              nativeSteps: density.nativeSteps,
              committedSteps: density.committedSteps,
              rejectedSteps: density.rejectedSteps
            };
            if (!redactTruth) return withDensity;
            const { role: _role, team: _team, won: _won, ...rest } = withDensity;
            return rest;
          });
        })(),
        partialArtifact: relativeMatchPaths.get(episode.index) ?? null
      };
    });
  if (redactTruth) return executionFailures;

  const evaluatorFailures = result.episodes.flatMap((episode) => {
    const artifact = artifactsByIndex.get(episode.index);
    const report = episode.evaluationReport ?? artifact?.evaluationReport;
    if (!report?.failures?.length) return [];
    const stepCounts = countSocialStepCommits(episode.socialEpisode?.steps ?? artifact?.socialEpisode.steps ?? []);
    return report.failures.map((failure) => ({
      type: "evaluation_failure",
      episodeIndex: episode.index,
      tournamentEpisodeIndex: episode.index,
      tournamentSeed: result.seed,
      episodeSeed: episode.seed,
      runId: episode.runId ?? artifact?.runId ?? null,
      matchId: episode.matchId ?? artifact?.matchId ?? null,
      status: episode.status,
      harnessStatus: episode.harnessStatus ?? artifact?.status ?? null,
      evaluationStatus: report.status ?? "completed",
      evaluatorFailure: failure,
      nativeSteps: stepCounts.nativeSteps,
      committedSteps: stepCounts.committedSteps,
      rejectedSteps: stepCounts.rejectedSteps,
      partialArtifact: relativeMatchPaths.get(episode.index) ?? null
    }));
  });
  return [...executionFailures, ...evaluatorFailures];
}

export function failureAttributionsForEpisode(
  episode: TournamentEpisode,
  artifact?: MatchArtifact,
  redactTruth = false
): TournamentFailureAttribution[] {
  const agentByPlayer = new Map(episode.agents.map((agent) => [agent.playerId, agent]));
  return harnessFailureEvidenceFromEpisode(artifact?.socialEpisode)
    .map((failure) => {
      const payload = failure.payload ?? failurePayload(failure.failure.metadata);
      const actorId = failure.actorId ?? null;
      const agent = actorId ? agentByPlayer.get(actorId) : undefined;
      const providerFailure = payload.providerFailure ?? null;
      return {
        actorId,
        profileId: agent?.profileId ?? null,
        model: agent?.model ?? payload.model ?? null,
        seat: agent?.seat ?? null,
        role: redactTruth ? null : agent?.role ?? null,
        team: redactTruth ? null : agent?.team ?? null,
        policyName: agent?.policyName ?? null,
        actionKind: payload.actionKind ?? null,
        traceId: payload.traceId ?? failure.traceId ?? null,
        eventId: null,
        eventSeq: null,
        failureKind: providerFailure?.failureKind ?? null,
        providerStage: providerFailure?.providerStage ?? null,
        status: providerFailure?.status ?? null,
        timeoutMs: providerFailure?.timeoutMs ?? null,
        aborted: providerFailure?.aborted ?? null,
        retryable: providerFailure?.retryable ?? null,
        attempts: providerFailure?.attempts ?? null,
        maxAttempts: providerFailure?.maxAttempts ?? null,
        providerFailure,
        source: "social_step_failure"
      };
    });
}

function failurePayload(payload: unknown): {
  model?: string;
  actionKind?: string;
  traceId?: string;
  providerFailure?: ProviderFailureSummary;
} {
  if (!isRecord(payload)) return {};
  return {
    model: typeof payload.model === "string" ? payload.model : undefined,
    actionKind: typeof payload.actionKind === "string" ? payload.actionKind : undefined,
    traceId: typeof payload.traceId === "string" ? payload.traceId : undefined,
    providerFailure: providerFailurePayload(payload.providerFailure)
  };
}

function providerFailurePayload(value: unknown): ProviderFailureSummary | undefined {
  if (!isRecord(value)) return undefined;
  const failureKind = typeof value.failureKind === "string" ? value.failureKind : undefined;
  if (!isProviderFailureKind(failureKind)) return undefined;
  const summary: ProviderFailureSummary = { failureKind };
  const providerStage = typeof value.providerStage === "string" ? value.providerStage : undefined;
  if (isProviderFailureStage(providerStage)) summary.providerStage = providerStage;
  copyNumber(value, summary, "status");
  copyNumber(value, summary, "timeoutMs");
  copyBoolean(value, summary, "aborted");
  copyBoolean(value, summary, "retryable");
  copyNumber(value, summary, "attempts");
  copyNumber(value, summary, "maxAttempts");
  return summary;
}

function copyNumber(source: Record<string, unknown>, target: ProviderFailureSummary, key: "status" | "timeoutMs" | "attempts" | "maxAttempts"): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function copyBoolean(source: Record<string, unknown>, target: ProviderFailureSummary, key: "aborted" | "retryable"): void {
  const value = source[key];
  if (typeof value === "boolean") target[key] = value;
}

function isProviderFailureStage(value: string | undefined): value is NonNullable<ProviderFailureSummary["providerStage"]> {
  return (
    value === "before_start" ||
    value === "during_request" ||
    value === "during_stream" ||
    value === "during_retry_delay" ||
    value === "http_response" ||
    value === "stream_start" ||
    value === "stream_parse" ||
    value === "stream_finish" ||
    value === "non_stream_parse"
  );
}
