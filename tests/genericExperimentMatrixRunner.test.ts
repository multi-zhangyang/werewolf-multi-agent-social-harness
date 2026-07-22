import { describe, expect, it } from "vitest";
import {
  GENERIC_EXPERIMENT_MATRIX_CELL_FAILURE_MESSAGE,
  GENERIC_EXPERIMENT_MATRIX_VERSION,
  runGenericExperimentMatrix,
  validateGenericExperimentMatrixSpec
} from "../src/harness/experimentMatrixRunner";

describe("generic experiment matrix control plane", () => {
  it("preserves deterministic cell order, tri-state lifecycle, opaque results, and continue-on-error without domain imports", async () => {
    const calls: string[] = [];
    const result = await runGenericExperimentMatrix({
      createdAt: "2026-07-21T03:00:00.000Z",
      experiment: {
        version: GENERIC_EXPERIMENT_MATRIX_VERSION,
        id: "ledger-matrix",
        continueOnError: true,
        cells: [
          { id: "complete", group: "baseline", input: { status: "completed" as const, entries: ["a:open"] } },
          { id: "bounded", input: { status: "truncated" as const, entries: ["a:open", "bounded"] } },
          { id: "failed", input: { status: "failed" as const, entries: [] } },
          { id: "after-failure", input: { status: "completed" as const, entries: ["b:close"] } }
        ]
      },
      async runCell(input, context) {
        calls.push(`${context.index}:${context.id}`);
        return input;
      },
      statusOf: (result) => result.status
    });

    expect(calls).toEqual(["0:complete", "1:bounded", "2:failed", "3:after-failure"]);
    expect(result).toMatchObject({
      artifactVersion: GENERIC_EXPERIMENT_MATRIX_VERSION,
      kind: "experiment-matrix",
      matrixId: "ledger-matrix",
      status: "partial",
      cellsRequested: 4,
      cellsAttempted: 4,
      cellsUnstarted: 0,
      cellsCompleted: 2,
      cellsTruncated: 1,
      cellsFailed: 1
    });
    expect(result.cells.map((cell) => [cell.id, cell.label, cell.group, cell.status, cell.executionId, cell.result])).toEqual([
      ["complete", "complete", "baseline", "completed", "ledger-matrix:cell:complete:0", { status: "completed", entries: ["a:open"] }],
      ["bounded", "bounded", "default", "truncated", "ledger-matrix:cell:bounded:1", { status: "truncated", entries: ["a:open", "bounded"] }],
      ["failed", "failed", "default", "failed", "ledger-matrix:cell:failed:2", { status: "failed", entries: [] }],
      ["after-failure", "after-failure", "default", "completed", "ledger-matrix:cell:after-failure:3", { status: "completed", entries: ["b:close"] }]
    ]);
  });

  it("continues after a bounded cell but stops at a failed cell when configured", async () => {
    const calls: string[] = [];
    const result = await runGenericExperimentMatrix({
      experiment: {
        id: "stop-on-failure",
        continueOnError: false,
        cells: [
          { id: "bounded", input: "truncated" as const },
          { id: "first-failure", input: "failed" as const },
          { id: "never", input: "completed" as const }
        ]
      },
      runCell: (input, context) => {
        calls.push(context.id);
        return input;
      },
      statusOf: (result) => result
    });
    expect(calls).toEqual(["bounded", "first-failure"]);
    expect(result).toMatchObject({
      status: "partial",
      cellsRequested: 3,
      cellsAttempted: 2,
      cellsUnstarted: 1,
      cellsFailed: 1,
      cellsCompleted: 0,
      cellsTruncated: 1
    });

    expect(result.cells.map((cell) => [cell.id, cell.status])).toEqual([
      ["bounded", "truncated"],
      ["first-failure", "failed"]
    ]);
  });

  it("does not report completed when a shared control-plane abort leaves cells unstarted", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const result = await runGenericExperimentMatrix({
      experiment: {
        id: "abort-matrix",
        continueOnError: true,
        cells: [
          { id: "first", input: "completed" as const },
          { id: "unstarted", input: "completed" as const }
        ]
      },
      abortSignal: controller.signal,
      runCell: (input, context) => {
        calls.push(context.id);
        controller.abort();
        return input;
      },
      statusOf: (result) => result
    });

    expect(calls).toEqual(["first"]);
    expect(result).toMatchObject({
      status: "partial",
      cellsRequested: 2,
      cellsAttempted: 1,
      cellsUnstarted: 1,
      cellsCompleted: 1,
      cellsFailed: 0
    });
  });

  it("rejects malformed cell identity before it runs", () => {
    expect(() =>
      validateGenericExperimentMatrixSpec({
        id: "bad",
        cells: [
          { id: "duplicate", input: null },
          { id: "duplicate", input: null }
        ]
      })
    ).toThrow(/duplicate cell id/);

    expect(() =>
      validateGenericExperimentMatrixSpec({
        id: "invalid-continue",
        continueOnError: "false" as never,
        cells: [{ id: "cell", input: null }]
      })
    ).toThrow(/continueOnError must be a boolean/i);
  });

  it("converts an invalid domain lifecycle into explicit failed cell evidence", async () => {
    const result = await runGenericExperimentMatrix({
      createdAt: "2026-07-21T03:00:00.000Z",
      experiment: {
        id: "invalid-lifecycle",
        continueOnError: true,
        cells: [{ id: "bad-domain-result", input: { source: "ledger" } }]
      },
      runCell: (input) => input,
      statusOf: () => "unknown" as never
    });

    expect(result).toMatchObject({
      status: "failed",
      cellsRequested: 1,
      cellsAttempted: 1,
      cellsUnstarted: 0,
      cellsFailed: 1
    });
    expect(result.cells[0]).toMatchObject({
      id: "bad-domain-result",
      status: "failed",
      error: GENERIC_EXPERIMENT_MATRIX_CELL_FAILURE_MESSAGE
    });
    expect(result.cells[0]).not.toHaveProperty("result");
  });

  it("records a thrown domain execution as a failed cell and continues when configured", async () => {
    const calls: string[] = [];
    const result = await runGenericExperimentMatrix({
      experiment: {
        id: "thrown-cell",
        continueOnError: true,
        cells: [
          { id: "throw", input: "throw" as const },
          { id: "recover", input: "completed" as const }
        ]
      },
      runCell(input, context) {
        calls.push(context.id);
        if (input === "throw") throw new Error("Bearer secret-token https://provider.example/raw-body request-id=unsafe");
        return input;
      },
      statusOf: (result) => result
    });

    expect(calls).toEqual(["throw", "recover"]);
    expect(result).toMatchObject({
      status: "partial",
      cellsAttempted: 2,
      cellsUnstarted: 0,
      cellsCompleted: 1,
      cellsFailed: 1
    });
    expect(result.cells[0]).toMatchObject({ status: "failed", error: GENERIC_EXPERIMENT_MATRIX_CELL_FAILURE_MESSAGE });
    expect(JSON.stringify(result.cells[0])).not.toContain("secret-token");
    expect(JSON.stringify(result.cells[0])).not.toContain("provider.example");
    expect(result.cells[0]).not.toHaveProperty("result");
  });

  it("resumes a validated contiguous settled prefix without rerunning its cells or hooks", async () => {
    const calls: string[] = [];
    const result = await runGenericExperimentMatrix({
      experiment: {
        id: "resume-matrix",
        continueOnError: true,
        cells: [
          { id: "settled", label: "Settled", group: "g", input: "must-not-run" },
          { id: "suffix", input: "completed" as const }
        ]
      },
      initialCells: [{
        index: 0,
        id: "settled",
        label: "Settled",
        group: "g",
        executionId: "resume-matrix:cell:settled:0",
        status: "truncated",
        result: "canonical-prefix"
      }],
      onCellStarting: (context) => { calls.push(`start:${context.id}`); },
      runCell: (input, context) => { calls.push(`run:${context.id}`); return input; },
      statusOf: () => "completed",
      onCellSettled: (cell) => { calls.push(`settled:${cell.id}`); }
    });

    expect(calls).toEqual(["start:suffix", "run:suffix", "settled:suffix"]);
    expect(result.cells.map((cell) => [cell.id, cell.status])).toEqual([
      ["settled", "truncated"],
      ["suffix", "completed"]
    ]);
  });

  it("keeps control-plane hooks and durable cell exceptions outside ordinary failure capture", async () => {
    const experiment = {
      id: "fatal-control-plane",
      continueOnError: true,
      cells: [{ id: "first", input: "completed" as const }, { id: "second", input: "completed" as const }]
    };
    await expect(runGenericExperimentMatrix({
      experiment,
      runCell: (input) => input,
      statusOf: (result) => result,
      onCellStarting() { throw new Error("durable start failed"); }
    })).rejects.toThrow(/durable start failed/);

    await expect(runGenericExperimentMatrix({
      experiment,
      captureCellErrors: false,
      runCell() { throw new Error("canonical store drift"); },
      statusOf: (result) => result
    })).rejects.toThrow(/canonical store drift/);

    await expect(runGenericExperimentMatrix({
      experiment,
      runCell: (input) => input,
      statusOf: (result) => result,
      onCellSettled() { throw new Error("durable membership failed"); }
    })).rejects.toThrow(/durable membership failed/);
  });

  it("rejects a restored prefix whose identity or stop-on-error order conflicts with the schedule", async () => {
    const experiment = {
      id: "invalid-prefix",
      continueOnError: false,
      cells: [{ id: "first", input: 1 }, { id: "second", input: 2 }]
    };
    await expect(runGenericExperimentMatrix({
      experiment,
      initialCells: [{
        index: 0,
        id: "wrong",
        label: "wrong",
        group: "default",
        executionId: "invalid-prefix:cell:wrong:0",
        status: "completed"
      }],
      runCell: (input) => input,
      statusOf: () => "completed"
    })).rejects.toThrow(/conflicts with the deterministic schedule/i);

    await expect(runGenericExperimentMatrix({
      experiment,
      initialCells: [
        {
          index: 0, id: "first", label: "first", group: "default",
          executionId: "invalid-prefix:cell:first:0", status: "failed"
        },
        {
          index: 1, id: "second", label: "second", group: "default",
          executionId: "invalid-prefix:cell:second:1", status: "completed"
        }
      ],
      runCell: (input) => input,
      statusOf: () => "completed"
    })).rejects.toThrow(/continue after a terminal stop-on-error failure/i);
  });
});
