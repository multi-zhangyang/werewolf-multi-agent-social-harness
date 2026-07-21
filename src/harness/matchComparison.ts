import type { MatchMetrics } from "../core/types";
import type { MatchArtifact } from "./artifacts";
import {
  legacyMetricPromotionPolicyFromSummary,
  normalizeMetricPromotionSummary,
  resolveRecordedMetricPromotion,
  type MetricPromotionPolicy
} from "./evaluation";
import { hashStableState } from "./hash";
import { countSocialStepCommits, deriveSocialExposureRecords } from "./social";
import type { HarnessMetricPromotionDecision, HarnessMetricRecord } from "./types";
import {
  applyMatchComparisonRowFilterToSearchParams,
  buildMatchComparisonFilterDeepLink,
  defaultMatchComparisonRowFilter,
  filterMatchComparisonRows,
  formatComparisonRegistryEntryLabel,
  isMatchComparisonSelectionCurrent,
  mergeExportedTournamentPackList,
  parseComparisonMatchIdsQuery,
  parseMatchComparisonDeepLinkSelection,
  parseMatchComparisonRowFilterFromSearchParams,
  resolvePackSeededComparisonSelection,
  selectPackSeededComparisonId
} from "./matchComparisonShared";
import type {
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

export {
  applyMatchComparisonRowFilterToSearchParams,
  buildMatchComparisonFilterDeepLink,
  defaultMatchComparisonRowFilter,
  filterMatchComparisonRows,
  formatComparisonRegistryEntryLabel,
  isMatchComparisonSelectionCurrent,
  mergeExportedTournamentPackList,
  parseComparisonMatchIdsQuery,
  parseMatchComparisonDeepLinkSelection,
  parseMatchComparisonRowFilterFromSearchParams,
  resolvePackSeededComparisonSelection,
  selectPackSeededComparisonId
};
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
};

export const MATCH_COMPARISON_ARTIFACT_VERSION = "harness.match-comparison.v1";
export const MATCH_COMPARISON_MAX_METRIC_ROWS = 64;
export const TOURNAMENT_COMPARISON_ARTIFACT_VERSION = "harness.tournament-comparison.v1";

export interface MatchComparisonProjection {
  view: MatchComparisonView;
  privateEvidenceRedacted: boolean;
  postgameTruthRedacted: boolean;
  generatedAt: string;
}

export interface MatchComparisonSourceSummary {
  matchId?: string;
  runId?: string;
  seed?: string;
  createdAt?: string;
  status: string;
  truncationReason?: string;
  failureReason?: string;
  projection?: MatchComparisonProjection;
  models: string[];
  profileCount: number;
  resolvedAssignmentCount: number;
  agentCount: number;
  trajectorySteps: number;
  socialSteps: number;
  committedSteps: number;
  rejectedSteps: number;
  socialMessages: number;
  socialSpeechActs: number;
  socialDeliveryReceipts: number;
  socialChannels: number;
  gameEvents: number;
  evaluationMetricCount: number;
  evaluationWarningCount: number;
  evaluatorCount: number;
  stateHash: string;
  artifactHash: string;
}

export interface MatchComparisonRow {
  id: string;
  label: string;
  group?: MatchComparisonRowGroup;
  metricId?: string;
  subjectId?: string;
  baseline: MatchComparisonValue;
  candidate: MatchComparisonValue;
  delta?: number;
  changed: boolean;
  promotion?: MatchComparisonRowPromotion;
  evidence?: {
    baselineRefs: number;
    candidateRefs: number;
    baselineKinds: string[];
    candidateKinds: string[];
    baselineIds: string[];
    candidateIds: string[];
    onlyBaselineIds: string[];
    onlyCandidateIds: string[];
  };
}

export interface MatchComparisonArtifact {
  artifactVersion: typeof MATCH_COMPARISON_ARTIFACT_VERSION;
  kind: "match-comparison";
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
    promotionProvenanceChangedMetricCount?: number;
    scorecardMetricDelta: number;
    diagnosticMetricDelta: number;
    benchmarkOnlyMetricDelta: number;
    metricKeysCompared: number;
    metricKeysEmitted: number;
    metricKeysTruncated: number;
    scorecardMetricKeysCompared: number;
    scorecardMetricKeysEmitted: number;
    scorecardMetricKeysTruncated: number;
    diagnosticMetricKeysCompared: number;
    diagnosticMetricKeysEmitted: number;
    diagnosticMetricKeysTruncated: number;
    benchmarkOnlyMetricKeysCompared: number;
    benchmarkOnlyMetricKeysEmitted: number;
    benchmarkOnlyMetricKeysTruncated: number;
    evidenceIdentityChangedMetricCount: number;
    evidenceIdentityOnlyBaselineRefCount: number;
    evidenceIdentityOnlyCandidateRefCount: number;
    baselineSocialSteps: number;
    candidateSocialSteps: number;
    baselineCommittedSteps: number;
    candidateCommittedSteps: number;
    baselineRejectedSteps: number;
    candidateRejectedSteps: number;
    socialStepsDelta: number;
    committedStepsDelta: number;
    rejectedStepsDelta: number;
    metricRowsMax: number;
    baselineHash: string;
    candidateHash: string;
  };
}

/**
 * Structural comparison input shared by canonical match artifacts and honest
 * API projections. Comparison needs counts and summaries, not replay authority.
 */
export type MatchComparisonSource = Omit<MatchArtifact, "trajectory"> & {
  trajectory: readonly unknown[];
  projection?: MatchComparisonProjection;
};

/**
 * A public comparison is intentionally narrower than a canonical or
 * postgame artifact. It can compare only fields that remain observable after
 * role truth, agent state, trajectories, evaluator data, and identity have
 * been removed.
 */
export interface TruthRedactedMatchComparisonSource {
  status?: string;
  createdAt?: string;
  finalState?: unknown;
  socialEpisode?: unknown;
  projection?: MatchComparisonProjection;
}

export type MatchComparisonInput = MatchComparisonSource | TruthRedactedMatchComparisonSource;

export function buildMatchComparisonArtifact(options: {
  baseline: MatchComparisonInput;
  candidate: MatchComparisonInput;
  view: MatchComparisonView;
  createdAt?: string;
}): MatchComparisonArtifact {
  if (options.view === "truth-redacted") {
    return buildTruthRedactedMatchComparisonArtifact({ ...options, view: "truth-redacted" });
  }
  const baseline = options.baseline as MatchComparisonSource;
  const candidate = options.candidate as MatchComparisonSource;
  const comparisonRows = buildComparisonRows(baseline, candidate);
  const baselinePromotion = promotionSummaryForReport(baseline);
  const candidatePromotion = promotionSummaryForReport(candidate);
  const rows = comparisonRows.rows;
  const baselineHash = hashStableState(baseline);
  const candidateHash = hashStableState(candidate);
  const comparisonId = comparisonArtifactId({
    view: options.view,
    baselineRunId: baseline.runId,
    baselineMatchId: baseline.matchId,
    candidateRunId: candidate.runId,
    candidateMatchId: candidate.matchId,
    baselineHash,
    candidateHash
  });
  const baselineSummary = summarizeSource(baseline, baselineHash);
  const candidateSummary = summarizeSource(candidate, candidateHash);
  return {
    artifactVersion: MATCH_COMPARISON_ARTIFACT_VERSION,
    kind: "match-comparison",
    comparisonId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    view: options.view,
    projection: {
      view: options.view,
      privateEvidenceRedacted:
        sourceProjection(baseline)?.privateEvidenceRedacted ??
        options.view === "postgame-redacted",
      postgameTruthRedacted: sourceProjection(baseline)?.postgameTruthRedacted ?? false,
      generatedAt: sourceProjection(baseline)?.generatedAt ?? new Date(0).toISOString()
    },
    baseline: baselineSummary,
    candidate: candidateSummary,
    rows,
    summary: {
      rowCount: rows.length,
      changedRowCount: rows.filter((row) => row.changed).length,
      numericDeltaCount: rows.filter((row) => row.delta !== undefined).length,
      promotionChangedMetricCount: rows.filter(
        (row) => row.id.startsWith("metric_promotion:") && row.changed
      ).length,
      promotionProvenanceChangedMetricCount: comparisonRows.promotionProvenanceChangedMetricCount,
      scorecardMetricDelta:
        candidatePromotion.scorecardMetricCount - baselinePromotion.scorecardMetricCount,
      diagnosticMetricDelta:
        candidatePromotion.diagnosticMetricCount - baselinePromotion.diagnosticMetricCount,
      benchmarkOnlyMetricDelta:
        countPromotionClass(candidate.evaluationReport.metrics, promotionPolicyForReport(candidate), "benchmark_only") -
        countPromotionClass(baseline.evaluationReport.metrics, promotionPolicyForReport(baseline), "benchmark_only"),
      metricKeysCompared: comparisonRows.metricKeysCompared,
      metricKeysEmitted: comparisonRows.metricKeysEmitted,
      metricKeysTruncated: comparisonRows.metricKeysTruncated,
      scorecardMetricKeysCompared: comparisonRows.scorecardMetricKeysCompared,
      scorecardMetricKeysEmitted: comparisonRows.scorecardMetricKeysEmitted,
      scorecardMetricKeysTruncated: comparisonRows.scorecardMetricKeysTruncated,
      diagnosticMetricKeysCompared: comparisonRows.diagnosticMetricKeysCompared,
      diagnosticMetricKeysEmitted: comparisonRows.diagnosticMetricKeysEmitted,
      diagnosticMetricKeysTruncated: comparisonRows.diagnosticMetricKeysTruncated,
      benchmarkOnlyMetricKeysCompared: comparisonRows.benchmarkOnlyMetricKeysCompared,
      benchmarkOnlyMetricKeysEmitted: comparisonRows.benchmarkOnlyMetricKeysEmitted,
      benchmarkOnlyMetricKeysTruncated: comparisonRows.benchmarkOnlyMetricKeysTruncated,
      evidenceIdentityChangedMetricCount: comparisonRows.evidenceIdentityChangedMetricCount,
      evidenceIdentityOnlyBaselineRefCount: comparisonRows.evidenceIdentityOnlyBaselineRefCount,
      evidenceIdentityOnlyCandidateRefCount: comparisonRows.evidenceIdentityOnlyCandidateRefCount,
      baselineSocialSteps: baselineSummary.socialSteps,
      candidateSocialSteps: candidateSummary.socialSteps,
      baselineCommittedSteps: baselineSummary.committedSteps,
      candidateCommittedSteps: candidateSummary.committedSteps,
      baselineRejectedSteps: baselineSummary.rejectedSteps,
      candidateRejectedSteps: candidateSummary.rejectedSteps,
      socialStepsDelta: candidateSummary.socialSteps - baselineSummary.socialSteps,
      committedStepsDelta: candidateSummary.committedSteps - baselineSummary.committedSteps,
      rejectedStepsDelta: candidateSummary.rejectedSteps - baselineSummary.rejectedSteps,
      metricRowsMax: MATCH_COMPARISON_MAX_METRIC_ROWS,
      baselineHash,
      candidateHash
    }
  };
}

