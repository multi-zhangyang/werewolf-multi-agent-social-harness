import express from "express";
import { formatMatchComparisonMarkdown, parseComparisonMatchIdsQuery } from "../../harness/matchComparison";
import { artifactViewFromQuery, setArtifactProjectionResponseHeaders } from "../artifactAccess";
import { loadComparisonArtifactIndex } from "../comparisonArtifactStore";
import { comparisonFormatFromQuery, comparisonIsVisibleInRegistry, downloadRequested } from "../comparisonQuery";
import type { ServerContext } from "../context";
import { HttpError } from "../httpValidation";
import { getComparison, listComparisons } from "../store";

export function registerComparisonRoutes(app: express.Express, context: ServerContext): void {
const { artifactAccessBindHost, comparisonArtifactBaseDir } = context;

app.get("/api/comparisons", async (req, res, next) => {
  try {
    await loadComparisonArtifactIndex(comparisonArtifactBaseDir);
    const view = artifactViewFromQuery(req.query, req, artifactAccessBindHost);
    const baselineId = typeof req.query.baselineId === "string" ? req.query.baselineId.trim() : "";
    const candidateId = typeof req.query.candidateId === "string" ? req.query.candidateId.trim() : "";
    const packMatchIds = parseComparisonMatchIdsQuery(req.query.matchIds);
    const comparisons = listComparisons({
      ...(baselineId ? { baselineId } : {}),
      ...(candidateId ? { candidateId } : {}),
      ...(packMatchIds ? { packMatchIds } : {})
    })
      .filter((comparison) => comparisonIsVisibleInRegistry(comparison, view))
      .map((comparison) => ({
      comparisonId: comparison.comparisonId,
      createdAt: comparison.createdAt,
      view: comparison.view,
      projection: comparison.projection,
      baseline: {
        matchId: comparison.baseline.matchId,
        runId: comparison.baseline.runId,
        seed: comparison.baseline.seed
      },
      candidate: {
        matchId: comparison.candidate.matchId,
        runId: comparison.candidate.runId,
        seed: comparison.candidate.seed
      },
      summary: {
        rowCount: comparison.summary.rowCount,
        changedRowCount: comparison.summary.changedRowCount,
        numericDeltaCount: comparison.summary.numericDeltaCount,
        promotionChangedMetricCount: comparison.summary.promotionChangedMetricCount,
        promotionProvenanceChangedMetricCount: comparison.summary.promotionProvenanceChangedMetricCount,
        scorecardMetricDelta: comparison.summary.scorecardMetricDelta,
        diagnosticMetricDelta: comparison.summary.diagnosticMetricDelta,
        benchmarkOnlyMetricDelta: comparison.summary.benchmarkOnlyMetricDelta,
        evidenceIdentityChangedMetricCount: comparison.summary.evidenceIdentityChangedMetricCount,
        evidenceIdentityOnlyBaselineRefCount: comparison.summary.evidenceIdentityOnlyBaselineRefCount,
        evidenceIdentityOnlyCandidateRefCount: comparison.summary.evidenceIdentityOnlyCandidateRefCount,
        metricKeysCompared: comparison.summary.metricKeysCompared,
        metricKeysEmitted: comparison.summary.metricKeysEmitted,
        metricKeysTruncated: comparison.summary.metricKeysTruncated,
        scorecardMetricKeysCompared: comparison.summary.scorecardMetricKeysCompared,
        scorecardMetricKeysEmitted: comparison.summary.scorecardMetricKeysEmitted,
        scorecardMetricKeysTruncated: comparison.summary.scorecardMetricKeysTruncated,
        diagnosticMetricKeysCompared: comparison.summary.diagnosticMetricKeysCompared,
        diagnosticMetricKeysEmitted: comparison.summary.diagnosticMetricKeysEmitted,
        diagnosticMetricKeysTruncated: comparison.summary.diagnosticMetricKeysTruncated,
        benchmarkOnlyMetricKeysCompared: comparison.summary.benchmarkOnlyMetricKeysCompared,
        benchmarkOnlyMetricKeysEmitted: comparison.summary.benchmarkOnlyMetricKeysEmitted,
        benchmarkOnlyMetricKeysTruncated: comparison.summary.benchmarkOnlyMetricKeysTruncated,
        metricRowsMax: comparison.summary.metricRowsMax,
        baselineSocialSteps: comparison.summary.baselineSocialSteps,
        candidateSocialSteps: comparison.summary.candidateSocialSteps,
        baselineCommittedSteps: comparison.summary.baselineCommittedSteps,
        candidateCommittedSteps: comparison.summary.candidateCommittedSteps,
        baselineRejectedSteps: comparison.summary.baselineRejectedSteps,
        candidateRejectedSteps: comparison.summary.candidateRejectedSteps,
        socialStepsDelta: comparison.summary.socialStepsDelta,
        committedStepsDelta: comparison.summary.committedStepsDelta,
        rejectedStepsDelta: comparison.summary.rejectedStepsDelta,
        baselineHash: comparison.summary.baselineHash,
        candidateHash: comparison.summary.candidateHash
      }
    }));
    setArtifactProjectionResponseHeaders(res, view);
    res.json({ comparisons });
  } catch (error) {
    next(error);
  }
});

app.get("/api/comparisons/:id", async (req, res, next) => {
  try {
    await loadComparisonArtifactIndex(comparisonArtifactBaseDir);
    const comparison = getComparison(req.params.id);
    if (!comparison) {
      res.status(404).json({ error: "comparison not found" });
      return;
    }
    const view = artifactViewFromQuery(req.query, req, artifactAccessBindHost);
    if (!comparisonIsVisibleInRegistry(comparison, view)) {
      // Do not disclose a legacy full comparison through the default safe
      // route. A caller that intentionally needs a locally stored full record
      // must explicitly request view=full.
      res.status(404).json({ error: "comparison not found" });
      return;
    }
    if (view === "full" && comparison.view !== "full") {
      throw new HttpError(
        409,
        "Stored comparison is not available in the requested full view; regenerate it from the match pair with view=full.",
        "comparison_view_unavailable"
      );
    }
    const format = comparisonFormatFromQuery(req.query);
    setArtifactProjectionResponseHeaders(res, view);
    if (format === "markdown") {
      if (downloadRequested(req.query)) {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${req.params.id.slice(0, 24)}-comparison.md"`
        );
      }
      res.type("text/markdown; charset=utf-8").send(formatMatchComparisonMarkdown(comparison));
      return;
    }
    if (downloadRequested(req.query)) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${req.params.id.slice(0, 24)}-comparison.json"`
      );
    }
    res.json(comparison);
  } catch (error) {
    next(error);
  }
});
}
