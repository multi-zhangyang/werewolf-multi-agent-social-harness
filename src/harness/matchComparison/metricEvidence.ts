import { numberRow, promotionDetails, stringRow } from "./comparisonRows";
import { MatchMetrics } from "../../core/types";
import { MetricPromotionPolicy, resolveRecordedMetricPromotion } from "../evaluation";
import { hashStableState } from "../hash";
import { MatchComparisonRowPromotion, MatchComparisonValue, MatchComparisonView } from "../matchComparisonShared";
import { deriveSocialExposureRecords } from "../social";
import { HarnessMetricRecord } from "../types";
import { MATCH_COMPARISON_MAX_METRIC_ROWS, MatchComparisonProjection, MatchComparisonRow, MatchComparisonSource } from "./artifact";
export function buildMetricEvidenceRows(
  baselineMetrics: HarnessMetricRecord[],
  candidateMetrics: HarnessMetricRecord[],
  baselinePromotionPolicy: MetricPromotionPolicy,
  candidatePromotionPolicy: MetricPromotionPolicy
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
  const baselineByKey = indexMetrics(baselineMetrics);
  const candidateByKey = indexMetrics(candidateMetrics);
  const keys = sortMetricKeysForEmission(
    uniqueSorted([...baselineByKey.keys(), ...candidateByKey.keys()]),
    baselineByKey,
    candidateByKey,
    baselinePromotionPolicy,
    candidatePromotionPolicy
  );
  const rows: MatchComparisonRow[] = [];
  let metricKeysEmitted = 0;
  let metricKeysTruncated = 0;
  let scorecardMetricKeysCompared = 0;
  let scorecardMetricKeysEmitted = 0;
  let scorecardMetricKeysTruncated = 0;
  let diagnosticMetricKeysCompared = 0;
  let diagnosticMetricKeysEmitted = 0;
  let diagnosticMetricKeysTruncated = 0;
  let benchmarkOnlyMetricKeysCompared = 0;
  let benchmarkOnlyMetricKeysEmitted = 0;
  let benchmarkOnlyMetricKeysTruncated = 0;
  let promotionProvenanceChangedMetricCount = 0;
  let evidenceIdentityChangedMetricCount = 0;
  let evidenceIdentityOnlyBaselineRefCount = 0;
  let evidenceIdentityOnlyCandidateRefCount = 0;

  for (const key of keys) {
    const baselineMetric = baselineByKey.get(key);
    const candidateMetric = candidateByKey.get(key);
    const baselineValue = metricComparableValue(baselineMetric);
    const candidateValue = metricComparableValue(candidateMetric);
    const baselineRefs = baselineMetric?.evidenceRefs?.length ?? 0;
    const candidateRefs = candidateMetric?.evidenceRefs?.length ?? 0;
    const baselineKinds = evidenceKinds(baselineMetric);
    const candidateKinds = evidenceKinds(candidateMetric);
    const baselineIds = evidenceIdentities(baselineMetric);
    const candidateIds = evidenceIdentities(candidateMetric);
    const onlyBaselineIds = differenceSorted(baselineIds, candidateIds);
    const onlyCandidateIds = differenceSorted(candidateIds, baselineIds);
    const baselineDecision = baselineMetric
      ? resolveRecordedMetricPromotion(baselineMetric, baselinePromotionPolicy)
      : undefined;
    const candidateDecision = candidateMetric
      ? resolveRecordedMetricPromotion(candidateMetric, candidatePromotionPolicy)
      : undefined;
    const promotion: MatchComparisonRowPromotion = {
      baseline: baselineDecision?.promotionClass ?? "missing",
      candidate: candidateDecision?.promotionClass ?? "missing",
      details: promotionDetails(baselineDecision, candidateDecision)
    };
    const baselinePromotion = promotion.baseline;
    const candidatePromotion = promotion.candidate;
    const valueChanged = baselineValue !== candidateValue;
    const identityChanged = onlyBaselineIds.length > 0 || onlyCandidateIds.length > 0;
    const evidenceChanged =
      baselineRefs !== candidateRefs ||
      baselineKinds.join("|") !== candidateKinds.join("|") ||
      identityChanged;
    const promotionChanged = promotion.details?.changed ?? baselinePromotion !== candidatePromotion;
    const promotionProvenanceChanged = Boolean(
      promotion.details?.changedFields.some((field) => field !== "class")
    );
    const eligibilityChanged = Boolean(
      promotion.details?.changedFields.includes("eligibility") && baselinePromotion === candidatePromotion
    );
    if (!valueChanged && !evidenceChanged && !promotionChanged && baselineMetric && candidateMetric) continue;

    const isScorecardKey = baselinePromotion === "scorecard" || candidatePromotion === "scorecard";
    const isDiagnosticKey = baselinePromotion === "diagnostic" || candidatePromotion === "diagnostic";
    const isBenchmarkOnlyKey = baselinePromotion === "benchmark_only" || candidatePromotion === "benchmark_only";
    if (isScorecardKey) scorecardMetricKeysCompared += 1;
    if (isDiagnosticKey) diagnosticMetricKeysCompared += 1;
    if (isBenchmarkOnlyKey) benchmarkOnlyMetricKeysCompared += 1;

    if (metricKeysEmitted >= MATCH_COMPARISON_MAX_METRIC_ROWS) {
      metricKeysTruncated += 1;
      if (isScorecardKey) scorecardMetricKeysTruncated += 1;
      if (isDiagnosticKey) diagnosticMetricKeysTruncated += 1;
      if (isBenchmarkOnlyKey) benchmarkOnlyMetricKeysTruncated += 1;
      continue;
    }

    const metricId = baselineMetric?.id ?? candidateMetric?.id ?? key;
    const subjectId = baselineMetric?.subjectId ?? candidateMetric?.subjectId;
    const labelSubject = subjectId ? ` · ${subjectId}` : "";
    const evidence = {
      baselineRefs,
      candidateRefs,
      baselineKinds,
      candidateKinds,
      baselineIds,
      candidateIds,
      onlyBaselineIds,
      onlyCandidateIds
    } as const;
    const bothNumericOrMissing =
      (baselineValue === null || typeof baselineValue === "number") &&
      (candidateValue === null || typeof candidateValue === "number") &&
      !(baselineValue === null && candidateValue === null);
    if (bothNumericOrMissing) {
      const baselineNumber = typeof baselineValue === "number" ? baselineValue : 0;
      const candidateNumber = typeof candidateValue === "number" ? candidateValue : 0;
      rows.push({
        ...numberRow(`metric:${key}`, `指标 ${metricId}${labelSubject}`, baselineNumber, candidateNumber),
        baseline: baselineValue,
        candidate: candidateValue,
        delta:
          typeof baselineValue === "number" && typeof candidateValue === "number"
            ? candidateValue - baselineValue
            : typeof candidateValue === "number"
              ? candidateValue
              : typeof baselineValue === "number"
                ? -baselineValue
                : undefined,
        changed: valueChanged || promotionChanged,
        group: "metric",
        metricId,
        subjectId,
        promotion,
        evidence
      });
    } else {
      rows.push({
        ...stringRow(
          `metric:${key}`,
          `指标 ${metricId}${labelSubject}`,
          formatMetricValue(baselineValue, baselinePromotion),
          formatMetricValue(candidateValue, candidatePromotion)
        ),
        group: "metric",
        metricId,
        subjectId,
        changed: valueChanged || promotionChanged,
        promotion,
        evidence
      });
    }

    if (promotionChanged) {
      if (promotionProvenanceChanged) promotionProvenanceChangedMetricCount += 1;
      rows.push({
        ...stringRow(
          `metric_promotion:${key}`,
          `promotion · ${metricId}${labelSubject} · ${promotion.details?.changedFields.join(",") ?? "class"}`,
          baselinePromotion,
          candidatePromotion
        ),
        changed: true,
        group: "metric",
        metricId,
        subjectId,
        promotion,
        evidence
      });
    }

    if (eligibilityChanged) {
      rows.push({
        ...stringRow(
          `metric_promotion_eligibility:${key}`,
          `scorecard eligibility · ${metricId}${labelSubject}`,
          promotion.details?.baseline?.eligibleForScorecard ? "eligible" : "ineligible",
          promotion.details?.candidate?.eligibleForScorecard ? "eligible" : "ineligible"
        ),
        changed: true,
        group: "metric",
        metricId,
        subjectId,
        promotion,
        evidence
      });
    }

    if (evidenceChanged || baselineRefs > 0 || candidateRefs > 0) {
      rows.push({
        ...numberRow(`metric_evidence:${key}`, `evidence refs · ${metricId}${labelSubject}`, baselineRefs, candidateRefs),
        group: "metric_evidence",
        metricId,
        subjectId,
        promotion,
        evidence
      });
      if (baselineKinds.join("|") !== candidateKinds.join("|")) {
        rows.push({
          ...stringRow(
            `metric_evidence_kinds:${key}`,
            `evidence kinds · ${metricId}${labelSubject}`,
            baselineKinds.join(",") || "无",
            candidateKinds.join(",") || "无"
          ),
          group: "metric_evidence",
          metricId,
          subjectId,
          promotion,
          evidence
        });
      }
      if (identityChanged) {
        evidenceIdentityChangedMetricCount += 1;
        evidenceIdentityOnlyBaselineRefCount += onlyBaselineIds.length;
        evidenceIdentityOnlyCandidateRefCount += onlyCandidateIds.length;
        rows.push({
          ...stringRow(
            `metric_evidence_ids:${key}`,
            `evidence ids · ${metricId}${labelSubject}`,
            formatEvidenceIdentityDelta(onlyBaselineIds, "baseline-only"),
            formatEvidenceIdentityDelta(onlyCandidateIds, "candidate-only")
          ),
          group: "metric_evidence",
          metricId,
          subjectId,
          promotion,
          evidence
        });
      }
    }

    metricKeysEmitted += 1;
    if (isScorecardKey) scorecardMetricKeysEmitted += 1;
    if (isDiagnosticKey) diagnosticMetricKeysEmitted += 1;
    if (isBenchmarkOnlyKey) benchmarkOnlyMetricKeysEmitted += 1;
  }

  return {
    rows,
    metricKeysCompared: keys.length,
    metricKeysEmitted,
    metricKeysTruncated,
    scorecardMetricKeysCompared,
    scorecardMetricKeysEmitted,
    scorecardMetricKeysTruncated,
    diagnosticMetricKeysCompared,
    diagnosticMetricKeysEmitted,
    diagnosticMetricKeysTruncated,
    benchmarkOnlyMetricKeysCompared,
    benchmarkOnlyMetricKeysEmitted,
    benchmarkOnlyMetricKeysTruncated,
    promotionProvenanceChangedMetricCount,
    evidenceIdentityChangedMetricCount,
    evidenceIdentityOnlyBaselineRefCount,
    evidenceIdentityOnlyCandidateRefCount
  };
}

