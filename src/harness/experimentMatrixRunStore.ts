import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  validateGenericExperimentMatrixAuthoritySpec,
  type GenericExperimentMatrixAuthoritySpecV1,
  type GenericExperimentMatrixCellLifecycle
} from "./experimentMatrixRunner";
import { hashStableJsonValue } from "./hash";

export const HARNESS_EXPERIMENT_MATRIX_RUN_RECORD_VERSION = "harness.experiment-matrix-run-record.v1";
export const HARNESS_EXPERIMENT_MATRIX_RUN_MANIFEST_VERSION = "harness.experiment-matrix-run-manifest.v1";

const MATRICES_DIRECTORY = "matrices";
const LOCKS_DIRECTORY = "locks";
const REVISIONS_DIRECTORY = "revisions";
const RECORD_FILE = "record.json";
const MANIFEST_FILE = "manifest.json";
const DIRECTORY_KEY_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_DIRECTORY_PATTERN = /^\d{12}$/;
const MATRIX_LEASE_ACQUIRED_MARKER = "HARNESS_MATRIX_LEASE_ACQUIRED\n";

class MatrixRevisionCasConflict extends Error {
  constructor(readonly revision: number) {
    super(`Experiment matrix revision ${revision} lost its canonical CAS slot.`);
    this.name = "MatrixRevisionCasConflict";
  }
}

export interface HarnessExperimentMatrixCurrentCellV1 {
  phase: "started";
  index: number;
  id: string;
  label: string;
  group: string;
  executionId: string;
  childRunSetId: string;
  startedAt: string;
  updatedAt: string;
}

export interface HarnessExperimentMatrixCellReferenceV1 {
  index: number;
  id: string;
  label: string;
  group: string;
  executionId: string;
  status: GenericExperimentMatrixCellLifecycle;
  childRunSetId: string;
  childRunSetSha256: string;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
}

export interface HarnessExperimentMatrixRunRecordV1 {
  schemaVersion: typeof HARNESS_EXPERIMENT_MATRIX_RUN_RECORD_VERSION;
  kind: "experiment-matrix-run-record";
  state: "active" | "finalized";
  matrixId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  authorityHash: string;
  authority: GenericExperimentMatrixAuthoritySpecV1;
  cellsRequested: number;
  cellsCompleted: number;
  cellsTruncated: number;
  cellsFailed: number;
  cellsInFlight: 0 | 1;
  cellsUnstarted: number;
  cells: HarnessExperimentMatrixCellReferenceV1[];
  currentCell?: HarnessExperimentMatrixCurrentCellV1;
}

export interface HarnessExperimentMatrixRunManifestV1 {
  schemaVersion: typeof HARNESS_EXPERIMENT_MATRIX_RUN_MANIFEST_VERSION;
  kind: "experiment-matrix-run-manifest";
  matrixId: string;
  directoryKey: string;
  revision: number;
  state: HarnessExperimentMatrixRunRecordV1["state"];
  recordSha256: string;
  files: { record: typeof RECORD_FILE; manifest: typeof MANIFEST_FILE };
}

export interface HarnessExperimentMatrixRunResume {
  disposition: "created" | "active" | "finalized";
  revision: number;
  record: HarnessExperimentMatrixRunRecordV1;
}

export interface GenericExperimentMatrixFinalizedChildV1 {
  runSetId: string;
  status: GenericExperimentMatrixCellLifecycle;
  completedAt: string;
  canonicalHash: string;
}

export interface ExperimentMatrixChildRunAuthority {
  /** Returns only reviewed finalized identity; active/missing children are not adoptable. */
  getFinalized(runSetId: string): Promise<GenericExperimentMatrixFinalizedChildV1 | undefined>;
}

export interface HarnessExperimentMatrixRunStoreOptions {
  baseDirectory: string;
  childRunStore: ExperimentMatrixChildRunAuthority;
  now?: () => string;
}

/**
 * Parent-level matrix lifecycle authority. Child run-sets remain the canonical
 * episode authorities, but they cannot create matrix membership: this store
 * adopts only finalized child records into one immutable, ordered parent log.
 */
