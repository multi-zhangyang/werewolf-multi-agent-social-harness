import { hashStableState } from "../hash";
import { DIRECTORY_KEY_PATTERN, GenericCheckpointEnvelope, GenericEpisodeEnvelope, HarnessEpisodeCheckpointStoreEntry, HarnessEpisodeStoreEntry, STORE_LEASE_ACQUIRED_MARKER } from "./model";
import path from "node:path";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
export async function readSafeFile(directory: string, fileName: string): Promise<string> {
  const candidate = path.join(directory, fileName);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Stored episode artifact file is not a regular file.");
  const realDirectory = await realpath(directory);
  const realCandidate = await realpath(candidate);
  if (!isStrictlyInside(realCandidate, realDirectory)) throw new Error("Stored episode artifact file escaped its directory.");
  return readFile(candidate, "utf8");
}

export async function assertDirectory(directory: string, message: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(message);
}

export async function assertDirectoryInside(parent: string, directory: string, message: string): Promise<void> {
  await assertDirectory(parent, message);
  await assertDirectory(directory, message);
  const realParent = await realpath(parent);
  const realDirectory = await realpath(directory);
  if (!isStrictlyInside(realDirectory, realParent)) throw new Error(message);
}

export async function assertPathMissing(candidate: string, message: string): Promise<void> {
  try {
    await lstat(candidate);
    throw new Error(message);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

export async function assertWritableFileTarget(candidate: string, message: string): Promise<void> {
  try {
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(message);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

export function assertArtifactIdentity(artifact: GenericEpisodeEnvelope): void {
  assertRunId(artifact.runId);
  if (!artifact.artifactVersion.trim()) throw new Error("Episode artifact artifactVersion is required.");
  if (!artifact.kind.trim()) throw new Error("Episode artifact kind is required.");
  if (!artifact.createdAt.trim()) throw new Error("Episode artifact createdAt is required.");
}

export function assertCheckpointIdentity(
  checkpoint: GenericCheckpointEnvelope,
  artifact: GenericEpisodeEnvelope
): void {
  assertCheckpointId(checkpoint.checkpointId);
  if (!checkpoint.artifactVersion.trim()) throw new Error("Harness checkpoint artifactVersion is required.");
  if (!checkpoint.kind.trim()) throw new Error("Harness checkpoint kind is required.");
  if (!checkpoint.createdAt.trim()) throw new Error("Harness checkpoint createdAt is required.");
  if (checkpoint.source.runId !== artifact.runId) {
    throw new Error("Harness checkpoint source run id does not match its canonical episode artifact.");
  }
  if (checkpoint.source.sourceArtifactVersion !== artifact.artifactVersion) {
    throw new Error("Harness checkpoint source artifact version does not match its canonical episode artifact.");
  }
  if (checkpoint.executionPrefix.id !== artifact.runId) {
    throw new Error("Harness checkpoint execution prefix id does not match its canonical episode artifact.");
  }
  if (
    checkpoint.source.nativeStepCount > artifact.socialEpisode.steps.length ||
    hashStableState(checkpoint.executionPrefix.steps) !==
      hashStableState(artifact.socialEpisode.steps.slice(0, checkpoint.source.nativeStepCount))
  ) {
    throw new Error("Harness checkpoint steps are not a canonical prefix of the episode artifact.");
  }
  if (
    checkpoint.source.messageCount > artifact.socialEpisode.messages.length ||
    hashStableState(checkpoint.executionPrefix.messages) !==
      hashStableState(artifact.socialEpisode.messages.slice(0, checkpoint.source.messageCount))
  ) {
    throw new Error("Harness checkpoint messages are not a canonical prefix of the episode artifact.");
  }
  for (const [label, checkpointValue, artifactValue] of [
    ["initial state", checkpoint.executionPrefix.initialState, artifact.socialEpisode.initialState],
    ["channels", checkpoint.executionPrefix.channels, artifact.socialEpisode.channels],
    ["domain adapter", checkpoint.executionPrefix.domainAdapter, artifact.socialEpisode.domainAdapter],
    ["runtime actors", checkpoint.executionPrefix.runtimeActorIds, artifact.socialEpisode.runtimeActorIds]
  ] as const) {
    if (hashStableState(checkpointValue) !== hashStableState(artifactValue)) {
      throw new Error(`Harness checkpoint ${label} does not match its canonical episode artifact.`);
    }
  }
  if (
    checkpoint.executionPrefix.domainId !== artifact.socialEpisode.domainId ||
    checkpoint.executionPrefix.schedulerMode !== artifact.socialEpisode.schedulerMode
  ) {
    throw new Error("Harness checkpoint domain or scheduler does not match its canonical episode artifact.");
  }
  if ((checkpoint.source.experiment === undefined) !== (artifact.experiment === undefined)) {
    throw new Error("Harness checkpoint experiment provenance does not match its canonical episode artifact.");
  }
  if (
    checkpoint.source.experiment !== undefined &&
    artifact.experiment !== undefined &&
    hashStableState(checkpoint.source.experiment) !== hashStableState(artifact.experiment)
  ) {
    throw new Error("Harness checkpoint experiment provenance does not match its canonical episode artifact.");
  }
}

export function assertRunId(runId: string): void {
  if (typeof runId !== "string" || !runId.trim() || runId.length > 1024 || runId.includes("\0")) {
    throw new Error("Episode artifact runId must be a nonempty bounded string.");
  }
}

export function assertCheckpointId(checkpointId: string): void {
  if (
    typeof checkpointId !== "string" ||
    !checkpointId.trim() ||
    checkpointId.length > 1024 ||
    checkpointId.includes("\0")
  ) {
    throw new Error("Harness checkpoint id must be a nonempty bounded string.");
  }
}

export function directoryKeyForRunId(runId: string): string {
  assertRunId(runId);
  return sha256(runId);
}

export function directoryKeyForCheckpointId(checkpointId: string): string {
  assertCheckpointId(checkpointId);
  return sha256(checkpointId);
}

export function compareEntries(left: HarnessEpisodeStoreEntry, right: HarnessEpisodeStoreEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId);
}

export function compareCheckpointEntries(
  left: HarnessEpisodeCheckpointStoreEntry,
  right: HarnessEpisodeCheckpointStoreEntry
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.checkpointId.localeCompare(right.checkpointId);
}

export function cloneEntry(entry: HarnessEpisodeStoreEntry): HarnessEpisodeStoreEntry {
  return { ...entry };
}

export function cloneCheckpointEntry(entry: HarnessEpisodeCheckpointStoreEntry): HarnessEpisodeCheckpointStoreEntry {
  return { ...entry };
}

export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function jsonLines(values: readonly unknown[]): string {
  return values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}

export function parseJsonLines(text: string): unknown[] {
  if (!text) return [];
  if (!text.endsWith("\n")) throw new Error("Stored JSONL must end with a newline.");
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => !line)) throw new Error("Stored JSONL contains an empty row.");
  return lines.map((line) => JSON.parse(line) as unknown);
}

export function jsonClone<T>(value: T, message: string): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error(message);
    return JSON.parse(serialized) as T;
  } catch {
    throw new Error(message);
  }
}

export function assertJsonData(value: unknown, message: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(message);
    return;
  }
  if (typeof value !== "object") throw new Error(message);
  if (seen.has(value)) throw new Error(message);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonData(item, message, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
    for (const item of Object.values(value as Record<string, unknown>)) {
      if (item === undefined) throw new Error(message);
      assertJsonData(item, message, seen);
    }
  }
  seen.delete(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isStrictlyInside(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && DIRECTORY_KEY_PATTERN.test(value);
}

export function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function isMissing(error: unknown): boolean {
  return isNotFound(error);
}

export function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

export async function waitForStoreLease(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(STORE_LEASE_ACQUIRED_MARKER)) finish(resolve);
    };
    const onStderr = (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_024); };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(() => reject(new Error(
      `Episode artifact store lease failed before acquisition (code=${code}, signal=${signal}${stderr ? `, detail=${stderr.trim()}` : ""}).`
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

export async function releaseStoreLease(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.stdin.end();
  await exited;
}