function metricPromotionPriority(metric: HarnessMetricRecord | undefined, fallbackPolicy: MetricPromotionPolicy): number {
  if (!metric) return 3;
  const promotionClass = resolveRecordedMetricPromotion(metric, fallbackPolicy).promotionClass;
  if (promotionClass === "scorecard") return 0;
  if (promotionClass === "benchmark_only") return 1;
  if (promotionClass === "diagnostic") return 2;
  return 3;
}

function metricEmissionChangePriority(
  baselineMetric: HarnessMetricRecord | undefined,
  candidateMetric: HarnessMetricRecord | undefined,
  baselinePromotionPolicy: MetricPromotionPolicy,
  candidatePromotionPolicy: MetricPromotionPolicy
): number {
  if (!baselineMetric || !candidateMetric) return 0;
  const promotion = promotionDetails(
    resolveRecordedMetricPromotion(baselineMetric, baselinePromotionPolicy),
    resolveRecordedMetricPromotion(candidateMetric, candidatePromotionPolicy)
  );
  // Policy/catalog provenance is audit-critical even when value and final
  // class match, so it wins tie-breaks within the same promotion class.
  if (promotion.changed) return 0;
  const baselineKinds = evidenceKinds(baselineMetric);
  const candidateKinds = evidenceKinds(candidateMetric);
  const evidenceChanged =
    (baselineMetric.evidenceRefs?.length ?? 0) !== (candidateMetric.evidenceRefs?.length ?? 0) ||
    baselineKinds.join("|") !== candidateKinds.join("|") ||
    evidenceIdentities(baselineMetric).join("|") !== evidenceIdentities(candidateMetric).join("|");
  if (metricComparableValue(baselineMetric) !== metricComparableValue(candidateMetric) || evidenceChanged) return 1;
  return 2;
}