export class HarnessExperimentMatrixRunStore {
  private readonly root: string;
  private readonly matricesDirectory: string;
  private readonly locksDirectory: string;
  private readonly childRunStore: ExperimentMatrixChildRunAuthority;
  private readonly now: () => string;
  private readonly mutating = new Set<string>();

  private constructor(options: HarnessExperimentMatrixRunStoreOptions) {
    if (!options.baseDirectory.trim()) throw new Error("Experiment matrix run store baseDirectory is required.");
    if (!options.childRunStore || typeof options.childRunStore.getFinalized !== "function") {
      throw new Error("Experiment matrix run store requires canonical child run authority.");
    }
    this.root = path.resolve(options.baseDirectory);
    this.matricesDirectory = path.join(this.root, MATRICES_DIRECTORY);
    this.locksDirectory = path.join(this.root, LOCKS_DIRECTORY);
    this.childRunStore = options.childRunStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  static async open(options: HarnessExperimentMatrixRunStoreOptions): Promise<HarnessExperimentMatrixRunStore> {
    const store = new HarnessExperimentMatrixRunStore(options);
    await store.initialize();
    return store;
  }

  async withMatrixLease<TResult>(matrixId: string, operation: () => Promise<TResult>): Promise<TResult> {
    assertIdentifier(matrixId, "matrixId");
    const lease = await this.acquireLease(matrixId);
    try {
      return await operation();
    } finally {
      await releaseLease(lease);
    }
  }

  async beginOrResume(input: {
    matrixId: string;
    authority: GenericExperimentMatrixAuthoritySpecV1;
    createdAt?: string;
  }): Promise<HarnessExperimentMatrixRunResume> {
    assertIdentifier(input.matrixId, "matrixId");
    const authority = structuredClone(input.authority);
    validateGenericExperimentMatrixAuthoritySpec(authority);
    if (authority.id !== input.matrixId) throw new Error("Experiment matrix id does not match its durable identity.");
    const authorityHash = hashStableJsonValue(authority);
    const loaded = await this.load(input.matrixId);
    if (loaded) {
      if (loaded.record.authorityHash !== authorityHash || hashStableJsonValue(loaded.record.authority) !== authorityHash) {
        throw new Error("Experiment matrix resume provenance conflicts with durable authority.");
      }
      if (input.createdAt !== undefined && input.createdAt !== loaded.record.createdAt) {
        throw new Error("Experiment matrix resume createdAt conflicts with durable authority.");
      }
      return {
        disposition: loaded.record.state === "finalized" ? "finalized" : "active",
        revision: loaded.revision,
        record: structuredClone(loaded.record)
      };
    }

    const createdAt = input.createdAt ?? this.now();
    assertTimestamp(createdAt, "createdAt");
    const record: HarnessExperimentMatrixRunRecordV1 = {
      schemaVersion: HARNESS_EXPERIMENT_MATRIX_RUN_RECORD_VERSION,
      kind: "experiment-matrix-run-record",
      state: "active",
      matrixId: input.matrixId,
      createdAt,
      updatedAt: createdAt,
      authorityHash,
      authority,
      cellsRequested: authority.cells.length,
      cellsCompleted: 0,
      cellsTruncated: 0,
      cellsFailed: 0,
      cellsInFlight: 0,
      cellsUnstarted: authority.cells.length,
      cells: []
    };
    assertRecord(record);
    const directoryKey = directoryKeyForMatrixId(input.matrixId);
    const finalDirectory = path.join(this.matricesDirectory, directoryKey);
    const temporaryDirectory = path.join(this.matricesDirectory, `.tmp-${randomUUID()}`);
    await mkdir(path.join(temporaryDirectory, REVISIONS_DIRECTORY), { recursive: true });
    try {
      await this.writeRevision(path.join(temporaryDirectory, REVISIONS_DIRECTORY), directoryKey, 1, record);
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      const winner = await this.load(input.matrixId);
      if (!winner) throw error;
      if (winner.record.authorityHash !== authorityHash) {
        throw new Error("Experiment matrix resume provenance conflicts with concurrently published authority.");
      }
      return {
        disposition: winner.record.state === "finalized" ? "finalized" : "active",
        revision: winner.revision,
        record: structuredClone(winner.record)
      };
    }
    return { disposition: "created", revision: 1, record: structuredClone(record) };
  }

  async startCell(input: { matrixId: string; index: number; startedAt?: string }): Promise<HarnessExperimentMatrixRunRecordV1> {
    return this.mutate(input.matrixId, async (loaded) => {
      const record = requireActive(loaded.record);
      const expected = record.authority.cells[record.cells.length];
      if (!expected || input.index !== record.cells.length) {
        throw new Error("Experiment matrix cell start does not match the next durable schedule slot.");
      }
      if (record.currentCell) {
        if (record.currentCell.index === input.index) return { record, write: false };
        throw new Error("Experiment matrix already has a different cell in flight.");
      }
      const startedAt = input.startedAt ?? this.now();
      assertTimestamp(startedAt, "startedAt");
      const currentCell = currentCellFor(record.matrixId, expected, input.index, startedAt);
      const next: HarnessExperimentMatrixRunRecordV1 = {
        ...structuredClone(record),
        updatedAt: monotonicTimestamp(startedAt, record.updatedAt),
        cellsInFlight: 1,
        cellsUnstarted: record.cellsUnstarted - 1,
        currentCell
      };
      return { record: next, write: true };
    });
  }

  async adoptCurrentCell(matrixId: string): Promise<HarnessExperimentMatrixRunRecordV1> {
    return this.mutate(matrixId, async (loaded) => {
      const record = requireActive(loaded.record);
      if (!record.currentCell) throw new Error("Experiment matrix has no started cell to adopt.");
      const current = record.currentCell;
      const child = await this.requireFinalizedChild(current.childRunSetId);
      const completedAt = monotonicTimestamp(child.completedAt, current.startedAt);
      const reference: HarnessExperimentMatrixCellReferenceV1 = {
        index: current.index,
        id: current.id,
        label: current.label,
        group: current.group,
        executionId: current.executionId,
        status: child.status,
        childRunSetId: current.childRunSetId,
        childRunSetSha256: child.canonicalHash,
        startedAt: current.startedAt,
        completedAt,
        elapsedMs: Math.max(0, Date.parse(completedAt) - Date.parse(current.startedAt))
      };
      const cells = [...record.cells, reference];
      const counts = lifecycleCounts(cells);
      const next: HarnessExperimentMatrixRunRecordV1 = {
        ...structuredClone(record),
        updatedAt: monotonicTimestamp(this.now(), monotonicTimestamp(completedAt, record.updatedAt)),
        cellsCompleted: counts.completed,
        cellsTruncated: counts.truncated,
        cellsFailed: counts.failed,
        cellsInFlight: 0,
        cells,
        currentCell: undefined
      };
      delete next.currentCell;
      return { record: next, write: true };
    });
  }

  async finalize(matrixId: string, completedAt?: string): Promise<HarnessExperimentMatrixRunRecordV1> {
    return this.mutate(matrixId, async (loaded) => {
      const record = loaded.record;
      if (record.state === "finalized") return { record, write: false };
      if (record.currentCell) throw new Error("Experiment matrix cannot finalize while a cell is in flight.");
      const finalAt = completedAt ?? this.now();
      assertTimestamp(finalAt, "completedAt");
      const stableCompletedAt = monotonicTimestamp(finalAt, record.updatedAt);
      const next: HarnessExperimentMatrixRunRecordV1 = {
        ...structuredClone(record),
        state: "finalized",
        updatedAt: stableCompletedAt,
        completedAt: stableCompletedAt
      };
      return { record: next, write: true };
    });
  }

  async get(matrixId: string): Promise<HarnessExperimentMatrixRunRecordV1 | undefined> {
    const loaded = await this.load(matrixId);
    return loaded ? structuredClone(loaded.record) : undefined;
  }

  private async mutate(
    matrixId: string,
    operation: (loaded: LoadedMatrix) => Promise<{ record: HarnessExperimentMatrixRunRecordV1; write: boolean }>
  ): Promise<HarnessExperimentMatrixRunRecordV1> {
    if (this.mutating.has(matrixId)) throw new Error("Experiment matrix mutation is already in progress.");
    this.mutating.add(matrixId);
    try {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const loaded = await this.load(matrixId);
        if (!loaded) throw new Error("Experiment matrix must begin before it can mutate.");
        const result = await operation(loaded);
        assertRecord(result.record);
        if (!result.write) return structuredClone(result.record);
        const revisionsDirectory = path.join(this.matricesDirectory, loaded.directoryKey, REVISIONS_DIRECTORY);
        await assertDirectoryInside(path.join(this.matricesDirectory, loaded.directoryKey), revisionsDirectory, "Experiment matrix revisions directory is not safe.");
        try {
          await this.writeRevision(revisionsDirectory, loaded.directoryKey, loaded.revision + 1, result.record);
        } catch (error) {
          if (error instanceof MatrixRevisionCasConflict) continue;
          throw error;
        }
        return structuredClone(result.record);
      }
      throw new Error("Experiment matrix mutation exceeded the revision CAS retry limit.");
    } finally {
      this.mutating.delete(matrixId);
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await assertDirectory(this.root, "Experiment matrix store root is not a safe directory.");
    await mkdir(this.matricesDirectory, { recursive: true });
    await assertDirectoryInside(this.root, this.matricesDirectory, "Experiment matrix records directory is not safe.");
    await mkdir(this.locksDirectory, { recursive: true });
    await assertDirectoryInside(this.root, this.locksDirectory, "Experiment matrix locks directory is not safe.");
    for (const child of await readdir(this.matricesDirectory, { withFileTypes: true })) {
      if (!DIRECTORY_KEY_PATTERN.test(child.name)) continue;
      if (!child.isDirectory() || child.isSymbolicLink()) throw new Error("Stored experiment matrix path is not a safe directory.");
      await this.loadDirectory(child.name);
    }
  }

  private async load(matrixId: string): Promise<LoadedMatrix | undefined> {
    assertIdentifier(matrixId, "matrixId");
    const directoryKey = directoryKeyForMatrixId(matrixId);
    try {
      const stat = await lstat(path.join(this.matricesDirectory, directoryKey));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Stored experiment matrix path is not a safe directory.");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    return this.loadDirectory(directoryKey, matrixId);
  }

  private async loadDirectory(directoryKey: string, expectedMatrixId?: string): Promise<LoadedMatrix> {
    if (!DIRECTORY_KEY_PATTERN.test(directoryKey)) throw new Error("Stored experiment matrix directory key is invalid.");
    const matrixDirectory = path.join(this.matricesDirectory, directoryKey);
    const revisionsDirectory = path.join(matrixDirectory, REVISIONS_DIRECTORY);
    await assertDirectoryInside(this.matricesDirectory, matrixDirectory, "Stored experiment matrix directory is not safe.");
    await assertDirectoryInside(matrixDirectory, revisionsDirectory, "Stored experiment matrix revisions directory is not safe.");
    const revisionEntries = await readdir(revisionsDirectory, { withFileTypes: true });
    for (const child of revisionEntries) {
      if (REVISION_DIRECTORY_PATTERN.test(child.name) && (!child.isDirectory() || child.isSymbolicLink())) {
        throw new Error("Stored experiment matrix revision path is not a safe directory.");
      }
    }
    const children = revisionEntries
      .filter((child) => child.isDirectory() && !child.isSymbolicLink() && REVISION_DIRECTORY_PATTERN.test(child.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!children.length) throw new Error("Stored experiment matrix has no canonical revision.");
    let previous: HarnessExperimentMatrixRunRecordV1 | undefined;
    let latest: LoadedMatrix | undefined;
    for (const [position, child] of children.entries()) {
      const revision = Number(child.name);
      if (revision !== position + 1) throw new Error("Experiment matrix revisions must be contiguous and ordered.");
      const revisionDirectory = path.join(revisionsDirectory, child.name);
      await assertDirectoryInside(revisionsDirectory, revisionDirectory, "Stored experiment matrix revision is not safe.");
      const recordText = await readSafeFile(revisionDirectory, RECORD_FILE);
      const manifestText = await readSafeFile(revisionDirectory, MANIFEST_FILE);
      const record = JSON.parse(recordText) as HarnessExperimentMatrixRunRecordV1;
      const manifest = JSON.parse(manifestText) as HarnessExperimentMatrixRunManifestV1;
      assertRecord(record);
      assertManifest(manifest, record, directoryKey, revision, recordText);
      if (expectedMatrixId && record.matrixId !== expectedMatrixId) throw new Error("Stored experiment matrix identity does not match its directory.");
      if (directoryKeyForMatrixId(record.matrixId) !== directoryKey) throw new Error("Stored experiment matrix directory key does not match matrixId.");
      if (position === 0) {
        if (record.state !== "active" || record.cells.length || record.currentCell) {
          throw new Error("First experiment matrix revision must be an empty active header.");
        }
      } else {
        assertRevisionTransition(previous!, record);
      }
      await this.assertChildReferences(record);
      previous = record;
      latest = { record, revision, directoryKey };
    }
    return latest!;
  }

  private async assertChildReferences(record: HarnessExperimentMatrixRunRecordV1): Promise<void> {
    for (const reference of record.cells) {
      const child = await this.requireFinalizedChild(reference.childRunSetId);
      if (child.canonicalHash !== reference.childRunSetSha256) {
        throw new Error(`Stored matrix child ${reference.childRunSetId} digest mismatch.`);
      }
      if (child.status !== reference.status) {
        throw new Error(`Stored matrix child ${reference.childRunSetId} lifecycle mismatch.`);
      }
    }
  }

  private async requireFinalizedChild(runSetId: string): Promise<GenericExperimentMatrixFinalizedChildV1> {
    const child = await this.childRunStore.getFinalized(runSetId);
    if (!child) throw new Error(`Canonical matrix child ${runSetId} is missing.`);
    if (child.runSetId !== runSetId) throw new Error(`Canonical matrix child ${runSetId} identity is invalid.`);
    if (child.status !== "completed" && child.status !== "truncated" && child.status !== "failed") {
      throw new Error(`Canonical matrix child ${runSetId} lifecycle is invalid.`);
    }
    assertTimestamp(child.completedAt, "child.completedAt");
    if (!DIRECTORY_KEY_PATTERN.test(child.canonicalHash)) throw new Error(`Canonical matrix child ${runSetId} digest is invalid.`);
    return child;
  }

  private async writeRevision(
    revisionsDirectory: string,
    directoryKey: string,
    revision: number,
    record: HarnessExperimentMatrixRunRecordV1
  ): Promise<void> {
    const recordText = jsonDocument(record);
    const recordSha256 = sha256(recordText);
    const revisionName = String(revision).padStart(12, "0");
    const finalDirectory = path.join(revisionsDirectory, revisionName);
    const temporaryDirectory = path.join(revisionsDirectory, `.tmp-${randomUUID()}`);
    try {
      await assertPathMissing(finalDirectory, "Experiment matrix revision CAS slot already exists.");
      await mkdir(temporaryDirectory, { recursive: false });
      const manifest: HarnessExperimentMatrixRunManifestV1 = {
        schemaVersion: HARNESS_EXPERIMENT_MATRIX_RUN_MANIFEST_VERSION,
        kind: "experiment-matrix-run-manifest",
        matrixId: record.matrixId,
        directoryKey,
        revision,
        state: record.state,
        recordSha256,
        files: { record: RECORD_FILE, manifest: MANIFEST_FILE }
      };
      await writeFile(path.join(temporaryDirectory, RECORD_FILE), recordText, { encoding: "utf8", flag: "wx" });
      await writeFile(path.join(temporaryDirectory, MANIFEST_FILE), jsonDocument(manifest), { encoding: "utf8", flag: "wx" });
      await rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      try {
        await lstat(finalDirectory);
        throw new MatrixRevisionCasConflict(revision);
      } catch (publishedError) {
        if (publishedError instanceof MatrixRevisionCasConflict) throw publishedError;
        if (!isMissing(publishedError)) throw publishedError;
      }
      throw error;
    }
  }

  private async acquireLease(matrixId: string): Promise<ChildProcessWithoutNullStreams> {
    const lockDirectory = path.join(this.locksDirectory, `${directoryKeyForMatrixId(matrixId)}.lock`);
    try {
      await mkdir(lockDirectory, { recursive: false });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertDirectoryInside(this.locksDirectory, lockDirectory, "Experiment matrix lease path is not safe.");
    const child = spawn(
      "/usr/bin/flock",
      ["--exclusive", "--nonblock", lockDirectory, "/bin/sh", "-c", `printf '${MATRIX_LEASE_ACQUIRED_MARKER}'; cat >/dev/null`],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    try {
      await waitForLease(child, matrixId);
      return child;
    } catch (error) {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      throw error;
    }
  }
}

interface LoadedMatrix {
  record: HarnessExperimentMatrixRunRecordV1;
  revision: number;
  directoryKey: string;
}

function currentCellFor(
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

function lifecycleCounts(cells: HarnessExperimentMatrixCellReferenceV1[]): { completed: number; truncated: number; failed: number } {
  return {
    completed: cells.filter((cell) => cell.status === "completed").length,
    truncated: cells.filter((cell) => cell.status === "truncated").length,
    failed: cells.filter((cell) => cell.status === "failed").length
  };
}

function requireActive(record: HarnessExperimentMatrixRunRecordV1): HarnessExperimentMatrixRunRecordV1 {
  if (record.state !== "active") throw new Error("Finalized experiment matrix cannot mutate cell progress.");
  return record;
}

function assertRecord(record: HarnessExperimentMatrixRunRecordV1): void {
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

function assertCellReference(record: HarnessExperimentMatrixRunRecordV1, reference: HarnessExperimentMatrixCellReferenceV1, index: number): void {
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

function assertCurrentCell(record: HarnessExperimentMatrixRunRecordV1, current: HarnessExperimentMatrixCurrentCellV1): void {
  assertExactKeys(current, [
    "phase", "index", "id", "label", "group", "executionId", "childRunSetId", "startedAt", "updatedAt"
  ], "Experiment matrix current cell");
  const expected = record.authority.cells[record.cells.length]!;
  const identity = currentCellFor(record.matrixId, expected, record.cells.length, current.startedAt);
  if (hashStableJsonValue(current) !== hashStableJsonValue(identity)) throw new Error("Experiment matrix current cell conflicts with its ordered spec.");
}

function assertRevisionTransition(previous: HarnessExperimentMatrixRunRecordV1, current: HarnessExperimentMatrixRunRecordV1): void {
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

function assertManifest(
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

function directoryKeyForMatrixId(matrixId: string): string {
  return createHash("sha256").update(matrixId).digest("hex");
}

function monotonicTimestamp(candidate: string, previous: string): string {
  assertTimestamp(candidate, "timestamp");
  return Date.parse(candidate) < Date.parse(previous) ? previous : candidate;
}

function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || value.includes("\0")) throw new Error(`${label} is invalid.`);
}

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} contains unsupported field ${key}.`);
  }
}

async function readSafeFile(directory: string, fileName: string): Promise<string> {
  await assertDirectory(directory, "Experiment matrix revision is not a safe directory.");
  const handle = await open(path.join(directory, fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Experiment matrix revision member is not a regular file.");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function assertDirectory(directory: string, message: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
}

async function assertDirectoryInside(parent: string, directory: string, message: string): Promise<void> {
  await assertDirectory(parent, message);
  await assertDirectory(directory, message);
  const parentReal = await realpath(parent);
  const directoryReal = await realpath(directory);
  if (directoryReal !== parentReal && !directoryReal.startsWith(`${parentReal}${path.sep}`)) throw new Error(message);
}

async function assertPathMissing(target: string, message: string): Promise<void> {
  try {
    await lstat(target);
    throw new Error(message);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && ["EEXIST", "ENOTEMPTY"].includes((error as { code?: string }).code ?? ""));
}

async function waitForLease(child: ChildProcessWithoutNullStreams, matrixId: string): Promise<void> {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const finish = (callback: () => void) => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    const onStdout = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(MATRIX_LEASE_ACQUIRED_MARKER)) finish(resolve);
    };
    const onStderr = (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1024); };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(() => reject(new Error(
      code === 1
        ? `Experiment matrix ${matrixId} is already active in another process.`
        : `Experiment matrix lease failed before acquisition (code=${code}, signal=${signal}${stderr ? `, detail=${stderr.trim()}` : ""}).`
    )));
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function releaseLease(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.stdin.end();
  await exited;
}
