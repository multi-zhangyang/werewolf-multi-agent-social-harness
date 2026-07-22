import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

type CrashPoint =
  | "after_start"
  | "after_stage"
  | "after_artifact_put"
  | "after_terminal_membership"
  | "after_finalize";

interface WorkerMessage {
  type: "READY_TO_KILL" | "DONE" | "ERROR";
  crashPoint?: CrashPoint;
  episodeIndex?: number;
  message?: string;
  state?: "active" | "finalized";
  statuses?: Array<"completed" | "truncated" | "failed">;
  gamesUnstarted?: number;
  artifactRunIds?: string[];
  decisions?: Array<{ index: number; seed: string }>;
}

type TrackedChild = ChildProcess & { stderrTail?: string };

const workerPath = fileURLToPath(new URL("./fixtures/experimentV2CrashWorker.ts", import.meta.url));
const children = new Set<TrackedChild>();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("experiment v2 single-writer process-crash recovery", () => {
  it.each([
    "after_start",
    "after_stage",
    "after_artifact_put",
    "after_terminal_membership",
    "after_finalize"
  ] as const)("recovers without rerunning durable episode work after %s", async (crashPoint) => {
    const root = await mkdtemp(path.join(tmpdir(), "experiment-v2-crash-"));
    roots.push(root);
    const crashing = spawnWorker("crash", crashPoint, root);
    const ready = await waitForMessage(crashing, (message) => message.type === "READY_TO_KILL");
    expect(ready.crashPoint).toBe(crashPoint);

    const exit = waitForExit(crashing);
    expect(crashing.kill("SIGKILL")).toBe(true);
    expect(await exit).toEqual({ code: null, signal: "SIGKILL" });
    children.delete(crashing);

    const before = await readDecisionRows(root);
    const resuming = spawnWorker("resume", "none", root);
    const done = await waitForMessage(resuming, (message) => message.type === "DONE");
    const normalExit = await waitForExit(resuming);
    expect(normalExit).toEqual({ code: 0, signal: null });
    children.delete(resuming);

    const after = await readDecisionRows(root);
    const delta = after.slice(before.length);
    expect(delta.some((row) => row.index === 0)).toBe(false);
    expect(delta.map((row) => row.index)).toEqual(crashPoint === "after_finalize" ? [] : [1]);
    expect(done.state).toBe("finalized");
    expect(done.gamesUnstarted).toBe(0);
    expect(done.statuses).toEqual(
      crashPoint === "after_start" || crashPoint === "after_stage"
        ? ["failed", "completed"]
        : ["completed", "completed"]
    );
    expect(done.artifactRunIds).toHaveLength(
      crashPoint === "after_start" || crashPoint === "after_stage" ? 1 : 2
    );
    expect(after.map((row) => row.index)).toEqual(
      crashPoint === "after_start" ? [1] : [0, 1]
    );
  }, 60_000);
});

function spawnWorker(mode: "crash" | "resume", crashPoint: CrashPoint | "none", root: string): TrackedChild {
  const child = fork(workerPath, [mode, crashPoint, root], {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {}
  }) as TrackedChild;
  child.stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    child.stderrTail = `${child.stderrTail ?? ""}${chunk}`.slice(-8_192);
  });
  children.add(child);
  return child;
}

function waitForMessage(
  child: TrackedChild,
  predicate: (message: WorkerMessage) => boolean
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(workerError(child, "Timed out waiting for crash worker IPC."))), 15_000);
    const onMessage = (value: unknown) => {
      const message = value as WorkerMessage;
      if (message.type === "ERROR") {
        finish(() => reject(workerError(child, message.message ?? "Crash worker reported an error.")));
      } else if (predicate(message)) {
        finish(() => resolve(message));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(() => reject(workerError(child, `Crash worker exited before IPC (code=${code}, signal=${signal}).`)));
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function stopChild(child: TrackedChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = waitForExit(child);
  child.kill("SIGKILL");
  await exit;
}

async function readDecisionRows(root: string): Promise<Array<{ index: number; seed: string }>> {
  try {
    const text = await readFile(path.join(root, "actor-decisions.jsonl"), "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function workerError(child: TrackedChild, message: string): Error {
  return new Error(`${message}${child.stderrTail ? `\n${child.stderrTail}` : ""}`);
}
