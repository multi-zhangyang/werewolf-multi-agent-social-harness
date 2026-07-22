import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface WorkerMessage {
  type: "READY" | "DONE" | "ERROR";
  disposition?: "created" | "active" | "finalized";
  attemptId?: string;
  message?: string;
}

const workerPath = fileURLToPath(new URL("./fixtures/experimentRunStoreConcurrentWorker.ts", import.meta.url));
const children = new Set<ChildProcess>();
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("experiment run cross-process revision CAS", () => {
  it("publishes one revision per numeric slot and converges exact concurrent writers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "experiment-run-cas-process-"));
    roots.push(root);
    const workers = [spawnWorker(root), spawnWorker(root)];
    await Promise.all(workers.map((child) => waitForMessage(child, "READY")));
    workers.forEach((child) => child.send("GO"));
    const done = await Promise.all(workers.map((child) => waitForMessage(child, "DONE")));
    expect(done.map((message) => message.disposition).sort()).toEqual(["active", "created"]);
    expect(new Set(done.map((message) => message.attemptId)).size).toBe(1);
    await Promise.all(workers.map(waitForExit));

    const directoryKey = createHash("sha256").update("cross-process-cas").digest("hex");
    const revisions = await readdir(path.join(root, "runs", directoryKey, "revisions"));
    expect(revisions.filter((name) => /^\d{12}(?:-|$)/.test(name)).sort()).toEqual([
      "000000000001",
      "000000000002"
    ]);
  }, 30_000);
});

function spawnWorker(root: string): ChildProcess {
  const child = fork(workerPath, [root], {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {}
  });
  children.add(child);
  return child;
}

function waitForMessage(child: ChildProcess, type: WorkerMessage["type"]): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for worker ${type}.`))), 10_000);
    const onMessage = (value: unknown) => {
      const message = value as WorkerMessage;
      if (message.type === "ERROR") finish(() => reject(new Error(message.message ?? "Worker failed.")));
      else if (message.type === type) finish(() => resolve(message));
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
