import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  HarnessExperimentMatrixRunStore,
  createGenericExperimentMatrixAuthoritySpec,
  type ExperimentMatrixChildRunAuthority
} from "../../src/harness/generic";
import { hashStableJsonValue } from "../../src/harness/hash";

type WorkerMode = "cas" | "lease";

const root = process.argv[2];
const mode = process.argv[3] as WorkerMode | undefined;
const matrixId = process.argv[4] ?? "cross-process-matrix";
if (!root) throw new Error("Concurrent matrix-store worker requires a root path.");
if (mode !== "cas" && mode !== "lease") throw new Error("Concurrent matrix-store worker mode is invalid.");

const schedule = {
  id: matrixId,
  continueOnError: false,
  cells: [{
    id: "cell-a",
    label: "Ledger A",
    group: "bookkeeping",
    input: { openingBalance: 100 }
  }]
};
const authority = createGenericExperimentMatrixAuthoritySpec({
  experiment: schedule,
  sourceSpecHash: hashStableJsonValue({ kind: "ledger-matrix", schedule }),
  inputHashOf: (input) => hashStableJsonValue(input)
});
const childAuthority: ExperimentMatrixChildRunAuthority = {
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
const store = await HarnessExperimentMatrixRunStore.open({
  baseDirectory: root,
  childRunStore: childAuthority,
  now: () => "2026-07-23T03:00:00.000Z"
});

await send({ type: "READY" });
process.once("message", async (message) => {
  if (message !== "GO") return;
  try {
    if (mode === "cas") {
      const begun = await store.beginOrResume({ matrixId, authority });
      const started = await store.startCell({
        matrixId,
        index: 0,
        startedAt: "2026-07-23T03:00:01.000Z"
      });
      await send({
        type: "DONE",
        disposition: begun.disposition,
        revisionState: started.state,
        currentExecutionId: started.currentCell?.executionId
      });
      process.exit(0);
    }

    await store.withMatrixLease(matrixId, async () => {
      await send({ type: "ACQUIRED" });
      await waitForExecute();
      const markersDirectory = path.join(root, "execution-markers");
      await mkdir(markersDirectory, { recursive: true });
      await writeFile(path.join(markersDirectory, `${process.pid}.json`), `${JSON.stringify({ matrixId })}\n`, {
        encoding: "utf8",
        flag: "wx"
      });
      const begun = await store.beginOrResume({ matrixId, authority });
      await store.startCell({
        matrixId,
        index: 0,
        startedAt: "2026-07-23T03:00:01.000Z"
      });
      await store.adoptCurrentCell(matrixId);
      const finalized = await store.finalize(matrixId, "2026-07-23T03:00:03.000Z");
      await send({
        type: "DONE",
        disposition: begun.disposition,
        state: finalized.state,
        settledCells: finalized.cells.length
      });
    });
    process.exit(0);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (mode === "lease" && /already active in another process/i.test(detail)) {
      await send({ type: "REJECTED", message: detail });
      process.exit(0);
    }
    await send({ type: "ERROR", message: detail });
    process.exit(1);
  }
});

function waitForExecute(): Promise<void> {
  return new Promise((resolve) => {
    const listener = (message: unknown) => {
      if (message !== "EXECUTE") return;
      process.off("message", listener);
      resolve();
    };
    process.on("message", listener);
  });
}

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Concurrent matrix-store worker requires an IPC channel."));
      return;
    }
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}
