import path from "node:path";
import { redactSecrets } from "../harness/redaction";
import { sanitizeApiErrorText } from "./apiFailure";
import {
  CHECKPOINT_ARTIFACT_DIR,
  CHECKPOINT_ARTIFACT_INDEX_FILE,
  GENERATED_ARTIFACT_SET_ID_PATTERN,
  MATCH_ARTIFACT_DIR,
  MATCH_ARTIFACT_INDEX_FILE,
  TOURNAMENT_ARTIFACT_SET_INDEX_FILE,
  isFileReadNotFound,
  isPathStrictlyInsideDirectory,
  isPersistedMatchArtifactId,
  resolveUnderDirectory
} from "./artifactFiles";
import { HttpError, optionalIntegerQuery, optionalSingleQueryString } from "./httpValidation";
import { isRecord, stringField } from "./jsonUtil";
import { type StoredArtifactRecoveryAuditRecord, saveArtifactRecoveryAuditRecord } from "./store";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";

export const ARTIFACT_RECOVERY_AUDIT_FILE = "artifact_recovery_audits.jsonl";

export const ARTIFACT_RECOVERY_AUDIT_VERSION = "server.artifact-recovery-audit.v1";

export const ARTIFACT_RECOVERY_AUDIT_MAX_LIMIT = 500;

export type ArtifactRecoveryReadResult<T> = { ok: true; artifact: T } | { ok: false; code: string };

export interface ArtifactRecoveryAuditQuery {
  store?: StoredArtifactRecoveryAuditRecord["store"];
  source?: StoredArtifactRecoveryAuditRecord["source"];
  code?: string;
  limit?: number;
  offset: number;
}

export function serializeArtifactRecoveryAuditRecord(record: StoredArtifactRecoveryAuditRecord): object {
  return {
    id: record.id,
    createdAt: record.createdAt,
    store: record.store,
    source: record.source,
    code: sanitizeApiErrorText(record.code),
    artifactId: record.artifactId ? normalizeAuditArtifactId(record.artifactId) : null,
    relativeFile: record.relativeFile ? normalizeAuditRelativeFile(record.store, record.source, record.relativeFile) : null,
    message: sanitizeApiErrorText(record.message)
  };
}

export function artifactRecoveryAuditQueryFromRequest(query: unknown): ArtifactRecoveryAuditQuery {
  const record = isRecord(query) ? query : {};
  const storeValue = optionalSingleQueryString(record, "store");
  const sourceValue = optionalSingleQueryString(record, "source");
  const codeValue = optionalSingleQueryString(record, "code");
  const store = storeValue === undefined ? undefined : artifactRecoveryAuditStoreFromUnknown(storeValue);
  const source = sourceValue === undefined ? undefined : artifactRecoveryAuditSourceFromUnknown(sourceValue);
  if (storeValue !== undefined && !store) throw new HttpError(400, "Artifact recovery audit store filter is invalid.");
  if (sourceValue !== undefined && !source) throw new HttpError(400, "Artifact recovery audit source filter is invalid.");
  if (codeValue !== undefined && !/^[a-z][a-z0-9_]{0,80}$/.test(codeValue)) {
    throw new HttpError(400, "Artifact recovery audit code filter is invalid.");
  }
  return {
    store: store ?? undefined,
    source: source ?? undefined,
    code: codeValue,
    limit: optionalIntegerQuery(record, "limit", { min: 1, max: ARTIFACT_RECOVERY_AUDIT_MAX_LIMIT }),
    offset: optionalIntegerQuery(record, "offset", { min: 0, max: 1_000_000 }) ?? 0
  };
}

export function artifactRecoveryAuditRecordMatchesQuery(record: StoredArtifactRecoveryAuditRecord, query: ArtifactRecoveryAuditQuery): boolean {
  if (query.store && record.store !== query.store) return false;
  if (query.source && record.source !== query.source) return false;
  if (query.code && record.code !== query.code) return false;
  return true;
}

