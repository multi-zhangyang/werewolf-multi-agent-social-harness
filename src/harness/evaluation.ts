import type {
  AgentHarnessState,
  HarnessEvaluatorManifestConfig,
  HarnessEvaluatorManifestEntry,
  HarnessEvaluationModuleResult,
  HarnessEvaluationReport,
  HarnessEvaluationWarning,
  HarnessMetricRecord,
  HarnessMetricPromotionClass,
  HarnessMetricPromotionDecision,
  HarnessStepRecord
} from "./types";
import { hashStableState } from "./hash";

export type HarnessEvaluationStatus = "completed" | "truncated" | "failed";

/**
 * Domain-neutral evaluator input. A domain selects its own durable actor
 * snapshot and trajectory contracts; evaluators must not require a Werewolf
 * PlayerView, GameCommand, or legacy HarnessStepRecord unless they are
 * explicitly domain-owned evaluators.
 */
export interface HarnessEvaluationContext<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown,
  TAgent = AgentHarnessState,
  TTrajectory = HarnessStepRecord
> {
  id: string;
  status: HarnessEvaluationStatus;
  initialState: TState;
  finalState: TState;
  agents: TAgent[];
  trajectory: TTrajectory[];
  metrics?: TMetrics;
  socialEpisode?: TSocialEpisode;
}

export interface HarnessEvaluator<
  TState = unknown,
  TMetrics = unknown,
  TSocialEpisode = unknown,
  TOutput = unknown,
  TAgent = AgentHarnessState,
  TTrajectory = HarnessStepRecord
> {
  id: string;
  label: string;
  version: string;
  manifest?: HarnessEvaluatorManifestConfig;
  evaluate(context: HarnessEvaluationContext<TState, TMetrics, TSocialEpisode, TAgent, TTrajectory>): HarnessEvaluationModuleResult<TOutput>;
}

interface EvaluatorManifestSource {
  id: string;
  label: string;
  version: string;
  manifest?: HarnessEvaluatorManifestConfig;
}

interface EvaluationModuleRun {
  evaluator: EvaluatorManifestSource;
  result: HarnessEvaluationModuleResult;
  metrics: HarnessMetricRecord[];
  manifest: HarnessEvaluatorManifestEntry;
}

export function runEvaluationRegistry<
  TState,
  TMetrics,
  TSocialEpisode,
  TAgent = AgentHarnessState,
  TTrajectory = HarnessStepRecord
>(options: {
  id: string;
  context: HarnessEvaluationContext<TState, TMetrics, TSocialEpisode, TAgent, TTrajectory>;
  evaluators: Array<HarnessEvaluator<TState, TMetrics, TSocialEpisode, unknown, TAgent, TTrajectory>>;
  createdAt?: string;
  promotionPolicy?: MetricPromotionPolicy;
}): HarnessEvaluationReport {
  const promotionPolicy = options.promotionPolicy ?? DEFAULT_METRIC_PROMOTION_POLICY;
  const moduleResults = options.evaluators.map((evaluator) => {
    const result = evaluator.evaluate(options.context);
    const metrics = result.metrics.map((item) =>
      materializeMetricPromotion(
        {
          ...item,
          evaluatorId: item.evaluatorId ?? result.evaluatorId,
          evaluatorVersion: item.evaluatorVersion ?? result.version,
          evidenceRefs: item.evidenceRefs ?? []
        },
        promotionPolicy
      )
    );
    return { evaluator, result, metrics };
  });
  const metrics = moduleResults.flatMap((moduleResult) => moduleResult.metrics);
  const evaluatorRegistry = moduleResults.map(({ evaluator, result, metrics: moduleMetrics }) =>
    evaluatorManifestEntry(evaluator, result, moduleMetrics)
  );
  const moduleRuns: EvaluationModuleRun[] = moduleResults.map((moduleResult, index) => ({
    ...moduleResult,
    manifest: evaluatorRegistry[index]
  }));
  return {
    id: options.id,
    createdAt: options.createdAt ?? new Date().toISOString(),
    evaluatorIds: moduleResults.map(({ result }) => result.evaluatorId),
    evaluatorRegistry,
    metricCount: metrics.length,
    metrics,
    outputs: Object.fromEntries(moduleResults.map(({ result }) => [result.evaluatorId, result.output ?? null])),
    warnings: collectEvaluationWarnings(moduleRuns, promotionPolicy),
    summary: summarizeMetrics(metrics, promotionPolicy)
  };
}

