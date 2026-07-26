import { createHash } from "node:crypto";
import {
  validateGenericExperimentMatrixAuthoritySpec,
  type GenericExperimentMatrixAuthoritySpecV1
} from "../experimentMatrixRunner";
import { hashStableJsonValue } from "../hash";
import {
  DIRECTORY_KEY_PATTERN,
  HARNESS_EXPERIMENT_MATRIX_RUN_MANIFEST_VERSION,
  HARNESS_EXPERIMENT_MATRIX_RUN_RECORD_VERSION,
  MANIFEST_FILE,
  RECORD_FILE,
  type HarnessExperimentMatrixCellReferenceV1,
  type HarnessExperimentMatrixCurrentCellV1,
  type HarnessExperimentMatrixRunManifestV1,
  type HarnessExperimentMatrixRunRecordV1
} from "./types";

export interface LoadedMatrix {
  record: HarnessExperimentMatrixRunRecordV1;
  revision: number;
  directoryKey: string;
}

export function currentCellFor(
  matrixId: string,
  cell: GenericExperimentMatrixAuthoritySpecV1["cells"][number],
  index: number,
  startedAt: string
): HarnessExperimentMatrixCurrentCellV1 {
  return {
    phase: "started",
    index,
    id: cell.id,
    label: cell.label,
    group: cell.group,
    executionId: `${matrixId}:cell:${cell.id}:${index}`,
    childRunSetId: `${matrixId}:${cell.id}`,
    startedAt,
    updatedAt: startedAt
  };
}

export function lifecycleCounts(cells: HarnessExperimentMatrixCellReferenceV1[]): { completed: number; truncated: number; failed: number } {
  return {
    completed: cells.filter((cell) => cell.status === "completed").length,
    truncated: cells.filter((cell) => cell.status === "truncated").length,
    failed: cells.filter((cell) => cell.status === "failed").length
  };
}

export function requireActive(record: HarnessExperimentMatrixRunRecordV1): HarnessExperimentMatrixRunRecordV1 {
  if (record.state !== "active") throw new Error("Finalized experiment matrix cannot mutate cell progress.");
  return record;
}

export function assertRecord(record: HarnessExperimentMatrixRunRecordV1): void {
  assertExactKeys(record, [
    "schemaVersion", "kind", "state", "matrixId", "createdAt", "updatedAt", "completedAt",
    "authorityHash", "authority", "cellsRequested", "cellsCompleted", "cellsTruncated", "cellsFailed",
    "cellsInFlight", "cellsUnstarted", "cells", "currentCell"
  ], "Experiment matrix run record");
  if (record.schemaVersion !== HARNESS_EXPERIMENT_MATRIX_RUN_RECORD_VERSION || record.kind !== "experiment-matrix-run-record") {
    throw new Error("Experiment matrix run record version or kind is invalid.");
  }
  assertIdentifier(record.matrixId, "matrixId");
  assertTimestamp(record.createdAt, "createdAt");
  assertTimestamp(record.updatedAt, "updatedAt");
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) throw new Error("Experiment matrix updatedAt moved backwards.");
  validateGenericExperimentMatrixAuthoritySpec(record.authority);
  if (record.authority.id !== record.matrixId || record.authorityHash !== hashStableJsonValue(record.authority)) {
    throw new Error("Experiment matrix provenance hash is invalid.");
  }
  if (record.state !== "active" && record.state !== "finalized") throw new Error("Experiment matrix state is invalid.");
  if (record.state === "finalized") {
    if (!record.completedAt) throw new Error("Finalized experiment matrix is missing completedAt.");
    assertTimestamp(record.completedAt, "completedAt");
    if (record.completedAt !== record.updatedAt) throw new Error("Finalized experiment matrix completedAt must match updatedAt.");
  } else if (record.completedAt !== undefined) {
    throw new Error("Active experiment matrix cannot have completedAt.");
  }
  if (record.cellsRequested !== record.authority.cells.length) throw new Error("Experiment matrix requested count does not match its spec.");
  const counts = [record.cellsRequested, record.cellsCompleted, record.cellsTruncated, record.cellsFailed, record.cellsUnstarted];
  if (counts.some((value) => !Number.isInteger(value) || value < 0)) throw new Error("Experiment matrix counts must be non-negative integers.");
  if (record.cellsInFlight !== 0 && record.cellsInFlight !== 1) throw new Error("Experiment matrix in-flight count is invalid.");
  if ((record.currentCell === undefined) !== (record.cellsInFlight === 0)) throw new Error("Experiment matrix current cell does not match in-flight count.");
  if (record.state === "finalized" && record.currentCell) throw new Error("Finalized experiment matrix cannot retain a current cell.");
  if (record.cellsCompleted + record.cellsTruncated + record.cellsFailed + record.cellsInFlight + record.cellsUnstarted !== record.cellsRequested) {
    throw new Error("Experiment matrix lifecycle counts do not cover its schedule.");
  }
  if (record.cells.length !== record.cellsRequested - record.cellsUnstarted - record.cellsInFlight) {
    throw new Error("Experiment matrix settled cell count is invalid.");
  }
  const actual = lifecycleCounts(record.cells);
  if (actual.completed !== record.cellsCompleted || actual.truncated !== record.cellsTruncated || actual.failed !== record.cellsFailed) {
    throw new Error("Experiment matrix lifecycle counts do not match cell references.");
  }
  for (const [index, reference] of record.cells.entries()) assertCellReference(record, reference, index);
  if (record.cells.some((reference) => Date.parse(reference.completedAt) > Date.parse(record.updatedAt))) {
    throw new Error("Experiment matrix record predates a completed child reference.");
  }
  if (record.currentCell) assertCurrentCell(record, record.currentCell);
}

