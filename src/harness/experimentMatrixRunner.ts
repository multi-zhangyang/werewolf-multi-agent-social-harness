/**
 * Domain-neutral experiment-matrix control plane.  It schedules independent
 * experiment cells in stable order and preserves lifecycle evidence; domains
 * own cell normalization, execution, artifacts, metrics, and conclusions.
 */
export const GENERIC_EXPERIMENT_MATRIX_VERSION = "harness.generic-experiment-matrix.v1";

/**
 * A matrix cell may execute untrusted domain/provider code. Keep the generic
 * control-plane failure closed rather than serializing arbitrary thrown text.
 */
export const GENERIC_EXPERIMENT_MATRIX_CELL_FAILURE_MESSAGE = "Experiment matrix cell failed before a result was recorded.";

/** Closed lifecycle vocabulary for a generic, in-memory matrix cell. */
export type GenericExperimentMatrixCellLifecycle = "completed" | "truncated" | "failed";

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
  status: GenericExperimentMatrixCellLifecycle;
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
  /** A global matrix deadline prevents scheduling further cells after the
   * current domain execution has returned its own lifecycle evidence. */
  abortSignal?: AbortSignal;
  runCell: (
    input: TInput,
    context: { matrixId: string; index: number; id: string; label: string; group: string; executionId: string }
  ) => TResult | Promise<TResult>;
  statusOf: (result: TResult) => GenericExperimentMatrixCellLifecycle;
  /** Canonical, already-settled contiguous prefix used for model-free resume. */
  initialCells?: Array<GenericExperimentMatrixCellResult<TResult>>;
  /** Control-plane hooks are intentionally outside cell error capture. */
  onCellStarting?: (context: {
    matrixId: string; index: number; id: string; label: string; group: string; executionId: string;
  }) => void | Promise<void>;
  onCellSettled?: (cell: GenericExperimentMatrixCellResult<TResult>) => void | Promise<void>;
  /** In durable mode a thrown runCell/statusOf error means authority failure,
   * because the child orchestrator has already materialized domain failures. */
  captureCellErrors?: boolean;
  describeError?: (error: unknown) => string;
  createdAt?: string;
}

/**
 * Execute cells in deterministic order. A truncated cell is a valid bounded
 * result and does not stop the matrix. Failed cells obey continueOnError.
 * The runner makes no winner, score, role, model, or significance claim, and
 * its in-memory result is not a cross-domain persistence format.
 */
export async function runGenericExperimentMatrix<TInput, TResult>(
  options: RunGenericExperimentMatrixOptions<TInput, TResult>
): Promise<GenericExperimentMatrixResult<TResult>> {
  validateGenericExperimentMatrixSpec(options.experiment);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const describeError = options.describeError ?? defaultErrorText;
  const cells = validateInitialMatrixCells(options.experiment, options.initialCells ?? []);
  for (let index = cells.length; index < options.experiment.cells.length; index += 1) {
    if (options.abortSignal?.aborted) break;
    const cell = options.experiment.cells[index]!;
    const label = cell.label ?? cell.id;
    const group = cell.group ?? "default";
    const executionId = `${options.experiment.id}:cell:${cell.id}:${index}`;
    const context = { matrixId: options.experiment.id, index, id: cell.id, label, group, executionId };
    await options.onCellStarting?.(context);
    let settled: GenericExperimentMatrixCellResult<TResult>;
    if (options.captureCellErrors === false) {
      const result = await options.runCell(cell.input, {
        ...context
      });
      const status = options.statusOf(result);
      assertMatrixCellStatus(status);
      settled = { index, id: cell.id, label, group, executionId, status, result };
    } else {
      try {
        const result = await options.runCell(cell.input, context);
        const status = options.statusOf(result);
        assertMatrixCellStatus(status);
        settled = { index, id: cell.id, label, group, executionId, status, result };
      } catch (error) {
        settled = {
          index,
          id: cell.id,
          label,
          group,
          executionId,
          status: "failed",
          error: describeError(error)
        };
      }
    }
    cells.push(settled);
    await options.onCellSettled?.({ ...settled });
    if (settled.status === "failed" && !options.experiment.continueOnError) break;
  }
  const cellsCompleted = cells.filter((cell) => cell.status === "completed").length;
  const cellsTruncated = cells.filter((cell) => cell.status === "truncated").length;
  const cellsFailed = cells.filter((cell) => cell.status === "failed").length;
  const cellsUnstarted = options.experiment.cells.length - cells.length;
  const hasStartedCell = cellsCompleted + cellsTruncated + cellsFailed > 0;
  return {
    artifactVersion: GENERIC_EXPERIMENT_MATRIX_VERSION,
    kind: "experiment-matrix",
    matrixId: options.experiment.id,
    createdAt,
    completedAt: new Date().toISOString(),
    status:
      cellsUnstarted > 0
        ? hasStartedCell
          ? "partial"
          : "failed"
        : cellsFailed === 0
          ? "completed"
          : cellsCompleted + cellsTruncated > 0
            ? "partial"
            : "failed",
    cellsRequested: options.experiment.cells.length,
    cellsAttempted: cells.length,
    cellsUnstarted,
    cellsCompleted,
    cellsTruncated,
    cellsFailed,
    cells
  };
}

