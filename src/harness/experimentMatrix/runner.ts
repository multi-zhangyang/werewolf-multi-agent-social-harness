import path from "node:path";
import type { NormalizedTournamentExperiment } from "../experiment";
import {
  createGenericExperimentMatrixAuthoritySpec,
  runGenericExperimentMatrix,
  type GenericExperimentMatrixSpec
} from "../experimentMatrixRunner";
import {
  HarnessExperimentMatrixRunStore,
  type HarnessExperimentMatrixRunRecordV1
} from "../experimentMatrixRunStore";
import { hashStableJsonValue } from "../hash";
import { safeProviderFailureMessage } from "../providerFailure";
import {
  openTournamentOrchestration,
  runTournament,
  type OpenedTournamentOrchestrationOptions,
  type TournamentResult
} from "../tournament";
import {
  MATRIX_ARTIFACT_VERSION,
  type ExperimentMatrixCellResult,
  type ExperimentMatrixResult,
  type ExperimentMatrixRunOptions
} from "./types";
import { gamesTruncatedForCell, gamesUnstartedForCell, sumCells } from "./internals";
import { buildExperimentMatrixStatistics } from "./statistics";

export async function runExperimentMatrix(options: ExperimentMatrixRunOptions): Promise<ExperimentMatrixResult> {
  // Open durable authority before entering the generic cell error boundary.
  // Store/provenance/integrity failures must abort the matrix, never become a
  // misleading ordinary failed cell under continueOnError.
  const sharedOrchestration = options.orchestrationBaseDirectory
    ? await openTournamentOrchestration({ baseDirectory: options.orchestrationBaseDirectory })
    : undefined;
  if (!sharedOrchestration || !options.orchestrationBaseDirectory) {
    return runExperimentMatrixWithAuthority(options, undefined, undefined);
  }
  const matrixStore = await HarnessExperimentMatrixRunStore.open({
    baseDirectory: path.join(path.resolve(options.orchestrationBaseDirectory), "matrix-runs"),
    childRunStore: {
      async getFinalized(runSetId) {
        const child = await sharedOrchestration.runStore.get(runSetId);
        if (!child || child.state !== "finalized") return undefined;
        return {
          runSetId: child.runSetId,
          status: lifecycleForChildRunRecord(child),
          completedAt: child.updatedAt,
          canonicalHash: hashStableJsonValue(child)
        };
      }
    }
  });
  return matrixStore.withMatrixLease(options.experiment.id, () =>
    runExperimentMatrixWithAuthority(options, sharedOrchestration, matrixStore)
  );
}

