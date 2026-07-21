/**
 * Browser-safe comparison DTOs and filtered projection.
 *
 * Comparison truth is constructed by `matchComparison.ts`; the shared module
 * supplies identical URL, selection, filtering, registry-label, and pack-list
 * behavior to the server and Cockpit without pulling Node-only dependencies
 * into the browser bundle.
 */

import {
  filterMatchComparisonRows,
  normalizeMatchComparisonRowFilter
} from "./matchComparisonShared";
import type {
  MatchComparisonRowFilterCandidate,
  MatchComparisonRowFilter,
  MatchComparisonRowGroup,
  MatchComparisonValue,
  MatchComparisonView
} from "./matchComparisonShared";

export {
  applyMatchComparisonRowFilterToSearchParams,
  buildMatchComparisonFilterDeepLink,
  defaultMatchComparisonRowFilter,
  formatComparisonRegistryEntryLabel,
  isMatchComparisonSelectionCurrent,
  mergeExportedTournamentPackList,
  parseMatchComparisonDeepLinkSelection,
  parseMatchComparisonRowFilterFromSearchParams,
  resolvePackSeededComparisonSelection
} from "./matchComparisonShared";
export type {
  ComparisonRegistryLabelSource,
  MatchComparisonDeepLinkView,
  MatchComparisonEvidenceIdentityFilter,
  MatchComparisonNumericDeltaFilter,
  MatchComparisonPromotionChangeField,
  MatchComparisonPromotionDecisionSnapshot,
  MatchComparisonPromotionDetails,
  MatchComparisonPromotionFilter,
  MatchComparisonRowFilter,
  MatchComparisonRowGroup,
  MatchComparisonRowPromotion,
  MatchComparisonValue,
  MatchComparisonView,
  MergeExportedTournamentPackListNote,
  MergeExportedTournamentPackListResult,
  PackSeededComparisonRegistryEntry,
  ResolvePackSeededComparisonSelectionResult,
  ResolvePackSeededComparisonSource,
  TournamentPackListEntry
} from "./matchComparisonShared";

export interface MatchComparisonProjection {
  view: MatchComparisonView;
  privateEvidenceRedacted: boolean;
  postgameTruthRedacted: boolean;
  generatedAt: string;
}

export interface MatchComparisonSourceSummary {
  matchId?: string;
  /** Omitted by truth-redacted comparison projections. */
  runId?: string;
  /** Omitted by truth-redacted comparison projections. */
  seed?: string;
  createdAt?: string;
  status: string;
  projection?: MatchComparisonProjection;
  [key: string]: unknown;
}

export interface MatchComparisonRowEvidence {
  baselineRefs: number;
  candidateRefs: number;
  baselineKinds: string[];
  candidateKinds: string[];
  baselineIds: string[];
  candidateIds: string[];
  onlyBaselineIds: string[];
  onlyCandidateIds: string[];
}

export interface MatchComparisonRow extends MatchComparisonRowFilterCandidate {
  id: string;
  label: string;
  metricId?: string;
  subjectId?: string;
  baseline: MatchComparisonValue;
  candidate: MatchComparisonValue;
  evidence?: MatchComparisonRowEvidence;
}

export interface MatchComparisonArtifact {
  artifactVersion?: string;
  kind?: "match-comparison" | string;
  comparisonId: string;
  createdAt: string;
  view: MatchComparisonView;
  projection: MatchComparisonProjection;
  baseline: MatchComparisonSourceSummary;
  candidate: MatchComparisonSourceSummary;
  rows: MatchComparisonRow[];
  summary: {
    rowCount: number;
    changedRowCount: number;
    numericDeltaCount: number;
    promotionChangedMetricCount: number;
    promotionProvenanceChangedMetricCount: number;
    scorecardMetricDelta: number;
    diagnosticMetricDelta: number;
    benchmarkOnlyMetricDelta: number;
    evidenceIdentityChangedMetricCount: number;
    evidenceIdentityOnlyBaselineRefCount: number;
    evidenceIdentityOnlyCandidateRefCount: number;
    metricKeysCompared: number;
    metricKeysEmitted: number;
    metricKeysTruncated: number;
    metricRowsMax: number;
    [key: string]: number;
  };
}