export function assertCellReference(record: HarnessExperimentMatrixRunRecordV1, reference: HarnessExperimentMatrixCellReferenceV1, index: number): void {
  assertExactKeys(reference, [
    "index", "id", "label", "group", "executionId", "status", "childRunSetId", "childRunSetSha256",
    "startedAt", "completedAt", "elapsedMs"
  ], `Experiment matrix cell reference ${index}`);
  const expected = record.authority.cells[index]!;
  const identity = currentCellFor(record.matrixId, expected, index, reference.startedAt);
  if (
    reference.index !== index || reference.id !== identity.id || reference.label !== identity.label || reference.group !== identity.group ||
    reference.executionId !== identity.executionId || reference.childRunSetId !== identity.childRunSetId
  ) throw new Error("Experiment matrix cell reference conflicts with its ordered spec.");
  if (!DIRECTORY_KEY_PATTERN.test(reference.childRunSetSha256)) throw new Error("Experiment matrix child digest is invalid.");
  assertTimestamp(reference.startedAt, "cell.startedAt");
  assertTimestamp(reference.completedAt, "cell.completedAt");
  const elapsed = Date.parse(reference.completedAt) - Date.parse(reference.startedAt);
  if (!Number.isInteger(reference.elapsedMs) || reference.elapsedMs < 0 || reference.elapsedMs !== Math.max(0, elapsed)) {
    throw new Error("Experiment matrix cell elapsedMs is invalid.");
  }
}

export function assertCurrentCell(record: HarnessExperimentMatrixRunRecordV1, current: HarnessExperimentMatrixCurrentCellV1): void {
  assertExactKeys(current, [
    "phase", "index", "id", "label", "group", "executionId", "childRunSetId", "startedAt", "updatedAt"
  ], "Experiment matrix current cell");
  const expected = record.authority.cells[record.cells.length]!;
  const identity = currentCellFor(record.matrixId, expected, record.cells.length, current.startedAt);
  if (hashStableJsonValue(current) !== hashStableJsonValue(identity)) throw new Error("Experiment matrix current cell conflicts with its ordered spec.");
}

export function assertRevisionTransition(previous: HarnessExperimentMatrixRunRecordV1, current: HarnessExperimentMatrixRunRecordV1): void {
  if (
    current.matrixId !== previous.matrixId || current.createdAt !== previous.createdAt || current.authorityHash !== previous.authorityHash ||
    hashStableJsonValue(current.authority) !== hashStableJsonValue(previous.authority)
  ) throw new Error("Experiment matrix revision changed immutable header authority.");
  if (previous.state === "finalized") throw new Error("Finalized experiment matrix cannot have a later revision.");
  if (Date.parse(current.updatedAt) < Date.parse(previous.updatedAt)) throw new Error("Experiment matrix revision updatedAt moved backwards.");
  for (const [index, cell] of previous.cells.entries()) {
    if (hashStableJsonValue(cell) !== hashStableJsonValue(current.cells[index])) {
      throw new Error("Experiment matrix revision changed durable cell history.");
    }
  }
  if (!previous.currentCell && current.currentCell && current.cells.length === previous.cells.length && current.state === "active") return;
  if (previous.currentCell && !current.currentCell && current.cells.length === previous.cells.length + 1 && current.state === "active") return;
  if (!previous.currentCell && !current.currentCell && current.cells.length === previous.cells.length && current.state === "finalized") return;
  throw new Error("Experiment matrix revision transition is invalid.");
}

export function assertManifest(
  manifest: HarnessExperimentMatrixRunManifestV1,
  record: HarnessExperimentMatrixRunRecordV1,
  directoryKey: string,
  revision: number,
  recordText: string
): void {
  assertExactKeys(manifest, [
    "schemaVersion", "kind", "matrixId", "directoryKey", "revision", "state", "recordSha256", "files"
  ], "Experiment matrix manifest");
  if (manifest.files && typeof manifest.files === "object") {
    assertExactKeys(manifest.files, ["record", "manifest"], "Experiment matrix manifest files");
  }
  if (
    manifest.schemaVersion !== HARNESS_EXPERIMENT_MATRIX_RUN_MANIFEST_VERSION || manifest.kind !== "experiment-matrix-run-manifest" ||
    manifest.matrixId !== record.matrixId || manifest.directoryKey !== directoryKey || manifest.revision !== revision ||
    manifest.state !== record.state || manifest.recordSha256 !== sha256(recordText) ||
    manifest.files?.record !== RECORD_FILE || manifest.files?.manifest !== MANIFEST_FILE
  ) throw new Error("Experiment matrix manifest does not match its canonical record.");
}

export function directoryKeyForMatrixId(matrixId: string): string {
  return createHash("sha256").update(matrixId).digest("hex");
}

export function monotonicTimestamp(candidate: string, previous: string): string {
  assertTimestamp(candidate, "timestamp");
  return Date.parse(candidate) < Date.parse(previous) ? previous : candidate;
}

export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || value.includes("\0")) throw new Error(`${label} is invalid.`);
}

export function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
}

export function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} contains unsupported field ${key}.`);
  }
}
