import { HarnessEvaluationModuleResult, HarnessEvaluationReport, HarnessEvaluationWarning, HarnessEvaluatorManifestEntry, HarnessMetricRecord } from "../types";
import { DEFAULT_METRIC_PROMOTION_POLICY, MetricPromotionPolicy, metricPromotionIdentity, resolveRecordedMetricPromotion, summarizeMetricPromotionCatalog, uncatalogedMetricPolicyFor } from "./metricPromotion";
import { EvaluationModuleRun } from "./registry";
export function summarizeMetrics(
  metrics: readonly HarnessMetricRecord[],
  fallbackPolicy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY
): HarnessEvaluationReport["summary"] {
  const decisions = metrics.map((item) => ({ metric: item, decision: resolveRecordedMetricPromotion(item, fallbackPolicy) }));
  const scoreMetrics = decisions
    .filter(({ decision }) => decision.eligibleForScorecard)
    .map(({ metric }) => metric)
    .filter((metric) => isFiniteNumber(metric.value) && isFiniteNumber(metric.weight) && metric.weight > 0);
  const weightedMetricCount = metrics.filter((metric) => isFiniteNumber(metric.weight) && metric.weight > 0).length;
  const excludedWeighted = decisions
    .filter(({ metric, decision }) => isFiniteNumber(metric.weight) && metric.weight > 0 && !decision.eligibleForScorecard)
    .map(({ metric }) => metric.id);
  const diagnosticMetricCount = decisions.filter(({ decision }) => !decision.eligibleForScorecard).length;
  const catalog = summarizeMetricPromotionCatalog(fallbackPolicy);
  const identity = metricPromotionIdentity(fallbackPolicy);

  return {
    episodeScore: weightedAverage(scoreMetrics.filter((metric) => metric.scope === "episode")),
    teamScores: averageBySubject(scoreMetrics.filter((metric) => metric.scope === "team")),
    agentScores: averageBySubject(scoreMetrics.filter((metric) => metric.scope === "agent")),
    profileScores: averageBySubject(scoreMetrics.filter((metric) => metric.scope === "profile")),
    modelScores: averageBySubject(scoreMetrics.filter((metric) => metric.scope === "model")),
    promotion: {
      ...identity,
      catalogEntryCount: catalog.entryCount,
      catalogRuleCount: catalog.ruleCount,
      catalogRuleIds: catalog.ruleIds,
      catalogScorecardMetricIds: catalog.scorecardMetricIds,
      catalogDiagnosticMetricIds: catalog.diagnosticMetricIds,
      catalogBenchmarkOnlyMetricIds: catalog.benchmarkOnlyMetricIds,
      scorecardMetricCount: scoreMetrics.length,
      diagnosticMetricCount,
      weightedMetricCount,
      excludedWeightedMetricCount: excludedWeighted.length,
      excludedWeightedMetricIds: uniqueStrings(excludedWeighted).sort(),
      scorecardRequiresEvidence: true,
      scorecardRequiresPositiveWeight: true,
      uncatalogedMetricPolicy: uncatalogedMetricPolicyFor(fallbackPolicy),
      decisionStorage: "per_metric_recorded"
    }
  };
}

export function emptyEvaluationSummary(options?: {
  metricCount?: number;
  weightedMetricCount?: number;
  excludedWeightedMetricIds?: string[];
  promotionPolicy?: MetricPromotionPolicy;
}): HarnessEvaluationReport["summary"] {
  const excluded = options?.excludedWeightedMetricIds ?? [];
  const metricCount = options?.metricCount ?? 0;
  const weightedMetricCount = options?.weightedMetricCount ?? 0;
  const policy = options?.promotionPolicy ?? DEFAULT_METRIC_PROMOTION_POLICY;
  const catalog = summarizeMetricPromotionCatalog(policy);
  const identity = metricPromotionIdentity(policy);
  return {
    teamScores: {},
    agentScores: {},
    profileScores: {},
    modelScores: {},
    promotion: {
      ...identity,
      catalogEntryCount: catalog.entryCount,
      catalogRuleCount: catalog.ruleCount,
      catalogRuleIds: catalog.ruleIds,
      catalogScorecardMetricIds: catalog.scorecardMetricIds,
      catalogDiagnosticMetricIds: catalog.diagnosticMetricIds,
      catalogBenchmarkOnlyMetricIds: catalog.benchmarkOnlyMetricIds,
      scorecardMetricCount: 0,
      diagnosticMetricCount: metricCount,
      weightedMetricCount,
      excludedWeightedMetricCount: excluded.length,
      excludedWeightedMetricIds: [...excluded].sort(),
      scorecardRequiresEvidence: true,
      scorecardRequiresPositiveWeight: true,
      uncatalogedMetricPolicy: uncatalogedMetricPolicyFor(policy),
      decisionStorage: "per_metric_recorded"
    }
  };
}

