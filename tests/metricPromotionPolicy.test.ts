import { describe, expect, it } from "vitest";
import {
  createMetricPromotionCatalogEntry,
  createMetricPromotionPolicy,
  legacyMetricPromotionPolicyFromSummary,
  metric,
  metricPromotionIdentity,
  resolveRecordedMetricPromotion,
  runEvaluationRegistry,
  type HarnessEvaluationContext,
  type HarnessEvaluator,
  type MetricPromotionPolicy
} from "../src/harness/evaluation";

const LEDGER_POLICY = createMetricPromotionPolicy({
  id: "ledger.metric-promotion.v1",
  version: "1.0.0",
  catalog: {
    id: "ledger.metric-promotion.catalog.v1",
    version: "1.0.0",
    domainId: "ledger",
    entries: [
      createMetricPromotionCatalogEntry(
        "ledger.metric-promotion.catalog.v1",
        "ledger.reliable_entry_rate",
        "scorecard",
        "A ledger-domain reliability signal."
      )
    ],
    rules: []
  }
});

function context(id: string): HarnessEvaluationContext<{ entries: number }> {
  return {
    id,
    status: "completed",
    initialState: { entries: 0 },
    finalState: { entries: 1 },
    agents: [],
    trajectory: []
  };
}

function evaluator(): HarnessEvaluator<{ entries: number }> {
  return {
    id: "ledger.evaluator.v1",
    label: "Ledger evaluator",
    version: "1.0.0",
    evaluate() {
      return {
        evaluatorId: "ledger.evaluator.v1",
        label: "Ledger evaluator",
        version: "1.0.0",
        metrics: [
          metric({
            id: "ledger.reliable_entry_rate",
            label: "Reliable entry rate",
            scope: "episode",
            value: 1,
            weight: 1,
            source: "ledger.evaluator.v1",
            evidenceRefs: [{ artifact: "state", id: "ledger-final" }]
          })
        ]
      };
    }
  };
}

describe("metric promotion policy provenance", () => {
  it("materializes a domain-owned decision with stable policy and catalog identity", () => {
    const report = runEvaluationRegistry({
      id: "ledger-policy-report",
      createdAt: "2026-07-20T00:00:00.000Z",
      context: context("ledger-policy-report"),
      evaluators: [evaluator()],
      promotionPolicy: LEDGER_POLICY
    });
    const recorded = report.metrics[0]?.promotionDecision;
    const identity = metricPromotionIdentity(LEDGER_POLICY);

    expect(recorded).toMatchObject({
      ...identity,
      promotionClass: "scorecard",
      eligibleForScorecard: true,
      resolution: "recorded",
      catalogDecisionId: "ledger.metric-promotion.catalog.v1#ledger.reliable_entry_rate"
    });
    expect(report.metrics[0]).toMatchObject({ promotionClass: "scorecard" });
    expect(report.summary.promotion).toMatchObject({
      ...identity,
      decisionStorage: "per_metric_recorded"
    });
  });

  it("keeps the recorded result when a later policy classifies the same id differently", () => {
    const report = runEvaluationRegistry({
      id: "ledger-policy-stability",
      context: context("ledger-policy-stability"),
      evaluators: [evaluator()],
      promotionPolicy: LEDGER_POLICY
    });
    const laterPolicy = policyWithClass("diagnostic");
    const decision = resolveRecordedMetricPromotion(report.metrics[0]!, laterPolicy);

    expect(decision).toMatchObject({
      promotionClass: "scorecard",
      eligibleForScorecard: true,
      resolution: "recorded",
      catalogId: "ledger.metric-promotion.catalog.v1"
    });
  });

  it("uses a conservative, explicitly legacy resolution for raw historical metrics", () => {
    const fallback = legacyMetricPromotionPolicyFromSummary({
      policyId: "legacy.ledger.policy.v1",
      catalogId: "legacy.ledger.catalog.v1",
      catalogScorecardMetricIds: [],
      catalogDiagnosticMetricIds: [],
      catalogBenchmarkOnlyMetricIds: []
    });
    const decision = resolveRecordedMetricPromotion(
      metric({
        id: "ledger.future_unlisted_metric",
        label: "Future unlisted metric",
        scope: "episode",
        value: 1,
        weight: 1,
        source: "legacy-ledger",
        evidenceRefs: [{ artifact: "state", id: "final" }]
      }),
      fallback
    );

    expect(decision).toMatchObject({
      promotionClass: "diagnostic",
      eligibleForScorecard: false,
      resolution: "legacy_recomputed",
      catalogDecisionId: "legacy.ledger.catalog.v1#legacy:uncataloged"
    });
  });

  it("preserves an evaluator declaration separately from the final compatibility class", () => {
    const report = runEvaluationRegistry({
      id: "ledger-explicit-declaration",
      context: context("ledger-explicit-declaration"),
      evaluators: [
        {
          ...evaluator(),
          evaluate() {
            return {
              evaluatorId: "ledger.evaluator.v1",
              label: "Ledger evaluator",
              version: "1.0.0",
              metrics: [
                metric({
                  id: "ledger.explicit_diagnostic",
                  label: "Explicit diagnostic",
                  scope: "episode",
                  value: 1,
                  weight: 1,
                  source: "ledger.evaluator.v1",
                  promotionClass: "diagnostic",
                  evidenceRefs: [{ artifact: "state", id: "ledger-final" }]
                })
              ]
            };
          }
        }
      ],
      promotionPolicy: LEDGER_POLICY
    });

    expect(report.metrics[0]).toMatchObject({
      declaredPromotionClass: "diagnostic",
      promotionClass: "diagnostic",
      promotionDecision: expect.objectContaining({ reasons: ["explicit_diagnostic"] })
    });
  });

  it("rejects duplicate and invalid policy declarations before they can become provenance", () => {
    expect(() =>
      createMetricPromotionPolicy({
        id: "invalid.policy",
        version: "1.0.0",
        catalog: {
          id: "invalid.catalog",
          version: "1.0.0",
          domainId: "invalid",
          entries: [
            createMetricPromotionCatalogEntry("invalid.catalog", "metric.same", "diagnostic", "first"),
            createMetricPromotionCatalogEntry("invalid.catalog", "metric.same", "scorecard", "second")
          ],
          rules: []
        }
      })
    ).toThrow(/duplicate catalog metric id/);

    expect(() =>
      createMetricPromotionPolicy({
        id: "invalid.rule.policy",
        version: "1.0.0",
        catalog: {
          id: "invalid.rule.catalog",
          version: "1.0.0",
          domainId: "invalid",
          entries: [],
          rules: [
            {
              id: "catch-all-before-specific",
              match: "all",
              pattern: "",
              promotionClass: "diagnostic",
              rationale: "Invalid ordering"
            },
            {
              id: "specific",
              match: "prefix",
              pattern: "metric.",
              promotionClass: "scorecard",
              rationale: "Never reached"
            }
          ]
        }
      })
    ).toThrow(/match all must be last/);
  });
});

function policyWithClass(promotionClass: "scorecard" | "diagnostic"): MetricPromotionPolicy {
  return createMetricPromotionPolicy({
    id: "ledger.metric-promotion.v2",
    version: "2.0.0",
    catalog: {
      id: "ledger.metric-promotion.catalog.v2",
      version: "2.0.0",
      domainId: "ledger",
      entries: [
        createMetricPromotionCatalogEntry(
          "ledger.metric-promotion.catalog.v2",
          "ledger.reliable_entry_rate",
          promotionClass,
          "Later policy version."
        )
      ],
      rules: []
    }
  });
}
