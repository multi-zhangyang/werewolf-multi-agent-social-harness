import { describe, expect, it } from "vitest";
import { applyCommand, createGame, getPendingActions } from "../src/core/engine";
import { buildMatchArtifact } from "../src/harness/artifacts";
import {
  DEFAULT_METRIC_PROMOTION_POLICY,
  decideMetricPromotion,
  metric,
  metricPromotionCatalogEntry,
  resolveRecordedMetricPromotion,
  runEvaluationRegistry,
  summarizeResearchMetricPromotionRows
} from "../src/harness/evaluation";
import type { MetricPromotionPolicy } from "../src/harness/evaluation";
import { SOCIAL_METRIC_PROMOTION_POLICY } from "../src/harness/socialMetricPromotion";
import {
  WEREWOLF_METRIC_PROMOTION_CATALOG_ID,
  WEREWOLF_METRIC_PROMOTION_POLICY
} from "../src/harness/werewolfMetricPromotion";
import { deriveSocialExposureRecords } from "../src/harness/social";
import {
  WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
  WEREWOLF_ADVERSARIAL_METRIC_IDS,
  WEREWOLF_DECEPTION_EVALUATOR_ID,
  WEREWOLF_DECEPTION_METRIC_IDS,
  DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
  DECEPTION_BELIEF_SHIFT_METRIC_IDS,
  DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
  DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS,
  createDeceptionBeliefShiftEvaluator,
  createDeceptionReputationAssociationEvaluator,
  createWerewolfDeceptionEvaluator,
  createWerewolfSocialCalibrationEvaluator,
  evaluateAdversarialMatch,
  metricsFromWerewolfOutcomeEvaluation,
  metricsFromWerewolfDeceptionEvaluation,
  metricsFromWerewolfInfluenceEvaluation,
  metricsFromWerewolfVoteAccuracyEvaluation,
  WEREWOLF_INFLUENCE_EVALUATOR_ID,
  WEREWOLF_INFLUENCE_METRIC_IDS,
  WEREWOLF_OUTCOME_EVALUATOR_ID,
  WEREWOLF_OUTCOME_METRIC_IDS,
  WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
  WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
  WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
  WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS,
  WEREWOLF_VOTE_ACCURACY_EVALUATOR_ID,
  WEREWOLF_VOTE_ACCURACY_METRIC_IDS
} from "../src/harness/evaluator";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { runHarnessMatch } from "../src/harness/runtime";
import {
  appendSocialMemory,
  addSocialBetrayal,
  addSocialCoalition,
  addSocialCommitment,
  addSocialGossip,
  addSocialNorm,
  addSocialNormSanction,
  addSocialTrustRepair,
  createAgentSocialState,
  recordSocialBetrayalEvidence,
  recordSocialCoalitionEvidence,
  updateReputation,
  updateSocialCommitmentStatus,
  updateSocialRelationship,
  updateSocialNormStatus,
  updateSocialNormSanctionStatus,
  updateSocialReputation,
  updateSocialTrustRepairStatus,
  upsertBelief,
  upsertSocialBelief,
  type EvidenceRef
} from "../src/harness/socialState";
import {
  BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
  COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS,
  COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  createBetrayalLifecycleTemporalAssociationEvaluator,
  createCommitmentCoalitionAssociationEvaluator,
  createCommitmentCoalitionLifecycleTemporalAssociationEvaluator,
  createGossipExposureTemporalAssociationEvaluator,
  createNormSanctionLifecycleTemporalAssociationEvaluator,
  createSocialFactIngestEvidenceEvaluator,
  createSocialStateEvaluator,
  createSocialDynamicsEvaluator,
  createTrustRepairLifecycleTemporalAssociationEvaluator,
  createTrustRepairRelationshipTemporalAssociationEvaluator,
  createTrustRepairReputationTemporalAssociationEvaluator,
  GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  SOCIAL_DYNAMICS_EVALUATOR_ID,
  SOCIAL_DYNAMICS_METRIC_IDS,
  SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
  SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS,
  SOCIAL_STATE_EVALUATOR_ID,
  SOCIAL_STATE_METRIC_IDS,
  TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
  TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS,
  TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
  TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS
} from "../src/harness/socialEvaluator";
import type { HarnessEvaluator, HarnessEvaluationContext } from "../src/harness/evaluation";
import type { HarnessReasoner, AgentHarnessState } from "../src/harness/types";
import type { SocialEpisodeArtifact, SocialMessage } from "../src/harness/social";
import type { GameState, PendingAction } from "../src/core/types";

function advanceSystem(state: GameState): GameState {
  let next = state;
  let guard = 0;
  while (guard < 20) {
    const pending = getPendingActions(next);
    if (pending.length !== 1 || pending[0].kind !== "advance") return next;
    next = applyCommand(next, { type: "system.advance", actorId: "system" });
    guard += 1;
  }
  throw new Error("advanceSystem guard exceeded");
}

function pendingByKind<K extends PendingAction["kind"]>(state: GameState, kind: K): Extract<PendingAction, { kind: K }>[] {
  return getPendingActions(state).filter((action): action is Extract<PendingAction, { kind: K }> => action.kind === kind);
}

function differentRole(role: GameState["players"][number]["role"]): GameState["players"][number]["role"] {
  return role === "seer" ? "witch" : "seer";
}

