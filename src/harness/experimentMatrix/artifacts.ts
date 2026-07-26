import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "../redaction";
import { writeTournamentArtifactDirectory } from "../tournamentArtifacts";
import { publishNewLocalArtifactDirectory } from "../localArtifactDirectory";
import {
  MATRIX_ARTIFACT_VERSION,
  type ExperimentMatrixArtifactWriteOptions,
  type ExperimentMatrixArtifactWriteResult,
  type ExperimentMatrixCellResult,
  type ExperimentMatrixResult,
  type MatrixSubjectStats,
  type PairwiseModelComparison
} from "./types";
import { gamesTruncatedForCell, gamesUnstartedForCell, relativeArtifactPath, safeId } from "./internals";

export async function writeExperimentMatrixArtifactDirectory(
  result: ExperimentMatrixResult,
  options: ExperimentMatrixArtifactWriteOptions
): Promise<ExperimentMatrixArtifactWriteResult> {
  const outputDir = path.resolve(options.outputDir);
  const overwrite = options.overwrite ?? false;
  const createdAt = options.createdAt ?? result.createdAt;
  if (overwrite) {
    // Legacy mutable export retained for CLI compatibility. Server-owned
    // artifact publication always uses the immutable path below.
    return writeExperimentMatrixTree(result, outputDir, createdAt, true);
  }
  const tournamentFiles = await publishNewLocalArtifactDirectory({
    finalDirectory: outputDir,
    populate: (stagingDirectory) => writeExperimentMatrixTree(result, stagingDirectory, createdAt, false)
      .then((written) => written.files.tournaments)
  });
  return matrixArtifactWriteResult(outputDir, tournamentFiles);
}

export async function writeExperimentMatrixTree(
  result: ExperimentMatrixResult,
  outputDir: string,
  createdAt: string,
  overwrite: boolean
): Promise<ExperimentMatrixArtifactWriteResult> {
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

  const files = matrixArtifactWriteResult(outputDir, tournamentFiles).files;
  const manifest = {
    artifactVersion: MATRIX_ARTIFACT_VERSION,
    kind: "experiment-matrix",
    createdAt,
    matrixId: result.experiment.id,
    status: result.status,
    cellsRequested: result.cellsRequested,
    cellsUnstarted: result.cellsUnstarted,
    cellsCompleted: result.cellsCompleted,
    cellsTruncated: result.cellsTruncated,
    cellsFailed: result.cellsFailed,
    gamesRequested: result.gamesRequested,
    gamesCompleted: result.gamesCompleted,
    gamesTruncated: result.gamesTruncated,
    gamesFailed: result.gamesFailed,
    gamesUnstarted: result.gamesUnstarted,
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
  // The manifest is written last. It is not the atomicity mechanism—the
  // sibling directory rename is—but this also keeps legacy overwrite readers
  // from observing a new manifest before its registered files exist.
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
  await writeJson(files.manifest, manifest, overwrite);
  return { outputDir, files };
}

export function matrixArtifactWriteResult(
  outputDir: string,
  tournamentFiles: ExperimentMatrixArtifactWriteResult["files"]["tournaments"]
): ExperimentMatrixArtifactWriteResult {
  const tournamentsDir = path.join(outputDir, "tournaments");
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
  return { outputDir, files };
}

export function matrixCellRecord(cell: ExperimentMatrixCellResult): object {
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
    gamesUnstarted: cell.tournament ? gamesUnstartedForCell(cell) : null,
    jointPhaseScheduler: cell.tournament?.experiment.jointPhaseScheduler ?? null,
    models: cell.tournament?.models ?? [],
    error: cell.error ?? null
  };
}


export function matrixSummaryMarkdown(result: ExperimentMatrixResult): string {
  return `${[
    `# Experiment Matrix Summary: ${markdownText(result.experiment.id)}`,
    "",
    "## Run Set",
    "",
    `- Status: ${result.status}`,
    `- Cells requested: ${result.cellsRequested}`,
    `- Cells unstarted: ${result.cellsUnstarted}`,
    `- Cells completed: ${result.cellsCompleted}`,
    `- Cells truncated: ${result.cellsTruncated}`,
    `- Cells failed: ${result.cellsFailed}`,
    `- Games requested: ${result.gamesRequested}`,
    `- Games completed: ${result.gamesCompleted}`,
    `- Games truncated: ${result.gamesTruncated}`,
    `- Games failed: ${result.gamesFailed}`,
    `- Games unstarted: ${result.gamesUnstarted}`,
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

export function subjectStatsCsvRow(stats: MatrixSubjectStats): Record<string, CsvCell> {
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

export function pairwiseCsvRow(comparison: PairwiseModelComparison): Record<string, CsvCell> {
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

export function buildCsv(headers: string[], rows: Array<Record<string, CsvCell>>): string {
  return `${[headers, ...rows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function csvCell(value: CsvCell): string {
  if (value === undefined || value === null) return "";
  const redacted = redactSecrets(String(value));
  const text = typeof redacted === "string" ? redacted : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function writeJson(filePath: string, value: unknown, overwrite: boolean): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(redactSecrets(value), null, 2)}\n`, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

export async function writeJsonl(filePath: string, records: unknown[], overwrite: boolean): Promise<void> {
  const data = records.length ? `${records.map((record) => JSON.stringify(redactSecrets(record))).join("\n")}\n` : "";
  await writeFile(filePath, data, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

export async function writeText(filePath: string, value: string, overwrite: boolean): Promise<void> {
  const redacted = redactSecrets(value);
  await writeFile(filePath, typeof redacted === "string" ? redacted : value, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

export function markdownTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return "_No records._";
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`)
  ].join("\n");
}

export function markdownCell(value: string): string {
  return markdownText(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function markdownText(value: string): string {
  const redacted = redactSecrets(value);
  return typeof redacted === "string" ? redacted : value;
}
