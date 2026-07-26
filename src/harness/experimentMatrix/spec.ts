import {
  mergeExperimentOverrides,
  normalizeTournamentExperimentSpec,
  type TournamentExperimentSpecV1
} from "../experiment";
import {
  MATRIX_EXPERIMENT_VERSION,
  type MatrixExperimentSpecV1,
  type NormalizedMatrixExperiment
} from "./types";
import {
  assertUniqueCellIds,
  cloneJson,
  isRecord,
  removeControlFields,
  removeUndefined,
  safeId,
  stringField
} from "./internals";

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

export function matrixCellInputs(
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

export function dimensionCells(
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
  const jointPhaseSchedulers = dimensionArray(dimensions.jointPhaseSchedulers, base.jointPhaseScheduler);
  const temperatures = dimensionArray(dimensions.temperatures, base.temperature);
  const cells: Array<{ id?: string; label?: string; group?: string; spec: TournamentExperimentSpecV1 }> = [];
  for (const model of models) {
    for (const profile of profiles) {
      for (const assignment of assignments) {
        for (const seed of seeds) {
          for (const gameCount of games) {
            for (const maxTransition of maxTransitions) {
              for (const jointPhaseScheduler of jointPhaseSchedulers) {
                for (const temperature of temperatures) {
                  const spec: TournamentExperimentSpecV1 = {
                    ...base,
                    ...(model === undefined ? {} : { models: model as TournamentExperimentSpecV1["models"] }),
                    ...(profile === undefined ? {} : { profiles: profile as TournamentExperimentSpecV1["profiles"] }),
                    ...(assignment === undefined ? {} : { assignment: assignment as TournamentExperimentSpecV1["assignment"] }),
                    ...(seed === undefined ? {} : { seed: String(seed) }),
                    ...(gameCount === undefined ? {} : { games: gameCount as TournamentExperimentSpecV1["games"] }),
                    ...(maxTransition === undefined ? {} : { maxTransitions: maxTransition as TournamentExperimentSpecV1["maxTransitions"] }),
                    ...(jointPhaseScheduler === undefined
                      ? {}
                      : { jointPhaseScheduler: jointPhaseScheduler as TournamentExperimentSpecV1["jointPhaseScheduler"] }),
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
  }
  return cells;
}

export function dimensionArray(value: unknown, fallback: unknown): unknown[] {
  if (Array.isArray(value) && value.length) return value;
  return [fallback];
}
