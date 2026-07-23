import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  HarnessExperimentMatrixRunStore,
  type ExperimentMatrixChildRunAuthority
} from "../src/harness/generic";
import { hashStableJsonValue } from "../src/harness/hash";

interface WorkerMessage {
  type: "READY" | "ACQUIRED" | "REJECTED" | "DONE" | "ERROR";
  disposition?: "created" | "active" | "finalized";
  state?: "active" | "finalized";
  revisionState?: "active" | "finalized";
  currentExecutionId?: string;
  settledCells?: number;
  message?: string;
}

const workerPath = fileURLToPath(new URL("./fixtures/experimentMatrixRunStoreConcurrentWorker.ts", import.meta.url));
const children = new Set<ChildProcess>();
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("experiment matrix cross-process authority", () => {
  it("uses numeric revision CAS to converge exact concurrent cell starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "experiment-matrix-cas-process-"));
    roots.push(root);
    const matrixId = "cross-process-matrix-cas";
    const workers = [spawnWorker(root, "cas", matrixId), spawnWorker(root, "cas", matrixId)];
    await Promise.all(workers.map((child) => waitForMessage(child, ["READY"])));
    workers.forEach((child) => child.send("GO"));
    const done = await Promise.all(workers.map((child) => waitForMessage(child, ["DONE"])));

    expect(done.map((message) => message.disposition).sort()).toEqual(["active", "created"]);
    expect(done.every((message) => message.revisionState === "active")).toBe(true);
    expect(new Set(done.map((message) => message.currentExecutionId)).size).toBe(1);
    await Promise.all(workers.map(waitForExit));

    expect(await revisionNames(root, matrixId)).toEqual(["000000000001", "000000000002"]);
    const store = await openStore(root, matrixId);
    const current = await store.get(matrixId);
    expect(current).toMatchObject({
      state: "active",
      cellsCompleted: 0,
      cellsInFlight: 1,
      cellsUnstarted: 0,
      cells: [],
      currentCell: { index: 0, id: "cell-a" }
    });
    await store.adoptCurrentCell(matrixId);
    await store.finalize(matrixId, "2026-07-23T03:00:03.000Z");

    const reopened = await openStore(root, matrixId);
    expect(await reopened.get(matrixId)).toMatchObject({
      state: "finalized",
      cellsRequested: 1,
      cellsCompleted: 1,
      cellsTruncated: 0,
      cellsFailed: 0,
      cellsInFlight: 0,
      cellsUnstarted: 0,
      cells: [{ index: 0, id: "cell-a", status: "completed" }]
    });
    expect(await revisionNames(root, matrixId)).toEqual([
      "000000000001",
      "000000000002",
      "000000000003",
      "000000000004"
    ]);
  }, 30_000);

  it("leases one process for the complete matrix lifecycle and prevents duplicate execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "experiment-matrix-lease-process-"));
    roots.push(root);
    const matrixId = "cross-process-matrix-lease";
    const workers = [spawnWorker(root, "lease", matrixId), spawnWorker(root, "lease", matrixId)];
    await Promise.all(workers.map((child) => waitForMessage(child, ["READY"])));
    workers.forEach((child) => child.send("GO"));

    const outcomes = await Promise.all(workers.map((child) => waitForMessage(child, ["ACQUIRED", "REJECTED"])));
    expect(outcomes.map((message) => message.type).sort()).toEqual(["ACQUIRED", "REJECTED"]);
    const winnerIndex = outcomes.findIndex((message) => message.type === "ACQUIRED");
    workers[winnerIndex]!.send("EXECUTE");
    const done = await waitForMessage(workers[winnerIndex]!, ["DONE"]);
    expect(done).toMatchObject({ disposition: "created", state: "finalized", settledCells: 1 });
    await Promise.all(workers.map(waitForExit));

    expect(await readdir(path.join(root, "execution-markers"))).toHaveLength(1);
    expect(await revisionNames(root, matrixId)).toEqual([
      "000000000001",
      "000000000002",
      "000000000003",
      "000000000004"
    ]);
    const reopened = await openStore(root, matrixId);
    const canonical = await reopened.get(matrixId);
    expect(canonical).toMatchObject({
      state: "finalized",
      cellsRequested: 1,
      cellsCompleted: 1,
      cellsTruncated: 0,
      cellsFailed: 0,
      cellsInFlight: 0,
      cellsUnstarted: 0,
      cells: [{ index: 0, id: "cell-a", status: "completed" }]
    });
    expect(canonical?.currentCell).toBeUndefined();
  }, 30_000);
});

function spawnWorker(root: string, mode: "cas" | "lease", matrixId: string): ChildProcess {
  const child = fork(workerPath, [root, mode, matrixId], {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {}
  });
  children.add(child);
  return child;
}

function waitForMessage(child: ChildProcess, types: WorkerMessage["type"][]): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out waiting for worker ${types.join("/")}.`))),
      10_000
    );
    const onMessage = (value: unknown) => {
      const message = value as WorkerMessage;
      if (message.type === "ERROR") finish(() => reject(new Error(message.message ?? "Worker failed.")));
      else if (types.includes(message.type)) finish(() => resolve(message));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(() => reject(new Error(`Worker exited early (code=${code}, signal=${signal}).`)));
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      callback();
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`Worker exited with code ${code}.`));
    });
  });
}

async function revisionNames(root: string, matrixId: string): Promise<string[]> {
  const directoryKey = createHash("sha256").update(matrixId).digest("hex");
  return (await readdir(path.join(root, "matrices", directoryKey, "revisions")))
    .filter((name) => /^\d{12}$/.test(name))
    .sort();
}

async function openStore(root: string, matrixId: string): Promise<HarnessExperimentMatrixRunStore> {
  return HarnessExperimentMatrixRunStore.open({
    baseDirectory: root,
    childRunStore: childAuthority(matrixId),
    now: () => "2026-07-23T03:00:00.000Z"
  });
}

function childAuthority(matrixId: string): ExperimentMatrixChildRunAuthority {
  return {
    async getFinalized(runSetId) {
      if (runSetId !== `${matrixId}:cell-a`) return undefined;
      return {
        runSetId,
        status: "completed",
        completedAt: "2026-07-23T03:00:02.000Z",
        canonicalHash: hashStableJsonValue({ kind: "ledger-child", runSetId, status: "completed" })
      };
    }
  };
}