export async function loadArtifactRecoveryAuditSidecar(baseDir: string, store: StoredArtifactRecoveryAuditRecord["store"]): Promise<void> {
  const root = path.resolve(baseDir);
  const file = artifactRecoveryAuditSidecarPath(root);
  const status = await artifactRecoveryAuditSidecarStatus(root, file);
  if (status === "missing") return;
  if (status === "unsafe") {
    recordArtifactRecoverySidecarDiagnostic(store, "sidecar_file_rejected", 0, "unsafe-sidecar-file");
    return;
  }
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (isFileReadNotFound(error)) return;
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "Artifact recovery audit sidecar could not be read.");
  }

  let lineNumber = 0;
  for (const line of content.split("\n")) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      recordArtifactRecoverySidecarDiagnostic(store, "sidecar_invalid_jsonl_line", lineNumber, trimmed);
      continue;
    }
    const record = artifactRecoveryAuditRecordFromUnknown(parsed);
    if (record) {
      saveArtifactRecoveryAuditRecord(record);
    } else {
      recordArtifactRecoverySidecarDiagnostic(store, "sidecar_invalid_record_shape", lineNumber, trimmed);
    }
  }
}

export async function recordArtifactRecoveryAudit(
  baseDir: string,
  record: Omit<StoredArtifactRecoveryAuditRecord, "id" | "createdAt">
): Promise<void> {
  const stored = saveArtifactRecoveryAuditRecord(sanitizeArtifactRecoveryAuditRecord(record));
  if (!stored) return;
  await appendArtifactRecoveryAuditSidecar(baseDir, stored);
}

export function artifactRecoveryAuditRecordFromUnknown(
  value: unknown
): (Omit<StoredArtifactRecoveryAuditRecord, "id" | "createdAt"> & { createdAt?: string }) | null {
  if (!isRecord(value)) return null;
  const store = artifactRecoveryAuditStoreFromUnknown(value.store);
  const source = artifactRecoveryAuditSourceFromUnknown(value.source);
  const code = stringField(value, "code");
  const createdAt = stringField(value, "createdAt");
  const message = store && source && code ? artifactRecoveryAuditMessageForCode(store, source, code) : null;
  const detailKey = source === "sidecar" ? safeArtifactRecoveryAuditDetailKey(stringField(value, "detailKey")) : undefined;
  if (
    value.artifactVersion !== ARTIFACT_RECOVERY_AUDIT_VERSION ||
    !store ||
    !source ||
    !code ||
    !message ||
    !createdAt ||
    !isSafeIsoTimestamp(createdAt) ||
    (source === "sidecar" && !detailKey)
  ) {
    return null;
  }
  return sanitizeArtifactRecoveryAuditRecord({
    store,
    source,
    code,
    artifactId: stringField(value, "artifactId") ?? undefined,
    relativeFile: stringField(value, "relativeFile") ?? undefined,
    detailKey,
    message,
    createdAt
  });
}

export function recordArtifactRecoverySidecarDiagnostic(
  store: StoredArtifactRecoveryAuditRecord["store"],
  code: "sidecar_invalid_jsonl_line" | "sidecar_invalid_record_shape" | "sidecar_file_rejected",
  lineNumber: number,
  rawLine: string
): void {
  const message = artifactRecoveryAuditMessageForCode(store, "sidecar", code);
  if (!message) return;
  saveArtifactRecoveryAuditRecord(
    sanitizeArtifactRecoveryAuditRecord({
      store,
      source: "sidecar",
      code,
      relativeFile: ARTIFACT_RECOVERY_AUDIT_FILE,
      detailKey: sidecarDiagnosticDetailKey(lineNumber, rawLine),
      message
    })
  );
}

export function sidecarDiagnosticDetailKey(lineNumber: number, rawLine: string): string {
  const digest = createHash("sha256").update(rawLine).digest("hex").slice(0, 16);
  return `line:${lineNumber}:${digest}`;
}

export function sanitizeArtifactRecoveryAuditRecord(
  record: Omit<StoredArtifactRecoveryAuditRecord, "id" | "createdAt"> & { createdAt?: string }
): Omit<StoredArtifactRecoveryAuditRecord, "id" | "createdAt"> & { createdAt?: string } {
  return {
    ...record,
    code: sanitizeApiErrorText(record.code),
    artifactId: record.artifactId ? normalizeAuditArtifactId(record.artifactId) : undefined,
    relativeFile: record.relativeFile ? normalizeAuditRelativeFile(record.store, record.source, record.relativeFile) : undefined,
    detailKey: record.detailKey ? safeArtifactRecoveryAuditDetailKey(record.detailKey) : undefined,
    message: sanitizeApiErrorText(record.message)
  };
}

