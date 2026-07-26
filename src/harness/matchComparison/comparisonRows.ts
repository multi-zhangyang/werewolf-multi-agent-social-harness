import { buildMetricEvidenceRows, countMetricEvidenceRefs, countMetricsWithEvidence, countRelationshipEdges, countReputationEdges, countSocialDeliveryReceipts, countSocialExposureRecords, countSocialSpeechActs, sourceProjection, summarizeModelUsage } from "./metricEvidence";
import { MetricPromotionPolicy, legacyMetricPromotionPolicyFromSummary, normalizeMetricPromotionSummary, resolveRecordedMetricPromotion } from "../evaluation";
import { hashStableState } from "../hash";
import { MatchComparisonPromotionChangeField, MatchComparisonPromotionDecisionSnapshot, MatchComparisonPromotionDetails } from "../matchComparisonShared";
import { countSocialStepCommits } from "../social";
import { HarnessMetricPromotionDecision, HarnessMetricRecord } from "../types";
import { MATCH_COMPARISON_MAX_METRIC_ROWS, MatchComparisonRow, MatchComparisonSource, MatchComparisonSourceSummary } from "./artifact";
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = recordOf(item);
        return record ? [record] : [];
      })
    : [];
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function countPromotionClass(
  metrics: HarnessMetricRecord[],
  fallbackPolicy: MetricPromotionPolicy,
  promotionClass: "scorecard" | "diagnostic" | "benchmark_only"
): number {
  return metrics.filter((metric) => resolveRecordedMetricPromotion(metric, fallbackPolicy).promotionClass === promotionClass).length;
}

export function promotionPolicyForReport(source: MatchComparisonSource): MetricPromotionPolicy {
  return legacyMetricPromotionPolicyFromSummary(source.evaluationReport?.summary?.promotion);
}

export function promotionSummaryForReport(source: MatchComparisonSource): MatchComparisonSource["evaluationReport"]["summary"]["promotion"] {
  return normalizeMetricPromotionSummary(source.evaluationReport?.summary?.promotion);
}

function promotionIdentityLabel(promotion: MatchComparisonSource["evaluationReport"]["summary"]["promotion"]): string {
  const policyVersion = promotion.policyVersion;
  const catalogVersion = promotion.catalogVersion;
  const catalogHash = promotion.catalogHash;
  return `${promotion.policyId}@${policyVersion} / ${promotion.catalogId}@${catalogVersion}#${catalogHash.slice(0, 12)}`;
}

function promotionDecisionSnapshot(
  decision: HarnessMetricPromotionDecision
): MatchComparisonPromotionDecisionSnapshot {
  return {
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    policyHash: decision.policyHash,
    catalogId: decision.catalogId,
    catalogVersion: decision.catalogVersion,
    catalogHash: decision.catalogHash,
    catalogDomainId: decision.catalogDomainId,
    catalogDecisionId: decision.catalogDecisionId ?? null,
    eligibleForScorecard: decision.eligibleForScorecard,
    resolution: decision.resolution,
    reasons: [...decision.reasons].sort()
  };
}

function sameStringValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function promotionDetails(
  baselineDecision: HarnessMetricPromotionDecision | undefined,
  candidateDecision: HarnessMetricPromotionDecision | undefined
): MatchComparisonPromotionDetails {
  const baseline = baselineDecision ? promotionDecisionSnapshot(baselineDecision) : null;
  const candidate = candidateDecision ? promotionDecisionSnapshot(candidateDecision) : null;
  const changedFields: MatchComparisonPromotionChangeField[] = [];

  if (!baselineDecision || !candidateDecision) {
    if (baselineDecision !== candidateDecision) changedFields.push("class");
    return {
      baseline,
      candidate,
      changed: changedFields.length > 0,
      changedFields
    };
  }

  const baselineSnapshot = baseline!;
  const candidateSnapshot = candidate!;
  if (baselineDecision.promotionClass !== candidateDecision.promotionClass) changedFields.push("class");
  if (baselineSnapshot.eligibleForScorecard !== candidateSnapshot.eligibleForScorecard) changedFields.push("eligibility");
  if (!sameStringValues(baselineSnapshot.reasons, candidateSnapshot.reasons)) changedFields.push("reasons");
  if (baselineSnapshot.catalogDecisionId !== candidateSnapshot.catalogDecisionId) changedFields.push("catalogDecisionId");
  if (
    baselineSnapshot.policyId !== candidateSnapshot.policyId ||
    baselineSnapshot.policyVersion !== candidateSnapshot.policyVersion ||
    baselineSnapshot.policyHash !== candidateSnapshot.policyHash
  ) {
    changedFields.push("policy");
  }
  if (
    baselineSnapshot.catalogId !== candidateSnapshot.catalogId ||
    baselineSnapshot.catalogVersion !== candidateSnapshot.catalogVersion ||
    baselineSnapshot.catalogHash !== candidateSnapshot.catalogHash ||
    baselineSnapshot.catalogDomainId !== candidateSnapshot.catalogDomainId
  ) {
    changedFields.push("catalog");
  }
  if (baselineSnapshot.resolution !== candidateSnapshot.resolution) changedFields.push("resolution");
  return {
    baseline,
    candidate,
    changed: changedFields.length > 0,
    changedFields
  };
}