export function metric(options: {
  id: string;
  label: string;
  scope: HarnessMetricRecord["scope"];
  subjectId?: string;
  subject?: Record<string, unknown>;
  value: HarnessMetricRecord["value"];
  unit?: string;
  higherIsBetter?: boolean;
  weight?: number;
  source: string;
  evaluatorId?: string;
  evaluatorVersion?: string;
  denominator?: number;
  confidence?: number;
  aggregation?: string;
  evidenceRefs?: HarnessMetricRecord["evidenceRefs"];
  scenario?: string;
  split?: string;
  promotionClass?: HarnessMetricRecord["promotionClass"];
  declaredPromotionClass?: HarnessMetricRecord["declaredPromotionClass"];
  metadata?: Record<string, unknown>;
}): HarnessMetricRecord {
  return { ...options };
}

export function summarizeEvaluationWarnings(warnings: HarnessEvaluationWarning[] | undefined): {
  warningCount: number;
  warningSeverityCounts: Record<HarnessEvaluationWarning["severity"], number>;
  warningCodes: Array<{
    code: string;
    severity: HarnessEvaluationWarning["severity"];
    count: number;
    evaluatorIds: string[];
    metricIds: string[];
  }>;
} {
  const entries = warnings ?? [];
  const codeMap = new Map<
    string,
    {
      code: string;
      severity: HarnessEvaluationWarning["severity"];
      count: number;
      evaluatorIds: Set<string>;
      metricIds: Set<string>;
    }
  >();
  const warningSeverityCounts: Record<HarnessEvaluationWarning["severity"], number> = {
    info: 0,
    warning: 0
  };
  for (const warning of entries) {
    warningSeverityCounts[warning.severity] += 1;
    const key = `${warning.severity}:${warning.code}`;
    const row = codeMap.get(key) ?? {
      code: warning.code,
      severity: warning.severity,
      count: 0,
      evaluatorIds: new Set<string>(),
      metricIds: new Set<string>()
    };
    row.count += 1;
    if (warning.evaluatorId) row.evaluatorIds.add(warning.evaluatorId);
    if (warning.metricId) row.metricIds.add(warning.metricId);
    codeMap.set(key, row);
  }
  return {
    warningCount: entries.length,
    warningSeverityCounts,
    warningCodes: [...codeMap.values()]
      .map((row) => ({
        code: row.code,
        severity: row.severity,
        count: row.count,
        evaluatorIds: [...row.evaluatorIds].sort(),
        metricIds: [...row.metricIds].sort()
      }))
      .sort((left, right) => right.count - left.count || left.severity.localeCompare(right.severity) || left.code.localeCompare(right.code))
  };
}

function averageBySubject(metrics: HarnessMetricRecord[]): Record<string, number> {
  const grouped = new Map<string, HarnessMetricRecord[]>();
  for (const item of metrics) {
    if (!item.subjectId) continue;
    grouped.set(item.subjectId, [...(grouped.get(item.subjectId) ?? []), item]);
  }
  return Object.fromEntries([...grouped.entries()].map(([subjectId, items]) => [subjectId, weightedAverage(items) ?? 0]));
}