export async function appendArtifactRecoveryAuditSidecar(baseDir: string, record: StoredArtifactRecoveryAuditRecord): Promise<void> {
  const root = path.resolve(baseDir);
  await mkdir(root, { recursive: true });
  const file = artifactRecoveryAuditSidecarPath(root);
  const status = await artifactRecoveryAuditSidecarStatus(root, file);
  if (status === "unsafe") return;
  await appendFile(
    file,
    `${JSON.stringify(
      redactSecrets({
        artifactVersion: ARTIFACT_RECOVERY_AUDIT_VERSION,
        ...record
      })
    )}\n`,
    "utf8"
  );
}

export function artifactRecoveryAuditSidecarPath(baseDir: string): string {
  return resolveUnderDirectory(baseDir, ARTIFACT_RECOVERY_AUDIT_FILE);
}

export async function artifactRecoveryAuditSidecarStatus(rootDir: string, absolutePath: string): Promise<"missing" | "safe" | "unsafe"> {
  try {
    const root = path.resolve(rootDir);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) return "unsafe";
    const realRoot = await realpath(root);
    const realFile = await realpath(absolutePath);
    if (!isPathStrictlyInsideDirectory(realFile, realRoot)) {
      return "unsafe";
    }
    return "safe";
  } catch (error) {
    if (isFileReadNotFound(error)) return "missing";
    return "unsafe";
  }
}

export function artifactRecoveryAuditStoreFromUnknown(value: unknown): StoredArtifactRecoveryAuditRecord["store"] | null {
  return value === "match" || value === "checkpoint" || value === "tournament" ? value : null;
}

export function artifactRecoveryAuditSourceFromUnknown(value: unknown): StoredArtifactRecoveryAuditRecord["source"] | null {
  return value === "index" || value === "directory" || value === "manifest" || value === "sidecar" ? value : null;
}

export function artifactRecoveryAuditMessageForCode(
  store: StoredArtifactRecoveryAuditRecord["store"],
  source: StoredArtifactRecoveryAuditRecord["source"],
  code: string
): string | null {
  if (source === "sidecar") {
    if (code === "sidecar_invalid_jsonl_line") return "Artifact recovery audit sidecar contained an invalid JSONL line that was ignored.";
    if (code === "sidecar_invalid_record_shape") return "Artifact recovery audit sidecar contained an invalid record shape that was ignored.";
    if (code === "sidecar_file_rejected") return "Artifact recovery audit sidecar file was not a safe regular file and was ignored.";
    return null;
  }
  if (source === "index") {
    if (code === "index_invalid_json") {
      if (store === "match") return "Match artifact index contained invalid JSON and will be repaired.";
      if (store === "checkpoint") return "Checkpoint artifact index contained invalid JSON and will be repaired.";
      return "Tournament artifact set index contained invalid JSON and will be repaired from child manifests.";
    }
    if (code === "index_invalid_shape") {
      if (store === "match") return "Match artifact index shape was invalid and will be repaired.";
      if (store === "checkpoint") return "Checkpoint artifact index shape was invalid and will be repaired.";
      return "Tournament artifact set index shape was invalid and will be repaired from child manifests.";
    }
    if (code === "index_record_rejected") {
      if (store === "match") return "Match artifact index record did not resolve to a valid server-owned artifact.";
      if (store === "checkpoint") return "Checkpoint artifact index record did not resolve to a valid server-owned checkpoint.";
      return "Tournament artifact set index record did not resolve to a valid manifest directory.";
    }
    return null;
  }
  if (store === "match" && source === "directory") {
    if (code === "file_name_rejected") return "Match artifact file name was not a server-owned match artifact id.";
    if (code === "file_not_regular") return "Match artifact file was not a safe regular server-owned file.";
    if (code === "file_invalid_json") return "Match artifact file contained invalid JSON.";
    if (code === "file_invalid_shape") return "Match artifact file shape or version was invalid.";
    if (code === "file_identity_mismatch") return "Match artifact file identity did not match its server-owned match artifact id.";
    if (code === "file_integrity_invalid") return "Match artifact file failed structural integrity validation.";
    if (code === "file_rejected") return "Match artifact file failed version, identity, filesystem, or integrity validation.";
  }
  if (store === "checkpoint" && source === "directory") {
    if (code === "file_name_rejected") return "Checkpoint artifact file name was not a generated UUID JSON artifact.";
    if (code === "file_not_regular") return "Checkpoint artifact file was not a safe regular server-owned file.";
    if (code === "file_invalid_json") return "Checkpoint artifact file contained invalid JSON.";
    if (code === "file_invalid_shape") return "Checkpoint artifact file shape or version was invalid.";
    if (code === "file_identity_mismatch") return "Checkpoint artifact file identity did not match its generated checkpoint id.";
    if (code === "file_provenance_invalid") return "Checkpoint artifact file failed provenance or structural validation.";
    if (code === "file_rejected") return "Checkpoint artifact file failed version, identity, filesystem, or provenance validation.";
  }
  if (store === "tournament" && source === "directory" && code === "directory_entry_rejected") {
    return "Tournament artifact set entry was not a generated artifact directory.";
  }
  if (store === "tournament" && source === "manifest" && code === "manifest_rejected") {
    return "Tournament artifact set manifest failed version, identity, registered-file, or filesystem validation.";
  }
  if (store === "tournament" && source === "manifest") {
    if (code === "manifest_directory_rejected") return "Tournament artifact set directory was not a safe generated directory.";
    if (code === "manifest_file_not_regular") return "Tournament artifact set manifest was not a safe regular server-owned file.";
    if (code === "manifest_invalid_json") return "Tournament artifact set manifest contained invalid JSON.";
    if (code === "manifest_invalid_shape") return "Tournament artifact set manifest shape or version was invalid.";
    if (code === "manifest_identity_mismatch") return "Tournament artifact set manifest identity did not match its generated artifact id.";
    if (code === "manifest_file_set_invalid") return "Tournament artifact set manifest registered an unexpected file set.";
  }
  return null;
}

