import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  mergeExperimentOverrides,
  normalizeTournamentExperimentSpec,
  type NormalizedTournamentExperiment,
  type TournamentExperimentSpecV1
} from "./experiment";
import { runGenericExperimentMatrix } from "./experimentMatrixRunner";
import { hashStableState } from "./hash";
import type { HarnessAssignmentConfig } from "./profiles";
import { redactSecrets } from "./redaction";
import { runTournament, type TournamentResult } from "./tournament";
import { writeTournamentArtifactDirectory } from "./tournamentArtifacts";
import type { HarnessAgentProfile, HarnessReasoner } from "./types";

export const MATRIX_EXPERIMENT_VERSION = "harness.experiment-matrix.v1";
export const MATRIX_ARTIFACT_VERSION = "harness.experiment-matrix-artifact.v1";

export interface MatrixExperimentCellSpecV1 extends Partial<TournamentExperimentSpecV1> {
  id?: string;
  label?: string;
  group?: string;
  spec?: TournamentExperimentSpecV1;
}

export interface MatrixExperimentDimensionsV1 {
  models?: Array<string | string[]>;
  profiles?: Array<string | HarnessAgentProfile[]>;
  assignments?: Array<string | HarnessAssignmentConfig>;
  seeds?: string[];
  games?: Array<string | number>;
  maxTransitions?: Array<string | number>;
  temperatures?: Array<string | number>;
}

export interface MatrixExperimentSpecV1 {
  version?: typeof MATRIX_EXPERIMENT_VERSION;
  id?: string;
  kind?: "matrix";
  base?: TournamentExperimentSpecV1;
  cells?: MatrixExperimentCellSpecV1[];
  dimensions?: MatrixExperimentDimensionsV1;
  continueOnError?: boolean;
}

export interface NormalizedMatrixExperimentCell {
  id: string;
  label: string;
  group: string;
  tournament: NormalizedTournamentExperiment;
}

export interface NormalizedMatrixExperiment {
  version: typeof MATRIX_EXPERIMENT_VERSION;
  id: string;
  kind: "matrix";
  continueOnError: boolean;
  cells: NormalizedMatrixExperimentCell[];
}

export interface ExperimentMatrixRunOptions {
  experiment: NormalizedMatrixExperiment;
  reasoner: HarnessReasoner;
  includeArtifacts?: boolean;
}

export interface ExperimentMatrixCellResult {
  index: number;
  id: string;
  label: string;
  group: string;
  /** Aggregate lifecycle of the cell's tournament episodes. */
  status: "completed" | "truncated" | "failed";
  elapsedMs: number;
  tournament?: TournamentResult;
  error?: string;
}

export interface ExperimentMatrixResult {
  artifactVersion: typeof MATRIX_ARTIFACT_VERSION;
  kind: "experiment-matrix-result";
  experiment: NormalizedMatrixExperiment;
  createdAt: string;
  completedAt: string;
  status: "completed" | "partial" | "failed";
  cellsRequested: number;
  cellsCompleted: number;
  cellsTruncated: number;
  cellsFailed: number;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  cells: ExperimentMatrixCellResult[];
  statistics: ExperimentMatrixStatistics;
}

export interface ExperimentMatrixStatistics {
  artifactVersion: typeof MATRIX_ARTIFACT_VERSION;
  kind: "experiment-matrix-statistics";
  matrixId: string;
  experimentHash: string;
  denominatorPolicy: {
    seatLevelRows: string;
    completedEpisodeRows: string;
    truncatedEpisodes: string;
    failedEpisodes: string;
    significance: string;
    superiorityClaims: false;
  };
  status: {
    cellsRequested: number;
    cellsCompleted: number;
    cellsTruncated: number;
    cellsFailed: number;
    gamesRequested: number;
    gamesCompleted: number;
    gamesTruncated: number;
    gamesFailed: number;
    completedSeatRows: number;
  };
  modelStats: MatrixSubjectStats[];
  profileStats: MatrixSubjectStats[];
  pairwiseModelComparisons: PairwiseModelComparison[];
}