export const MATCH_COMPARISON_FILTERED_ARTIFACT_VERSION = "harness.match-comparison.filtered.v1";

export interface MatchComparisonFilteredProjection {
  artifactVersion: typeof MATCH_COMPARISON_FILTERED_ARTIFACT_VERSION;
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
  const normalizedFilter: Required<MatchComparisonRowFilter> = {
    group: filter.group ?? "all",
    changedOnly: Boolean(filter.changedOnly),
    promotion: filter.promotion ?? "all",
    evidenceIdentity: filter.evidenceIdentity ?? "all",
    numericDelta: filter.numericDelta ?? "all"
  };
  const rows = filterMatchComparisonRows(comparison.rows, normalizedFilter);
  let evidenceIdentityChangedMetricCount = 0;
  let evidenceIdentityOnlyBaselineRefCount = 0;
  let evidenceIdentityOnlyCandidateRefCount = 0;
  const promotionProvenanceMetricKeys = new Set<string>();
  for (const row of rows) {
    if (row.promotion?.details?.changedFields.some((field) => field !== "class") && row.metricId) {
      promotionProvenanceMetricKeys.add(`${row.metricId}::${row.subjectId ?? "episode"}`);
    }
    if (!row.id.startsWith("metric_evidence_ids:")) continue;
    evidenceIdentityChangedMetricCount += 1;
    evidenceIdentityOnlyBaselineRefCount += row.evidence?.onlyBaselineIds.length ?? 0;
    evidenceIdentityOnlyCandidateRefCount += row.evidence?.onlyCandidateIds.length ?? 0;
  }
  return {
    artifactVersion: MATCH_COMPARISON_FILTERED_ARTIFACT_VERSION,
    kind: "match-comparison-filtered",
    sourceComparisonId: comparison.comparisonId,
    createdAt: options?.createdAt ?? new Date().toISOString(),
    view: comparison.view,
    filter: normalizedFilter,
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
      promotionChangedMetricCount: rows.filter(
        (row) => row.id.startsWith("metric_promotion:") && row.changed
      ).length,
      promotionProvenanceChangedMetricCount: promotionProvenanceMetricKeys.size,
      evidenceIdentityChangedMetricCount,
      evidenceIdentityOnlyBaselineRefCount,
      evidenceIdentityOnlyCandidateRefCount,
      summaryRowCount: rows.filter((row) => (row.group ?? "summary") === "summary").length,
      metricRowCount: rows.filter((row) => row.group === "metric").length,
      metricEvidenceRowCount: rows.filter((row) => row.group === "metric_evidence").length,
      sourceRowCount: comparison.summary.rowCount,
      sourceChangedRowCount: comparison.summary.changedRowCount
    }
  };
}

