import { describe, expect, it } from "vitest";
import {
  applyMatchComparisonRowFilterToSearchParams as applyServerFilter,
  buildMatchComparisonFilterDeepLink as buildServerDeepLink,
  filterMatchComparisonRows,
  formatComparisonRegistryEntryLabel as formatServerLabel,
  mergeExportedTournamentPackList as mergeServerPackList,
  parseMatchComparisonDeepLinkSelection as parseServerDeepLink,
  parseMatchComparisonRowFilterFromSearchParams as parseServerFilter,
  resolvePackSeededComparisonSelection as resolveServerPackSelection
} from "../src/harness/matchComparison";
import {
  applyMatchComparisonRowFilterToSearchParams as applyBrowserFilter,
  buildMatchComparisonFilterDeepLink as buildBrowserDeepLink,
  formatComparisonRegistryEntryLabel as formatBrowserLabel,
  mergeExportedTournamentPackList as mergeBrowserPackList,
  parseMatchComparisonDeepLinkSelection as parseBrowserDeepLink,
  parseMatchComparisonRowFilterFromSearchParams as parseBrowserFilter,
  projectFilteredMatchComparison,
  resolvePackSeededComparisonSelection as resolveBrowserPackSelection,
  type MatchComparisonArtifact
} from "../src/harness/matchComparisonView";

describe("browser-safe comparison parity", () => {
  it("uses the server's URL filter and deep-link rules", () => {
    const search = "noise=keep&compareGroup=metric&compareChangedOnly=yes&comparePromotion=diagnostic";
    expect(parseBrowserFilter(search)).toEqual(parseServerFilter(search));
    expect(applyBrowserFilter({ evidenceIdentity: "changed", numericDelta: "changed" }, search).toString()).toBe(
      applyServerFilter({ evidenceIdentity: "changed", numericDelta: "changed" }, search).toString()
    );

    const input = {
      origin: "https://arena.example",
      pathname: "/cockpit",
      search,
      hash: "#compare",
      filter: { group: "metric_evidence" as const, promotion: "scorecard" as const },
      workspace: "compare",
      baselineId: "baseline-run",
      candidateId: "candidate-run",
      view: "truth-redacted" as const
    };
    const browserLink = buildBrowserDeepLink(input);
    expect(browserLink).toBe(buildServerDeepLink(input));
    expect(parseBrowserDeepLink(browserLink)).toEqual(parseServerDeepLink(browserLink));
  });

  it("projects the same filtered rows used by the server", () => {
    const comparison = comparisonFixture();
    const filter = {
      group: "metric_evidence" as const,
      changedOnly: true,
      evidenceIdentity: "changed" as const,
      numericDelta: "all" as const
    };
    const browserProjection = projectFilteredMatchComparison(comparison, filter, {
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    expect(browserProjection.rows).toEqual(filterMatchComparisonRows(comparison.rows, filter));
    expect(browserProjection.rows.map((row) => row.id)).toEqual(["metric_evidence_ids:truth"]);
    expect(browserProjection.summary).toMatchObject({
      rowCount: 1,
      changedRowCount: 1,
      evidenceIdentityChangedMetricCount: 1,
      evidenceIdentityOnlyBaselineRefCount: 1,
      evidenceIdentityOnlyCandidateRefCount: 2
    });
  });

  it("treats same-class promotion provenance changes as promotion changes in the browser projection", () => {
    const comparison = comparisonFixture();
    const metric = comparison.rows.find((row) => row.id === "metric:truth");
    if (!metric) throw new Error("Expected metric fixture row.");
    metric.promotion = {
      baseline: "scorecard",
      candidate: "scorecard",
      details: {
        baseline: {
          policyId: "policy.baseline",
          policyVersion: "1.0.0",
          policyHash: "baseline-policy-hash",
          catalogId: "catalog.baseline",
          catalogVersion: "1.0.0",
          catalogHash: "baseline-catalog-hash",
          catalogDomainId: "test",
          eligibleForScorecard: true,
          reasons: ["catalog_scorecard"],
          catalogDecisionId: "catalog.baseline#truth",
          resolution: "recorded"
        },
        candidate: {
          policyId: "policy.candidate",
          policyVersion: "1.0.0",
          policyHash: "candidate-policy-hash",
          catalogId: "catalog.candidate",
          catalogVersion: "1.0.0",
          catalogHash: "candidate-catalog-hash",
          catalogDomainId: "test",
          eligibleForScorecard: true,
          reasons: ["catalog_scorecard"],
          catalogDecisionId: "catalog.candidate#truth",
          resolution: "recorded"
        },
        changed: true,
        changedFields: ["catalogDecisionId", "policy", "catalog"]
      }
    };
    comparison.summary.promotionProvenanceChangedMetricCount = 1;

    const projection = projectFilteredMatchComparison(comparison, { promotion: "changed" }, {
      createdAt: "2026-07-20T00:00:00.000Z"
    });

    expect(projection.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: "metric:truth" })]));
    expect(projection.summary.promotionProvenanceChangedMetricCount).toBe(1);
  });

  it("keeps registry labels and pack-selection degradation notes identical", () => {
    const entry = {
      comparisonId: "match-comparison:abcdef1234567890",
      view: "postgame-redacted",
      baseline: { matchId: "baseline-match", runId: "baseline-run" },
      candidate: { matchId: "candidate-match", runId: "candidate-run" },
      summary: {
        rowCount: 12,
        changedRowCount: 7,
        numericDeltaCount: 5,
        promotionChangedMetricCount: 3,
        evidenceIdentityChangedMetricCount: 2,
        evidenceIdentityOnlyBaselineRefCount: 1,
        evidenceIdentityOnlyCandidateRefCount: 2,
        committedStepsDelta: 4,
        rejectedStepsDelta: -1,
        metricKeysCompared: 80,
        metricKeysEmitted: 64,
        metricKeysTruncated: 16,
        diagnosticMetricKeysTruncated: 16,
        metricRowsMax: 64
      }
    };
    const label = formatBrowserLabel(entry);
    expect(label).toBe(formatServerLabel(entry));
    expect(label).toContain("evidOnly 1→2");
    expect(label).toContain("keys 64/80");
    expect(label).toContain("max64");
    expect(label).toContain("diagTrunc16");

    const selectionInput = {
      packMatchIds: new Set(["baseline-match", "candidate-match"]),
      packScopedEntries: [],
      packScopedRefreshOk: true,
      fullEntries: [entry]
    };
    expect(resolveBrowserPackSelection(selectionInput)).toEqual(resolveServerPackSelection(selectionInput));
    expect(resolveBrowserPackSelection(selectionInput)).toMatchObject({
      source: "full-registry-fallback",
      degradedNotes: ["pack-scoped-comparison-empty-fallback"]
    });

    const pack = { artifactSetId: "pack-new", createdAt: "2026-07-20T00:00:00.000Z" };
    const mergeInput = { exportedPack: pack, listedPacks: [{ artifactSetId: "pack-old", createdAt: "earlier" }] };
    expect(mergeBrowserPackList(mergeInput)).toEqual(mergeServerPackList(mergeInput));
  });
});