export interface MatrixSubjectStats {
  subjectType: "model" | "profile";
  subjectId: string;
  model?: string;
  profileId?: string;
  policyName?: string;
  seatGames: number;
  wins: number;
  losses: number;
  winRate: number;
  winRateWilson95: [number, number] | null;
  rewardCount: number;
  rewardMean: number;
  rewardStdDev: number | null;
  rewardStdError: number | null;
}

export interface PairwiseModelComparison {
  leftModel: string;
  rightModel: string;
  leftSeatGames: number;
  rightSeatGames: number;
  leftWinRate: number;
  rightWinRate: number;
  winRateDiff: number;
  z: number | null;
  pValueTwoSided: number | null;
  pValueHolm: number | null;
  diffNormalApprox95: [number, number] | null;
  method: "two_proportion_z_test_unpaired_seat_level";
  warning: string;
}

interface SeatOutcomeRow {
  cellId: string;
  episodeIndex: number;
  model: string;
  profileId?: string;
  policyName?: string;
  won?: boolean;
  reward?: number;
}

export interface ExperimentMatrixArtifactWriteOptions {
  outputDir: string;
  createdAt?: string;
  overwrite?: boolean;
}

export interface ExperimentMatrixArtifactWriteResult {
  outputDir: string;
  files: {
    manifest: string;
    specNormalized: string;
    cells: string;
    statistics: string;
    summaryMarkdown: string;
    modelStatsCsv: string;
    profileStatsCsv: string;
    pairwiseModelComparisonsCsv: string;
    tournamentsDir: string;
    tournaments: Array<{
      cellId: string;
      manifest: string;
    }>;
  };
}

export function normalizeMatrixExperimentSpec(
  input: unknown,
  defaults: Partial<TournamentExperimentSpecV1> = {}
): NormalizedMatrixExperiment {
  const spec = input === undefined || input === null ? {} : input;
  if (!isRecord(spec)) throw new Error("Matrix experiment spec must be an object.");
  const version = stringField(spec, "version") ?? MATRIX_EXPERIMENT_VERSION;
  if (version !== MATRIX_EXPERIMENT_VERSION) throw new Error(`Matrix experiment version must be ${MATRIX_EXPERIMENT_VERSION}.`);
  const kind = stringField(spec, "kind") ?? "matrix";
  if (kind !== "matrix") throw new Error("Matrix experiment kind must be matrix.");
  const id = stringField(spec, "id") ?? "matrix";
  const base = isRecord(spec.base) ? (cloneJson(spec.base) as TournamentExperimentSpecV1) : {};
  const continueOnError = typeof spec.continueOnError === "boolean" ? spec.continueOnError : true;
  const cellInputs = matrixCellInputs(spec, base);
  const cells = cellInputs.map((cell, index) => {
    const tournament = normalizeTournamentExperimentSpec(mergeExperimentOverrides(base, cell.spec), defaults);
    const cellId = safeId(cell.id ?? `${id}-cell-${index + 1}`);
    return {
      id: cellId,
      label: cell.label ?? cellId,
      group: cell.group ?? "default",
      tournament: {
        ...tournament,
        id: tournament.id === "tournament" ? cellId : tournament.id
      }
    };
  });
  if (!cells.length) throw new Error("Matrix experiment requires at least one cell.");
  assertUniqueCellIds(cells);
  return {
    version: MATRIX_EXPERIMENT_VERSION,
    id,
    kind: "matrix",
    continueOnError,
    cells
  };
}

