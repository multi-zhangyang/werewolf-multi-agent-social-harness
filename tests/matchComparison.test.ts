import { describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import type { AgentPendingAction } from "../src/core/pending";
import type { GameCommand, GameState, PlayerView } from "../src/core/types";
import type { MatchArtifact } from "../src/harness/artifacts";
import {
  applyMatchComparisonRowFilterToSearchParams,
  buildMatchComparisonFilterDeepLink,
  buildMatchComparisonArtifact,
  buildTournamentComparisonAggregate,
  filterMatchComparisonRows,
  formatComparisonRegistryEntryLabel,
  formatFilteredMatchComparisonMarkdown,
  formatMatchComparisonMarkdown,
  formatTournamentComparisonMarkdown,
  isMatchComparisonSelectionCurrent,
  MATCH_COMPARISON_ARTIFACT_VERSION,
  MATCH_COMPARISON_FILTERED_ARTIFACT_VERSION,
  MATCH_COMPARISON_MAX_METRIC_ROWS,
  mergeExportedTournamentPackList,
  parseComparisonMatchIdsQuery,
  parseMatchComparisonDeepLinkSelection,
  parseMatchComparisonRowFilterFromSearchParams,
  projectFilteredMatchComparison,
  resolvePackSeededComparisonSelection,
  selectPackSeededComparisonId,
  TOURNAMENT_COMPARISON_ARTIFACT_VERSION,
  type MatchComparisonProjection
} from "../src/harness/matchComparison";
import type { SocialEpisodeArtifact, SocialExposureRecord, SocialMessage } from "../src/harness/social";
import type { SocialHarnessStep } from "../src/harness/social";
import { createAgentSocialState } from "../src/harness/socialState";
import type { AgentHarnessState, HarnessPlayerView, HarnessStepRecord, PolicyPlan } from "../src/harness/types";
import {
  createMetricPromotionCatalogEntry,
  createMetricPromotionPolicy,
  materializeMetricPromotion,
  summarizeMetrics
} from "../src/harness/evaluation";

const PRIVATE_SENTINEL = "PRIVATE_SENTINEL_DO_NOT_LEAK_MATCH_COMPARISON";
const BASE_CREATED_AT = "2026-01-02T03:04:05.000Z";
const CANDIDATE_CREATED_AT = "2026-01-03T03:04:05.000Z";
const COMPARISON_CREATED_AT = "2026-01-04T03:04:05.000Z";
const PROJECTION_GENERATED_AT = "2026-01-01T00:00:00.000Z";


describe("match comparison URL filter helpers", () => {
  it("parses and serializes comparison filter deep-link params without inventing truth", () => {
    const parsed = parseMatchComparisonRowFilterFromSearchParams(
      "?compareGroup=metric_evidence&compareChangedOnly=1&comparePromotion=changed&compareEvidenceIdentity=changed&compareNumericDelta=changed&noise=1"
    );
    expect(parsed).toEqual({
      group: "metric_evidence",
      changedOnly: true,
      promotion: "changed",
      evidenceIdentity: "changed",
      numericDelta: "changed"
    });

    const params = applyMatchComparisonRowFilterToSearchParams(parsed, "noise=1&compareGroup=summary");
    expect(params.get("noise")).toBe("1");
    expect(params.get("compareGroup")).toBe("metric_evidence");
    expect(params.get("compareChangedOnly")).toBe("1");
    expect(params.get("comparePromotion")).toBe("changed");
    expect(params.get("compareEvidenceIdentity")).toBe("changed");
    expect(params.get("compareNumericDelta")).toBe("changed");

    const cleared = applyMatchComparisonRowFilterToSearchParams(
      {
        group: "all",
        changedOnly: false,
        promotion: "all",
        evidenceIdentity: "all",
        numericDelta: "all"
      },
      params
    );
    expect(cleared.get("compareGroup")).toBeNull();
    expect(cleared.get("compareChangedOnly")).toBeNull();
    expect(cleared.get("comparePromotion")).toBeNull();
    expect(cleared.get("compareEvidenceIdentity")).toBeNull();
    expect(cleared.get("compareNumericDelta")).toBeNull();
    expect(cleared.get("noise")).toBe("1");
  });

  it("falls back to defaults for invalid comparison filter deep-link values", () => {
    expect(
      parseMatchComparisonRowFilterFromSearchParams(
        "compareGroup=private&comparePromotion=leaderboard&compareEvidenceIdentity=maybe&compareNumericDelta=nope&compareChangedOnly=maybe"
      )
    ).toEqual({
      group: "all",
      changedOnly: false,
      promotion: "all",
      evidenceIdentity: "all",
      numericDelta: "all"
    });
  });
  it("builds research deep links with workspace, match ids, view, and active filter params only", () => {
    const deepLink = buildMatchComparisonFilterDeepLink({
      origin: "https://example.test",
      pathname: "/cockpit",
      hash: "#matrix",
      search: "noise=1&tab=diagnostics",
      filter: {
        group: "metric",
        changedOnly: true,
        promotion: "scorecard",
        evidenceIdentity: "changed",
        numericDelta: "all"
      },
      workspace: "compare",
      baselineId: "match-baseline",
      candidateId: "match-candidate",
      view: "truth-redacted"
    });
    const url = new URL(deepLink);
    expect(url.origin + url.pathname).toBe("https://example.test/cockpit");
    expect(url.hash).toBe("#matrix");
    expect(url.searchParams.get("noise")).toBe("1");
    expect(url.searchParams.get("workspace")).toBe("compare");
    expect(url.searchParams.get("compareGroup")).toBe("metric");
    expect(url.searchParams.get("compareChangedOnly")).toBe("1");
    expect(url.searchParams.get("comparePromotion")).toBe("scorecard");
    expect(url.searchParams.get("compareEvidenceIdentity")).toBe("changed");
    expect(url.searchParams.get("compareBaseline")).toBe("match-baseline");
    expect(url.searchParams.get("compareCandidate")).toBe("match-candidate");
    expect(url.searchParams.get("compareView")).toBe("truth-redacted");
    expect(parseMatchComparisonDeepLinkSelection(deepLink)).toEqual({
      baselineId: "match-baseline",
      candidateId: "match-candidate",
      view: "truth-redacted"
    });
  });

  it("keeps baseline and candidate ids when rebuilding filter deep links from live search", () => {
    const liveSearch =
      "workspace=compare&compareBaseline=match-a&compareCandidate=match-b&compareGroup=summary&noise=keep";
    const next = buildMatchComparisonFilterDeepLink({
      origin: "https://example.test",
      pathname: "/cockpit",
      search: liveSearch,
      filter: {
        group: "metric_evidence",
        changedOnly: false,
        promotion: "all",
        evidenceIdentity: "all",
        numericDelta: "changed"
      },
      workspace: "compare",
      baselineId: "match-a",
      candidateId: "match-b"
    });
    const url = new URL(next);
    expect(url.origin + url.pathname).toBe("https://example.test/cockpit");
    expect(url.searchParams.get("noise")).toBe("keep");
    expect(url.searchParams.get("workspace")).toBe("compare");
    expect(url.searchParams.get("compareGroup")).toBe("metric_evidence");
    expect(url.searchParams.get("compareNumericDelta")).toBe("changed");
    expect(url.searchParams.get("compareBaseline")).toBe("match-a");
    expect(url.searchParams.get("compareCandidate")).toBe("match-b");
    expect(url.searchParams.get("compareChangedOnly")).toBeNull();
    expect(url.searchParams.get("comparePromotion")).toBeNull();
    expect(url.searchParams.get("compareEvidenceIdentity")).toBeNull();
  });

  it("detects whether a loaded comparison still matches baseline/candidate/view selection", () => {
    const comparison = {
      comparisonId: "cmp-1",
      view: "postgame-redacted",
      baseline: { matchId: "match-a", runId: "run-a" },
      candidate: { matchId: "match-b", runId: "run-b" }
    } as const;
    expect(
      isMatchComparisonSelectionCurrent({
        comparison: comparison as never,
        baselineId: "match-a",
        candidateId: "match-b",
        view: "postgame-redacted"
      })
    ).toBe(true);
    expect(
      isMatchComparisonSelectionCurrent({
        comparison: comparison as never,
        baselineId: "match-a",
        candidateId: "match-c",
        view: "postgame-redacted"
      })
    ).toBe(false);
    expect(
      isMatchComparisonSelectionCurrent({
        comparison: comparison as never,
        baselineId: "match-z",
        candidateId: "match-b",
        view: "postgame-redacted"
      })
    ).toBe(false);
    expect(
      isMatchComparisonSelectionCurrent({
        comparison: comparison as never,
        baselineId: "match-a",
        candidateId: "match-b",
        view: "truth-redacted"
      })
    ).toBe(false);
  });
});

describe("buildMatchComparisonArtifact", () => {
  it("builds a deterministic redacted comparison artifact without leaking private evidence", () => {
    const baselineState = createGame({ id: "comparison-baseline-state", seed: "comparison-baseline-seed" });
    const candidateState = createGame({ id: "comparison-candidate-state", seed: "comparison-candidate-seed" });
    const baseline = matchArtifactFixture({
      state: baselineState,
      runId: "run-baseline",
      matchId: "match-baseline",
      seed: "comparison-baseline-seed",
      createdAt: BASE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 2,
      evaluationWarningCount: 1,
      evaluatorCount: 2,
      modelCalls: 2,
      promptTokens: 40,
      completionTokens: 10,
      latencyMs: 120,
      winner: "village"
    });
    const candidate = matchArtifactFixture({
      state: candidateState,
      runId: "run-candidate",
      matchId: "match-candidate",
      seed: "comparison-candidate-seed",
      createdAt: CANDIDATE_CREATED_AT,
      trajectoryCount: 2,
      socialMessageCount: 3,
      evaluationMetricCount: 4,
      evaluationWarningCount: 2,
      evaluatorCount: 3,
      modelCalls: 5,
      promptTokens: 100,
      completionTokens: 25,
      latencyMs: 300,
      winner: "werewolves"
    });

    const comparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT
    });
    const repeatedComparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: "2030-01-01T00:00:00.000Z"
    });

    expect(comparison).toMatchObject({
      artifactVersion: MATCH_COMPARISON_ARTIFACT_VERSION,
      kind: "match-comparison",
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT,
      projection: {
        view: "postgame-redacted",
        privateEvidenceRedacted: true,
        postgameTruthRedacted: true,
        generatedAt: PROJECTION_GENERATED_AT
      }
    });
    expect(comparison.comparisonId).toMatch(/^match-comparison:[a-f0-9]{24}$/);
    expect(repeatedComparison.comparisonId).toBe(comparison.comparisonId);

    expect(comparison.baseline).toMatchObject({
      matchId: "match-baseline",
      runId: "run-baseline",
      seed: "comparison-baseline-seed",
      createdAt: BASE_CREATED_AT,
      status: "completed",
      models: ["comparison-model"],
      profileCount: 1,
      resolvedAssignmentCount: baselineState.players.length,
      agentCount: 1,
      trajectorySteps: 1,
      socialSteps: 1,
      committedSteps: 1,
      rejectedSteps: 0,
      socialMessages: 1,
      socialSpeechActs: 1,
      socialDeliveryReceipts: baselineState.players.length,
      socialChannels: 1,
      gameEvents: baseline.finalState.events.length,
      evaluationMetricCount: 2,
      evaluationWarningCount: 1,
      evaluatorCount: 2,
      projection: baseline.projection
    });
    expect(comparison.candidate).toMatchObject({
      matchId: "match-candidate",
      runId: "run-candidate",
      seed: "comparison-candidate-seed",
      createdAt: CANDIDATE_CREATED_AT,
      status: "completed",
      models: ["comparison-model"],
      profileCount: 1,
      resolvedAssignmentCount: candidateState.players.length,
      agentCount: 1,
      trajectorySteps: 2,
      socialSteps: 2,
      committedSteps: 2,
      rejectedSteps: 0,
      socialMessages: 3,
      socialSpeechActs: 3,
      socialDeliveryReceipts: candidateState.players.length * 3,
      socialChannels: 1,
      gameEvents: candidate.finalState.events.length,
      evaluationMetricCount: 4,
      evaluationWarningCount: 2,
      evaluatorCount: 3,
      projection: candidate.projection
    });
    expect(comparison.baseline.artifactHash).toBe(comparison.summary.baselineHash);
    expect(comparison.candidate.artifactHash).toBe(comparison.summary.candidateHash);
    expect(comparison.summary).toMatchObject({
      baselineSocialSteps: 1,
      candidateSocialSteps: 2,
      baselineCommittedSteps: 1,
      candidateCommittedSteps: 2,
      baselineRejectedSteps: 0,
      candidateRejectedSteps: 0,
      socialStepsDelta: 1,
      committedStepsDelta: 1,
      rejectedStepsDelta: 0
    });
    expect(comparison.baseline.stateHash).toMatch(/^[a-f0-9]{64}$/);

    const rowsById = new Map(comparison.rows.map((row) => [row.id, row]));
    expect([...rowsById.keys()]).toEqual(
      expect.arrayContaining([
        "status",
        "winner",
        "trajectory_steps",
        "social_steps",
        "committed_steps",
        "rejected_steps",
        "social_messages",
        "social_speech_acts",
        "social_delivery_receipts",
        "social_channels",
        "model_calls",
        "prompt_tokens",
        "completion_tokens",
        "evaluation_metrics",
        "evaluation_warnings",
        "evaluators",
        "scorecard_metrics",
        "diagnostic_metrics",
        "metrics_with_evidence",
        "metric_evidence_refs",
        "social_exposures"
      ])
    );
    expect(rowsById.get("winner")).toMatchObject({ baseline: "village", candidate: "werewolves", changed: true });
    expect(rowsById.get("trajectory_steps")).toMatchObject({ baseline: 1, candidate: 2, delta: 1, changed: true });
    expect(rowsById.get("social_steps")).toMatchObject({ baseline: 1, candidate: 2, delta: 1, changed: true });
    expect(rowsById.get("committed_steps")).toMatchObject({ baseline: 1, candidate: 2, delta: 1, changed: true });
    expect(rowsById.get("rejected_steps")).toMatchObject({ baseline: 0, candidate: 0, delta: 0, changed: false });
    expect(rowsById.get("social_messages")).toMatchObject({ baseline: 1, candidate: 3, delta: 2, changed: true });
    expect(rowsById.get("social_speech_acts")).toMatchObject({ baseline: 1, candidate: 3, delta: 2, changed: true });
    expect(rowsById.get("social_delivery_receipts")).toMatchObject({
      baseline: baselineState.players.length,
      candidate: candidateState.players.length * 3,
      delta: candidateState.players.length * 3 - baselineState.players.length,
      changed: true
    });
    expect(rowsById.get("model_calls")).toMatchObject({ baseline: 2, candidate: 5, delta: 3, changed: true });
    expect(rowsById.get("evaluation_metrics")).toMatchObject({ baseline: 2, candidate: 4, delta: 2, changed: true });
    expect(rowsById.get("scorecard_metrics")).toMatchObject({ baseline: 1, candidate: 1, delta: 0, changed: false });
    expect(rowsById.get("diagnostic_metrics")).toMatchObject({ baseline: 1, candidate: 3, delta: 2, changed: true });
    expect(rowsById.get("scorecard_to_diagnostic_gap")).toMatchObject({ baseline: 0, candidate: -2, delta: -2, changed: true });
    expect(rowsById.get("metrics_with_evidence")).toMatchObject({ baseline: 2, candidate: 2, delta: 0, changed: false });
    expect(rowsById.get("metric_evidence_refs")).toMatchObject({ baseline: 3, candidate: 3, delta: 0, changed: false });
    expect(rowsById.get("social_exposures")).toMatchObject({ baseline: 0, candidate: 0, delta: 0, changed: false });
    expect(rowsById.get("metric:run-candidate:metric:3::episode")).toMatchObject({
      group: "metric",
      metricId: "run-candidate:metric:3",
      baseline: null,
      candidate: 3,
      delta: 3,
      changed: true,
      promotion: {
        baseline: "missing",
        candidate: "diagnostic"
      },
      evidence: {
        baselineRefs: 0,
        candidateRefs: 0,
        baselineKinds: [],
        candidateKinds: [],
        baselineIds: [],
        candidateIds: [],
        onlyBaselineIds: [],
        onlyCandidateIds: []
      }
    });
    expect(rowsById.get("metric:run-candidate:metric:4::episode")).toMatchObject({
      group: "metric",
      metricId: "run-candidate:metric:4",
      baseline: null,
      candidate: 4,
      delta: 4,
      changed: true,
      promotion: {
        baseline: "missing",
        candidate: "diagnostic"
      }
    });
    expect(rowsById.get("metric_promotion:run-candidate:metric:3::episode")).toMatchObject({
      group: "metric",
      metricId: "run-candidate:metric:3",
      baseline: "missing",
      candidate: "diagnostic",
      changed: true
    });
    // Unchanged shared metrics with identical values/evidence are omitted from the
    // metric-diff section to keep comparison focused on divergence.
    expect(rowsById.has("metric:shared.metric.1::episode")).toBe(false);
    expect(rowsById.has("metric:shared.metric.2::episode")).toBe(false);
    const firstUnchangedSummaryIndex = comparison.rows.findIndex((row) => row.group === "summary" && !row.changed);
    const firstChangedIndex = comparison.rows.findIndex((row) => row.changed);
    expect(firstChangedIndex).toBeGreaterThanOrEqual(0);
    if (firstUnchangedSummaryIndex >= 0) {
      expect(firstChangedIndex).toBeLessThan(firstUnchangedSummaryIndex);
    }
    expect(comparison.summary).toEqual({
      rowCount: comparison.rows.length,
      changedRowCount: comparison.rows.filter((row) => row.changed).length,
      numericDeltaCount: comparison.rows.filter((row) => row.delta !== undefined).length,
      promotionChangedMetricCount: comparison.rows.filter(
        (row) => row.id.startsWith("metric_promotion:") && row.changed
      ).length,
      promotionProvenanceChangedMetricCount: 0,
      scorecardMetricDelta: 0,
      diagnosticMetricDelta: 2,
      benchmarkOnlyMetricDelta: 0,
      metricKeysCompared: expect.any(Number),
      metricKeysEmitted: expect.any(Number),
      metricKeysTruncated: 0,
      scorecardMetricKeysCompared: expect.any(Number),
      scorecardMetricKeysEmitted: expect.any(Number),
      scorecardMetricKeysTruncated: 0,
      diagnosticMetricKeysCompared: expect.any(Number),
      diagnosticMetricKeysEmitted: expect.any(Number),
      diagnosticMetricKeysTruncated: 0,
      benchmarkOnlyMetricKeysCompared: expect.any(Number),
      benchmarkOnlyMetricKeysEmitted: expect.any(Number),
      benchmarkOnlyMetricKeysTruncated: 0,
      evidenceIdentityChangedMetricCount: 0,
      evidenceIdentityOnlyBaselineRefCount: 0,
      evidenceIdentityOnlyCandidateRefCount: 0,
      baselineSocialSteps: 1,
      candidateSocialSteps: 2,
      baselineCommittedSteps: 1,
      candidateCommittedSteps: 2,
      baselineRejectedSteps: 0,
      candidateRejectedSteps: 0,
      socialStepsDelta: 1,
      committedStepsDelta: 1,
      rejectedStepsDelta: 0,
      metricRowsMax: 64,
      baselineHash: comparison.baseline.artifactHash,
      candidateHash: comparison.candidate.artifactHash
    });
    expect(comparison.summary.promotionChangedMetricCount).toBeGreaterThanOrEqual(2);
    expect(comparison.summary.metricKeysCompared).toBeGreaterThanOrEqual(comparison.summary.metricKeysEmitted);
    expect(rowsById.get("benchmark_only_metrics")).toMatchObject({
      baseline: 0,
      candidate: 0,
      delta: 0,
      changed: false
    });
    expect(JSON.stringify(comparison)).not.toContain(PRIVATE_SENTINEL);
    const markdown = formatMatchComparisonMarkdown(comparison);
    expect(markdown).toContain("# Match Comparison");
    expect(markdown).toContain(comparison.comparisonId);
    expect(markdown).toContain("## Changed Rows");
    expect(markdown).toContain("metric:run-candidate:metric:3::episode");
    expect(markdown).toContain("| yes |");
    expect(markdown).toContain("socialStepsDelta=1");
    expect(markdown).toContain("committedStepsDelta=1");
    expect(markdown).toContain("rejectedStepsDelta=0");
    expect(markdown).toContain("committedSteps: 1");
    expect(markdown).toContain("committedSteps: 2");
    expect(markdown).not.toContain(PRIVATE_SENTINEL);
  });

  it("emits a metric-level provenance diff when a recorded policy changes without changing class, value, or evidence", () => {
    const baselineState = createGame({ id: "comparison-provenance-baseline", seed: "comparison-provenance-seed" });
    const candidateState = createGame({ id: "comparison-provenance-candidate", seed: "comparison-provenance-seed" });
    const baseline = matchArtifactFixture({
      state: baselineState,
      runId: "run-provenance-baseline",
      matchId: "match-provenance-baseline",
      seed: "comparison-provenance-seed",
      createdAt: BASE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 20,
      winner: "village"
    });
    const candidate = matchArtifactFixture({
      state: candidateState,
      runId: "run-provenance-candidate",
      matchId: "match-provenance-candidate",
      seed: "comparison-provenance-seed",
      createdAt: CANDIDATE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 20,
      winner: "village"
    });
    const baselinePolicy = comparisonMetricPromotionPolicy("comparison.provenance.baseline", "comparison.provenance.baseline.catalog");
    const candidatePolicy = comparisonMetricPromotionPolicy("comparison.provenance.candidate", "comparison.provenance.candidate.catalog");
    const baselineMetric = baseline.evaluationReport.metrics[0];
    const candidateMetric = candidate.evaluationReport.metrics[0];
    if (!baselineMetric || !candidateMetric) throw new Error("Expected a shared metric fixture.");

    baseline.evaluationReport.metrics[0] = materializeMetricPromotion(baselineMetric, baselinePolicy);
    candidate.evaluationReport.metrics[0] = materializeMetricPromotion(candidateMetric, candidatePolicy);
    baseline.evaluationReport.summary = summarizeMetrics(baseline.evaluationReport.metrics, baselinePolicy);
    candidate.evaluationReport.summary = summarizeMetrics(candidate.evaluationReport.metrics, candidatePolicy);

    const comparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT
    });
    const metricKey = "shared.metric.1::episode";
    const rowsById = new Map(comparison.rows.map((row) => [row.id, row]));
    const metricRow = rowsById.get(`metric:${metricKey}`);
    const promotionRow = rowsById.get(`metric_promotion:${metricKey}`);

    expect(metricRow).toMatchObject({
      baseline: 1,
      candidate: 1,
      changed: true,
      promotion: {
        baseline: "scorecard",
        candidate: "scorecard",
        details: {
          changed: true,
          changedFields: ["catalogDecisionId", "policy", "catalog"]
        }
      }
    });
    expect(promotionRow).toMatchObject({
      changed: true,
      promotion: {
        baseline: "scorecard",
        candidate: "scorecard",
        details: {
          changed: true,
          changedFields: ["catalogDecisionId", "policy", "catalog"]
        }
      }
    });
    expect(comparison.summary).toMatchObject({
      promotionChangedMetricCount: 1,
      promotionProvenanceChangedMetricCount: 1
    });
    expect(filterMatchComparisonRows(comparison.rows, { promotion: "changed" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: `metric_promotion:${metricKey}` })])
    );
    const filtered = projectFilteredMatchComparison(comparison, { promotion: "changed" }, { createdAt: COMPARISON_CREATED_AT });
    expect(filtered.summary.promotionProvenanceChangedMetricCount).toBe(1);
    expect(formatMatchComparisonMarkdown(comparison)).toContain("catalogDecisionId,policy,catalog");
  });

  it("prefers projected social exposure counts before deriving from redacted observations", () => {
    const baselineState = createGame({ id: "comparison-projected-baseline-state", seed: "comparison-projected-baseline-seed" });
    const candidateState = createGame({ id: "comparison-projected-candidate-state", seed: "comparison-projected-candidate-seed" });
    const baseline = matchArtifactFixture({
      state: baselineState,
      runId: "run-projected-baseline",
      matchId: "match-projected-baseline",
      seed: "comparison-projected-baseline-seed",
      createdAt: BASE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 20,
      winner: "village"
    });
    const candidate = matchArtifactFixture({
      state: candidateState,
      runId: "run-projected-candidate",
      matchId: "match-projected-candidate",
      seed: "comparison-projected-candidate-seed",
      createdAt: CANDIDATE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 20,
      winner: "werewolves"
    });
    attachProjectedExposureRecords(baseline, 2);
    attachProjectedExposureRecords(candidate, 5);

    const comparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT
    });
    const rowsById = new Map(comparison.rows.map((row) => [row.id, row]));

    expect(rowsById.get("social_exposures")).toMatchObject({ baseline: 2, candidate: 5, delta: 3, changed: true });
  });

  it("reports metric key truncation when changed metrics exceed the emit cap", () => {
    const baselineState = createGame({ id: "comparison-truncation-baseline", seed: "comparison-truncation-baseline" });
    const candidateState = createGame({ id: "comparison-truncation-candidate", seed: "comparison-truncation-candidate" });
    const baseline = matchArtifactFixture({
      state: baselineState,
      runId: "run-truncation-baseline",
      matchId: "match-truncation-baseline",
      seed: "comparison-truncation-baseline",
      createdAt: BASE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 2,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 20,
      winner: "village"
    });
    const candidate = matchArtifactFixture({
      state: candidateState,
      runId: "run-truncation-candidate",
      matchId: "match-truncation-candidate",
      seed: "comparison-truncation-candidate",
      createdAt: CANDIDATE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: MATCH_COMPARISON_MAX_METRIC_ROWS + 8,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 20,
      winner: "werewolves"
    });

    // A late-id scorecard metric would sort after many diagnostic keys under pure
    // lexicographic order. Scorecard-first emission must still keep it.
    const lateScorecard = candidate.evaluationReport.metrics.at(-1);
    if (!lateScorecard) throw new Error("Expected truncation fixture metrics.");
    lateScorecard.id = "zzz.scorecard.metric";
    lateScorecard.label = "Late scorecard metric";
    lateScorecard.weight = 1;
    lateScorecard.evidenceRefs = [{ artifact: "state", description: "scorecard evidence" }];
    lateScorecard.promotionClass = "scorecard";
    candidate.evaluationReport.summary = summarizeMetrics(candidate.evaluationReport.metrics);

    const comparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT
    });
    const rowsById = new Map(comparison.rows.map((row) => [row.id, row]));
    expect(comparison.summary.metricKeysCompared).toBeGreaterThan(MATCH_COMPARISON_MAX_METRIC_ROWS);
    expect(comparison.summary.metricKeysEmitted).toBe(MATCH_COMPARISON_MAX_METRIC_ROWS);
    // Unchanged shared metric keys are skipped before the emit cap and are neither
    // emitted nor truncated, so truncated is not simply compared - emitted.
    expect(comparison.summary.metricKeysTruncated).toBeGreaterThan(0);
    expect(
      comparison.summary.metricKeysEmitted + comparison.summary.metricKeysTruncated
    ).toBeLessThanOrEqual(comparison.summary.metricKeysCompared);
    expect(comparison.summary.metricRowsMax).toBe(MATCH_COMPARISON_MAX_METRIC_ROWS);
    expect(comparison.summary.scorecardMetricKeysCompared).toBeGreaterThanOrEqual(1);
    expect(comparison.summary.scorecardMetricKeysEmitted).toBe(
      comparison.summary.scorecardMetricKeysCompared
    );
    expect(comparison.summary.scorecardMetricKeysTruncated).toBe(0);
    expect(comparison.summary.diagnosticMetricKeysCompared).toBeGreaterThan(0);
    expect(comparison.summary.diagnosticMetricKeysTruncated).toBeGreaterThan(0);
    expect(
      comparison.summary.diagnosticMetricKeysEmitted + comparison.summary.diagnosticMetricKeysTruncated
    ).toBeLessThanOrEqual(comparison.summary.diagnosticMetricKeysCompared);
    expect(rowsById.get("metric:zzz.scorecard.metric::episode")).toMatchObject({
      group: "metric",
      metricId: "zzz.scorecard.metric",
      promotion: {
        baseline: "missing",
        candidate: "scorecard"
      },
      changed: true
    });
    expect(rowsById.get("scorecard_metric_keys_truncated")).toMatchObject({
      baseline: 0,
      candidate: 0,
      changed: false
    });
    expect(rowsById.get("diagnostic_metric_keys_truncated")).toMatchObject({
      baseline: comparison.summary.diagnosticMetricKeysTruncated,
      candidate: comparison.summary.diagnosticMetricKeysTruncated,
      changed: false
    });
    expect(rowsById.get("benchmark_only_metric_keys_truncated")).toMatchObject({
      baseline: comparison.summary.benchmarkOnlyMetricKeysTruncated,
      candidate: comparison.summary.benchmarkOnlyMetricKeysTruncated,
      changed: false
    });
    expect(rowsById.get("metric_keys_compared")).toMatchObject({
      baseline: comparison.summary.metricKeysCompared,
      candidate: comparison.summary.metricKeysCompared,
      changed: false
    });
    expect(rowsById.get("metric_keys_emitted")).toMatchObject({
      baseline: MATCH_COMPARISON_MAX_METRIC_ROWS,
      candidate: MATCH_COMPARISON_MAX_METRIC_ROWS,
      changed: false
    });
    expect(rowsById.get("metric_keys_truncated")).toMatchObject({
      baseline: comparison.summary.metricKeysTruncated,
      candidate: comparison.summary.metricKeysTruncated,
      changed: false
    });
    expect(rowsById.get("metric_rows_max")).toMatchObject({
      baseline: MATCH_COMPARISON_MAX_METRIC_ROWS,
      candidate: MATCH_COMPARISON_MAX_METRIC_ROWS,
      changed: false
    });
    expect(comparison.rows.filter((row) => row.id.startsWith("metric:")).length).toBeLessThanOrEqual(
      MATCH_COMPARISON_MAX_METRIC_ROWS
    );
  });

  it("diffs evidence-ref identity sets even when counts and kinds match", () => {
    const baselineState = createGame({ id: "comparison-evidence-ids-baseline", seed: "comparison-evidence-ids-baseline" });
    const candidateState = createGame({ id: "comparison-evidence-ids-candidate", seed: "comparison-evidence-ids-candidate" });
    const baseline = matchArtifactFixture({
      state: baselineState,
      runId: "run-evidence-ids-baseline",
      matchId: "match-evidence-ids-baseline",
      seed: "comparison-evidence-ids-baseline",
      createdAt: COMPARISON_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      winner: "village"
    });
    const candidate = matchArtifactFixture({
      state: candidateState,
      runId: "run-evidence-ids-candidate",
      matchId: "match-evidence-ids-candidate",
      seed: "comparison-evidence-ids-candidate",
      createdAt: COMPARISON_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      winner: "village"
    });

    baseline.evaluationReport.metrics = [
      {
        id: "shared.metric.evidence-identity",
        label: "Shared evidence identity metric",
        scope: "episode",
        value: 1,
        weight: 0,
        source: "matchComparison.test",
        evidenceRefs: [
          { artifact: "message", id: "msg-a", seq: 1, description: PRIVATE_SENTINEL },
          { artifact: "trace", traceId: "trace-shared", description: PRIVATE_SENTINEL }
        ]
      }
    ];
    candidate.evaluationReport.metrics = [
      {
        id: "shared.metric.evidence-identity",
        label: "Shared evidence identity metric",
        scope: "episode",
        value: 1,
        weight: 0,
        source: "matchComparison.test",
        evidenceRefs: [
          { artifact: "message", id: "msg-b", seq: 1, description: PRIVATE_SENTINEL },
          { artifact: "trace", traceId: "trace-shared", description: PRIVATE_SENTINEL }
        ]
      }
    ];
    baseline.evaluationReport.summary = summarizeMetrics(baseline.evaluationReport.metrics);
    candidate.evaluationReport.summary = summarizeMetrics(candidate.evaluationReport.metrics);
    baseline.evaluationReport.metricCount = baseline.evaluationReport.metrics.length;
    candidate.evaluationReport.metricCount = candidate.evaluationReport.metrics.length;

    const comparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT
    });
    const rowsById = new Map(comparison.rows.map((row) => [row.id, row]));
    const metricRow = rowsById.get("metric:shared.metric.evidence-identity::episode");
    expect(metricRow).toMatchObject({
      group: "metric",
      metricId: "shared.metric.evidence-identity",
      baseline: 1,
      candidate: 1,
      changed: false,
      evidence: {
        baselineRefs: 2,
        candidateRefs: 2,
        baselineKinds: ["message", "trace"],
        candidateKinds: ["message", "trace"],
        onlyBaselineIds: ["artifact=message|id=msg-a|seq=1"],
        onlyCandidateIds: ["artifact=message|id=msg-b|seq=1"]
      }
    });
    expect(metricRow?.evidence?.baselineIds).toEqual([
      "artifact=message|id=msg-a|seq=1",
      "artifact=trace|traceId=trace-shared"
    ]);
    expect(metricRow?.evidence?.candidateIds).toEqual([
      "artifact=message|id=msg-b|seq=1",
      "artifact=trace|traceId=trace-shared"
    ]);
    expect(rowsById.get("metric_evidence:shared.metric.evidence-identity::episode")).toMatchObject({
      group: "metric_evidence",
      baseline: 2,
      candidate: 2,
      changed: false
    });
    expect(rowsById.get("metric_evidence_ids:shared.metric.evidence-identity::episode")).toMatchObject({
      group: "metric_evidence",
      baseline: "baseline-only:1 · artifact=message|id=msg-a|seq=1",
      candidate: "candidate-only:1 · artifact=message|id=msg-b|seq=1",
      changed: true
    });
    expect(rowsById.has("metric_evidence_kinds:shared.metric.evidence-identity::episode")).toBe(false);
    expect(comparison.summary.evidenceIdentityChangedMetricCount).toBe(1);
    expect(comparison.summary.evidenceIdentityOnlyBaselineRefCount).toBe(1);
    expect(comparison.summary.evidenceIdentityOnlyCandidateRefCount).toBe(1);
    expect(rowsById.get("evidence_identity_changed_metrics")).toMatchObject({
      baseline: 1,
      candidate: 1,
      changed: false
    });
    expect(JSON.stringify(comparison)).not.toContain(PRIVATE_SENTINEL);
    const markdown = formatMatchComparisonMarkdown(comparison);
    expect(markdown).toContain("metric_evidence_ids:shared.metric.evidence-identity::episode");
    expect(markdown).toContain("Δids 1→1");
    expect(markdown).toContain("evidenceIdentityChangedMetrics=1");
    expect(markdown).not.toContain(PRIVATE_SENTINEL);
  });


  it("filters rows by evidence identity changes through pure helper", () => {
    const baselineState = createGame({ id: "comparison-filter-baseline", seed: "comparison-filter-baseline" });
    const candidateState = createGame({ id: "comparison-filter-candidate", seed: "comparison-filter-candidate" });
    const baseline = matchArtifactFixture({
      state: baselineState,
      runId: "run-filter-baseline",
      matchId: "match-filter-baseline",
      seed: "comparison-filter-baseline",
      createdAt: COMPARISON_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      winner: "village"
    });
    const candidate = matchArtifactFixture({
      state: candidateState,
      runId: "run-filter-candidate",
      matchId: "match-filter-candidate",
      seed: "comparison-filter-candidate",
      createdAt: COMPARISON_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      winner: "village"
    });

    baseline.evaluationReport.metrics = [
      {
        id: "shared.metric.evidence-identity",
        label: "Shared evidence identity metric",
        scope: "episode",
        value: 1,
        weight: 0,
        source: "matchComparison.test",
        evidenceRefs: [
          { artifact: "message", id: "msg-a", seq: 1, description: PRIVATE_SENTINEL },
          { artifact: "trace", traceId: "trace-shared", description: PRIVATE_SENTINEL }
        ]
      }
    ];
    candidate.evaluationReport.metrics = [
      {
        id: "shared.metric.evidence-identity",
        label: "Shared evidence identity metric",
        scope: "episode",
        value: 1,
        weight: 0,
        source: "matchComparison.test",
        evidenceRefs: [
          { artifact: "message", id: "msg-b", seq: 1, description: PRIVATE_SENTINEL },
          { artifact: "trace", traceId: "trace-shared", description: PRIVATE_SENTINEL }
        ]
      }
    ];
    baseline.evaluationReport.summary = summarizeMetrics(baseline.evaluationReport.metrics);
    candidate.evaluationReport.summary = summarizeMetrics(candidate.evaluationReport.metrics);
    baseline.evaluationReport.metricCount = baseline.evaluationReport.metrics.length;
    candidate.evaluationReport.metricCount = candidate.evaluationReport.metrics.length;

    const comparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT
    });

    const identityRows = filterMatchComparisonRows(comparison.rows, {
      evidenceIdentity: "changed"
    });
    expect(identityRows.length).toBeGreaterThan(0);
    expect(identityRows.every((row) => {
      const onlyBaseline = row.evidence?.onlyBaselineIds.length ?? 0;
      const onlyCandidate = row.evidence?.onlyCandidateIds.length ?? 0;
      return onlyBaseline > 0 || onlyCandidate > 0;
    })).toBe(true);
    expect(identityRows.some((row) => row.id === "metric_evidence_ids:shared.metric.evidence-identity::episode")).toBe(
      true
    );

    const metricIdentityRows = filterMatchComparisonRows(comparison.rows, {
      group: "metric",
      evidenceIdentity: "changed"
    });
    expect(metricIdentityRows).toHaveLength(1);
    expect(metricIdentityRows[0]?.id).toBe("metric:shared.metric.evidence-identity::episode");

    const unchangedOnly = filterMatchComparisonRows(comparison.rows, {
      changedOnly: true,
      evidenceIdentity: "all"
    });
    expect(unchangedOnly.every((row) => row.changed)).toBe(true);

    const numericDeltaRows = filterMatchComparisonRows(comparison.rows, {
      numericDelta: "changed"
    });
    expect(numericDeltaRows.length).toBeGreaterThan(0);
    expect(numericDeltaRows.every((row) => row.delta !== undefined)).toBe(true);
  });


  it("projects filtered comparison views without inventing comparison truth", () => {
    const baselineState = createGame({ id: "comparison-filtered-baseline", seed: "comparison-filtered-baseline" });
    const candidateState = createGame({ id: "comparison-filtered-candidate", seed: "comparison-filtered-candidate" });
    const baseline = matchArtifactFixture({
      state: baselineState,
      runId: "run-filtered-baseline",
      matchId: "match-filtered-baseline",
      seed: "comparison-filtered-baseline",
      createdAt: COMPARISON_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      winner: "village"
    });
    const candidate = matchArtifactFixture({
      state: candidateState,
      runId: "run-filtered-candidate",
      matchId: "match-filtered-candidate",
      seed: "comparison-filtered-candidate",
      createdAt: COMPARISON_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      winner: "village"
    });

    baseline.evaluationReport.metrics = [
      {
        id: "shared.metric.evidence-identity",
        label: "Shared evidence identity metric",
        scope: "episode",
        value: 1,
        weight: 0,
        source: "matchComparison.test",
        evidenceRefs: [
          { artifact: "message", id: "msg-a", seq: 1, description: PRIVATE_SENTINEL },
          { artifact: "trace", traceId: "trace-shared", description: PRIVATE_SENTINEL }
        ]
      }
    ];
    candidate.evaluationReport.metrics = [
      {
        id: "shared.metric.evidence-identity",
        label: "Shared evidence identity metric",
        scope: "episode",
        value: 1,
        weight: 0,
        source: "matchComparison.test",
        evidenceRefs: [
          { artifact: "message", id: "msg-b", seq: 1, description: PRIVATE_SENTINEL },
          { artifact: "trace", traceId: "trace-shared", description: PRIVATE_SENTINEL }
        ]
      }
    ];
    baseline.evaluationReport.summary = summarizeMetrics(baseline.evaluationReport.metrics);
    candidate.evaluationReport.summary = summarizeMetrics(candidate.evaluationReport.metrics);
    baseline.evaluationReport.metricCount = baseline.evaluationReport.metrics.length;
    candidate.evaluationReport.metricCount = candidate.evaluationReport.metrics.length;

    const comparison = buildMatchComparisonArtifact({
      baseline,
      candidate,
      view: "postgame-redacted",
      createdAt: COMPARISON_CREATED_AT
    });
    const filtered = projectFilteredMatchComparison(
      comparison,
      {
        group: "metric_evidence",
        evidenceIdentity: "changed"
      },
      { createdAt: COMPARISON_CREATED_AT }
    );

    expect(filtered).toMatchObject({
      artifactVersion: MATCH_COMPARISON_FILTERED_ARTIFACT_VERSION,
      kind: "match-comparison-filtered",
      sourceComparisonId: comparison.comparisonId,
      createdAt: COMPARISON_CREATED_AT,
      view: "postgame-redacted",
      filter: {
        group: "metric_evidence",
        changedOnly: false,
        promotion: "all",
        evidenceIdentity: "changed",
        numericDelta: "all"
      },
      source: {
        comparisonId: comparison.comparisonId,
        summary: comparison.summary
      },
      summary: {
        rowCount: 2,
        changedRowCount: 1,
        numericDeltaCount: expect.any(Number),
        promotionChangedMetricCount: expect.any(Number),
        evidenceIdentityChangedMetricCount: 1,
        evidenceIdentityOnlyBaselineRefCount: 1,
        evidenceIdentityOnlyCandidateRefCount: 1,
        summaryRowCount: 0,
        metricRowCount: 0,
        metricEvidenceRowCount: 2,
        sourceRowCount: comparison.summary.rowCount,
        sourceChangedRowCount: comparison.summary.changedRowCount
      }
    });
    expect(filtered.rows.map((row) => row.id).sort()).toEqual([
      "metric_evidence:shared.metric.evidence-identity::episode",
      "metric_evidence_ids:shared.metric.evidence-identity::episode"
    ].sort());
    expect(JSON.stringify(filtered)).not.toContain(PRIVATE_SENTINEL);

    const markdown = formatFilteredMatchComparisonMarkdown(filtered);
    expect(markdown).toContain("# Match Comparison Filtered View");
    expect(markdown).toContain(comparison.comparisonId);
    expect(markdown).toContain("evidenceIdentity=changed");
    expect(markdown).toContain("metric_evidence_ids:shared.metric.evidence-identity::episode");
    expect(markdown).toContain("Δids 1→1");
    expect(markdown).toContain("sourceSocialStepsDelta=");
    expect(markdown).toContain("sourceCommittedStepsDelta=");
    expect(markdown).toContain("sourceRejectedStepsDelta=");
    expect(markdown).not.toContain(PRIVATE_SENTINEL);
  });

});