export interface MatchComparisonFilteredProjection {
  artifactVersion: string;
  kind: "match-comparison-filtered";
  sourceComparisonId: string;
  createdAt: string;
  view: MatchComparisonView;
  filter: Required<MatchComparisonRowFilter>;
  source: {
    comparisonId: string;
    baseline: MatchComparisonSourceSummary;
    candidate: MatchComparisonSourceSummary;
    projection: MatchComparisonProjection;
    summary: MatchComparisonArtifact["summary"];
  };
  rows: MatchComparisonRow[];
  summary: {
    rowCount: number;
    changedRowCount: number;
    numericDeltaCount: number;
    promotionChangedMetricCount: number;
    promotionProvenanceChangedMetricCount: number;
    evidenceIdentityChangedMetricCount: number;
    evidenceIdentityOnlyBaselineRefCount: number;
    evidenceIdentityOnlyCandidateRefCount: number;
    summaryRowCount: number;
    metricRowCount: number;
    metricEvidenceRowCount: number;
    sourceRowCount: number;
    sourceChangedRowCount: number;
  };
}

export function projectFilteredMatchComparison(
  comparison: MatchComparisonArtifact,
  filter: MatchComparisonRowFilter = {},
  options?: { createdAt?: string }
): MatchComparisonFilteredProjection {
  const normalized = normalizeMatchComparisonRowFilter(filter);
  const rows = filterMatchComparisonRows(comparison.rows, normalized);
  const evidenceRows = rows.filter((row) => row.id.startsWith("metric_evidence_ids:"));
  const promotionProvenanceMetricKeys = new Set<string>();
  for (const row of rows) {
    if (row.promotion?.details?.changedFields.some((field) => field !== "class") && row.metricId) {
      promotionProvenanceMetricKeys.add(`${row.metricId}::${row.subjectId ?? "episode"}`);
    }
  }
  return {
    artifactVersion: "harness.match-comparison.filtered.v1",
    kind: "match-comparison-filtered",
    sourceComparisonId: comparison.comparisonId,
    createdAt: options?.createdAt ?? new Date().toISOString(),
    view: comparison.view,
    filter: normalized,
    source: {
      comparisonId: comparison.comparisonId,
      baseline: comparison.baseline,
      candidate: comparison.candidate,
      projection: comparison.projection,
      summary: comparison.summary
    },
    rows,
    summary: {
      rowCount: rows.length,
      changedRowCount: rows.filter((row) => row.changed).length,
      numericDeltaCount: rows.filter((row) => row.delta !== undefined).length,
      promotionChangedMetricCount: rows.filter((row) => row.id.startsWith("metric_promotion:") && row.changed).length,
      promotionProvenanceChangedMetricCount: promotionProvenanceMetricKeys.size,
      evidenceIdentityChangedMetricCount: evidenceRows.length,
      evidenceIdentityOnlyBaselineRefCount: evidenceRows.reduce(
        (sum, row) => sum + (row.evidence?.onlyBaselineIds.length ?? 0),
        0
      ),
      evidenceIdentityOnlyCandidateRefCount: evidenceRows.reduce(
        (sum, row) => sum + (row.evidence?.onlyCandidateIds.length ?? 0),
        0
      ),
      summaryRowCount: rows.filter((row) => (row.group ?? "summary") === "summary").length,
      metricRowCount: rows.filter((row) => row.group === "metric").length,
      metricEvidenceRowCount: rows.filter((row) => row.group === "metric_evidence").length,
      sourceRowCount: comparison.summary.rowCount,
      sourceChangedRowCount: comparison.summary.changedRowCount
    }
  };
}
