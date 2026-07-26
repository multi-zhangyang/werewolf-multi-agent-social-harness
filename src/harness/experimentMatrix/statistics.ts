import { hashStableState } from "../hash";
import {
  MATRIX_ARTIFACT_VERSION,
  type ExperimentMatrixCellResult,
  type ExperimentMatrixStatistics,
  type MatrixSubjectStats,
  type NormalizedMatrixExperiment,
  type PairwiseModelComparison,
  type SeatOutcomeRow
} from "./types";
import { gamesTruncatedForCell, gamesUnstartedForCell, sumCells } from "./internals";

export function buildExperimentMatrixStatistics(
  experiment: NormalizedMatrixExperiment,
  cells: ExperimentMatrixCellResult[]
): ExperimentMatrixStatistics {
  const rows = completedSeatRows(cells);
  const modelStats = aggregateSubjectStats(rows, "model");
  const profileStats = aggregateSubjectStats(rows, "profile");
  const pairwiseModelComparisons = holmAdjustComparisons(pairwiseComparisons(modelStats));
  return {
    artifactVersion: MATRIX_ARTIFACT_VERSION,
    kind: "experiment-matrix-statistics",
    matrixId: experiment.id,
    experimentHash: hashStableState(experiment),
    denominatorPolicy: {
      seatLevelRows: "Each completed player seat with an observed outcome contributes one Bernoulli win/loss row for model/profile win-rate estimates.",
      completedEpisodeRows: "Only terminally completed tournament episodes contribute seat-level outcome rows.",
      truncatedEpisodes:
        "Truncated cells and episodes remain in matrix status denominators and are excluded from outcome and scorecard denominators.",
      failedEpisodes: "Failed cells and episodes remain in matrix status denominators and are excluded from outcome and scorecard denominators.",
      significance:
        "Pairwise model comparisons use an unpaired seat-level two-proportion z-test with Holm correction. This is a descriptive screening statistic, not a causal or paired-seed superiority claim.",
      superiorityClaims: false
    },
    status: {
      cellsRequested: experiment.cells.length,
      cellsUnstarted: Math.max(0, experiment.cells.length - cells.length),
      cellsCompleted: cells.filter((cell) => cell.status === "completed").length,
      cellsTruncated: cells.filter((cell) => cell.status === "truncated").length,
      cellsFailed: cells.filter((cell) => cell.status === "failed").length,
      gamesRequested: sumCells(cells, (cell) => cell.tournament?.gamesRequested ?? 0),
      gamesCompleted: sumCells(cells, (cell) => cell.tournament?.gamesCompleted ?? 0),
      gamesTruncated: sumCells(cells, gamesTruncatedForCell),
      gamesFailed: sumCells(cells, (cell) => cell.tournament?.gamesFailed ?? 0),
      gamesUnstarted: sumCells(cells, gamesUnstartedForCell),
      completedSeatRows: rows.length
    },
    modelStats,
    profileStats,
    pairwiseModelComparisons
  };
}

export function completedSeatRows(cells: ExperimentMatrixCellResult[]): SeatOutcomeRow[] {
  return cells.flatMap((cell) =>
    (cell.tournament?.episodes ?? []).flatMap((episode) => {
      if (episode.status !== "completed") return [];
      return episode.agents.map((agent) => ({
        cellId: cell.id,
        episodeIndex: episode.index,
        model: agent.model,
        profileId: agent.profileId,
        policyName: agent.policyName,
        won: agent.won,
        reward: agent.reward
      }));
    })
  );
}

