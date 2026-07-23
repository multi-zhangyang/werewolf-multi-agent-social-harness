import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HarnessExperimentMatrixRunStore,
  createGenericExperimentMatrixAuthoritySpec,
  type ExperimentMatrixChildRunAuthority,
  type GenericExperimentMatrixFinalizedChildV1
} from "../src/harness/generic";
import { hashStableJsonValue } from "../src/harness/hash";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("experiment matrix parent run store", () => {
  it("persists begin, start-cell, adopt-cell, and finalize as a stable parent lifecycle", async () => {
    const fixture = await createFixture("matrix-parent-lifecycle");
    const store = await fixture.open();
    const begun = await store.beginOrResume({
      matrixId: fixture.matrixId,
      authority: fixture.authority
    });
    expect(begun).toMatchObject({ disposition: "created", revision: 1 });
    expect(begun.record).toMatchObject({ state: "active", cellsUnstarted: 1, cellsInFlight: 0, cells: [] });
    expect(begun.record.authority).toEqual(fixture.authority);
    expect(JSON.stringify(begun.record)).not.toContain("tournament");
    expect(JSON.stringify(begun.record)).not.toContain("model");

    fixture.clock.value = "2026-07-23T01:00:01.000Z";
    const started = await store.startCell({ matrixId: fixture.matrixId, index: 0 });
    expect(started.currentCell).toMatchObject({
      index: 0,
      id: "cell-a",
      childRunSetId: "matrix-parent-lifecycle:cell-a",
      startedAt: "2026-07-23T01:00:01.000Z"
    });

    fixture.children.set(
      "matrix-parent-lifecycle:cell-a",
      childRun("matrix-parent-lifecycle:cell-a", "2026-07-23T01:00:04.250Z", "completed")
    );
    fixture.clock.value = "2026-07-23T01:00:05.000Z";
    const adopted = await store.adoptCurrentCell(fixture.matrixId);
    expect(adopted).toMatchObject({
      state: "active",
      cellsCompleted: 1,
      cellsInFlight: 0,
      cellsUnstarted: 0,
      cells: [{
        childRunSetId: "matrix-parent-lifecycle:cell-a",
        completedAt: "2026-07-23T01:00:04.250Z",
        elapsedMs: 3250,
        status: "completed"
      }]
    });

    fixture.clock.value = "2026-07-23T01:00:06.000Z";
    const finalized = await store.finalize(fixture.matrixId);
    expect(finalized).toMatchObject({
      state: "finalized",
      createdAt: "2026-07-23T01:00:00.000Z",
      completedAt: "2026-07-23T01:00:06.000Z"
    });

    fixture.clock.value = "2030-01-01T00:00:00.000Z";
    const reopened = await fixture.open();
    const resumed = await reopened.beginOrResume({ matrixId: fixture.matrixId, authority: fixture.authority });
    expect(resumed).toMatchObject({ disposition: "finalized", revision: 4 });
    expect(resumed.record).toEqual(finalized);
    expect(await reopened.finalize(fixture.matrixId)).toEqual(finalized);
  });

  it("recovers a crash after start-cell without inventing parent progress", async () => {
    const fixture = await createFixture("matrix-crash-after-start");
    const first = await fixture.open();
    await first.beginOrResume({ matrixId: fixture.matrixId, authority: fixture.authority });
    fixture.clock.value = "2026-07-23T01:10:01.000Z";
    await first.startCell({ matrixId: fixture.matrixId, index: 0 });

    fixture.clock.value = "2026-07-23T01:20:00.000Z";
    const restarted = await fixture.open();
    const resume = await restarted.beginOrResume({ matrixId: fixture.matrixId, authority: fixture.authority });
    expect(resume).toMatchObject({
      disposition: "active",
      revision: 2,
      record: { cells: [], cellsInFlight: 1, cellsUnstarted: 0, currentCell: { index: 0 } }
    });
    await expect(restarted.adoptCurrentCell(fixture.matrixId)).rejects.toThrow(/child .* is missing/i);
    expect((await restarted.get(fixture.matrixId))?.cells).toEqual([]);
  });

  it("adopts a finalized child after restart when the crash happened before parent adoption", async () => {
    const fixture = await createFixture("matrix-crash-before-adopt");
    const first = await fixture.open();
    await first.beginOrResume({ matrixId: fixture.matrixId, authority: fixture.authority });
    fixture.clock.value = "2026-07-23T01:30:01.000Z";
    await first.startCell({ matrixId: fixture.matrixId, index: 0 });
    fixture.children.set(
      "matrix-crash-before-adopt:cell-a",
      childRun("matrix-crash-before-adopt:cell-a", "2026-07-23T01:30:03.000Z", "truncated")
    );

    fixture.clock.value = "2026-07-23T02:00:00.000Z";
    const restarted = await fixture.open();
    const adopted = await restarted.adoptCurrentCell(fixture.matrixId);
    expect(adopted.cells[0]).toMatchObject({
      status: "truncated",
      completedAt: "2026-07-23T01:30:03.000Z",
      elapsedMs: 2000
    });
    expect(adopted.updatedAt).toBe("2026-07-23T02:00:00.000Z");
  });

  it("resumes an adopted prefix and finalizes it without consulting child scheduling order", async () => {
    const fixture = await createFixture("matrix-crash-before-finalize");
    const first = await fixture.open();
    await first.beginOrResume({ matrixId: fixture.matrixId, authority: fixture.authority });
    fixture.clock.value = "2026-07-23T02:10:01.000Z";
    await first.startCell({ matrixId: fixture.matrixId, index: 0 });
    fixture.children.set(
      "matrix-crash-before-finalize:cell-a",
      childRun("matrix-crash-before-finalize:cell-a", "2026-07-23T02:10:02.000Z", "failed")
    );
    await first.adoptCurrentCell(fixture.matrixId);

    fixture.clock.value = "2026-07-23T02:11:00.000Z";
    const restarted = await fixture.open();
    const resume = await restarted.beginOrResume({ matrixId: fixture.matrixId, authority: fixture.authority });
    expect(resume).toMatchObject({ disposition: "active", revision: 3, record: { cellsFailed: 1, cellsInFlight: 0 } });
    const finalized = await restarted.finalize(fixture.matrixId);
    expect(finalized).toMatchObject({ state: "finalized", cellsFailed: 1, completedAt: "2026-07-23T02:11:00.000Z" });
  });

  it("fails closed when a resumed normalized matrix conflicts with the persisted parent hash", async () => {
    const fixture = await createFixture("matrix-parent-conflict");
    const store = await fixture.open();
    await store.beginOrResume({ matrixId: fixture.matrixId, authority: fixture.authority });
    const conflicting = structuredClone(fixture.authority);
    conflicting.sourceSpecHash = hashStableJsonValue({ kind: "ledger", revision: "conflicting" });
    await expect(store.beginOrResume({ matrixId: conflicting.id, authority: conflicting })).rejects.toThrow(
      /provenance conflicts with durable authority/i
    );
  });

  it("makes the production matrix entrypoint recover a durably started parent cell", async () => {
    const [{ normalizeMatrixExperimentSpec, runExperimentMatrix }, { openTournamentOrchestration }] = await Promise.all([
      import("../src/harness/experimentMatrix"),
      import("../src/harness/tournament")
    ]);
    const root = await mkdtemp(path.join(tmpdir(), "werewolf-matrix-production-recovery-"));
    tempDirs.push(root);
    const experiment = normalizeMatrixExperimentSpec({
      id: "matrix-production-recovery",
      continueOnError: true,
      base: {
        models: ["opaque/recovery-model"],
        games: 1,
        seed: "matrix-production-recovery",
        maxTransitions: 0
      },
      cells: [{ id: "cell-a" }]
    });
    const childAuthority = await openTournamentOrchestration({ baseDirectory: root });
    const parentStore = await HarnessExperimentMatrixRunStore.open({
      baseDirectory: path.join(root, "matrix-runs"),
      childRunStore: finalizedChildAuthority(childAuthority.runStore)
    });
    const genericSchedule = {
      id: experiment.id,
      continueOnError: experiment.continueOnError,
      cells: experiment.cells.map((cell) => ({ id: cell.id, label: cell.label, group: cell.group, input: cell.tournament }))
    };
    await parentStore.beginOrResume({
      matrixId: experiment.id,
      authority: createGenericExperimentMatrixAuthoritySpec({
        experiment: genericSchedule,
        sourceSpecHash: hashStableJsonValue(experiment),
        inputHashOf: (input) => hashStableJsonValue(input)
      })
    });
    await parentStore.startCell({ matrixId: experiment.id, index: 0 });

    const result = await runExperimentMatrix({
      experiment,
      orchestrationBaseDirectory: root,
      includeArtifacts: true,
      reasoner: {
        async think() {
          throw new Error("maxTransitions=0 recovery must not call a model");
        }
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      cellsRequested: 1,
      cellsTruncated: 1,
      cellsUnstarted: 0,
      cells: [{ id: "cell-a", status: "truncated" }]
    });
    const canonicalParent = await parentStore.get(experiment.id);
    expect(canonicalParent).toMatchObject({
      state: "finalized",
      cellsInFlight: 0,
      cellsTruncated: 1,
      cells: [{ childRunSetId: "matrix-production-recovery:cell-a", status: "truncated" }]
    });
    expect(result.createdAt).toBe(canonicalParent?.createdAt);
    expect(result.completedAt).toBe(canonicalParent?.completedAt);
    expect(result.cells[0]?.elapsedMs).toBe(canonicalParent?.cells[0]?.elapsedMs);
  });
});

async function createFixture(matrixId: string) {
  const root = await mkdtemp(path.join(tmpdir(), "werewolf-matrix-parent-store-"));
  tempDirs.push(root);
  const children = new Map<string, GenericExperimentMatrixFinalizedChildV1>();
  const authority: ExperimentMatrixChildRunAuthority = {
    async getFinalized(runSetId) {
      const record = children.get(runSetId);
      return record ? structuredClone(record) : undefined;
    }
  };
  const clock = { value: "2026-07-23T01:00:00.000Z" };
  const ledgerSchedule = {
    id: matrixId,
    continueOnError: false,
    cells: [{
      id: "cell-a",
      label: "Ledger A",
      group: "bookkeeping",
      input: { openingBalance: 100, entries: [{ account: "cash", delta: -5 }] }
    }]
  };
  const matrixAuthority = createGenericExperimentMatrixAuthoritySpec({
    experiment: ledgerSchedule,
    sourceSpecHash: hashStableJsonValue({ kind: "ledger-matrix", schedule: ledgerSchedule }),
    inputHashOf: (input) => hashStableJsonValue(input)
  });
  return {
    root,
    children,
    clock,
    matrixId,
    authority: matrixAuthority,
    open: () => HarnessExperimentMatrixRunStore.open({
      baseDirectory: root,
      childRunStore: authority,
      now: () => clock.value
    })
  };
}

function childRun(
  runSetId: string,
  updatedAt: string,
  status: "completed" | "truncated" | "failed"
): GenericExperimentMatrixFinalizedChildV1 {
  return {
    runSetId,
    status,
    completedAt: updatedAt,
    canonicalHash: hashStableJsonValue({ kind: "ledger-child", runSetId, status, completedAt: updatedAt })
  };
}

function finalizedChildAuthority(runStore: {
  get(runSetId: string): Promise<{
    runSetId: string;
    state: "active" | "finalized";
    updatedAt: string;
    gamesFailed: number;
    gamesTruncated: number;
    gamesUnstarted: number;
  } | undefined>;
}): ExperimentMatrixChildRunAuthority {
  return {
    async getFinalized(runSetId) {
      const child = await runStore.get(runSetId);
      if (!child || child.state !== "finalized") return undefined;
      return {
        runSetId: child.runSetId,
        status: child.gamesFailed || child.gamesUnstarted ? "failed" : child.gamesTruncated ? "truncated" : "completed",
        completedAt: child.updatedAt,
        canonicalHash: hashStableJsonValue(child)
      };
    }
  };
}