describe("selectPackSeededComparisonId", () => {
  it("selects only comparisons whose baseline and candidate belong to the pack", () => {
    const entries = [
      {
        comparisonId: "match-comparison:old-pack",
        createdAt: "2026-01-05T00:00:00.000Z",
        baseline: { matchId: "old-1", runId: "old-1" },
        candidate: { matchId: "old-2", runId: "old-2" }
      },
      {
        comparisonId: "match-comparison:new-pack",
        createdAt: "2026-01-04T00:00:00.000Z",
        baseline: { matchId: "pack-1", runId: "pack-1" },
        candidate: { matchId: "pack-2", runId: "pack-2" }
      }
    ];
    expect(selectPackSeededComparisonId(entries, new Set(["pack-1", "pack-2"]))).toBe(
      "match-comparison:new-pack"
    );
  });

  it("returns empty when fewer than two pack ids or no matching pair exists", () => {
    const entries = [
      {
        comparisonId: "match-comparison:partial",
        createdAt: "2026-01-05T00:00:00.000Z",
        baseline: { matchId: "pack-1", runId: "pack-1" },
        candidate: { matchId: "other", runId: "other" }
      }
    ];
    expect(selectPackSeededComparisonId(entries, new Set(["pack-1"]))).toBe("");
    expect(selectPackSeededComparisonId(entries, new Set(["pack-1", "pack-2"]))).toBe("");
    expect(selectPackSeededComparisonId([], new Set(["pack-1", "pack-2"]))).toBe("");
  });

  it("accepts runId matches when matchId is absent", () => {
    const entries = [
      {
        comparisonId: "match-comparison:run-ids",
        createdAt: "2026-01-05T00:00:00.000Z",
        baseline: { runId: "run-a" },
        candidate: { runId: "run-b" }
      }
    ];
    expect(selectPackSeededComparisonId(entries, new Set(["run-a", "run-b"]))).toBe(
      "match-comparison:run-ids"
    );
  });
});