function comparisonFixture(): MatchComparisonArtifact {
  const evidence = {
    baselineRefs: 1,
    candidateRefs: 2,
    baselineKinds: ["observation"],
    candidateKinds: ["observation"],
    baselineIds: ["obs:a"],
    candidateIds: ["obs:b", "obs:c"],
    onlyBaselineIds: ["obs:a"],
    onlyCandidateIds: ["obs:b", "obs:c"]
  };
  return {
    comparisonId: "comparison-fixture",
    createdAt: "2026-07-20T00:00:00.000Z",
    view: "postgame-redacted",
    projection: {
      view: "postgame-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: true,
      generatedAt: "2026-07-20T00:00:00.000Z"
    },
    baseline: { runId: "baseline-run", seed: "seed-a", createdAt: "2026-07-20T00:00:00.000Z", status: "completed" },
    candidate: { runId: "candidate-run", seed: "seed-b", createdAt: "2026-07-20T00:00:00.000Z", status: "completed" },
    rows: [
      {
        id: "status",
        label: "status",
        baseline: "completed",
        candidate: "completed",
        changed: false
      },
      {
        id: "metric:truth",
        label: "truth metric",
        group: "metric",
        metricId: "truth",
        baseline: 1,
        candidate: 2,
        delta: 1,
        changed: true,
        promotion: { baseline: "diagnostic", candidate: "scorecard" },
        evidence
      },
      {
        id: "metric_evidence_ids:truth",
        label: "truth evidence ids",
        group: "metric_evidence",
        metricId: "truth",
        baseline: 1,
        candidate: 2,
        delta: 1,
        changed: true,
        evidence
      }
    ],
    summary: {
      rowCount: 3,
      changedRowCount: 2,
      numericDeltaCount: 2,
      promotionChangedMetricCount: 1,
      promotionProvenanceChangedMetricCount: 0,
      scorecardMetricDelta: 1,
      diagnosticMetricDelta: -1,
      benchmarkOnlyMetricDelta: 0,
      evidenceIdentityChangedMetricCount: 1,
      evidenceIdentityOnlyBaselineRefCount: 1,
      evidenceIdentityOnlyCandidateRefCount: 2,
      metricKeysCompared: 1,
      metricKeysEmitted: 1,
      metricKeysTruncated: 0,
      metricRowsMax: 64
    }
  };
}