export function mergeMatrixExperimentOverrides(
  input: unknown,
  overrides: Partial<TournamentExperimentSpecV1>
): MatrixExperimentSpecV1 {
  const cleanOverrides = removeUndefined(overrides as Record<string, unknown>) as Partial<TournamentExperimentSpecV1>;
  const hasOverrides = Object.keys(cleanOverrides).length > 0;
  const spec = input === undefined || input === null ? {} : input;
  if (!isRecord(spec)) throw new Error("Matrix experiment spec must be an object.");
  const clone = cloneJson(spec) as MatrixExperimentSpecV1;
  if (!hasOverrides) return clone;
  const base = isRecord(clone.base) ? clone.base : {};
  return {
    ...clone,
    base: mergeExperimentOverrides(base, cleanOverrides)
  };
}

export async function runExperimentMatrix(options: ExperimentMatrixRunOptions): Promise<ExperimentMatrixResult> {
  const elapsedMsByExecutionId = new Map<string, number>();
  const generic = await runGenericExperimentMatrix({
    experiment: {
      id: options.experiment.id,
      continueOnError: options.experiment.continueOnError,
      cells: options.experiment.cells.map((cell) => ({
        id: cell.id,
        label: cell.label,
        group: cell.group,
        input: cell.tournament
      }))
    },
    runCell: async (tournament, context) => {
      const started = performance.now();
      try {
        return await runTournament({
          models: tournament.models,
          profiles: tournament.profiles,
          assignment: tournament.assignment,
          games: tournament.games,
          seed: tournament.seed,
          maxTransitions: tournament.maxTransitions,
          config: tournament.config,
          temperature: tournament.temperature,
          continueOnError: tournament.continueOnError,
          experiment: tournament,
          includeArtifacts: options.includeArtifacts,
          reasoner: options.reasoner
        });
      } finally {
        elapsedMsByExecutionId.set(context.executionId, Math.round(performance.now() - started));
      }
    },
    statusOf: (tournament) => {
      const gamesTruncated = tournament.gamesTruncated ?? tournament.episodes.filter((episode) => episode.status === "truncated").length;
      return tournament.gamesFailed ? "failed" : gamesTruncated > 0 ? "truncated" : "completed";
    },
  });
  const cells: ExperimentMatrixCellResult[] = generic.cells.map((cell) => ({
    index: cell.index,
    id: cell.id,
    label: cell.label,
    group: cell.group,
    status: cell.status,
    elapsedMs: elapsedMsByExecutionId.get(cell.executionId) ?? 0,
    tournament: cell.result,
    error: cell.error
  }));
  const statistics = buildExperimentMatrixStatistics(options.experiment, cells);
  return {
    artifactVersion: MATRIX_ARTIFACT_VERSION,
    kind: "experiment-matrix-result",
    experiment: options.experiment,
    createdAt: generic.createdAt,
    completedAt: generic.completedAt,
    status: generic.status,
    cellsRequested: generic.cellsRequested,
    cellsCompleted: generic.cellsCompleted,
    cellsTruncated: generic.cellsTruncated,
    cellsFailed: generic.cellsFailed,
    gamesRequested: sumCells(cells, (cell) => cell.tournament?.gamesRequested ?? 0),
    gamesCompleted: sumCells(cells, (cell) => cell.tournament?.gamesCompleted ?? 0),
    gamesTruncated: sumCells(cells, gamesTruncatedForCell),
    gamesFailed: sumCells(cells, (cell) => cell.tournament?.gamesFailed ?? 0),
    cells,
    statistics
  };
}

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
      cellsCompleted: cells.filter((cell) => cell.status === "completed").length,
      cellsTruncated: cells.filter((cell) => cell.status === "truncated").length,
      cellsFailed: cells.filter((cell) => cell.status === "failed").length,
      gamesRequested: sumCells(cells, (cell) => cell.tournament?.gamesRequested ?? 0),
      gamesCompleted: sumCells(cells, (cell) => cell.tournament?.gamesCompleted ?? 0),
      gamesTruncated: sumCells(cells, gamesTruncatedForCell),
      gamesFailed: sumCells(cells, (cell) => cell.tournament?.gamesFailed ?? 0),
      completedSeatRows: rows.length
    },
    modelStats,
    profileStats,
    pairwiseModelComparisons
  };
}