describe("generic evaluation registry", () => {
  function genericContext(id: string): HarnessEvaluationContext<{ ok: boolean }> {
    return {
      id,
      status: "completed",
      initialState: { ok: false },
      finalState: { ok: true },
      agents: [],
      trajectory: []
    };
  }

  it("runs registered evaluators and aggregates weighted metric scopes", () => {
    const evaluator: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.social-test",
      label: "Generic social evaluator",
      version: "0.1.0",
      evaluate(context: HarnessEvaluationContext<{ ok: boolean }>) {
        return {
          evaluatorId: "generic.social-test",
          label: "Generic social evaluator",
          version: "0.1.0",
          metrics: [
            metric({
              id: "episode.score",
              label: "Episode score",
              scope: "episode",
              value: context.finalState.ok ? 1 : 0,
              weight: 1,
              source: "generic.social-test",
              evidenceRefs: [{ artifact: "state", description: "final_state.ok" }]
            }),
            metric({
              id: "agent.score",
              label: "Agent score",
              scope: "agent",
              subjectId: "a1",
              value: 0.2,
              weight: 1,
              source: "generic.social-test",
              evidenceRefs: [{ artifact: "trace", traceId: "a1-turn-1" }]
            }),
            metric({
              id: "agent.score",
              label: "Agent score",
              scope: "agent",
              subjectId: "a1",
              value: 0.8,
              weight: 3,
              source: "generic.social-test",
              evidenceRefs: [{ artifact: "trace", traceId: "a1-turn-2" }]
            })
          ],
          output: { checked: true }
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "generic-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "generic-eval",
        status: "completed",
        initialState: { ok: false },
        finalState: { ok: true },
        agents: [],
        trajectory: []
      },
      evaluators: [evaluator]
    });

    expect(report.evaluatorIds).toEqual(["generic.social-test"]);
    expect(report.evaluatorRegistry).toEqual([
      {
        id: "generic.social-test",
        label: "Generic social evaluator",
        version: "0.1.0",
        inputSchema: "harness.evaluation.context.v1",
        outputSchema: "harness.evaluation.output.untyped.v1",
        mode: "deterministic",
        metricIds: ["episode.score", "agent.score"],
        rubric: undefined,
        dependencies: {},
        aggregation: "weighted_summary",
        visibility: "postgame"
      }
    ]);
    expect(report.metricCount).toBe(3);
    expect(report.metrics.every((item) => item.evaluatorId === "generic.social-test")).toBe(true);
    expect(report.metrics.every((item) => item.evaluatorVersion === "0.1.0")).toBe(true);
    expect(report.metrics.every((item) => Array.isArray(item.evidenceRefs))).toBe(true);
    expect(report.outputs["generic.social-test"]).toEqual({ checked: true });
    expect(report.summary.episodeScore).toBe(1);
    expect(report.summary.agentScores.a1).toBe(0.65);
  });

  it("isolates every evaluator behind an independent immutable snapshot of recorded truth", () => {
    const context = genericContext("immutable-evaluator-input");
    const receivedContexts: unknown[] = [];
    const mutatingEvaluator: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.mutating-evaluator",
      label: "Mutating evaluator",
      version: "1.0.0",
      evaluate(received) {
        receivedContexts.push(received);
        received.finalState.ok = false;
        return {
          evaluatorId: "generic.mutating-evaluator",
          label: "Mutating evaluator",
          version: "1.0.0",
          metrics: []
        };
      }
    };
    const observingEvaluator: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.observing-evaluator",
      label: "Observing evaluator",
      version: "1.0.0",
      evaluate(received) {
        receivedContexts.push(received);
        expect(Object.isFrozen(received)).toBe(true);
        expect(Object.isFrozen(received.finalState)).toBe(true);
        return {
          evaluatorId: "generic.observing-evaluator",
          label: "Observing evaluator",
          version: "1.0.0",
          metrics: [
            metric({
              id: "episode.observed_recorded_truth",
              label: "Observed recorded truth",
              scope: "episode",
              value: received.finalState.ok ? 1 : 0,
              source: "generic.observing-evaluator"
            })
          ]
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "immutable-evaluator-input",
      createdAt: new Date(0).toISOString(),
      context,
      evaluators: [mutatingEvaluator, observingEvaluator]
    });

    expect(report.status).toBe("incomplete");
    expect(report.failures).toEqual([
      expect.objectContaining({
        evaluatorId: "generic.mutating-evaluator",
        stage: "evaluate",
        code: "evaluator_exception"
      })
    ]);
    expect(report.metrics).toEqual([
      expect.objectContaining({ id: "episode.observed_recorded_truth", value: 1 })
    ]);
    expect(context.finalState.ok).toBe(true);
    expect(receivedContexts).toHaveLength(2);
    expect(receivedContexts[0]).not.toBe(receivedContexts[1]);
    expect(receivedContexts[0]).not.toBe(context);
    expect(receivedContexts[1]).not.toBe(context);
  });

  it("anchors evaluator inputs and prior outputs to runner-owned snapshots", () => {
    const context = genericContext("snapshot-anchored-evaluator-input");
    const sharedResult = {
      evaluatorId: "generic.shared-result",
      label: "Shared result evaluator",
      version: "1.0.0",
      metrics: [
        metric({
          id: "episode.shared_result_truth",
          label: "Shared result truth",
          scope: "episode" as const,
          value: 1,
          source: "generic.shared-result"
        })
      ],
      output: { verdict: "original" }
    };
    const first: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.shared-result",
      label: "Shared result evaluator",
      version: "1.0.0",
      evaluate() {
        return sharedResult;
      }
    };
    const second: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.snapshot-observer",
      label: "Snapshot observer",
      version: "1.0.0",
      evaluate(received) {
        // Simulate plugin closure state changing both caller-owned input and a
        // previously returned object. Neither may rewrite registry authority.
        context.finalState.ok = false;
        sharedResult.metrics[0]!.value = 0;
        sharedResult.output.verdict = "tampered";
        return {
          evaluatorId: "generic.snapshot-observer",
          label: "Snapshot observer",
          version: "1.0.0",
          metrics: [
            metric({
              id: "episode.snapshot_observed_truth",
              label: "Snapshot observed truth",
              scope: "episode",
              value: received.finalState.ok ? 1 : 0,
              source: "generic.snapshot-observer"
            })
          ]
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "snapshot-anchored-evaluator-input",
      createdAt: new Date(0).toISOString(),
      context,
      evaluators: [first, second]
    });

    expect(report.metrics.map(({ id, value }) => [id, value])).toEqual([
      ["episode.shared_result_truth", 1],
      ["episode.snapshot_observed_truth", 1]
    ]);
    expect(report.outputs["generic.shared-result"]).toEqual({ verdict: "original" });
    expect(context.finalState.ok).toBe(false);
  });

  it("anchors metric-promotion authority before evaluator closure code can mutate the caller policy", () => {
    const policy: MetricPromotionPolicy = {
      id: "evaluation.test-policy",
      version: "1",
      catalog: {
        id: "evaluation.test-catalog",
        version: "1",
        domainId: "test",
        entries: [{
          metricId: "episode.policy_anchored",
          promotionClass: "diagnostic",
          decisionId: "evaluation.test-catalog#episode.policy_anchored",
          rationale: "Remain diagnostic during this registry run."
        }],
        rules: []
      }
    };
    const evaluator: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.policy-mutator",
      label: "Policy mutator",
      version: "1.0.0",
      evaluate() {
        (policy.catalog.entries[0] as { promotionClass: string }).promotionClass = "scorecard";
        return {
          evaluatorId: "generic.policy-mutator",
          label: "Policy mutator",
          version: "1.0.0",
          metrics: [
            metric({
              id: "episode.policy_anchored",
              label: "Policy anchored",
              scope: "episode",
              value: 1,
              weight: 1,
              source: "generic.policy-mutator",
              evidenceRefs: [{ artifact: "trace", traceId: "policy-anchor" }]
            })
          ]
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "policy-authority-anchor",
      createdAt: new Date(0).toISOString(),
      context: genericContext("policy-authority-anchor"),
      evaluators: [evaluator],
      promotionPolicy: policy
    });

    expect(policy.catalog.entries[0]?.promotionClass).toBe("scorecard");
    expect(report.metrics[0]?.promotionDecision).toMatchObject({
      policyId: "evaluation.test-policy",
      catalogId: "evaluation.test-catalog",
      promotionClass: "diagnostic",
      eligibleForScorecard: false,
      reasons: ["catalog_diagnostic"]
    });
    expect(report.summary.episodeScore).toBeUndefined();
  });

  it("contains non-portable nested metrics and cyclic evaluator manifests as module failures", () => {
    const cyclicMetric: Record<string, unknown> = {
      id: "episode.cyclic",
      label: "Cyclic metric",
      scope: "episode",
      value: 1,
      weight: 1,
      source: "generic.cyclic-result",
      evidenceRefs: []
    };
    cyclicMetric.metadata = { cyclicMetric };
    const cyclicManifest: Record<string, unknown> = { mode: "deterministic" };
    cyclicManifest.dependencies = { cyclicManifest };
    const invalidResult: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.cyclic-result",
      label: "Cyclic result",
      version: "1.0.0",
      evaluate() {
        return {
          evaluatorId: "generic.cyclic-result",
          label: "Cyclic result",
          version: "1.0.0",
          metrics: [cyclicMetric]
        } as never;
      }
    };
    const invalidManifest: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.cyclic-manifest",
      label: "Cyclic manifest",
      version: "1.0.0",
      manifest: cyclicManifest as never,
      evaluate() {
        throw new Error("must not execute with an invalid manifest");
      }
    };
    const invalidNestedNumber: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.nonfinite-nested",
      label: "Non-finite nested metric",
      version: "1.0.0",
      evaluate() {
        return {
          evaluatorId: "generic.nonfinite-nested",
          label: "Non-finite nested metric",
          version: "1.0.0",
          metrics: [
            metric({
              id: "episode.nonfinite_nested",
              label: "Non-finite nested metric",
              scope: "episode",
              value: 1,
              source: "generic.nonfinite-nested",
              metadata: { invalidNestedValue: Number.POSITIVE_INFINITY }
            })
          ]
        };
      }
    };
    const healthy: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.healthy-after-invalid",
      label: "Healthy after invalid",
      version: "1.0.0",
      evaluate() {
        return {
          evaluatorId: "generic.healthy-after-invalid",
          label: "Healthy after invalid",
          version: "1.0.0",
          metrics: [
            metric({
              id: "episode.healthy_after_invalid",
              label: "Healthy after invalid",
              scope: "episode",
              value: 1,
              source: "generic.healthy-after-invalid"
            })
          ]
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "invalid-evaluator-data-isolation",
      createdAt: new Date(0).toISOString(),
      context: genericContext("invalid-evaluator-data-isolation"),
      evaluators: [invalidResult, invalidManifest, invalidNestedNumber, healthy]
    });

    expect(report.status).toBe("incomplete");
    expect(report.failures).toEqual([
      expect.objectContaining({ evaluatorId: "generic.cyclic-result", stage: "result_normalization" }),
      expect.objectContaining({ evaluatorId: "generic.cyclic-manifest", stage: "result_normalization" }),
      expect.objectContaining({ evaluatorId: "generic.nonfinite-nested", stage: "result_normalization" })
    ]);
    expect(report.evaluatorIds).toEqual(["generic.healthy-after-invalid"]);
    expect(report.metrics).toEqual([
      expect.objectContaining({ id: "episode.healthy_after_invalid", value: 1 })
    ]);
  });

  it("isolates evaluator exceptions, preserves successful modules, and never persists raw exception text", () => {
    const executionOrder: string[] = [];
    const healthy = (id: string): HarnessEvaluator<{ ok: boolean }> => ({
      id,
      label: `${id} evaluator`,
      version: "1.0.0",
      evaluate() {
        executionOrder.push(id);
        return {
          evaluatorId: id,
          label: `${id} evaluator`,
          version: "1.0.0",
          metrics: [
            metric({
              id: `${id}.metric`,
              label: `${id} metric`,
              scope: "episode",
              value: 1,
              source: id,
              evidenceRefs: [{ artifact: "state", description: id }]
            })
          ],
          output: { id }
        };
      }
    });
    const failed: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.intentional-throw",
      label: "Intentional throwing evaluator",
      version: "1.0.0",
      evaluate() {
        executionOrder.push("generic.intentional-throw");
        throw new Error("raw evaluator exception must never reach the artifact");
      }
    };

    const report = runEvaluationRegistry({
      id: "isolated-evaluator-exception",
      createdAt: new Date(0).toISOString(),
      context: genericContext("isolated-evaluator-exception"),
      evaluators: [healthy("generic.before"), failed, healthy("generic.after")]
    });

    expect(executionOrder).toEqual(["generic.before", "generic.intentional-throw", "generic.after"]);
    expect(report.status).toBe("incomplete");
    expect(report.failures).toEqual([
      {
        evaluatorId: "generic.intentional-throw",
        label: "Intentional throwing evaluator",
        version: "1.0.0",
        stage: "evaluate",
        code: "evaluator_exception",
        message: "Evaluator execution failed; no metrics or output were recorded."
      }
    ]);
    expect(report.evaluatorIds).toEqual(["generic.before", "generic.after"]);
    expect(report.evaluatorRegistry?.map((entry) => entry.id)).toEqual([
      "generic.before",
      "generic.intentional-throw",
      "generic.after"
    ]);
    expect(report.metrics.map((item) => item.id)).toEqual(["generic.before.metric", "generic.after.metric"]);
    expect(report.outputs).toEqual({
      "generic.before": { id: "generic.before" },
      "generic.after": { id: "generic.after" }
    });
    expect(JSON.stringify(report)).not.toContain("raw evaluator exception");
  });

  it("isolates malformed module results during normalization and continues in registration order", () => {
    const executionOrder: string[] = [];
    const malformed: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.malformed-result",
      label: "Malformed result evaluator",
      version: "1.0.0",
      evaluate() {
        executionOrder.push("generic.malformed-result");
        return {
          evaluatorId: "generic.malformed-result",
          label: "Malformed result evaluator",
          version: "1.0.0",
          metrics: null
        } as unknown as ReturnType<HarnessEvaluator<{ ok: boolean }>["evaluate"]>;
      }
    };
    const healthy: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.after-malformed",
      label: "After malformed evaluator",
      version: "1.0.0",
      evaluate() {
        executionOrder.push("generic.after-malformed");
        return {
          evaluatorId: "generic.after-malformed",
          label: "After malformed evaluator",
          version: "1.0.0",
          metrics: [],
          output: { continued: true }
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "isolated-malformed-evaluator-result",
      createdAt: new Date(0).toISOString(),
      context: genericContext("isolated-malformed-evaluator-result"),
      evaluators: [malformed, healthy]
    });

    expect(executionOrder).toEqual(["generic.malformed-result", "generic.after-malformed"]);
    expect(report.status).toBe("incomplete");
    expect(report.failures).toEqual([
      {
        evaluatorId: "generic.malformed-result",
        label: "Malformed result evaluator",
        version: "1.0.0",
        stage: "result_normalization",
        code: "invalid_module_result",
        message: "Evaluator returned an invalid module result; no metrics or output were recorded."
      }
    ]);
    expect(report.evaluatorIds).toEqual(["generic.after-malformed"]);
    expect(report.outputs).toEqual({ "generic.after-malformed": { continued: true } });
    expect(JSON.stringify(report)).not.toContain("TypeError");
  });

  it("applies evaluation.metric-promotion.v1 so zero-weight and unevidenced weights stay off scorecards", () => {
    const evaluator: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.promotion-policy",
      label: "Promotion policy evaluator",
      version: "1.0.0",
      evaluate() {
        return {
          evaluatorId: "generic.promotion-policy",
          label: "Promotion policy evaluator",
          version: "1.0.0",
          metrics: [
            metric({
              id: "episode.scorecard_ready",
              label: "Scorecard ready",
              scope: "episode",
              value: 1,
              weight: 2,
              source: "generic.promotion-policy",
              evidenceRefs: [{ artifact: "event", seq: 1 }]
            }),
            metric({
              id: "agent.temporal_diagnostic",
              label: "Temporal diagnostic",
              scope: "agent",
              subjectId: "a1",
              value: 0.9,
              weight: 0,
              source: "generic.promotion-policy",
              evidenceRefs: [{ artifact: "message", seq: 2 }],
              promotionClass: "diagnostic"
            }),
            metric({
              id: "agent.positive_weight_no_evidence",
              label: "Positive weight no evidence",
              scope: "agent",
              subjectId: "a1",
              value: 0.5,
              weight: 4,
              source: "generic.promotion-policy"
            }),
            metric({
              id: "agent.explicit_scorecard",
              label: "Explicit scorecard",
              scope: "agent",
              subjectId: "a2",
              value: 0.25,
              weight: 1,
              source: "generic.promotion-policy",
              promotionClass: "scorecard",
              evidenceRefs: [{ artifact: "trace", traceId: "a2-decision" }]
            }),
            metric({
              id: "model.benchmark_only",
              label: "Benchmark only",
              scope: "model",
              subjectId: "model-a",
              value: 0.8,
              weight: 3,
              source: "generic.promotion-policy",
              promotionClass: "benchmark_only",
              evidenceRefs: [{ artifact: "state", description: "benchmark seed" }]
            })
          ]
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "promotion-policy-eval",
      createdAt: new Date(0).toISOString(),
      context: genericContext("promotion-policy-eval"),
      evaluators: [evaluator]
    });

    expect(report.summary.episodeScore).toBe(1);
    expect(report.summary.agentScores).toEqual({ a2: 0.25 });
    expect(report.summary.modelScores).toEqual({});
    expect(report.summary.promotion).toMatchObject({
      policyId: "evaluation.metric-promotion.v1",
      catalogId: "harness.metric-promotion.generic.v1",
      catalogDomainId: "harness.generic",
      catalogEntryCount: 0,
      catalogRuleCount: 0,
      catalogRuleIds: [],
      catalogScorecardMetricIds: [],
      catalogDiagnosticMetricIds: [],
      catalogBenchmarkOnlyMetricIds: [],
      scorecardMetricCount: 2,
      diagnosticMetricCount: 3,
      weightedMetricCount: 4,
      excludedWeightedMetricCount: 2,
      excludedWeightedMetricIds: ["agent.positive_weight_no_evidence", "model.benchmark_only"],
      scorecardRequiresEvidence: true,
      scorecardRequiresPositiveWeight: true,
      uncatalogedMetricPolicy: "implicit_positive_weight_with_evidence"
    });
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "metric.weighted_excluded_from_scorecard",
          metricId: "agent.positive_weight_no_evidence"
        }),
        expect.objectContaining({
          code: "metric.weighted_excluded_from_scorecard",
          metricId: "model.benchmark_only",
          metadata: expect.objectContaining({
            promotionClass: "benchmark_only"
          })
        })
      ])
    );
  });

  it("projects research topMetrics rows with promotion decisions without inventing scorecard eligibility", () => {
    const rows = summarizeResearchMetricPromotionRows(
      [
        metric({
          id: "agent.reward",
          label: "Agent reward",
          scope: "agent",
          subjectId: "a1",
          value: 1,
          weight: 1,
          source: "werewolf.outcome.v1",
          evidenceRefs: [{ artifact: "state", id: "final" }]
        }),
        metric({
          id: "agent.social.commitment_speech_act_ingest_link_count",
          label: "Commitment ingest",
          scope: "agent",
          subjectId: "a1",
          value: 2,
          weight: 0,
          source: "evaluation.social-fact-ingest-evidence.v1",
          evidenceRefs: [{ artifact: "message", seq: 3 }]
        }),
        metric({
          id: "agent.extra",
          label: "Extra",
          scope: "agent",
          subjectId: "a2",
          value: 0,
          weight: 0,
          source: "generic"
        })
      ],
      2,
      WEREWOLF_METRIC_PROMOTION_POLICY
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "agent.reward",
      subjectId: "a1",
      promotionClass: "scorecard",
      scorecardEligible: true
    });
    expect(rows[0]?.promotionDecisionId).toBe(`${WEREWOLF_METRIC_PROMOTION_CATALOG_ID}#agent.reward`);
    expect(rows[1]).toMatchObject({
      id: "agent.social.commitment_speech_act_ingest_link_count",
      promotionClass: "diagnostic",
      scorecardEligible: false
    });
    expect(rows[1]?.promotionDecisionId).toBe(
      `${WEREWOLF_METRIC_PROMOTION_CATALOG_ID}#agent.social.commitment_speech_act_ingest_link_count`
    );
  });

  it("keeps exact catalog diagnostic decisions for all social metric id constants", () => {
    const socialMetricIds = [
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
      ...BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS
    ];

    for (const metricId of socialMetricIds) {
      const entry = metricPromotionCatalogEntry(metricId, SOCIAL_METRIC_PROMOTION_POLICY);
      expect(entry, metricId).toBeDefined();
      expect(entry?.promotionClass).toBe("diagnostic");
      // Exact catalog entries use metric-id decision ids; prefix/include rules use rule ids.
      expect(entry?.decisionId).toBe(`harness.social.metric-promotion.catalog.v1#${metricId}`);
    }

    // Guard the previously missing ingest-link family explicitly.
    expect(metricPromotionCatalogEntry("agent.social.commitment_speech_act_ingest_link_count", SOCIAL_METRIC_PROMOTION_POLICY)).toMatchObject({
      promotionClass: "diagnostic",
      decisionId: "harness.social.metric-promotion.catalog.v1#agent.social.commitment_speech_act_ingest_link_count"
    });
  });

  it("never promotes social metric constants to scorecard even with weight and evidence", () => {
    const socialMetricIds = [
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
      ...BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS
    ];

    for (const metricId of socialMetricIds) {
      const decision = decideMetricPromotion(
        metric({
          id: metricId,
          label: metricId,
          scope: "agent",
          subjectId: "a1",
          value: 1,
          weight: 1,
          source: "test.social-anti-promotion",
          evidenceRefs: [{ artifact: "agent_state", seq: 1 }]
        }),
        SOCIAL_METRIC_PROMOTION_POLICY
      );
      expect(decision, metricId).toMatchObject({
        eligibleForScorecard: false,
        promotionClass: "diagnostic",
        catalogDecisionId: `harness.social.metric-promotion.catalog.v1#${metricId}`
      });
      expect(decision.reasons).toEqual(expect.arrayContaining(["catalog_diagnostic"]));
    }

    // Scorecard metrics remain eligible under the same weight/evidence conditions.
    expect(
      decideMetricPromotion(
        metric({
          id: "agent.reward",
          label: "Agent reward",
          scope: "agent",
          subjectId: "a1",
          value: 1,
          weight: 1,
          source: "test.social-anti-promotion",
          evidenceRefs: [{ artifact: "event", seq: 1 }]
        }),
        WEREWOLF_METRIC_PROMOTION_POLICY
      )
    ).toMatchObject({
      eligibleForScorecard: true,
      promotionClass: "scorecard"
    });
  });

  it("covers all Werewolf metric id constants with exact catalog decisions", () => {
    const scorecardMetricIds = new Set([
      "episode.completed_with_winner",
      "team.reward",
      "agent.reward",
      "profile.agent_reward",
      "model.agent_reward",
      "agent.vote_accuracy",
      "agent.deception_score"
    ]);
    const werewolfMetricIds = [
      ...WEREWOLF_OUTCOME_METRIC_IDS,
      ...WEREWOLF_VOTE_ACCURACY_METRIC_IDS,
      ...WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
      ...WEREWOLF_INFLUENCE_METRIC_IDS,
      ...WEREWOLF_DECEPTION_METRIC_IDS,
      ...WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS,
      ...DECEPTION_BELIEF_SHIFT_METRIC_IDS,
      ...DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS
    ];

    for (const metricId of werewolfMetricIds) {
      const entry = metricPromotionCatalogEntry(metricId, WEREWOLF_METRIC_PROMOTION_POLICY);
      expect(entry, metricId).toBeDefined();
      expect(entry?.decisionId).toBe(`${WEREWOLF_METRIC_PROMOTION_CATALOG_ID}#${metricId}`);
      if (scorecardMetricIds.has(metricId)) {
        expect(entry?.promotionClass, metricId).toBe("scorecard");
        expect(
          decideMetricPromotion(
            metric({
              id: metricId,
              label: metricId,
              scope: "agent",
              subjectId: "a1",
              value: 1,
              weight: 1,
              source: "test.werewolf-catalog",
              evidenceRefs: [{ artifact: "event", seq: 1 }]
            }),
            WEREWOLF_METRIC_PROMOTION_POLICY
          )
        ).toMatchObject({
          eligibleForScorecard: true,
          promotionClass: "scorecard"
        });
      } else {
        expect(entry?.promotionClass, metricId).toBe("diagnostic");
        expect(
          decideMetricPromotion(
            metric({
              id: metricId,
              label: metricId,
              scope: "agent",
              subjectId: "a1",
              value: 1,
              weight: 1,
              source: "test.werewolf-catalog",
              evidenceRefs: [{ artifact: "event", seq: 1 }]
            }),
            WEREWOLF_METRIC_PROMOTION_POLICY
          )
        ).toMatchObject({
          eligibleForScorecard: false,
          promotionClass: "diagnostic",
          catalogDecisionId: `${WEREWOLF_METRIC_PROMOTION_CATALOG_ID}#${metricId}`
        });
      }
    }
  });




  it("applies formal metric promotion catalog decisions for known Werewolf metric ids", () => {
    const evaluator: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.catalog-promotion",
      label: "Catalog promotion evaluator",
      version: "1.0.0",
      evaluate() {
        return {
          evaluatorId: "generic.catalog-promotion",
          label: "Catalog promotion evaluator",
          version: "1.0.0",
          metrics: [
            metric({
              id: "agent.reward",
              label: "Agent reward",
              scope: "agent",
              subjectId: "a1",
              value: 0.8,
              weight: 1,
              source: "generic.catalog-promotion",
              evidenceRefs: [{ artifact: "event", seq: 1 }]
            }),
            metric({
              id: "agent.survival_rate",
              label: "Survival",
              scope: "agent",
              subjectId: "a1",
              value: 1,
              weight: 0,
              source: "generic.catalog-promotion",
              evidenceRefs: [{ artifact: "state", description: "alive" }]
            }),
            metric({
              id: "agent.false_role_claim_belief_temporal_association_rate",
              label: "Belief temporal rate",
              scope: "agent",
              subjectId: "a1",
              value: 0.5,
              weight: 0,
              source: "generic.catalog-promotion",
              evidenceRefs: [{ artifact: "message", seq: 2 }]
            }),
            metric({
              id: "agent.social.memory_count",
              label: "Social memory count",
              scope: "agent",
              subjectId: "a1",
              value: 4,
              weight: 0,
              source: "generic.catalog-promotion",
              evidenceRefs: [{ artifact: "agent_state", description: "memory" }]
            }),
            metric({
              id: "agent.future_temporal_association_probe",
              label: "Future temporal probe",
              scope: "agent",
              subjectId: "a1",
              value: 0.1,
              weight: 0,
              source: "generic.catalog-promotion",
              evidenceRefs: [{ artifact: "trace", traceId: "future-temporal" }]
            })
          ]
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "catalog-promotion-eval",
      createdAt: new Date(0).toISOString(),
      context: genericContext("catalog-promotion-eval"),
      evaluators: [evaluator],
      promotionPolicy: WEREWOLF_METRIC_PROMOTION_POLICY
    });

    expect(resolveRecordedMetricPromotion(report.metrics[0]!)).toMatchObject({
      eligibleForScorecard: true,
      promotionClass: "scorecard",
      reasons: ["catalog_scorecard"],
      catalogDecisionId: `${WEREWOLF_METRIC_PROMOTION_CATALOG_ID}#agent.reward`
    });
    expect(resolveRecordedMetricPromotion(report.metrics[1]!)).toMatchObject({
      eligibleForScorecard: false,
      promotionClass: "diagnostic",
      reasons: ["catalog_diagnostic"],
      catalogDecisionId: `${WEREWOLF_METRIC_PROMOTION_CATALOG_ID}#agent.survival_rate`
    });
    expect(resolveRecordedMetricPromotion(report.metrics[2]!)).toMatchObject({
      eligibleForScorecard: false,
      promotionClass: "diagnostic",
      reasons: ["catalog_diagnostic"],
      catalogDecisionId:
        `${WEREWOLF_METRIC_PROMOTION_CATALOG_ID}#agent.false_role_claim_belief_temporal_association_rate`
    });
    expect(resolveRecordedMetricPromotion(report.metrics[3]!)).toMatchObject({
      eligibleForScorecard: false,
      promotionClass: "diagnostic",
      reasons: ["catalog_diagnostic"],
      catalogDecisionId: `${WEREWOLF_METRIC_PROMOTION_CATALOG_ID}#agent.social.memory_count`
    });
    expect(resolveRecordedMetricPromotion(report.metrics[4]!)).toMatchObject({
      eligibleForScorecard: false,
      promotionClass: "diagnostic",
      reasons: ["catalog_diagnostic"],
      catalogDecisionId: `${WEREWOLF_METRIC_PROMOTION_CATALOG_ID}#includes:temporal_association`
    });
    expect(report.summary.agentScores).toEqual({ a1: 0.8 });
    expect(report.summary.promotion.catalogScorecardMetricIds).toContain("agent.reward");
    expect(report.summary.promotion.catalogRuleCount).toBe(3);
    expect(report.summary.promotion.catalogRuleIds).toEqual([
      "prefix:agent.social.",
      "includes:temporal_association",
      "includes:temporal_evaluable"
    ]);
    expect(report.summary.promotion.catalogDiagnosticMetricIds).toEqual(
      expect.arrayContaining([
        "agent.survival_rate",
        "agent.false_role_claim_belief_temporal_association_rate",
        "agent.social.memory_count"
      ])
    );
  });

  it("normalizes defaults and preserves explicit additive metric fields", () => {
    const evaluator: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.normalizer",
      label: "Generic normalizer",
      version: "0.2.0",
      manifest: {
        inputSchema: "generic.normalizer.input.v1",
        outputSchema: "generic.normalizer.output.v1",
        mode: "model_graded",
        metricIds: ["episode.defaulted", "agent.explicit"],
        rubric: "Synthetic explicit manifest preservation test.",
        dependencies: {
          judgeModel: "judge-model",
          promptVersion: "rubric-2026-07-04"
        },
        aggregation: "explicit_manifest_aggregation",
        visibility: "private"
      },
      evaluate() {
        return {
          evaluatorId: "generic.normalizer",
          label: "Generic normalizer",
          version: "0.2.0",
          metrics: [
            metric({
              id: "episode.defaulted",
              label: "Defaulted metric",
              scope: "episode",
              value: 1,
              source: "generic.normalizer"
            }),
            metric({
              id: "agent.explicit",
              label: "Explicit additive metric",
              scope: "agent",
              subjectId: "a1",
              subject: { playerId: "a1", profileId: "p1", model: "m1" },
              value: 0.5,
              source: "custom.source",
              evaluatorId: "custom.metric-evaluator",
              evaluatorVersion: "9.9.9",
              denominator: 4,
              confidence: 0.75,
              aggregation: "ratio",
              evidenceRefs: [{ artifact: "trace", traceId: "trace-1", description: "synthetic evidence" }],
              scenario: "scenario-a",
              split: "holdout",
              metadata: { reason: "preservation-test" }
            })
          ]
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "normalizer-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "normalizer-eval",
        status: "completed",
        initialState: { ok: false },
        finalState: { ok: true },
        agents: [],
        trajectory: []
      },
      evaluators: [evaluator]
    });

    expect(report.evaluatorRegistry).toEqual([
      {
        id: "generic.normalizer",
        label: "Generic normalizer",
        version: "0.2.0",
        inputSchema: "generic.normalizer.input.v1",
        outputSchema: "generic.normalizer.output.v1",
        mode: "model_graded",
        metricIds: ["episode.defaulted", "agent.explicit"],
        rubric: "Synthetic explicit manifest preservation test.",
        dependencies: {
          judgeModel: "judge-model",
          promptVersion: "rubric-2026-07-04"
        },
        aggregation: "explicit_manifest_aggregation",
        visibility: "private"
      }
    ]);
    expect(report.metrics.find((item) => item.id === "episode.defaulted")).toMatchObject({
      evaluatorId: "generic.normalizer",
      evaluatorVersion: "0.2.0",
      evidenceRefs: []
    });
    expect(report.metrics.find((item) => item.id === "agent.explicit")).toMatchObject({
      evaluatorId: "custom.metric-evaluator",
      evaluatorVersion: "9.9.9",
      subject: { playerId: "a1", profileId: "p1", model: "m1" },
      denominator: 4,
      confidence: 0.75,
      aggregation: "ratio",
      evidenceRefs: [{ artifact: "trace", traceId: "trace-1", description: "synthetic evidence" }],
      scenario: "scenario-a",
      split: "holdout",
      metadata: { reason: "preservation-test" }
    });
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "metric.cross_evaluator_attribution",
          severity: "info",
          evaluatorId: "custom.metric-evaluator",
          evaluatorVersion: "9.9.9",
          metricId: "agent.explicit",
          subjectId: "a1"
        })
      ])
    );
  });

  it("emits additive diagnostics for evaluator identity drift, duplicate outputs, and manifest coverage", () => {
    const driftEvaluator: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.object-id",
      label: "Object identity",
      version: "0.0.1",
      manifest: {
        metricIds: ["episode.declared", "episode.missing"]
      },
      evaluate() {
        return {
          evaluatorId: "generic.result-id",
          label: "Result identity",
          version: "1.0.0",
          metrics: [
            metric({
              id: "episode.declared",
              label: "Declared emitted metric",
              scope: "episode",
              value: 1,
              weight: 1,
              source: "generic.result-id",
              evidenceRefs: [{ artifact: "trace", traceId: "trace-diagnostics" }]
            }),
            metric({
              id: "episode.undeclared",
              label: "Undeclared emitted metric",
              scope: "episode",
              value: 0,
              source: "generic.result-id"
            })
          ],
          output: { ordinal: 1 }
        };
      }
    };
    const duplicateEvaluator: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.duplicate-wrapper",
      label: "Duplicate wrapper",
      version: "0.0.2",
      evaluate() {
        return {
          evaluatorId: "generic.result-id",
          label: "Duplicate result identity",
          version: "1.0.1",
          metrics: [],
          output: { ordinal: 2 }
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "diagnostic-identity-eval",
      createdAt: new Date(0).toISOString(),
      context: genericContext("diagnostic-identity-eval"),
      evaluators: [driftEvaluator, duplicateEvaluator]
    });

    expect(report.outputs["generic.result-id"]).toEqual({ ordinal: 2 });
    const warningCodes = (report.warnings ?? []).map((warning) => warning.code);
    expect(warningCodes).toEqual(
      expect.arrayContaining([
        "evaluator.identity_mismatch",
        "manifest.metric_id_undeclared",
        "manifest.metric_id_declared_not_emitted"
      ])
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manifest.metric_id_undeclared",
          severity: "warning",
          evaluatorId: "generic.result-id",
          metricId: "episode.undeclared"
        }),
        expect.objectContaining({
          code: "manifest.metric_id_declared_not_emitted",
          severity: "info",
          evaluatorId: "generic.result-id",
          metricId: "episode.missing"
        }),
        expect.objectContaining({
          code: "evaluator.identity_mismatch",
          severity: "warning",
          evaluatorId: "generic.result-id"
        })
      ])
    );
  });

  it("warns about weighted metrics without evidence and invalid numeric contracts without corrupting summaries", () => {
    const evaluator: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.metric-contracts",
      label: "Metric contract diagnostics",
      version: "0.3.0",
      evaluate() {
        return {
          evaluatorId: "generic.metric-contracts",
          label: "Metric contract diagnostics",
          version: "0.3.0",
          metrics: [
            metric({
              id: "episode.valid",
              label: "Valid weighted metric",
              scope: "episode",
              value: 0.75,
              weight: 1,
              source: "generic.metric-contracts",
              evidenceRefs: [{ artifact: "trace", traceId: "valid-trace" }]
            }),
            metric({
              id: "agent.weighted_missing_evidence",
              label: "Weighted no evidence",
              scope: "agent",
              subjectId: "a1",
              value: 0.2,
              weight: 1,
              source: "generic.metric-contracts"
            }),
            metric({
              id: "agent.missing_subject",
              label: "Missing subject",
              scope: "agent",
              value: 0.4,
              source: "generic.metric-contracts"
            }),
            metric({
              id: "episode.invalid_nan",
              label: "Invalid NaN",
              scope: "episode",
              value: Number.NaN,
              weight: 1,
              source: "generic.metric-contracts",
              evidenceRefs: [{ artifact: "trace", traceId: "nan-trace" }]
            }),
            metric({
              id: "episode.invalid_weight",
              label: "Invalid negative weight",
              scope: "episode",
              value: 1,
              weight: -1,
              source: "generic.metric-contracts",
              evidenceRefs: [{ artifact: "trace", traceId: "negative-weight-trace" }]
            }),
            metric({
              id: "episode.ratio_contract",
              label: "Bad ratio",
              scope: "episode",
              value: 1.5,
              unit: "ratio",
              denominator: 0,
              confidence: 1.2,
              source: "generic.metric-contracts",
              evidenceRefs: [{ artifact: "metric" }]
            })
          ]
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "metric-contracts-eval",
      createdAt: new Date(0).toISOString(),
      context: genericContext("metric-contracts-eval"),
      evaluators: [evaluator]
    });

    expect(report.summary.episodeScore).toBe(0.75);
    expect(Number.isFinite(report.summary.episodeScore)).toBe(true);
    expect(report.summary.agentScores.a1).toBeUndefined();
    expect(report.metrics.find((item) => item.id === "episode.invalid_nan")?.value).toBeNull();
    expect(report.summary.promotion).toMatchObject({
      policyId: DEFAULT_METRIC_PROMOTION_POLICY.id,
      catalogId: DEFAULT_METRIC_PROMOTION_POLICY.catalog.id,
      catalogEntryCount: 0,
      catalogRuleCount: 0,
      catalogRuleIds: [],
      scorecardMetricCount: 1,
      weightedMetricCount: 3,
      excludedWeightedMetricCount: 2,
      scorecardRequiresEvidence: true,
      scorecardRequiresPositiveWeight: true,
      uncatalogedMetricPolicy: "implicit_positive_weight_with_evidence"
    });
    expect(report.summary.promotion.excludedWeightedMetricIds).toEqual(
      expect.arrayContaining(["agent.weighted_missing_evidence", "episode.invalid_nan"])
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "metric.weighted_without_evidence",
          metricId: "agent.weighted_missing_evidence",
          subjectId: "a1"
        }),
        expect.objectContaining({
          code: "metric.weighted_excluded_from_scorecard",
          metricId: "agent.weighted_missing_evidence",
          metadata: expect.objectContaining({
            reasons: expect.arrayContaining(["missing_evidence_refs"])
          })
        }),
        expect.objectContaining({
          code: "metric.non_episode_missing_subject",
          metricId: "agent.missing_subject"
        }),
        expect.objectContaining({
          code: "metric.invalid_numeric",
          metricId: "episode.invalid_nan",
          metadata: expect.objectContaining({ invalidFields: expect.arrayContaining(["value"]) })
        }),
        expect.objectContaining({
          code: "metric.invalid_numeric",
          metricId: "episode.invalid_weight",
          metadata: expect.objectContaining({ invalidFields: expect.arrayContaining(["weight_negative"]) })
        }),
        expect.objectContaining({
          code: "metric.ratio_contract_warning",
          metricId: "episode.ratio_contract",
          metadata: expect.objectContaining({
            issues: expect.arrayContaining(["zero_denominator_nonzero_value", "value_outside_0_1"])
          })
        }),
        expect.objectContaining({
          code: "metric.evidence_ref_unlocated",
          metricId: "episode.ratio_contract",
          evidenceRefs: [{ artifact: "metric" }]
        })
      ])
    );
  });

  it("warns when evaluator grading mode metadata blurs deterministic and model-graded boundaries", () => {
    const modelGradedMissingMetadata: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.model-graded",
      label: "Model graded",
      version: "0.1.0",
      manifest: {
        mode: "model_graded"
      },
      evaluate() {
        return {
          evaluatorId: "generic.model-graded",
          label: "Model graded",
          version: "0.1.0",
          metrics: []
        };
      }
    };
    const deterministicWithJudgeDependency: HarnessEvaluator<{ ok: boolean }> = {
      id: "generic.deterministic",
      label: "Deterministic with judge dependency",
      version: "0.1.0",
      manifest: {
        mode: "deterministic",
        dependencies: { judgeModel: "judge-model", promptVersion: "rubric-v1" }
      },
      evaluate() {
        return {
          evaluatorId: "generic.deterministic",
          label: "Deterministic with judge dependency",
          version: "0.1.0",
          metrics: []
        };
      }
    };

    const report = runEvaluationRegistry({
      id: "mode-boundary-eval",
      createdAt: new Date(0).toISOString(),
      context: genericContext("mode-boundary-eval"),
      evaluators: [modelGradedMissingMetadata, deterministicWithJudgeDependency]
    });

    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manifest.model_graded_missing_judge_metadata",
          evaluatorId: "generic.model-graded",
          severity: "warning"
        }),
        expect.objectContaining({
          code: "manifest.deterministic_declares_judge_dependency",
          evaluatorId: "generic.deterministic",
          severity: "warning"
        })
      ])
    );
  });

  it("audits social-state mutation journal coverage without changing reward summaries", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    appendSocialMemory(social, {
      kind: "message",
      source: "p2",
      visibility: "public",
      content: "p2 made a role claim",
      evidenceRefs: [{ artifact: "message", id: "msg-journal-1", seq: 1 }],
      tags: ["claim"]
    }, { traceId: "trace-journal-1", turnIndex: 1, phase: "day_speech", day: 1 });
    upsertSocialBelief(social, {
      subject: "p2",
      predicate: "claimedRole",
      value: "seer",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "trace", traceId: "trace-journal-2", seq: 2 }],
      metadata: { observerId: "p1" }
    }, { traceId: "trace-journal-2", turnIndex: 2, phase: "day_speech", day: 1 });
    updateSocialReputation(social, {
      subjectId: "p2",
      deltas: { honesty: 0.2, cooperation: 0.1 },
      evidenceRefs: [{ artifact: "message", id: "msg-journal-2", seq: 2 }]
    }, { traceId: "trace-journal-3", turnIndex: 3, phase: "day_vote", day: 1 });

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-journal",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "social-state-journal-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "social-state-journal-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createSocialStateEvaluator()]
    });

    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: SOCIAL_STATE_EVALUATOR_ID,
      metricIds: SOCIAL_STATE_METRIC_IDS
    });
    expect(report.outputs[SOCIAL_STATE_EVALUATOR_ID]).toMatchObject({
      journalEntries: 3,
      agentsWithJournal: 1
    });
    expect(report.summary.agentScores).toEqual({});

    const journalMetrics = report.metrics.filter((item) => item.id.includes("journal"));
    expect(journalMetrics.map((item) => item.id)).toEqual([
      "agent.social.journal_entry_count",
      "agent.social.evidenced_journal_rate",
      "agent.social.journal_store_coverage_count"
    ]);
    expect(journalMetrics.every((item) => item.evaluatorId === SOCIAL_STATE_EVALUATOR_ID)).toBe(true);
    expect(journalMetrics.every((item) => item.evaluatorVersion === "1.0.0")).toBe(true);
    expect(journalMetrics.every((item) => item.weight === 0)).toBe(true);
    expect(journalMetrics.find((item) => item.id === "agent.social.journal_entry_count")).toMatchObject({
      value: 3,
      denominator: 1000,
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-journal-1", seq: 1 }),
        expect.objectContaining({ artifact: "message", id: "msg-journal-2", seq: 2 }),
        expect.objectContaining({ artifact: "trace", traceId: "trace-journal-2", seq: 2 })
      ]),
      metadata: expect.objectContaining({
        stores: ["beliefs", "memory", "reputation"],
        hiddenTruthUsedCount: 0
      })
    });
    expect(journalMetrics.find((item) => item.id === "agent.social.evidenced_journal_rate")).toMatchObject({
      value: 1,
      denominator: 3,
      confidence: 1
    });
    expect(journalMetrics.find((item) => item.id === "agent.social.journal_store_coverage_count")).toMatchObject({
      value: 3,
      denominator: 13
    });
    expect(JSON.stringify(journalMetrics)).not.toMatch(/causal|rewardDelta|vote_follow|causalInfluence/);
  });

  it("audits evidence-backed commitment and coalition stores without inferring from text", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;

    const commitment = addSocialCommitment(social, {
      id: "commit-p1-p2",
      actorId: "p1",
      audienceIds: ["p2"],
      visibility: "public",
      promisedAction: "vote with p2",
      targetId: "p3",
      deadlinePhase: "day_vote",
      deadlineDay: 2,
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-commit", seq: 1 }],
      metadata: { kind: "typed-commitment" }
    }, { traceId: "trace-commit", turnIndex: 1, phase: "day_speech", day: 2 });
    updateSocialCommitmentStatus(social, {
      id: commitment.id,
      status: "fulfilled",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-commit", seq: 2 }]
    }, { traceId: "trace-commit-outcome", turnIndex: 2, phase: "day_vote", day: 2 });
    const coalition = addSocialCoalition(social, {
      id: "coalition-p1-p2",
      memberIds: ["p2", "p1"],
      visibility: "team",
      sharedGoal: "coordinate pressure on p3",
      targetId: "p3",
      status: "active",
      confidence: 0.7,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition", seq: 3 }],
      metadata: { kind: "typed-coalition" }
    }, { traceId: "trace-coalition", turnIndex: 3, phase: "night", day: 2 });
    recordSocialCoalitionEvidence(social, {
      id: coalition.id,
      kind: "betrayal",
      status: "betrayed",
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal", seq: 4 }]
    }, { traceId: "trace-betrayal", turnIndex: 4, phase: "day_speech", day: 3 });

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-commitment-coalition",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "social-state-commitment-coalition-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "social-state-commitment-coalition-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createSocialStateEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect(report.outputs[SOCIAL_STATE_EVALUATOR_ID]).toMatchObject({
      commitments: 1,
      coalitions: 1,
      journalEntries: 4
    });
    expect(report.metrics.find((item) => item.id === "agent.social.commitment_count")).toMatchObject({
      value: 1,
      weight: 0,
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-commit", seq: 1 }),
        expect.objectContaining({ artifact: "state", id: "outcome-commit", seq: 2 })
      ]),
      metadata: expect.objectContaining({
        commitmentIds: ["commit-p1-p2"],
        statuses: { fulfilled: 1 }
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.fulfilled_commitment_count")).toMatchObject({
      value: 1,
      denominator: 1
    });
    expect(report.metrics.find((item) => item.id === "agent.social.broken_commitment_count")).toMatchObject({
      value: 0,
      denominator: 1
    });
    expect(report.metrics.find((item) => item.id === "agent.social.evidenced_commitment_rate")).toMatchObject({
      value: 1,
      denominator: 1,
      confidence: 1
    });
    expect(report.metrics.find((item) => item.id === "agent.social.coalition_count")).toMatchObject({
      value: 1,
      weight: 0,
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-coalition", seq: 3 }),
        expect.objectContaining({ artifact: "message", id: "msg-betrayal", seq: 4 })
      ]),
      metadata: expect.objectContaining({
        coalitionIds: ["coalition-p1-p2"],
        statuses: { betrayed: 1 }
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.betrayed_coalition_count")).toMatchObject({
      value: 1,
      denominator: 1
    });
    expect(report.metrics.find((item) => item.id === "agent.social.evidenced_coalition_rate")).toMatchObject({
      value: 1,
      denominator: 1,
      confidence: 1
    });
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|deception\s+success|persuasion\s+success|caused by/i
    );
  });

  it("audits evidence-backed gossip and norm sanction stores without assigning reward", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;

    addSocialGossip(social, {
      id: "gossip-p2-p3",
      speakerId: "p2",
      subjectId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      topic: "credibility",
      claim: "p3 contradicted a vote claim",
      sourceId: "p4",
      valence: "negative",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip", seq: 1 }],
      metadata: { kind: "typed-gossip" }
    }, { traceId: "trace-gossip", turnIndex: 1, phase: "day_speech", day: 1 });
    const sanction = addSocialNormSanction(social, {
      id: "sanction-p2-p3",
      normId: "norm-public-evidence",
      actorId: "p2",
      targetId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "warning",
      reason: "p3 accused without evidence",
      requestedRepair: "cite evidence",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-sanction", seq: 2 }],
      metadata: { kind: "typed-norm-sanction" }
    }, { traceId: "trace-sanction", turnIndex: 2, phase: "day_speech", day: 1 });
    updateSocialNormSanctionStatus(social, {
      id: sanction.id,
      status: "applied",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-sanction", seq: 3 }]
    }, { traceId: "trace-sanction-status", turnIndex: 3, phase: "day_vote", day: 1 });
    const repair = addSocialTrustRepair(social, {
      id: "repair-p3-public-evidence",
      actorId: "p3",
      targetId: "p2",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "evidence_provided",
      triggerKind: "norm_sanction",
      triggerId: "sanction-p2-p3",
      relatedNormSanctionId: "sanction-p2-p3",
      requestedById: "p2",
      requestedRepair: "cite evidence",
      offeredRepair: "p3 provided public evidence",
      confidence: 0.75,
      evidenceRefs: [{ artifact: "message", id: "msg-repair", seq: 4 }],
      metadata: { kind: "typed-trust-repair" }
    }, { traceId: "trace-repair", turnIndex: 4, phase: "day_speech", day: 1 });
    updateSocialTrustRepairStatus(social, {
      id: repair.id,
      status: "accepted",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-repair", seq: 5 }]
    }, { traceId: "trace-repair-status", turnIndex: 5, phase: "day_vote", day: 1 });

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-gossip-sanction",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "social-state-gossip-sanction-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "social-state-gossip-sanction-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createSocialStateEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect(report.outputs[SOCIAL_STATE_EVALUATOR_ID]).toMatchObject({
      gossip: 1,
      normSanctions: 1,
      trustRepairs: 1,
      journalEntries: 5
    });
    expect(report.metrics.find((item) => item.id === "agent.social.gossip_count")).toMatchObject({
      value: 1,
      weight: 0,
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "message", id: "msg-gossip", seq: 1 })]),
      metadata: expect.objectContaining({
        gossipIds: ["gossip-p2-p3"],
        subjectIds: ["p3"],
        valences: { negative: 1 }
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.evidenced_gossip_rate")).toMatchObject({
      value: 1,
      denominator: 1,
      confidence: 1
    });
    expect(report.metrics.find((item) => item.id === "agent.social.norm_sanction_count")).toMatchObject({
      value: 1,
      weight: 0,
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-sanction", seq: 2 }),
        expect.objectContaining({ artifact: "state", id: "outcome-sanction", seq: 3 })
      ]),
      metadata: expect.objectContaining({
        normSanctionIds: ["sanction-p2-p3"],
        normIds: ["norm-public-evidence"],
        statuses: { applied: 1 },
        kinds: { warning: 1 }
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.applied_norm_sanction_count")).toMatchObject({
      value: 1,
      denominator: 1
    });
    expect(report.metrics.find((item) => item.id === "agent.social.evidenced_norm_sanction_rate")).toMatchObject({
      value: 1,
      denominator: 1,
      confidence: 1
    });
    expect(report.metrics.find((item) => item.id === "agent.social.trust_repair_count")).toMatchObject({
      value: 1,
      weight: 0,
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-repair", seq: 4 }),
        expect.objectContaining({ artifact: "state", id: "outcome-repair", seq: 5 })
      ]),
      metadata: expect.objectContaining({
        trustRepairIds: ["repair-p3-public-evidence"],
        targetIds: ["p2"],
        statuses: { accepted: 1 },
        kinds: { evidence_provided: 1 }
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.accepted_trust_repair_count")).toMatchObject({
      value: 1,
      denominator: 1
    });
    expect(report.metrics.find((item) => item.id === "agent.social.evidenced_trust_repair_rate")).toMatchObject({
      value: 1,
      denominator: 1,
      confidence: 1
    });
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|deception\s+success|persuasion\s+success|sanctionEffect|trustRepairSuccess|repairSuccess|caused by/i
    );
  });

  it("audits evidence-backed betrayal stores without assigning reward or truth claims", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;

    const betrayal = addSocialBetrayal(social, {
      id: "betrayal-p2-p1",
      actorId: "p2",
      targetId: "p1",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "commitment_broken",
      triggerKind: "commitment",
      triggerId: "commit-p2-p1",
      relatedCommitmentId: "commit-p2-p1",
      claim: "p2 broke the vote agreement",
      impact: "p1 was exposed",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal", seq: 1 }],
      metadata: { kind: "typed-betrayal" }
    }, { traceId: "trace-betrayal", turnIndex: 1, phase: "day_speech", day: 1 });
    recordSocialBetrayalEvidence(social, {
      id: betrayal.id,
      kind: "corroboration",
      status: "confirmed",
      evidenceRefs: [{ artifact: "event", id: "event-betrayal", seq: 2 }],
      metadata: { kind: "typed-betrayal-evidence" }
    }, { traceId: "trace-betrayal-evidence", turnIndex: 2, phase: "day_vote", day: 1 });

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-betrayal",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "social-state-betrayal-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "social-state-betrayal-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createSocialStateEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect(report.outputs[SOCIAL_STATE_EVALUATOR_ID]).toMatchObject({
      betrayals: 1,
      journalEntries: 2,
      agentsWithJournal: 1
    });
    expect(report.metrics.find((item) => item.id === "agent.social.betrayal_count")).toMatchObject({
      value: 1,
      weight: 0,
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-betrayal", seq: 1 }),
        expect.objectContaining({ artifact: "event", id: "event-betrayal", seq: 2 })
      ]),
      metadata: expect.objectContaining({
        betrayalIds: ["betrayal-p2-p1"],
        targetIds: ["p1"],
        statuses: { confirmed: 1 },
        kinds: { commitment_broken: 1 },
        socialStateHash: "hash-betrayal"
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.confirmed_betrayal_count")).toMatchObject({
      value: 1,
      denominator: 1,
      weight: 0,
      metadata: expect.objectContaining({
        betrayalCount: 1,
        statusSource: "AgentSocialState.betrayals.records.status",
        postgameTruthUsed: false,
        causalClaim: false,
        socialStateHash: "hash-betrayal"
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.evidenced_betrayal_rate")).toMatchObject({
      value: 1,
      denominator: 1,
      confidence: 1,
      weight: 0,
      metadata: expect.objectContaining({
        evidenceBackedBetrayals: 1,
        betrayalCount: 1,
        socialStateHash: "hash-betrayal"
      })
    });
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|deception\s+success|persuasion\s+success|betrayalSuccess|successful betrayal|betrayalImpact|betrayal\s+impact|truthConfirmed|groundTruth|actualBetrayal|relationshipDamage|reputationDamage|trustLoss|caused by/i
    );
  });

  it("audits explicit commitment-coalition associations without inferring causality or text similarity", () => {
    const p1Social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    addSocialCommitment(p1Social, {
      id: "commit-shared",
      actorId: "p1",
      audienceIds: ["p2"],
      visibility: "public",
      promisedAction: "vote with p2",
      targetId: "p3",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-shared", seq: 1 }],
      metadata: { kind: "typed-commitment" }
    }, { traceId: "trace-shared", turnIndex: 1, phase: "day_speech", day: 1 });
    addSocialCoalition(p1Social, {
      id: "coalition-shared",
      memberIds: ["p1", "p2"],
      visibility: "public",
      sharedGoal: "vote with p2",
      targetId: "p3",
      confidence: 0.7,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-shared", seq: 1 }],
      metadata: { kind: "typed-coalition" }
    }, { traceId: "trace-shared", turnIndex: 1, phase: "day_speech", day: 1 });
    addSocialCommitment(p1Social, {
      id: "commit-metadata-link",
      actorId: "p1",
      audienceIds: ["p4"],
      visibility: "team",
      stance: "coordinate with p4",
      targetId: "p5",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-commit-link", seq: 2 }],
      metadata: { coalitionId: "coalition-metadata-link" }
    }, { traceId: "trace-commit-link", turnIndex: 2, phase: "night", day: 1 });
    addSocialCoalition(p1Social, {
      id: "coalition-metadata-link",
      memberIds: ["p1", "p4"],
      visibility: "team",
      targetId: "p5",
      confidence: 0.6,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-link", seq: 3 }],
      metadata: { commitmentIds: ["commit-metadata-link"] }
    }, { traceId: "trace-coalition-link", turnIndex: 3, phase: "night", day: 1 });

    const p2Social = createAgentSocialState({
      agentId: "p2",
      profile: { id: "profile-p2", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    addSocialCommitment(p2Social, {
      id: "commit-text-only",
      actorId: "p2",
      audienceIds: ["p3"],
      visibility: "public",
      promisedAction: "pressure p5",
      targetId: "p5",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-commit-text", seq: 4 }]
    }, { traceId: "trace-commit-text", turnIndex: 4, phase: "day_speech", day: 2 });
    addSocialCoalition(p2Social, {
      id: "coalition-text-only",
      memberIds: ["p2", "p3"],
      visibility: "public",
      sharedGoal: "pressure p5",
      targetId: "p5",
      confidence: 0.7,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-text", seq: 5 }]
    }, { traceId: "trace-coalition-text", turnIndex: 5, phase: "day_speech", day: 2 });

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-p1-association",
        social: p1Social
      },
      {
        playerId: "p2",
        profileId: "profile-p2",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-p2-no-association",
        social: p2Social
      }
    ];
    const report = runEvaluationRegistry({
      id: "commitment-coalition-association-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "commitment-coalition-association-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createCommitmentCoalitionAssociationEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
      label: "Commitment-coalition association evaluator",
      version: "1.0.0",
      inputSchema: "harness.commitment-coalition-association.evaluation-context.v1",
      outputSchema: "harness.commitment-coalition-association.summary.v1",
      mode: "deterministic",
      metricIds: COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS,
      aggregation: "zero_weight_commitment_coalition_association_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("zero-weight association baseline");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("does not assert causality");
    expect(report.outputs[COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: 2,
      agentsWithSocialState: 2,
      commitments: 3,
      coalitions: 3,
      totalPairs: 5,
      evaluablePairs: 5,
      associatedPairs: 2
    });

    const p1AssociationCount = report.metrics.find(
      (item) => item.id === "agent.social.commitment_coalition_association_count" && item.subjectId === "p1"
    );
    expect(p1AssociationCount).toMatchObject({
      value: 2,
      denominator: 4,
      weight: 0,
      source: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
      evaluatorId: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-shared", seq: 1 }),
        expect.objectContaining({ artifact: "message", id: "msg-commit-link", seq: 2 }),
        expect.objectContaining({ artifact: "message", id: "msg-coalition-link", seq: 3 })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "explicit_evidence_or_metadata_association",
        causalClaim: false,
        totalPairs: 4,
        evaluablePairs: 4,
        associatedPairs: 2,
        socialStateHash: "hash-p1-association"
      })
    });
    expect(p1AssociationCount?.metadata?.samplePairs).toEqual(
      expect.arrayContaining([
        { commitmentId: "commit-shared", coalitionId: "coalition-shared", associationKinds: ["shared-evidence"] },
        { commitmentId: "commit-metadata-link", coalitionId: "coalition-metadata-link", associationKinds: ["metadata-link"] }
      ])
    );
    expect(report.metrics.find((item) => item.id === "agent.social.commitment_coalition_association_rate" && item.subjectId === "p1")).toMatchObject({
      value: 0.5,
      denominator: 4,
      confidence: 1
    });
    expect(report.metrics.find((item) => item.id === "agent.social.commitment_coalition_evaluable_pair_rate" && item.subjectId === "p1")).toMatchObject({
      value: 1,
      denominator: 4,
      confidence: 1
    });

    expect(report.metrics.find((item) => item.id === "agent.social.commitment_coalition_association_count" && item.subjectId === "p2")).toMatchObject({
      value: 0,
      denominator: 1,
      evidenceRefs: [{ artifact: "agent_state", id: "p2", description: "socialStateHash:hash-p2-no-association" }],
      metadata: expect.objectContaining({
        associationLevel: "explicit_evidence_or_metadata_association",
        causalClaim: false,
        totalPairs: 1,
        evaluablePairs: 1,
        associatedPairs: 0,
        samplePairs: []
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.commitment_coalition_association_rate" && item.subjectId === "p2")).toMatchObject({
      value: 0,
      denominator: 1,
      confidence: 1
    });
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs, registry: report.evaluatorRegistry })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|deception\s+success|persuasion\s+success|caused by/i
    );
  });

  it("audits commitment and coalition lifecycle temporal associations from ordered journals", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;

    addSocialCommitment(social, {
      id: "commit-ordered",
      actorId: "p1",
      audienceIds: ["p2"],
      visibility: "public",
      promisedAction: "vote with p2",
      targetId: "p3",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-commit-ordered", seq: 1 }]
    }, { traceId: "trace-commit-ordered", turnIndex: 1, phase: "day_speech", day: 1 });
    updateSocialCommitmentStatus(social, {
      id: "commit-ordered",
      status: "fulfilled",
      evidenceRefs: [{ artifact: "event", id: "event-commit-ordered", seq: 2 }]
    }, { traceId: "trace-commit-ordered-status", turnIndex: 3, phase: "day_vote", day: 1 });
    addSocialCommitment(social, {
      id: "commit-same-turn",
      actorId: "p1",
      audienceIds: ["p4"],
      visibility: "public",
      stance: "pressure p5",
      targetId: "p5",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-commit-same-turn", seq: 3 }]
    }, { traceId: "trace-commit-same-turn", turnIndex: 4, phase: "day_speech", day: 1 });
    updateSocialCommitmentStatus(social, {
      id: "commit-same-turn",
      status: "broken",
      evidenceRefs: [{ artifact: "event", id: "event-commit-same-turn", seq: 4 }]
    }, { traceId: "trace-commit-same-turn-status", turnIndex: 4, phase: "day_vote", day: 1 });
    addSocialCommitment(social, {
      id: "commit-missing-creation",
      actorId: "p1",
      audienceIds: ["p6"],
      visibility: "public",
      stance: "defend p6",
      targetId: "p6",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-commit-missing-creation", seq: 5 }]
    }, { traceId: "trace-commit-missing-creation", turnIndex: 5, phase: "day_speech", day: 1 });
    addSocialCommitment(social, {
      id: "commit-ambiguous",
      actorId: "p1",
      audienceIds: ["p7"],
      visibility: "public",
      promisedAction: "protect p7",
      targetId: "p7",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-commit-ambiguous", seq: 6 }]
    }, { traceId: "trace-commit-ambiguous", turnIndex: 6, phase: "day_speech", day: 1 });
    updateSocialCommitmentStatus(social, {
      id: "commit-ambiguous",
      status: "fulfilled",
      evidenceRefs: [{ artifact: "event", id: "event-commit-ambiguous", seq: 7 }]
    }, { traceId: "trace-commit-ambiguous-status", turnIndex: 7, phase: "day_vote", day: 1 });

    addSocialCoalition(social, {
      id: "coalition-ordered",
      memberIds: ["p1", "p2"],
      visibility: "team",
      sharedGoal: "coordinate pressure on p3",
      targetId: "p3",
      confidence: 0.8,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-ordered", seq: 8 }]
    }, { traceId: "trace-coalition-ordered", turnIndex: 2, phase: "night", day: 1 });
    recordSocialCoalitionEvidence(social, {
      id: "coalition-ordered",
      kind: "coordination",
      status: "active",
      evidenceRefs: [{ artifact: "message", id: "msg-coalition-ordered-coordinate", seq: 9 }]
    }, { traceId: "trace-coalition-ordered-coordinate", turnIndex: 4, phase: "night", day: 1 });
    addSocialCoalition(social, {
      id: "coalition-formation-only",
      memberIds: ["p1", "p4"],
      visibility: "public",
      sharedGoal: "formation evidence should not become lifecycle evidence",
      targetId: "p5",
      confidence: 0.7,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-formation-only", seq: 10 }]
    }, { traceId: "trace-coalition-formation-only", turnIndex: 8, phase: "day_speech", day: 1 });
    recordSocialCoalitionEvidence(social, {
      id: "coalition-formation-only",
      kind: "formation",
      evidenceRefs: [{ artifact: "message", id: "msg-coalition-formation-later", seq: 11 }]
    }, { traceId: "trace-coalition-formation-later", turnIndex: 9, phase: "day_speech", day: 1 });
    addSocialCoalition(social, {
      id: "coalition-same-turn",
      memberIds: ["p1", "p5"],
      visibility: "team",
      targetId: "p6",
      confidence: 0.7,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-same-turn", seq: 12 }]
    }, { traceId: "trace-coalition-same-turn", turnIndex: 10, phase: "night", day: 1 });
    recordSocialCoalitionEvidence(social, {
      id: "coalition-same-turn",
      kind: "betrayal",
      status: "betrayed",
      evidenceRefs: [{ artifact: "message", id: "msg-coalition-same-turn-betrayal", seq: 13 }]
    }, { traceId: "trace-coalition-same-turn-betrayal", turnIndex: 10, phase: "night", day: 1 });
    addSocialCoalition(social, {
      id: "coalition-missing-creation",
      memberIds: ["p1", "p6"],
      visibility: "team",
      targetId: "p7",
      confidence: 0.6,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-missing-creation", seq: 14 }]
    }, { traceId: "trace-coalition-missing-creation", turnIndex: 11, phase: "night", day: 1 });
    addSocialCoalition(social, {
      id: "coalition-ambiguous",
      memberIds: ["p1", "p7"],
      visibility: "team",
      targetId: "p8",
      confidence: 0.6,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-ambiguous", seq: 15 }]
    }, { traceId: "trace-coalition-ambiguous", turnIndex: 12, phase: "night", day: 1 });
    recordSocialCoalitionEvidence(social, {
      id: "coalition-ambiguous",
      kind: "dissolution",
      status: "dissolved",
      evidenceRefs: [{ artifact: "message", id: "msg-coalition-ambiguous-dissolution", seq: 16 }]
    }, { traceId: "trace-coalition-ambiguous-dissolution", turnIndex: 13, phase: "day_speech", day: 2 });

    const ambiguousCommitmentEntry = social.journal?.entries.find(
      (entry) => entry.mutationKind === "commitment.status.updated" && entry.subjectId === "commit-ambiguous"
    );
    const ambiguousCoalitionEntry = social.journal?.entries.find(
      (entry) => entry.mutationKind === "coalition.evidence.recorded" && entry.subjectId === "coalition-ambiguous"
    );
    expect(ambiguousCommitmentEntry).toBeDefined();
    expect(ambiguousCoalitionEntry).toBeDefined();
    delete ambiguousCommitmentEntry!.turnIndex;
    delete ambiguousCoalitionEntry!.turnIndex;
    social.journal!.entries = social.journal!.entries.filter(
      (entry) =>
        !(
          (entry.mutationKind === "commitment.added" && entry.subjectId === "commit-missing-creation") ||
          (entry.mutationKind === "coalition.added" && entry.subjectId === "coalition-missing-creation")
        )
    );

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-lifecycle",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "commitment-coalition-lifecycle-temporal-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "commitment-coalition-lifecycle-temporal-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createCommitmentCoalitionLifecycleTemporalAssociationEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect([...new Set(report.metrics.map((item) => item.id))].sort()).toEqual(
      [...COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS].sort()
    );
    expect(report.metrics.every((item) => item.evaluatorId === COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.evaluatorVersion === "1.0.0")).toBe(true);
    expect(report.metrics.every((item) => item.weight === 0)).toBe(true);
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      label: "Commitment-coalition lifecycle temporal association evaluator",
      version: "1.0.0",
      inputSchema: "harness.commitment-coalition-lifecycle-temporal-association.evaluation-context.v1",
      outputSchema: "harness.commitment-coalition-lifecycle-temporal-association.summary.v1",
      mode: "deterministic",
      metricIds: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
      dependencies: {
        mutationJournal: "AgentSocialState.journal.entries with subjectId, mutationKind, turnIndex, deltaSummary, evidenceRefs, and hiddenTruthUsed=false",
        socialState: "AgentSocialState.commitments and AgentSocialState.coalitions for record denominators"
      },
      aggregation: "zero_weight_commitment_coalition_lifecycle_temporal_association_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("strict");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("does not assert causality");
    expect(report.outputs[COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: 1,
      agentsWithSocialState: 1,
      agentsWithJournal: 1,
      commitments: 4,
      commitmentEvaluableRecords: 2,
      commitmentAssociatedRecords: 1,
      commitmentMissingCreationRecords: 1,
      commitmentAmbiguousOrderingRecords: 1,
      commitmentNoLaterStatusUpdateRecords: 1,
      coalitions: 5,
      coalitionEvaluableRecords: 3,
      coalitionAssociatedRecords: 1,
      coalitionMissingCreationRecords: 1,
      coalitionAmbiguousOrderingRecords: 1,
      coalitionNoLaterLifecycleEvidenceRecords: 2
    });

    const commitmentCount = report.metrics.find((item) => item.id === "agent.social.commitment_status_temporal_association_count");
    expect(commitmentCount).toMatchObject({
      value: 1,
      denominator: 2,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-commit-ordered", seq: 1 }),
        expect.objectContaining({ artifact: "event", id: "event-commit-ordered", seq: 2 }),
        expect.objectContaining({ artifact: "agent_state", id: "p1", description: "socialStateHash:hash-lifecycle" })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "commitment_status_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation",
        hiddenTruthUsedInLiveStore: false,
        postgameTruthUsed: false,
        recordCount: 4,
        evaluableRecords: 2,
        associatedRecords: 1,
        missingCreationRecords: 1,
        ambiguousOrderingRecords: 1,
        noLaterStatusUpdateRecords: 1,
        socialStateHash: "hash-lifecycle"
      })
    });
    expect(commitmentCount?.metadata?.sampleAssociatedRecords).toEqual([
      {
        recordId: "commit-ordered",
        creationTurnIndex: 1,
        lifecycleTurnIndexes: [3],
        lifecycleKinds: ["fulfilled"]
      }
    ]);
    expect(report.metrics.find((item) => item.id === "agent.social.commitment_status_temporal_association_rate")).toMatchObject({
      value: 0.5,
      denominator: 2,
      confidence: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.social.commitment_status_temporal_evaluable_record_rate")).toMatchObject({
      value: 0.5,
      denominator: 4,
      confidence: 1,
      aggregation: "coverage_ratio"
    });

    const coalitionCount = report.metrics.find((item) => item.id === "agent.social.coalition_lifecycle_temporal_association_count");
    expect(coalitionCount).toMatchObject({
      value: 1,
      denominator: 3,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-coalition-ordered", seq: 8 }),
        expect.objectContaining({ artifact: "message", id: "msg-coalition-ordered-coordinate", seq: 9 }),
        expect.objectContaining({ artifact: "agent_state", id: "p1", description: "socialStateHash:hash-lifecycle" })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "coalition_lifecycle_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation",
        recordCount: 5,
        evaluableRecords: 3,
        associatedRecords: 1,
        missingCreationRecords: 1,
        ambiguousOrderingRecords: 1,
        noLaterLifecycleEvidenceRecords: 2,
        lifecycleEvidenceKinds: ["coordination", "betrayal", "dissolution"]
      })
    });
    expect(coalitionCount?.metadata?.sampleAssociatedRecords).toEqual([
      {
        recordId: "coalition-ordered",
        creationTurnIndex: 2,
        lifecycleTurnIndexes: [4],
        lifecycleKinds: ["coordination"]
      }
    ]);
    expect(report.metrics.find((item) => item.id === "agent.social.coalition_lifecycle_temporal_association_rate")).toMatchObject({
      value: 0.333,
      denominator: 3,
      confidence: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.social.coalition_lifecycle_temporal_evaluable_record_rate")).toMatchObject({
      value: 0.6,
      denominator: 5,
      confidence: 1,
      aggregation: "coverage_ratio"
    });
    expect(report.metrics.some((item) => item.evidenceRefs?.some((ref) => ref.artifact === "message" && ref.id === "msg-coalition-formation-later"))).toBe(false);
    const registryWithoutRubric = report.evaluatorRegistry?.map(({ rubric, ...entry }) => entry);
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs, registry: registryWithoutRubric })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|deception\s+success|persuasion\s+success|caused by/i
    );
  });

  it("audits norm and norm-sanction lifecycle temporal associations from ordered journals", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;

    addSocialNorm(social, {
      id: "norm-ordered",
      kind: "obligation",
      scope: "public-table",
      expectedBehavior: "cite evidence before accusations",
      sanction: "warning",
      source: "table",
      confidence: 0.8,
      status: "active",
      evidenceRefs: [{ artifact: "message", id: "msg-norm-ordered", seq: 1 }]
    }, { traceId: "trace-norm-ordered", turnIndex: 1, phase: "day_speech", day: 1 });
    updateSocialNormStatus(social, {
      id: "norm-ordered",
      status: "violated",
      evidenceRefs: [{ artifact: "event", id: "event-norm-ordered", seq: 2 }]
    }, { traceId: "trace-norm-ordered-status", turnIndex: 3, phase: "day_vote", day: 1 });
    addSocialNorm(social, {
      id: "norm-same-turn",
      kind: "prohibition",
      scope: "public-table",
      expectedBehavior: "do not claim hidden truth without evidence",
      source: "table",
      confidence: 0.7,
      status: "active",
      evidenceRefs: [{ artifact: "message", id: "msg-norm-same-turn", seq: 3 }]
    }, { traceId: "trace-norm-same-turn", turnIndex: 4, phase: "day_speech", day: 1 });
    updateSocialNormStatus(social, {
      id: "norm-same-turn",
      status: "fulfilled",
      evidenceRefs: [{ artifact: "event", id: "event-norm-same-turn", seq: 4 }]
    }, { traceId: "trace-norm-same-turn-status", turnIndex: 4, phase: "day_vote", day: 1 });
    addSocialNorm(social, {
      id: "norm-missing-creation",
      kind: "convention",
      scope: "public-table",
      expectedBehavior: "answer direct evidence requests",
      source: "table",
      confidence: 0.6,
      status: "active",
      evidenceRefs: [{ artifact: "message", id: "msg-norm-missing-creation", seq: 5 }]
    }, { traceId: "trace-norm-missing-creation", turnIndex: 5, phase: "day_speech", day: 1 });
    addSocialNorm(social, {
      id: "norm-ambiguous",
      kind: "obligation",
      scope: "public-table",
      expectedBehavior: "repair unsupported accusation",
      source: "table",
      confidence: 0.6,
      status: "active",
      evidenceRefs: [{ artifact: "message", id: "msg-norm-ambiguous", seq: 6 }]
    }, { traceId: "trace-norm-ambiguous", turnIndex: 6, phase: "day_speech", day: 1 });
    updateSocialNormStatus(social, {
      id: "norm-ambiguous",
      status: "expired",
      evidenceRefs: [{ artifact: "event", id: "event-norm-ambiguous", seq: 7 }]
    }, { traceId: "trace-norm-ambiguous-status", turnIndex: 7, phase: "day_vote", day: 1 });

    addSocialNormSanction(social, {
      id: "sanction-ordered",
      normId: "norm-ordered",
      actorId: "p2",
      targetId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "warning",
      reason: "p3 accused without evidence",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-sanction-ordered", seq: 8 }]
    }, { traceId: "trace-sanction-ordered", turnIndex: 2, phase: "day_speech", day: 1 });
    updateSocialNormSanctionStatus(social, {
      id: "sanction-ordered",
      status: "applied",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-sanction-ordered", seq: 9 }]
    }, { traceId: "trace-sanction-ordered-status", turnIndex: 4, phase: "day_vote", day: 1 });
    addSocialNormSanction(social, {
      id: "sanction-same-turn",
      normId: "norm-same-turn",
      actorId: "p4",
      targetId: "p5",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "pressure",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-sanction-same-turn", seq: 10 }]
    }, { traceId: "trace-sanction-same-turn", turnIndex: 5, phase: "day_speech", day: 1 });
    updateSocialNormSanctionStatus(social, {
      id: "sanction-same-turn",
      status: "withdrawn",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-sanction-same-turn", seq: 11 }]
    }, { traceId: "trace-sanction-same-turn-status", turnIndex: 5, phase: "day_vote", day: 1 });
    addSocialNormSanction(social, {
      id: "sanction-missing-creation",
      normId: "norm-missing-creation",
      actorId: "p6",
      targetId: "p7",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "repair_request",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-sanction-missing-creation", seq: 12 }]
    }, { traceId: "trace-sanction-missing-creation", turnIndex: 6, phase: "day_speech", day: 1 });
    addSocialNormSanction(social, {
      id: "sanction-ambiguous",
      normId: "norm-ambiguous",
      actorId: "p8",
      targetId: "p9",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "reputation",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-sanction-ambiguous", seq: 13 }]
    }, { traceId: "trace-sanction-ambiguous", turnIndex: 7, phase: "day_speech", day: 1 });
    updateSocialNormSanctionStatus(social, {
      id: "sanction-ambiguous",
      status: "applied",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-sanction-ambiguous", seq: 14 }]
    }, { traceId: "trace-sanction-ambiguous-status", turnIndex: 8, phase: "day_vote", day: 1 });

    const ambiguousNormEntry = social.journal?.entries.find(
      (entry) => entry.mutationKind === "norm.status.updated" && entry.subjectId === "norm-ambiguous"
    );
    const ambiguousSanctionEntry = social.journal?.entries.find(
      (entry) => entry.mutationKind === "norm_sanction.status.updated" && entry.subjectId === "sanction-ambiguous"
    );
    expect(ambiguousNormEntry).toBeDefined();
    expect(ambiguousSanctionEntry).toBeDefined();
    delete ambiguousNormEntry!.turnIndex;
    delete ambiguousSanctionEntry!.turnIndex;
    social.journal!.entries = social.journal!.entries.filter(
      (entry) =>
        !(
          (entry.mutationKind === "norm.added" && entry.subjectId === "norm-missing-creation") ||
          (entry.mutationKind === "norm_sanction.added" && entry.subjectId === "sanction-missing-creation")
        )
    );

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-norm-sanction-lifecycle",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "norm-sanction-lifecycle-temporal-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "norm-sanction-lifecycle-temporal-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createNormSanctionLifecycleTemporalAssociationEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect([...new Set(report.metrics.map((item) => item.id))].sort()).toEqual(
      [...NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS].sort()
    );
    expect(report.metrics.every((item) => item.evaluatorId === NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.evaluatorVersion === "1.0.0")).toBe(true);
    expect(report.metrics.every((item) => item.weight === 0)).toBe(true);
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      label: "Norm-sanction lifecycle temporal association evaluator",
      version: "1.0.0",
      inputSchema: "harness.norm-sanction-lifecycle-temporal-association.evaluation-context.v1",
      outputSchema: "harness.norm-sanction-lifecycle-temporal-association.summary.v1",
      mode: "deterministic",
      metricIds: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
      dependencies: {
        mutationJournal: "AgentSocialState.journal.entries with subjectId, mutationKind, turnIndex, deltaSummary, evidenceRefs, and hiddenTruthUsed=false",
        socialState: "AgentSocialState.norms and AgentSocialState.normSanctions for record denominators"
      },
      aggregation: "zero_weight_norm_sanction_lifecycle_temporal_association_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("strict");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("does not assert causality");
    expect(report.outputs[NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: 1,
      agentsWithSocialState: 1,
      agentsWithJournal: 1,
      norms: 4,
      normEvaluableRecords: 2,
      normAssociatedRecords: 1,
      normMissingCreationRecords: 1,
      normAmbiguousOrderingRecords: 1,
      normNoLaterStatusUpdateRecords: 1,
      normSanctions: 4,
      normSanctionEvaluableRecords: 2,
      normSanctionAssociatedRecords: 1,
      normSanctionMissingCreationRecords: 1,
      normSanctionAmbiguousOrderingRecords: 1,
      normSanctionNoLaterStatusUpdateRecords: 1
    });

    const normCount = report.metrics.find((item) => item.id === "agent.social.norm_status_temporal_association_count");
    expect(normCount).toMatchObject({
      value: 1,
      denominator: 2,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-norm-ordered", seq: 1 }),
        expect.objectContaining({ artifact: "event", id: "event-norm-ordered", seq: 2 }),
        expect.objectContaining({ artifact: "agent_state", id: "p1", description: "socialStateHash:hash-norm-sanction-lifecycle" })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "norm_status_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation",
        hiddenTruthUsedInLiveStore: false,
        postgameTruthUsed: false,
        recordCount: 4,
        evaluableRecords: 2,
        associatedRecords: 1,
        missingCreationRecords: 1,
        ambiguousOrderingRecords: 1,
        noLaterStatusUpdateRecords: 1,
        socialStateHash: "hash-norm-sanction-lifecycle"
      })
    });
    expect(normCount?.metadata?.sampleAssociatedRecords).toEqual([
      {
        recordId: "norm-ordered",
        creationTurnIndex: 1,
        lifecycleTurnIndexes: [3],
        lifecycleKinds: ["violated"]
      }
    ]);
    const normEvidenceRefs = normCount?.evidenceRefs ?? [];
    expect(normEvidenceRefs.some((ref) => ref.id === "msg-norm-same-turn" || ref.id === "event-norm-same-turn")).toBe(false);
    expect(report.metrics.find((item) => item.id === "agent.social.norm_status_temporal_association_rate")).toMatchObject({
      value: 0.5,
      denominator: 2,
      confidence: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.social.norm_status_temporal_evaluable_record_rate")).toMatchObject({
      value: 0.5,
      denominator: 4,
      confidence: 1,
      aggregation: "coverage_ratio"
    });

    const sanctionCount = report.metrics.find((item) => item.id === "agent.social.norm_sanction_status_temporal_association_count");
    expect(sanctionCount).toMatchObject({
      value: 1,
      denominator: 2,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-sanction-ordered", seq: 8 }),
        expect.objectContaining({ artifact: "state", id: "outcome-sanction-ordered", seq: 9 }),
        expect.objectContaining({ artifact: "agent_state", id: "p1", description: "socialStateHash:hash-norm-sanction-lifecycle" })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "norm_sanction_status_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation",
        hiddenTruthUsedInLiveStore: false,
        postgameTruthUsed: false,
        recordCount: 4,
        evaluableRecords: 2,
        associatedRecords: 1,
        missingCreationRecords: 1,
        ambiguousOrderingRecords: 1,
        noLaterStatusUpdateRecords: 1,
        socialStateHash: "hash-norm-sanction-lifecycle"
      })
    });
    expect(sanctionCount?.metadata?.sampleAssociatedRecords).toEqual([
      {
        recordId: "sanction-ordered",
        creationTurnIndex: 2,
        lifecycleTurnIndexes: [4],
        lifecycleKinds: ["applied"]
      }
    ]);
    const sanctionEvidenceRefs = sanctionCount?.evidenceRefs ?? [];
    expect(sanctionEvidenceRefs.some((ref) => ref.id === "msg-sanction-same-turn" || ref.id === "outcome-sanction-same-turn")).toBe(false);
    expect(report.metrics.find((item) => item.id === "agent.social.norm_sanction_status_temporal_association_rate")).toMatchObject({
      value: 0.5,
      denominator: 2,
      confidence: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.social.norm_sanction_status_temporal_evaluable_record_rate")).toMatchObject({
      value: 0.5,
      denominator: 4,
      confidence: 1,
      aggregation: "coverage_ratio"
    });
    const registryWithoutRubric = report.evaluatorRegistry?.map(({ rubric, ...entry }) => entry);
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs, registry: registryWithoutRubric })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|deception\s+success|persuasion\s+success|sanctionEffect|caused by/i
    );
  });

  it("audits trust-repair lifecycle temporal associations from ordered journals", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;

    addSocialTrustRepair(social, {
      id: "repair-ordered",
      actorId: "p2",
      targetId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "evidence_provided",
      triggerKind: "norm_sanction",
      triggerId: "sanction-ordered",
      requestedRepair: "state public evidence",
      offeredRepair: "p2 provided the evidence",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-repair-ordered", seq: 1 }]
    }, { traceId: "trace-repair-ordered", turnIndex: 1, phase: "day_speech", day: 1 });
    updateSocialTrustRepairStatus(social, {
      id: "repair-ordered",
      status: "accepted",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-repair-ordered", seq: 2 }]
    }, { traceId: "trace-repair-ordered-status", turnIndex: 3, phase: "day_vote", day: 1 });
    addSocialTrustRepair(social, {
      id: "repair-same-turn",
      actorId: "p4",
      targetId: "p5",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "apology",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-repair-same-turn", seq: 3 }]
    }, { traceId: "trace-repair-same-turn", turnIndex: 4, phase: "day_speech", day: 1 });
    updateSocialTrustRepairStatus(social, {
      id: "repair-same-turn",
      status: "accepted",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-repair-same-turn", seq: 4 }]
    }, { traceId: "trace-repair-same-turn-status", turnIndex: 4, phase: "day_vote", day: 1 });
    addSocialTrustRepair(social, {
      id: "repair-missing-creation",
      actorId: "p6",
      targetId: "p7",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "correction",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-repair-missing-creation", seq: 5 }]
    }, { traceId: "trace-repair-missing-creation", turnIndex: 5, phase: "day_speech", day: 1 });
    addSocialTrustRepair(social, {
      id: "repair-ambiguous",
      actorId: "p8",
      targetId: "p9",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "public_clarification",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-repair-ambiguous", seq: 6 }]
    }, { traceId: "trace-repair-ambiguous", turnIndex: 6, phase: "day_speech", day: 1 });
    updateSocialTrustRepairStatus(social, {
      id: "repair-ambiguous",
      status: "rejected",
      evidenceRefs: [{ artifact: "outcome", id: "outcome-repair-ambiguous", seq: 7 }]
    }, { traceId: "trace-repair-ambiguous-status", turnIndex: 7, phase: "day_vote", day: 1 });

    const ambiguousEntry = social.journal?.entries.find(
      (entry) => entry.mutationKind === "trust_repair.status.updated" && entry.subjectId === "repair-ambiguous"
    );
    expect(ambiguousEntry).toBeDefined();
    delete ambiguousEntry!.turnIndex;
    social.journal!.entries = social.journal!.entries.filter(
      (entry) => !(entry.mutationKind === "trust_repair.added" && entry.subjectId === "repair-missing-creation")
    );

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-trust-repair-lifecycle",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "trust-repair-lifecycle-temporal-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "trust-repair-lifecycle-temporal-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createTrustRepairLifecycleTemporalAssociationEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect([...new Set(report.metrics.map((item) => item.id))].sort()).toEqual(
      [...TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS].sort()
    );
    expect(report.metrics.every((item) => item.evaluatorId === TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.evaluatorVersion === "1.0.0")).toBe(true);
    expect(report.metrics.every((item) => item.weight === 0)).toBe(true);
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      label: "Trust-repair lifecycle temporal association evaluator",
      version: "1.0.0",
      inputSchema: "harness.trust-repair-lifecycle-temporal-association.evaluation-context.v1",
      outputSchema: "harness.trust-repair-lifecycle-temporal-association.summary.v1",
      mode: "deterministic",
      metricIds: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
      dependencies: {
        mutationJournal: "AgentSocialState.journal.entries with subjectId, mutationKind, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
        socialState: "AgentSocialState.trustRepairs records for record denominators"
      },
      aggregation: "zero_weight_trust_repair_lifecycle_temporal_association_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("strict");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("does not assert causality");
    expect(report.outputs[TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: 1,
      agentsWithSocialState: 1,
      agentsWithJournal: 1,
      trustRepairs: 4,
      trustRepairEvaluableRecords: 2,
      trustRepairAssociatedRecords: 1,
      trustRepairMissingCreationRecords: 1,
      trustRepairAmbiguousOrderingRecords: 1,
      trustRepairNoLaterStatusUpdateRecords: 1
    });

    const repairCount = report.metrics.find((item) => item.id === "agent.social.trust_repair_status_temporal_association_count");
    expect(repairCount).toMatchObject({
      value: 1,
      denominator: 2,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-repair-ordered", seq: 1 }),
        expect.objectContaining({ artifact: "state", id: "outcome-repair-ordered", seq: 2 }),
        expect.objectContaining({ artifact: "agent_state", id: "p1", description: "socialStateHash:hash-trust-repair-lifecycle" })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "trust_repair_status_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation",
        hiddenTruthUsedInLiveStore: false,
        postgameTruthUsed: false,
        recordCount: 4,
        evaluableRecords: 2,
        associatedRecords: 1,
        missingCreationRecords: 1,
        ambiguousOrderingRecords: 1,
        noLaterStatusUpdateRecords: 1,
        socialStateHash: "hash-trust-repair-lifecycle"
      })
    });
    expect(repairCount?.metadata?.sampleAssociatedRecords).toEqual([
      {
        recordId: "repair-ordered",
        creationTurnIndex: 1,
        lifecycleTurnIndexes: [3],
        lifecycleKinds: ["accepted"]
      }
    ]);
    const repairEvidenceRefs = repairCount?.evidenceRefs ?? [];
    expect(repairEvidenceRefs.some((ref) => ref.id === "msg-repair-same-turn" || ref.id === "outcome-repair-same-turn")).toBe(false);
    expect(report.metrics.find((item) => item.id === "agent.social.trust_repair_status_temporal_association_rate")).toMatchObject({
      value: 0.5,
      denominator: 2,
      confidence: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.social.trust_repair_status_temporal_evaluable_record_rate")).toMatchObject({
      value: 0.5,
      denominator: 4,
      confidence: 1,
      aggregation: "coverage_ratio"
    });
    const registryWithoutRubric = report.evaluatorRegistry?.map(({ rubric, ...entry }) => entry);
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs, registry: registryWithoutRubric })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|trustRepairSuccess|trust_repair_success|repairSuccess|relationshipRestored|reputationRecovered|caused by/i
    );
  });

  it("audits betrayal lifecycle temporal associations from ordered journals", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;

    addSocialBetrayal(social, {
      id: "betrayal-ordered",
      actorId: "p2",
      targetId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "deception",
      triggerKind: "coalition",
      triggerId: "coalition-ordered",
      claim: "p2 broke the coalition cover story",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal-ordered", seq: 1 }]
    }, { traceId: "trace-betrayal-ordered", turnIndex: 1, phase: "day_speech", day: 1 });
    recordSocialBetrayalEvidence(social, {
      id: "betrayal-ordered",
      kind: "corroboration",
      status: "confirmed",
      evidenceRefs: [{ artifact: "event", id: "event-betrayal-ordered", seq: 2 }]
    }, { traceId: "trace-betrayal-ordered-evidence", turnIndex: 3, phase: "day_vote", day: 1 });
    addSocialBetrayal(social, {
      id: "betrayal-same-turn",
      actorId: "p4",
      targetId: "p5",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "abandonment",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal-same-turn", seq: 3 }]
    }, { traceId: "trace-betrayal-same-turn", turnIndex: 4, phase: "day_speech", day: 1 });
    recordSocialBetrayalEvidence(social, {
      id: "betrayal-same-turn",
      kind: "contest",
      status: "contested",
      evidenceRefs: [{ artifact: "event", id: "event-betrayal-same-turn", seq: 4 }]
    }, { traceId: "trace-betrayal-same-turn-evidence", turnIndex: 4, phase: "day_vote", day: 1 });
    addSocialBetrayal(social, {
      id: "betrayal-missing-creation",
      actorId: "p6",
      targetId: "p7",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "information_leak",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal-missing-creation", seq: 5 }]
    }, { traceId: "trace-betrayal-missing-creation", turnIndex: 5, phase: "day_speech", day: 1 });
    addSocialBetrayal(social, {
      id: "betrayal-ambiguous",
      actorId: "p8",
      targetId: "p9",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "coalition_betrayal",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal-ambiguous", seq: 6 }]
    }, { traceId: "trace-betrayal-ambiguous", turnIndex: 6, phase: "day_speech", day: 1 });
    recordSocialBetrayalEvidence(social, {
      id: "betrayal-ambiguous",
      kind: "repair",
      status: "repaired",
      evidenceRefs: [{ artifact: "event", id: "event-betrayal-ambiguous", seq: 7 }]
    }, { traceId: "trace-betrayal-ambiguous-evidence", turnIndex: 7, phase: "day_vote", day: 1 });
    addSocialBetrayal(social, {
      id: "betrayal-no-later",
      actorId: "p10",
      targetId: "p11",
      audienceIds: ["p1"],
      visibility: "public",
      kind: "other",
      confidence: 0.5,
      evidenceRefs: [{ artifact: "message", id: "msg-betrayal-no-later", seq: 8 }]
    }, { traceId: "trace-betrayal-no-later", turnIndex: 8, phase: "day_speech", day: 1 });

    const ambiguousEntry = social.journal?.entries.find(
      (entry) => entry.mutationKind === "betrayal.evidence.recorded" && entry.subjectId === "betrayal-ambiguous"
    );
    expect(ambiguousEntry).toBeDefined();
    delete ambiguousEntry!.turnIndex;
    social.journal!.entries = social.journal!.entries.filter(
      (entry) => !(entry.mutationKind === "betrayal.added" && entry.subjectId === "betrayal-missing-creation")
    );

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-betrayal-lifecycle",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "betrayal-lifecycle-temporal-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "betrayal-lifecycle-temporal-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createBetrayalLifecycleTemporalAssociationEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect(report.metricCount).toBe(BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS.length);
    expect([...new Set(report.metrics.map((item) => item.id))].sort()).toEqual(
      [...BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS].sort()
    );
    expect(report.metrics.every((item) => item.evaluatorId === BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.source === BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.evaluatorVersion === "1.0.0")).toBe(true);
    expect(report.metrics.every((item) => item.weight === 0)).toBe(true);
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      label: "Betrayal lifecycle temporal association evaluator",
      version: "1.0.0",
      inputSchema: "harness.betrayal-lifecycle-temporal-association.evaluation-context.v1",
      outputSchema: "harness.betrayal-lifecycle-temporal-association.summary.v1",
      mode: "deterministic",
      metricIds: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
      dependencies: {
        mutationJournal:
          "AgentSocialState.journal.entries with store betrayals, mutationKind betrayal.added/betrayal.evidence.recorded, subjectId, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
        socialState: "AgentSocialState.betrayals records for record denominators"
      },
      aggregation: "zero_weight_betrayal_lifecycle_temporal_association_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("strict");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("does not assert betrayal truth");
    expect(report.outputs[BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: 1,
      agentsWithSocialState: 1,
      agentsWithJournal: 1,
      betrayals: 5,
      betrayalEvaluableRecords: 3,
      betrayalAssociatedRecords: 1,
      betrayalMissingCreationRecords: 1,
      betrayalAmbiguousOrderingRecords: 1,
      betrayalNoLaterLifecycleEvidenceRecords: 2
    });

    const betrayalCount = report.metrics.find((item) => item.id === "agent.social.betrayal_lifecycle_temporal_association_count");
    expect(betrayalCount).toMatchObject({
      value: 1,
      denominator: 3,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-betrayal-ordered", seq: 1 }),
        expect.objectContaining({ artifact: "event", id: "event-betrayal-ordered", seq: 2 }),
        expect.objectContaining({ artifact: "agent_state", id: "p1", description: "socialStateHash:hash-betrayal-lifecycle" })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "betrayal_lifecycle_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation",
        hiddenTruthUsedInLiveStore: false,
        postgameTruthUsed: false,
        betrayalSource: "AgentSocialState.betrayals.records",
        mutationSource: "AgentSocialState.journal.entries:betrayal.evidence.recorded",
        recordCount: 5,
        evaluableRecords: 3,
        associatedRecords: 1,
        missingCreationRecords: 1,
        ambiguousOrderingRecords: 1,
        noLaterLifecycleEvidenceRecords: 2,
        lifecycleEvidenceKinds: ["allegation", "corroboration", "contest", "repair", "outcome"],
        socialStateHash: "hash-betrayal-lifecycle"
      })
    });
    expect(betrayalCount?.metadata?.sampleAssociatedRecords).toEqual([
      {
        recordId: "betrayal-ordered",
        creationTurnIndex: 1,
        lifecycleTurnIndexes: [3],
        lifecycleKinds: ["corroboration"]
      }
    ]);
    const associatedEvidenceRefs = betrayalCount?.evidenceRefs ?? [];
    expect(associatedEvidenceRefs.some((ref) => ref.id === "msg-betrayal-same-turn" || ref.id === "event-betrayal-same-turn")).toBe(false);
    expect(associatedEvidenceRefs.some((ref) => ref.id === "msg-betrayal-missing-creation")).toBe(false);
    expect(associatedEvidenceRefs.some((ref) => ref.id === "msg-betrayal-ambiguous" || ref.id === "event-betrayal-ambiguous")).toBe(false);
    expect(associatedEvidenceRefs.some((ref) => ref.id === "msg-betrayal-no-later")).toBe(false);
    expect(report.metrics.find((item) => item.id === "agent.social.betrayal_lifecycle_temporal_association_rate")).toMatchObject({
      value: 0.333,
      denominator: 3,
      confidence: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.social.betrayal_lifecycle_temporal_evaluable_record_rate")).toMatchObject({
      value: 0.6,
      denominator: 5,
      confidence: 1,
      aggregation: "coverage_ratio"
    });
    const registryWithoutRubric = report.evaluatorRegistry?.map(({ rubric, ...entry }) => entry);
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs, registry: registryWithoutRubric })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|betrayalSuccess|successful betrayal|betrayalImpact|betrayal\s+impact|relationshipDamage|reputationDamage|coalitionFailure|caused by/i
    );
  });

  it("audits trust-repair relationship temporal associations from ordered journals", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    const addRepair = (input: { id: string; actorId: string; targetId: string; seq: number; turnIndex: number }) =>
      addSocialTrustRepair(
        social,
        {
          id: input.id,
          actorId: input.actorId,
          targetId: input.targetId,
          audienceIds: ["p1"],
          visibility: "public",
          kind: "evidence_provided",
          confidence: 0.7,
          evidenceRefs: [{ artifact: "message", id: `msg-${input.id}`, seq: input.seq }]
        },
        { traceId: `trace-${input.id}`, turnIndex: input.turnIndex, phase: "day_speech", day: 1 }
      );

    addRepair({ id: "repair-associated", actorId: "p2", targetId: "p3", seq: 1, turnIndex: 1 });
    updateSocialRelationship(
      social,
      {
        targetId: "p2",
        deltas: { trust: 0.4, suspicion: -0.2 },
        evidenceRefs: [{ artifact: "message", id: "msg-relationship-after-repair", seq: 2 }]
      },
      { traceId: "trace-relationship-after-repair", turnIndex: 3, phase: "day_vote", day: 1 }
    );
    updateSocialRelationship(
      social,
      {
        targetId: "p12",
        deltas: { trust: 0.3 },
        evidenceRefs: [{ artifact: "message", id: "msg-relationship-unrelated-subject", seq: 3 }]
      },
      { traceId: "trace-relationship-unrelated-subject", turnIndex: 3, phase: "day_vote", day: 1 }
    );
    addRepair({ id: "repair-same-turn", actorId: "p4", targetId: "p5", seq: 4, turnIndex: 4 });
    updateSocialRelationship(
      social,
      {
        targetId: "p4",
        deltas: { trust: 0.1 },
        evidenceRefs: [{ artifact: "message", id: "msg-relationship-same-turn", seq: 5 }]
      },
      { traceId: "trace-relationship-same-turn", turnIndex: 4, phase: "day_vote", day: 1 }
    );
    addRepair({ id: "repair-missing-creation", actorId: "p6", targetId: "p7", seq: 6, turnIndex: 5 });
    updateSocialRelationship(
      social,
      {
        targetId: "p6",
        deltas: { respect: 0.2 },
        evidenceRefs: [{ artifact: "message", id: "msg-relationship-missing-creation", seq: 7 }]
      },
      { traceId: "trace-relationship-missing-creation", turnIndex: 6, phase: "day_vote", day: 1 }
    );
    addRepair({ id: "repair-ambiguous", actorId: "p8", targetId: "p9", seq: 8, turnIndex: 6 });
    updateSocialRelationship(
      social,
      {
        targetId: "p8",
        deltas: { influence: 0.2 },
        evidenceRefs: [{ artifact: "message", id: "msg-relationship-ambiguous", seq: 9 }]
      },
      { traceId: "trace-relationship-ambiguous", turnIndex: 7, phase: "day_vote", day: 1 }
    );
    addRepair({ id: "repair-no-later", actorId: "p10", targetId: "p11", seq: 10, turnIndex: 8 });

    const ambiguousEntry = social.journal?.entries.find(
      (entry) => entry.mutationKind === "relationship.updated" && entry.subjectId === "p8"
    );
    expect(ambiguousEntry).toBeDefined();
    delete ambiguousEntry!.turnIndex;
    social.journal!.entries = social.journal!.entries.filter(
      (entry) => !(entry.mutationKind === "trust_repair.added" && entry.subjectId === "repair-missing-creation")
    );

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-trust-repair-relationship",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "trust-repair-relationship-temporal-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "trust-repair-relationship-temporal-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createTrustRepairRelationshipTemporalAssociationEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect([...new Set(report.metrics.map((item) => item.id))].sort()).toEqual(
      [...TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS].sort()
    );
    expect(report.metrics.every((item) => item.evaluatorId === TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.source === TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.evaluatorVersion === "1.0.0")).toBe(true);
    expect(report.metrics.every((item) => item.weight === 0)).toBe(true);
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      label: "Trust-repair relationship temporal association evaluator",
      version: "1.0.0",
      inputSchema: "harness.trust-repair-relationship-temporal-association.evaluation-context.v1",
      outputSchema: "harness.trust-repair-relationship-temporal-association.summary.v1",
      mode: "deterministic",
      metricIds: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS,
      dependencies: {
        mutationJournal:
          "AgentSocialState.journal.entries with store trustRepairs/relationships, mutationKind trust_repair.added/relationship.updated, subjectId, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
        socialState: "AgentSocialState.trustRepairs records and AgentSocialState.relationships edges for record denominators"
      },
      aggregation: "zero_weight_trust_repair_relationship_temporal_association_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("strict");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("does not assert causality");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("relationship.updated");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("repair actor");
    expect(report.outputs[TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: 1,
      agentsWithSocialState: 1,
      agentsWithJournal: 1,
      trustRepairs: 5,
      relationshipEdges: 5,
      trustRepairRelationshipEvaluableRecords: 3,
      trustRepairRelationshipAssociatedRecords: 1,
      trustRepairRelationshipMissingCreationRecords: 1,
      trustRepairRelationshipAmbiguousOrderingRecords: 1,
      trustRepairRelationshipSameTurnMutationRecords: 1,
      trustRepairRelationshipNoLaterRelationshipUpdateRecords: 1
    });

    const relationshipCount = report.metrics.find((item) => item.id === "agent.social.trust_repair_relationship_temporal_association_count");
    expect(relationshipCount).toMatchObject({
      value: 1,
      denominator: 3,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-repair-associated", seq: 1 }),
        expect.objectContaining({ artifact: "message", id: "msg-relationship-after-repair", seq: 2 }),
        expect.objectContaining({ artifact: "agent_state", id: "p1", description: "socialStateHash:hash-trust-repair-relationship" })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "trust_repair_relationship_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation",
        hiddenTruthUsedInLiveStore: false,
        postgameTruthUsed: false,
        repairSource: "AgentSocialState.trustRepairs.records",
        mutationSource: "AgentSocialState.journal.entries:relationship.updated",
        subjectMatchRule: "repair_actor_id",
        matchedParticipantRole: "actor",
        relationshipDimensionWhitelist: ["trust", "suspicion", "affinity", "influence", "debt", "respect", "threat"],
        relationshipDimensions: expect.arrayContaining(["trust", "suspicion"]),
        recordCount: 5,
        evaluableRecords: 3,
        associatedRecords: 1,
        missingCreationRecords: 1,
        ambiguousOrderingRecords: 1,
        sameTurnMutationRecords: 1,
        noLaterRelationshipUpdateRecords: 1,
        socialStateHash: "hash-trust-repair-relationship"
      })
    });
    expect(relationshipCount?.metadata?.sampleAssociatedRecords).toEqual([
      {
        recordId: "repair-associated",
        creationTurnIndex: 1,
        mutationTurnIndexes: [3],
        mutationKinds: ["relationship.updated"],
        mutationDimensions: ["trust", "suspicion"]
      }
    ]);
    const relationshipEvidenceRefs = relationshipCount?.evidenceRefs ?? [];
    expect(
      relationshipEvidenceRefs.some((ref) =>
        [
          "msg-relationship-unrelated-subject",
          "msg-repair-same-turn",
          "msg-relationship-same-turn",
          "msg-relationship-missing-creation",
          "msg-relationship-ambiguous"
        ].includes(String(ref.id))
      )
    ).toBe(false);
    expect(report.metrics.find((item) => item.id === "agent.social.trust_repair_relationship_temporal_association_rate")).toMatchObject({
      value: 0.333,
      denominator: 3,
      confidence: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.social.trust_repair_relationship_temporal_evaluable_record_rate")).toMatchObject({
      value: 0.6,
      denominator: 5,
      confidence: 1,
      aggregation: "coverage_ratio"
    });
    const registryWithoutRubric = report.evaluatorRegistry?.map(({ rubric, ...entry }) => entry);
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs, registry: registryWithoutRubric })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|trustRepairSuccess|trust_repair_success|repairSuccess|relationshipRestored|trustRestored|reputationRecovered|caused by/i
    );
  });

  it("audits trust-repair reputation temporal associations from ordered journals", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    const addRepair = (input: { id: string; actorId: string; targetId: string; seq: number; turnIndex: number }) =>
      addSocialTrustRepair(
        social,
        {
          id: input.id,
          actorId: input.actorId,
          targetId: input.targetId,
          audienceIds: ["p1"],
          visibility: "public",
          kind: "evidence_provided",
          confidence: 0.7,
          evidenceRefs: [{ artifact: "message", id: `msg-${input.id}`, seq: input.seq }]
        },
        { traceId: `trace-${input.id}`, turnIndex: input.turnIndex, phase: "day_speech", day: 1 }
      );

    addRepair({ id: "repair-associated", actorId: "p2", targetId: "p3", seq: 1, turnIndex: 1 });
    updateSocialReputation(
      social,
      {
        subjectId: "p2",
        deltas: { honesty: 0.3, cooperation: 0.2, threat: -0.2 },
        evidenceRefs: [{ artifact: "message", id: "msg-reputation-after-repair", seq: 2 }]
      },
      { traceId: "trace-reputation-after-repair", turnIndex: 3, phase: "day_vote", day: 1 }
    );
    updateSocialReputation(
      social,
      {
        subjectId: "p12",
        deltas: { honesty: 0.2 },
        evidenceRefs: [{ artifact: "message", id: "msg-reputation-unrelated-subject", seq: 3 }]
      },
      { traceId: "trace-reputation-unrelated-subject", turnIndex: 3, phase: "day_vote", day: 1 }
    );
    addRepair({ id: "repair-same-turn", actorId: "p4", targetId: "p5", seq: 4, turnIndex: 4 });
    updateSocialReputation(
      social,
      {
        subjectId: "p4",
        deltas: { competence: 0.1 },
        evidenceRefs: [{ artifact: "message", id: "msg-reputation-same-turn", seq: 5 }]
      },
      { traceId: "trace-reputation-same-turn", turnIndex: 4, phase: "day_vote", day: 1 }
    );
    addRepair({ id: "repair-missing-creation", actorId: "p6", targetId: "p7", seq: 6, turnIndex: 5 });
    updateSocialReputation(
      social,
      {
        subjectId: "p6",
        deltas: { normCompliance: 0.2 },
        evidenceRefs: [{ artifact: "message", id: "msg-reputation-missing-creation", seq: 7 }]
      },
      { traceId: "trace-reputation-missing-creation", turnIndex: 6, phase: "day_vote", day: 1 }
    );
    addRepair({ id: "repair-ambiguous", actorId: "p8", targetId: "p9", seq: 8, turnIndex: 6 });
    updateSocialReputation(
      social,
      {
        subjectId: "p8",
        deltas: { cooperation: 0.2 },
        evidenceRefs: [{ artifact: "message", id: "msg-reputation-ambiguous", seq: 9 }]
      },
      { traceId: "trace-reputation-ambiguous", turnIndex: 7, phase: "day_vote", day: 1 }
    );
    addRepair({ id: "repair-no-later", actorId: "p10", targetId: "p11", seq: 10, turnIndex: 8 });

    const ambiguousEntry = social.journal?.entries.find(
      (entry) => entry.mutationKind === "reputation.updated" && entry.subjectId === "p8"
    );
    expect(ambiguousEntry).toBeDefined();
    delete ambiguousEntry!.turnIndex;
    social.journal!.entries = social.journal!.entries.filter(
      (entry) => !(entry.mutationKind === "trust_repair.added" && entry.subjectId === "repair-missing-creation")
    );

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-trust-repair-reputation",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "trust-repair-reputation-temporal-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "trust-repair-reputation-temporal-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [createTrustRepairReputationTemporalAssociationEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect([...new Set(report.metrics.map((item) => item.id))].sort()).toEqual(
      [...TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS].sort()
    );
    expect(report.metrics.every((item) => item.evaluatorId === TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.source === TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.evaluatorVersion === "1.0.0")).toBe(true);
    expect(report.metrics.every((item) => item.weight === 0)).toBe(true);
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      label: "Trust-repair reputation temporal association evaluator",
      version: "1.0.0",
      inputSchema: "harness.trust-repair-reputation-temporal-association.evaluation-context.v1",
      outputSchema: "harness.trust-repair-reputation-temporal-association.summary.v1",
      mode: "deterministic",
      metricIds: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS,
      dependencies: {
        mutationJournal:
          "AgentSocialState.journal.entries with store trustRepairs/reputation, mutationKind trust_repair.added/reputation.updated, subjectId, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
        socialState: "AgentSocialState.trustRepairs records and AgentSocialState.reputation records for record denominators"
      },
      aggregation: "zero_weight_trust_repair_reputation_temporal_association_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("strict");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("does not assert causality");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("reputation.updated");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("repair actor");
    expect(report.outputs[TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: 1,
      agentsWithSocialState: 1,
      agentsWithJournal: 1,
      trustRepairs: 5,
      reputationRecords: 5,
      trustRepairReputationEvaluableRecords: 3,
      trustRepairReputationAssociatedRecords: 1,
      trustRepairReputationMissingCreationRecords: 1,
      trustRepairReputationAmbiguousOrderingRecords: 1,
      trustRepairReputationSameTurnMutationRecords: 1,
      trustRepairReputationNoLaterReputationUpdateRecords: 1
    });

    const reputationCount = report.metrics.find((item) => item.id === "agent.social.trust_repair_reputation_temporal_association_count");
    expect(reputationCount).toMatchObject({
      value: 1,
      denominator: 3,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-repair-associated", seq: 1 }),
        expect.objectContaining({ artifact: "message", id: "msg-reputation-after-repair", seq: 2 }),
        expect.objectContaining({ artifact: "agent_state", id: "p1", description: "socialStateHash:hash-trust-repair-reputation" })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "trust_repair_reputation_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation",
        hiddenTruthUsedInLiveStore: false,
        postgameTruthUsed: false,
        repairSource: "AgentSocialState.trustRepairs.records",
        mutationSource: "AgentSocialState.journal.entries:reputation.updated",
        subjectMatchRule: "repair_actor_id",
        matchedParticipantRole: "actor",
        reputationDimensionWhitelist: ["honesty", "competence", "cooperation", "threat", "normCompliance"],
        reputationDimensions: expect.arrayContaining(["honesty", "cooperation", "threat"]),
        recordCount: 5,
        evaluableRecords: 3,
        associatedRecords: 1,
        missingCreationRecords: 1,
        ambiguousOrderingRecords: 1,
        sameTurnMutationRecords: 1,
        noLaterReputationUpdateRecords: 1,
        socialStateHash: "hash-trust-repair-reputation"
      })
    });
    expect(reputationCount?.metadata?.sampleAssociatedRecords).toEqual([
      {
        recordId: "repair-associated",
        creationTurnIndex: 1,
        mutationTurnIndexes: [3],
        mutationKinds: ["reputation.updated"],
        mutationDimensions: ["honesty", "cooperation", "threat"]
      }
    ]);
    const reputationEvidenceRefs = reputationCount?.evidenceRefs ?? [];
    expect(
      reputationEvidenceRefs.some((ref) =>
        [
          "msg-reputation-unrelated-subject",
          "msg-repair-same-turn",
          "msg-reputation-same-turn",
          "msg-reputation-missing-creation",
          "msg-reputation-ambiguous"
        ].includes(String(ref.id))
      )
    ).toBe(false);
    expect(report.metrics.find((item) => item.id === "agent.social.trust_repair_reputation_temporal_association_rate")).toMatchObject({
      value: 0.333,
      denominator: 3,
      confidence: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.social.trust_repair_reputation_temporal_evaluable_record_rate")).toMatchObject({
      value: 0.6,
      denominator: 5,
      confidence: 1,
      aggregation: "coverage_ratio"
    });
    const registryWithoutRubric = report.evaluatorRegistry?.map(({ rubric, ...entry }) => entry);
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs, registry: registryWithoutRubric })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|trustRepairSuccess|trust_repair_success|repairSuccess|relationshipRestored|trustRestored|reputationRecovered|caused by/i
    );
  });

  it("audits gossip-exposure temporal associations from scoped exposure records", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    const messages: SocialMessage[] = [
      {
        id: "msg-gossip-associated",
        seq: 1,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 says p3 contradicted their vote claim.",
        createdAt: new Date(1000).toISOString(),
        metadata: { kind: "typed-gossip" }
      },
      {
        id: "msg-gossip-same-turn",
        seq: 2,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 says p3 hedged on a direct question.",
        createdAt: new Date(2000).toISOString(),
        metadata: { kind: "typed-gossip" }
      },
      {
        id: "msg-gossip-before",
        seq: 3,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 says p3 avoided accountability.",
        createdAt: new Date(3000).toISOString(),
        metadata: { kind: "typed-gossip" }
      },
      {
        id: "msg-gossip-unobserved",
        seq: 4,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "This committed public message is not in p1 scoped observation.",
        createdAt: new Date(4000).toISOString(),
        metadata: { kind: "typed-gossip" }
      },
      {
        id: "msg-gossip-missing-creation",
        seq: 5,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 says p3 over-claimed certainty.",
        createdAt: new Date(5000).toISOString(),
        metadata: { kind: "typed-gossip" }
      },
      {
        id: "msg-gossip-ambiguous",
        seq: 6,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 says p3 is shifting blame.",
        createdAt: new Date(6000).toISOString(),
        metadata: { kind: "typed-gossip" }
      }
    ];
    const socialEpisode = {
      steps: [
        {
          traceId: "trace-p1-exposure",
          turnIndex: 2,
          actorId: "p1",
          profileId: "profile-p1",
          schedulerMode: "aec",
          pendingAction: { actorId: "p1", kind: "observe" },
          observation: {
            agentId: "p1",
            visibleMessages: [messages[0], messages[1], messages[2], messages[4], messages[5]]
          },
          action: { actorId: "p1", kind: "observe", command: { type: "observe" } }
        }
      ],
      messages
    } as unknown as SocialEpisodeArtifact;

    addSocialGossip(social, {
      id: "gossip-associated",
      speakerId: "p2",
      subjectId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      topic: "credibility",
      claim: "p3 contradicted a vote claim",
      valence: "negative",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip-associated", seq: 1 }]
    }, { traceId: "trace-gossip-associated", turnIndex: 3, phase: "day_speech", day: 1 });
    addSocialGossip(social, {
      id: "gossip-same-turn",
      speakerId: "p2",
      subjectId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      topic: "responsiveness",
      claim: "p3 hedged on a direct question",
      valence: "negative",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip-same-turn", seq: 2 }]
    }, { traceId: "trace-gossip-same-turn", turnIndex: 2, phase: "day_speech", day: 1 });
    addSocialGossip(social, {
      id: "gossip-before-exposure",
      speakerId: "p2",
      subjectId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      topic: "accountability",
      claim: "p3 avoided accountability",
      valence: "negative",
      confidence: 0.7,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip-before", seq: 3 }]
    }, { traceId: "trace-gossip-before", turnIndex: 1, phase: "day_speech", day: 1 });
    addSocialGossip(social, {
      id: "gossip-missing-scoped-exposure",
      speakerId: "p2",
      subjectId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      topic: "unobserved-claim",
      claim: "p3 made an unobserved public claim",
      valence: "negative",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip-unobserved", seq: 4 }]
    }, { traceId: "trace-gossip-unobserved", turnIndex: 3, phase: "day_speech", day: 1 });
    addSocialGossip(social, {
      id: "gossip-missing-creation",
      speakerId: "p2",
      subjectId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      topic: "certainty",
      claim: "p3 over-claimed certainty",
      valence: "negative",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip-missing-creation", seq: 5 }]
    }, { traceId: "trace-gossip-missing-creation", turnIndex: 3, phase: "day_speech", day: 1 });
    addSocialGossip(social, {
      id: "gossip-ambiguous",
      speakerId: "p2",
      subjectId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      topic: "blame",
      claim: "p3 is shifting blame",
      valence: "negative",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip-ambiguous", seq: 6 }]
    }, { traceId: "trace-gossip-ambiguous", turnIndex: 3, phase: "day_speech", day: 1 });
    addSocialGossip(social, {
      id: "gossip-missing-message-evidence",
      speakerId: "p2",
      subjectId: "p3",
      audienceIds: ["p1"],
      visibility: "public",
      topic: "event-only",
      claim: "event-only gossip should not be joined to exposure",
      valence: "unknown",
      confidence: 0.5,
      evidenceRefs: [{ artifact: "event", id: "event-gossip-only", seq: 7 }]
    }, { traceId: "trace-gossip-event-only", turnIndex: 3, phase: "day_speech", day: 1 });

    const ambiguousEntry = social.journal?.entries.find((entry) => entry.mutationKind === "gossip.added" && entry.subjectId === "gossip-ambiguous");
    expect(ambiguousEntry).toBeDefined();
    delete ambiguousEntry!.turnIndex;
    social.journal!.entries = social.journal!.entries.filter(
      (entry) => !(entry.mutationKind === "gossip.added" && entry.subjectId === "gossip-missing-creation")
    );

    const derivedExposure = deriveSocialExposureRecords(socialEpisode);
    expect(derivedExposure.map((record) => [record.messageId, record.sourceId, record.observerId])).toEqual([
      ["msg-gossip-associated", "p2", "p1"],
      ["msg-gossip-same-turn", "p2", "p1"],
      ["msg-gossip-before", "p2", "p1"],
      ["msg-gossip-missing-creation", "p2", "p1"],
      ["msg-gossip-ambiguous", "p2", "p1"]
    ]);
    expect(derivedExposure.some((record) => record.messageId === "msg-gossip-unobserved")).toBe(false);

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-gossip-exposure",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "gossip-exposure-temporal-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "gossip-exposure-temporal-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: [],
        socialEpisode
      },
      evaluators: [createGossipExposureTemporalAssociationEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect([...new Set(report.metrics.map((item) => item.id))].sort()).toEqual(
      [...GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS].sort()
    );
    expect(report.metrics.every((item) => item.evaluatorId === GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.evaluatorVersion === "1.0.0")).toBe(true);
    expect(report.metrics.every((item) => item.weight === 0)).toBe(true);
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      label: "Gossip-exposure temporal association evaluator",
      version: "1.0.0",
      inputSchema: "harness.gossip-exposure-temporal-association.evaluation-context.v1",
      outputSchema: "harness.gossip-exposure-temporal-association.summary.v1",
      mode: "deterministic",
      metricIds: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS,
      dependencies: {
        socialExposure: "SocialExposureRecord records from deriveSocialExposureRecords() over SocialEpisodeArtifact steps/messages",
        mutationJournal: "AgentSocialState.journal.entries with store gossip, mutationKind gossip.added, subjectId, turnIndex, hiddenTruthUsed, and evidenceRefs",
        socialState: "AgentSocialState.gossip records for record denominators"
      },
      aggregation: "zero_weight_gossip_exposure_temporal_association_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("does not assert");
    expect(report.outputs[GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: 1,
      agentsWithSocialState: 1,
      agentsWithJournal: 1,
      agentsWithExposureRecords: 1,
      exposureRecords: 5,
      gossipRecords: 7,
      gossipEvaluableRecords: 3,
      gossipAssociatedRecords: 1,
      gossipMissingCreationRecords: 1,
      gossipMissingMessageEvidenceRecords: 1,
      gossipMissingScopedExposureRecords: 1,
      gossipAmbiguousOrderingRecords: 1,
      gossipSameTurnIngestionRecords: 1,
      gossipNoLaterCreationRecords: 2
    });

    const countMetric = report.metrics.find((item) => item.id === "agent.social.gossip_exposure_temporal_association_count");
    expect(countMetric).toMatchObject({
      value: 1,
      denominator: 3,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-gossip-associated", seq: 1 }),
        expect.objectContaining({ artifact: "trace", traceId: "trace-p1-exposure", seq: 2 }),
        expect.objectContaining({ artifact: "agent_state", id: "p1", description: "socialStateHash:hash-gossip-exposure" })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "gossip_exposure_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_gossip_added_turnIndex_after_scoped_exposure",
        exposureSource: "SocialExposureRecord from deriveSocialExposureRecords",
        gossipSource: "AgentSocialState.gossip.records",
        mutationSource: "AgentSocialState.journal.entries:gossip.added",
        hiddenTruthUsedInLiveStore: false,
        postgameTruthUsed: false,
        recordCount: 7,
        evaluableRecords: 3,
        associatedRecords: 1,
        missingCreationRecords: 1,
        missingMessageEvidenceRecords: 1,
        missingScopedExposureRecords: 1,
        ambiguousOrderingRecords: 1,
        sameTurnIngestionRecords: 1,
        noLaterCreationRecords: 2,
        totalExposureRecords: 5,
        observerExposureRecords: 5,
        socialStateHash: "hash-gossip-exposure"
      })
    });
    expect(countMetric?.metadata?.sampleAssociatedRecords).toEqual([
      {
        recordId: "gossip-associated",
        creationTurnIndex: 3,
        exposureTurnIndexes: [2],
        messageIds: ["msg-gossip-associated"],
        messageSeqs: [1]
      }
    ]);
    const countEvidenceRefs = countMetric?.evidenceRefs ?? [];
    expect(countEvidenceRefs.some((ref) => ref.id === "msg-gossip-same-turn")).toBe(false);
    expect(countEvidenceRefs.some((ref) => ref.id === "msg-gossip-unobserved")).toBe(false);
    expect(report.metrics.find((item) => item.id === "agent.social.gossip_exposure_temporal_association_rate")).toMatchObject({
      value: 0.333,
      denominator: 3,
      confidence: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.social.gossip_exposure_temporal_evaluable_record_rate")).toMatchObject({
      value: 0.429,
      denominator: 7,
      confidence: 1,
      aggregation: "coverage_ratio"
    });
    const registryWithoutRubric = report.evaluatorRegistry?.map(({ rubric, ...entry }) => entry);
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs, registry: registryWithoutRubric })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|deception\s+success|persuasion\s+success|reputationDamage|reputation\s+damage|gossipTruth|successful gossip|caused by/i
    );
  });

  it("audits explicit social-fact ingest evidence from scoped exposure to journal mutation", () => {
    const social = createAgentSocialState({
      agentId: "p1",
      profile: { id: "profile-p1", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    const messages: SocialMessage[] = [
      {
        id: "msg-commit-linked",
        seq: 1,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 makes a typed commitment.",
        createdAt: new Date(1000).toISOString(),
        speechActs: [
          {
            id: "act-commit-linked",
            kind: "commitment",
            subjectId: "p2",
            targetId: "p3",
            value: "vote p3",
            confidence: 0.9,
            evidenceRefs: [{ artifact: "message", id: "msg-commit-linked", seq: 1 }],
            metadata: { commitmentId: "commit-linked", promisedAction: "vote p3" }
          }
        ]
      },
      {
        id: "msg-coalition-linked",
        seq: 2,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 signals a typed coalition.",
        createdAt: new Date(2000).toISOString(),
        speechActs: [
          {
            id: "act-coalition-linked",
            kind: "coalition_signal",
            targetId: "p3",
            value: "werewolf.killVote",
            confidence: 0.8,
            evidenceRefs: [{ artifact: "message", id: "msg-coalition-linked", seq: 2 }],
            metadata: { coalitionId: "coalition-linked", memberIds: ["p1", "p2"], sharedGoal: "pressure p3" }
          }
        ]
      },
      {
        id: "msg-relationship-linked",
        seq: 3,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 provides a structured relationship fact.",
        createdAt: new Date(3000).toISOString(),
        metadata: {
          socialFacts: [
            {
              kind: "relationship",
              targetId: "p2",
              deltas: { trust: 0.2 },
              reason: "kept a public commitment"
            }
          ]
        }
      },
      {
        id: "msg-reputation-linked",
        seq: 4,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 provides a structured reputation fact.",
        createdAt: new Date(4000).toISOString(),
        metadata: {
          socialFacts: [
            {
              kind: "reputation",
              subjectId: "p2",
              deltas: { honesty: 0.1 },
              reason: "consistent public claim"
            }
          ]
        }
      },
      {
        id: "msg-commit-missing",
        seq: 5,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 makes a second typed commitment without journal mutation.",
        createdAt: new Date(5000).toISOString(),
        speechActs: [
          {
            id: "act-commit-missing",
            kind: "commitment",
            subjectId: "p2",
            targetId: "p3",
            value: "guard p3",
            confidence: 0.7,
            evidenceRefs: [{ artifact: "message", id: "msg-commit-missing", seq: 5 }],
            metadata: { commitmentId: "commit-missing", promisedAction: "guard p3" }
          }
        ]
      },
      {
        id: "msg-coalition-missing",
        seq: 6,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "p2 signals a second typed coalition without a valid journal mutation.",
        createdAt: new Date(6000).toISOString(),
        speechActs: [
          {
            id: "act-coalition-missing",
            kind: "coalition_signal",
            targetId: "p3",
            value: "pressure p4",
            confidence: 0.7,
            evidenceRefs: [{ artifact: "message", id: "msg-coalition-missing", seq: 6 }],
            metadata: { coalitionId: "coalition-missing", memberIds: ["p1", "p2"], sharedGoal: "pressure p4" }
          }
        ]
      },
      {
        id: "msg-free-text-only",
        seq: 7,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "I promise I will help, but this message has no typed speech act or socialFacts.",
        createdAt: new Date(7000).toISOString()
      },
      {
        id: "msg-metadata-derived",
        seq: 8,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "Derived metadata should not become a top-level speech-act denominator.",
        createdAt: new Date(8000).toISOString(),
        speechActs: [
          {
            id: "act-derived-commitment",
            kind: "commitment",
            subjectId: "p2",
            value: "derived commitment",
            confidence: 0.5,
            evidenceRefs: [{ artifact: "message", id: "msg-metadata-derived", seq: 8 }],
            metadata: { source: "metadata.socialFacts", commitmentId: "commit-derived", promisedAction: "derived" }
          }
        ],
        metadata: {
          socialFacts: [
            {
              kind: "commitment",
              id: "commit-derived",
              promisedAction: "derived"
            }
          ]
        }
      },
      {
        id: "msg-malformed-speech-acts",
        seq: 9,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "Malformed speechActs should be ignored by the evaluator.",
        createdAt: new Date(9000).toISOString(),
        speechActs: [{ kind: "commitment", value: "malformed missing id", metadata: { commitmentId: "commit-malformed" } } as never]
      },
      {
        id: "msg-unobserved-relationship",
        seq: 10,
        channelId: "table",
        senderId: "p2",
        recipientIds: ["p1", "p3"],
        visibility: "public",
        content: "Committed but not included in p1 scoped observation.",
        createdAt: new Date(10000).toISOString(),
        metadata: {
          socialFacts: [
            {
              kind: "relationship",
              targetId: "p4",
              deltas: { trust: 0.3 }
            }
          ]
        }
      }
    ];
    const socialEpisode = {
      steps: [
        {
          traceId: "trace-p1-social-fact-exposure",
          turnIndex: 2,
          actorId: "p1",
          profileId: "profile-p1",
          schedulerMode: "aec",
          pendingAction: { actorId: "p1", kind: "observe" },
          observation: {
            agentId: "p1",
            visibleMessages: messages.slice(0, 9)
          },
          action: { actorId: "p1", kind: "observe", command: { type: "observe" } }
        }
      ],
      messages
    } as unknown as SocialEpisodeArtifact;

    addSocialCommitment(social, {
      id: "commit-linked",
      actorId: "p2",
      audienceIds: ["p1"],
      visibility: "public",
      promisedAction: "vote p3",
      targetId: "p3",
      confidence: 0.9,
      evidenceRefs: [{ artifact: "message", id: "msg-commit-linked", seq: 1 }],
      metadata: {
        factSource: "social-message-speech-act",
        factKind: "commitment",
        factSemantic: "commitment",
        observerId: "p1",
        speakerId: "p2",
        targetId: "p3",
        messageId: "msg-commit-linked",
        messageSeq: 1,
        speechActId: "act-commit-linked",
        speechActKind: "commitment",
        speechActIndex: 0,
        channelId: "table",
        visibility: "public"
      }
    }, { traceId: "trace-commit-linked", turnIndex: 2, phase: "day_speech", day: 1 });
    addSocialCoalition(social, {
      id: "coalition-linked",
      memberIds: ["p1", "p2"],
      visibility: "public",
      sharedGoal: "pressure p3",
      targetId: "p3",
      confidence: 0.8,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-linked", seq: 2 }],
      metadata: {
        factSource: "social-message-speech-act",
        factKind: "coalition_signal",
        factSemantic: "coalition",
        observerId: "p1",
        speakerId: "p2",
        targetId: "p3",
        messageId: "msg-coalition-linked",
        messageSeq: 2,
        speechActId: "act-coalition-linked",
        speechActKind: "coalition_signal",
        speechActIndex: 0,
        channelId: "table",
        visibility: "public"
      }
    }, { traceId: "trace-coalition-linked", turnIndex: 2, phase: "day_speech", day: 1 });
    updateSocialRelationship(social, {
      targetId: "p2",
      deltas: { trust: 0.2 },
      evidenceRefs: [{ artifact: "message", id: "msg-relationship-linked", seq: 3 }],
      metadata: {
        factSource: "social-message-metadata",
        factKind: "relationship",
        factIndex: 0,
        observerId: "p1",
        speakerId: "p2",
        targetId: "p2",
        messageId: "msg-relationship-linked",
        messageSeq: 3,
        channelId: "table",
        visibility: "public"
      }
    }, { traceId: "trace-relationship-linked", turnIndex: 2, phase: "day_speech", day: 1 });
    updateSocialReputation(social, {
      subjectId: "p2",
      deltas: { honesty: 0.1 },
      evidenceRefs: [{ artifact: "message", id: "msg-reputation-linked", seq: 4 }],
      metadata: {
        factSource: "social-message-metadata",
        factKind: "reputation",
        factIndex: 0,
        observerId: "p1",
        speakerId: "p2",
        subjectId: "p2",
        targetId: "p2",
        messageId: "msg-reputation-linked",
        messageSeq: 4,
        channelId: "table",
        visibility: "public"
      }
    }, { traceId: "trace-reputation-linked", turnIndex: 2, phase: "day_speech", day: 1 });

    social.journal!.entries.push({
      journalSeq: social.journal!.nextSeq++,
      agentId: "p1",
      profileId: "profile-p1",
      traceId: "trace-hidden-commit-missing",
      turnIndex: 2,
      phase: "postgame",
      day: 1,
      store: "commitments",
      mutationKind: "commitment.added",
      subjectId: "commit-missing",
      evidenceRefs: [{ artifact: "message", id: "msg-commit-missing", seq: 5 }],
      messageSeqRange: { start: 5, end: 5 },
      redactionClass: "agent_private_summary",
      hiddenTruthUsed: true,
      createdAt: new Date(0).toISOString(),
      metadata: {
        messageId: "msg-commit-missing",
        messageSeq: 5,
        speechActId: "act-commit-missing",
        speechActKind: "commitment",
        speechActIndex: 0
      }
    } as never);
    social.journal!.entries.push({
      journalSeq: social.journal!.nextSeq++,
      agentId: "p2",
      profileId: "profile-p2",
      traceId: "trace-cross-agent-coalition-missing",
      turnIndex: 2,
      phase: "day_speech",
      day: 1,
      store: "coalitions",
      mutationKind: "coalition.added",
      subjectId: "coalition-missing",
      evidenceRefs: [{ artifact: "message", id: "msg-coalition-missing", seq: 6 }],
      messageSeqRange: { start: 6, end: 6 },
      redactionClass: "agent_private_summary",
      hiddenTruthUsed: false,
      createdAt: new Date(0).toISOString(),
      metadata: {
        observerId: "p2",
        messageId: "msg-coalition-missing",
        messageSeq: 6,
        speechActId: "act-coalition-missing",
        speechActKind: "coalition_signal",
        speechActIndex: 0
      }
    } as never);
    social.journal!.entries.push({
      journalSeq: social.journal!.nextSeq++,
      agentId: "p1",
      profileId: "profile-p1",
      traceId: "trace-missing-hidden-flag-coalition",
      turnIndex: 2,
      phase: "day_speech",
      day: 1,
      store: "coalitions",
      mutationKind: "coalition.added",
      subjectId: "coalition-missing",
      evidenceRefs: [{ artifact: "message", id: "msg-coalition-missing", seq: 6 }],
      messageSeqRange: { start: 6, end: 6 },
      redactionClass: "agent_private_summary",
      createdAt: new Date(0).toISOString(),
      metadata: {
        observerId: "p1",
        messageId: "msg-coalition-missing",
        messageSeq: 6,
        speechActId: "act-coalition-missing",
        speechActKind: "coalition_signal",
        speechActIndex: 0
      }
    } as never);
    social.journal!.entries.push({
      journalSeq: social.journal!.nextSeq++,
      agentId: "p1",
      profileId: "profile-p1",
      traceId: "trace-broad-range-coalition",
      turnIndex: 2,
      phase: "day_speech",
      day: 1,
      store: "coalitions",
      mutationKind: "coalition.added",
      subjectId: "coalition-missing",
      evidenceRefs: [{ artifact: "message", id: "msg-coalition-linked", seq: 2 }],
      messageSeqRange: { start: 1, end: 10 },
      redactionClass: "agent_private_summary",
      hiddenTruthUsed: false,
      createdAt: new Date(0).toISOString(),
      metadata: {
        observerId: "p1",
        speechActId: "act-coalition-missing",
        speechActKind: "coalition_signal",
        speechActIndex: 0
      }
    } as never);

    const derivedExposure = deriveSocialExposureRecords(socialEpisode);
    expect(derivedExposure.map((record) => [record.messageId, record.sourceId, record.observerId])).toEqual([
      ["msg-commit-linked", "p2", "p1"],
      ["msg-coalition-linked", "p2", "p1"],
      ["msg-relationship-linked", "p2", "p1"],
      ["msg-reputation-linked", "p2", "p1"],
      ["msg-commit-missing", "p2", "p1"],
      ["msg-coalition-missing", "p2", "p1"],
      ["msg-free-text-only", "p2", "p1"],
      ["msg-metadata-derived", "p2", "p1"],
      ["msg-malformed-speech-acts", "p2", "p1"]
    ]);
    expect(derivedExposure.some((record) => record.messageId === "msg-unobserved-relationship")).toBe(false);

    const agents: AgentHarnessState[] = [
      {
        playerId: "p1",
        profileId: "profile-p1",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-social-fact-ingest",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "social-fact-ingest-evidence-eval",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "social-fact-ingest-evidence-eval",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: [],
        socialEpisode
      },
      evaluators: [createSocialFactIngestEvidenceEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect([...new Set(report.metrics.map((item) => item.id))].sort()).toEqual([...SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS].sort());
    expect(report.metrics.every((item) => item.source === SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.evaluatorId === SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID)).toBe(true);
    expect(report.metrics.every((item) => item.evaluatorVersion === "1.0.0")).toBe(true);
    expect(report.metrics.every((item) => item.weight === 0)).toBe(true);
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
      label: "Social fact ingest evidence evaluator",
      version: "1.0.0",
      inputSchema: "harness.social-fact-ingest-evidence.evaluation-context.v1",
      outputSchema: "harness.social-fact-ingest-evidence.summary.v1",
      mode: "deterministic",
      metricIds: SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS,
      dependencies: {
        socialEpisode: "SocialEpisodeArtifact.messages and scoped SocialExposureRecord records from actor observations",
        mutationJournal:
          "AgentSocialState.journal.entries with store/mutationKind, messageSeqRange, safe provenance metadata, hiddenTruthUsed=false, and evidenceRefs",
        socialState: "AgentSocialState commitments, coalitions, relationships, and reputation records for mutation evidence"
      },
      aggregation: "zero_weight_social_fact_ingest_evidence_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("does not parse free text");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("does not");
    expect(report.outputs[SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID]).toMatchObject({
      agentCount: 1,
      agentsWithSocialState: 1,
      agentsWithJournal: 1,
      agentsWithExposureRecords: 1,
      exposureRecords: 9,
      commitmentSpeechActCandidates: 2,
      commitmentSpeechActLinkedCandidates: 1,
      commitmentSpeechActMissingMutationCandidates: 1,
      coalitionSpeechActCandidates: 2,
      coalitionSpeechActLinkedCandidates: 1,
      coalitionSpeechActMissingMutationCandidates: 1,
      relationshipFactCandidates: 1,
      relationshipFactLinkedCandidates: 1,
      relationshipFactMissingMutationCandidates: 0,
      reputationFactCandidates: 1,
      reputationFactLinkedCandidates: 1,
      reputationFactMissingMutationCandidates: 0
    });

    const commitmentCount = report.metrics.find((item) => item.id === "agent.social.commitment_speech_act_ingest_link_count");
    expect(commitmentCount).toMatchObject({
      value: 1,
      denominator: 2,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-commit-linked", seq: 1 }),
        expect.objectContaining({ artifact: "trace", traceId: "trace-p1-social-fact-exposure", seq: 2 }),
        expect.objectContaining({ artifact: "agent_state", id: "p1", description: "socialStateHash:hash-social-fact-ingest" })
      ]),
      metadata: expect.objectContaining({
        candidateKind: "commitment",
        commitmentSpeechActCandidates: 2,
        linkedCandidates: 1,
        missingMutationCandidates: 1,
        coverageLevel: "explicit_scoped_exposure_to_social_state_mutation",
        causalClaim: false,
        socialStateHash: "hash-social-fact-ingest"
      })
    });
    expect(commitmentCount?.metadata?.sampleLinkedCandidates).toEqual([
      {
        kind: "commitment",
        recordId: "commit-linked",
        messageId: "msg-commit-linked",
        messageSeq: 1,
        speechActId: "act-commit-linked",
        speechActKind: "commitment",
        factKind: undefined,
        factIndex: undefined
      }
    ]);
    expect(commitmentCount?.metadata?.sampleMissingMutationCandidates).toEqual([
      {
        kind: "commitment",
        recordId: "commit-missing",
        messageId: "msg-commit-missing",
        messageSeq: 5,
        speechActId: "act-commit-missing",
        speechActKind: "commitment",
        factKind: undefined,
        factIndex: undefined
      }
    ]);
    expect(report.metrics.find((item) => item.id === "agent.social.commitment_speech_act_ingest_link_rate")).toMatchObject({
      value: 0.5,
      denominator: 2,
      confidence: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.social.coalition_speech_act_ingest_link_count")).toMatchObject({
      value: 1,
      denominator: 2,
      aggregation: "sum",
      metadata: expect.objectContaining({
        candidateKind: "coalition",
        coalitionSpeechActCandidates: 2,
        linkedCandidates: 1,
        missingMutationCandidates: 1
      })
    });
    const coalitionCount = report.metrics.find((item) => item.id === "agent.social.coalition_speech_act_ingest_link_count");
    expect(coalitionCount?.metadata?.sampleMissingMutationCandidates).toEqual([
      {
        kind: "coalition",
        recordId: "coalition-missing",
        messageId: "msg-coalition-missing",
        messageSeq: 6,
        speechActId: "act-coalition-missing",
        speechActKind: "coalition_signal",
        factKind: undefined,
        factIndex: undefined
      }
    ]);
    expect(report.metrics.find((item) => item.id === "agent.social.relationship_fact_ingest_link_count")).toMatchObject({
      value: 1,
      denominator: 1,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "message", id: "msg-relationship-linked", seq: 3 })]),
      metadata: expect.objectContaining({
        candidateKind: "relationship",
        relationshipFactCandidates: 1,
        linkedCandidates: 1,
        missingMutationCandidates: 0
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.reputation_fact_ingest_link_count")).toMatchObject({
      value: 1,
      denominator: 1,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "message", id: "msg-reputation-linked", seq: 4 })]),
      metadata: expect.objectContaining({
        candidateKind: "reputation",
        reputationFactCandidates: 1,
        linkedCandidates: 1,
        missingMutationCandidates: 0
      })
    });
    const registryWithoutRubric = report.evaluatorRegistry?.map(({ rubric, ...entry }) => entry);
    expect(JSON.stringify({ metrics: report.metrics, outputs: report.outputs, registry: registryWithoutRubric })).not.toMatch(
      /msg-free-text-only|msg-metadata-derived|msg-malformed-speech-acts|msg-unobserved-relationship|commit-derived|commit-malformed|causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|deception\s+success|persuasion\s+success|caused by/i
    );
  });
});

