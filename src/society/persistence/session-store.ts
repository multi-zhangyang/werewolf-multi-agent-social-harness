/**
 * Durable JSON session store implementing the SDK `Session` interface.
 *
 * Each peer agent's session is persisted to its own file under
 * `data/sessions/<sessionId>.json` (gitignored), so an agent's conversation
 * history survives process restarts. Writes are coalesced: appends mark the
 * store dirty and flush within a short window; compaction (history rewrite),
 * clears and pops flush immediately. The store never sees provider secrets —
 * it holds the same model-visible items the SDK session holds.
 *
 * Durability contract (AGENTS.md §16.2):
 *  - every mutation marks the store dirty before it touches the file;
 *  - a failed flush keeps the dirty flag so the next write retries;
 *  - files carry a schema version and a checksum; a file that fails either
 *    check is preserved aside as `.corrupt-<timestamp>` and reported with a
 *    diagnosable error instead of being silently reset to empty history;
 *  - `close()` forces a flush, and the process flushes all open stores on
 *    exit so a clean shutdown never drops pending writes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentInputItem, Session } from "@openai/agents";

export const SESSION_STORE_SCHEMA_VERSION = 1;

export interface SessionStoreFile {
  schemaVersion: number;
  sessionId: string;
  items: AgentInputItem[];
  updatedAt: string;
  checksum: string;
}

/** A session file that exists but fails schema/checksum validation. */
export class SessionStoreCorruptError extends Error {
  constructor(readonly file: string, readonly reason: string) {
    super(
      `SESSION_STORE_CORRUPT: ${file} is unreadable (${reason}). ` +
      "The file was preserved aside as .corrupt-* instead of being silently reset."
    );
    this.name = "SessionStoreCorruptError";
  }
}

export function defaultSessionDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "data", "sessions");
}

const openStores = new Set<WeakRef<JsonSessionStore>>();

/** Flush every open store; hooked into process exit paths. */
export function flushAllSessionStores(): void {
  for (const ref of openStores) {
    const store = ref.deref();
    if (!store) {
      openStores.delete(ref);
      continue;
    }
    store.close();
  }
}

process.on("beforeExit", flushAllSessionStores);
process.on("exit", flushAllSessionStores);

export class JsonSessionStore implements Session {
  private items: AgentInputItem[];
  private dirty = false;
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly sessionId: string,
    private readonly file: string
  ) {
    const loaded = loadFile(file);
    this.items = loaded?.sessionId === sessionId ? (loaded.items ?? []) : [];
    openStores.add(new WeakRef(this));
  }

  static open(sessionId: string, dir = defaultSessionDir()): JsonSessionStore {
    const safeId = sessionId.replace(/[^A-Za-z0-9_.:-]/g, "_");
    mkdirSync(dir, { recursive: true });
    return new JsonSessionStore(sessionId, path.join(dir, `${safeId}.json`));
  }

  get sessionFilePath(): string {
    return this.file;
  }

  /** Observable write state: true while in-memory changes are not yet durable. */
  get needsFlush(): boolean {
    return this.dirty;
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const all = this.items;
    return limit === undefined ? [...all] : all.slice(-limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (!items.length) return;
    this.items.push(...structuredClone(items));
    this.markDirty();
  }

  /** Compaction path: the SDK replaces history with marker + retained suffix. */
  async replaceHistoryWithCompaction(items: AgentInputItem[]): Promise<void> {
    this.items = structuredClone(items);
    this.markDirty();
    this.flush();
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const item = this.items.pop();
    if (item) {
      this.markDirty();
      this.flush();
    }
    return item ? structuredClone(item) : undefined;
  }

  async clearSession(): Promise<void> {
    this.items = [];
    this.markDirty();
    this.flush();
  }

  /** Force any pending writes to disk now; safe to call at any time. */
  close(): void {
    this.flush();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 1_500);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty) return;
    const payload: Omit<SessionStoreFile, "checksum"> = {
      schemaVersion: SESSION_STORE_SCHEMA_VERSION,
      sessionId: this.sessionId,
      items: this.items,
      updatedAt: new Date().toISOString()
    };
    const payloadWithChecksum: SessionStoreFile = { ...payload, checksum: checksumFor(payload) };
    const temporary = `${this.file}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(payloadWithChecksum), { mode: 0o600 });
      renameSync(temporary, this.file);
      this.dirty = false;
    } catch {
      // A failed flush keeps the store dirty; the next write retries.
      this.dirty = true;
    }
  }
}

function checksumFor(payload: Omit<SessionStoreFile, "checksum">): string {
  return createHash("sha256")
    .update(JSON.stringify({ sessionId: payload.sessionId, items: payload.items }))
    .digest("hex");
}

function loadFile(file: string): SessionStoreFile | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: Partial<SessionStoreFile> | undefined;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionStoreFile>;
  } catch {
    preserveCorrupt(file, "invalid JSON");
  }
  const reason = corruptReason(file, parsed!);
  if (reason) preserveCorrupt(file, reason);
  return parsed as SessionStoreFile;
}

function corruptReason(file: string, parsed: Partial<SessionStoreFile>): string | undefined {
  if (parsed.schemaVersion !== SESSION_STORE_SCHEMA_VERSION) {
    return `unsupported schema version ${String(parsed.schemaVersion)}`;
  }
  if (typeof parsed.sessionId !== "string" || !Array.isArray(parsed.items)) {
    return "malformed envelope";
  }
  const expected = checksumFor({ schemaVersion: parsed.schemaVersion, sessionId: parsed.sessionId, items: parsed.items, updatedAt: parsed.updatedAt ?? "" });
  if (parsed.checksum !== expected) return "checksum mismatch";
  return undefined;
}

/** Never returns: renames the bad file aside and throws a diagnosable error. */
function preserveCorrupt(file: string, reason: string): never {
  const preserved = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, preserved);
  } catch {
    // The rename is best-effort; the error below is the diagnostic.
  }
  throw new SessionStoreCorruptError(file, reason);
}