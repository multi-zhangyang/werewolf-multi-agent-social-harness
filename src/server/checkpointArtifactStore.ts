import path from "node:path";
import { isProviderFailureKind } from "../agents/schema";
import { HARNESS_CHECKPOINT_VERSION, type HarnessCheckpoint, assertValidHarnessCheckpoint } from "../harness/artifacts";
import { validateGenericForkProvenance } from "../harness/episodeArtifacts";
import { sanitizePersistedProviderDiagnostics } from "../harness/providerFailure";
import { redactSecrets } from "../harness/redaction";
import { type PublicProviderFailureSummary, publicProviderFailureFromUnknown } from "./apiFailure";
import {
  CHECKPOINT_ARTIFACT_DIR,
  CHECKPOINT_ARTIFACT_INDEX_FILE,
  CHECKPOINT_FORK_ATTEMPT_FILE,
  GENERATED_ARTIFACT_SET_ID_PATTERN,
  assertRegularFileInsideDirectory,
  ensureWritableArtifactSubdirectory,
  isFileReadNotFound,
  normalizeRequestedArtifactPath,
  resolveUnderDirectory
} from "./artifactFiles";
import { checkpointSourceMatchesForkProvenance } from "./checkpointDto";
import { HttpError } from "./httpValidation";
import { isRecord, stringField } from "./jsonUtil";
import {
  type ArtifactRecoveryReadResult,
  artifactRecoveryAuditMessageForCode,
  isSafeIsoTimestamp,
  loadArtifactRecoveryAuditSidecar,
  recordArtifactRecoveryAudit
} from "./recoveryAudit";
import {
  type StoredCheckpointForkAttempt,
  deleteCheckpointForkAttempt,
  getCheckpoint,
  getMatch,
  listCheckpointForkAttempts,
  listCheckpoints,
  registerServerStoreResetHook,
  saveCheckpoint,
  saveCheckpointForkAttempt
} from "./store";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

let checkpointForkAttemptWriteQueue: Promise<void> = Promise.resolve();

/**
 * One-time recovery memo per base directory. Disk state only diverges from
 * the in-memory store through out-of-process writes, which every fail-closed
 * recovery test exercises via a store clear + server restart; the hook below
 * drops the memo on clear so those flows still rescan the directory. All
 * in-process mutations write through saveCheckpoint()/saveCheckpointForkAttempt()
 * and stay coherent without a rescan.
 */
const checkpointIndexLoadsByRoot = new Map<string, Promise<void>>();
const checkpointForkAttemptLoadsByRoot = new Map<string, Promise<void>>();
registerServerStoreResetHook(() => {
  checkpointIndexLoadsByRoot.clear();
  checkpointForkAttemptLoadsByRoot.clear();
});