describe("social dynamics evaluator", () => {
  it("turns scoped message exposure artifacts into evidence-backed agent metrics", () => {
    const messages: SocialMessage[] = [
      {
        id: "msg-1",
        seq: 1,
        channelId: "table",
        senderId: "p1",
        recipientIds: ["p2", "p3"],
        visibility: "public",
        content: "p1 made a public claim.",
        createdAt: new Date(1000).toISOString(),
        metadata: { kind: "speech" }
      },
      {
        id: "msg-2",
        seq: 2,
        channelId: "dm-p2-p3",
        senderId: "p2",
        recipientIds: ["p3"],
        visibility: "private",
        content: "p2 privately coordinated with p3.",
        createdAt: new Date(2000).toISOString(),
        metadata: { kind: "private_note" }
      },
      {
        id: "msg-3",
        seq: 3,
        channelId: "table",
        senderId: "p1",
        recipientIds: ["p2", "p3"],
        visibility: "public",
        content: "This committed message was not present in a later scoped observation.",
        createdAt: new Date(3000).toISOString(),
        metadata: { kind: "speech" }
      }
    ];
    const socialEpisode = {
      steps: [
        {
          traceId: "trace-p2",
          turnIndex: 1,
          actorId: "p2",
          profileId: "profile-p2",
          schedulerMode: "aec",
          pendingAction: { actorId: "p2", kind: "vote" },
          observation: {
            agentId: "p2",
            visibleMessages: [messages[0]]
          },
          action: { actorId: "p2", kind: "vote", command: { type: "vote" } }
        },
        {
          traceId: "trace-p3",
          turnIndex: 2,
          actorId: "p3",
          profileId: "profile-p3",
          schedulerMode: "aec",
          pendingAction: { actorId: "p3", kind: "vote" },
          observation: {
            agentId: "p3",
            visibleMessages: [messages[0], messages[1]]
          },
          action: { actorId: "p3", kind: "vote", command: { type: "vote" } }
        }
      ],
      messages
    } as unknown as SocialEpisodeArtifact;
    const agents: AgentHarnessState[] = ["p1", "p2", "p3"].map((playerId) => ({
      playerId,
      model: "deterministic-test-model",
      temperature: 0,
      policyName: "balanced",
      turns: 0,
      observations: 0,
      beliefs: {},
      privateMemos: [],
      socialStateHash: `hash-${playerId}`
    }));

    const report = runEvaluationRegistry({
      id: "social-exposure-evaluator",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "social-exposure-evaluator",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: [],
        socialEpisode
      },
      evaluators: [createSocialDynamicsEvaluator()]
    });

    expect(deriveSocialExposureRecords(socialEpisode).map((record) => [record.messageId, record.sourceId, record.observerId])).toEqual([
      ["msg-1", "p1", "p2"],
      ["msg-1", "p1", "p3"],
      ["msg-2", "p2", "p3"]
    ]);
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: SOCIAL_DYNAMICS_EVALUATOR_ID,
      metricIds: SOCIAL_DYNAMICS_METRIC_IDS
    });
    expect(report.outputs[SOCIAL_DYNAMICS_EVALUATOR_ID]).toMatchObject({
      exposureRecords: 3,
      publicExposureRecords: 2
    });

    const exposureByAgent = report.metrics.filter((item) => item.id === "agent.social.exposure_received_count");
    expect(exposureByAgent).toHaveLength(3);
    expect(exposureByAgent.find((item) => item.subjectId === "p1")).toMatchObject({
      value: 0,
      denominator: 3,
      evidenceRefs: [expect.objectContaining({ artifact: "agent_state", id: "p1" })]
    });
    expect(exposureByAgent.find((item) => item.subjectId === "p2")).toMatchObject({
      value: 1,
      denominator: 3,
      subject: {
        actorId: "p2",
        playerId: "p2",
        policyId: "balanced",
        policyName: "balanced"
      },
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-1", seq: 1 }),
        expect.objectContaining({ artifact: "trace", traceId: "trace-p2", seq: 1 }),
        expect.objectContaining({ artifact: "observation", traceId: "trace-p2", description: expect.stringContaining("observation") })
      ]),
      metadata: expect.objectContaining({
        exposureRecords: 1,
        publicExposureRecords: 1,
        sourceIds: ["p1"],
        messageIds: ["msg-1"],
        messageSeqs: [1],
        visibilityCounts: { public: 1 }
      })
    });
    expect(exposureByAgent.find((item) => item.subjectId === "p3")).toMatchObject({
      value: 2,
      denominator: 3,
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-1", seq: 1 }),
        expect.objectContaining({ artifact: "message", id: "msg-2", seq: 2 }),
        expect.objectContaining({ artifact: "observation", traceId: "trace-p3", description: expect.stringContaining("observation") })
      ]),
      metadata: expect.objectContaining({
        exposureRecords: 2,
        publicExposureRecords: 1,
        sourceIds: ["p1", "p2"],
        messageIds: ["msg-1", "msg-2"],
        visibilityCounts: { public: 1, private: 1 }
      })
    });

    expect(report.metrics.find((item) => item.id === "agent.social.public_exposure_received_count" && item.subjectId === "p3")).toMatchObject({
      value: 1,
      denominator: 2,
      metadata: expect.objectContaining({ publicMessageSeqs: [1] })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.unique_exposure_source_count" && item.subjectId === "p3")).toMatchObject({
      value: 2,
      denominator: 2
    });
    expect(report.metrics.some((item) => item.evidenceRefs?.some((ref) => ref.artifact === "message" && ref.id === "msg-3"))).toBe(false);
  });
});