export async function writeExperimentMatrixArtifactDirectory(
  result: ExperimentMatrixResult,
  options: ExperimentMatrixArtifactWriteOptions
): Promise<ExperimentMatrixArtifactWriteResult> {
  const outputDir = path.resolve(options.outputDir);
  const overwrite = options.overwrite ?? false;
  const createdAt = options.createdAt ?? result.createdAt;
  await mkdir(outputDir, { recursive: true });
  const tournamentsDir = path.join(outputDir, "tournaments");
  await mkdir(tournamentsDir, { recursive: true });
  const tournamentFiles: ExperimentMatrixArtifactWriteResult["files"]["tournaments"] = [];

  for (const cell of result.cells) {
    if (!cell.tournament) continue;
    const cellDir = path.join(tournamentsDir, safeId(cell.id));
    const written = await writeTournamentArtifactDirectory(cell.tournament, {
      outputDir: cellDir,
      experimentId: cell.tournament.experiment.id,
      createdAt,
      overwrite
    });
    tournamentFiles.push({
      cellId: cell.id,
      manifest: relativeArtifactPath(outputDir, written.files.manifest)
    });
  }

  const files = {
    manifest: path.join(outputDir, "manifest.json"),
    specNormalized: path.join(outputDir, "spec.normalized.json"),
    cells: path.join(outputDir, "cells.jsonl"),
    statistics: path.join(outputDir, "statistics.json"),
    summaryMarkdown: path.join(outputDir, "summary.md"),
    modelStatsCsv: path.join(outputDir, "model_stats.csv"),
    profileStatsCsv: path.join(outputDir, "profile_stats.csv"),
    pairwiseModelComparisonsCsv: path.join(outputDir, "pairwise_model_comparisons.csv"),
    tournamentsDir,
    tournaments: tournamentFiles
  };
  const manifest = {
    artifactVersion: MATRIX_ARTIFACT_VERSION,
    kind: "experiment-matrix",
    createdAt,
    matrixId: result.experiment.id,
    status: result.status,
    cellsRequested: result.cellsRequested,
    cellsCompleted: result.cellsCompleted,
    cellsTruncated: result.cellsTruncated,
    cellsFailed: result.cellsFailed,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesTruncated: result.gamesTruncated,
    gamesFailed: result.gamesFailed,
    experimentHash: result.statistics.experimentHash,
    files: {
      manifest: "manifest.json",
      specNormalized: "spec.normalized.json",
      cells: "cells.jsonl",
      statistics: "statistics.json",
      summaryMarkdown: "summary.md",
      modelStatsCsv: "model_stats.csv",
      profileStatsCsv: "profile_stats.csv",
      pairwiseModelComparisonsCsv: "pairwise_model_comparisons.csv",
      tournaments: tournamentFiles
    }
  };
  await writeJson(files.manifest, manifest, overwrite);
  await writeJson(files.specNormalized, result.experiment, overwrite);
  await writeJsonl(files.cells, result.cells.map(matrixCellRecord), overwrite);
  await writeJson(files.statistics, result.statistics, overwrite);
  await writeText(files.summaryMarkdown, matrixSummaryMarkdown(result), overwrite);
  await writeText(files.modelStatsCsv, buildCsv(MODEL_STATS_HEADERS, result.statistics.modelStats.map(subjectStatsCsvRow)), overwrite);
  await writeText(files.profileStatsCsv, buildCsv(PROFILE_STATS_HEADERS, result.statistics.profileStats.map(subjectStatsCsvRow)), overwrite);
  await writeText(
    files.pairwiseModelComparisonsCsv,
    buildCsv(PAIRWISE_HEADERS, result.statistics.pairwiseModelComparisons.map(pairwiseCsvRow)),
    overwrite
  );
  return { outputDir, files };
}

