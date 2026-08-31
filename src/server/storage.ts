import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type StorageName = "models" | "characters" | "templates" | "archives";
export type StorageIssueCode = "CORRUPT_FILE_QUARANTINED" | "READ_FAILED" | "WRITE_FAILED";

export interface StorageIssue {
  store: StorageName;
  code: StorageIssueCode;
}

/** Process-local, path-free storage health exposed by `/api/health`. */
export class StorageHealth {
  private readonly issues = new Map<string, StorageIssue>();

  record(issue: StorageIssue): void {
    this.issues.set(`${issue.store}:${issue.code}`, issue);
  }

  snapshot(): { status: "ok" | "degraded"; issues: StorageIssue[] } {
    const issues = [...this.issues.values()];
    return { status: issues.length ? "degraded" : "ok", issues };
  }
}

/** Crash-safe JSON write: same-directory temp file, fsync, then atomic rename. */
export function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(value, null, 2), { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

/** Preserve an unreadable user file under a unique, human-recoverable name. */
export function quarantineCorruptFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const parsed = path.parse(file);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(parsed.dir, `${parsed.name}.corrupt-${timestamp}-${randomUUID().slice(0, 6)}${parsed.ext || ".json"}`);
  try {
    renameSync(file, target);
    return target;
  } catch {
    return undefined;
  }
}