describe("parseComparisonMatchIdsQuery", () => {
  it("parses comma-separated and repeated string values into a set", () => {
    expect(Array.from(parseComparisonMatchIdsQuery("pack-1, pack-2") ?? []).sort()).toEqual([
      "pack-1",
      "pack-2"
    ]);
    expect(Array.from(parseComparisonMatchIdsQuery(["pack-1", "pack-2,pack-3"]) ?? []).sort()).toEqual([
      "pack-1",
      "pack-2",
      "pack-3"
    ]);
  });

  it("returns null for fewer than two ids or non-string input", () => {
    expect(parseComparisonMatchIdsQuery("pack-1")).toBeNull();
    expect(parseComparisonMatchIdsQuery(["pack-1", "  "])).toBeNull();
    expect(parseComparisonMatchIdsQuery(null)).toBeNull();
    expect(parseComparisonMatchIdsQuery(12)).toBeNull();
  });
});


describe("resolvePackSeededComparisonSelection", () => {
  const packEntries = [
    {
      comparisonId: "match-comparison:pack-pair",
      createdAt: "2026-01-05T00:00:00.000Z",
      baseline: { matchId: "pack-1", runId: "pack-1" },
      candidate: { matchId: "pack-2", runId: "pack-2" }
    }
  ];
  const fullEntries = [
    {
      comparisonId: "match-comparison:other-pack",
      createdAt: "2026-01-06T00:00:00.000Z",
      baseline: { matchId: "old-1", runId: "old-1" },
      candidate: { matchId: "old-2", runId: "old-2" }
    },
    {
      comparisonId: "match-comparison:pack-pair-full",
      createdAt: "2026-01-04T00:00:00.000Z",
      baseline: { matchId: "pack-1", runId: "pack-1" },
      candidate: { matchId: "pack-2", runId: "pack-2" }
    }
  ];

  it("prefers a successful pack-scoped selection", () => {
    expect(
      resolvePackSeededComparisonSelection({
        packMatchIds: ["pack-1", "pack-2"],
        packScopedEntries: packEntries,
        packScopedRefreshOk: true,
        fullEntries
      })
    ).toEqual({
      comparisonId: "match-comparison:pack-pair",
      source: "pack-scoped",
      degradedNotes: []
    });
  });

  it("falls back to the full registry when pack-scoped list is empty", () => {
    expect(
      resolvePackSeededComparisonSelection({
        packMatchIds: ["pack-1", "pack-2"],
        packScopedEntries: [],
        packScopedRefreshOk: true,
        fullEntries
      })
    ).toEqual({
      comparisonId: "match-comparison:pack-pair-full",
      source: "full-registry-fallback",
      degradedNotes: ["pack-scoped-comparison-empty-fallback"]
    });
  });

  it("falls back when pack-scoped refresh fails", () => {
    expect(
      resolvePackSeededComparisonSelection({
        packMatchIds: ["pack-1", "pack-2"],
        packScopedEntries: null,
        packScopedRefreshOk: false,
        fullEntries
      })
    ).toEqual({
      comparisonId: "match-comparison:pack-pair-full",
      source: "full-registry-fallback",
      degradedNotes: ["pack-scoped-comparison-refresh-degraded"]
    });
  });

  it("does not invent a hit for single-episode packs", () => {
    expect(
      resolvePackSeededComparisonSelection({
        packMatchIds: ["pack-1"],
        packScopedEntries: packEntries,
        packScopedRefreshOk: true,
        fullEntries
      })
    ).toEqual({
      comparisonId: "",
      source: "none",
      degradedNotes: []
    });
  });
});