function sortMetricKeysForEmission(
  keys: string[],
  baselineByKey: Map<string, HarnessMetricRecord>,
  candidateByKey: Map<string, HarnessMetricRecord>,
  baselinePromotionPolicy: MetricPromotionPolicy,
  candidatePromotionPolicy: MetricPromotionPolicy
): string[] {
  return [...keys].sort((left, right) => {
    const leftPriority = Math.min(
      metricPromotionPriority(baselineByKey.get(left), baselinePromotionPolicy),
      metricPromotionPriority(candidateByKey.get(left), candidatePromotionPolicy)
    );
    const rightPriority = Math.min(
      metricPromotionPriority(baselineByKey.get(right), baselinePromotionPolicy),
      metricPromotionPriority(candidateByKey.get(right), candidatePromotionPolicy)
    );
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;

    const leftChangePriority = metricEmissionChangePriority(
      baselineByKey.get(left),
      candidateByKey.get(left),
      baselinePromotionPolicy,
      candidatePromotionPolicy
    );
    const rightChangePriority = metricEmissionChangePriority(
      baselineByKey.get(right),
      candidateByKey.get(right),
      baselinePromotionPolicy,
      candidatePromotionPolicy
    );
    if (leftChangePriority !== rightChangePriority) return leftChangePriority - rightChangePriority;

    return left.localeCompare(right);
  });
}