export function formatFilteredMatchComparisonMarkdown(
  projection: MatchComparisonFilteredProjection
): string {
  const lines: string[] = [];
  lines.push(`# Match Comparison Filtered View`);
  lines.push("");
  lines.push(`- artifactVersion: \`${projection.artifactVersion}\``);
  lines.push(`- sourceComparisonId: \`${projection.sourceComparisonId}\``);
  lines.push(`- view: \`${projection.view}\``);
  lines.push(`- createdAt: \`${projection.createdAt}\``);
  lines.push(
    `- filter: group=${projection.filter.group}, changedOnly=${projection.filter.changedOnly}, promotion=${projection.filter.promotion}, evidenceIdentity=${projection.filter.evidenceIdentity}, numericDelta=${projection.filter.numericDelta}`
  );
  lines.push(
    `- summary: rows=${projection.summary.rowCount}/${projection.summary.sourceRowCount}, changed=${projection.summary.changedRowCount}/${projection.summary.sourceChangedRowCount}, numericDeltas=${projection.summary.numericDeltaCount}, promotionChangedMetrics=${projection.summary.promotionChangedMetricCount}, promotionProvenanceChangedMetrics=${projection.summary.promotionProvenanceChangedMetricCount}, evidenceIdentityChangedMetrics=${projection.summary.evidenceIdentityChangedMetricCount}, evidenceIdentityOnlyBaselineRefs=${projection.summary.evidenceIdentityOnlyBaselineRefCount}, evidenceIdentityOnlyCandidateRefs=${projection.summary.evidenceIdentityOnlyCandidateRefCount}, summaryRows=${projection.summary.summaryRowCount}, metricRows=${projection.summary.metricRowCount}, metricEvidenceRows=${projection.summary.metricEvidenceRowCount}, sourceSocialStepsDelta=${projection.source.summary.socialStepsDelta}, sourceCommittedStepsDelta=${projection.source.summary.committedStepsDelta}, sourceRejectedStepsDelta=${projection.source.summary.rejectedStepsDelta}`
  );
  lines.push("");
  lines.push(`## Sources`);
  lines.push("");
  lines.push(formatSourceMarkdown("Baseline", projection.source.baseline));
  lines.push("");
  lines.push(formatSourceMarkdown("Candidate", projection.source.candidate));
  lines.push("");
  lines.push(`## Filtered Rows`);
  lines.push("");
  if (!projection.rows.length) {
    lines.push("_No rows matched the filter._");
  } else {
    lines.push(`| changed | group | id | label | baseline | candidate | delta | promotion | evidence |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const row of projection.rows) {
      const evidence = row.evidence
        ? `${row.evidence.baselineRefs}→${row.evidence.candidateRefs}${
            row.evidence.onlyBaselineIds.length || row.evidence.onlyCandidateIds.length
              ? ` · Δids ${row.evidence.onlyBaselineIds.length}→${row.evidence.onlyCandidateIds.length}`
              : ""
          }`
        : "—";
      const promotion = row.promotion ? `${row.promotion.baseline}→${row.promotion.candidate}` : "—";
      lines.push(
        `| ${row.changed ? "yes" : "no"} | ${row.group ?? "summary"} | \`${escapeMarkdownCell(row.id)}\` | ${escapeMarkdownCell(row.label)} | ${escapeMarkdownCell(String(row.baseline))} | ${escapeMarkdownCell(String(row.candidate))} | ${row.delta ?? "—"} | ${promotion} | ${evidence} |`
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}


export function formatMatchComparisonMarkdown(comparison: MatchComparisonArtifact): string {
  const lines: string[] = [];
  lines.push(`# Match Comparison`);
  lines.push("");
  lines.push(`- comparisonId: \`${comparison.comparisonId}\``);
  lines.push(`- view: \`${comparison.view}\``);
  lines.push(`- createdAt: \`${comparison.createdAt}\``);
  lines.push(
    `- summary: rows=${comparison.summary.rowCount}, changed=${comparison.summary.changedRowCount}, numericDeltas=${comparison.summary.numericDeltaCount}, promotionChangedMetrics=${comparison.summary.promotionChangedMetricCount}, promotionProvenanceChangedMetrics=${comparison.summary.promotionProvenanceChangedMetricCount}, scorecardDelta=${comparison.summary.scorecardMetricDelta}, diagnosticDelta=${comparison.summary.diagnosticMetricDelta}, benchmarkOnlyDelta=${comparison.summary.benchmarkOnlyMetricDelta}, socialStepsDelta=${comparison.summary.socialStepsDelta}, committedStepsDelta=${comparison.summary.committedStepsDelta}, rejectedStepsDelta=${comparison.summary.rejectedStepsDelta}, metricKeys=${comparison.summary.metricKeysEmitted}/${comparison.summary.metricKeysCompared}, truncatedKeys=${comparison.summary.metricKeysTruncated}, scorecardKeys=${comparison.summary.scorecardMetricKeysEmitted}/${comparison.summary.scorecardMetricKeysCompared}, scorecardTruncated=${comparison.summary.scorecardMetricKeysTruncated}, diagnosticKeys=${comparison.summary.diagnosticMetricKeysEmitted}/${comparison.summary.diagnosticMetricKeysCompared}, diagnosticTruncated=${comparison.summary.diagnosticMetricKeysTruncated}, benchmarkOnlyKeys=${comparison.summary.benchmarkOnlyMetricKeysEmitted}/${comparison.summary.benchmarkOnlyMetricKeysCompared}, benchmarkOnlyTruncated=${comparison.summary.benchmarkOnlyMetricKeysTruncated}, evidenceIdentityChangedMetrics=${comparison.summary.evidenceIdentityChangedMetricCount}, evidenceIdentityOnlyBaselineRefs=${comparison.summary.evidenceIdentityOnlyBaselineRefCount}, evidenceIdentityOnlyCandidateRefs=${comparison.summary.evidenceIdentityOnlyCandidateRefCount}`
  );
  lines.push("");
  lines.push(`## Sources`);
  lines.push("");
  lines.push(formatSourceMarkdown("Baseline", comparison.baseline));
  lines.push("");
  lines.push(formatSourceMarkdown("Candidate", comparison.candidate));
  lines.push("");
  lines.push(`## Changed Rows`);
  lines.push("");
  const changed = comparison.rows.filter((row) => row.changed);
  if (!changed.length) {
    lines.push("_No changed rows._");
  } else {
    lines.push(`| group | id | label | baseline | candidate | delta | promotion | evidence |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const row of changed) {
      const evidence = row.evidence
        ? `${row.evidence.baselineRefs}→${row.evidence.candidateRefs}${
            row.evidence.onlyBaselineIds.length || row.evidence.onlyCandidateIds.length
              ? ` · Δids ${row.evidence.onlyBaselineIds.length}→${row.evidence.onlyCandidateIds.length}`
              : ""
          }`
        : "—";
      const promotion = row.promotion ? `${row.promotion.baseline}→${row.promotion.candidate}` : "—";
      lines.push(
        `| ${row.group ?? "summary"} | \`${escapeMarkdownCell(row.id)}\` | ${escapeMarkdownCell(row.label)} | ${escapeMarkdownCell(String(row.baseline))} | ${escapeMarkdownCell(String(row.candidate))} | ${row.delta ?? "—"} | ${promotion} | ${evidence} |`
      );
    }
  }
  lines.push("");
  lines.push(`## All Rows`);
  lines.push("");
  lines.push(`| changed | group | id | label | baseline | candidate | delta | promotion |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const row of comparison.rows) {
    const promotion = row.promotion ? `${row.promotion.baseline}→${row.promotion.candidate}` : "—";
    lines.push(
      `| ${row.changed ? "yes" : "no"} | ${row.group ?? "summary"} | \`${escapeMarkdownCell(row.id)}\` | ${escapeMarkdownCell(row.label)} | ${escapeMarkdownCell(String(row.baseline))} | ${escapeMarkdownCell(String(row.candidate))} | ${row.delta ?? "—"} | ${promotion} |`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function formatTournamentComparisonMarkdown(comparison: TournamentComparisonAggregate): string {
  const lines: string[] = [];
  lines.push(`# Tournament Comparison`);
  lines.push("");
  lines.push(`- comparisonSetId: \`${comparison.comparisonSetId}\``);
  lines.push(`- view: \`${comparison.view}\``);
  lines.push(`- createdAt: \`${comparison.createdAt}\``);
  lines.push(`- tournamentSeed: \`${comparison.tournamentSeed}\``);
  lines.push(`- experimentId: \`${comparison.experimentId ?? "—"}\``);
  lines.push(
    `- summary: matches=${comparison.artifactMatchCount}, pairs=${comparison.pairCount}, changedPairs=${comparison.summary.changedPairCount}, totalChangedRows=${comparison.summary.totalChangedRows}, avgChangedRows=${comparison.summary.averageChangedRows}, scorecardDelta=${comparison.summary.totalScorecardMetricDelta}, diagnosticDelta=${comparison.summary.totalDiagnosticMetricDelta}, benchmarkOnlyDelta=${comparison.summary.totalBenchmarkOnlyMetricDelta}, promotionProvenanceChanged=${comparison.summary.totalPromotionProvenanceChangedMetrics}, evidenceIdentityChanged=${comparison.summary.totalEvidenceIdentityChangedMetrics}, socialStepsDelta=${comparison.summary.totalSocialStepsDelta}, committedStepsDelta=${comparison.summary.totalCommittedStepsDelta}, rejectedStepsDelta=${comparison.summary.totalRejectedStepsDelta}`
  );
  lines.push(`- pairIdentityHash: \`${comparison.summary.pairIdentityHash}\``);
  lines.push("");
  lines.push(`## Pairs`);
  lines.push("");
  if (!comparison.pairs.length) {
    lines.push("_No pairwise comparisons. At least two match artifacts are required._");
  } else {
    lines.push(
      `| baselineEpisode | candidateEpisode | comparisonId | changedRows | numericDeltas | socialStepsΔ | committedΔ | rejectedΔ | scorecardΔ | diagnosticΔ | benchmarkOnlyΔ | promotionProvenanceChanged | evidenceIdentityChanged |`
    );
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const pair of comparison.pairs) {
      lines.push(
        `| ${pair.baseline.episodeIndex} | ${pair.candidate.episodeIndex} | \`${escapeMarkdownCell(pair.comparisonId)}\` | ${pair.changedRowCount} | ${pair.numericDeltaCount} | ${pair.socialStepsDelta} | ${pair.committedStepsDelta} | ${pair.rejectedStepsDelta} | ${pair.scorecardMetricDelta} | ${pair.diagnosticMetricDelta} | ${pair.benchmarkOnlyMetricDelta} | ${pair.promotionProvenanceChangedMetricCount} | ${pair.evidenceIdentityChangedMetricCount} |`
      );
    }
  }
  lines.push("");
  lines.push(`## Metric Change Frequency`);
  lines.push("");
  if (!comparison.metricChangeFrequency.length) {
    lines.push("_No metric frequency rows._");
  } else {
    lines.push(`| metricKey | label | pairs | changedPairs | avgAbsDelta |`);
    lines.push(`| --- | --- | --- | --- | --- |`);
    for (const metric of comparison.metricChangeFrequency) {
      lines.push(
        `| \`${escapeMarkdownCell(metric.metricKey)}\` | ${escapeMarkdownCell(metric.label)} | ${metric.pairCount} | ${metric.changedPairCount} | ${metric.averageAbsoluteDelta ?? "—"} |`
      );
    }
  }
  lines.push("");
  lines.push(`## Interpretation Policy`);
  lines.push("");
  lines.push(
    "This aggregate is a pure projection over recorded match artifacts. It summarizes pairwise comparison artifacts and does not invent winners, private evidence, causality, persuasion success, or counterfactual superiority claims."
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}


function formatSourceMarkdown(title: string, source: MatchComparisonSourceSummary): string {
  return [
    `### ${title}`,
    "",
    `- matchId: \`${source.matchId ?? "—"}\``,
    `- runId: \`${source.runId ?? "—"}\``,
    `- status: \`${source.status}\``,
    `- models: ${source.models.map((model) => `\`${model}\``).join(", ") || "—"}`,
    `- trajectorySteps: ${source.trajectorySteps}`,
    `- socialSteps: ${source.socialSteps}`,
    `- committedSteps: ${source.committedSteps}`,
    `- rejectedSteps: ${source.rejectedSteps}`,
    `- evaluationMetricCount: ${source.evaluationMetricCount}`,
    `- stateHash: \`${source.stateHash}\``
  ].join("\n");
}

interface TruthRedactedComparisonSnapshot {
  status: string;
  createdAt?: string;
  phase: string;
  day: number;
  alivePlayers: number;
  publicEvents: Array<{ seq: number | null; day: number | null; type: string }>;
  schedulerMode: string;
  publicChannelCount: number;
  publicMessageCount: number;
  publicSpeechActCount: number;
  projection?: MatchComparisonProjection;
}

/**
 * Public comparisons deliberately operate on a newly narrowed snapshot. This
 * prevents an accidental full artifact input from contributing hidden state
 * merely because a caller requested a truth-redacted view.
 */
function buildTruthRedactedMatchComparisonArtifact(options: {
  baseline: MatchComparisonInput;
  candidate: MatchComparisonInput;
  view: "truth-redacted";
  createdAt?: string;
}): MatchComparisonArtifact {
  const baseline = truthRedactedComparisonSnapshot(options.baseline);
  const candidate = truthRedactedComparisonSnapshot(options.candidate);
  const baselineHash = hashStableState(truthRedactedComparisonFingerprint(baseline));
  const candidateHash = hashStableState(truthRedactedComparisonFingerprint(candidate));
  const rows = sortComparisonRows([
    stringRow("status", "状态", baseline.status, candidate.status),
    stringRow("phase", "阶段", baseline.phase, candidate.phase),
    stringRow("social_scheduler", "社会调度器", baseline.schedulerMode, candidate.schedulerMode),
    numberRow("day", "天数", baseline.day, candidate.day),
    numberRow("alive_players", "存活玩家", baseline.alivePlayers, candidate.alivePlayers),
    numberRow("public_game_events", "公开游戏事件", baseline.publicEvents.length, candidate.publicEvents.length),
    numberRow("public_social_messages", "公开社会消息", baseline.publicMessageCount, candidate.publicMessageCount),
    numberRow("public_social_speech_acts", "公开言语行为", baseline.publicSpeechActCount, candidate.publicSpeechActCount),
    numberRow("public_social_channels", "公开通信通道", baseline.publicChannelCount, candidate.publicChannelCount)
  ].map((row) => ({ ...row, group: "summary" as const })));
  const projection: MatchComparisonProjection = {
    view: "truth-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: true,
    generatedAt: baseline.projection?.generatedAt ?? candidate.projection?.generatedAt ?? new Date(0).toISOString()
  };
  const comparisonId = comparisonArtifactId({
    view: "truth-redacted",
    baselineHash,
    candidateHash
  });

  return {
    artifactVersion: MATCH_COMPARISON_ARTIFACT_VERSION,
    kind: "match-comparison",
    comparisonId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    view: "truth-redacted",
    projection,
    baseline: truthRedactedSourceSummary(baseline, baselineHash),
    candidate: truthRedactedSourceSummary(candidate, candidateHash),
    rows,
    summary: {
      rowCount: rows.length,
      changedRowCount: rows.filter((row) => row.changed).length,
      numericDeltaCount: rows.filter((row) => row.delta !== undefined).length,
      promotionChangedMetricCount: 0,
      promotionProvenanceChangedMetricCount: 0,
      scorecardMetricDelta: 0,
      diagnosticMetricDelta: 0,
      benchmarkOnlyMetricDelta: 0,
      metricKeysCompared: 0,
      metricKeysEmitted: 0,
      metricKeysTruncated: 0,
      scorecardMetricKeysCompared: 0,
      scorecardMetricKeysEmitted: 0,
      scorecardMetricKeysTruncated: 0,
      diagnosticMetricKeysCompared: 0,
      diagnosticMetricKeysEmitted: 0,
      diagnosticMetricKeysTruncated: 0,
      benchmarkOnlyMetricKeysCompared: 0,
      benchmarkOnlyMetricKeysEmitted: 0,
      benchmarkOnlyMetricKeysTruncated: 0,
      evidenceIdentityChangedMetricCount: 0,
      evidenceIdentityOnlyBaselineRefCount: 0,
      evidenceIdentityOnlyCandidateRefCount: 0,
      baselineSocialSteps: 0,
      candidateSocialSteps: 0,
      baselineCommittedSteps: 0,
      candidateCommittedSteps: 0,
      baselineRejectedSteps: 0,
      candidateRejectedSteps: 0,
      socialStepsDelta: 0,
      committedStepsDelta: 0,
      rejectedStepsDelta: 0,
      metricRowsMax: MATCH_COMPARISON_MAX_METRIC_ROWS,
      baselineHash,
      candidateHash
    }
  };
}

function truthRedactedComparisonSnapshot(source: MatchComparisonInput): TruthRedactedComparisonSnapshot {
  const redacted = source as TruthRedactedMatchComparisonSource;
  const state = recordOf(redacted.finalState);
  const socialEpisode = recordOf(redacted.socialEpisode);
  const publicChannels = recordsOf(socialEpisode?.channels).filter(
    (channel) => channel.kind === "public" && channel.readableBy === "all"
  );
  const publicChannelIds = new Set(
    publicChannels.flatMap((channel) => (typeof channel.id === "string" ? [channel.id] : []))
  );
  const publicMessages = recordsOf(socialEpisode?.messages).filter(
    (message) => message.visibility === "public" && typeof message.channelId === "string" && publicChannelIds.has(message.channelId)
  );
  const publicEvents = recordsOf(state?.events)
    .filter((event) => event.visibility === "public")
    .map((event) => ({
      seq: finiteNumber(event.seq) ?? null,
      day: finiteNumber(event.day) ?? null,
      type: stringValue(event.type) ?? "unknown"
    }));

  return {
    status: stringValue(redacted.status) ?? "unknown",
    createdAt: stringValue(redacted.createdAt),
    phase: stringValue(state?.phase) ?? "unknown",
    day: finiteNumber(state?.day) ?? 0,
    alivePlayers: recordsOf(state?.players).filter((player) => player.alive === true).length,
    publicEvents,
    schedulerMode: stringValue(socialEpisode?.schedulerMode) ?? "unknown",
    publicChannelCount: publicChannels.length,
    publicMessageCount: publicMessages.length,
    publicSpeechActCount: publicMessages.reduce(
      (count, message) => count + (Array.isArray(message.speechActs) ? message.speechActs.length : 0),
      0
    ),
    projection: redacted.projection
  };
}

function truthRedactedComparisonFingerprint(snapshot: TruthRedactedComparisonSnapshot): Record<string, unknown> {
  return {
    status: snapshot.status,
    phase: snapshot.phase,
    day: snapshot.day,
    alivePlayers: snapshot.alivePlayers,
    publicEvents: snapshot.publicEvents,
    schedulerMode: snapshot.schedulerMode,
    publicChannelCount: snapshot.publicChannelCount,
    publicMessageCount: snapshot.publicMessageCount,
    publicSpeechActCount: snapshot.publicSpeechActCount
  };
}

function truthRedactedSourceSummary(
  snapshot: TruthRedactedComparisonSnapshot,
  artifactHash: string
): MatchComparisonSourceSummary {
  return {
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    projection: snapshot.projection,
    models: [],
    profileCount: 0,
    resolvedAssignmentCount: 0,
    agentCount: 0,
    trajectorySteps: 0,
    socialSteps: 0,
    committedSteps: 0,
    rejectedSteps: 0,
    socialMessages: snapshot.publicMessageCount,
    socialSpeechActs: snapshot.publicSpeechActCount,
    socialDeliveryReceipts: 0,
    socialChannels: snapshot.publicChannelCount,
    gameEvents: snapshot.publicEvents.length,
    evaluationMetricCount: 0,
    evaluationWarningCount: 0,
    evaluatorCount: 0,
    stateHash: hashStableState({
      phase: snapshot.phase,
      day: snapshot.day,
      alivePlayers: snapshot.alivePlayers,
      publicEvents: snapshot.publicEvents
    }),
    artifactHash
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = recordOf(item);
        return record ? [record] : [];
      })
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function countPromotionClass(
  metrics: HarnessMetricRecord[],
  fallbackPolicy: MetricPromotionPolicy,
  promotionClass: "scorecard" | "diagnostic" | "benchmark_only"
): number {
  return metrics.filter((metric) => resolveRecordedMetricPromotion(metric, fallbackPolicy).promotionClass === promotionClass).length;
}

function promotionPolicyForReport(source: MatchComparisonSource): MetricPromotionPolicy {
  return legacyMetricPromotionPolicyFromSummary(source.evaluationReport?.summary?.promotion);
}

function promotionSummaryForReport(source: MatchComparisonSource): MatchComparisonSource["evaluationReport"]["summary"]["promotion"] {
  return normalizeMetricPromotionSummary(source.evaluationReport?.summary?.promotion);
}

function promotionIdentityLabel(promotion: MatchComparisonSource["evaluationReport"]["summary"]["promotion"]): string {
  const policyVersion = promotion.policyVersion;
  const catalogVersion = promotion.catalogVersion;
  const catalogHash = promotion.catalogHash;
  return `${promotion.policyId}@${policyVersion} / ${promotion.catalogId}@${catalogVersion}#${catalogHash.slice(0, 12)}`;
}

function promotionDecisionSnapshot(
  decision: HarnessMetricPromotionDecision
): MatchComparisonPromotionDecisionSnapshot {
  return {
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    policyHash: decision.policyHash,
    catalogId: decision.catalogId,
    catalogVersion: decision.catalogVersion,
    catalogHash: decision.catalogHash,
    catalogDomainId: decision.catalogDomainId,
    catalogDecisionId: decision.catalogDecisionId ?? null,
    eligibleForScorecard: decision.eligibleForScorecard,
    resolution: decision.resolution,
    reasons: [...decision.reasons].sort()
  };
}

function sameStringValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function promotionDetails(
  baselineDecision: HarnessMetricPromotionDecision | undefined,
  candidateDecision: HarnessMetricPromotionDecision | undefined
): MatchComparisonPromotionDetails {
  const baseline = baselineDecision ? promotionDecisionSnapshot(baselineDecision) : null;
  const candidate = candidateDecision ? promotionDecisionSnapshot(candidateDecision) : null;
  const changedFields: MatchComparisonPromotionChangeField[] = [];

  if (!baselineDecision || !candidateDecision) {
    if (baselineDecision !== candidateDecision) changedFields.push("class");
    return {
      baseline,
      candidate,
      changed: changedFields.length > 0,
      changedFields
    };
  }

  const baselineSnapshot = baseline!;
  const candidateSnapshot = candidate!;
  if (baselineDecision.promotionClass !== candidateDecision.promotionClass) changedFields.push("class");
  if (baselineSnapshot.eligibleForScorecard !== candidateSnapshot.eligibleForScorecard) changedFields.push("eligibility");
  if (!sameStringValues(baselineSnapshot.reasons, candidateSnapshot.reasons)) changedFields.push("reasons");
  if (baselineSnapshot.catalogDecisionId !== candidateSnapshot.catalogDecisionId) changedFields.push("catalogDecisionId");
  if (
    baselineSnapshot.policyId !== candidateSnapshot.policyId ||
    baselineSnapshot.policyVersion !== candidateSnapshot.policyVersion ||
    baselineSnapshot.policyHash !== candidateSnapshot.policyHash
  ) {
    changedFields.push("policy");
  }
  if (
    baselineSnapshot.catalogId !== candidateSnapshot.catalogId ||
    baselineSnapshot.catalogVersion !== candidateSnapshot.catalogVersion ||
    baselineSnapshot.catalogHash !== candidateSnapshot.catalogHash ||
    baselineSnapshot.catalogDomainId !== candidateSnapshot.catalogDomainId
  ) {
    changedFields.push("catalog");
  }
  if (baselineSnapshot.resolution !== candidateSnapshot.resolution) changedFields.push("resolution");
  return {
    baseline,
    candidate,
    changed: changedFields.length > 0,
    changedFields
  };
}

function buildComparisonRows(
  baseline: MatchComparisonSource,
  candidate: MatchComparisonSource
): {
  rows: MatchComparisonRow[];
  metricKeysCompared: number;
  metricKeysEmitted: number;
  metricKeysTruncated: number;
  scorecardMetricKeysCompared: number;
  scorecardMetricKeysEmitted: number;
  scorecardMetricKeysTruncated: number;
  diagnosticMetricKeysCompared: number;
  diagnosticMetricKeysEmitted: number;
  diagnosticMetricKeysTruncated: number;
  benchmarkOnlyMetricKeysCompared: number;
  benchmarkOnlyMetricKeysEmitted: number;
  benchmarkOnlyMetricKeysTruncated: number;
  promotionProvenanceChangedMetricCount: number;
  evidenceIdentityChangedMetricCount: number;
  evidenceIdentityOnlyBaselineRefCount: number;
  evidenceIdentityOnlyCandidateRefCount: number;
} {
  const baselineUsage = summarizeModelUsage(baseline.metrics.modelUsage);
  const candidateUsage = summarizeModelUsage(candidate.metrics.modelUsage);
  const baselinePromotion = promotionSummaryForReport(baseline);
  const candidatePromotion = promotionSummaryForReport(candidate);
  const baselinePromotionPolicy = promotionPolicyForReport(baseline);
  const candidatePromotionPolicy = promotionPolicyForReport(candidate);
  const baselineStepCounts = countSocialStepCommits(baseline.socialEpisode.steps);
  const candidateStepCounts = countSocialStepCommits(candidate.socialEpisode.steps);
  const summaryRows: MatchComparisonRow[] = [
    stringRow("status", "状态", baseline.status, candidate.status),
    stringRow("winner", "胜者", baseline.finalState.winner ?? baseline.metrics.winner ?? "未结束", candidate.finalState.winner ?? candidate.metrics.winner ?? "未结束"),
    stringRow("truncation_reason", "截断原因", baseline.truncationReason ?? "无", candidate.truncationReason ?? "无"),
    stringRow("failure_reason", "失败原因", baseline.failureReason ?? "无", candidate.failureReason ?? "无"),
    stringRow("models", "模型", baseline.models.join(", ") || "暂无", candidate.models.join(", ") || "暂无"),
    stringRow("social_scheduler", "社会调度器", baseline.socialEpisode.schedulerMode, candidate.socialEpisode.schedulerMode),
    numberRow("trajectory_steps", "轨迹步数", baseline.trajectory.length, candidate.trajectory.length),
    numberRow("social_steps", "社会调度步", baselineStepCounts.nativeSteps, candidateStepCounts.nativeSteps),
    numberRow("committed_steps", "已提交步", baselineStepCounts.committedSteps, candidateStepCounts.committedSteps),
    numberRow("rejected_steps", "已拒绝步", baselineStepCounts.rejectedSteps, candidateStepCounts.rejectedSteps),
    numberRow("social_messages", "社会消息", baseline.socialEpisode.messages.length, candidate.socialEpisode.messages.length),
    numberRow("social_speech_acts", "社会言语行为", countSocialSpeechActs(baseline), countSocialSpeechActs(candidate)),
    numberRow("social_delivery_receipts", "消息投递凭证", countSocialDeliveryReceipts(baseline), countSocialDeliveryReceipts(candidate)),
    numberRow("social_channels", "通信通道", baseline.socialEpisode.channels.length, candidate.socialEpisode.channels.length),
    numberRow("profiles", "profiles", baseline.profiles.length, candidate.profiles.length),
    numberRow("resolved_assignments", "resolved assignments", baseline.resolvedAssignments.length, candidate.resolvedAssignments.length),
    numberRow("agents", "智能体状态", baseline.agents.length, candidate.agents.length),
    numberRow("game_events", "游戏事件", baseline.finalState.events.length, candidate.finalState.events.length),
    numberRow("days", "天数", baseline.metrics.days, candidate.metrics.days),
    numberRow("deaths", "死亡", baseline.metrics.totalDeaths, candidate.metrics.totalDeaths),
    numberRow("speeches", "发言", baseline.metrics.totalSpeeches, candidate.metrics.totalSpeeches),
    numberRow("votes", "投票", baseline.metrics.totalVotes, candidate.metrics.totalVotes),
    numberRow("harness_turns", "harness turn", baseline.metrics.harnessTurnCount, candidate.metrics.harnessTurnCount),
    numberRow("harness_errors", "harness error", baseline.metrics.harnessErrorCount, candidate.metrics.harnessErrorCount),
    numberRow("average_latency_ms", "平均模型延迟(ms)", Math.round(baseline.metrics.averageLatencyMs), Math.round(candidate.metrics.averageLatencyMs)),
    numberRow("model_calls", "模型调用", baselineUsage.calls, candidateUsage.calls),
    numberRow("prompt_tokens", "prompt tokens", baselineUsage.promptTokens, candidateUsage.promptTokens),
    numberRow("completion_tokens", "completion tokens", baselineUsage.completionTokens, candidateUsage.completionTokens),
    numberRow("evaluation_metrics", "评测指标", baseline.evaluationReport.metricCount, candidate.evaluationReport.metricCount),
    numberRow("evaluation_warnings", "评测告警", baseline.evaluationReport.warnings?.length ?? 0, candidate.evaluationReport.warnings?.length ?? 0),
    numberRow("evaluators", "evaluator 数", baseline.evaluationReport.evaluatorIds.length, candidate.evaluationReport.evaluatorIds.length),
    stringRow("metric_promotion_policy", "metric promotion policy", promotionIdentityLabel(baselinePromotion), promotionIdentityLabel(candidatePromotion)),
    numberRow(
      "scorecard_metrics",
      "scorecard 指标",
      baselinePromotion.scorecardMetricCount,
      candidatePromotion.scorecardMetricCount
    ),
    numberRow(
      "diagnostic_metrics",
      "diagnostic 指标",
      baselinePromotion.diagnosticMetricCount,
      candidatePromotion.diagnosticMetricCount
    ),
    numberRow(
      "benchmark_only_metrics",
      "benchmark_only 指标",
      countPromotionClass(baseline.evaluationReport.metrics, baselinePromotionPolicy, "benchmark_only"),
      countPromotionClass(candidate.evaluationReport.metrics, candidatePromotionPolicy, "benchmark_only")
    ),
    numberRow(
      "scorecard_to_diagnostic_gap",
      "scorecard-diagnostic 差值",
      baselinePromotion.scorecardMetricCount - baselinePromotion.diagnosticMetricCount,
      candidatePromotion.scorecardMetricCount - candidatePromotion.diagnosticMetricCount
    ),
    numberRow(
      "metrics_with_evidence",
      "带 evidence 的指标",
      countMetricsWithEvidence(baseline.evaluationReport.metrics),
      countMetricsWithEvidence(candidate.evaluationReport.metrics)
    ),
    numberRow(
      "metric_evidence_refs",
      "metric evidence refs",
      countMetricEvidenceRefs(baseline.evaluationReport.metrics),
      countMetricEvidenceRefs(candidate.evaluationReport.metrics)
    ),
    numberRow("social_exposures", "观察暴露记录", countSocialExposureRecords(baseline), countSocialExposureRecords(candidate)),
    numberRow("relationship_edges", "关系边", countRelationshipEdges(baseline), countRelationshipEdges(candidate)),
    numberRow("reputation_edges", "声誉边", countReputationEdges(baseline), countReputationEdges(candidate))
  ].map((row) => ({ ...row, group: "summary" as const }));

  const metricRows = buildMetricEvidenceRows(
    baseline.evaluationReport.metrics,
    candidate.evaluationReport.metrics,
    baselinePromotionPolicy,
    candidatePromotionPolicy
  );
  const truncationRows: MatchComparisonRow[] = [
    numberRow(
      "metric_keys_compared",
      "metric keys compared",
      metricRows.metricKeysCompared,
      metricRows.metricKeysCompared
    ),
    numberRow(
      "metric_keys_emitted",
      "metric keys emitted",
      metricRows.metricKeysEmitted,
      metricRows.metricKeysEmitted
    ),
    numberRow(
      "metric_keys_truncated",
      "metric keys truncated",
      metricRows.metricKeysTruncated,
      metricRows.metricKeysTruncated
    ),
    numberRow(
      "scorecard_metric_keys_compared",
      "scorecard metric keys compared",
      metricRows.scorecardMetricKeysCompared,
      metricRows.scorecardMetricKeysCompared
    ),
    numberRow(
      "scorecard_metric_keys_emitted",
      "scorecard metric keys emitted",
      metricRows.scorecardMetricKeysEmitted,
      metricRows.scorecardMetricKeysEmitted
    ),
    numberRow(
      "scorecard_metric_keys_truncated",
      "scorecard metric keys truncated",
      metricRows.scorecardMetricKeysTruncated,
      metricRows.scorecardMetricKeysTruncated
    ),
    numberRow(
      "diagnostic_metric_keys_compared",
      "diagnostic metric keys compared",
      metricRows.diagnosticMetricKeysCompared,
      metricRows.diagnosticMetricKeysCompared
    ),
    numberRow(
      "diagnostic_metric_keys_emitted",
      "diagnostic metric keys emitted",
      metricRows.diagnosticMetricKeysEmitted,
      metricRows.diagnosticMetricKeysEmitted
    ),
    numberRow(
      "diagnostic_metric_keys_truncated",
      "diagnostic metric keys truncated",
      metricRows.diagnosticMetricKeysTruncated,
      metricRows.diagnosticMetricKeysTruncated
    ),
    numberRow(
      "benchmark_only_metric_keys_compared",
      "benchmark_only metric keys compared",
      metricRows.benchmarkOnlyMetricKeysCompared,
      metricRows.benchmarkOnlyMetricKeysCompared
    ),
    numberRow(
      "benchmark_only_metric_keys_emitted",
      "benchmark_only metric keys emitted",
      metricRows.benchmarkOnlyMetricKeysEmitted,
      metricRows.benchmarkOnlyMetricKeysEmitted
    ),
    numberRow(
      "benchmark_only_metric_keys_truncated",
      "benchmark_only metric keys truncated",
      metricRows.benchmarkOnlyMetricKeysTruncated,
      metricRows.benchmarkOnlyMetricKeysTruncated
    ),
    numberRow(
      "promotion_provenance_changed_metrics",
      "metric promotion provenance changed",
      metricRows.promotionProvenanceChangedMetricCount,
      metricRows.promotionProvenanceChangedMetricCount
    ),
    numberRow(
      "evidence_identity_changed_metrics",
      "evidence identity changed metrics",
      metricRows.evidenceIdentityChangedMetricCount,
      metricRows.evidenceIdentityChangedMetricCount
    ),
    numberRow(
      "evidence_identity_only_baseline_refs",
      "evidence identity only-baseline refs",
      metricRows.evidenceIdentityOnlyBaselineRefCount,
      metricRows.evidenceIdentityOnlyBaselineRefCount
    ),
    numberRow(
      "evidence_identity_only_candidate_refs",
      "evidence identity only-candidate refs",
      metricRows.evidenceIdentityOnlyCandidateRefCount,
      metricRows.evidenceIdentityOnlyCandidateRefCount
    ),
    numberRow(
      "metric_rows_max",
      "metric rows max",
      MATCH_COMPARISON_MAX_METRIC_ROWS,
      MATCH_COMPARISON_MAX_METRIC_ROWS
    )
  ].map((row) => ({ ...row, group: "summary" as const }));

  return {
    rows: sortComparisonRows([...summaryRows, ...truncationRows, ...metricRows.rows]),
    metricKeysCompared: metricRows.metricKeysCompared,
    metricKeysEmitted: metricRows.metricKeysEmitted,
    metricKeysTruncated: metricRows.metricKeysTruncated,
    scorecardMetricKeysCompared: metricRows.scorecardMetricKeysCompared,
    scorecardMetricKeysEmitted: metricRows.scorecardMetricKeysEmitted,
    scorecardMetricKeysTruncated: metricRows.scorecardMetricKeysTruncated,
    diagnosticMetricKeysCompared: metricRows.diagnosticMetricKeysCompared,
    diagnosticMetricKeysEmitted: metricRows.diagnosticMetricKeysEmitted,
    diagnosticMetricKeysTruncated: metricRows.diagnosticMetricKeysTruncated,
    benchmarkOnlyMetricKeysCompared: metricRows.benchmarkOnlyMetricKeysCompared,
    benchmarkOnlyMetricKeysEmitted: metricRows.benchmarkOnlyMetricKeysEmitted,
    benchmarkOnlyMetricKeysTruncated: metricRows.benchmarkOnlyMetricKeysTruncated,
    promotionProvenanceChangedMetricCount: metricRows.promotionProvenanceChangedMetricCount,
    evidenceIdentityChangedMetricCount: metricRows.evidenceIdentityChangedMetricCount,
    evidenceIdentityOnlyBaselineRefCount: metricRows.evidenceIdentityOnlyBaselineRefCount,
    evidenceIdentityOnlyCandidateRefCount: metricRows.evidenceIdentityOnlyCandidateRefCount
  };
}

function summarizeSource(artifact: MatchComparisonSource, artifactHash: string): MatchComparisonSourceSummary {
  const stepCounts = countSocialStepCommits(artifact.socialEpisode.steps);
  return {
    matchId: artifact.matchId,
    runId: artifact.runId,
    seed: artifact.seed,
    createdAt: artifact.createdAt,
    status: artifact.status,
    truncationReason: artifact.truncationReason,
    failureReason: artifact.failureReason,
    projection: sourceProjection(artifact),
    models: [...artifact.models],
    profileCount: artifact.profiles.length,
    resolvedAssignmentCount: artifact.resolvedAssignments.length,
    agentCount: artifact.agents.length,
    trajectorySteps: artifact.trajectory.length,
    socialSteps: stepCounts.nativeSteps,
    committedSteps: stepCounts.committedSteps,
    rejectedSteps: stepCounts.rejectedSteps,
    socialMessages: artifact.socialEpisode.messages.length,
    socialSpeechActs: countSocialSpeechActs(artifact),
    socialDeliveryReceipts: countSocialDeliveryReceipts(artifact),
    socialChannels: artifact.socialEpisode.channels.length,
    gameEvents: artifact.finalState.events.length,
    evaluationMetricCount: artifact.evaluationReport.metricCount,
    evaluationWarningCount: artifact.evaluationReport.warnings?.length ?? 0,
    evaluatorCount: artifact.evaluationReport.evaluatorIds.length,
    stateHash: hashStableState(artifact.finalState),
    artifactHash
  };
}

function numberRow(id: string, label: string, baseline: number, candidate: number): MatchComparisonRow {
  return {
    id,
    label,
    baseline,
    candidate,
    delta: candidate - baseline,
    changed: baseline !== candidate
  };
}

function stringRow(id: string, label: string, baseline: string, candidate: string): MatchComparisonRow {
  return {
    id,
    label,
    baseline,
    candidate,
    changed: baseline !== candidate
  };
}

function sortComparisonRows(rows: MatchComparisonRow[]): MatchComparisonRow[] {
  const groupOrder: Record<NonNullable<MatchComparisonRow["group"]>, number> = {
    summary: 0,
    metric: 1,
    metric_evidence: 2
  };
  return [...rows].sort((left, right) => {
    if (left.changed !== right.changed) return left.changed ? -1 : 1;
    const leftGroup = groupOrder[left.group ?? "summary"] ?? 9;
    const rightGroup = groupOrder[right.group ?? "summary"] ?? 9;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    return left.id.localeCompare(right.id);
  });
}

function buildMetricEvidenceRows(
  baselineMetrics: HarnessMetricRecord[],
  candidateMetrics: HarnessMetricRecord[],
  baselinePromotionPolicy: MetricPromotionPolicy,
  candidatePromotionPolicy: MetricPromotionPolicy
): {
  rows: MatchComparisonRow[];
  metricKeysCompared: number;
  metricKeysEmitted: number;
  metricKeysTruncated: number;
  scorecardMetricKeysCompared: number;
  scorecardMetricKeysEmitted: number;
  scorecardMetricKeysTruncated: number;
  diagnosticMetricKeysCompared: number;
  diagnosticMetricKeysEmitted: number;
  diagnosticMetricKeysTruncated: number;
  benchmarkOnlyMetricKeysCompared: number;
  benchmarkOnlyMetricKeysEmitted: number;
  benchmarkOnlyMetricKeysTruncated: number;
  promotionProvenanceChangedMetricCount: number;
  evidenceIdentityChangedMetricCount: number;
  evidenceIdentityOnlyBaselineRefCount: number;
  evidenceIdentityOnlyCandidateRefCount: number;
} {
  const baselineByKey = indexMetrics(baselineMetrics);
  const candidateByKey = indexMetrics(candidateMetrics);
  const keys = sortMetricKeysForEmission(
    uniqueSorted([...baselineByKey.keys(), ...candidateByKey.keys()]),
    baselineByKey,
    candidateByKey,
    baselinePromotionPolicy,
    candidatePromotionPolicy
  );
  const rows: MatchComparisonRow[] = [];
  let metricKeysEmitted = 0;
  let metricKeysTruncated = 0;
  let scorecardMetricKeysCompared = 0;
  let scorecardMetricKeysEmitted = 0;
  let scorecardMetricKeysTruncated = 0;
  let diagnosticMetricKeysCompared = 0;
  let diagnosticMetricKeysEmitted = 0;
  let diagnosticMetricKeysTruncated = 0;
  let benchmarkOnlyMetricKeysCompared = 0;
  let benchmarkOnlyMetricKeysEmitted = 0;
  let benchmarkOnlyMetricKeysTruncated = 0;
  let promotionProvenanceChangedMetricCount = 0;
  let evidenceIdentityChangedMetricCount = 0;
  let evidenceIdentityOnlyBaselineRefCount = 0;
  let evidenceIdentityOnlyCandidateRefCount = 0;

  for (const key of keys) {
    const baselineMetric = baselineByKey.get(key);
    const candidateMetric = candidateByKey.get(key);
    const baselineValue = metricComparableValue(baselineMetric);
    const candidateValue = metricComparableValue(candidateMetric);
    const baselineRefs = baselineMetric?.evidenceRefs?.length ?? 0;
    const candidateRefs = candidateMetric?.evidenceRefs?.length ?? 0;
    const baselineKinds = evidenceKinds(baselineMetric);
    const candidateKinds = evidenceKinds(candidateMetric);
    const baselineIds = evidenceIdentities(baselineMetric);
    const candidateIds = evidenceIdentities(candidateMetric);
    const onlyBaselineIds = differenceSorted(baselineIds, candidateIds);
    const onlyCandidateIds = differenceSorted(candidateIds, baselineIds);
    const baselineDecision = baselineMetric
      ? resolveRecordedMetricPromotion(baselineMetric, baselinePromotionPolicy)
      : undefined;
    const candidateDecision = candidateMetric
      ? resolveRecordedMetricPromotion(candidateMetric, candidatePromotionPolicy)
      : undefined;
    const promotion: MatchComparisonRowPromotion = {
      baseline: baselineDecision?.promotionClass ?? "missing",
      candidate: candidateDecision?.promotionClass ?? "missing",
      details: promotionDetails(baselineDecision, candidateDecision)
    };
    const baselinePromotion = promotion.baseline;
    const candidatePromotion = promotion.candidate;
    const valueChanged = baselineValue !== candidateValue;
    const identityChanged = onlyBaselineIds.length > 0 || onlyCandidateIds.length > 0;
    const evidenceChanged =
      baselineRefs !== candidateRefs ||
      baselineKinds.join("|") !== candidateKinds.join("|") ||
      identityChanged;
    const promotionChanged = promotion.details?.changed ?? baselinePromotion !== candidatePromotion;
    const promotionProvenanceChanged = Boolean(
      promotion.details?.changedFields.some((field) => field !== "class")
    );
    const eligibilityChanged = Boolean(
      promotion.details?.changedFields.includes("eligibility") && baselinePromotion === candidatePromotion
    );
    if (!valueChanged && !evidenceChanged && !promotionChanged && baselineMetric && candidateMetric) continue;

    const isScorecardKey = baselinePromotion === "scorecard" || candidatePromotion === "scorecard";
    const isDiagnosticKey = baselinePromotion === "diagnostic" || candidatePromotion === "diagnostic";
    const isBenchmarkOnlyKey = baselinePromotion === "benchmark_only" || candidatePromotion === "benchmark_only";
    if (isScorecardKey) scorecardMetricKeysCompared += 1;
    if (isDiagnosticKey) diagnosticMetricKeysCompared += 1;
    if (isBenchmarkOnlyKey) benchmarkOnlyMetricKeysCompared += 1;

    if (metricKeysEmitted >= MATCH_COMPARISON_MAX_METRIC_ROWS) {
      metricKeysTruncated += 1;
      if (isScorecardKey) scorecardMetricKeysTruncated += 1;
      if (isDiagnosticKey) diagnosticMetricKeysTruncated += 1;
      if (isBenchmarkOnlyKey) benchmarkOnlyMetricKeysTruncated += 1;
      continue;
    }

    const metricId = baselineMetric?.id ?? candidateMetric?.id ?? key;
    const subjectId = baselineMetric?.subjectId ?? candidateMetric?.subjectId;
    const labelSubject = subjectId ? ` · ${subjectId}` : "";
    const evidence = {
      baselineRefs,
      candidateRefs,
      baselineKinds,
      candidateKinds,
      baselineIds,
      candidateIds,
      onlyBaselineIds,
      onlyCandidateIds
    } as const;
    const bothNumericOrMissing =
      (baselineValue === null || typeof baselineValue === "number") &&
      (candidateValue === null || typeof candidateValue === "number") &&
      !(baselineValue === null && candidateValue === null);
    if (bothNumericOrMissing) {
      const baselineNumber = typeof baselineValue === "number" ? baselineValue : 0;
      const candidateNumber = typeof candidateValue === "number" ? candidateValue : 0;
      rows.push({
        ...numberRow(`metric:${key}`, `指标 ${metricId}${labelSubject}`, baselineNumber, candidateNumber),
        baseline: baselineValue,
        candidate: candidateValue,
        delta:
          typeof baselineValue === "number" && typeof candidateValue === "number"
            ? candidateValue - baselineValue
            : typeof candidateValue === "number"
              ? candidateValue
              : typeof baselineValue === "number"
                ? -baselineValue
                : undefined,
        changed: valueChanged || promotionChanged,
        group: "metric",
        metricId,
        subjectId,
        promotion,
        evidence
      });
    } else {
      rows.push({
        ...stringRow(
          `metric:${key}`,
          `指标 ${metricId}${labelSubject}`,
          formatMetricValue(baselineValue, baselinePromotion),
          formatMetricValue(candidateValue, candidatePromotion)
        ),
        group: "metric",
        metricId,
        subjectId,
        changed: valueChanged || promotionChanged,
        promotion,
        evidence
      });
    }

    if (promotionChanged) {
      if (promotionProvenanceChanged) promotionProvenanceChangedMetricCount += 1;
      rows.push({
        ...stringRow(
          `metric_promotion:${key}`,
          `promotion · ${metricId}${labelSubject} · ${promotion.details?.changedFields.join(",") ?? "class"}`,
          baselinePromotion,
          candidatePromotion
        ),
        changed: true,
        group: "metric",
        metricId,
        subjectId,
        promotion,
        evidence
      });
    }

    if (eligibilityChanged) {
      rows.push({
        ...stringRow(
          `metric_promotion_eligibility:${key}`,
          `scorecard eligibility · ${metricId}${labelSubject}`,
          promotion.details?.baseline?.eligibleForScorecard ? "eligible" : "ineligible",
          promotion.details?.candidate?.eligibleForScorecard ? "eligible" : "ineligible"
        ),
        changed: true,
        group: "metric",
        metricId,
        subjectId,
        promotion,
        evidence
      });
    }

    if (evidenceChanged || baselineRefs > 0 || candidateRefs > 0) {
      rows.push({
        ...numberRow(`metric_evidence:${key}`, `evidence refs · ${metricId}${labelSubject}`, baselineRefs, candidateRefs),
        group: "metric_evidence",
        metricId,
        subjectId,
        promotion,
        evidence
      });
      if (baselineKinds.join("|") !== candidateKinds.join("|")) {
        rows.push({
          ...stringRow(
            `metric_evidence_kinds:${key}`,
            `evidence kinds · ${metricId}${labelSubject}`,
            baselineKinds.join(",") || "无",
            candidateKinds.join(",") || "无"
          ),
          group: "metric_evidence",
          metricId,
          subjectId,
          promotion,
          evidence
        });
      }
      if (identityChanged) {
        evidenceIdentityChangedMetricCount += 1;
        evidenceIdentityOnlyBaselineRefCount += onlyBaselineIds.length;
        evidenceIdentityOnlyCandidateRefCount += onlyCandidateIds.length;
        rows.push({
          ...stringRow(
            `metric_evidence_ids:${key}`,
            `evidence ids · ${metricId}${labelSubject}`,
            formatEvidenceIdentityDelta(onlyBaselineIds, "baseline-only"),
            formatEvidenceIdentityDelta(onlyCandidateIds, "candidate-only")
          ),
          group: "metric_evidence",
          metricId,
          subjectId,
          promotion,
          evidence
        });
      }
    }

    metricKeysEmitted += 1;
    if (isScorecardKey) scorecardMetricKeysEmitted += 1;
    if (isDiagnosticKey) diagnosticMetricKeysEmitted += 1;
    if (isBenchmarkOnlyKey) benchmarkOnlyMetricKeysEmitted += 1;
  }

  return {
    rows,
    metricKeysCompared: keys.length,
    metricKeysEmitted,
    metricKeysTruncated,
    scorecardMetricKeysCompared,
    scorecardMetricKeysEmitted,
    scorecardMetricKeysTruncated,
    diagnosticMetricKeysCompared,
    diagnosticMetricKeysEmitted,
    diagnosticMetricKeysTruncated,
    benchmarkOnlyMetricKeysCompared,
    benchmarkOnlyMetricKeysEmitted,
    benchmarkOnlyMetricKeysTruncated,
    promotionProvenanceChangedMetricCount,
    evidenceIdentityChangedMetricCount,
    evidenceIdentityOnlyBaselineRefCount,
    evidenceIdentityOnlyCandidateRefCount
  };
}

function metricPromotionPriority(metric: HarnessMetricRecord | undefined, fallbackPolicy: MetricPromotionPolicy): number {
  if (!metric) return 3;
  const promotionClass = resolveRecordedMetricPromotion(metric, fallbackPolicy).promotionClass;
  if (promotionClass === "scorecard") return 0;
  if (promotionClass === "benchmark_only") return 1;
  if (promotionClass === "diagnostic") return 2;
  return 3;
}

function metricEmissionChangePriority(
  baselineMetric: HarnessMetricRecord | undefined,
  candidateMetric: HarnessMetricRecord | undefined,
  baselinePromotionPolicy: MetricPromotionPolicy,
  candidatePromotionPolicy: MetricPromotionPolicy
): number {
  if (!baselineMetric || !candidateMetric) return 0;
  const promotion = promotionDetails(
    resolveRecordedMetricPromotion(baselineMetric, baselinePromotionPolicy),
    resolveRecordedMetricPromotion(candidateMetric, candidatePromotionPolicy)
  );
  // Policy/catalog provenance is audit-critical even when value and final
  // class match, so it wins tie-breaks within the same promotion class.
  if (promotion.changed) return 0;
  const baselineKinds = evidenceKinds(baselineMetric);
  const candidateKinds = evidenceKinds(candidateMetric);
  const evidenceChanged =
    (baselineMetric.evidenceRefs?.length ?? 0) !== (candidateMetric.evidenceRefs?.length ?? 0) ||
    baselineKinds.join("|") !== candidateKinds.join("|") ||
    evidenceIdentities(baselineMetric).join("|") !== evidenceIdentities(candidateMetric).join("|");
  if (metricComparableValue(baselineMetric) !== metricComparableValue(candidateMetric) || evidenceChanged) return 1;
  return 2;
}

function sortMetricKeysForEmission(
  keys: string[],
  baselineByKey: Map<string, HarnessMetricRecord>,
  candidateByKey: Map<string, HarnessMetricRecord>,
  baselinePromotionPolicy: MetricPromotionPolicy,
  candidatePromotionPolicy: MetricPromotionPolicy
): string[] {
  return [...keys].sort((left, right) => {
    const leftPriority = Math.min(
      metricPromotionPriority(baselineByKey.get(left), baselinePromotionPolicy),
      metricPromotionPriority(candidateByKey.get(left), candidatePromotionPolicy)
    );
    const rightPriority = Math.min(
      metricPromotionPriority(baselineByKey.get(right), baselinePromotionPolicy),
      metricPromotionPriority(candidateByKey.get(right), candidatePromotionPolicy)
    );
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;

    const leftChangePriority = metricEmissionChangePriority(
      baselineByKey.get(left),
      candidateByKey.get(left),
      baselinePromotionPolicy,
      candidatePromotionPolicy
    );
    const rightChangePriority = metricEmissionChangePriority(
      baselineByKey.get(right),
      candidateByKey.get(right),
      baselinePromotionPolicy,
      candidatePromotionPolicy
    );
    if (leftChangePriority !== rightChangePriority) return leftChangePriority - rightChangePriority;

    return left.localeCompare(right);
  });
}

function indexMetrics(metrics: HarnessMetricRecord[]): Map<string, HarnessMetricRecord> {
  const indexed = new Map<string, HarnessMetricRecord>();
  for (const metric of metrics) {
    indexed.set(metricKey(metric), metric);
  }
  return indexed;
}

function metricKey(metric: HarnessMetricRecord): string {
  return `${metric.id}::${metric.subjectId ?? "episode"}`;
}

function metricComparableValue(metric: HarnessMetricRecord | undefined): MatchComparisonValue {
  if (!metric) return null;
  const value = metric.value;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function formatMetricValue(value: MatchComparisonValue, promotionClass: string): string {
  if (value === null) return `missing/${promotionClass}`;
  return `${String(value)}/${promotionClass}`;
}

function evidenceKinds(metric: HarnessMetricRecord | undefined): string[] {
  if (!metric?.evidenceRefs?.length) return [];
  return uniqueSorted(metric.evidenceRefs.map((ref) => ref.artifact));
}

function evidenceIdentities(metric: HarnessMetricRecord | undefined): string[] {
  if (!metric?.evidenceRefs?.length) return [];
  return uniqueSorted(metric.evidenceRefs.map((ref) => evidenceIdentity(ref)));
}

function evidenceIdentity(ref: NonNullable<HarnessMetricRecord["evidenceRefs"]>[number]): string {
  // Structural identity only. Descriptions are intentionally excluded so private
  // narrative/sentinel text cannot leak through comparison artifacts.
  const parts = [`artifact=${ref.artifact}`];
  if (ref.id !== undefined) parts.push(`id=${ref.id}`);
  if (ref.seq !== undefined) parts.push(`seq=${ref.seq}`);
  if (ref.traceId !== undefined) parts.push(`traceId=${ref.traceId}`);
  return parts.join("|");
}

function differenceSorted(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function formatEvidenceIdentityDelta(ids: string[], label: string): string {
  if (!ids.length) return "无";
  const preview = ids.slice(0, 4).join("; ");
  const suffix = ids.length > 4 ? `; +${ids.length - 4} more` : "";
  return `${label}:${ids.length} · ${preview}${suffix}`;
}

function countMetricsWithEvidence(metrics: HarnessMetricRecord[]): number {
  return metrics.filter((metric) => (metric.evidenceRefs?.length ?? 0) > 0).length;
}

function countMetricEvidenceRefs(metrics: HarnessMetricRecord[]): number {
  return metrics.reduce((sum, metric) => sum + (metric.evidenceRefs?.length ?? 0), 0);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function summarizeModelUsage(usage: MatchMetrics["modelUsage"]): { calls: number; promptTokens: number; completionTokens: number; latencyMs: number } {
  return Object.values(usage).reduce(
    (summary, item) => ({
      calls: summary.calls + item.calls,
      promptTokens: summary.promptTokens + item.promptTokens,
      completionTokens: summary.completionTokens + item.completionTokens,
      latencyMs: summary.latencyMs + item.latencyMs
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 }
  );
}

function countRelationshipEdges(artifact: MatchComparisonSource): number {
  return artifact.agents.reduce((sum, agent) => sum + Object.keys(agent.social?.relationships.edges ?? {}).length, 0);
}

function countReputationEdges(artifact: MatchComparisonSource): number {
  return artifact.agents.reduce((sum, agent) => sum + Object.keys(agent.social?.reputation.records ?? {}).length, 0);
}

function countSocialSpeechActs(artifact: MatchComparisonSource): number {
  return artifact.socialEpisode.messages.reduce((sum, message) => sum + (message.speechActs?.length ?? 0), 0);
}

function countSocialDeliveryReceipts(artifact: MatchComparisonSource): number {
  return artifact.socialEpisode.messages.reduce((sum, message) => sum + (message.deliveryReceipts?.length ?? 0), 0);
}

function countSocialExposureRecords(artifact: MatchComparisonSource): number {
  const view = sourceProjection(artifact)?.view;
  if ((view === "postgame-redacted" || view === "truth-redacted") && Array.isArray(artifact.socialEpisode.exposureRecords)) {
    return artifact.socialEpisode.exposureRecords.length;
  }
  return deriveSocialExposureRecords(artifact.socialEpisode).length;
}

function sourceProjection(artifact: MatchComparisonSource): MatchComparisonProjection | undefined {
  const projection = artifact.projection;
  return projection ? { ...projection } : undefined;
}

function comparisonArtifactId(input: {
  view: MatchComparisonView;
  baselineRunId?: string;
  baselineMatchId?: string;
  candidateRunId?: string;
  candidateMatchId?: string;
  baselineHash: string;
  candidateHash: string;
}): string {
  return `match-comparison:${hashStableState(input).slice(0, 24)}`;
}

export interface TournamentComparisonPairSource {
  episodeIndex: number;
  seed: string;
  runId: string;
  matchId?: string;
  artifact: MatchComparisonSource;
}

export interface TournamentComparisonPairSummary {
  comparisonId: string;
  baseline: {
    episodeIndex: number;
    seed: string;
    runId: string;
    matchId?: string;
  };
  candidate: {
    episodeIndex: number;
    seed: string;
    runId: string;
    matchId?: string;
  };
  changedRowCount: number;
  numericDeltaCount: number;
  scorecardMetricDelta: number;
  diagnosticMetricDelta: number;
  benchmarkOnlyMetricDelta: number;
  promotionProvenanceChangedMetricCount: number;
  evidenceIdentityChangedMetricCount: number;
  baselineSocialSteps: number;
  candidateSocialSteps: number;
  baselineCommittedSteps: number;
  candidateCommittedSteps: number;
  baselineRejectedSteps: number;
  candidateRejectedSteps: number;
  socialStepsDelta: number;
  committedStepsDelta: number;
  rejectedStepsDelta: number;
  baselineHash: string;
  candidateHash: string;
}

export interface TournamentComparisonMetricFrequency {
  metricKey: string;
  label: string;
  pairCount: number;
  changedPairCount: number;
  averageAbsoluteDelta: number | null;
}

export interface TournamentComparisonAggregate {
  artifactVersion: typeof TOURNAMENT_COMPARISON_ARTIFACT_VERSION;
  kind: "tournament-comparison";
  comparisonSetId: string;
  createdAt: string;
  view: MatchComparisonView;
  projection: MatchComparisonProjection;
  experimentId: string | null;
  tournamentSeed: string;
  gamesRequested: number;
  artifactMatchCount: number;
  pairCount: number;
  pairs: TournamentComparisonPairSummary[];
  metricChangeFrequency: TournamentComparisonMetricFrequency[];
  summary: {
    changedPairCount: number;
    totalChangedRows: number;
    averageChangedRows: number;
    totalScorecardMetricDelta: number;
    totalDiagnosticMetricDelta: number;
    totalBenchmarkOnlyMetricDelta: number;
    totalPromotionProvenanceChangedMetrics: number;
    totalEvidenceIdentityChangedMetrics: number;
    totalSocialStepsDelta: number;
    totalCommittedStepsDelta: number;
    totalRejectedStepsDelta: number;
    pairIdentityHash: string;
  };
}

/**
 * Build a tournament-level pairwise comparison aggregate from recorded match
 * artifacts. This is a pure projection over server/harness-owned match truth.
 * It does not invent winners, private evidence, or causal claims.
 */
export function buildTournamentComparisonAggregate(options: {
  sources: TournamentComparisonPairSource[];
  view: MatchComparisonView;
  tournamentSeed: string;
  gamesRequested: number;
  experimentId?: string | null;
  createdAt?: string;
  metricFrequencyLimit?: number;
}): TournamentComparisonAggregate {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const sources = [...options.sources].sort((left, right) => left.episodeIndex - right.episodeIndex);
  const pairs: TournamentComparisonPairSummary[] = [];
  const metricStats = new Map<
    string,
    {
      label: string;
      pairCount: number;
      changedPairCount: number;
      absoluteDeltaSum: number;
      absoluteDeltaCount: number;
    }
  >();

  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      const baseline = sources[i]!;
      const candidate = sources[j]!;
      const comparison = buildMatchComparisonArtifact({
        baseline: baseline.artifact,
        candidate: candidate.artifact,
        view: options.view,
        createdAt
      });
      pairs.push({
        comparisonId: comparison.comparisonId,
        baseline: {
          episodeIndex: baseline.episodeIndex,
          seed: baseline.seed,
          runId: baseline.runId,
          matchId: baseline.matchId
        },
        candidate: {
          episodeIndex: candidate.episodeIndex,
          seed: candidate.seed,
          runId: candidate.runId,
          matchId: candidate.matchId
        },
        changedRowCount: comparison.summary.changedRowCount,
        numericDeltaCount: comparison.summary.numericDeltaCount,
        scorecardMetricDelta: comparison.summary.scorecardMetricDelta,
        diagnosticMetricDelta: comparison.summary.diagnosticMetricDelta,
        benchmarkOnlyMetricDelta: comparison.summary.benchmarkOnlyMetricDelta,
        promotionProvenanceChangedMetricCount: comparison.summary.promotionProvenanceChangedMetricCount ?? 0,
        evidenceIdentityChangedMetricCount: comparison.summary.evidenceIdentityChangedMetricCount,
        baselineSocialSteps: comparison.baseline.socialSteps,
        candidateSocialSteps: comparison.candidate.socialSteps,
        baselineCommittedSteps: comparison.baseline.committedSteps,
        candidateCommittedSteps: comparison.candidate.committedSteps,
        baselineRejectedSteps: comparison.baseline.rejectedSteps,
        candidateRejectedSteps: comparison.candidate.rejectedSteps,
        socialStepsDelta: comparison.candidate.socialSteps - comparison.baseline.socialSteps,
        committedStepsDelta: comparison.candidate.committedSteps - comparison.baseline.committedSteps,
        rejectedStepsDelta: comparison.candidate.rejectedSteps - comparison.baseline.rejectedSteps,
        baselineHash: comparison.summary.baselineHash,
        candidateHash: comparison.summary.candidateHash
      });

      for (const row of comparison.rows) {
        if (row.group !== "metric" && row.group !== "metric_evidence") continue;
        const metricKey = row.metricId ?? row.id;
        const current = metricStats.get(metricKey) ?? {
          label: row.label,
          pairCount: 0,
          changedPairCount: 0,
          absoluteDeltaSum: 0,
          absoluteDeltaCount: 0
        };
        current.pairCount += 1;
        if (row.changed) current.changedPairCount += 1;
        if (typeof row.delta === "number" && Number.isFinite(row.delta)) {
          current.absoluteDeltaSum += Math.abs(row.delta);
          current.absoluteDeltaCount += 1;
        }
        metricStats.set(metricKey, current);
      }
    }
  }

  const metricFrequencyLimit = options.metricFrequencyLimit ?? 32;
  const metricChangeFrequency = [...metricStats.entries()]
    .map(([metricKey, stats]) => ({
      metricKey,
      label: stats.label,
      pairCount: stats.pairCount,
      changedPairCount: stats.changedPairCount,
      averageAbsoluteDelta:
        stats.absoluteDeltaCount > 0 ? stats.absoluteDeltaSum / stats.absoluteDeltaCount : null
    }))
    .sort((left, right) => {
      if (right.changedPairCount !== left.changedPairCount) {
        return right.changedPairCount - left.changedPairCount;
      }
      return left.metricKey.localeCompare(right.metricKey);
    })
    .slice(0, metricFrequencyLimit);

  const totalChangedRows = pairs.reduce((sum, pair) => sum + pair.changedRowCount, 0);
  const totalScorecardMetricDelta = pairs.reduce((sum, pair) => sum + pair.scorecardMetricDelta, 0);
  const totalDiagnosticMetricDelta = pairs.reduce((sum, pair) => sum + pair.diagnosticMetricDelta, 0);
  const totalBenchmarkOnlyMetricDelta = pairs.reduce((sum, pair) => sum + pair.benchmarkOnlyMetricDelta, 0);
  const totalPromotionProvenanceChangedMetrics = pairs.reduce(
    (sum, pair) => sum + pair.promotionProvenanceChangedMetricCount,
    0
  );
  const totalEvidenceIdentityChangedMetrics = pairs.reduce(
    (sum, pair) => sum + pair.evidenceIdentityChangedMetricCount,
    0
  );
  const totalSocialStepsDelta = pairs.reduce((sum, pair) => sum + pair.socialStepsDelta, 0);
  const totalCommittedStepsDelta = pairs.reduce((sum, pair) => sum + pair.committedStepsDelta, 0);
  const totalRejectedStepsDelta = pairs.reduce((sum, pair) => sum + pair.rejectedStepsDelta, 0);
  const pairIdentityHash = hashStableState(
    pairs.map((pair) => ({
      comparisonId: pair.comparisonId,
      baselineEpisodeIndex: pair.baseline.episodeIndex,
      candidateEpisodeIndex: pair.candidate.episodeIndex
    }))
  );
  const comparisonSetId = tournamentComparisonSetId({
    view: options.view,
    tournamentSeed: options.tournamentSeed,
    experimentId: options.experimentId ?? null,
    pairIdentityHash,
    artifactMatchCount: sources.length
  });

  return {
    artifactVersion: TOURNAMENT_COMPARISON_ARTIFACT_VERSION,
    kind: "tournament-comparison",
    comparisonSetId,
    createdAt,
    view: options.view,
    projection: {
      view: options.view,
      privateEvidenceRedacted: options.view === "postgame-redacted" || options.view === "truth-redacted",
      postgameTruthRedacted: options.view === "truth-redacted",
      generatedAt: createdAt
    },
    experimentId: options.experimentId ?? null,
    tournamentSeed: options.tournamentSeed,
    gamesRequested: options.gamesRequested,
    artifactMatchCount: sources.length,
    pairCount: pairs.length,
    pairs,
    metricChangeFrequency,
    summary: {
      changedPairCount: pairs.filter((pair) => pair.changedRowCount > 0).length,
      totalChangedRows,
      averageChangedRows: pairs.length > 0 ? totalChangedRows / pairs.length : 0,
      totalScorecardMetricDelta,
      totalDiagnosticMetricDelta,
      totalBenchmarkOnlyMetricDelta,
      totalPromotionProvenanceChangedMetrics,
      totalEvidenceIdentityChangedMetrics,
      totalSocialStepsDelta,
      totalCommittedStepsDelta,
      totalRejectedStepsDelta,
      pairIdentityHash
    }
  };
}

function tournamentComparisonSetId(input: {
  view: MatchComparisonView;
  tournamentSeed: string;
  experimentId: string | null;
  pairIdentityHash: string;
  artifactMatchCount: number;
}): string {
  return `tournament-comparison:${hashStableState(input).slice(0, 24)}`;
}