describe("formatComparisonRegistryEntryLabel", () => {
  it("formats pair context and optional deltas without inventing truth", () => {
    expect(
      formatComparisonRegistryEntryLabel({
        comparisonId: "match-comparison:abcdef0123456789",
        view: "truth-redacted",
        baseline: { matchId: "tournament-seed-1", runId: "run-1" },
        candidate: { runId: "run-candidate-long" },
        summary: {
          rowCount: 12,
          changedRowCount: 4,
          numericDeltaCount: 2,
          promotionChangedMetricCount: 1,
          scorecardMetricDelta: 1,
          diagnosticMetricDelta: 5,
          benchmarkOnlyMetricDelta: 0,
          evidenceIdentityChangedMetricCount: 2,
          evidenceIdentityOnlyBaselineRefCount: 1,
          evidenceIdentityOnlyCandidateRefCount: 3,
          metricKeysCompared: 40,
          metricKeysEmitted: 37,
          metricKeysTruncated: 3,
          scorecardMetricKeysTruncated: 1,
          diagnosticMetricKeysTruncated: 2,
          benchmarkOnlyMetricKeysTruncated: 0,
          metricRowsMax: 50,
          socialStepsDelta: 2,
          committedStepsDelta: 1,
          rejectedStepsDelta: 0
        }
      })
    ).toBe(
      "cmp:abcdef01 · truth-redacted · tourname→run-cand · Δ4/12 · numΔ2 · promoΔ1 · scoreΔ1 · diagΔ5 · benchΔ0 · evidΔ2 · evidOnly 1→3 · cΔ1/rΔ0 · keys 37/40 · max50 · scoreTrunc1 · diagTrunc2"
    );
  });

  it("omits optional deltas when absent", () => {
    expect(
      formatComparisonRegistryEntryLabel({
        comparisonId: "cmp-short",
        view: "postgame-redacted",
        baseline: { runId: "b1" },
        candidate: { matchId: "c1", runId: "c-run" },
        summary: {
          rowCount: 3,
          changedRowCount: 0
        }
      })
    ).toBe("cmp-short · postgame-redacted · b1→c1 · Δ0/3");
  });
});