export function buildComparisonRows(
  baseline: MatchComparisonSource,
  candidate: MatchComparisonSource
): {
  rows: MatchComparisonRow[];
  metricKeysCompared: number;
  metricKeysEmitted: number;
  metricKeysTruncated: number;
  scorecardMetricKeysCompared: number;
  scorecardMetricKeysEmitted: number;
  scorecardMetricKeysTruncated: number;
  diagnosticMetricKeysCompared: number;
  diagnosticMetricKeysEmitted: number;
  diagnosticMetricKeysTruncated: number;
  benchmarkOnlyMetricKeysCompared: number;
  benchmarkOnlyMetricKeysEmitted: number;
  benchmarkOnlyMetricKeysTruncated: number;
  promotionProvenanceChangedMetricCount: number;
  evidenceIdentityChangedMetricCount: number;
  evidenceIdentityOnlyBaselineRefCount: number;
  evidenceIdentityOnlyCandidateRefCount: number;
} {
  const baselineUsage = summarizeModelUsage(baseline.metrics.modelUsage);
  const candidateUsage = summarizeModelUsage(candidate.metrics.modelUsage);
  const baselinePromotion = promotionSummaryForReport(baseline);
  const candidatePromotion = promotionSummaryForReport(candidate);
  const baselinePromotionPolicy = promotionPolicyForReport(baseline);
  const candidatePromotionPolicy = promotionPolicyForReport(candidate);
  const baselineStepCounts = countSocialStepCommits(baseline.socialEpisode.steps);
  const candidateStepCounts = countSocialStepCommits(candidate.socialEpisode.steps);
  const summaryRows: MatchComparisonRow[] = [
    stringRow("status", "状态", baseline.status, candidate.status),
    stringRow("winner", "胜者", baseline.finalState.winner ?? baseline.metrics.winner ?? "未结束", candidate.finalState.winner ?? candidate.metrics.winner ?? "未结束"),
    stringRow("truncation_reason", "截断原因", baseline.truncationReason ?? "无", candidate.truncationReason ?? "无"),
    stringRow("failure_reason", "失败原因", baseline.failureReason ?? "无", candidate.failureReason ?? "无"),
    stringRow("models", "模型", baseline.models.join(", ") || "暂无", candidate.models.join(", ") || "暂无"),
    stringRow("social_scheduler", "社会调度器", baseline.socialEpisode.schedulerMode, candidate.socialEpisode.schedulerMode),
    numberRow("trajectory_steps", "轨迹步数", baseline.trajectory.length, candidate.trajectory.length),
    numberRow("social_steps", "社会调度步", baselineStepCounts.nativeSteps, candidateStepCounts.nativeSteps),
    numberRow("committed_steps", "已提交步", baselineStepCounts.committedSteps, candidateStepCounts.committedSteps),
    numberRow("rejected_steps", "已拒绝步", baselineStepCounts.rejectedSteps, candidateStepCounts.rejectedSteps),
    numberRow("social_messages", "社会消息", baseline.socialEpisode.messages.length, candidate.socialEpisode.messages.length),
    numberRow("social_speech_acts", "社会言语行为", countSocialSpeechActs(baseline), countSocialSpeechActs(candidate)),
    numberRow("social_delivery_receipts", "消息投递凭证", countSocialDeliveryReceipts(baseline), countSocialDeliveryReceipts(candidate)),
    numberRow("social_channels", "通信通道", baseline.socialEpisode.channels.length, candidate.socialEpisode.channels.length),
    numberRow("profiles", "profiles", baseline.profiles.length, candidate.profiles.length),
    numberRow("resolved_assignments", "resolved assignments", baseline.resolvedAssignments.length, candidate.resolvedAssignments.length),
    numberRow("agents", "智能体状态", baseline.agents.length, candidate.agents.length),
    numberRow("game_events", "游戏事件", baseline.finalState.events.length, candidate.finalState.events.length),
    numberRow("days", "天数", baseline.metrics.days, candidate.metrics.days),
    numberRow("deaths", "死亡", baseline.metrics.totalDeaths, candidate.metrics.totalDeaths),
    numberRow("speeches", "发言", baseline.metrics.totalSpeeches, candidate.metrics.totalSpeeches),
    numberRow("votes", "投票", baseline.metrics.totalVotes, candidate.metrics.totalVotes),
    numberRow("harness_turns", "harness turn", baseline.metrics.harnessTurnCount, candidate.metrics.harnessTurnCount),
    numberRow("harness_errors", "harness error", baseline.metrics.harnessErrorCount, candidate.metrics.harnessErrorCount),
    numberRow("average_latency_ms", "平均模型延迟(ms)", Math.round(baseline.metrics.averageLatencyMs), Math.round(candidate.metrics.averageLatencyMs)),
    numberRow("model_calls", "模型调用", baselineUsage.calls, candidateUsage.calls),
    numberRow("prompt_tokens", "prompt tokens", baselineUsage.promptTokens, candidateUsage.promptTokens),
    numberRow("completion_tokens", "completion tokens", baselineUsage.completionTokens, candidateUsage.completionTokens),
    numberRow("evaluation_metrics", "评测指标", baseline.evaluationReport.metricCount, candidate.evaluationReport.metricCount),
    numberRow("evaluation_warnings", "评测告警", baseline.evaluationReport.warnings?.length ?? 0, candidate.evaluationReport.warnings?.length ?? 0),
    numberRow("evaluators", "evaluator 数", baseline.evaluationReport.evaluatorIds.length, candidate.evaluationReport.evaluatorIds.length),
    stringRow("metric_promotion_policy", "metric promotion policy", promotionIdentityLabel(baselinePromotion), promotionIdentityLabel(candidatePromotion)),
    numberRow(
      "scorecard_metrics",
      "scorecard 指标",
      baselinePromotion.scorecardMetricCount,
      candidatePromotion.scorecardMetricCount
    ),
    numberRow(
      "diagnostic_metrics",
      "diagnostic 指标",
      baselinePromotion.diagnosticMetricCount,
      candidatePromotion.diagnosticMetricCount
    ),
    numberRow(
      "benchmark_only_metrics",
      "benchmark_only 指标",
      countPromotionClass(baseline.evaluationReport.metrics, baselinePromotionPolicy, "benchmark_only"),
      countPromotionClass(candidate.evaluationReport.metrics, candidatePromotionPolicy, "benchmark_only")
    ),
    numberRow(
      "scorecard_to_diagnostic_gap",
      "scorecard-diagnostic 差值",
      baselinePromotion.scorecardMetricCount - baselinePromotion.diagnosticMetricCount,
      candidatePromotion.scorecardMetricCount - candidatePromotion.diagnosticMetricCount
    ),
    numberRow(
      "metrics_with_evidence",
      "带 evidence 的指标",
      countMetricsWithEvidence(baseline.evaluationReport.metrics),
      countMetricsWithEvidence(candidate.evaluationReport.metrics)
    ),
    numberRow(
      "metric_evidence_refs",
      "metric evidence refs",
      countMetricEvidenceRefs(baseline.evaluationReport.metrics),
      countMetricEvidenceRefs(candidate.evaluationReport.metrics)
    ),
    numberRow("social_exposures", "观察暴露记录", countSocialExposureRecords(baseline), countSocialExposureRecords(candidate)),
    numberRow("relationship_edges", "关系边", countRelationshipEdges(baseline), countRelationshipEdges(candidate)),
    numberRow("reputation_edges", "声誉边", countReputationEdges(baseline), countReputationEdges(candidate))
  ].map((row) => ({ ...row, group: "summary" as const }));

  const metricRows = buildMetricEvidenceRows(
    baseline.evaluationReport.metrics,
    candidate.evaluationReport.metrics,
    baselinePromotionPolicy,
    candidatePromotionPolicy
  );
  const truncationRows: MatchComparisonRow[] = [
    numberRow(
      "metric_keys_compared",
      "metric keys compared",
      metricRows.metricKeysCompared,
      metricRows.metricKeysCompared
    ),
    numberRow(
      "metric_keys_emitted",
      "metric keys emitted",
      metricRows.metricKeysEmitted,
      metricRows.metricKeysEmitted
    ),
    numberRow(
      "metric_keys_truncated",
      "metric keys truncated",
      metricRows.metricKeysTruncated,
      metricRows.metricKeysTruncated
    ),
    numberRow(
      "scorecard_metric_keys_compared",
      "scorecard metric keys compared",
      metricRows.scorecardMetricKeysCompared,
      metricRows.scorecardMetricKeysCompared
    ),
    numberRow(
      "scorecard_metric_keys_emitted",
      "scorecard metric keys emitted",
      metricRows.scorecardMetricKeysEmitted,
      metricRows.scorecardMetricKeysEmitted
    ),
    numberRow(
      "scorecard_metric_keys_truncated",
      "scorecard metric keys truncated",
      metricRows.scorecardMetricKeysTruncated,
      metricRows.scorecardMetricKeysTruncated
    ),
    numberRow(
      "diagnostic_metric_keys_compared",
      "diagnostic metric keys compared",
      metricRows.diagnosticMetricKeysCompared,
      metricRows.diagnosticMetricKeysCompared
    ),
    numberRow(
      "diagnostic_metric_keys_emitted",
      "diagnostic metric keys emitted",
      metricRows.diagnosticMetricKeysEmitted,
      metricRows.diagnosticMetricKeysEmitted
    ),
    numberRow(
      "diagnostic_metric_keys_truncated",
      "diagnostic metric keys truncated",
      metricRows.diagnosticMetricKeysTruncated,
      metricRows.diagnosticMetricKeysTruncated
    ),
    numberRow(
      "benchmark_only_metric_keys_compared",
      "benchmark_only metric keys compared",
      metricRows.benchmarkOnlyMetricKeysCompared,
      metricRows.benchmarkOnlyMetricKeysCompared
    ),
    numberRow(
      "benchmark_only_metric_keys_emitted",
      "benchmark_only metric keys emitted",
      metricRows.benchmarkOnlyMetricKeysEmitted,
      metricRows.benchmarkOnlyMetricKeysEmitted
    ),
    numberRow(
      "benchmark_only_metric_keys_truncated",
      "benchmark_only metric keys truncated",
      metricRows.benchmarkOnlyMetricKeysTruncated,
      metricRows.benchmarkOnlyMetricKeysTruncated
    ),
    numberRow(
      "promotion_provenance_changed_metrics",
      "metric promotion provenance changed",
      metricRows.promotionProvenanceChangedMetricCount,
      metricRows.promotionProvenanceChangedMetricCount
    ),
    numberRow(
      "evidence_identity_changed_metrics",
      "evidence identity changed metrics",
      metricRows.evidenceIdentityChangedMetricCount,
      metricRows.evidenceIdentityChangedMetricCount
    ),
    numberRow(
      "evidence_identity_only_baseline_refs",
      "evidence identity only-baseline refs",
      metricRows.evidenceIdentityOnlyBaselineRefCount,
      metricRows.evidenceIdentityOnlyBaselineRefCount
    ),
    numberRow(
      "evidence_identity_only_candidate_refs",
      "evidence identity only-candidate refs",
      metricRows.evidenceIdentityOnlyCandidateRefCount,
      metricRows.evidenceIdentityOnlyCandidateRefCount
    ),
    numberRow(
      "metric_rows_max",
      "metric rows max",
      MATCH_COMPARISON_MAX_METRIC_ROWS,
      MATCH_COMPARISON_MAX_METRIC_ROWS
    )
  ].map((row) => ({ ...row, group: "summary" as const }));

  return {
    rows: sortComparisonRows([...summaryRows, ...truncationRows, ...metricRows.rows]),
    metricKeysCompared: metricRows.metricKeysCompared,
    metricKeysEmitted: metricRows.metricKeysEmitted,
    metricKeysTruncated: metricRows.metricKeysTruncated,
    scorecardMetricKeysCompared: metricRows.scorecardMetricKeysCompared,
    scorecardMetricKeysEmitted: metricRows.scorecardMetricKeysEmitted,
    scorecardMetricKeysTruncated: metricRows.scorecardMetricKeysTruncated,
    diagnosticMetricKeysCompared: metricRows.diagnosticMetricKeysCompared,
    diagnosticMetricKeysEmitted: metricRows.diagnosticMetricKeysEmitted,
    diagnosticMetricKeysTruncated: metricRows.diagnosticMetricKeysTruncated,
    benchmarkOnlyMetricKeysCompared: metricRows.benchmarkOnlyMetricKeysCompared,
    benchmarkOnlyMetricKeysEmitted: metricRows.benchmarkOnlyMetricKeysEmitted,
    benchmarkOnlyMetricKeysTruncated: metricRows.benchmarkOnlyMetricKeysTruncated,
    promotionProvenanceChangedMetricCount: metricRows.promotionProvenanceChangedMetricCount,
    evidenceIdentityChangedMetricCount: metricRows.evidenceIdentityChangedMetricCount,
    evidenceIdentityOnlyBaselineRefCount: metricRows.evidenceIdentityOnlyBaselineRefCount,
    evidenceIdentityOnlyCandidateRefCount: metricRows.evidenceIdentityOnlyCandidateRefCount
  };
}