export async function persistCheckpointArtifact(checkpoint: HarnessCheckpoint, baseDir: string | undefined): Promise<void> {
  assertValidHarnessCheckpoint(checkpoint);
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  const file = checkpointArtifactAbsoluteFile(root, checkpoint.checkpointId);
  await ensureWritableArtifactSubdirectory(root, checkpointArtifactDirectory(root), "Checkpoint artifact directory is not safe.");
  await writeFile(file, `${JSON.stringify(sanitizePersistedProviderDiagnostics(redactSecrets(checkpoint)), null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
}

export async function loadCheckpointForkAttemptStore(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  let pending = checkpointForkAttemptLoadsByRoot.get(root);
  if (!pending) {
    pending = loadCheckpointForkAttemptStoreFromDisk(root).catch((error: unknown) => {
      checkpointForkAttemptLoadsByRoot.delete(root);
      throw error;
    });
    checkpointForkAttemptLoadsByRoot.set(root, pending);
  }
  await pending;
}

async function loadCheckpointForkAttemptStoreFromDisk(root: string): Promise<void> {
  const baseDir = root;
  let parsed: unknown;
  try {
    const target = checkpointForkAttemptPath(root);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new HttpError(500, "Checkpoint fork-attempt store is not a safe regular file.");
    }
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (isFileReadNotFound(error)) return;
    throw new HttpError(500, "Checkpoint fork-attempt store could not be read.");
  }
  if (
    !isRecord(parsed) ||
    parsed.artifactVersion !== "server.checkpoint-fork-attempt-store.v1" ||
    parsed.kind !== "checkpoint-fork-attempt-store" ||
    !Array.isArray(parsed.attempts)
  ) {
    throw new HttpError(500, "Checkpoint fork-attempt store has invalid shape.");
  }
  let rewriteAttemptStore = false;
  for (const value of parsed.attempts) {
    const parsedAttempt = parseStoredCheckpointForkAttempt(value);
    if (!parsedAttempt) throw new HttpError(500, "Checkpoint fork-attempt store contains an invalid record.");
    const checkpoint = getCheckpoint(parsedAttempt.forkOf.checkpointId);
    if (!checkpoint || !checkpointSourceMatchesForkProvenance(checkpoint, parsedAttempt.forkOf)) {
      throw new HttpError(500, "Checkpoint fork-attempt store contains inconsistent provenance.");
    }
    const activeAttempt = listCheckpointForkAttempts().find(
      (candidate) => candidate.childRunId === parsedAttempt.childRunId && candidate.status === "running"
    );
    const artifact = getMatch(parsedAttempt.childRunId)?.artifact;
    if (artifact) {
      deleteCheckpointForkAttempt(parsedAttempt.childRunId);
      rewriteAttemptStore = true;
      continue;
    }
    const attempt =
      parsedAttempt.status === "running" && !activeAttempt && !artifact
        ? {
            ...parsedAttempt,
            updatedAt: new Date().toISOString(),
            status: "failed" as const,
            elapsedMs: Math.max(0, Date.now() - Date.parse(parsedAttempt.createdAt)),
            timedOut: false,
            failureCode: "checkpoint_fork_interrupted",
            failureReason: "Checkpoint fork execution was interrupted before an artifact was recorded.",
            providerFailure: null
          }
        : parsedAttempt;
    if (attempt !== parsedAttempt) rewriteAttemptStore = true;
    saveCheckpointForkAttempt(attempt);
  }
  if (rewriteAttemptStore) await writeCheckpointForkAttemptStore(baseDir);
}

export async function writeCheckpointForkAttemptStore(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const write = async () => {
    const root = path.resolve(baseDir);
    await mkdir(root, { recursive: true });
    const target = checkpointForkAttemptPath(root);
    await assertWritableRegularFileTarget(target, "Checkpoint fork-attempt store is not a safe regular file.");
    const temporary = path.join(root, `.checkpoint-fork-attempts-${randomUUID()}.tmp`);
    const store = {
      artifactVersion: "server.checkpoint-fork-attempt-store.v1",
      kind: "checkpoint-fork-attempt-store",
      updatedAt: new Date().toISOString(),
      attempts: listCheckpointForkAttempts()
    };
    try {
      await writeFile(temporary, `${JSON.stringify(redactSecrets(store), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  const pending = checkpointForkAttemptWriteQueue.then(write, write);
  checkpointForkAttemptWriteQueue = pending.then(
    () => undefined,
    () => undefined
  );
  await pending;
}

export async function assertWritableRegularFileTarget(target: string, message: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(500, message);
  } catch (error) {
    if (isFileReadNotFound(error)) return;
    throw error;
  }
}

export function parseStoredCheckpointForkAttempt(value: unknown): StoredCheckpointForkAttempt | null {
  if (!isRecord(value)) return null;
  const allowedFields = new Set([
    "schemaVersion",
    "childRunId",
    "createdAt",
    "updatedAt",
    "status",
    "forkOf",
    "limits",
    "elapsedMs",
    "timedOut",
    "failureCode",
    "failureReason",
    "providerFailure"
  ]);
  if (Object.keys(value).some((key) => !allowedFields.has(key))) return null;
  if (value.schemaVersion !== "server.checkpoint-fork-attempt.v1") return null;
  const childRunId = stringField(value, "childRunId");
  const createdAt = stringField(value, "createdAt");
  const updatedAt = stringField(value, "updatedAt");
  if (!childRunId || !createdAt || !updatedAt) return null;
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(childRunId)) return null;
  if (!isSafeIsoTimestamp(createdAt) || !isSafeIsoTimestamp(updatedAt) || Date.parse(updatedAt) < Date.parse(createdAt)) return null;
  if (value.status !== "running" && value.status !== "failed") return null;
  if (!isRecord(value.forkOf) || validateGenericForkProvenance(value.forkOf).length > 0) return null;
  const allowedForkFields = new Set([
    "schemaVersion",
    "checkpointArtifactVersion",
    "checkpointId",
    "parentRunId",
    "parentArtifactId",
    "parentMatchId",
    "parentBoundaryTraceId",
    "parentEvidenceTraceIds",
    "parentBoundaryTurnIndex",
    "parentStateHash",
    "parentExecutionPrefixHash",
    "parentAgentsHash",
    "parentChannelsHash",
    "parentMessagesHash",
    "parentNativeStepCount",
    "parentMessageCount",
    "parentDomainAdapter",
    "parentRulesetId",
    "experimentLineage",
    "createdAt",
    "reason"
  ]);
  if (Object.keys(value.forkOf).some((key) => !allowedForkFields.has(key))) return null;
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(stringField(value.forkOf, "checkpointId") ?? "")) return null;
  if (typeof value.forkOf.parentRulesetId !== "string" || !value.forkOf.parentRulesetId.trim()) return null;
  if (value.forkOf.parentMatchId !== undefined && (typeof value.forkOf.parentMatchId !== "string" || !value.forkOf.parentMatchId.trim())) {
    return null;
  }
  if (value.forkOf.createdAt !== createdAt) return null;
  if (typeof value.forkOf.reason === "string" && value.forkOf.reason.length > 256) return null;
  if (!isRecord(value.limits)) return null;
  if (Object.keys(value.limits).some((key) => key !== "maxTransitions" && key !== "timeoutMs")) return null;
  const maxTransitions = value.limits.maxTransitions;
  const timeoutMs = value.limits.timeoutMs;
  if (maxTransitions !== null && (typeof maxTransitions !== "number" || !Number.isInteger(maxTransitions) || maxTransitions <= 0)) return null;
  if (timeoutMs !== null && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) return null;
  for (const field of ["failureCode", "failureReason"] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || !value[field].trim() || value[field].length > (field === "failureCode" ? 128 : 512))
    ) {
      return null;
    }
  }
  if (value.elapsedMs !== undefined && (typeof value.elapsedMs !== "number" || !Number.isInteger(value.elapsedMs) || value.elapsedMs < 0)) {
    return null;
  }
  if (value.timedOut !== undefined && typeof value.timedOut !== "boolean") return null;
  let providerFailure: PublicProviderFailureSummary | null | undefined;
  if (value.providerFailure !== undefined && value.providerFailure !== null) {
    if (!isRecord(value.providerFailure)) return null;
    const providerRecord = value.providerFailure;
    const allowedProviderFields = new Set([
      "failureKind",
      "providerStage",
      "status",
      "timeoutMs",
      "aborted",
      "retryable",
      "attempts",
      "maxAttempts"
    ]);
    if (Object.keys(providerRecord).some((key) => !allowedProviderFields.has(key))) return null;
    if (
      typeof providerRecord.failureKind !== "string" ||
      !isProviderFailureKind(providerRecord.failureKind) ||
      (providerRecord.providerStage !== undefined &&
        (typeof providerRecord.providerStage !== "string" ||
          ![
            "before_start",
            "during_request",
            "during_stream",
            "during_retry_delay",
            "http_response",
            "stream_start",
            "stream_parse",
            "stream_finish",
            "non_stream_parse"
          ].includes(providerRecord.providerStage))) ||
      ["status", "timeoutMs", "attempts", "maxAttempts"].some(
        (field) =>
          providerRecord[field] !== undefined &&
          (typeof providerRecord[field] !== "number" ||
            !Number.isInteger(providerRecord[field]) ||
            providerRecord[field] < 0)
      ) ||
      ["aborted", "retryable"].some(
        (field) => providerRecord[field] !== undefined && typeof providerRecord[field] !== "boolean"
      )
    ) {
      return null;
    }
    providerFailure = publicProviderFailureFromUnknown(providerRecord);
    if (!providerFailure) return null;
  } else if (value.providerFailure === null) {
    providerFailure = null;
  }
  if (
    value.status === "failed" &&
    (typeof value.failureReason !== "string" || typeof value.failureCode !== "string" || typeof value.elapsedMs !== "number" || typeof value.timedOut !== "boolean")
  ) {
    return null;
  }
  if (
    value.status === "running" &&
    (value.elapsedMs !== undefined ||
      value.timedOut !== undefined ||
      value.failureCode !== undefined ||
      value.failureReason !== undefined ||
      value.providerFailure !== undefined)
  ) {
    return null;
  }
  return {
    ...(value as unknown as StoredCheckpointForkAttempt),
    ...(providerFailure === undefined ? {} : { providerFailure })
  };
}