function validateInitialMatrixCells<TInput, TResult>(
  experiment: GenericExperimentMatrixSpec<TInput>,
  initialCells: Array<GenericExperimentMatrixCellResult<TResult>>
): Array<GenericExperimentMatrixCellResult<TResult>> {
  if (!Array.isArray(initialCells)) throw new Error("Generic experiment matrix initialCells must be an array.");
  if (initialCells.length > experiment.cells.length) {
    throw new Error("Generic experiment matrix initialCells exceed the requested schedule.");
  }
  const restored: Array<GenericExperimentMatrixCellResult<TResult>> = [];
  for (const [index, candidate] of initialCells.entries()) {
    const expected = experiment.cells[index]!;
    const label = expected.label ?? expected.id;
    const group = expected.group ?? "default";
    const executionId = `${experiment.id}:cell:${expected.id}:${index}`;
    if (
      !isRecord(candidate) ||
      candidate.index !== index ||
      candidate.id !== expected.id ||
      candidate.label !== label ||
      candidate.group !== group ||
      candidate.executionId !== executionId
    ) throw new Error(`Generic experiment matrix initial cell ${index} conflicts with the deterministic schedule.`);
    assertMatrixCellStatus(candidate.status);
    if (candidate.status === "failed" && !experiment.continueOnError && index !== initialCells.length - 1) {
      throw new Error("Generic experiment matrix initialCells continue after a terminal stop-on-error failure.");
    }
    restored.push({ ...candidate });
  }
  return restored;
}

export function validateGenericExperimentMatrixSpec<TInput>(spec: GenericExperimentMatrixSpec<TInput>): void {
  if (!isRecord(spec)) throw new Error("Generic experiment matrix spec must be an object.");
  if (spec.version !== undefined && spec.version !== GENERIC_EXPERIMENT_MATRIX_VERSION) {
    throw new Error(`Generic experiment matrix version must be ${GENERIC_EXPERIMENT_MATRIX_VERSION}.`);
  }
  if (typeof spec.id !== "string" || !spec.id.trim()) throw new Error("Generic experiment matrix id is required.");
  if (spec.continueOnError !== undefined && typeof spec.continueOnError !== "boolean") {
    throw new Error("Generic experiment matrix continueOnError must be a boolean when provided.");
  }
  if (!Array.isArray(spec.cells)) throw new Error("Generic experiment matrix cells must be an array.");
  if (!spec.cells.length) throw new Error("Generic experiment matrix requires at least one cell.");
  const ids = new Set<string>();
  for (const [index, candidate] of spec.cells.entries()) {
    if (!isRecord(candidate)) throw new Error(`Generic experiment matrix cell ${index} must be an object.`);
    const cell = candidate as GenericExperimentMatrixCell<TInput>;
    if (typeof cell.id !== "string" || !cell.id.trim()) {
      throw new Error(`Generic experiment matrix cell ${index} id is required.`);
    }
    if (cell.label !== undefined && (typeof cell.label !== "string" || !cell.label.trim())) {
      throw new Error(`Generic experiment matrix cell ${index} label must be a non-empty string when provided.`);
    }
    if (cell.group !== undefined && (typeof cell.group !== "string" || !cell.group.trim())) {
      throw new Error(`Generic experiment matrix cell ${index} group must be a non-empty string when provided.`);
    }
    if (ids.has(cell.id)) throw new Error(`Generic experiment matrix has duplicate cell id ${cell.id}.`);
    ids.add(cell.id);
  }
}

function defaultErrorText(_error: unknown): string {
  return GENERIC_EXPERIMENT_MATRIX_CELL_FAILURE_MESSAGE;
}

/**
 * Generic callers can cross a JSON/plugin boundary before reaching the matrix
 * runner. Keep the persisted lifecycle vocabulary closed even when TypeScript
 * types are no longer available at that boundary.
 */
function assertMatrixCellStatus(status: unknown): asserts status is GenericExperimentMatrixCellLifecycle {
  if (status === "completed" || status === "truncated" || status === "failed") return;
  throw new Error(`Generic experiment matrix cell status must be completed, truncated, or failed; received ${String(status)}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