describe("werewolf deception evaluator", () => {
  it("audits false public role claims with speech event and postgame truth evidence", () => {
    let state = createGame({ id: "deception-role-claim", seed: "deception-role-claim" });
    state = advanceSystem(state);
    const seerInspect = pendingByKind(state, "inspect")[0];
    state = applyCommand(state, { type: "seer.inspect", actorId: seerInspect.actorId, targetId: seerInspect.legalTargetIds[0] });
    for (const kill of pendingByKind(state, "kill")) {
      state = applyCommand(state, { type: "werewolf.killVote", actorId: kill.actorId, targetId: kill.legalTargetIds[0] });
    }
    const witchAction = pendingByKind(state, "witch")[0];
    state = applyCommand(state, { type: "witch.act", actorId: witchAction.actorId, saveTargetId: witchAction.nightVictimId });
    expect(state.phase).toBe("day_speech");

    const speech = pendingByKind(state, "speech")[0];
    const speaker = state.players.find((player) => player.id === speech.actorId);
    expect(speaker).toBeDefined();
    const falseClaim = speaker!.role === "seer" ? "witch" : "seer";
    state = applyCommand(state, {
      type: "speech.submit",
      actorId: speech.actorId,
      text: `我是${falseClaim}，这个公开身份声明会在赛后被校验。`,
      claimedRole: falseClaim,
      strategyTags: ["role-claim"]
    });
    const truthfulSpeech = pendingByKind(state, "speech")[0];
    const truthfulSpeaker = state.players.find((player) => player.id === truthfulSpeech.actorId);
    expect(truthfulSpeaker).toBeDefined();
    state = applyCommand(state, {
      type: "speech.submit",
      actorId: truthfulSpeech.actorId,
      text: `我是${truthfulSpeaker!.role}，这个公开身份声明应当和赛后身份一致。`,
      claimedRole: truthfulSpeaker!.role,
      strategyTags: ["role-claim"]
    });

    const report = runEvaluationRegistry({
      id: "deception-role-claim:evaluation",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "deception-role-claim",
        status: "completed",
        initialState: state,
        finalState: state,
        agents: state.players.map((player): AgentHarnessState => ({
          playerId: player.id,
          model: "deterministic-test-model",
          temperature: 0,
          policyName: "balanced",
          turns: 0,
          observations: 0,
          beliefs: {},
          privateMemos: []
        })),
        trajectory: []
      },
      evaluators: [createWerewolfDeceptionEvaluator()]
    });

    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: WEREWOLF_DECEPTION_EVALUATOR_ID,
      metricIds: WEREWOLF_DECEPTION_METRIC_IDS
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_count" && item.subjectId === speech.actorId)).toMatchObject({
      evaluatorId: WEREWOLF_DECEPTION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      value: 1,
      denominator: 1,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "event", description: "speech.submitted" }),
        expect.objectContaining({ artifact: "state", description: `postgame role truth for ${speech.actorId}` })
      ]),
      metadata: expect.objectContaining({
        actualRole: speaker!.role,
        claims: 1,
        truthfulClaims: 0,
        falseClaims: 1,
        claimedRoles: [falseClaim],
        falseClaimedRoles: [falseClaim]
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_rate" && item.subjectId === speech.actorId)).toMatchObject({
      value: 1,
      denominator: 1,
      aggregation: "ratio",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "event", description: "speech.submitted" }),
        expect.objectContaining({ artifact: "state", description: `postgame role truth for ${speech.actorId}` })
      ])
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_count" && item.subjectId === truthfulSpeech.actorId)).toMatchObject({
      value: 0,
      denominator: 1,
      aggregation: "sum",
      metadata: expect.objectContaining({
        actualRole: truthfulSpeaker!.role,
        claims: 1,
        truthfulClaims: 1,
        falseClaims: 0,
        claimedRoles: [truthfulSpeaker!.role],
        falseClaimedRoles: []
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_rate" && item.subjectId === truthfulSpeech.actorId)).toMatchObject({
      value: 0,
      denominator: 1,
      aggregation: "ratio",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "event", description: "speech.submitted" }),
        expect.objectContaining({ artifact: "state", description: `postgame role truth for ${truthfulSpeech.actorId}` })
      ])
    });
  });

  it("counts false role claim exposure from scoped social observations instead of global transcript", () => {
    const state = createGame({ id: "deception-role-claim-exposure", seed: "deception-role-claim-exposure" });
    const [speaker, observerOne, observerTwo, secondSpeaker] = state.players;
    const speakerFalseClaim = differentRole(speaker.role);
    const secondSpeakerFalseClaim = differentRole(secondSpeaker.role);
    const publicRecipients = (senderId: string) => state.players.filter((player) => player.id !== senderId).map((player) => player.id);
    const messages: SocialMessage[] = [
      {
        id: "msg-1",
        seq: 1,
        channelId: "table",
        senderId: speaker.id,
        recipientIds: publicRecipients(speaker.id),
        visibility: "public",
        content: `${speaker.id} falsely claims ${speakerFalseClaim}.`,
        createdAt: new Date(1000).toISOString(),
        speechActs: [
          {
            id: "msg-1-role-claim",
            kind: "role_claim",
            subjectId: speaker.id,
            value: speakerFalseClaim,
            confidence: 1,
            evidenceRefs: [{ artifact: "message", id: "msg-1", seq: 1 }]
          }
        ],
        metadata: { kind: "public-speech", claimedRole: speaker.role }
      },
      {
        id: "msg-2",
        seq: 2,
        channelId: "table",
        senderId: speaker.id,
        recipientIds: publicRecipients(speaker.id),
        visibility: "public",
        content: `${speaker.id} makes an unobserved false claim.`,
        createdAt: new Date(2000).toISOString(),
        metadata: { kind: "public-speech", claimedRole: speakerFalseClaim }
      },
      {
        id: "msg-3",
        seq: 3,
        channelId: "table",
        senderId: observerOne.id,
        recipientIds: publicRecipients(observerOne.id),
        visibility: "public",
        content: `${observerOne.id} truthfully claims ${observerOne.role}.`,
        createdAt: new Date(3000).toISOString(),
        speechActs: [
          {
            id: "msg-3-role-claim",
            kind: "role_claim",
            subjectId: observerOne.id,
            value: observerOne.role,
            confidence: 1,
            evidenceRefs: [{ artifact: "message", id: "msg-3", seq: 3 }]
          }
        ],
        metadata: { kind: "public-speech", claimedRole: differentRole(observerOne.role) }
      },
      {
        id: "msg-4",
        seq: 4,
        channelId: "table",
        senderId: secondSpeaker.id,
        recipientIds: publicRecipients(secondSpeaker.id),
        visibility: "public",
        content: `${secondSpeaker.id} falsely claims ${secondSpeakerFalseClaim}.`,
        createdAt: new Date(4000).toISOString(),
        speechActs: [
          {
            id: "msg-4-role-claim",
            kind: "role_claim",
            subjectId: secondSpeaker.id,
            value: secondSpeakerFalseClaim,
            confidence: 1,
            evidenceRefs: [{ artifact: "message", id: "msg-4", seq: 4 }]
          }
        ],
        metadata: { kind: "typed-speech-act" }
      }
    ];
    const socialEpisode = {
      steps: [
        {
          traceId: "trace-self-speaker",
          turnIndex: 1,
          actorId: speaker.id,
          profileId: `profile-${speaker.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: speaker.id, kind: "vote" },
          observation: {
            agentId: speaker.id,
            visibleMessages: [messages[0]]
          },
          action: { actorId: speaker.id, kind: "vote.cast", command: { type: "vote.cast", actorId: speaker.id, abstain: true } }
        },
        {
          traceId: "trace-observer-one",
          turnIndex: 2,
          actorId: observerOne.id,
          profileId: `profile-${observerOne.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: observerOne.id, kind: "vote" },
          observation: {
            agentId: observerOne.id,
            visibleMessages: [messages[0]]
          },
          action: { actorId: observerOne.id, kind: "vote.cast", command: { type: "vote.cast", actorId: observerOne.id, abstain: true } }
        },
        {
          traceId: "trace-observer-two",
          turnIndex: 3,
          actorId: observerTwo.id,
          profileId: `profile-${observerTwo.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: observerTwo.id, kind: "vote" },
          observation: {
            agentId: observerTwo.id,
            visibleMessages: [messages[0], messages[2], messages[3]]
          },
          action: { actorId: observerTwo.id, kind: "vote.cast", command: { type: "vote.cast", actorId: observerTwo.id, abstain: true } }
        }
      ],
      messages
    } as unknown as SocialEpisodeArtifact;
    const agents: AgentHarnessState[] = state.players.map((player) => ({
      playerId: player.id,
      model: "deterministic-test-model",
      temperature: 0,
      policyName: "balanced",
      turns: 0,
      observations: 0,
      beliefs: {},
      privateMemos: []
    }));

    const report = runEvaluationRegistry({
      id: "deception-role-claim-exposure:evaluation",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "deception-role-claim-exposure",
        status: "completed",
        initialState: state,
        finalState: state,
        agents,
        trajectory: [],
        socialEpisode
      },
      evaluators: [createWerewolfDeceptionEvaluator()]
    });

    expect(deriveSocialExposureRecords(socialEpisode).map((record) => [record.messageId, record.sourceId, record.observerId])).toEqual([
      ["msg-1", speaker.id, observerOne.id],
      ["msg-1", speaker.id, observerTwo.id],
      ["msg-3", observerOne.id, observerTwo.id],
      ["msg-4", secondSpeaker.id, observerTwo.id]
    ]);
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: WEREWOLF_DECEPTION_EVALUATOR_ID,
      metricIds: WEREWOLF_DECEPTION_METRIC_IDS
    });

    const exposureMetrics = report.metrics.filter((item) => item.id === "agent.false_role_claim_exposure_received_count");
    expect(exposureMetrics).toHaveLength(state.players.length);
    expect(exposureMetrics.find((item) => item.subjectId === speaker.id)).toMatchObject({
      value: 0,
      denominator: 3,
      evidenceRefs: [expect.objectContaining({ artifact: "state", description: `false role claim exposure records for ${speaker.id}` })],
      metadata: expect.objectContaining({
        exposureRecords: 0,
        falseRoleClaimMessages: 3,
        observedFalseRoleClaimMessages: 2,
        totalFalseRoleClaimExposureRecords: 3
      })
    });
    expect(exposureMetrics.find((item) => item.subjectId === observerOne.id)).toMatchObject({
      value: 1,
      denominator: 3,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-1", seq: 1 }),
        expect.objectContaining({ artifact: "trace", traceId: "trace-observer-one", seq: 2 }),
        expect.objectContaining({ artifact: "observation", traceId: "trace-observer-one", description: expect.stringContaining("observation") }),
        expect.objectContaining({ artifact: "state", description: `postgame role truth for ${speaker.id}` })
      ]),
      metadata: expect.objectContaining({
        exposureRecords: 1,
        falseRoleClaimExposureRecords: 1,
        sourceIds: [speaker.id],
        messageIds: ["msg-1"],
        messageSeqs: [1],
        claimedRoles: [speakerFalseClaim],
        actualRoles: [speaker.role],
        speechActIds: ["msg-1-role-claim"],
        claimSources: ["speech_act"],
        observedAtTraceIds: ["trace-observer-one"]
      })
    });
    expect(exposureMetrics.find((item) => item.subjectId === observerTwo.id)).toMatchObject({
      value: 2,
      denominator: 3,
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-1", seq: 1 }),
        expect.objectContaining({ artifact: "message", id: "msg-4", seq: 4 }),
        expect.objectContaining({ artifact: "observation", traceId: "trace-observer-two", description: expect.stringContaining("observation") }),
        expect.objectContaining({ artifact: "state", description: `postgame role truth for ${speaker.id}` }),
        expect.objectContaining({ artifact: "state", description: `postgame role truth for ${secondSpeaker.id}` })
      ]),
      metadata: expect.objectContaining({
        exposureRecords: 2,
        sourceIds: [speaker.id, secondSpeaker.id],
        messageIds: ["msg-1", "msg-4"],
        claimedRoles: [speakerFalseClaim, secondSpeakerFalseClaim],
        actualRoles: [speaker.role, secondSpeaker.role],
        speechActIds: ["msg-1-role-claim", "msg-4-role-claim"],
        claimSources: ["speech_act"],
        observedAtTraceIds: ["trace-observer-two"]
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_unique_speaker_count" && item.subjectId === observerTwo.id)).toMatchObject({
      value: 2,
      denominator: 2,
      metadata: expect.objectContaining({
        falseRoleClaimSpeakers: 2
      })
    });
    expect(
      report.metrics.some(
        (item) =>
          (item.id === "agent.false_role_claim_exposure_received_count" || item.id === "agent.false_role_claim_unique_speaker_count") &&
          item.evidenceRefs?.some((ref) => ref.artifact === "message" && (ref.id === "msg-2" || ref.id === "msg-3"))
      )
    ).toBe(false);
  });

  it("links observed false role claims to later belief journal shifts as temporal association", () => {
    const state = createGame({ id: "deception-role-claim-journal-link", seed: "deception-role-claim-journal-link" });
    const [speaker, observer, unexposedObserver, unrelatedTarget, ambiguousObserver] = state.players;
    const speakerFalseClaim = differentRole(speaker.role);
    const publicRecipients = (senderId: string) => state.players.filter((player) => player.id !== senderId).map((player) => player.id);
    const messages: SocialMessage[] = [
      {
        id: "msg-journal-false-observed",
        seq: 1,
        channelId: "table",
        senderId: speaker.id,
        recipientIds: publicRecipients(speaker.id),
        visibility: "public",
        content: `${speaker.id} falsely claims ${speakerFalseClaim}.`,
        createdAt: new Date(1000).toISOString(),
        speechActs: [
          {
            id: "msg-journal-false-observed-role-claim",
            kind: "role_claim",
            subjectId: speaker.id,
            value: speakerFalseClaim,
            confidence: 1,
            evidenceRefs: [{ artifact: "message", id: "msg-journal-false-observed", seq: 1 }]
          }
        ],
        metadata: { kind: "public-speech", claimedRole: speaker.role }
      },
      {
        id: "msg-journal-false-unobserved",
        seq: 2,
        channelId: "table",
        senderId: speaker.id,
        recipientIds: publicRecipients(speaker.id),
        visibility: "public",
        content: `${speaker.id} repeats an unobserved false claim.`,
        createdAt: new Date(2000).toISOString(),
        metadata: { kind: "public-speech", claimedRole: speakerFalseClaim }
      },
      {
        id: "msg-journal-truthful-observed",
        seq: 3,
        channelId: "table",
        senderId: unrelatedTarget.id,
        recipientIds: publicRecipients(unrelatedTarget.id),
        visibility: "public",
        content: `${unrelatedTarget.id} truthfully claims ${unrelatedTarget.role}.`,
        createdAt: new Date(3000).toISOString(),
        metadata: { kind: "public-speech", claimedRole: unrelatedTarget.role }
      }
    ];
    const socialEpisode = {
      steps: [
        {
          traceId: "trace-journal-observer",
          turnIndex: 2,
          actorId: observer.id,
          profileId: `profile-${observer.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: observer.id, kind: "vote" },
          observation: {
            agentId: observer.id,
            visibleMessages: [messages[0], messages[2]]
          },
          action: { actorId: observer.id, kind: "vote.cast", command: { type: "vote.cast", actorId: observer.id, abstain: true } }
        },
        {
          traceId: "trace-journal-unexposed",
          turnIndex: 3,
          actorId: unexposedObserver.id,
          profileId: `profile-${unexposedObserver.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: unexposedObserver.id, kind: "vote" },
          observation: {
            agentId: unexposedObserver.id,
            visibleMessages: [messages[2]]
          },
          action: { actorId: unexposedObserver.id, kind: "vote.cast", command: { type: "vote.cast", actorId: unexposedObserver.id, abstain: true } }
        },
        {
          traceId: "trace-journal-ambiguous",
          turnIndex: 4,
          actorId: ambiguousObserver.id,
          profileId: `profile-${ambiguousObserver.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: ambiguousObserver.id, kind: "vote" },
          observation: {
            agentId: ambiguousObserver.id,
            visibleMessages: [messages[0]]
          },
          action: { actorId: ambiguousObserver.id, kind: "vote.cast", command: { type: "vote.cast", actorId: ambiguousObserver.id, abstain: true } }
        }
      ],
      messages
    } as unknown as SocialEpisodeArtifact;

    const observerSocial = createAgentSocialState({
      agentId: observer.id,
      profile: { id: `profile-${observer.id}`, model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    upsertSocialBelief(observerSocial, {
      subject: speaker.id,
      predicate: "claimedRole",
      value: speakerFalseClaim,
      confidence: 0.2,
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-same-turn-ingestion", turnIndex: 2, phase: "day_speech", day: 1 });
    upsertSocialBelief(observerSocial, {
      subject: speaker.id,
      predicate: "claimedRole",
      value: speakerFalseClaim,
      confidence: 0.9,
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-after-exposure-belief", turnIndex: 3, phase: "day_speech", day: 1 });
    updateSocialReputation(observerSocial, {
      subjectId: speaker.id,
      deltas: { honesty: -0.4, threat: 0.3 },
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-after-exposure-reputation", turnIndex: 4, phase: "day_vote", day: 1 });
    updateSocialReputation(observerSocial, {
      subjectId: unrelatedTarget.id,
      deltas: { honesty: -0.5 },
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-unrelated-subject", turnIndex: 5, phase: "day_vote", day: 1 });

    const unexposedSocial = createAgentSocialState({
      agentId: unexposedObserver.id,
      profile: { id: `profile-${unexposedObserver.id}`, model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    upsertSocialBelief(unexposedSocial, {
      subject: speaker.id,
      predicate: "claimedRole",
      value: speakerFalseClaim,
      confidence: 1,
      evidenceRefs: [{ artifact: "message", id: messages[1].id, seq: messages[1].seq }]
    }, { traceId: "trace-unobserved-message-belief", turnIndex: 4, phase: "day_vote", day: 1 });
    updateSocialReputation(unexposedSocial, {
      subjectId: speaker.id,
      deltas: { honesty: -0.8 },
      evidenceRefs: [{ artifact: "message", id: messages[1].id, seq: messages[1].seq }]
    }, { traceId: "trace-unobserved-message-reputation", turnIndex: 5, phase: "day_vote", day: 1 });

    const ambiguousSocial = createAgentSocialState({
      agentId: ambiguousObserver.id,
      profile: { id: `profile-${ambiguousObserver.id}`, model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    upsertSocialBelief(ambiguousSocial, {
      subject: speaker.id,
      predicate: "claimedRole",
      value: speakerFalseClaim,
      confidence: 0.2,
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-ambiguous-ingestion", turnIndex: 4, phase: "day_speech", day: 1 });
    upsertSocialBelief(ambiguousSocial, {
      subject: speaker.id,
      predicate: "claimedRole",
      value: speakerFalseClaim,
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-ambiguous-ordered-shift", turnIndex: 5, phase: "day_vote", day: 1 });
    upsertSocialBelief(ambiguousSocial, {
      subject: speaker.id,
      predicate: "claimedRole",
      value: speakerFalseClaim,
      confidence: 0.9,
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-ambiguous-unordered-shift", turnIndex: 6, phase: "day_vote", day: 1 });
    const unorderedJournalEntry = ambiguousSocial.journal?.entries[ambiguousSocial.journal.entries.length - 1];
    expect(unorderedJournalEntry).toBeDefined();
    delete unorderedJournalEntry!.turnIndex;

    const agents: AgentHarnessState[] = state.players.map((player) => ({
      playerId: player.id,
      profileId: `profile-${player.id}`,
      model: "deterministic-test-model",
      temperature: 0,
      policyName: "balanced",
      turns: 0,
      observations: 0,
      beliefs: {},
      privateMemos: [],
      socialStateHash:
        player.id === observer.id
          ? "observer-social-hash"
          : player.id === unexposedObserver.id
            ? "unexposed-social-hash"
            : player.id === ambiguousObserver.id
              ? "ambiguous-social-hash"
              : undefined,
      social:
        player.id === observer.id
          ? observerSocial
          : player.id === unexposedObserver.id
            ? unexposedSocial
            : player.id === ambiguousObserver.id
              ? ambiguousSocial
              : undefined
    }));

    const report = runEvaluationRegistry({
      id: "deception-role-claim-journal-link:evaluation",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "deception-role-claim-journal-link",
        status: "completed",
        initialState: state,
        finalState: state,
        agents,
        trajectory: [],
        socialEpisode
      },
      evaluators: [createDeceptionBeliefShiftEvaluator()]
    });

    expect(deriveSocialExposureRecords(socialEpisode).map((record) => [record.messageId, record.sourceId, record.observerId])).toEqual([
      [messages[0].id, speaker.id, observer.id],
      [messages[2].id, unrelatedTarget.id, observer.id],
      [messages[2].id, unrelatedTarget.id, unexposedObserver.id],
      [messages[0].id, speaker.id, ambiguousObserver.id]
    ]);

    const observerBeliefCount = report.metrics.find(
      (item) => item.id === "agent.false_role_claim_belief_temporal_association_count" && item.subjectId === observer.id
    );
    expect(observerBeliefCount).toMatchObject({
      evaluatorId: DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      value: 1,
      denominator: 1,
      weight: 0,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: messages[0].id, seq: 1 }),
        expect.objectContaining({ artifact: "trace", traceId: "trace-journal-observer" }),
        expect.objectContaining({ artifact: "trace", traceId: "trace-after-exposure-belief" }),
        expect.objectContaining({ artifact: "agent_state", id: observer.id, description: "socialStateHash:observer-social-hash" }),
        expect.objectContaining({ artifact: "state", description: `postgame role truth for ${speaker.id}` })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        causalClaim: false,
        falseRoleClaimExposureCount: 1,
        evaluableFalseClaimExposureCount: 1,
        associatedExposureCount: 1,
        associatedMutationCount: 1,
        formationOnlyCount: 1,
        noLaterMutationCount: 0,
        hiddenTruthUsedInLiveStore: false,
        postgameTruthUsedForFalseClaimClassification: true,
        truthAccessMode: "postgame_role_truth_for_false_claim_classification_only",
        stores: ["beliefs"],
        mutationKinds: ["belief.upserted"],
        predicates: ["claimedRole"],
        messageIds: [messages[0].id],
        sourceIds: [speaker.id],
        observedAtTraceIds: ["trace-journal-observer"],
        claimFacts: [
          expect.objectContaining({
            messageId: messages[0].id,
            claimSource: "speech_act",
            speechActId: "msg-journal-false-observed-role-claim",
            speechActKind: "role_claim"
          })
        ]
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_belief_temporal_association_rate" && item.subjectId === observer.id)).toMatchObject({
      value: 1,
      denominator: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_belief_temporal_evaluable_exposure_rate" && item.subjectId === observer.id)).toMatchObject({
      value: 1,
      denominator: 1,
      aggregation: "coverage_ratio",
      metadata: expect.objectContaining({
        falseRoleClaimExposureCount: 1,
        evaluableFalseClaimExposureCount: 1,
        associatedMutationCount: 1
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_belief_temporal_association_count" && item.subjectId === unexposedObserver.id)).toMatchObject({
      value: 0,
      denominator: 0
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_belief_temporal_association_count" && item.subjectId === ambiguousObserver.id)).toMatchObject({
      value: 0,
      denominator: 0,
      metadata: expect.objectContaining({
        falseRoleClaimExposureCount: 1,
        evaluableFalseClaimExposureCount: 0,
        associatedExposureCount: 0,
        associatedMutationCount: 0,
        ambiguousOrderingExposureCount: 1,
        noLaterMutationCount: 0
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_belief_temporal_evaluable_exposure_rate" && item.subjectId === ambiguousObserver.id)).toMatchObject({
      value: 0,
      denominator: 1,
      aggregation: "coverage_ratio"
    });
    expect([...new Set(report.metrics.map((item) => item.id))].sort()).toEqual([...DECEPTION_BELIEF_SHIFT_METRIC_IDS].sort());
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
      label: "Deception belief-shift temporal association evaluator",
      version: "1.0.0",
      inputSchema: "werewolf.deception-belief-shift.evaluation-context.v1",
      outputSchema: "evaluation.deception-belief-shift.temporal-association.v1",
      mode: "deterministic",
      metricIds: DECEPTION_BELIEF_SHIFT_METRIC_IDS,
      rubric: expect.stringContaining("temporal association"),
      dependencies: expect.objectContaining({
        exposureRecords: "SocialExposureRecord from deriveSocialExposureRecords()",
        mutationJournal: "AgentSocialState.journal.entries",
        falseClaimTruth: "postgame role truth for claim classification only"
      }),
      aggregation: "zero_weight_temporal_association_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("do not claim causal influence");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("successful deception");
    expect(report.outputs[DECEPTION_BELIEF_SHIFT_EVALUATOR_ID]).toMatchObject({
      agentCount: state.players.length,
      agentsWithJournal: 3,
      falseRoleClaimExposureRecords: 2,
      evaluableFalseRoleClaimExposureRecords: 1,
      associatedFalseRoleClaimExposures: 1,
      associatedBeliefMutationRecords: 1,
      missingJournalExposureRecords: 0,
      ambiguousOrderingExposureRecords: 1
    });
    const registryWithoutRubric = report.evaluatorRegistry?.map(({ rubric, ...entry }) => entry);
    expect(JSON.stringify({ metrics: report.metrics, registry: registryWithoutRubric, outputs: report.outputs })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|deception\s+success|persuasion\s+success|reputationDamage|reputation\s+damage|trustRepair|trust\s+repair|caused by/i
    );
  });

  it("links observed false role claims to later reputation journal updates as temporal association", () => {
    const state = createGame({ id: "deception-role-claim-reputation-link", seed: "deception-role-claim-reputation-link" });
    const [speaker, observer, unexposedObserver, unrelatedTarget, ambiguousObserver] = state.players;
    const speakerFalseClaim = differentRole(speaker.role);
    const publicRecipients = (senderId: string) => state.players.filter((player) => player.id !== senderId).map((player) => player.id);
    const messages: SocialMessage[] = [
      {
        id: "msg-reputation-false-observed",
        seq: 1,
        channelId: "table",
        senderId: speaker.id,
        recipientIds: publicRecipients(speaker.id),
        visibility: "public",
        content: `${speaker.id} falsely claims ${speakerFalseClaim}.`,
        createdAt: new Date(1000).toISOString(),
        speechActs: [
          {
            id: "msg-reputation-false-observed-role-claim",
            kind: "role_claim",
            subjectId: speaker.id,
            value: speakerFalseClaim,
            confidence: 1,
            evidenceRefs: [{ artifact: "message", id: "msg-reputation-false-observed", seq: 1 }]
          }
        ],
        metadata: { kind: "public-speech", claimedRole: speaker.role }
      },
      {
        id: "msg-reputation-false-unobserved",
        seq: 2,
        channelId: "table",
        senderId: speaker.id,
        recipientIds: publicRecipients(speaker.id),
        visibility: "public",
        content: `${speaker.id} repeats an unobserved false claim.`,
        createdAt: new Date(2000).toISOString(),
        metadata: { kind: "public-speech", claimedRole: speakerFalseClaim }
      },
      {
        id: "msg-reputation-truthful-observed",
        seq: 3,
        channelId: "table",
        senderId: unrelatedTarget.id,
        recipientIds: publicRecipients(unrelatedTarget.id),
        visibility: "public",
        content: `${unrelatedTarget.id} truthfully claims ${unrelatedTarget.role}.`,
        createdAt: new Date(3000).toISOString(),
        metadata: { kind: "public-speech", claimedRole: unrelatedTarget.role }
      }
    ];
    const socialEpisode = {
      steps: [
        {
          traceId: "trace-reputation-observer",
          turnIndex: 2,
          actorId: observer.id,
          profileId: `profile-${observer.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: observer.id, kind: "vote" },
          observation: {
            agentId: observer.id,
            visibleMessages: [messages[0], messages[2]]
          },
          action: { actorId: observer.id, kind: "vote.cast", command: { type: "vote.cast", actorId: observer.id, abstain: true } }
        },
        {
          traceId: "trace-reputation-unexposed",
          turnIndex: 3,
          actorId: unexposedObserver.id,
          profileId: `profile-${unexposedObserver.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: unexposedObserver.id, kind: "vote" },
          observation: {
            agentId: unexposedObserver.id,
            visibleMessages: [messages[2]]
          },
          action: { actorId: unexposedObserver.id, kind: "vote.cast", command: { type: "vote.cast", actorId: unexposedObserver.id, abstain: true } }
        },
        {
          traceId: "trace-reputation-ambiguous",
          turnIndex: 4,
          actorId: ambiguousObserver.id,
          profileId: `profile-${ambiguousObserver.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: ambiguousObserver.id, kind: "vote" },
          observation: {
            agentId: ambiguousObserver.id,
            visibleMessages: [messages[0]]
          },
          action: { actorId: ambiguousObserver.id, kind: "vote.cast", command: { type: "vote.cast", actorId: ambiguousObserver.id, abstain: true } }
        }
      ],
      messages
    } as unknown as SocialEpisodeArtifact;

    const observerSocial = createAgentSocialState({
      agentId: observer.id,
      profile: { id: `profile-${observer.id}`, model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    updateSocialReputation(observerSocial, {
      subjectId: speaker.id,
      deltas: { honesty: -0.1 },
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-reputation-same-turn", turnIndex: 2, phase: "day_speech", day: 1 });
    updateSocialReputation(observerSocial, {
      subjectId: speaker.id,
      deltas: { honesty: -0.4, threat: 0.3 },
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-reputation-after-exposure", turnIndex: 3, phase: "day_vote", day: 1 });
    updateSocialReputation(observerSocial, {
      subjectId: unrelatedTarget.id,
      deltas: { honesty: -0.5 },
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-reputation-unrelated-subject", turnIndex: 4, phase: "day_vote", day: 1 });

    const unexposedSocial = createAgentSocialState({
      agentId: unexposedObserver.id,
      profile: { id: `profile-${unexposedObserver.id}`, model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    updateSocialReputation(unexposedSocial, {
      subjectId: speaker.id,
      deltas: { honesty: -0.8, threat: 0.6 },
      evidenceRefs: [{ artifact: "message", id: messages[1].id, seq: messages[1].seq }]
    }, { traceId: "trace-reputation-unobserved-message", turnIndex: 5, phase: "day_vote", day: 1 });

    const ambiguousSocial = createAgentSocialState({
      agentId: ambiguousObserver.id,
      profile: { id: `profile-${ambiguousObserver.id}`, model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    updateSocialReputation(ambiguousSocial, {
      subjectId: speaker.id,
      deltas: { honesty: -0.2 },
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-reputation-ambiguous-ordered", turnIndex: 5, phase: "day_vote", day: 1 });
    updateSocialReputation(ambiguousSocial, {
      subjectId: speaker.id,
      deltas: { threat: 0.4 },
      evidenceRefs: [{ artifact: "message", id: messages[0].id, seq: messages[0].seq }]
    }, { traceId: "trace-reputation-ambiguous-unordered", turnIndex: 6, phase: "day_vote", day: 1 });
    const unorderedJournalEntry = ambiguousSocial.journal?.entries[ambiguousSocial.journal.entries.length - 1];
    expect(unorderedJournalEntry).toBeDefined();
    delete unorderedJournalEntry!.turnIndex;

    const agents: AgentHarnessState[] = state.players.map((player) => ({
      playerId: player.id,
      profileId: `profile-${player.id}`,
      model: "deterministic-test-model",
      temperature: 0,
      policyName: "balanced",
      turns: 0,
      observations: 0,
      beliefs: {},
      privateMemos: [],
      socialStateHash:
        player.id === observer.id
          ? "observer-reputation-hash"
          : player.id === unexposedObserver.id
            ? "unexposed-reputation-hash"
            : player.id === ambiguousObserver.id
              ? "ambiguous-reputation-hash"
              : undefined,
      social:
        player.id === observer.id
          ? observerSocial
          : player.id === unexposedObserver.id
            ? unexposedSocial
            : player.id === ambiguousObserver.id
              ? ambiguousSocial
              : undefined
    }));

    const report = runEvaluationRegistry({
      id: "deception-role-claim-reputation-link:evaluation",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "deception-role-claim-reputation-link",
        status: "completed",
        initialState: state,
        finalState: state,
        agents,
        trajectory: [],
        socialEpisode
      },
      evaluators: [createDeceptionReputationAssociationEvaluator()]
    });

    expect(report.summary.agentScores).toEqual({});
    expect(deriveSocialExposureRecords(socialEpisode).map((record) => [record.messageId, record.sourceId, record.observerId])).toEqual([
      [messages[0].id, speaker.id, observer.id],
      [messages[2].id, unrelatedTarget.id, observer.id],
      [messages[2].id, unrelatedTarget.id, unexposedObserver.id],
      [messages[0].id, speaker.id, ambiguousObserver.id]
    ]);

    const observerReputationCount = report.metrics.find(
      (item) => item.id === "agent.false_role_claim_reputation_temporal_association_count" && item.subjectId === observer.id
    );
    expect(observerReputationCount).toMatchObject({
      evaluatorId: DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      value: 1,
      denominator: 1,
      weight: 0,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: messages[0].id, seq: 1 }),
        expect.objectContaining({ artifact: "trace", traceId: "trace-reputation-observer" }),
        expect.objectContaining({ artifact: "trace", traceId: "trace-reputation-after-exposure" }),
        expect.objectContaining({ artifact: "agent_state", id: observer.id, description: "socialStateHash:observer-reputation-hash" }),
        expect.objectContaining({ artifact: "state", description: `postgame role truth for ${speaker.id}` })
      ]),
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        causalClaim: false,
        falseRoleClaimExposureCount: 1,
        evaluableFalseClaimExposureCount: 1,
        associatedExposureCount: 1,
        associatedMutationCount: 1,
        sameTurnMutationCount: 1,
        noLaterMutationCount: 0,
        hiddenTruthUsedInLiveStore: false,
        postgameTruthUsedForFalseClaimClassification: true,
        truthAccessMode: "postgame_role_truth_for_false_claim_classification_only",
        stores: ["reputation"],
        mutationKinds: ["reputation.updated"],
        reputationDimensions: ["honesty", "threat"],
        messageIds: [messages[0].id],
        sourceIds: [speaker.id],
        observedAtTraceIds: ["trace-reputation-observer"],
        claimFacts: [
          expect.objectContaining({
            messageId: messages[0].id,
            claimSource: "speech_act",
            speechActId: "msg-reputation-false-observed-role-claim",
            speechActKind: "role_claim"
          })
        ]
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_reputation_temporal_association_rate" && item.subjectId === observer.id)).toMatchObject({
      value: 1,
      denominator: 1,
      aggregation: "ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_reputation_temporal_evaluable_exposure_rate" && item.subjectId === observer.id)).toMatchObject({
      value: 1,
      denominator: 1,
      aggregation: "coverage_ratio"
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_reputation_temporal_association_count" && item.subjectId === unexposedObserver.id)).toMatchObject({
      value: 0,
      denominator: 0
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_reputation_temporal_association_count" && item.subjectId === ambiguousObserver.id)).toMatchObject({
      value: 0,
      denominator: 0,
      metadata: expect.objectContaining({
        falseRoleClaimExposureCount: 1,
        evaluableFalseClaimExposureCount: 0,
        associatedExposureCount: 0,
        associatedMutationCount: 0,
        ambiguousOrderingExposureCount: 1,
        noLaterMutationCount: 0
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_reputation_temporal_evaluable_exposure_rate" && item.subjectId === ambiguousObserver.id)).toMatchObject({
      value: 0,
      denominator: 1,
      aggregation: "coverage_ratio"
    });
    expect([...new Set(report.metrics.map((item) => item.id))].sort()).toEqual([...DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS].sort());
    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
      label: "Deception reputation temporal association evaluator",
      version: "1.0.0",
      inputSchema: "werewolf.deception-reputation-association.evaluation-context.v1",
      outputSchema: "evaluation.deception-reputation-association.temporal-association.v1",
      mode: "deterministic",
      metricIds: DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS,
      rubric: expect.stringContaining("temporal association"),
      dependencies: expect.objectContaining({
        exposureRecords: "SocialExposureRecord from deriveSocialExposureRecords()",
        mutationJournal: "AgentSocialState.journal.entries",
        falseClaimTruth: "postgame role truth for claim classification only"
      }),
      aggregation: "zero_weight_reputation_temporal_association_by_agent",
      visibility: "postgame"
    });
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("do not claim causal influence");
    expect(report.evaluatorRegistry?.[0]?.rubric).toContain("reputation damage");
    expect(report.outputs[DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: state.players.length,
      agentsWithJournal: 3,
      falseRoleClaimExposureRecords: 2,
      evaluableFalseRoleClaimExposureRecords: 1,
      associatedFalseRoleClaimExposures: 1,
      associatedReputationMutationRecords: 1,
      missingJournalExposureRecords: 0,
      ambiguousOrderingExposureRecords: 1
    });
    const registryWithoutRubric = report.evaluatorRegistry?.map(({ rubric, ...entry }) => entry);
    expect(JSON.stringify({ metrics: report.metrics, registry: registryWithoutRubric, outputs: report.outputs })).not.toMatch(
      /causedBy|rewardDelta|causalInfluence|influence_success|persuasionSuccess|deceptionSuccess|deception\s+success|persuasion\s+success|caused by/i
    );
  });

  it("links day-one scoped false role pressure to the exile vote even when a sheriff ballot was recorded first", () => {
    const baseState = createGame({ id: "deception-role-pressure-vote-follow", seed: "deception-role-pressure-vote-follow" });
    const [speaker, follower, resister, pressureTarget, otherTarget] = baseState.players;
    const speakerFalseClaim = differentRole(speaker.role);
    const publicRecipients = (senderId: string) => baseState.players.filter((player) => player.id !== senderId).map((player) => player.id);
    const sheriffBallot = {
      day: 1,
      voterId: follower.id,
      targetId: otherTarget.id,
      abstain: false,
      weight: 1,
      kind: "sheriff" as const
    };
    const followedVote = {
      day: 1,
      voterId: follower.id,
      targetId: pressureTarget.id,
      abstain: false,
      weight: 1,
      kind: "exile" as const
    };
    const resistedVote = {
      day: 1,
      voterId: resister.id,
      targetId: otherTarget.id,
      abstain: false,
      weight: 1,
      kind: "exile" as const
    };
    const unseenSameTargetVote = {
      day: 1,
      voterId: otherTarget.id,
      targetId: pressureTarget.id,
      abstain: false,
      weight: 1,
      kind: "exile" as const
    };
    const state: GameState = {
      ...baseState,
      day: 1,
      phase: "day_vote",
      votes: [sheriffBallot, followedVote, resistedVote, unseenSameTargetVote],
      events: [
        ...baseState.events,
        {
          id: "event-vote-followed",
          seq: baseState.events.length + 1,
          day: 1,
          phase: "day_vote",
          type: "vote.cast",
          actorId: follower.id,
          visibility: "public",
          payload: followedVote,
          createdAt: new Date(5000).toISOString()
        },
        {
          id: "event-vote-resisted",
          seq: baseState.events.length + 2,
          day: 1,
          phase: "day_vote",
          type: "vote.cast",
          actorId: resister.id,
          visibility: "public",
          payload: resistedVote,
          createdAt: new Date(6000).toISOString()
        },
        {
          id: "event-vote-unseen-same-target",
          seq: baseState.events.length + 3,
          day: 1,
          phase: "day_vote",
          type: "vote.cast",
          actorId: otherTarget.id,
          visibility: "public",
          payload: unseenSameTargetVote,
          createdAt: new Date(7000).toISOString()
        }
      ]
    };
    const messages: SocialMessage[] = [
      {
        id: "msg-1",
        seq: 1,
        channelId: "table",
        senderId: speaker.id,
        recipientIds: publicRecipients(speaker.id),
        visibility: "public",
        content: `${speaker.id} falsely claims ${speakerFalseClaim} and pressures ${pressureTarget.id}.`,
        createdAt: new Date(1000).toISOString(),
        speechActs: [
          {
            id: "msg-1-role-claim",
            kind: "role_claim",
            subjectId: speaker.id,
            value: speakerFalseClaim,
            confidence: 1,
            evidenceRefs: [{ artifact: "message", id: "msg-1", seq: 1 }]
          },
          {
            id: "msg-1-accusation",
            kind: "accusation",
            subjectId: speaker.id,
            targetId: pressureTarget.id,
            value: "pressure_target",
            confidence: 0.8,
            evidenceRefs: [{ artifact: "message", id: "msg-1", seq: 1 }]
          }
        ],
        metadata: {
          kind: "public-speech",
          day: 1,
          claimedRole: speaker.role,
          pressureTargetId: otherTarget.id
        }
      },
      {
        id: "msg-2",
        seq: 2,
        channelId: "table",
        senderId: speaker.id,
        recipientIds: publicRecipients(speaker.id),
        visibility: "public",
        content: `${speaker.id} makes another false pressure claim that nobody sees before voting.`,
        createdAt: new Date(2000).toISOString(),
        metadata: {
          kind: "public-speech",
          day: 1,
          claimedRole: speakerFalseClaim,
          pressureTargetId: otherTarget.id
        }
      },
      {
        id: "msg-3",
        seq: 3,
        channelId: "table",
        senderId: follower.id,
        recipientIds: publicRecipients(follower.id),
        visibility: "public",
        content: `${follower.id} truthfully claims ${follower.role} while pressuring ${pressureTarget.id}.`,
        createdAt: new Date(3000).toISOString(),
        metadata: {
          kind: "public-speech",
          day: 1,
          claimedRole: follower.role,
          pressureTargetId: pressureTarget.id
        }
      }
    ];
    const socialEpisode = {
      steps: [
        {
          traceId: "trace-follower-vote",
          turnIndex: 1,
          actorId: follower.id,
          profileId: `profile-${follower.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: follower.id, kind: "vote" },
          observation: {
            agentId: follower.id,
            visibleMessages: [messages[0]]
          },
          action: {
            actorId: follower.id,
            kind: "vote.cast",
            command: { type: "vote.cast", actorId: follower.id, targetId: pressureTarget.id }
          }
        },
        {
          traceId: "trace-resister-vote",
          turnIndex: 2,
          actorId: resister.id,
          profileId: `profile-${resister.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: resister.id, kind: "vote" },
          observation: {
            agentId: resister.id,
            visibleMessages: [messages[0], messages[2]]
          },
          action: {
            actorId: resister.id,
            kind: "vote.cast",
            command: { type: "vote.cast", actorId: resister.id, targetId: otherTarget.id }
          }
        },
        {
          traceId: "trace-unseen-same-target-vote",
          turnIndex: 3,
          actorId: otherTarget.id,
          profileId: `profile-${otherTarget.id}`,
          schedulerMode: "aec",
          pendingAction: { actorId: otherTarget.id, kind: "vote" },
          observation: {
            agentId: otherTarget.id,
            visibleMessages: []
          },
          action: {
            actorId: otherTarget.id,
            kind: "vote.cast",
            command: { type: "vote.cast", actorId: otherTarget.id, targetId: pressureTarget.id }
          }
        }
      ],
      messages
    } as unknown as SocialEpisodeArtifact;
    const agents: AgentHarnessState[] = state.players.map((player) => ({
      playerId: player.id,
      model: "deterministic-test-model",
      temperature: 0,
      policyName: "balanced",
      turns: 0,
      observations: 0,
      beliefs: {},
      privateMemos: []
    }));

    const report = runEvaluationRegistry({
      id: "deception-role-pressure-vote-follow:evaluation",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "deception-role-pressure-vote-follow",
        status: "completed",
        initialState: state,
        finalState: state,
        agents,
        trajectory: [],
        socialEpisode
      },
      evaluators: [createWerewolfDeceptionEvaluator()]
    });

    expect(deriveSocialExposureRecords(socialEpisode).map((record) => [record.messageId, record.sourceId, record.observerId])).toEqual([
      ["msg-1", speaker.id, follower.id],
      ["msg-1", speaker.id, resister.id],
      ["msg-3", follower.id, resister.id]
    ]);
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_pressure_vote_follow_count" && item.subjectId === speaker.id)).toMatchObject({
      value: 1,
      denominator: 2,
      aggregation: "sum",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-1", seq: 1 }),
        expect.objectContaining({ artifact: "trace", traceId: "trace-follower-vote", description: "vote.cast" }),
        expect.objectContaining({ artifact: "observation", traceId: "trace-resister-vote", description: expect.stringContaining("observation") }),
        expect.objectContaining({ artifact: "event", id: "event-vote-followed", description: "vote.cast" }),
        expect.objectContaining({ artifact: "event", id: "event-vote-resisted", description: "vote.cast" }),
        expect.objectContaining({ artifact: "state", description: `postgame role truth for ${speaker.id}` })
      ]),
      metadata: expect.objectContaining({
        falseRoleClaimPressureMessages: 2,
        voteOpportunities: 2,
        followedVotes: 1,
        nonFollowedVotes: 1,
        messageIds: ["msg-1"],
        followedMessageIds: ["msg-1"],
        observerIds: [follower.id, resister.id],
        followedObserverIds: [follower.id],
        pressureTargetIds: [pressureTarget.id],
        voteTargetIds: [pressureTarget.id, otherTarget.id],
        speechActIds: ["msg-1-role-claim"],
        claimSources: ["speech_act"],
        observedAtTraceIds: ["trace-follower-vote", "trace-resister-vote"]
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.false_role_claim_pressure_vote_follow_rate" && item.subjectId === speaker.id)).toMatchObject({
      value: 0.5,
      denominator: 2,
      aggregation: "ratio"
    });
    expect(
      report.metrics.some(
        (item) =>
          (item.id === "agent.false_role_claim_pressure_vote_follow_count" || item.id === "agent.false_role_claim_pressure_vote_follow_rate") &&
          item.evidenceRefs?.some((ref) => ref.artifact === "message" && (ref.id === "msg-2" || ref.id === "msg-3"))
      )
    ).toBe(false);
    expect(
      report.metrics.some(
        (item) =>
          (item.id === "agent.false_role_claim_pressure_vote_follow_count" || item.id === "agent.false_role_claim_pressure_vote_follow_rate") &&
          item.evidenceRefs?.some((ref) => ref.artifact === "event" && ref.id === "event-vote-unseen-same-target")
      )
    ).toBe(false);
  });
});

describe("werewolf social calibration evaluator", () => {
  it("scores final wolf beliefs and reputation threat estimates against postgame team truth", () => {
    const state = createGame({ id: "social-calibration", seed: "social-calibration" });
    const wolf = state.players.find((player) => player.team === "werewolves");
    const village = state.players.find((player) => player.team === "village");
    const observer = state.players.find((player) => player.id !== wolf?.id && player.id !== village?.id);
    expect(wolf).toBeDefined();
    expect(village).toBeDefined();
    expect(observer).toBeDefined();
    const beliefWolfEvidence: EvidenceRef = {
      artifact: "observation",
      seq: 1,
      traceId: "trace-belief-wolf",
      description: `belief update for ${wolf!.id}`
    };
    const beliefVillageEvidence: EvidenceRef = {
      artifact: "observation",
      seq: 2,
      traceId: "trace-belief-village",
      description: `belief update for ${village!.id}`
    };
    const reputationWolfEvidence: EvidenceRef = {
      artifact: "message",
      id: "msg-reputation-wolf",
      seq: 1,
      description: "public suspicious speech"
    };
    const reputationVillageEvidence: EvidenceRef = {
      artifact: "message",
      id: "msg-reputation-village",
      seq: 2,
      description: "public cooperative speech"
    };
    const social = createAgentSocialState({
      agentId: observer!.id,
      profile: { id: `profile-${observer!.id}`, model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;
    upsertBelief(social.beliefs, {
      subject: wolf!.id,
      predicate: "werewolfProbability",
      value: 0.9,
      confidence: 0.8,
      evidenceRefs: [beliefWolfEvidence]
    });
    upsertBelief(social.beliefs, {
      subject: village!.id,
      predicate: "werewolfProbability",
      value: 0.2,
      confidence: 0.6,
      evidenceRefs: [beliefVillageEvidence]
    });
    updateReputation(social.reputation, {
      subjectId: wolf!.id,
      deltas: { threat: 0.6 },
      evidenceRefs: [reputationWolfEvidence]
    });
    updateReputation(social.reputation, {
      subjectId: village!.id,
      deltas: { threat: -0.6 },
      evidenceRefs: [reputationVillageEvidence]
    });
    const agents: AgentHarnessState[] = [
      {
        playerId: observer!.id,
        profileId: `profile-${observer!.id}`,
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 2,
        observations: 2,
        beliefs: {
          [wolf!.id]: { wolfProb: 0.9, rationaleTags: ["test-wolf-suspicion"] },
          [village!.id]: { wolfProb: 0.2, rationaleTags: ["test-village-trust"] },
          [observer!.id]: { wolfProb: 0.5, rationaleTags: ["self-record-ignored"] }
        },
        privateMemos: [],
        social,
        socialStateHash: "hash-social-calibration"
      }
    ];

    const report = runEvaluationRegistry({
      id: "social-calibration:evaluation",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "social-calibration",
        status: "completed",
        initialState: state,
        finalState: state,
        agents,
        trajectory: []
      },
      evaluators: [createWerewolfSocialCalibrationEvaluator()]
    });

    expect(report.evaluatorRegistry?.[0]).toMatchObject({
      id: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
      metricIds: WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS
    });
    expect(report.outputs[WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID]).toMatchObject({
      agentCount: 1,
      agentsWithBeliefSamples: 1,
      agentsWithReputationSamples: 1,
      beliefSamples: 2,
      reputationSamples: 2,
      averageWolfBeliefBrierScore: 0.025,
      averageReputationThreatBrierScore: 0.04
    });
    expect(report.metrics.find((item) => item.id === "agent.wolf_belief_brier_score" && item.subjectId === observer!.id)).toMatchObject({
      value: 0.025,
      denominator: 2,
      higherIsBetter: false,
      weight: 0,
      aggregation: "average_brier_score",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "observation", traceId: "trace-belief-wolf", description: "belief update for p2" }),
        expect.objectContaining({ artifact: "observation", traceId: "trace-belief-village", description: "belief update for p1" }),
        expect.objectContaining({ artifact: "agent_state", id: observer!.id, description: "socialStateHash:hash-social-calibration" }),
        expect.objectContaining({ artifact: "state", description: "postgame team truth for wolf belief calibration" })
      ]),
      metadata: expect.objectContaining({
        sampleCount: 2,
        targetIds: [wolf!.id, village!.id],
        wolfTargetIds: [wolf!.id],
        villageTargetIds: [village!.id],
        averagePrediction: 0.55,
        wolfTruthRate: 0.5
      })
    });
    expect(report.metrics.find((item) => item.id === "agent.social.reputation_threat_brier_score" && item.subjectId === observer!.id)).toMatchObject({
      value: 0.04,
      denominator: 2,
      higherIsBetter: false,
      weight: 0,
      aggregation: "average_brier_score",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "msg-reputation-wolf", seq: 1 }),
        expect.objectContaining({ artifact: "message", id: "msg-reputation-village", seq: 2 }),
        expect.objectContaining({ artifact: "agent_state", id: observer!.id, description: "socialStateHash:hash-social-calibration" }),
        expect.objectContaining({ artifact: "state", description: "postgame team truth for reputation threat calibration" })
      ]),
      metadata: expect.objectContaining({
        sampleCount: 2,
        targetIds: [wolf!.id, village!.id],
        wolfTargetIds: [wolf!.id],
        villageTargetIds: [village!.id],
        averagePrediction: 0.5,
        wolfTruthRate: 0.5,
        threatScale: "signed [-1,1] normalized to wolf probability [0,1]"
      })
    });
    expect(report.metrics.some((item) => item.metadata?.samples && JSON.stringify(item.metadata.samples).includes(observer!.id))).toBe(false);
  });
});

describe("werewolf evaluation report integration", () => {
  it("emits reward-bearing metrics only for completed episodes with a legal winner", () => {
    const unfinished = createGame({ id: "outcome-lifecycle-gate", seed: "outcome-lifecycle-gate" });
    const unfinishedEvaluation = evaluateAdversarialMatch(unfinished, []);
    const rewardMetricIds = new Set(["team.reward", "agent.reward", "profile.agent_reward", "model.agent_reward"]);

    for (const status of ["completed", "truncated", "failed"] as const) {
      const metrics = metricsFromWerewolfOutcomeEvaluation(unfinishedEvaluation, unfinished, [], undefined, status);
      expect(metrics.map((item) => item.id)).toEqual(["episode.completed_with_winner"]);
      expect(metrics[0]).toMatchObject({ value: 0, metadata: expect.objectContaining({ status, winner: null }) });
      expect(metrics.filter((item) => rewardMetricIds.has(item.id))).toEqual([]);
    }

    const completed = { ...unfinished, phase: "game_over" as const, winner: "village" as const };
    const completedMetrics = metricsFromWerewolfOutcomeEvaluation(
      evaluateAdversarialMatch(completed, []),
      completed,
      [],
      undefined,
      "completed"
    );
    expect(completedMetrics.filter((item) => rewardMetricIds.has(item.id))).not.toEqual([]);
  });

  it("emits evaluator metrics through runtime and match artifacts", async () => {
    const initialState = createGame({ id: "evaluation-report", seed: "evaluation-report" });
    const profiles = profilesFromModels(["alpha", "beta"], 0.2);
    const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.2);
    const result = await runHarnessMatch({
      initialState,
      agents,
      reasoner: stubReasoner,
      maxTransitions: 8
    });
    const artifact = buildMatchArtifact({
      runId: "evaluation-report",
      seed: initialState.seed,
      models: ["alpha", "beta"],
      profiles,
      resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
      result
    });
    expect(result.status).toBe("truncated");

    expect(result.evaluationReport.evaluatorIds).toEqual(
      expect.arrayContaining([
        WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
        WEREWOLF_OUTCOME_EVALUATOR_ID,
        WEREWOLF_VOTE_ACCURACY_EVALUATOR_ID,
        WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
        WEREWOLF_INFLUENCE_EVALUATOR_ID,
        WEREWOLF_DECEPTION_EVALUATOR_ID,
        WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
        SOCIAL_STATE_EVALUATOR_ID,
        COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
        COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
        DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
        SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
        SOCIAL_DYNAMICS_EVALUATOR_ID
      ])
    );
    expect(artifact.evaluationReport.evaluatorIds).toEqual(
      expect.arrayContaining([
        NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
        DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
        DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID
      ])
    );
    expect(result.evaluationReport.evaluatorRegistry).toEqual(
      expect.arrayContaining([
        {
          id: WEREWOLF_ADVERSARIAL_EVALUATOR_ID,
          label: "Werewolf adversarial summary evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.adversarial.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_ADVERSARIAL_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "compatibility_output",
          visibility: "postgame"
        },
        {
          id: WEREWOLF_OUTCOME_EVALUATOR_ID,
          label: "Werewolf outcome and reward evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.outcome.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_OUTCOME_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "weighted_reward_summary",
          visibility: "postgame"
        },
        {
          id: WEREWOLF_VOTE_ACCURACY_EVALUATOR_ID,
          label: "Werewolf vote accuracy evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.vote-accuracy.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_VOTE_ACCURACY_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "ratio_by_agent",
          visibility: "postgame"
        },
        {
          id: WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
          label: "Werewolf role survival evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.role-survival.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_ROLE_SURVIVAL_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "survival_rate_by_agent_and_role",
          visibility: "postgame"
        },
        {
          id: WEREWOLF_INFLUENCE_EVALUATOR_ID,
          label: "Werewolf influence evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.influence.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_INFLUENCE_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            limitation: expect.stringContaining("observer-scoped message exposure")
          },
          aggregation: "zero_weight_legacy_ratio_by_agent",
          visibility: "postgame"
        },
        {
          id: WEREWOLF_DECEPTION_EVALUATOR_ID,
          label: "Werewolf deception evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.deception.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_DECEPTION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "score_by_werewolf_agent",
          visibility: "postgame"
        },
        {
          id: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
          label: "Werewolf social calibration evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.match.evaluation-context.v1",
          outputSchema: "werewolf.social-calibration.evaluation.v1",
          mode: "deterministic",
          metricIds: WEREWOLF_SOCIAL_CALIBRATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "postgame_calibration_by_agent",
          visibility: "postgame"
        },
        {
          id: SOCIAL_STATE_EVALUATOR_ID,
          label: "Social state evaluator",
          version: "1.0.0",
          inputSchema: "harness.social-state.evaluation-context.v1",
          outputSchema: "harness.social-state.summary.v1",
          mode: "deterministic",
          metricIds: SOCIAL_STATE_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "agent_social_state_summary",
          visibility: "postgame"
        },
        {
          id: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
          label: "Commitment-coalition association evaluator",
          version: "1.0.0",
          inputSchema: "harness.commitment-coalition-association.evaluation-context.v1",
          outputSchema: "harness.commitment-coalition-association.summary.v1",
          mode: "deterministic",
          metricIds: COMMITMENT_COALITION_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            socialState: "AgentSocialState.commitments, AgentSocialState.coalitions, and evidence-backed social-state records"
          },
          aggregation: "zero_weight_commitment_coalition_association_by_agent",
          visibility: "postgame"
        },
        {
          id: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          label: "Commitment-coalition lifecycle temporal association evaluator",
          version: "1.0.0",
          inputSchema: "harness.commitment-coalition-lifecycle-temporal-association.evaluation-context.v1",
          outputSchema: "harness.commitment-coalition-lifecycle-temporal-association.summary.v1",
          mode: "deterministic",
          metricIds: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            mutationJournal: "AgentSocialState.journal.entries with subjectId, mutationKind, turnIndex, deltaSummary, evidenceRefs, and hiddenTruthUsed=false",
            socialState: "AgentSocialState.commitments and AgentSocialState.coalitions for record denominators"
          },
          aggregation: "zero_weight_commitment_coalition_lifecycle_temporal_association_by_agent",
          visibility: "postgame"
        },
        {
          id: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          label: "Norm-sanction lifecycle temporal association evaluator",
          version: "1.0.0",
          inputSchema: "harness.norm-sanction-lifecycle-temporal-association.evaluation-context.v1",
          outputSchema: "harness.norm-sanction-lifecycle-temporal-association.summary.v1",
          mode: "deterministic",
          metricIds: NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            mutationJournal:
              "AgentSocialState.journal.entries with subjectId, mutationKind, turnIndex, deltaSummary, evidenceRefs, and hiddenTruthUsed=false",
            socialState: "AgentSocialState.norms and AgentSocialState.normSanctions for record denominators"
          },
          aggregation: "zero_weight_norm_sanction_lifecycle_temporal_association_by_agent",
          visibility: "postgame"
        },
        {
          id: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          label: "Gossip-exposure temporal association evaluator",
          version: "1.0.0",
          inputSchema: "harness.gossip-exposure-temporal-association.evaluation-context.v1",
          outputSchema: "harness.gossip-exposure-temporal-association.summary.v1",
          mode: "deterministic",
          metricIds: GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            socialExposure: "SocialExposureRecord records from deriveSocialExposureRecords() over SocialEpisodeArtifact steps/messages",
            mutationJournal:
              "AgentSocialState.journal.entries with store gossip, mutationKind gossip.added, subjectId, turnIndex, hiddenTruthUsed, and evidenceRefs",
            socialState: "AgentSocialState.gossip records for record denominators"
          },
          aggregation: "zero_weight_gossip_exposure_temporal_association_by_agent",
          visibility: "postgame"
        },
        {
          id: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          label: "Trust-repair lifecycle temporal association evaluator",
          version: "1.0.0",
          inputSchema: "harness.trust-repair-lifecycle-temporal-association.evaluation-context.v1",
          outputSchema: "harness.trust-repair-lifecycle-temporal-association.summary.v1",
          mode: "deterministic",
          metricIds: TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            mutationJournal:
              "AgentSocialState.journal.entries with subjectId, mutationKind, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
            socialState: "AgentSocialState.trustRepairs records for record denominators"
          },
          aggregation: "zero_weight_trust_repair_lifecycle_temporal_association_by_agent",
          visibility: "postgame"
        },
        {
          id: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          label: "Trust-repair relationship temporal association evaluator",
          version: "1.0.0",
          inputSchema: "harness.trust-repair-relationship-temporal-association.evaluation-context.v1",
          outputSchema: "harness.trust-repair-relationship-temporal-association.summary.v1",
          mode: "deterministic",
          metricIds: TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            mutationJournal:
              "AgentSocialState.journal.entries with store trustRepairs/relationships, mutationKind trust_repair.added/relationship.updated, subjectId, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
            socialState: "AgentSocialState.trustRepairs records and AgentSocialState.relationships edges for record denominators"
          },
          aggregation: "zero_weight_trust_repair_relationship_temporal_association_by_agent",
          visibility: "postgame"
        },
        {
          id: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          label: "Trust-repair reputation temporal association evaluator",
          version: "1.0.0",
          inputSchema: "harness.trust-repair-reputation-temporal-association.evaluation-context.v1",
          outputSchema: "harness.trust-repair-reputation-temporal-association.summary.v1",
          mode: "deterministic",
          metricIds: TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            mutationJournal:
              "AgentSocialState.journal.entries with store trustRepairs/reputation, mutationKind trust_repair.added/reputation.updated, subjectId, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
            socialState: "AgentSocialState.trustRepairs records and AgentSocialState.reputation records for record denominators"
          },
          aggregation: "zero_weight_trust_repair_reputation_temporal_association_by_agent",
          visibility: "postgame"
        },
        {
          id: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
          label: "Betrayal lifecycle temporal association evaluator",
          version: "1.0.0",
          inputSchema: "harness.betrayal-lifecycle-temporal-association.evaluation-context.v1",
          outputSchema: "harness.betrayal-lifecycle-temporal-association.summary.v1",
          mode: "deterministic",
          metricIds: BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            mutationJournal:
              "AgentSocialState.journal.entries with store betrayals, mutationKind betrayal.added/betrayal.evidence.recorded, subjectId, turnIndex, deltaSummary, hiddenTruthUsed, and evidenceRefs",
            socialState: "AgentSocialState.betrayals records for record denominators"
          },
          aggregation: "zero_weight_betrayal_lifecycle_temporal_association_by_agent",
          visibility: "postgame"
        },
        {
          id: DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
          label: "Deception belief-shift temporal association evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.deception-belief-shift.evaluation-context.v1",
          outputSchema: "evaluation.deception-belief-shift.temporal-association.v1",
          mode: "deterministic",
          metricIds: DECEPTION_BELIEF_SHIFT_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            exposureRecords: "SocialExposureRecord from deriveSocialExposureRecords()",
            mutationJournal: "AgentSocialState.journal.entries",
            falseClaimTruth: "postgame role truth for claim classification only"
          },
          aggregation: "zero_weight_temporal_association_by_agent",
          visibility: "postgame"
        },
        {
          id: DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID,
          label: "Deception reputation temporal association evaluator",
          version: "1.0.0",
          inputSchema: "werewolf.deception-reputation-association.evaluation-context.v1",
          outputSchema: "evaluation.deception-reputation-association.temporal-association.v1",
          mode: "deterministic",
          metricIds: DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            exposureRecords: "SocialExposureRecord from deriveSocialExposureRecords()",
            mutationJournal: "AgentSocialState.journal.entries",
            falseClaimTruth: "postgame role truth for claim classification only"
          },
          aggregation: "zero_weight_reputation_temporal_association_by_agent",
          visibility: "postgame"
        },
        {
          id: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
          label: "Social fact ingest evidence evaluator",
          version: "1.0.0",
          inputSchema: "harness.social-fact-ingest-evidence.evaluation-context.v1",
          outputSchema: "harness.social-fact-ingest-evidence.summary.v1",
          mode: "deterministic",
          metricIds: SOCIAL_FACT_INGEST_EVIDENCE_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {
            socialEpisode: "SocialEpisodeArtifact.messages and scoped SocialExposureRecord records from actor observations",
            mutationJournal:
              "AgentSocialState.journal.entries with store/mutationKind, messageSeqRange, safe provenance metadata, hiddenTruthUsed=false, and evidenceRefs",
            socialState: "AgentSocialState commitments, coalitions, relationships, and reputation records for mutation evidence"
          },
          aggregation: "zero_weight_social_fact_ingest_evidence_by_agent",
          visibility: "postgame"
        },
        {
          id: SOCIAL_DYNAMICS_EVALUATOR_ID,
          label: "Social dynamics evaluator",
          version: "1.0.0",
          inputSchema: "harness.social-dynamics.evaluation-context.v1",
          outputSchema: "harness.social-dynamics.summary.v1",
          mode: "deterministic",
          metricIds: SOCIAL_DYNAMICS_METRIC_IDS,
          rubric: expect.any(String),
          dependencies: {},
          aggregation: "agent_social_dynamics_summary",
          visibility: "postgame"
        }
      ])
    );
    expect(result.evaluationReport.metricCount).toBeGreaterThan(result.evaluation.agentRewards.length);
    expect(result.evaluationReport.metrics.every((item) => item.evaluatorId && item.evaluatorVersion && Array.isArray(item.evidenceRefs))).toBe(true);
    for (const evaluatorId of [
      NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      DECEPTION_BELIEF_SHIFT_EVALUATOR_ID,
      DECEPTION_REPUTATION_ASSOCIATION_EVALUATOR_ID
    ]) {
      expect(result.evaluationReport.evaluatorIds).toContain(evaluatorId);
      expect(artifact.evaluationReport.evaluatorIds).toContain(evaluatorId);
      expect(result.evaluationReport.evaluatorRegistry?.some((entry) => entry.id === evaluatorId)).toBe(true);
    }
    const newlyWiredMetricIds = new Set([
      ...NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
      ...GOSSIP_EXPOSURE_TEMPORAL_ASSOCIATION_METRIC_IDS,
      ...TRUST_REPAIR_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
      ...TRUST_REPAIR_RELATIONSHIP_TEMPORAL_ASSOCIATION_METRIC_IDS,
      ...TRUST_REPAIR_REPUTATION_TEMPORAL_ASSOCIATION_METRIC_IDS,
      ...BETRAYAL_LIFECYCLE_TEMPORAL_ASSOCIATION_METRIC_IDS,
      ...DECEPTION_BELIEF_SHIFT_METRIC_IDS,
      ...DECEPTION_REPUTATION_ASSOCIATION_METRIC_IDS
    ]);
    const newlyWiredMetrics = result.evaluationReport.metrics.filter((item) => newlyWiredMetricIds.has(item.id));
    expect(newlyWiredMetrics.every((item) => (item.weight ?? 0) === 0)).toBe(true);
    expect(result.evaluationReport.metrics.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "episode.completed_with_winner",
        "agent.survival_rate",
        "agent.wolf_belief_brier_score",
        "agent.social.memory_count",
        "agent.social.journal_entry_count",
        "agent.social.commitment_coalition_association_count",
        "agent.social.commitment_status_temporal_association_count",
        "agent.social.coalition_lifecycle_temporal_association_count",
        "agent.social.commitment_speech_act_ingest_link_count",
        "agent.social.coordination_message_count",
        "agent.social.reputation_evidence_rate"
      ])
    );
    expect(
      result.evaluationReport.metrics.filter((item) =>
        ["team.reward", "agent.reward", "profile.agent_reward", "model.agent_reward"].includes(item.id)
      )
    ).toEqual([]);
    expect(result.evaluationReport.metrics.find((item) => item.id === "episode.completed_with_winner")).toMatchObject({
      evaluatorId: WEREWOLF_OUTCOME_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      value: 0,
      metadata: expect.objectContaining({ status: "truncated", winner: null })
    });
    expect(result.evaluationReport.metrics.find((item) => item.id === "agent.survival_rate")).toMatchObject({
      evaluatorId: WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "event" })])
    });
    const socialMetric = result.evaluationReport.metrics.find((item) => item.id === "agent.social.memory_count");
    expect(socialMetric).toMatchObject({
      evaluatorId: SOCIAL_STATE_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subjectId: expect.any(String),
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), policyName: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: "sum",
      evidenceRefs: [expect.objectContaining({ artifact: "agent_state", id: expect.any(String) })]
    });
    expect(result.evaluationReport.outputs[SOCIAL_STATE_EVALUATOR_ID]).toMatchObject({
      agentCount: initialState.players.length,
      agentsWithSocialState: initialState.players.length
    });
    expect(result.evaluationReport.outputs[COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: initialState.players.length,
      agentsWithSocialState: initialState.players.length,
      totalPairs: expect.any(Number),
      associatedPairs: expect.any(Number)
    });
    expect(result.evaluationReport.metrics.find((item) => item.id === "agent.social.commitment_coalition_association_count")).toMatchObject({
      evaluatorId: COMMITMENT_COALITION_ASSOCIATION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subjectId: expect.any(String),
      weight: 0,
      aggregation: "sum",
      metadata: expect.objectContaining({
        associationLevel: "explicit_evidence_or_metadata_association",
        causalClaim: false
      })
    });
    expect(result.evaluationReport.outputs[COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      agentCount: initialState.players.length,
      agentsWithSocialState: initialState.players.length,
      commitments: expect.any(Number),
      commitmentAssociatedRecords: expect.any(Number),
      coalitions: expect.any(Number),
      coalitionAssociatedRecords: expect.any(Number)
    });
    expect(result.evaluationReport.metrics.find((item) => item.id === "agent.social.commitment_status_temporal_association_count")).toMatchObject({
      evaluatorId: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subjectId: expect.any(String),
      weight: 0,
      aggregation: "sum",
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "commitment_status_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation"
      })
    });
    expect(result.evaluationReport.metrics.find((item) => item.id === "agent.social.coalition_lifecycle_temporal_association_count")).toMatchObject({
      evaluatorId: COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subjectId: expect.any(String),
      weight: 0,
      aggregation: "sum",
      metadata: expect.objectContaining({
        associationLevel: "temporal_association",
        temporalAssociationKind: "coalition_lifecycle_journal_temporal_association",
        causalClaim: false,
        orderingRule: "strict_turnIndex_after_creation"
      })
    });
    expect(result.evaluationReport.outputs[SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID]).toMatchObject({
      agentCount: initialState.players.length,
      agentsWithSocialState: initialState.players.length,
      exposureRecords: deriveSocialExposureRecords(result.socialEpisode).length,
      commitmentSpeechActCandidates: expect.any(Number),
      commitmentSpeechActLinkedCandidates: expect.any(Number),
      commitmentSpeechActMissingMutationCandidates: expect.any(Number),
      coalitionSpeechActCandidates: expect.any(Number),
      coalitionSpeechActLinkedCandidates: expect.any(Number),
      coalitionSpeechActMissingMutationCandidates: expect.any(Number),
      relationshipFactCandidates: expect.any(Number),
      relationshipFactLinkedCandidates: expect.any(Number),
      relationshipFactMissingMutationCandidates: expect.any(Number),
      reputationFactCandidates: expect.any(Number),
      reputationFactLinkedCandidates: expect.any(Number),
      reputationFactMissingMutationCandidates: expect.any(Number)
    });
    expect(result.evaluationReport.metrics.find((item) => item.id === "agent.social.commitment_speech_act_ingest_link_count")).toMatchObject({
      evaluatorId: SOCIAL_FACT_INGEST_EVIDENCE_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subjectId: expect.any(String),
      weight: 0,
      aggregation: "sum",
      metadata: expect.objectContaining({
        candidateKind: "commitment",
        coverageLevel: "explicit_scoped_exposure_to_social_state_mutation",
        causalClaim: false
      })
    });
    expect(result.evaluationReport.metrics.find((item) => item.id === "agent.social.coordination_message_count")).toMatchObject({
      evaluatorId: SOCIAL_DYNAMICS_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      subjectId: expect.any(String),
      subject: expect.objectContaining({ playerId: expect.any(String), model: expect.any(String), policyName: expect.any(String) }),
      denominator: expect.any(Number),
      confidence: expect.any(Number),
      aggregation: "sum",
      evidenceRefs: expect.any(Array)
    });
    expect(result.evaluationReport.outputs[SOCIAL_DYNAMICS_EVALUATOR_ID]).toMatchObject({
      agentCount: initialState.players.length,
      agentsWithSocialState: initialState.players.length,
      influenceEdges: expect.any(Number),
      coordinationMessages: expect.any(Number),
      coalitionSignals: expect.any(Number),
      exposureRecords: deriveSocialExposureRecords(result.socialEpisode).length,
      publicExposureRecords: deriveSocialExposureRecords(result.socialEpisode).filter((record) => record.visibility === "public").length
    });
    expect(result.evaluationReport.outputs[WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID]).toMatchObject({
      agentCount: initialState.players.length,
      agentsWithBeliefSamples: expect.any(Number),
      beliefSamples: expect.any(Number),
      averageWolfBeliefBrierScore: expect.any(Number)
    });
    expect(result.evaluationReport.metrics.find((item) => item.id === "agent.wolf_belief_brier_score")).toMatchObject({
      evaluatorId: WEREWOLF_SOCIAL_CALIBRATION_EVALUATOR_ID,
      evaluatorVersion: "1.0.0",
      scope: "agent",
      aggregation: "average_brier_score",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "agent_state" }),
        expect.objectContaining({ artifact: "state", description: "postgame team truth for wolf belief calibration" })
      ])
    });
    const runtimeExposureRecords = deriveSocialExposureRecords(result.socialEpisode);
    if (runtimeExposureRecords.length > 0) {
      expect(result.evaluationReport.metrics.find((item) => item.id === "agent.social.exposure_received_count" && Number(item.value) > 0)).toMatchObject({
        evaluatorId: SOCIAL_DYNAMICS_EVALUATOR_ID,
        evaluatorVersion: "1.0.0",
        scope: "agent",
        aggregation: "sum",
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ artifact: "message" }),
          expect.objectContaining({ artifact: "trace" })
        ])
      });
    }
    const scorecardAgentIds = [
      ...new Set(
        result.evaluationReport.metrics
          .filter((item) => item.scope === "agent" && item.promotionDecision?.eligibleForScorecard && item.subjectId)
          .map((item) => item.subjectId!)
      )
    ].sort();
    expect(Object.keys(result.evaluationReport.summary.agentScores).sort()).toEqual(scorecardAgentIds);
    expect(Object.keys(result.evaluationReport.summary.profileScores)).toEqual([]);
    expect(artifact.evaluationReport.id).toBe(result.evaluationReport.id);
    const serializableEvaluation = JSON.parse(JSON.stringify(result.evaluation));
    expect(artifact.evaluation).toEqual(serializableEvaluation);
    expect(artifact.evaluationReport.outputs[WEREWOLF_ADVERSARIAL_EVALUATOR_ID]).toEqual(serializableEvaluation);
    expect(artifact.evaluationReport.outputs[WEREWOLF_OUTCOME_EVALUATOR_ID]).toMatchObject({ teamRewards: result.evaluation.teamRewards });
    expect(artifact.evaluationReport.outputs[WEREWOLF_ROLE_SURVIVAL_EVALUATOR_ID]).toMatchObject({
      agentSurvivalByAgent: expect.any(Object),
      survivalByRole: expect.any(Object)
    });
  });
});

describe("legacy influence reward guardrail", () => {
  it("excludes sheriff-only ballots from exile accuracy, influence, and misdirection statistics", () => {
    const state = createGame({ id: "sheriff-only-evaluation-boundary", seed: "sheriff-only-evaluation-boundary" });
    const villages = state.players.filter((player) => player.team === "village");
    const wolf = state.players.find((player) => player.team === "werewolves")!;
    const [speaker, accurateSheriffVoter, villageTarget] = villages;
    const current: GameState = {
      ...state,
      day: 1,
      speeches: [
        {
          day: 1,
          playerId: speaker.id,
          text: `${speaker.id} pressures ${wolf.id}.`,
          pressureTargetId: wolf.id,
          strategyTags: ["pressure"]
        }
      ],
      votes: [
        {
          day: 1,
          voterId: accurateSheriffVoter.id,
          targetId: wolf.id,
          abstain: false,
          weight: 1,
          kind: "sheriff"
        },
        {
          day: 1,
          voterId: speaker.id,
          targetId: villageTarget.id,
          abstain: false,
          weight: 1,
          kind: "sheriff"
        }
      ]
    };

    const evaluation = evaluateAdversarialMatch(current, []);

    expect(evaluation.voteAccuracyByAgent).toEqual({});
    expect(evaluation.influenceByAgent[speaker.id]).toMatchObject({
      pressureCount: 1,
      voteFollowCount: 0,
      influenceRate: 0
    });
    expect(Object.values(evaluation.deceptionByAgent).every((record) => record.misdirectVotes === 0)).toBe(true);
  });

  it("keeps global pressure vote-follow proxy out of reward-bearing metrics", () => {
    const state = createGame({ id: "legacy-influence-reward-guard", seed: "legacy-influence-reward-guard" });
    const [speaker, follower, target] = state.players;
    const current = {
      ...state,
      phase: "game_over" as const,
      day: 2,
      winner: speaker.team,
      speeches: [
        {
          day: 2,
          playerId: speaker.id,
          text: `${speaker.id} pressures ${target.id}.`,
          pressureTargetId: target.id,
          strategyTags: ["pressure"]
        }
      ],
      votes: [
        {
          day: 2,
          voterId: follower.id,
          targetId: target.id,
          abstain: false,
          weight: 1
        }
      ],
      events: [
        ...state.events,
        {
          id: `${state.id}:game-over`,
          seq: state.events.length + 1,
          day: 2,
          phase: "game_over" as const,
          type: "game.ended" as const,
          visibility: "public" as const,
          payload: { winner: speaker.team },
          createdAt: new Date().toISOString()
        }
      ]
    };
    const agents = state.players.map((player) => ({
      playerId: player.id,
      profileId: `${player.id}-profile`,
      model: "guardrail-model",
      temperature: 0,
      policyName: "balanced" as const,
      turns: 0,
      observations: 0,
      beliefs: {},
      privateMemos: []
    }));

    const evaluation = evaluateAdversarialMatch(current, agents);
    expect(evaluation.influenceByAgent[speaker.id]).toMatchObject({
      pressureCount: 1,
      voteFollowCount: 1,
      influenceRate: 1
    });
    expect(evaluation.agentRewards.find((reward) => reward.playerId === speaker.id)?.components.influence).toBe(0);

    const influenceMetric = metricsFromWerewolfInfluenceEvaluation(evaluation, current).find(
      (metric) => metric.id === "agent.influence_rate" && metric.subjectId === speaker.id
    );
    expect(influenceMetric).toMatchObject({
      value: 1,
      weight: 0,
      aggregation: "zero_weight_legacy_ratio",
      metadata: expect.objectContaining({
        rewardBearing: false,
        scopedExposureRequired: false,
        limitation: "legacy_global_speech_vote_proxy_without_scoped_exposure"
      })
    });
  });
});

describe("werewolf evidence fallback precision", () => {
  it("uses vote and pressure records with player ids when event evidence is missing", () => {
    const state = createGame({ id: "evidence-fallback-precision", seed: "evidence-fallback-precision" });
    const voter = state.players.find((player) => player.team === "village")!;
    const target = state.players.find((player) => player.id !== voter.id && player.team === "village")!;
    const current = {
      ...state,
      votes: [
        {
          day: 1,
          voterId: voter.id,
          targetId: target.id,
          abstain: false,
          weight: 1
        }
      ],
      speeches: [
        {
          day: 1,
          playerId: voter.id,
          text: "pressure without event",
          pressureTargetId: target.id,
          strategyTags: []
        }
      ]
    };

    const voteAccuracy = metricsFromWerewolfVoteAccuracyEvaluation(
      {
        winner: "village",
        teamRewards: { village: 1, werewolves: 0 },
        agentRewards: [],
        voteAccuracyByAgent: {
          [voter.id]: { votes: 1, correct: 0, accuracy: 0 }
        },
        influenceByAgent: {},
        deceptionByAgent: {},
        trajectory: []
      },
      current
    ).find((metric) => metric.id === "agent.vote_accuracy" && metric.subjectId === voter.id);

    expect(voteAccuracy?.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifact: "state",
          id: `${voter.id}:vote:d1:1`,
          description: expect.stringContaining(`vote records for ${voter.id}`)
        })
      ])
    );

    const influence = metricsFromWerewolfInfluenceEvaluation(
      {
        winner: "village",
        teamRewards: { village: 1, werewolves: 0 },
        agentRewards: [],
        voteAccuracyByAgent: {},
        influenceByAgent: {
          [voter.id]: { pressureCount: 1, voteFollowCount: 0, influenceRate: 0 }
        },
        deceptionByAgent: {},
        trajectory: []
      },
      current
    ).find((metric) => metric.id === "agent.influence_rate" && metric.subjectId === voter.id);

    expect(influence?.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifact: "state",
          id: `${voter.id}:pressure:d1:1`,
          description: expect.stringContaining(`pressure speeches for ${voter.id}`)
        })
      ])
    );

    const deception = metricsFromWerewolfDeceptionEvaluation(
      {
        winner: "village",
        teamRewards: { village: 1, werewolves: 0 },
        agentRewards: [],
        voteAccuracyByAgent: {},
        influenceByAgent: {},
        deceptionByAgent: {
          [voter.id]: { wolfSurvivalDays: 1, misdirectVotes: 1, score: 0.2 }
        },
        trajectory: []
      },
      current
    ).find((metric) => metric.id === "agent.deception_score" && metric.subjectId === voter.id);

    expect(deception?.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifact: "state",
          id: `${voter.id}:misdirect:d1:1`,
          description: expect.stringContaining("village-on-village misdirect votes")
        })
      ])
    );
  });
});

describe("social lifecycle hidden-truth guardrails", () => {
  it("does not count hidden-truth journal entries as lifecycle temporal associations", () => {
    const social = createAgentSocialState({
      agentId: "p-hidden",
      profile: { id: "profile-hidden", model: "deterministic-test-model", policyId: "balanced" }
    }) as NonNullable<AgentHarnessState["social"]>;

    addSocialCommitment(social, {
      id: "commit-hidden",
      actorId: "p-hidden",
      audienceIds: ["p2"],
      visibility: "public",
      promisedAction: "vote p3",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-commit-hidden", seq: 1 }]
    }, { traceId: "trace-commit-hidden", turnIndex: 1, phase: "day_speech", day: 1 });
    updateSocialCommitmentStatus(social, {
      id: "commit-hidden",
      status: "fulfilled",
      evidenceRefs: [{ artifact: "event", id: "event-commit-hidden", seq: 2 }]
    }, { traceId: "trace-commit-hidden-status", turnIndex: 2, phase: "day_vote", day: 1 });
    addSocialCoalition(social, {
      id: "coalition-hidden",
      memberIds: ["p-hidden", "p2"],
      visibility: "team",
      confidence: 0.8,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-hidden", seq: 3 }]
    }, { traceId: "trace-coalition-hidden", turnIndex: 1, phase: "night", day: 1 });
    recordSocialCoalitionEvidence(social, {
      id: "coalition-hidden",
      kind: "coordination",
      evidenceRefs: [{ artifact: "message", id: "msg-coalition-hidden-coordinate", seq: 4 }]
    }, { traceId: "trace-coalition-hidden-coordinate", turnIndex: 2, phase: "night", day: 1 });
    addSocialNorm(social, {
      id: "norm-hidden",
      kind: "obligation",
      scope: "public-table",
      expectedBehavior: "cite evidence",
      source: "table",
      confidence: 0.8,
      status: "active",
      evidenceRefs: [{ artifact: "message", id: "msg-norm-hidden", seq: 5 }]
    }, { traceId: "trace-norm-hidden", turnIndex: 1, phase: "day_speech", day: 1 });
    updateSocialNormStatus(social, {
      id: "norm-hidden",
      status: "violated",
      evidenceRefs: [{ artifact: "event", id: "event-norm-hidden", seq: 6 }]
    }, { traceId: "trace-norm-hidden-status", turnIndex: 2, phase: "day_vote", day: 1 });
    addSocialNormSanction(social, {
      id: "sanction-hidden",
      normId: "norm-hidden",
      actorId: "p2",
      targetId: "p-hidden",
      audienceIds: ["p-hidden"],
      visibility: "public",
      kind: "warning",
      confidence: 0.8,
      evidenceRefs: [{ artifact: "message", id: "msg-sanction-hidden", seq: 7 }]
    }, { traceId: "trace-sanction-hidden", turnIndex: 1, phase: "day_speech", day: 1 });
    updateSocialNormSanctionStatus(social, {
      id: "sanction-hidden",
      status: "applied",
      evidenceRefs: [{ artifact: "event", id: "event-sanction-hidden", seq: 8 }]
    }, { traceId: "trace-sanction-hidden-status", turnIndex: 2, phase: "day_vote", day: 1 });

    for (const entry of social.journal?.entries ?? []) {
      if (entry.subjectId?.endsWith("-hidden")) {
        (entry as unknown as { hiddenTruthUsed: boolean }).hiddenTruthUsed = true;
      }
    }

    const agents: AgentHarnessState[] = [
      {
        playerId: "p-hidden",
        profileId: "profile-hidden",
        model: "deterministic-test-model",
        temperature: 0,
        policyName: "balanced",
        turns: 1,
        observations: 1,
        beliefs: {},
        privateMemos: [],
        socialStateHash: "hash-hidden-truth",
        social
      }
    ];
    const report = runEvaluationRegistry({
      id: "hidden-truth-lifecycle-guardrail",
      createdAt: new Date(0).toISOString(),
      context: {
        id: "hidden-truth-lifecycle-guardrail",
        status: "completed",
        initialState: {},
        finalState: {},
        agents,
        trajectory: []
      },
      evaluators: [
        createCommitmentCoalitionLifecycleTemporalAssociationEvaluator(),
        createNormSanctionLifecycleTemporalAssociationEvaluator()
      ]
    });

    expect(report.outputs[COMMITMENT_COALITION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      commitmentEvaluableRecords: 0,
      commitmentAssociatedRecords: 0,
      commitmentMissingCreationRecords: 1,
      coalitionEvaluableRecords: 0,
      coalitionAssociatedRecords: 0,
      coalitionMissingCreationRecords: 1
    });
    expect(report.outputs[NORM_SANCTION_LIFECYCLE_TEMPORAL_ASSOCIATION_EVALUATOR_ID]).toMatchObject({
      normEvaluableRecords: 0,
      normAssociatedRecords: 0,
      normMissingCreationRecords: 1,
      normSanctionEvaluableRecords: 0,
      normSanctionAssociatedRecords: 0,
      normSanctionMissingCreationRecords: 1
    });
    expect(report.metrics.find((metric) => metric.id === "agent.social.commitment_status_temporal_association_count")).toMatchObject({
      value: 0,
      denominator: 0,
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "agent_state", id: "p-hidden" })])
    });
    expect(report.metrics.find((metric) => metric.id === "agent.social.norm_status_temporal_association_count")).toMatchObject({
      value: 0,
      denominator: 0,
      evidenceRefs: expect.arrayContaining([expect.objectContaining({ artifact: "agent_state", id: "p-hidden" })])
    });
    expect(JSON.stringify(report.metrics)).not.toContain("msg-commit-hidden");
    expect(JSON.stringify(report.metrics)).not.toContain("msg-coalition-hidden-coordinate");
    expect(JSON.stringify(report.metrics)).not.toContain("msg-norm-hidden");
    expect(JSON.stringify(report.metrics)).not.toContain("msg-sanction-hidden");
  });
});

const stubReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? "我按公开信息发言，优先比较夜晚死亡、发言压力和票型关系，今天先统一视角减少分票。"
        : `evaluation-test:${input.agent.model}:${input.action.kind}:${input.policyPlan.policyName}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        providerRequestId: `evaluation-${input.traceId}`,
        attempts: 1
      }
    };
  }
};