export async function loadCheckpointArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  let pending = checkpointIndexLoadsByRoot.get(root);
  if (!pending) {
    pending = loadCheckpointArtifactIndexFromDisk(root).catch((error: unknown) => {
      checkpointIndexLoadsByRoot.delete(root);
      throw error;
    });
    checkpointIndexLoadsByRoot.set(root, pending);
  }
  await pending;
}

async function loadCheckpointArtifactIndexFromDisk(root: string): Promise<void> {
  await loadArtifactRecoveryAuditSidecar(root, "checkpoint");
  let parsed: unknown;
  let shouldRewriteIndex = false;
  const loadedIds = new Set<string>();
  let indexExists = true;
  try {
    parsed = JSON.parse(await readFile(checkpointArtifactIndexPath(root), "utf8"));
  } catch (error) {
    if (isFileReadNotFound(error)) {
      indexExists = false;
    } else if (error instanceof SyntaxError) {
      indexExists = false;
      await recordArtifactRecoveryAudit(root, {
        store: "checkpoint",
        source: "index",
        code: "index_invalid_json",
        relativeFile: CHECKPOINT_ARTIFACT_INDEX_FILE,
        message: "Checkpoint artifact index contained invalid JSON and will be repaired."
      });
      shouldRewriteIndex = true;
    } else {
      throw new HttpError(500, "Checkpoint artifact index could not be read.");
    }
  }

  if (indexExists) {
    if (
      !isRecord(parsed) ||
      parsed.artifactVersion !== "harness.checkpoint-artifact-index.v2" ||
      parsed.kind !== "checkpoint-artifact-index" ||
      !Array.isArray(parsed.checkpoints)
    ) {
      await recordArtifactRecoveryAudit(root, {
        store: "checkpoint",
        source: "index",
        code: "index_invalid_shape",
        relativeFile: CHECKPOINT_ARTIFACT_INDEX_FILE,
        message: "Checkpoint artifact index shape was invalid and will be repaired."
      });
      shouldRewriteIndex = true;
    } else {
      for (const record of parsed.checkpoints) {
        const checkpoint = await checkpointFromIndexRecord(root, record);
        if (checkpoint) {
          saveCheckpoint(checkpoint);
          loadedIds.add(checkpoint.checkpointId);
        } else {
          await recordArtifactRecoveryAudit(root, {
            store: "checkpoint",
            source: "index",
            code: "index_record_rejected",
            artifactId: isRecord(record) ? stringField(record, "checkpointId") ?? undefined : undefined,
            relativeFile: isRecord(record) ? stringField(record, "relativeFile") ?? undefined : undefined,
            message: "Checkpoint artifact index record did not resolve to a valid server-owned checkpoint."
          });
          shouldRewriteIndex = true;
        }
      }
    }
  }

  const scannedIds = await loadCheckpointArtifactsFromDirectory(root, loadedIds);
  if (scannedIds.length > 0 || shouldRewriteIndex || !indexExists) {
    await writeCheckpointArtifactIndex(root);
  }
}