export function summarizeSource(artifact: MatchComparisonSource, artifactHash: string): MatchComparisonSourceSummary {
  const stepCounts = countSocialStepCommits(artifact.socialEpisode.steps);
  return {
    matchId: artifact.matchId,
    runId: artifact.runId,
    seed: artifact.seed,
    createdAt: artifact.createdAt,
    status: artifact.status,
    truncationReason: artifact.truncationReason,
    failureReason: artifact.failureReason,
    projection: sourceProjection(artifact),
    models: [...artifact.models],
    profileCount: artifact.profiles.length,
    resolvedAssignmentCount: artifact.resolvedAssignments.length,
    agentCount: artifact.agents.length,
    trajectorySteps: artifact.trajectory.length,
    socialSteps: stepCounts.nativeSteps,
    committedSteps: stepCounts.committedSteps,
    rejectedSteps: stepCounts.rejectedSteps,
    socialMessages: artifact.socialEpisode.messages.length,
    socialSpeechActs: countSocialSpeechActs(artifact),
    socialDeliveryReceipts: countSocialDeliveryReceipts(artifact),
    socialChannels: artifact.socialEpisode.channels.length,
    gameEvents: artifact.finalState.events.length,
    evaluationMetricCount: artifact.evaluationReport.metricCount,
    evaluationWarningCount: artifact.evaluationReport.warnings?.length ?? 0,
    evaluatorCount: artifact.evaluationReport.evaluatorIds.length,
    stateHash: hashStableState(artifact.finalState),
    artifactHash
  };
}

export function numberRow(id: string, label: string, baseline: number, candidate: number): MatchComparisonRow {
  return {
    id,
    label,
    baseline,
    candidate,
    delta: candidate - baseline,
    changed: baseline !== candidate
  };
}

export function stringRow(id: string, label: string, baseline: string, candidate: string): MatchComparisonRow {
  return {
    id,
    label,
    baseline,
    candidate,
    changed: baseline !== candidate
  };
}

export function sortComparisonRows(rows: MatchComparisonRow[]): MatchComparisonRow[] {
  const groupOrder: Record<NonNullable<MatchComparisonRow["group"]>, number> = {
    summary: 0,
    metric: 1,
    metric_evidence: 2
  };
  return [...rows].sort((left, right) => {
    if (left.changed !== right.changed) return left.changed ? -1 : 1;
    const leftGroup = groupOrder[left.group ?? "summary"] ?? 9;
    const rightGroup = groupOrder[right.group ?? "summary"] ?? 9;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    return left.id.localeCompare(right.id);
  });
}