function matrixCellInputs(
  spec: Record<string, unknown>,
  base: TournamentExperimentSpecV1
): Array<{ id?: string; label?: string; group?: string; spec: TournamentExperimentSpecV1 }> {
  if (Array.isArray(spec.cells)) {
    return spec.cells.map((cell, index) => {
      if (!isRecord(cell)) throw new Error("Matrix cells must be objects.");
      const nested = isRecord(cell.spec) ? (cell.spec as TournamentExperimentSpecV1) : {};
      const inline = removeControlFields(cell) as TournamentExperimentSpecV1;
      return {
        id: stringField(cell, "id") ?? undefined,
        label: stringField(cell, "label") ?? undefined,
        group: stringField(cell, "group") ?? undefined,
        spec: {
          ...inline,
          ...nested,
          id: stringField(cell, "id") ?? stringField(nested as Record<string, unknown>, "id") ?? `${stringField(spec, "id") ?? "matrix"}-cell-${index + 1}`
        }
      };
    });
  }
  if (isRecord(spec.dimensions)) {
    return dimensionCells(spec.dimensions, base, stringField(spec, "id") ?? "matrix");
  }
  return [{ id: base.id, label: base.id, group: "default", spec: base }];
}

function dimensionCells(
  dimensions: Record<string, unknown>,
  base: TournamentExperimentSpecV1,
  matrixId: string
): Array<{ id?: string; label?: string; group?: string; spec: TournamentExperimentSpecV1 }> {
  const models = dimensionArray(dimensions.models, undefined);
  const profiles = dimensionArray(dimensions.profiles, undefined);
  const assignments = dimensionArray(dimensions.assignments, undefined);
  const seeds = dimensionArray(dimensions.seeds, base.seed ?? matrixId);
  const games = dimensionArray(dimensions.games, base.games);
  const maxTransitions = dimensionArray(dimensions.maxTransitions, base.maxTransitions);
  const temperatures = dimensionArray(dimensions.temperatures, base.temperature);
  const cells: Array<{ id?: string; label?: string; group?: string; spec: TournamentExperimentSpecV1 }> = [];
  for (const model of models) {
    for (const profile of profiles) {
      for (const assignment of assignments) {
        for (const seed of seeds) {
          for (const gameCount of games) {
            for (const maxTransition of maxTransitions) {
              for (const temperature of temperatures) {
                const spec: TournamentExperimentSpecV1 = {
                  ...base,
                  ...(model === undefined ? {} : { models: model as TournamentExperimentSpecV1["models"] }),
                  ...(profile === undefined ? {} : { profiles: profile as TournamentExperimentSpecV1["profiles"] }),
                  ...(assignment === undefined ? {} : { assignment: assignment as TournamentExperimentSpecV1["assignment"] }),
                  ...(seed === undefined ? {} : { seed: String(seed) }),
                  ...(gameCount === undefined ? {} : { games: gameCount as TournamentExperimentSpecV1["games"] }),
                  ...(maxTransition === undefined ? {} : { maxTransitions: maxTransition as TournamentExperimentSpecV1["maxTransitions"] }),
                  ...(temperature === undefined ? {} : { temperature: temperature as TournamentExperimentSpecV1["temperature"] })
                };
                const id = `${matrixId}-c${cells.length + 1}`;
                cells.push({ id, label: id, group: String(seed ?? "default"), spec: { ...spec, id } });
              }
            }
          }
        }
      }
    }
  }
  return cells;
}

function dimensionArray(value: unknown, fallback: unknown): unknown[] {
  if (Array.isArray(value) && value.length) return value;
  return [fallback];
}