describe("mergeExportedTournamentPackList", () => {
  it("keeps the refreshed list when it already contains the exported pack", () => {
    const exported = { artifactSetId: "pack-new", seed: "new" };
    const listed = [
      { artifactSetId: "pack-new", seed: "listed-new" },
      { artifactSetId: "pack-old", seed: "old" }
    ];
    expect(
      mergeExportedTournamentPackList({
        exportedPack: exported,
        listedPacks: listed
      })
    ).toEqual({
      packs: listed,
      note: "ok"
    });
  });

  it("prepends the exported pack when the refreshed list is stale", () => {
    const exported = { artifactSetId: "pack-new", seed: "new" };
    const listed = [{ artifactSetId: "pack-old", seed: "old" }];
    expect(
      mergeExportedTournamentPackList({
        exportedPack: exported,
        listedPacks: listed
      })
    ).toEqual({
      packs: [exported, ...listed],
      note: "pack-list-stale"
    });
  });

  it("falls back to the exported pack when list refresh failed", () => {
    const exported = { artifactSetId: "pack-new", seed: "new" };
    expect(
      mergeExportedTournamentPackList({
        exportedPack: exported,
        listRefreshFailed: true
      })
    ).toEqual({
      packs: [exported],
      note: "pack-list-refresh-degraded"
    });
  });
});



