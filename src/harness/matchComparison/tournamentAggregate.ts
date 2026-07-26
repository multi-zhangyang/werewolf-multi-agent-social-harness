import { hashStableState } from "../hash";
import { MatchComparisonView } from "../matchComparisonShared";
import { MatchComparisonProjection, MatchComparisonSource, TOURNAMENT_COMPARISON_ARTIFACT_VERSION, buildMatchComparisonArtifact } from "./artifact";
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
