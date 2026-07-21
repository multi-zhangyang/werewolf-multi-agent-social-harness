import {
  createMetricPromotionCatalogEntry,
  createMetricPromotionPolicy,
  type MetricPromotionCatalogEntry,
  type MetricPromotionCatalogRule,
  type MetricPromotionPolicy
} from "./evaluation";
import {
  BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS,
  COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  SOCIAL_DYNAMICS_METRIC_IDS,
  SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS,
  SOCIAL_STATE_METRIC_IDS,
  TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS,
  TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS
} from "./socialEvaluator";

export const SOCIAL_METRIC_PROMOTION_POLICY_ID = "harness.social.metric-promotion.v1" as const;
export const SOCIAL_METRIC_PROMOTION_CATALOG_ID = "harness.social.metric-promotion.catalog.v1" as const;

const SOCIAL_DIAGNOSTIC_RATIONALE =
  "Social-state and social-dynamics metrics are formal diagnostics unless an explicit later scorecard policy changes them.";

export const SOCIAL_METRIC_PROMOTION_RULES: readonly MetricPromotionCatalogRule[] = [
  {
    id: "prefix:agent.social.",
    match: "prefix",
    pattern: "agent.social.",
    promotionClass: "diagnostic",
    rationale: SOCIAL_DIAGNOSTIC_RATIONALE
  },
  {
    id: "includes:temporal_association",
    match: "includes",
    pattern: "temporal_association",
    promotionClass: "diagnostic",
    rationale: "Temporal-association metrics remain diagnostic until an explicit later scorecard policy changes them."
  },
  {
    id: "includes:temporal_evaluable",
    match: "includes",
    pattern: "temporal_evaluable",
    promotionClass: "diagnostic",
    rationale: "Temporal evaluability and coverage metrics remain diagnostics rather than scorecard rewards."
  }
];

export const SOCIAL_DIAGNOSTIC_METRIC_IDS: readonly string[] = uniqueStrings([
  ...SOCIAL_STATE_METRIC_IDS,
  ...SOCIAL_DYNAMICS_METRIC_IDS,
  ...SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS,
  ...COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS,
  ...COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  ...NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  ...GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  ...TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  ...TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS,
  ...TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS,
  ...BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  "agent.social.reputation_threat_brier_score"
]);

export const SOCIAL_METRIC_PROMOTION_CATALOG_ENTRIES: readonly MetricPromotionCatalogEntry[] = SOCIAL_DIAGNOSTIC_METRIC_IDS.map(
  (metricId) => createMetricPromotionCatalogEntry(SOCIAL_METRIC_PROMOTION_CATALOG_ID, metricId, "diagnostic", SOCIAL_DIAGNOSTIC_RATIONALE)
);

export const SOCIAL_METRIC_PROMOTION_POLICY: MetricPromotionPolicy = createMetricPromotionPolicy({
  id: SOCIAL_METRIC_PROMOTION_POLICY_ID,
  version: "1.0.0",
  catalog: {
    id: SOCIAL_METRIC_PROMOTION_CATALOG_ID,
    version: "1.0.0",
    domainId: "harness.social",
    entries: SOCIAL_METRIC_PROMOTION_CATALOG_ENTRIES,
    rules: SOCIAL_METRIC_PROMOTION_RULES
  }
});

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