async function runExperimentMatrixWithAuthority(
  options: ExperimentMatrixRunOptions,
  sharedOrchestration: OpenedTournamentOrchestrationOptions | undefined,
  matrixStore: HarnessExperimentMatrixRunStore | undefined
): Promise<ExperimentMatrixResult> {
  const elapsedMsByExecutionId = new Map<string, number>();
  const executeTournamentCell = (
    tournament: NormalizedTournamentExperiment,
    cellId: string
  ) => runTournament({
    models: tournament.models,
    profiles: tournament.profiles,
    assignment: tournament.assignment,
    games: tournament.games,
    seed: tournament.seed,
    maxTransitions: tournament.maxTransitions,
    jointPhaseScheduler: tournament.jointPhaseScheduler,
    config: tournament.config,
    temperature: tournament.temperature,
    continueOnError: tournament.continueOnError,
    experiment: tournament,
    includeArtifacts: options.includeArtifacts,
    reasoner: options.reasoner,
    executionLimits: options.executionLimits,
    orchestration: sharedOrchestration
      ? { ...sharedOrchestration, runSetId: `${options.experiment.id}:${cellId}` }
      : undefined
  });
  const statusOfTournament = (tournament: TournamentResult): "completed" | "truncated" | "failed" => {
    const gamesTruncated = tournament.gamesTruncated ?? tournament.episodes.filter((episode) => episode.status === "truncated").length;
    const gamesUnstarted = tournament.gamesUnstarted ?? Math.max(0, tournament.gamesRequested - tournament.episodes.length);
    return tournament.gamesFailed || gamesUnstarted > 0 ? "failed" : gamesTruncated > 0 ? "truncated" : "completed";
  };
  const initialCells = [] as Array<{
    index: number;
    id: string;
    label: string;
    group: string;
    executionId: string;
    status: "completed" | "truncated" | "failed";
    result: TournamentResult;
  }>;
  const genericExperiment: GenericExperimentMatrixSpec<NormalizedTournamentExperiment> = {
    id: options.experiment.id,
    continueOnError: options.experiment.continueOnError,
    cells: options.experiment.cells.map((cell) => ({
      id: cell.id,
      label: cell.label,
      group: cell.group,
      input: cell.tournament
    }))
  };
  const matrixAuthority = createGenericExperimentMatrixAuthoritySpec({
    experiment: genericExperiment,
    sourceSpecHash: hashStableJsonValue(options.experiment),
    inputHashOf: (tournament) => hashStableJsonValue(tournament)
  });
  let parentRecord: HarnessExperimentMatrixRunRecordV1 | undefined;
  if (matrixStore) {
    const resume = await matrixStore.beginOrResume({
      matrixId: options.experiment.id,
      authority: matrixAuthority
    });
    parentRecord = resume.record;
    // A crash may leave a started parent cell whose child run-set is absent,
    // active, or already finalized. Re-entering the existing child orchestrator
    // recovers that exact child without granting it parent membership authority.
    if (parentRecord.state === "active" && parentRecord.currentCell) {
      const current = parentRecord.currentCell;
      const expected = options.experiment.cells[current.index]!;
      await executeTournamentCell(expected.tournament, expected.id);
      parentRecord = await matrixStore.adoptCurrentCell(options.experiment.id);
    }
    for (const reference of parentRecord.cells) {
      const cell = options.experiment.cells[reference.index]!;
      const tournament = await executeTournamentCell(cell.tournament, cell.id);
      const status = statusOfTournament(tournament);
      if (status !== reference.status) {
        throw new Error(`Matrix child ${reference.childRunSetId} lifecycle conflicts with parent authority.`);
      }
      elapsedMsByExecutionId.set(reference.executionId, reference.elapsedMs);
      initialCells.push({
        index: reference.index,
        id: reference.id,
        label: reference.label,
        group: reference.group,
        executionId: reference.executionId,
        status: reference.status,
        result: tournament
      });
    }
  }
  const matrixAbortSignal = parentRecord?.state === "finalized"
    ? AbortSignal.abort("matrix already finalized")
    : options.executionLimits?.abortSignal;
  const generic = await runGenericExperimentMatrix({
    experiment: genericExperiment,
    abortSignal: matrixAbortSignal,
    initialCells,
    createdAt: parentRecord?.createdAt,
    captureCellErrors: sharedOrchestration ? false : true,
    onCellStarting: matrixStore
      ? async (context) => {
          await matrixStore.startCell({ matrixId: options.experiment.id, index: context.index });
        }
      : undefined,
    onCellSettled: matrixStore
      ? async (settled) => {
          const record = await matrixStore.adoptCurrentCell(options.experiment.id);
          const adopted = record.cells[settled.index];
          if (!adopted || adopted.status !== settled.status) {
            throw new Error(`Matrix child ${settled.id} lifecycle conflicts with its adopted parent reference.`);
          }
          elapsedMsByExecutionId.set(settled.executionId, adopted.elapsedMs);
        }
      : undefined,
    runCell: async (tournament, context) => {
      const started = performance.now();
      try {
        return await executeTournamentCell(tournament, context.id);
      } finally {
        elapsedMsByExecutionId.set(context.executionId, Math.round(performance.now() - started));
      }
    },
    statusOf: (tournament) => {
      // A cell with an externally aborted, partially scheduled tournament is
      // not a completed experiment. The exact unstarted-game count remains on
      // the result; generic matrix lifecycle has no separate partial-cell
      // status, so it is a control-plane failure at this boundary.
      return statusOfTournament(tournament);
    },
    describeError: (error) => safeProviderFailureMessage(error, "Experiment matrix cell failed before its tournament result was recorded.")
  });
  if (matrixStore) parentRecord = await matrixStore.finalize(options.experiment.id);
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
    createdAt: parentRecord?.createdAt ?? generic.createdAt,
    completedAt: parentRecord?.completedAt ?? generic.completedAt,
    status: generic.status,
    cellsRequested: generic.cellsRequested,
    cellsUnstarted: generic.cellsUnstarted,
    cellsCompleted: generic.cellsCompleted,
    cellsTruncated: generic.cellsTruncated,
    cellsFailed: generic.cellsFailed,
    gamesRequested: sumCells(cells, (cell) => cell.tournament?.gamesRequested ?? 0),
    gamesCompleted: sumCells(cells, (cell) => cell.tournament?.gamesCompleted ?? 0),
    gamesTruncated: sumCells(cells, gamesTruncatedForCell),
    gamesFailed: sumCells(cells, (cell) => cell.tournament?.gamesFailed ?? 0),
    gamesUnstarted: sumCells(cells, gamesUnstartedForCell),
    cells,
    statistics
  };
}

export function lifecycleForChildRunRecord(child: {
  gamesFailed: number;
  gamesTruncated: number;
  gamesUnstarted: number;
}): "completed" | "truncated" | "failed" {
  if (child.gamesFailed > 0 || child.gamesUnstarted > 0) return "failed";
  return child.gamesTruncated > 0 ? "truncated" : "completed";
}