function evaluatorManifestEntry(
  evaluator: EvaluatorManifestSource,
  result: HarnessEvaluationModuleResult,
  metrics: HarnessMetricRecord[]
): HarnessEvaluatorManifestEntry {
  const manifest = {
    ...(evaluator.manifest ?? {}),
    ...(result.manifest ?? {})
  };
  return {
    id: result.evaluatorId,
    label: result.label,
    version: result.version,
    inputSchema: manifest.inputSchema ?? "harness.evaluation.context.v1",
    outputSchema: manifest.outputSchema ?? "harness.evaluation.output.untyped.v1",
    mode: manifest.mode ?? "deterministic",
    metricIds: manifest.metricIds ? uniqueStrings(manifest.metricIds) : uniqueStrings(metrics.map((item) => item.id)),
    rubric: manifest.rubric,
    dependencies: manifest.dependencies ?? {},
    aggregation: manifest.aggregation ?? "weighted_summary",
    visibility: manifest.visibility ?? "postgame"
  };
}

export const METRIC_PROMOTION_POLICY_ID = "evaluation.metric-promotion.v1" as const;
export const DEFAULT_METRIC_PROMOTION_CATALOG_ID = "harness.metric-promotion.generic.v1" as const;

export type MetricPromotionClass = HarnessMetricPromotionClass;

const METRIC_PROMOTION_CLASSES: readonly MetricPromotionClass[] = ["diagnostic", "scorecard", "benchmark_only"];