describe("buildTournamentComparisonAggregate", () => {
  it("aggregates pairwise match comparisons without inventing private truth", () => {
    const firstState = createGame({ id: "tournament-compare-a-state", seed: "tournament-compare-a" });
    const secondState = createGame({ id: "tournament-compare-b-state", seed: "tournament-compare-b" });
    const thirdState = createGame({ id: "tournament-compare-c-state", seed: "tournament-compare-c" });
    const first = matchArtifactFixture({
      state: firstState,
      runId: "run-a",
      matchId: "match-a",
      seed: "tournament-compare-a",
      createdAt: BASE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 2,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 2,
      latencyMs: 20,
      winner: "village"
    });
    const second = matchArtifactFixture({
      state: secondState,
      runId: "run-b",
      matchId: "match-b",
      seed: "tournament-compare-b",
      createdAt: CANDIDATE_CREATED_AT,
      trajectoryCount: 2,
      socialMessageCount: 2,
      evaluationMetricCount: 3,
      evaluationWarningCount: 1,
      evaluatorCount: 2,
      modelCalls: 2,
      promptTokens: 20,
      completionTokens: 4,
      latencyMs: 40,
      winner: "werewolves"
    });
    const third = matchArtifactFixture({
      state: thirdState,
      runId: "run-c",
      matchId: "match-c",
      seed: "tournament-compare-c",
      createdAt: COMPARISON_CREATED_AT,
      trajectoryCount: 3,
      socialMessageCount: 3,
      evaluationMetricCount: 4,
      evaluationWarningCount: 0,
      evaluatorCount: 2,
      modelCalls: 3,
      promptTokens: 30,
      completionTokens: 6,
      latencyMs: 60,
      winner: "village"
    });

    const aggregate = buildTournamentComparisonAggregate({
      sources: [
        { episodeIndex: 0, seed: "tournament-compare-a", runId: "run-a", matchId: "match-a", artifact: first },
        { episodeIndex: 1, seed: "tournament-compare-b", runId: "run-b", matchId: "match-b", artifact: second },
        { episodeIndex: 2, seed: "tournament-compare-c", runId: "run-c", matchId: "match-c", artifact: third }
      ],
      view: "postgame-redacted",
      tournamentSeed: "tournament-compare-seed",
      gamesRequested: 3,
      experimentId: "exp-tournament-compare",
      createdAt: COMPARISON_CREATED_AT
    });
    const repeated = buildTournamentComparisonAggregate({
      sources: [
        { episodeIndex: 2, seed: "tournament-compare-c", runId: "run-c", matchId: "match-c", artifact: third },
        { episodeIndex: 0, seed: "tournament-compare-a", runId: "run-a", matchId: "match-a", artifact: first },
        { episodeIndex: 1, seed: "tournament-compare-b", runId: "run-b", matchId: "match-b", artifact: second }
      ],
      view: "postgame-redacted",
      tournamentSeed: "tournament-compare-seed",
      gamesRequested: 3,
      experimentId: "exp-tournament-compare",
      createdAt: "2099-01-01T00:00:00.000Z"
    });

    expect(aggregate).toMatchObject({
      artifactVersion: TOURNAMENT_COMPARISON_ARTIFACT_VERSION,
      kind: "tournament-comparison",
      view: "postgame-redacted",
      tournamentSeed: "tournament-compare-seed",
      experimentId: "exp-tournament-compare",
      gamesRequested: 3,
      artifactMatchCount: 3,
      pairCount: 3,
      projection: {
        view: "postgame-redacted",
        privateEvidenceRedacted: true,
        postgameTruthRedacted: false
      }
    });
    expect(aggregate.comparisonSetId).toMatch(/^tournament-comparison:[a-f0-9]{24}$/);
    expect(repeated.comparisonSetId).toBe(aggregate.comparisonSetId);
    expect(aggregate.pairs).toHaveLength(3);
    expect(aggregate.pairs.map((pair) => [pair.baseline.episodeIndex, pair.candidate.episodeIndex])).toEqual([
      [0, 1],
      [0, 2],
      [1, 2]
    ]);
    expect(aggregate.pairs[0]).toMatchObject({
      baselineSocialSteps: 1,
      candidateSocialSteps: 2,
      baselineCommittedSteps: 1,
      candidateCommittedSteps: 2,
      baselineRejectedSteps: 0,
      candidateRejectedSteps: 0,
      socialStepsDelta: 1,
      committedStepsDelta: 1,
      rejectedStepsDelta: 0
    });
    expect(aggregate.summary).toMatchObject({
      totalSocialStepsDelta: 1 + 2 + 1,
      totalCommittedStepsDelta: 1 + 2 + 1,
      totalRejectedStepsDelta: 0
    });
    expect(aggregate.summary.pairIdentityHash).toBe(repeated.summary.pairIdentityHash);
    expect(aggregate.metricChangeFrequency.length).toBeGreaterThan(0);
    expect(JSON.stringify(aggregate)).not.toContain(PRIVATE_SENTINEL);
  });

  it("returns zero pairs when fewer than two match artifacts exist", () => {
    const onlyState = createGame({ id: "tournament-compare-single", seed: "tournament-compare-single" });
    const only = matchArtifactFixture({
      state: onlyState,
      runId: "run-only",
      matchId: "match-only",
      seed: "tournament-compare-single",
      createdAt: BASE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 1,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      winner: "village"
    });
    const aggregate = buildTournamentComparisonAggregate({
      sources: [{ episodeIndex: 0, seed: "tournament-compare-single", runId: "run-only", matchId: "match-only", artifact: only }],
      view: "full",
      tournamentSeed: "single-seed",
      gamesRequested: 1,
      createdAt: COMPARISON_CREATED_AT
    });
    expect(aggregate.pairCount).toBe(0);
    expect(aggregate.pairs).toEqual([]);
    expect(aggregate.summary).toMatchObject({
      changedPairCount: 0,
      totalChangedRows: 0,
      averageChangedRows: 0,
      totalSocialStepsDelta: 0,
      totalCommittedStepsDelta: 0,
      totalRejectedStepsDelta: 0
    });
  });

  it("formats tournament comparison aggregates as pure markdown projections", () => {
    const firstState = createGame({ id: "tournament-md-a-state", seed: "tournament-md-a" });
    const secondState = createGame({ id: "tournament-md-b-state", seed: "tournament-md-b" });
    const first = matchArtifactFixture({
      state: firstState,
      runId: "run-md-a",
      matchId: "match-md-a",
      seed: "tournament-md-a",
      createdAt: BASE_CREATED_AT,
      trajectoryCount: 1,
      socialMessageCount: 1,
      evaluationMetricCount: 2,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 1,
      promptTokens: 10,
      completionTokens: 2,
      latencyMs: 20,
      winner: "village"
    });
    const second = matchArtifactFixture({
      state: secondState,
      runId: "run-md-b",
      matchId: "match-md-b",
      seed: "tournament-md-b",
      createdAt: CANDIDATE_CREATED_AT,
      trajectoryCount: 2,
      socialMessageCount: 2,
      evaluationMetricCount: 3,
      evaluationWarningCount: 0,
      evaluatorCount: 1,
      modelCalls: 2,
      promptTokens: 20,
      completionTokens: 4,
      latencyMs: 40,
      winner: "werewolves"
    });
    const aggregate = buildTournamentComparisonAggregate({
      sources: [
        { episodeIndex: 0, seed: "tournament-md-a", runId: "run-md-a", matchId: "match-md-a", artifact: first },
        { episodeIndex: 1, seed: "tournament-md-b", runId: "run-md-b", matchId: "match-md-b", artifact: second }
      ],
      view: "postgame-redacted",
      tournamentSeed: "tournament-md-seed",
      gamesRequested: 2,
      experimentId: "exp-tournament-md",
      createdAt: COMPARISON_CREATED_AT
    });
    const markdown = formatTournamentComparisonMarkdown(aggregate);
    expect(markdown).toContain("# Tournament Comparison");
    expect(markdown).toContain(aggregate.comparisonSetId);
    expect(markdown).toContain("pairs=1");
    expect(markdown).toContain("socialStepsDelta=");
    expect(markdown).toContain("committedStepsDelta=");
    expect(markdown).toContain("rejectedStepsDelta=");
    expect(markdown).toContain("socialStepsΔ");
    expect(markdown).toContain("committedΔ");
    expect(markdown).toContain("rejectedΔ");
    expect(markdown).toContain("## Pairs");
    expect(markdown).toContain("## Metric Change Frequency");
    expect(markdown).toContain("does not invent winners");
    expect(markdown).not.toContain(PRIVATE_SENTINEL);
  });
});


