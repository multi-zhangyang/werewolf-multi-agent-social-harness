import { escapeMarkdownCell } from "./comparisonRows";
import { MatchComparisonRowFilter, MatchComparisonView, filterMatchComparisonRows } from "../matchComparisonShared";
import { MatchComparisonArtifact, MatchComparisonProjection, MatchComparisonRow, MatchComparisonSourceSummary } from "./artifact";
import { TournamentComparisonAggregate } from "./tournamentAggregate";
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
