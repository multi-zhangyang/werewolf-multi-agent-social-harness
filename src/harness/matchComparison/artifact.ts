import { buildComparisonRows, countPromotionClass, promotionPolicyForReport, promotionSummaryForReport, summarizeSource } from "./comparisonRows";
import { comparisonArtifactId, sourceProjection } from "./metricEvidence";
import { buildTruthRedactedMatchComparisonArtifact } from "./truthRedacted";
import { MatchArtifact } from "../artifacts";
import { hashStableState } from "../hash";
import { MatchComparisonRowGroup, MatchComparisonRowPromotion, MatchComparisonValue, MatchComparisonView } from "../matchComparisonShared";
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