function comparisonMetricPromotionPolicy(policyId: string, catalogId: string) {
  return createMetricPromotionPolicy({
    id: policyId,
    version: "1.0.0",
    catalog: {
      id: catalogId,
      version: "1.0.0",
      domainId: "comparison-test",
      entries: [
        createMetricPromotionCatalogEntry(
          catalogId,
          "shared.metric.1",
          "scorecard",
          "Comparison provenance regression metric."
        )
      ],
      rules: []
    }
  });
}

function matchArtifactFixture(options: {
  state: GameState;
  runId: string;
  matchId: string;
  seed: string;
  createdAt: string;
  trajectoryCount: number;
  socialMessageCount: number;
  evaluationMetricCount: number;
  evaluationWarningCount: number;
  evaluatorCount: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  winner: "village" | "werewolves";
}): MatchArtifact & { projection: MatchComparisonProjection } {
  const state = {
    ...options.state,
    seed: options.seed,
    winner: options.winner,
    events: [
      ...options.state.events,
      {
        id: `${options.runId}:postgame-private-event`,
        seq: options.state.events.length + 1,
        day: 1,
        phase: "game_over" as const,
        type: "game.ended" as const,
        visibility: "postgame" as const,
        payload: { privateNote: PRIVATE_SENTINEL },
        createdAt: options.createdAt
      }
    ]
  };
  const channels = [
    {
      id: `${options.runId}:public`,
      kind: "public" as const,
      participantIds: state.players.map((player) => player.id),
      readableBy: "all" as const
    }
  ];
  const messages = Array.from({ length: options.socialMessageCount }, (_, index): SocialMessage => ({
    id: `${options.runId}:message:${index + 1}`,
    seq: index + 1,
    channelId: channels[0].id,
    senderId: state.players[0].id,
    recipientIds: state.players.slice(1).map((player) => player.id),
    visibility: index === 0 ? "private" : "public",
    content: index === 0 ? PRIVATE_SENTINEL : `public comparison message ${index + 1}`,
    speechActs: [
      {
        id: `${options.runId}:message:${index + 1}:act:1`,
        kind: index === 0 ? "private_note" : "claim",
        subjectId: state.players[0].id,
        value: `comparison-act-${index + 1}`,
        confidence: 1,
        evidenceRefs: [{ artifact: "message", id: `${options.runId}:message:${index + 1}`, seq: index + 1 }]
      }
    ],
    deliveryReceipts: state.players.map((player, receiptIndex) => ({
      id: `${options.runId}:message:${index + 1}:delivery:${receiptIndex + 1}:${player.id}`,
      messageId: `${options.runId}:message:${index + 1}`,
      messageSeq: index + 1,
      channelId: channels[0].id,
      senderId: state.players[0].id,
      observerId: player.id,
      visibility: index === 0 ? "private" : "public",
      deliveredAtTurn: index + 1,
      redactionPolicy: `runtime-visible:${index === 0 ? "private" : "public"}`
    })),
    createdAt: options.createdAt,
    metadata: { traceId: `${options.runId}:trace:${index + 1}`, kind: "comparison-fixture" }
  }));
  const steps = Array.from({ length: options.trajectoryCount }, (_, index) =>
    harnessStepFixture({
      state,
      runId: options.runId,
      turnIndex: index,
      observedMessages: messages.slice(0, Math.min(messages.length, index + 1))
    })
  );
  const socialEpisode: SocialEpisodeArtifact<GameState, HarnessPlayerView, AgentPendingAction, GameCommand> = {
    id: `${options.runId}:social`,
    status: "completed",
    schedulerMode: "aec",
    profiles: [{ id: "profile-comparison", model: "comparison-model", temperature: 0 }],
    channels,
    initialState: state,
    finalState: state,
    steps,
    messages
  };
  const metrics = Array.from({ length: options.evaluationMetricCount }, (_, index) => ({
    id: index < 2 ? `shared.metric.${index + 1}` : `${options.runId}:metric:${index + 1}`,
    label: `Metric ${index + 1}`,
    scope: "episode" as const,
    value: index + 1,
    weight: index === 0 ? 1 : 0,
    source: "matchComparison.test",
    evidenceRefs:
      index === 0
        ? [
            // Shared metrics must use run-stable evidence identities so unchanged
            // shared metrics remain omitted from the metric-diff section.
            { artifact: "observation" as const, traceId: "shared-obs", description: "scoped observation" },
            { artifact: "message" as const, seq: 1, description: "public speech" }
          ]
        : index === 1
          ? [{ artifact: "state" as const, id: "shared-state-truth", description: "postgame truth" }]
          : []
  }));
  const evaluatorIds = Array.from({ length: options.evaluatorCount }, (_, index) => `${options.runId}:evaluator:${index + 1}`);
  const warnings = Array.from({ length: options.evaluationWarningCount }, (_, index) => ({
    code: `comparison.warning.${index + 1}`,
    severity: "warning" as const,
    message: `comparison warning ${index + 1}`
  }));
  const agent = agentFixture(state, options.runId);
  const projection: MatchComparisonProjection = {
    view: "postgame-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: true,
    generatedAt: PROJECTION_GENERATED_AT
  };

  return {
    artifactVersion: "harness.match.v2",
    kind: "match",
    runId: options.runId,
    matchId: options.matchId,
    createdAt: options.createdAt,
    seed: options.seed,
    rulesetId: state.config.rulesetId,
    config: state.config,
    models: ["comparison-model"],
    profiles: [{ id: "profile-comparison", model: "comparison-model", temperature: 0, policyName: "balanced" }],
    assignment: { strategy: "profile-rotation" },
    resolvedAssignments: state.players.map((player) => ({
      playerId: player.id,
      seat: player.seat,
      role: player.role,
      team: player.team,
      profileId: "profile-comparison",
      model: "comparison-model",
      temperature: 0,
      policyName: "balanced"
    })),
    status: "completed",
    initialState: state,
    finalState: state,
    trajectory: steps,
    socialEpisode,
    events: state.events,
    evaluation: {
      winner: options.winner,
      teamRewards: { village: options.winner === "village" ? 1 : 0, werewolves: options.winner === "werewolves" ? 1 : 0 },
      agentRewards: [],
      voteAccuracyByAgent: {},
      influenceByAgent: {},
      deceptionByAgent: {},
      trajectory: []
    },
    evaluationReport: {
      id: `${options.runId}:evaluation`,
      createdAt: options.createdAt,
      evaluatorIds,
      evaluatorRegistry: [],
      metricCount: metrics.length,
      metrics,
      outputs: {},
      warnings,
      summary: summarizeMetrics(metrics)
    },
    metrics: {
      winner: options.winner,
      days: 1,
      totalDeaths: 0,
      totalSpeeches: options.trajectoryCount,
      totalVotes: options.socialMessageCount,
      harnessTurnCount: options.trajectoryCount,
      harnessErrorCount: 0,
      averageLatencyMs: options.latencyMs / Math.max(options.modelCalls, 1),
      wolfVoteAccuracy: 0,
      villageVoteAccuracy: 0,
      deceptionSurvivalScore: 0,
      modelUsage: {
        "comparison-model": {
          calls: options.modelCalls,
          promptTokens: options.promptTokens,
          completionTokens: options.completionTokens,
          latencyMs: options.latencyMs
        }
      }
    },
    agents: [agent],
    projection
  };
}