function weightedAverage(metrics: HarnessMetricRecord[]): number | undefined {
  let weightedSum = 0;
  let weightSum = 0;
  for (const item of metrics) {
    if (!isFiniteNumber(item.value)) continue;
    const weight = item.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weightedSum += item.value * weight;
    weightSum += Math.abs(weight);
  }
  return weightSum ? round3(weightedSum / weightSum) : undefined;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function collectEvaluationWarnings(
  moduleRuns: EvaluationModuleRun[],
  fallbackPolicy: MetricPromotionPolicy
): HarnessEvaluationWarning[] {
  const warnings: HarnessEvaluationWarning[] = [];
  const evaluatorIdCounts = new Map<string, number>();
  for (const { result } of moduleRuns) {
    evaluatorIdCounts.set(result.evaluatorId, (evaluatorIdCounts.get(result.evaluatorId) ?? 0) + 1);
  }
  for (const [evaluatorId, count] of evaluatorIdCounts) {
    if (count > 1) {
      warnings.push({
        code: "evaluator.duplicate_output_key",
        severity: "warning",
        evaluatorId,
        message: `Evaluator id ${evaluatorId} was returned ${count} times; outputs keep the last value for that key.`,
        metadata: { count }
      });
    }
  }

  for (const moduleRun of moduleRuns) {
    const { evaluator, result, metrics, manifest } = moduleRun;
    if (evaluator.id !== result.evaluatorId || evaluator.label !== result.label || evaluator.version !== result.version) {
      warnings.push({
        code: "evaluator.identity_mismatch",
        severity: "warning",
        evaluatorId: result.evaluatorId,
        evaluatorVersion: result.version,
        message: "Evaluator object identity differs from the module result identity preserved in the report.",
        metadata: {
          evaluator: { id: evaluator.id, label: evaluator.label, version: evaluator.version },
          result: { id: result.evaluatorId, label: result.label, version: result.version }
        }
      });
    }

    warnings.push(...manifestWarnings(manifest));
    warnings.push(...manifestMetricCoverageWarnings(manifest, metrics));
    for (const item of metrics) {
      warnings.push(...metricWarnings(item, result, fallbackPolicy));
    }
  }
  return warnings;
}

function manifestWarnings(manifest: HarnessEvaluatorManifestEntry): HarnessEvaluationWarning[] {
  const warnings: HarnessEvaluationWarning[] = [];
  if (manifest.mode === "model_graded") {
    const hasJudgeMetadata = Boolean(manifest.dependencies.judgeModel && manifest.dependencies.promptVersion && manifest.rubric);
    if (!hasJudgeMetadata) {
      warnings.push({
        code: "manifest.model_graded_missing_judge_metadata",
        severity: "warning",
        evaluatorId: manifest.id,
        evaluatorVersion: manifest.version,
        message: "Model-graded evaluator is missing judge model, prompt version, or rubric metadata.",
        metadata: {
          hasJudgeModel: Boolean(manifest.dependencies.judgeModel),
          hasPromptVersion: Boolean(manifest.dependencies.promptVersion),
          hasRubric: Boolean(manifest.rubric)
        }
      });
    }
  }
  if (manifest.mode === "deterministic" && (manifest.dependencies.judgeModel || manifest.dependencies.promptVersion)) {
    warnings.push({
      code: "manifest.deterministic_declares_judge_dependency",
      severity: "warning",
      evaluatorId: manifest.id,
      evaluatorVersion: manifest.version,
      message: "Deterministic evaluator declares judge-model dependencies; deterministic and model-graded metrics should stay separate.",
      metadata: {
        judgeModel: manifest.dependencies.judgeModel ?? null,
        promptVersion: manifest.dependencies.promptVersion ?? null
      }
    });
  }
  return warnings;
}

function manifestMetricCoverageWarnings(manifest: HarnessEvaluatorManifestEntry, metrics: HarnessMetricRecord[]): HarnessEvaluationWarning[] {
  const warnings: HarnessEvaluationWarning[] = [];
  const declared = new Set(manifest.metricIds);
  const emitted = new Set(metrics.map((item) => item.id));
  for (const metricId of emitted) {
    if (!declared.has(metricId)) {
      warnings.push({
        code: "manifest.metric_id_undeclared",
        severity: "warning",
        evaluatorId: manifest.id,
        evaluatorVersion: manifest.version,
        metricId,
        message: `Metric ${metricId} was emitted but is not declared in evaluator manifest metricIds.`
      });
    }
  }
  for (const metricId of declared) {
    if (!emitted.has(metricId)) {
      warnings.push({
        code: "manifest.metric_id_declared_not_emitted",
        severity: "info",
        evaluatorId: manifest.id,
        evaluatorVersion: manifest.version,
        metricId,
        message: `Metric ${metricId} is declared in evaluator manifest metricIds but was not emitted in this run.`
      });
    }
  }
  return warnings;
}

function metricWarnings(
  metric: HarnessMetricRecord,
  result: HarnessEvaluationModuleResult,
  fallbackPolicy: MetricPromotionPolicy
): HarnessEvaluationWarning[] {
  const warnings: HarnessEvaluationWarning[] = [];
  const evaluatorId = metric.evaluatorId ?? result.evaluatorId;
  const evaluatorVersion = metric.evaluatorVersion ?? result.version;
  if (evaluatorId !== result.evaluatorId || evaluatorVersion !== result.version) {
    warnings.push({
      code: "metric.cross_evaluator_attribution",
      severity: "info",
      evaluatorId,
      evaluatorVersion,
      metricId: metric.id,
      subjectId: metric.subjectId,
      message: "Metric attribution differs from the emitting evaluator result identity.",
      metadata: {
        emittingEvaluatorId: result.evaluatorId,
        emittingEvaluatorVersion: result.version
      }
    });
  }

  if (isFiniteNumber(metric.weight) && metric.weight !== 0 && !(metric.evidenceRefs?.length ?? 0)) {
    warnings.push({
      code: "metric.weighted_without_evidence",
      severity: "warning",
      evaluatorId,
      evaluatorVersion,
      metricId: metric.id,
      subjectId: metric.subjectId,
      message: "Metric has nonzero weight but no evidence references."
    });
  }

  const promotion = resolveRecordedMetricPromotion(metric, fallbackPolicy);
  if (isFiniteNumber(metric.weight) && metric.weight > 0 && !promotion.eligibleForScorecard) {
    warnings.push({
      code: "metric.weighted_excluded_from_scorecard",
      severity: "warning",
      evaluatorId,
      evaluatorVersion,
      metricId: metric.id,
      subjectId: metric.subjectId,
      message: "Metric has positive weight but is not scorecard-eligible under evaluation.metric-promotion.v1.",
      metadata: {
        promotionClass: promotion.promotionClass,
        reasons: promotion.reasons
      }
    });
  }

  if (metric.scope !== "episode" && !metric.subjectId) {
    warnings.push({
      code: "metric.non_episode_missing_subject",
      severity: "warning",
      evaluatorId,
      evaluatorVersion,
      metricId: metric.id,
      message: `Metric scope ${metric.scope} requires a subjectId for aggregation and audit.`
    });
  }

  const invalidFields = invalidNumericFields(metric);
  if (invalidFields.length) {
    warnings.push({
      code: "metric.invalid_numeric",
      severity: "warning",
      evaluatorId,
      evaluatorVersion,
      metricId: metric.id,
      subjectId: metric.subjectId,
      message: "Metric contains a non-finite or out-of-contract numeric field.",
      metadata: { invalidFields }
    });
  }

  const ratioIssues = ratioContractIssues(metric);
  if (ratioIssues.length) {
    warnings.push({
      code: "metric.ratio_contract_warning",
      severity: "warning",
      evaluatorId,
      evaluatorVersion,
      metricId: metric.id,
      subjectId: metric.subjectId,
      message: "Ratio/rate metric is missing denominator support or has an out-of-range value.",
      metadata: { issues: ratioIssues }
    });
  }

  for (const evidenceRef of metric.evidenceRefs ?? []) {
    if (
      evidenceRef.id === undefined &&
      evidenceRef.seq === undefined &&
      evidenceRef.traceId === undefined &&
      evidenceRef.description === undefined
    ) {
      warnings.push({
        code: "metric.evidence_ref_unlocated",
        severity: "warning",
        evaluatorId,
        evaluatorVersion,
        metricId: metric.id,
        subjectId: metric.subjectId,
        message: "Metric evidence reference has no id, seq, traceId, or description.",
        evidenceRefs: [evidenceRef]
      });
    }
  }
  return warnings;
}

function invalidNumericFields(metric: HarnessMetricRecord): string[] {
  const fields: string[] = [];
  if (typeof metric.value === "number" && !Number.isFinite(metric.value)) fields.push("value");
  if (typeof metric.weight === "number" && !Number.isFinite(metric.weight)) fields.push("weight");
  if (typeof metric.weight === "number" && metric.weight < 0) fields.push("weight_negative");
  if (typeof metric.denominator === "number" && !Number.isFinite(metric.denominator)) fields.push("denominator");
  if (typeof metric.denominator === "number" && metric.denominator < 0) fields.push("denominator_negative");
  if (typeof metric.confidence === "number" && (!Number.isFinite(metric.confidence) || metric.confidence < 0 || metric.confidence > 1)) {
    fields.push("confidence");
  }
  return fields;
}

function ratioContractIssues(metric: HarnessMetricRecord): string[] {
  const ratioLike = metric.unit === "ratio" || includesRatioTerm(metric.aggregation) || includesRatioTerm(metric.id);
  if (!ratioLike) return [];
  const issues: string[] = [];
  if (metric.denominator === undefined) issues.push("missing_denominator");
  if (metric.denominator === 0 && isFiniteNumber(metric.value) && metric.value !== 0) issues.push("zero_denominator_nonzero_value");
  if (isFiniteNumber(metric.value) && (metric.value < 0 || metric.value > 1)) issues.push("value_outside_0_1");
  return issues;
}

function includesRatioTerm(value: string | undefined): boolean {
  if (!value) return false;
  return /(^|[._:-])(ratio|rate)($|[._:-])/i.test(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
