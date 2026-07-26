import { hashStableState } from "../hash";
import { HarnessEvaluationReport, HarnessMetricPromotionClass, HarnessMetricPromotionDecision, HarnessMetricRecord } from "../types";
import { emptyEvaluationSummary, isFiniteNumber } from "./metricSummary";
export const METRIC_PROMOTION_POLICY_ID = "evaluation.metric-promotion.v1" as const;
export const DEFAULT_METRIC_PROMOTION_CATALOG_ID = "harness.metric-promotion.generic.v1" as const;

export type MetricPromotionClass = HarnessMetricPromotionClass;

const METRIC_PROMOTION_CLASSES: readonly MetricPromotionClass[] = ["diagnostic", "scorecard", "benchmark_only"];

function isMetricPromotionClass(value: unknown): value is MetricPromotionClass {
  return typeof value === "string" && METRIC_PROMOTION_CLASSES.includes(value as MetricPromotionClass);
}

export function isNonEmptyString(value: unknown): value is string {
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

export function uncatalogedMetricPolicyFor(
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