function attachProjectedExposureRecords(artifact: MatchArtifact, count: number): void {
  artifact.socialEpisode.exposureRecords = Array.from({ length: count }, (_, index) => socialExposureRecordFixture(artifact.runId, index + 1));
}

function socialExposureRecordFixture(runId: string, index: number): SocialExposureRecord {
  const messageId = `${runId}:projected-exposure-message:${index}`;
  const traceId = `${runId}:projected-exposure-trace:${index}`;
  return {
    messageId,
    messageSeq: index,
    sourceId: `${runId}:source`,
    observerId: `${runId}:observer:${index}`,
    observedAtTraceId: traceId,
    observedAtTurnIndex: index,
    observedAtActionKind: "projected",
    channelId: `${runId}:public`,
    visibility: "public",
    evidenceRefs: [
      { artifact: "message", id: messageId, seq: index },
      { artifact: "trace", traceId, seq: index }
    ]
  };
}

function harnessStepFixture(options: {
  state: GameState;
  runId: string;
  turnIndex: number;
  observedMessages: SocialMessage[];
}): HarnessStepRecord & SocialHarnessStep<HarnessPlayerView, AgentPendingAction, GameCommand> {
  const actor = options.state.players[0];
  const target = options.state.players[1];
  const pendingAction: AgentPendingAction = {
    kind: "speech",
    phase: "day_speech",
    actorId: actor.id,
    legalPressureTargetIds: [target.id]
  };
  const command: GameCommand = {
    type: "speech.submit",
    actorId: actor.id,
    text: `public fixture speech ${options.turnIndex + 1}`,
    pressureTargetId: target.id,
    strategyTags: ["comparison-fixture"]
  };
  const policyPlan: PolicyPlan = {
    policyName: "balanced",
    command,
    intent: "exercise match comparison rows",
    confidence: 0.7,
    strategyTags: ["comparison-fixture"],
    pressureTargetId: target.id,
    targetId: target.id
  };
  const traceId = `${options.runId}:trace:${options.turnIndex + 1}`;

  return {
    traceId,
    turnIndex: options.turnIndex,
    actorId: actor.id,
    profileId: "profile-comparison",
    schedulerMode: "aec",
    model: "comparison-model",
    pendingAction,
    observation: playerViewFixture(options.state, pendingAction, options.observedMessages),
    action: {
      actorId: actor.id,
      kind: "speech",
      traceId,
      command
    },
    decisionStateHash: `${options.runId}:decision:${options.turnIndex}`,
    preStateHash: `${options.runId}:pre:${options.turnIndex}`,
    policyPlan,
    reasonerOutput: {
      content: PRIVATE_SENTINEL,
      latencyMs: 5,
      promptTokens: 3,
      completionTokens: 2
    },
    command,
    turnTrace: {
      traceId,
      playerId: actor.id,
      profileId: "profile-comparison",
      model: "comparison-model",
      actionKind: "speech",
      policyName: "balanced",
      commandType: "speech.submit",
      intent: "exercise match comparison rows",
      targetId: target.id,
      confidence: 0.7,
      strategyTags: ["comparison-fixture"],
      beliefs: {},
      privateMemo: PRIVATE_SENTINEL,
      publicSpeech: `public fixture speech ${options.turnIndex + 1}`,
      latencyMs: 5,
      promptTokens: 3,
      completionTokens: 2
    },
    agentStateHash: `${options.runId}:agent:${options.turnIndex}`,
    postStateHash: `${options.runId}:post:${options.turnIndex}`,
    eventSeqRange: [1, options.state.events.length],
    messageSeqRange: options.observedMessages.length ? [1, options.observedMessages.length] : undefined
  };
}

function playerViewFixture(state: GameState, pendingAction: AgentPendingAction, visibleMessages: SocialMessage[]): HarnessPlayerView {
  const actor = state.players[0];
  const publicPlayers: PlayerView["publicPlayers"] = state.players.map((player) => ({
    id: player.id,
    seat: player.seat,
    name: player.name,
    alive: player.alive,
    isSheriff: player.isSheriff,
    revealedRole: player.alive ? undefined : player.role,
    eliminatedAt: player.eliminatedAt
  }));

  return {
    phase: "day_speech",
    day: 1,
    you: {
      id: actor.id,
      seat: actor.seat,
      name: actor.name,
      role: actor.role,
      team: actor.team,
      alive: actor.alive,
      ability: actor.ability
    },
    publicPlayers,
    privateInfo: { werewolfAllies: [PRIVATE_SENTINEL] },
    speeches: [],
    votes: [],
    deaths: [],
    recentEvents: state.events,
    pendingAction,
    social: {
      channels: [
        {
          id: `${state.id}:public`,
          kind: "public",
          participantIds: state.players.map((player) => player.id),
          readableBy: "all"
        }
      ],
      messages: visibleMessages
    }
  };
}

function agentFixture(state: GameState, runId: string): AgentHarnessState {
  const social = createAgentSocialState<PlayerView, AgentPendingAction, GameCommand>({
    agentId: state.players[0].id,
    profile: { id: "profile-comparison", model: "comparison-model", policyId: "balanced" }
  });
  social.relationships.edges[state.players[1].id] = {
    targetId: state.players[1].id,
    trust: 0.1,
    suspicion: 0.9,
    affinity: 0,
    influence: 0,
    debt: 0,
    respect: 0,
    threat: 0.4,
    evidenceRefs: [{ artifact: "trace", traceId: `${runId}:trace:1`, description: PRIVATE_SENTINEL }],
    updatedAt: BASE_CREATED_AT
  };

  return {
    playerId: state.players[0].id,
    profileId: "profile-comparison",
    model: "comparison-model",
    temperature: 0,
    policyName: "balanced",
    turns: 1,
    observations: 1,
    beliefs: {},
    privateMemos: [PRIVATE_SENTINEL],
    lastIntent: "exercise match comparison rows",
    social,
    socialStateHash: `${runId}:social-state`
  };
}