export async function writeCheckpointArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await mkdir(checkpointArtifactDirectory(root), { recursive: true });
  const checkpoints = [];
  for (const checkpoint of listCheckpoints()) {
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(checkpoint.checkpointId)) continue;
    const persisted = await checkpointFromFile(root, checkpoint.checkpointId, checkpointArtifactRelativeFile(checkpoint.checkpointId));
    if (!persisted) continue;
    checkpoints.push({
      checkpointId: persisted.checkpointId,
      createdAt: persisted.createdAt,
      sourceRunId: persisted.source.runId,
      sourceMatchId: persisted.source.matchId ?? null,
      seed: persisted.source.seed,
      rulesetId: persisted.source.rulesetId,
      stateHash: persisted.source.stateHash,
      executionPrefixHash: persisted.source.executionPrefixHash,
      agentsHash: persisted.source.agentsHash,
      channelsHash: persisted.source.channelsHash,
      messagesHash: persisted.source.messagesHash,
      relativeFile: checkpointArtifactRelativeFile(persisted.checkpointId)
    });
  }
  const index = {
    artifactVersion: "harness.checkpoint-artifact-index.v2",
    kind: "checkpoint-artifact-index",
    updatedAt: new Date().toISOString(),
    checkpoints
  };
  await writeFile(checkpointArtifactIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

export async function checkpointFromIndexRecord(baseDir: string, value: unknown): Promise<HarnessCheckpoint | null> {
  try {
    if (!isRecord(value)) return null;
    const checkpointId = stringField(value, "checkpointId");
    const relativeFile = stringField(value, "relativeFile");
    if (!checkpointId || !relativeFile) return null;
    if (relativeFile !== checkpointArtifactRelativeFile(checkpointId)) return null;
    return checkpointFromFile(baseDir, checkpointId, relativeFile);
  } catch {
    return null;
  }
}

export async function loadCheckpointArtifactsFromDirectory(baseDir: string, skipIds: Set<string>): Promise<string[]> {
  const dir = checkpointArtifactDirectory(baseDir);
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isFileReadNotFound(error)) return [];
    throw new HttpError(500, "Checkpoint artifact directory could not be read.");
  }
  const loadedIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const checkpointId = entry.name.slice(0, -".json".length);
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(checkpointId)) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "checkpoint",
        source: "directory",
        code: "file_name_rejected",
        relativeFile: `${CHECKPOINT_ARTIFACT_DIR}/${entry.name}`,
        message: "Checkpoint artifact file name was not a generated UUID JSON artifact."
      });
      continue;
    }
    if (skipIds.has(checkpointId)) continue;
    const checkpointResult = await readCheckpointFromFile(baseDir, checkpointId, checkpointArtifactRelativeFile(checkpointId));
    if (!checkpointResult.ok) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "checkpoint",
        source: "directory",
        code: checkpointResult.code,
        artifactId: checkpointId,
        relativeFile: checkpointArtifactRelativeFile(checkpointId),
        message:
          artifactRecoveryAuditMessageForCode("checkpoint", "directory", checkpointResult.code) ??
          "Checkpoint artifact file failed recovery validation."
      });
      continue;
    }
    const checkpoint = checkpointResult.artifact;
    saveCheckpoint(checkpoint);
    skipIds.add(checkpoint.checkpointId);
    loadedIds.push(checkpoint.checkpointId);
  }
  return loadedIds;
}