export function isSafeIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function safeArtifactRecoveryAuditDetailKey(value: string | null): string | undefined {
  return value && /^line:[0-9]+:[0-9a-f]{16}$/.test(value) ? value : undefined;
}

export function normalizeAuditArtifactId(artifactId: string): string {
  return isPersistedMatchArtifactId(artifactId) || GENERATED_ARTIFACT_SET_ID_PATTERN.test(artifactId)
    ? artifactId
    : "<rejected>";
}

export function normalizeAuditRelativeFile(store: StoredArtifactRecoveryAuditRecord["store"], source: StoredArtifactRecoveryAuditRecord["source"], relativeFile: string): string {
  if (!relativeFile || relativeFile.includes("\0") || relativeFile.includes("\\") || relativeFile.startsWith("/") || /^[A-Za-z]:\//.test(relativeFile)) {
    return "<rejected>";
  }
  const segments = relativeFile.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "<rejected>";
  }
  if (source === "sidecar") {
    return relativeFile === ARTIFACT_RECOVERY_AUDIT_FILE ? relativeFile : "<rejected>";
  }
  if (store === "match") {
    if (source === "index" && relativeFile === MATCH_ARTIFACT_INDEX_FILE) return relativeFile;
    if (relativeFile.startsWith(`${MATCH_ARTIFACT_DIR}/`)) {
      if (!relativeFile.endsWith(".json")) return "<rejected>";
      const matchId = relativeFile.slice(MATCH_ARTIFACT_DIR.length + 1, -".json".length);
      return isPersistedMatchArtifactId(matchId) ? relativeFile : "<rejected>";
    }
    return "<rejected>";
  }
  if (store === "checkpoint") {
    if (source === "index" && relativeFile === CHECKPOINT_ARTIFACT_INDEX_FILE) return relativeFile;
    if (relativeFile.startsWith(`${CHECKPOINT_ARTIFACT_DIR}/`)) {
      if (!relativeFile.endsWith(".json")) return "<rejected>";
      const checkpointId = relativeFile.slice(CHECKPOINT_ARTIFACT_DIR.length + 1, -".json".length);
      return GENERATED_ARTIFACT_SET_ID_PATTERN.test(checkpointId) ? relativeFile : "<rejected>";
    }
    return "<rejected>";
  }
  if (store === "tournament") {
    if (source === "index" && relativeFile === TOURNAMENT_ARTIFACT_SET_INDEX_FILE) return relativeFile;
    if (source === "manifest" && relativeFile === "manifest.json") return relativeFile;
    return "<rejected>";
  }
  return relativeFile;
}