function completedSeatRows(cells: ExperimentMatrixCellResult[]): SeatOutcomeRow[] {
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

function aggregateSubjectStats(rows: SeatOutcomeRow[], subjectType: "model" | "profile"): MatrixSubjectStats[] {
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

function pairwiseComparisons(modelStats: MatrixSubjectStats[]): PairwiseModelComparison[] {
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

function twoProportionComparison(left: MatrixSubjectStats, right: MatrixSubjectStats): PairwiseModelComparison {
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

function holmAdjustComparisons(comparisons: PairwiseModelComparison[]): PairwiseModelComparison[] {
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

function matrixCellRecord(cell: ExperimentMatrixCellResult): object {
  return {
    type: "matrix_cell",
    index: cell.index,
    id: cell.id,
    label: cell.label,
    group: cell.group,
    status: cell.status,
    elapsedMs: cell.elapsedMs,
    tournamentSeed: cell.tournament?.seed ?? null,
    gamesRequested: cell.tournament?.gamesRequested ?? null,
    gamesCompleted: cell.tournament?.gamesCompleted ?? null,
    gamesTruncated: cell.tournament ? gamesTruncatedForCell(cell) : null,
    gamesFailed: cell.tournament?.gamesFailed ?? null,
    models: cell.tournament?.models ?? [],
    error: cell.error ?? null
  };
}

function gamesTruncatedForCell(cell: ExperimentMatrixCellResult): number {
  return cell.tournament?.gamesTruncated ?? cell.tournament?.episodes.filter((episode) => episode.status === "truncated").length ?? 0;
}

function matrixSummaryMarkdown(result: ExperimentMatrixResult): string {
  return `${[
    `# Experiment Matrix Summary: ${markdownText(result.experiment.id)}`,
    "",
    "## Run Set",
    "",
    `- Status: ${result.status}`,
    `- Cells requested: ${result.cellsRequested}`,
    `- Cells completed: ${result.cellsCompleted}`,
    `- Cells truncated: ${result.cellsTruncated}`,
    `- Cells failed: ${result.cellsFailed}`,
    `- Games requested: ${result.gamesRequested}`,
    `- Games completed: ${result.gamesCompleted}`,
    `- Games truncated: ${result.gamesTruncated}`,
    `- Games failed: ${result.gamesFailed}`,
    `- Completed seat rows: ${result.statistics.status.completedSeatRows}`,
    "",
    "## Model Statistics",
    "",
    markdownTable(
      ["model", "seat_games", "wins", "win_rate", "reward_mean"],
      result.statistics.modelStats.map((stats) => [
        stats.subjectId,
        String(stats.seatGames),
        String(stats.wins),
        String(stats.winRate),
        String(stats.rewardMean)
      ])
    ),
    "",
    "## Pairwise Model Comparisons",
    "",
    markdownTable(
      ["left", "right", "diff", "p", "holm_p"],
      result.statistics.pairwiseModelComparisons.map((comparison) => [
        comparison.leftModel,
        comparison.rightModel,
        String(comparison.winRateDiff),
        String(comparison.pValueTwoSided ?? ""),
        String(comparison.pValueHolm ?? "")
      ])
    ),
    "",
    "## Interpretation Policy",
    "",
    result.statistics.denominatorPolicy.significance
  ].join("\n")}\n`;
}

function subjectStatsCsvRow(stats: MatrixSubjectStats): Record<string, CsvCell> {
  return {
    subject_type: stats.subjectType,
    subject_id: stats.subjectId,
    model: stats.model ?? "",
    profile_id: stats.profileId ?? "",
    policy_name: stats.policyName ?? "",
    seat_games: stats.seatGames,
    wins: stats.wins,
    losses: stats.losses,
    win_rate: stats.winRate,
    win_rate_wilson_95_low: stats.winRateWilson95?.[0] ?? "",
    win_rate_wilson_95_high: stats.winRateWilson95?.[1] ?? "",
    reward_count: stats.rewardCount,
    reward_mean: stats.rewardMean,
    reward_std_dev: stats.rewardStdDev ?? "",
    reward_std_error: stats.rewardStdError ?? ""
  };
}

function pairwiseCsvRow(comparison: PairwiseModelComparison): Record<string, CsvCell> {
  return {
    left_model: comparison.leftModel,
    right_model: comparison.rightModel,
    left_seat_games: comparison.leftSeatGames,
    right_seat_games: comparison.rightSeatGames,
    left_win_rate: comparison.leftWinRate,
    right_win_rate: comparison.rightWinRate,
    win_rate_diff: comparison.winRateDiff,
    z: comparison.z ?? "",
    p_value_two_sided: comparison.pValueTwoSided ?? "",
    p_value_holm: comparison.pValueHolm ?? "",
    diff_ci_95_low: comparison.diffNormalApprox95?.[0] ?? "",
    diff_ci_95_high: comparison.diffNormalApprox95?.[1] ?? "",
    method: comparison.method,
    warning: comparison.warning
  };
}

const MODEL_STATS_HEADERS = [
  "subject_type",
  "subject_id",
  "model",
  "profile_id",
  "policy_name",
  "seat_games",
  "wins",
  "losses",
  "win_rate",
  "win_rate_wilson_95_low",
  "win_rate_wilson_95_high",
  "reward_count",
  "reward_mean",
  "reward_std_dev",
  "reward_std_error"
];

const PROFILE_STATS_HEADERS = MODEL_STATS_HEADERS;

const PAIRWISE_HEADERS = [
  "left_model",
  "right_model",
  "left_seat_games",
  "right_seat_games",
  "left_win_rate",
  "right_win_rate",
  "win_rate_diff",
  "z",
  "p_value_two_sided",
  "p_value_holm",
  "diff_ci_95_low",
  "diff_ci_95_high",
  "method",
  "warning"
];

type CsvCell = string | number | boolean | null | undefined;

function buildCsv(headers: string[], rows: Array<Record<string, CsvCell>>): string {
  return `${[headers, ...rows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: CsvCell): string {
  if (value === undefined || value === null) return "";
  const redacted = redactSecrets(String(value));
  const text = typeof redacted === "string" ? redacted : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeJson(filePath: string, value: unknown, overwrite: boolean): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(redactSecrets(value), null, 2)}\n`, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

async function writeJsonl(filePath: string, records: unknown[], overwrite: boolean): Promise<void> {
  const data = records.length ? `${records.map((record) => JSON.stringify(redactSecrets(record))).join("\n")}\n` : "";
  await writeFile(filePath, data, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

async function writeText(filePath: string, value: string, overwrite: boolean): Promise<void> {
  const redacted = redactSecrets(value);
  await writeFile(filePath, typeof redacted === "string" ? redacted : value, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

function markdownTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return "_No records._";
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`)
  ].join("\n");
}

function markdownCell(value: string): string {
  return markdownText(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function markdownText(value: string): string {
  const redacted = redactSecrets(value);
  return typeof redacted === "string" ? redacted : value;
}

function wilsonInterval(wins: number, n: number): [number, number] {
  const z = 1.96;
  const phat = wins / n;
  const denominator = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denominator;
  return [round4(Math.max(0, center - margin)), round4(Math.min(1, center + margin))];
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return sign * y;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStdDev(values: number[], mean: number): number {
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? round4(numerator / denominator) : 0;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function sumCells(cells: ExperimentMatrixCellResult[], select: (cell: ExperimentMatrixCellResult) => number): number {
  return cells.reduce((sum, cell) => sum + select(cell), 0);
}

function assertUniqueCellIds(cells: NormalizedMatrixExperimentCell[]): void {
  const ids = new Set<string>();
  for (const cell of cells) {
    if (ids.has(cell.id)) throw new Error(`Matrix cell id must be unique: ${cell.id}.`);
    ids.add(cell.id);
  }
}

function removeControlFields(value: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...value };
  delete clone.label;
  delete clone.group;
  delete clone.spec;
  return clone;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function relativeArtifactPath(rootDir: string, absolutePath: string): string {
  const relativePath = path.relative(path.resolve(rootDir), path.resolve(absolutePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Matrix artifact writer returned a file outside the artifact directory.");
  }
  return relativePath.split(path.sep).join("/");
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_") || "cell";
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