export function aggregateSubjectStats(rows: SeatOutcomeRow[], subjectType: "model" | "profile"): MatrixSubjectStats[] {
  const groups = new Map<string, SeatOutcomeRow[]>();
  for (const row of rows) {
    const key = subjectType === "model" ? row.model : row.profileId;
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([subjectId, subjectRows]) => {
      const outcomeRows = subjectRows.filter((row) => typeof row.won === "boolean");
      const rewardRows = subjectRows.filter((row) => typeof row.reward === "number" && Number.isFinite(row.reward));
      const wins = outcomeRows.filter((row) => row.won).length;
      const rewards = rewardRows.map((row) => row.reward as number);
      const rewardMean = rewards.length ? average(rewards) : 0;
      const rewardStdDev = rewards.length > 1 ? sampleStdDev(rewards, rewardMean) : null;
      return {
        subjectType,
        subjectId,
        model: subjectType === "model" ? subjectId : subjectRows.find((row) => row.model)?.model,
        profileId: subjectType === "profile" ? subjectId : undefined,
        policyName: subjectType === "profile" ? subjectRows.find((row) => row.policyName)?.policyName : undefined,
        seatGames: outcomeRows.length,
        wins,
        losses: outcomeRows.length - wins,
        winRate: ratio(wins, outcomeRows.length),
        winRateWilson95: outcomeRows.length ? wilsonInterval(wins, outcomeRows.length) : null,
        rewardCount: rewards.length,
        rewardMean: round4(rewardMean),
        rewardStdDev: rewardStdDev === null ? null : round4(rewardStdDev),
        rewardStdError: rewardStdDev === null ? null : round4(rewardStdDev / Math.sqrt(rewards.length))
      };
    });
}

export function pairwiseComparisons(modelStats: MatrixSubjectStats[]): PairwiseModelComparison[] {
  const comparisons: PairwiseModelComparison[] = [];
  for (let leftIndex = 0; leftIndex < modelStats.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < modelStats.length; rightIndex += 1) {
      const left = modelStats[leftIndex];
      const right = modelStats[rightIndex];
      const comparison = twoProportionComparison(left, right);
      comparisons.push(comparison);
    }
  }
  return comparisons;
}

export function twoProportionComparison(left: MatrixSubjectStats, right: MatrixSubjectStats): PairwiseModelComparison {
  const p1 = left.winRate;
  const p2 = right.winRate;
  const diff = p1 - p2;
  const pooled = ratio(left.wins + right.wins, left.seatGames + right.seatGames);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / Math.max(1, left.seatGames) + 1 / Math.max(1, right.seatGames)));
  const independentSe = Math.sqrt((p1 * (1 - p1)) / Math.max(1, left.seatGames) + (p2 * (1 - p2)) / Math.max(1, right.seatGames));
  const z = left.seatGames > 0 && right.seatGames > 0 && se > 0 ? diff / se : null;
  const pValue = z === null ? null : round6(2 * (1 - normalCdf(Math.abs(z))));
  return {
    leftModel: left.subjectId,
    rightModel: right.subjectId,
    leftSeatGames: left.seatGames,
    rightSeatGames: right.seatGames,
    leftWinRate: left.winRate,
    rightWinRate: right.winRate,
    winRateDiff: round4(diff),
    z: z === null ? null : round4(z),
    pValueTwoSided: pValue,
    pValueHolm: null,
    diffNormalApprox95:
      left.seatGames > 0 && right.seatGames > 0 ? [round4(diff - 1.96 * independentSe), round4(diff + 1.96 * independentSe)] : null,
    method: "two_proportion_z_test_unpaired_seat_level",
    warning:
      "Seat-level rows inside the same game are not independent. Treat this as a descriptive screening statistic until a paired-seed or hierarchical analysis contract is added."
  };
}

export function holmAdjustComparisons(comparisons: PairwiseModelComparison[]): PairwiseModelComparison[] {
  const withP = comparisons
    .map((comparison, index) => ({ comparison, index }))
    .filter((entry) => entry.comparison.pValueTwoSided !== null)
    .sort((left, right) => (left.comparison.pValueTwoSided ?? 1) - (right.comparison.pValueTwoSided ?? 1));
  let previous = 0;
  for (let rank = 0; rank < withP.length; rank += 1) {
    const adjusted = Math.min(1, (withP.length - rank) * (withP[rank].comparison.pValueTwoSided ?? 1));
    previous = Math.max(previous, adjusted);
    withP[rank].comparison.pValueHolm = round6(previous);
  }
  return comparisons;
}

export function wilsonInterval(wins: number, n: number): [number, number] {
  const z = 1.96;
  const phat = wins / n;
  const denominator = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denominator;
  return [round4(Math.max(0, center - margin)), round4(Math.min(1, center + margin))];
}

export function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

export function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return sign * y;
}

export function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sampleStdDev(values: number[], mean: number): number {
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

export function ratio(numerator: number, denominator: number): number {
  return denominator ? round4(numerator / denominator) : 0;
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

