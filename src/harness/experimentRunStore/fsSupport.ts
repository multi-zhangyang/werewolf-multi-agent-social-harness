import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { RUN_LEASE_ACQUIRED_MARKER } from "./types";

export async function readSafeFile(directory: string, fileName: string): Promise<string> {
  const candidate = path.join(directory, fileName);
  await assertDirectory(directory, "Experiment run revision is not a safe directory.");
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Experiment run record is not a regular file.");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

export async function assertDirectory(directory: string, message: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
}

export async function assertDirectoryInside(parent: string, directory: string, message: string): Promise<void> {
  await assertDirectory(parent, message);
  await assertDirectory(directory, message);
  const parentReal = await realpath(parent);
  const directoryReal = await realpath(directory);
  if (directoryReal !== parentReal && !directoryReal.startsWith(`${parentReal}${path.sep}`)) throw new Error(message);
}

export async function assertWritableFileTarget(target: string, message: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(message);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function assertPathMissing(target: string, message: string): Promise<void> {
  try {
    await lstat(target);
    throw new Error(message);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

export function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: string }).code === "EEXIST" || (error as { code?: string }).code === "ENOTEMPTY")
  );
}

export async function waitForRunLease(child: ChildProcessWithoutNullStreams, runSetId: string): Promise<void> {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(RUN_LEASE_ACQUIRED_MARKER)) finish(resolve);
    };
    const onStderr = (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_024); };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(() => reject(new Error(
      code === 1
        ? `Experiment run ${runSetId} is already active in another process.`
        : `Experiment run lease failed before acquisition (code=${code}, signal=${signal}${stderr ? `, detail=${stderr.trim()}` : ""}).`
    )));
    const finish = (callback: () => void) => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function releaseRunLease(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.stdin.end();
  await exited;
}
