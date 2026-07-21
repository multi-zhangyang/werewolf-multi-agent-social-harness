import { describe, expect, it } from "vitest";
import {
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
      error: expect.stringMatching(/status must be completed, truncated, or failed/i)
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
        if (input === "throw") throw new Error("ledger execution failed");
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
    expect(result.cells[0]).toMatchObject({ status: "failed", error: "ledger execution failed" });
    expect(result.cells[0]).not.toHaveProperty("result");
  });
});
