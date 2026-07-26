import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  validateGenericExperimentMatrixAuthoritySpec,
  type GenericExperimentMatrixAuthoritySpecV1
} from "../experimentMatrixRunner";
import { hashStableJsonValue } from "../hash";
import {
  DIRECTORY_KEY_PATTERN,
  HARNESS_EXPERIMENT_MATRIX_RUN_MANIFEST_VERSION,
  HARNESS_EXPERIMENT_MATRIX_RUN_RECORD_VERSION,
  LOCKS_DIRECTORY,
  MANIFEST_FILE,
  MATRICES_DIRECTORY,
  MATRIX_LEASE_ACQUIRED_MARKER,
  RECORD_FILE,
  REVISIONS_DIRECTORY,
  REVISION_DIRECTORY_PATTERN,
  type ExperimentMatrixChildRunAuthority,
  type GenericExperimentMatrixFinalizedChildV1,
  type HarnessExperimentMatrixCellReferenceV1,
  type HarnessExperimentMatrixRunManifestV1,
  type HarnessExperimentMatrixRunRecordV1,
  type HarnessExperimentMatrixRunResume,
  type HarnessExperimentMatrixRunStoreOptions
} from "./types";
import {
  assertIdentifier,
  assertManifest,
  assertRecord,
  assertRevisionTransition,
  assertTimestamp,
  currentCellFor,
  directoryKeyForMatrixId,
  jsonDocument,
  lifecycleCounts,
  monotonicTimestamp,
  requireActive,
  sha256,
  type LoadedMatrix
} from "./validation";
import {
  assertDirectory,
  assertDirectoryInside,
  assertPathMissing,
  isAlreadyExists,
  isMissing,
  readSafeFile,
  releaseLease,
  waitForLease
} from "./fsSupport";

class MatrixRevisionCasConflict extends Error {
  constructor(readonly revision: number) {
    super(`Experiment matrix revision ${revision} lost its canonical CAS slot.`);
    this.name = "MatrixRevisionCasConflict";
  }
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