export async function checkpointFromFile(baseDir: string, checkpointId: string, relativeFile: string): Promise<HarnessCheckpoint | null> {
  const result = await readCheckpointFromFile(baseDir, checkpointId, relativeFile);
  return result.ok ? result.artifact : null;
}

export async function readCheckpointFromFile(
  baseDir: string,
  checkpointId: string,
  relativeFile: string
): Promise<ArtifactRecoveryReadResult<HarnessCheckpoint>> {
  try {
    if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(checkpointId)) return { ok: false, code: "file_identity_mismatch" };
    const normalized = normalizeRequestedArtifactPath(relativeFile);
    if (normalized !== checkpointArtifactRelativeFile(checkpointId)) return { ok: false, code: "file_identity_mismatch" };
    const absolutePath = resolveUnderDirectory(baseDir, normalized);
    try {
      await assertRegularFileInsideDirectory(baseDir, absolutePath, "checkpoint artifact file not found");
    } catch {
      return { ok: false, code: "file_not_regular" };
    }
    let checkpoint: unknown;
    try {
      checkpoint = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
    } catch (error) {
      return { ok: false, code: error instanceof SyntaxError ? "file_invalid_json" : "file_not_regular" };
    }
    if (!isRecord(checkpoint)) return { ok: false, code: "file_invalid_shape" };
    if (checkpoint.artifactVersion !== HARNESS_CHECKPOINT_VERSION || checkpoint.kind !== "checkpoint") {
      return { ok: false, code: "file_invalid_shape" };
    }
    if (checkpoint.checkpointId !== checkpointId) return { ok: false, code: "file_identity_mismatch" };
    const restored = checkpoint as unknown as HarnessCheckpoint;
    try {
      assertValidHarnessCheckpoint(restored);
    } catch {
      return { ok: false, code: "file_provenance_invalid" };
    }
    return { ok: true, artifact: restored };
  } catch {
    return { ok: false, code: "file_identity_mismatch" };
  }
}

export function checkpointArtifactIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), CHECKPOINT_ARTIFACT_INDEX_FILE);
}

export function checkpointForkAttemptPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), CHECKPOINT_FORK_ATTEMPT_FILE);
}

export function checkpointArtifactDirectory(baseDir: string): string {
  return resolveUnderDirectory(baseDir, CHECKPOINT_ARTIFACT_DIR);
}

export function checkpointArtifactAbsoluteFile(baseDir: string, checkpointId: string): string {
  return resolveUnderDirectory(baseDir, checkpointArtifactRelativeFile(checkpointId));
}

export function checkpointArtifactRelativeFile(checkpointId: string): string {
  if (!GENERATED_ARTIFACT_SET_ID_PATTERN.test(checkpointId)) throw new HttpError(500, "generated checkpoint id is invalid");
  return `${CHECKPOINT_ARTIFACT_DIR}/${checkpointId}.json`;
}
