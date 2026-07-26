import path from "node:path";
import type { ExperimentMatrixCellResult, NormalizedMatrixExperimentCell } from "./types";

export function gamesTruncatedForCell(cell: ExperimentMatrixCellResult): number {
  return cell.tournament?.gamesTruncated ?? cell.tournament?.episodes.filter((episode) => episode.status === "truncated").length ?? 0;
}

export function gamesUnstartedForCell(cell: ExperimentMatrixCellResult): number {
  if (!cell.tournament) return 0;
  return cell.tournament.gamesUnstarted ?? Math.max(0, cell.tournament.gamesRequested - cell.tournament.episodes.length);
}

export function sumCells(cells: ExperimentMatrixCellResult[], select: (cell: ExperimentMatrixCellResult) => number): number {
  return cells.reduce((sum, cell) => sum + select(cell), 0);
}

export function assertUniqueCellIds(cells: NormalizedMatrixExperimentCell[]): void {
  const ids = new Set<string>();
  for (const cell of cells) {
    if (ids.has(cell.id)) throw new Error(`Matrix cell id must be unique: ${cell.id}.`);
    ids.add(cell.id);
  }
}

export function removeControlFields(value: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...value };
  delete clone.label;
  delete clone.group;
  delete clone.spec;
  return clone;
}

export function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function relativeArtifactPath(rootDir: string, absolutePath: string): string {
  const relativePath = path.relative(path.resolve(rootDir), path.resolve(absolutePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Matrix artifact writer returned a file outside the artifact directory.");
  }
  return relativePath.split(path.sep).join("/");
}

export function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_") || "cell";
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