function isMetricPromotionClass(value: unknown): value is MetricPromotionClass {
  return typeof value === "string" && METRIC_PROMOTION_CLASSES.includes(value as MetricPromotionClass);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export interface MetricPromotionDecision {
  eligibleForScorecard: boolean;
  promotionClass: MetricPromotionClass;
  reasons: string[];
  catalogDecisionId?: string;
}

export interface MetricPromotionCatalogEntry {
  metricId: string;
  promotionClass: MetricPromotionClass;
  decisionId: string;
  rationale: string;
}

export interface MetricPromotionCatalogRule {
  id: string;
  match: "prefix" | "includes" | "all";
  pattern: string;
  promotionClass: MetricPromotionClass;
  rationale: string;
}

/**
 * Pure, serializable catalog data owned by a domain or reusable harness plane.
 * The generic evaluator owns matching and scorecard eligibility, never the
 * domain metric ids themselves.
 */
export interface MetricPromotionCatalog {
  id: string;
  version: string;
  domainId: string;
  entries: readonly MetricPromotionCatalogEntry[];
  rules: readonly MetricPromotionCatalogRule[];
}

export interface MetricPromotionPolicy {
  id: string;
  version: string;
  catalog: MetricPromotionCatalog;
}

export interface MetricPromotionIdentity {
  policyId: string;
  policyVersion: string;
  policyHash: string;
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  catalogDomainId: string;
}

export const DEFAULT_METRIC_PROMOTION_POLICY: MetricPromotionPolicy = createMetricPromotionPolicy({
  id: METRIC_PROMOTION_POLICY_ID,
  version: "1.0.0",
  catalog: {
    id: DEFAULT_METRIC_PROMOTION_CATALOG_ID,
    version: "1.0.0",
    domainId: "harness.generic",
    entries: [],
    rules: []
  }
});

/**
 * Reader-only fallback for reports that predate durable promotion decisions
 * and do not retain a catalog summary. A missing historical policy must not
 * silently promote a positive-weight metric into a scorecard.
 */
export const LEGACY_UNKNOWN_METRIC_PROMOTION_POLICY: MetricPromotionPolicy = createMetricPromotionPolicy({
  id: "evaluation.metric-promotion.legacy-unknown.v1",
  version: "1.0.0",
  catalog: {
    id: "harness.metric-promotion.legacy-unknown.v1",
    version: "1.0.0",
    domainId: "legacy-artifact",
    entries: [],
    rules: [
      {
        id: "legacy:uncataloged",
        match: "all",
        pattern: "",
        promotionClass: "diagnostic",
        rationale: "Legacy report has no recoverable metric-promotion catalog; uncataloged metrics remain diagnostic."
      }
    ]
  }
});

/** @deprecated Use a domain-owned policy or DEFAULT_METRIC_PROMOTION_POLICY. */
export const METRIC_PROMOTION_CATALOG_ID = DEFAULT_METRIC_PROMOTION_CATALOG_ID;
/** @deprecated Generic evaluation has no built-in domain entries. */
export const METRIC_PROMOTION_CATALOG = DEFAULT_METRIC_PROMOTION_POLICY.catalog.entries;
/** @deprecated Generic evaluation has no built-in domain rules. */
export const METRIC_PROMOTION_CATALOG_RULES = DEFAULT_METRIC_PROMOTION_POLICY.catalog.rules;

export function createMetricPromotionCatalogEntry(
  catalogId: string,
  metricId: string,
  promotionClass: MetricPromotionClass,
  rationale: string
): MetricPromotionCatalogEntry {
  return {
    metricId,
    promotionClass,
    decisionId: `${catalogId}#${metricId}`,
    rationale
  };
}

export function createMetricPromotionPolicy(policy: MetricPromotionPolicy): MetricPromotionPolicy {
  const normalized: MetricPromotionPolicy = {
    id: policy.id,
    version: policy.version,
    catalog: {
      id: policy.catalog.id,
      version: policy.catalog.version,
      domainId: policy.catalog.domainId,
      entries: policy.catalog.entries.map((entry) => ({ ...entry })),
      rules: policy.catalog.rules.map((rule) => ({ ...rule }))
    }
  };
  const issues = validateMetricPromotionPolicy(normalized);
  if (issues.length) {
    throw new Error(`Invalid metric-promotion policy ${normalized.id}: ${issues.join("; ")}`);
  }
  return Object.freeze({
    ...normalized,
    catalog: Object.freeze({
      ...normalized.catalog,
      entries: Object.freeze(normalized.catalog.entries.map((entry) => Object.freeze({ ...entry }))),
      rules: Object.freeze(normalized.catalog.rules.map((rule) => Object.freeze({ ...rule })))
    })
  }) as MetricPromotionPolicy;
}

export function validateMetricPromotionPolicy(policy: MetricPromotionPolicy): string[] {
  const issues: string[] = [];
  if (!policy.id) issues.push("missing policy id");
  if (!policy.version) issues.push("missing policy version");
  if (!policy.catalog.id) issues.push("missing catalog id");
  if (!policy.catalog.version) issues.push("missing catalog version");
  if (!policy.catalog.domainId) issues.push("missing catalog domain id");

  const metricIds = new Set<string>();
  const decisionIds = new Set<string>();
  for (const entry of policy.catalog.entries) {
    if (!entry.metricId) issues.push("catalog entry has no metric id");
    if (!entry.decisionId) issues.push(`catalog entry ${entry.metricId || "unknown"} has no decision id`);
    if (!isMetricPromotionClass(entry.promotionClass)) {
      issues.push(`catalog entry ${entry.metricId || "unknown"} has invalid promotion class ${String(entry.promotionClass)}`);
    }
    if (entry.decisionId && !entry.decisionId.startsWith(`${policy.catalog.id}#`)) {
      issues.push(`catalog entry ${entry.metricId || "unknown"} decision id must use ${policy.catalog.id}# namespace`);
    }
    if (metricIds.has(entry.metricId)) issues.push(`duplicate catalog metric id ${entry.metricId}`);
    if (decisionIds.has(entry.decisionId)) issues.push(`duplicate catalog decision id ${entry.decisionId}`);
    metricIds.add(entry.metricId);
    decisionIds.add(entry.decisionId);
  }

  const ruleIds = new Set<string>();
  for (const [index, rule] of policy.catalog.rules.entries()) {
    if (!rule.id) issues.push("catalog rule has no id");
    if (rule.match !== "prefix" && rule.match !== "includes" && rule.match !== "all") {
      issues.push(`catalog rule ${rule.id || "unknown"} has invalid match kind ${String(rule.match)}`);
    }
    if (rule.match !== "all" && !rule.pattern) issues.push(`catalog rule ${rule.id || "unknown"} has no pattern`);
    if (rule.match === "all" && index !== policy.catalog.rules.length - 1) {
      issues.push(`catalog rule ${rule.id || "unknown"} with match all must be last`);
    }
    if (!isMetricPromotionClass(rule.promotionClass)) {
      issues.push(`catalog rule ${rule.id || "unknown"} has invalid promotion class ${String(rule.promotionClass)}`);
    }
    if (ruleIds.has(rule.id)) issues.push(`duplicate catalog rule id ${rule.id}`);
    const decisionId = `${policy.catalog.id}#${rule.id}`;
    if (decisionIds.has(decisionId)) issues.push(`catalog rule ${rule.id || "unknown"} duplicates catalog decision id ${decisionId}`);
    decisionIds.add(decisionId);
    ruleIds.add(rule.id);
  }
  return issues;
}

export function metricPromotionIdentity(policy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY): MetricPromotionIdentity {
  const catalogHash = hashStableState({
    id: policy.catalog.id,
    version: policy.catalog.version,
    domainId: policy.catalog.domainId,
    entries: policy.catalog.entries,
    rules: policy.catalog.rules
  });
  return {
    policyId: policy.id,
    policyVersion: policy.version,
    policyHash: hashStableState({ id: policy.id, version: policy.version, catalogHash }),
    catalogId: policy.catalog.id,
    catalogVersion: policy.catalog.version,
    catalogHash,
    catalogDomainId: policy.catalog.domainId
  };
}

function uncatalogedMetricPolicyFor(
  policy: MetricPromotionPolicy
): HarnessEvaluationReport["summary"]["promotion"]["uncatalogedMetricPolicy"] {
  return policy.catalog.domainId === "legacy-artifact"
    ? "legacy_conservative_diagnostic"
    : "implicit_positive_weight_with_evidence";
}

export function metricPromotionCatalogEntry(
  metricId: string,
  policy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY
): MetricPromotionCatalogEntry | undefined {
  const exact = policy.catalog.entries.find((entry) => entry.metricId === metricId);
  if (exact) return exact;
  for (const rule of policy.catalog.rules) {
    const matched =
      rule.match === "all" ||
      (rule.match === "prefix" ? metricId.startsWith(rule.pattern) : metricId.includes(rule.pattern));
    if (!matched) continue;
    return {
      metricId,
      promotionClass: rule.promotionClass,
      decisionId: `${policy.catalog.id}#${rule.id}`,
      rationale: rule.rationale
    };
  }
  return undefined;
}

export function summarizeMetricPromotionCatalog(
  policy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY
): {
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  catalogDomainId: string;
  entryCount: number;
  ruleCount: number;
  scorecardMetricIds: string[];
  diagnosticMetricIds: string[];
  benchmarkOnlyMetricIds: string[];
  ruleIds: string[];
} {
  const scorecardMetricIds: string[] = [];
  const diagnosticMetricIds: string[] = [];
  const benchmarkOnlyMetricIds: string[] = [];
  for (const entry of policy.catalog.entries) {
    if (entry.promotionClass === "scorecard") scorecardMetricIds.push(entry.metricId);
    else if (entry.promotionClass === "benchmark_only") benchmarkOnlyMetricIds.push(entry.metricId);
    else diagnosticMetricIds.push(entry.metricId);
  }
  const identity = metricPromotionIdentity(policy);
  return {
    catalogId: identity.catalogId,
    catalogVersion: identity.catalogVersion,
    catalogHash: identity.catalogHash,
    catalogDomainId: identity.catalogDomainId,
    entryCount: policy.catalog.entries.length,
    ruleCount: policy.catalog.rules.length,
    scorecardMetricIds: scorecardMetricIds.sort(),
    diagnosticMetricIds: diagnosticMetricIds.sort(),
    benchmarkOnlyMetricIds: benchmarkOnlyMetricIds.sort(),
    ruleIds: policy.catalog.rules.map((rule) => rule.id)
  };
}

/**
 * Generic scorecard eligibility algorithm. A domain policy only supplies a
 * catalog; it cannot bypass the finite-value, positive-weight, and evidence
 * constraints enforced here.
 */
export function decideMetricPromotion(
  metric: HarnessMetricRecord,
  policy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY
): MetricPromotionDecision {
  const reasons: string[] = [];
  const weight = isFiniteNumber(metric.weight) ? metric.weight : undefined;
  const hasEvidence = (metric.evidenceRefs?.length ?? 0) > 0;
  const catalogEntry = metricPromotionCatalogEntry(metric.id, policy);
  const declaredPromotionClass = metric.declaredPromotionClass ?? (metric.promotionDecision ? undefined : metric.promotionClass);
  const explicit = declaredPromotionClass ?? catalogEntry?.promotionClass;
  const catalogDecisionId = declaredPromotionClass ? undefined : catalogEntry?.decisionId;

  if (explicit === "diagnostic" || explicit === "benchmark_only") {
    return {
      eligibleForScorecard: false,
      promotionClass: explicit,
      reasons: [declaredPromotionClass ? `explicit_${explicit}` : `catalog_${explicit}`],
      ...(catalogDecisionId ? { catalogDecisionId } : {})
    };
  }

  if (explicit === "scorecard") {
    if (weight === undefined || weight <= 0) reasons.push("scorecard_requires_positive_weight");
    if (!hasEvidence) reasons.push("scorecard_requires_evidence");
    if (!isFiniteNumber(metric.value)) reasons.push("scorecard_requires_finite_value");
    if (reasons.length) {
      return {
        eligibleForScorecard: false,
        promotionClass: "scorecard",
        reasons,
        ...(catalogDecisionId ? { catalogDecisionId } : {})
      };
    }
    return {
      eligibleForScorecard: true,
      promotionClass: "scorecard",
      reasons: [declaredPromotionClass ? "explicit_scorecard" : "catalog_scorecard"],
      ...(catalogDecisionId ? { catalogDecisionId } : {})
    };
  }

  if (weight === undefined || weight <= 0) {
    return { eligibleForScorecard: false, promotionClass: "diagnostic", reasons: ["non_positive_or_missing_weight"] };
  }
  if (!isFiniteNumber(metric.value)) {
    return { eligibleForScorecard: false, promotionClass: "diagnostic", reasons: ["non_finite_value"] };
  }
  if (!hasEvidence) {
    return { eligibleForScorecard: false, promotionClass: "diagnostic", reasons: ["missing_evidence_refs"] };
  }
  return {
    eligibleForScorecard: true,
    promotionClass: "scorecard",
    reasons: ["implicit_positive_weight_with_evidence"]
  };
}

export function materializeMetricPromotion(
  metric: HarnessMetricRecord,
  policy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY
): HarnessMetricRecord {
  const declaredPromotionClass = metric.declaredPromotionClass ?? (metric.promotionDecision ? undefined : metric.promotionClass);
  const decision = decideMetricPromotion(
    {
      ...metric,
      declaredPromotionClass,
      promotionDecision: undefined
    },
    policy
  );
  const identity = metricPromotionIdentity(policy);
  const promotionDecision: HarnessMetricPromotionDecision = {
    ...identity,
    ...decision,
    resolution: "recorded"
  };
  return {
    ...metric,
    ...(declaredPromotionClass ? { declaredPromotionClass } : {}),
    promotionClass: decision.promotionClass,
    promotionDecision
  };
}

/**
 * Reads the immutable report-owned decision when it exists. Older artifacts
 * remain readable through an explicit fallback policy, and callers can surface
 * that the result was recomputed rather than recorded.
 */
export function resolveRecordedMetricPromotion(
  metric: HarnessMetricRecord,
  fallbackPolicy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY
): HarnessMetricPromotionDecision {
  if (metric.promotionDecision) return metric.promotionDecision;
  const decision = decideMetricPromotion(metric, fallbackPolicy);
  return {
    ...metricPromotionIdentity(fallbackPolicy),
    ...decision,
    resolution: "legacy_recomputed"
  };
}

/**
 * Builds a resolver only from a recorded report summary. This is intentionally
 * a lossy legacy path: new reports use per-metric immutable decisions instead.
 */
export function legacyMetricPromotionPolicyFromSummary(
  summary: Partial<HarnessEvaluationReport["summary"]["promotion"]> | undefined
): MetricPromotionPolicy {
  if (!summary?.catalogId) return LEGACY_UNKNOWN_METRIC_PROMOTION_POLICY;
  const catalogId = summary.catalogId;
  const classesByMetricId = new Map<string, MetricPromotionClass>();
  const recoverEntries = (value: unknown, promotionClass: MetricPromotionClass) => {
    if (!Array.isArray(value)) return;
    for (const metricId of value) {
      if (typeof metricId !== "string" || !metricId) continue;
      const existing = classesByMetricId.get(metricId);
      // Conflicting historical list membership cannot establish scorecard
      // eligibility. Preserve readability with a conservative diagnostic.
      classesByMetricId.set(metricId, existing && existing !== promotionClass ? "diagnostic" : promotionClass);
    }
  };
  recoverEntries(summary.catalogScorecardMetricIds, "scorecard");
  recoverEntries(summary.catalogDiagnosticMetricIds, "diagnostic");
  recoverEntries(summary.catalogBenchmarkOnlyMetricIds, "benchmark_only");
  const entries = [...classesByMetricId.entries()].map(([metricId, promotionClass]) =>
    createMetricPromotionCatalogEntry(catalogId, metricId, promotionClass, "Recovered from legacy report summary.")
  );
  return createMetricPromotionPolicy({
    id: summary.policyId ?? METRIC_PROMOTION_POLICY_ID,
    version: summary.policyVersion ?? "legacy",
    catalog: {
      id: catalogId,
      version: summary.catalogVersion ?? "legacy",
      domainId: summary.catalogDomainId ?? "legacy-artifact",
      entries,
      // The historical summary names rules but does not preserve their
      // match patterns. Unknown legacy metrics must remain diagnostic rather
      // than being silently promoted by the generic implicit-positive rule.
      rules: [
        {
          id: "legacy:uncataloged",
          match: "all",
          pattern: "",
          promotionClass: "diagnostic",
          rationale: "Legacy report catalog is incomplete; uncataloged metrics remain diagnostic."
        }
      ]
    }
  });
}

/**
 * Normalizes a possibly old report summary for read-only projections. New
 * reports always carry all fields; old reports receive only a conservative
 * fallback descriptor and remain marked by per-metric legacy_recomputed
 * resolution instead of being rewritten as current policy truth.
 */
export function normalizeMetricPromotionSummary(
  summary: Partial<HarnessEvaluationReport["summary"]["promotion"]> | undefined
): HarnessEvaluationReport["summary"]["promotion"] {
  const fallback = emptyEvaluationSummary({
    promotionPolicy: legacyMetricPromotionPolicyFromSummary(summary)
  }).promotion;
  return {
    ...fallback,
    ...summary,
    catalogRuleIds: [...(Array.isArray(summary?.catalogRuleIds) ? summary.catalogRuleIds.filter(isNonEmptyString) : fallback.catalogRuleIds)],
    catalogScorecardMetricIds: [
      ...(Array.isArray(summary?.catalogScorecardMetricIds)
        ? summary.catalogScorecardMetricIds.filter(isNonEmptyString)
        : fallback.catalogScorecardMetricIds)
    ],
    catalogDiagnosticMetricIds: [
      ...(Array.isArray(summary?.catalogDiagnosticMetricIds)
        ? summary.catalogDiagnosticMetricIds.filter(isNonEmptyString)
        : fallback.catalogDiagnosticMetricIds)
    ],
    catalogBenchmarkOnlyMetricIds: [
      ...(Array.isArray(summary?.catalogBenchmarkOnlyMetricIds)
        ? summary.catalogBenchmarkOnlyMetricIds.filter(isNonEmptyString)
        : fallback.catalogBenchmarkOnlyMetricIds)
    ],
    excludedWeightedMetricIds: [
      ...(Array.isArray(summary?.excludedWeightedMetricIds)
        ? summary.excludedWeightedMetricIds.filter(isNonEmptyString)
        : fallback.excludedWeightedMetricIds)
    ]
  };
}

export interface ResearchMetricPromotionSummary {
  id: string;
  scope: HarnessMetricRecord["scope"];
  subjectId?: string;
  value: HarnessMetricRecord["value"];
  weight?: number;
  source: string;
  promotionClass: MetricPromotionClass;
  scorecardEligible: boolean;
  promotionDecisionId: string | null;
  promotionResolution: HarnessMetricPromotionDecision["resolution"];
}

/**
 * Research CLI projection helper. Public server summaries must not expose these
 * rows when they would leak subject/score payloads; use promotion aggregates
 * only on redacted public surfaces.
 */
export function summarizeResearchMetricPromotionRows(
  metrics: readonly HarnessMetricRecord[],
  limit = 24,
  fallbackPolicy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY
): ResearchMetricPromotionSummary[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 24;
  return metrics.slice(0, safeLimit).map((metric) => {
    const promotion = resolveRecordedMetricPromotion(metric, fallbackPolicy);
    return {
      id: metric.id,
      scope: metric.scope,
      subjectId: metric.subjectId,
      value: metric.value,
      weight: metric.weight,
      source: metric.source,
      promotionClass: promotion.promotionClass,
      scorecardEligible: promotion.eligibleForScorecard,
      promotionDecisionId: promotion.catalogDecisionId ?? null,
      promotionResolution: promotion.resolution
    };
  });
}

export function isScorecardEligibleMetric(
  metric: HarnessMetricRecord,
  fallbackPolicy: MetricPromotionPolicy = DEFAULT_METRIC_PROMOTION_POLICY
): boolean {
  return resolveRecordedMetricPromotion(metric, fallbackPolicy).eligibleForScorecard;
}

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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function collectEvaluationWarnings(
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