function indexMetrics(metrics: HarnessMetricRecord[]): Map<string, HarnessMetricRecord> {
  const indexed = new Map<string, HarnessMetricRecord>();
  for (const metric of metrics) {
    indexed.set(metricKey(metric), metric);
  }
  return indexed;
}

function metricKey(metric: HarnessMetricRecord): string {
  return `${metric.id}::${metric.subjectId ?? "episode"}`;
}

function metricComparableValue(metric: HarnessMetricRecord | undefined): MatchComparisonValue {
  if (!metric) return null;
  const value = metric.value;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function formatMetricValue(value: MatchComparisonValue, promotionClass: string): string {
  if (value === null) return `missing/${promotionClass}`;
  return `${String(value)}/${promotionClass}`;
}

function evidenceKinds(metric: HarnessMetricRecord | undefined): string[] {
  if (!metric?.evidenceRefs?.length) return [];
  return uniqueSorted(metric.evidenceRefs.map((ref) => ref.artifact));
}

function evidenceIdentities(metric: HarnessMetricRecord | undefined): string[] {
  if (!metric?.evidenceRefs?.length) return [];
  return uniqueSorted(metric.evidenceRefs.map((ref) => evidenceIdentity(ref)));
}

function evidenceIdentity(ref: NonNullable<HarnessMetricRecord["evidenceRefs"]>[number]): string {
  // Structural identity only. Descriptions are intentionally excluded so private
  // narrative/sentinel text cannot leak through comparison artifacts.
  const parts = [`artifact=${ref.artifact}`];
  if (ref.id !== undefined) parts.push(`id=${ref.id}`);
  if (ref.seq !== undefined) parts.push(`seq=${ref.seq}`);
  if (ref.traceId !== undefined) parts.push(`traceId=${ref.traceId}`);
  return parts.join("|");
}

function differenceSorted(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function formatEvidenceIdentityDelta(ids: string[], label: string): string {
  if (!ids.length) return "无";
  const preview = ids.slice(0, 4).join("; ");
  const suffix = ids.length > 4 ? `; +${ids.length - 4} more` : "";
  return `${label}:${ids.length} · ${preview}${suffix}`;
}

export function countMetricsWithEvidence(metrics: HarnessMetricRecord[]): number {
  return metrics.filter((metric) => (metric.evidenceRefs?.length ?? 0) > 0).length;
}

export function countMetricEvidenceRefs(metrics: HarnessMetricRecord[]): number {
  return metrics.reduce((sum, metric) => sum + (metric.evidenceRefs?.length ?? 0), 0);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function summarizeModelUsage(usage: MatchMetrics["modelUsage"]): { calls: number; promptTokens: number; completionTokens: number; latencyMs: number } {
  return Object.values(usage).reduce(
    (summary, item) => ({
      calls: summary.calls + item.calls,
      promptTokens: summary.promptTokens + item.promptTokens,
      completionTokens: summary.completionTokens + item.completionTokens,
      latencyMs: summary.latencyMs + item.latencyMs
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 }
  );
}

export function countRelationshipEdges(artifact: MatchComparisonSource): number {
  return artifact.agents.reduce((sum, agent) => sum + Object.keys(agent.social?.relationships.edges ?? {}).length, 0);
}

export function countReputationEdges(artifact: MatchComparisonSource): number {
  return artifact.agents.reduce((sum, agent) => sum + Object.keys(agent.social?.reputation.records ?? {}).length, 0);
}

export function countSocialSpeechActs(artifact: MatchComparisonSource): number {
  return artifact.socialEpisode.messages.reduce((sum, message) => sum + (message.speechActs?.length ?? 0), 0);
}

export function countSocialDeliveryReceipts(artifact: MatchComparisonSource): number {
  return artifact.socialEpisode.messages.reduce((sum, message) => sum + (message.deliveryReceipts?.length ?? 0), 0);
}

export function countSocialExposureRecords(artifact: MatchComparisonSource): number {
  const view = sourceProjection(artifact)?.view;
  if ((view === "postgame-redacted" || view === "truth-redacted") && Array.isArray(artifact.socialEpisode.exposureRecords)) {
    return artifact.socialEpisode.exposureRecords.length;
  }
  return deriveSocialExposureRecords(artifact.socialEpisode).length;
}

export function sourceProjection(artifact: MatchComparisonSource): MatchComparisonProjection | undefined {
  const projection = artifact.projection;
  return projection ? { ...projection } : undefined;
}

export function comparisonArtifactId(input: {
  view: MatchComparisonView;
  baselineRunId?: string;
  baselineMatchId?: string;
  candidateRunId?: string;
  candidateMatchId?: string;
  baselineHash: string;
  candidateHash: string;
}): string {
  return `match-comparison:${hashStableState(input).slice(0, 24)}`;
}
