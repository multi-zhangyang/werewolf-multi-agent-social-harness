import {
  METRIC_PROMOTION_POLICY_ID,
  createMetricPromotionCatalogEntry,
  createMetricPromotionPolicy,
  type MetricPromotionCatalogEntry,
  type MetricPromotionPolicy
} from "./evaluation";
import {
  DECEPTION_BELIEF_SHIFT_METRIC_IDS,
  DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS,
  WEREWOLF_DECEPTION_METRIC_IDS,
  WEREWOLF_INFLUENCE_METRIC_IDS,
  WEREWOLF_OUTCOME_METRIC_IDS,
  WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
  WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS,
  WEREWOLF_VOTE_ACCURACY_METRIC_IDS
} from "./evaluator";
import {
  SOCIAL_METRIC_PROMOTION_CATALOG_ENTRIES,
  SOCIAL_METRIC_PROMOTION_RULES
} from "./socialMetricPromotion";

export const WEREWOLF_METRIC_PROMOTION_CATALOG_ID = "werewolf.metric-promotion.catalog.v1" as const;

const SCORECARD_METRIC_IDS = new Set([
  "episode.completed_with_winner",
  "team.reward",
  "agent.reward",
  "profile.agent_reward",
  "model.agent_reward",
  "agent.vote_accuracy",
  "agent.deception_score"
]);

const WEREWOLF_DIAGNOSTIC_METRIC_IDS = uniqueStrings([
  ...WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
  ...WEREWOLF_INFLUENCE_METRIC_IDS,
  ...WEREWOLF_DECEPTION_METRIC_IDS.filter((metricId) => metricId !== "agent.deception_score"),
  ...DECEPTION_BELIEF_SHIFT_METRIC_IDS,
  ...DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS,
  ...WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS.filter((metricId) => !metricId.startsWith("agent.social."))
]);

const WEREWOLF_EXACT_METRIC_IDS = uniqueStrings([
  ...SCORECARD_METRIC_IDS,
  ...WEREWOLF_OUTCOME_METRIC_IDS,
  ...WEREWOLF_VOTE_ACCURACY_METRIC_IDS,
  ...WEREWOLF_DIAGNOSTIC_METRIC_IDS
]);

export const WEREWOLF_METRIC_PROMOTION_CATALOG_ENTRIES: readonly MetricPromotionCatalogEntry[] = [
  ...SOCIAL_METRIC_PROMOTION_CATALOG_ENTRIES.map((entry) => ({
    ...entry,
    decisionId: `${WEREWOLF_METRIC_PROMOTION_CATALOG_ID}#${entry.metricId}`
  })),
  ...WEREWOLF_EXACT_METRIC_IDS.map((metricId) =>
    createMetricPromotionCatalogEntry(
      WEREWOLF_METRIC_PROMOTION_CATALOG_ID,
      metricId,
      SCORECARD_METRIC_IDS.has(metricId) ? "scorecard" : "diagnostic",
      rationaleFor(metricId)
    )
  )
];

export const WEREWOLF_METRIC_PROMOTION_POLICY: MetricPromotionPolicy = createMetricPromotionPolicy({
  id: METRIC_PROMOTION_POLICY_ID,
  version: "1.0.0",
  catalog: {
    id: WEREWOLF_METRIC_PROMOTION_CATALOG_ID,
    version: "1.0.0",
    domainId: "werewolf",
    entries: WEREWOLF_METRIC_PROMOTION_CATALOG_ENTRIES,
    rules: SOCIAL_METRIC_PROMOTION_RULES
  }
});

function rationaleFor(metricId: string): string {
  if (metricId === "episode.completed_with_winner") return "Outcome completion is a core episode scorecard signal.";
  if (metricId === "team.reward") return "Team reward is the primary faction outcome scorecard metric.";
  if (metricId === "agent.reward") return "Agent reward is the primary per-agent outcome scorecard metric.";
  if (metricId === "profile.agent_reward") return "Profile reward samples aggregate agent rewards for scorecard splits.";
  if (metricId === "model.agent_reward") return "Model reward samples aggregate agent rewards for scorecard splits.";
  if (metricId === "agent.vote_accuracy") return "Vote accuracy is an evidence-backed skill metric eligible for scorecard aggregation.";
  if (metricId === "agent.deception_score") return "Legacy deception score remains scorecard-eligible until stronger exposure metrics replace it.";
  return "Werewolf domain diagnostic retained for audit and analysis, not a reward-bearing scorecard input.";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
