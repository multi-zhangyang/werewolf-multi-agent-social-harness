import type { TournamentEpisodeLifecycle } from "./tournamentRunner";

/**
 * Domain-neutral experiment-matrix control plane.  It schedules independent
 * experiment cells in stable order and preserves lifecycle evidence; domains
 * own cell normalization, execution, artifacts, metrics, and conclusions.
 */
export const GENERIC_EXPERIMENT_MATRIX_VERSION = "harness.generic-experiment-matrix.v1";

export interface GenericExperimentMatrixCell<TInput> {
  id: string;
  label?: string;
  group?: string;
  input: TInput;
}

export interface GenericExperimentMatrixSpec<TInput> {
  version?: typeof GENERIC_EXPERIMENT_MATRIX_VERSION;
  id: string;
  continueOnError?: boolean;
  cells: Array<GenericExperimentMatrixCell<TInput>>;
}

export interface GenericExperimentMatrixCellResult<TResult> {
  index: number;
  id: string;
  label: string;
  group: string;
  /** Stable control-plane identity; does not encode seed, model, or domain state. */
  executionId: string;
  status: TournamentEpisodeLifecycle;
  result?: TResult;
  error?: string;
}

export interface GenericExperimentMatrixResult<TResult> {
  artifactVersion: typeof GENERIC_EXPERIMENT_MATRIX_VERSION;
  kind: "experiment-matrix";
  matrixId: string;
  createdAt: string;
  completedAt: string;
  status: "completed" | "partial" | "failed";
  cellsRequested: number;
  cellsAttempted: number;
  cellsUnstarted: number;
  cellsCompleted: number;
  cellsTruncated: number;
  cellsFailed: number;
  cells: Array<GenericExperimentMatrixCellResult<TResult>>;
}

export interface RunGenericExperimentMatrixOptions<TInput, TResult> {
  experiment: GenericExperimentMatrixSpec<TInput>;
  runCell: (
    input: TInput,
    context: { matrixId: string; index: number; id: string; label: string; group: string; executionId: string }
  ) => TResult | Promise<TResult>;
  statusOf: (result: TResult) => TournamentEpisodeLifecycle;
  describeError?: (error: unknown) => string;
  createdAt?: string;
}

/**
 * Execute cells in deterministic order. A truncated cell is a valid bounded
 * result and does not stop the matrix. Failed cells obey continueOnError.
 * The runner makes no winner, score, role, model, or significance claim.
 */
export async function runGenericExperimentMatrix<TInput, TResult>(
  options: RunGenericExperimentMatrixOptions<TInput, TResult>
): Promise<GenericExperimentMatrixResult<TResult>> {
  validateGenericExperimentMatrixSpec(options.experiment);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const describeError = options.describeError ?? defaultErrorText;
  const cells: Array<GenericExperimentMatrixCellResult<TResult>> = [];
  for (const [index, cell] of options.experiment.cells.entries()) {
    const label = cell.label ?? cell.id;
    const group = cell.group ?? "default";
    const executionId = `${options.experiment.id}:cell:${cell.id}:${index}`;
    try {
      const result = await options.runCell(cell.input, {
        matrixId: options.experiment.id,
        index,
        id: cell.id,
        label,
        group,
        executionId
      });
      const status = options.statusOf(result);
      assertMatrixCellStatus(status);
      cells.push({ index, id: cell.id, label, group, executionId, status, result });
      if (status === "failed" && !options.experiment.continueOnError) break;
    } catch (error) {
      cells.push({
        index,
        id: cell.id,
        label,
        group,
        executionId,
        status: "failed",
        error: describeError(error)
      });
      if (!options.experiment.continueOnError) break;
    }
  }
  const cellsCompleted = cells.filter((cell) => cell.status === "completed").length;
  const cellsTruncated = cells.filter((cell) => cell.status === "truncated").length;
  const cellsFailed = cells.filter((cell) => cell.status === "failed").length;
  return {
    artifactVersion: GENERIC_EXPERIMENT_MATRIX_VERSION,
    kind: "experiment-matrix",
    matrixId: options.experiment.id,
    createdAt,
    completedAt: new Date().toISOString(),
    status: cellsFailed === 0 ? "completed" : cellsCompleted + cellsTruncated > 0 ? "partial" : "failed",
    cellsRequested: options.experiment.cells.length,
    cellsAttempted: cells.length,
    cellsUnstarted: options.experiment.cells.length - cells.length,
    cellsCompleted,
    cellsTruncated,
    cellsFailed,
    cells
  };
}

export function validateGenericExperimentMatrixSpec<TInput>(spec: GenericExperimentMatrixSpec<TInput>): void {
  if (spec.version !== undefined && spec.version !== GENERIC_EXPERIMENT_MATRIX_VERSION) {
    throw new Error(`Generic experiment matrix version must be ${GENERIC_EXPERIMENT_MATRIX_VERSION}.`);
  }
  if (!spec.id.trim()) throw new Error("Generic experiment matrix id is required.");
  if (!spec.cells.length) throw new Error("Generic experiment matrix requires at least one cell.");
  const ids = new Set<string>();
  for (const [index, cell] of spec.cells.entries()) {
    if (!cell.id.trim()) throw new Error(`Generic experiment matrix cell ${index} id is required.`);
    if (ids.has(cell.id)) throw new Error(`Generic experiment matrix has duplicate cell id ${cell.id}.`);
    ids.add(cell.id);
  }
}

function defaultErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Generic callers can cross a JSON/plugin boundary before reaching the matrix
 * runner. Keep the persisted lifecycle vocabulary closed even when TypeScript
 * types are no longer available at that boundary.
 */
function assertMatrixCellStatus(status: TournamentEpisodeLifecycle): void {
  if (status === "completed" || status === "truncated" || status === "failed") return;
  throw new Error(`Generic experiment matrix cell status must be completed, truncated, or failed; received ${String(status)}.`);
}
