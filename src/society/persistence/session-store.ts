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

/** Synchronous pause for the rename retry loop (no builtin sleepSync). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentInputItem, Session } from "@openai/agents";
import { normalizeInputTextParts, repairJsonText } from "../wire-json";

export const SESSION_STORE_SCHEMA_VERSION = 1;

export interface SessionStoreFile {
  schemaVersion: number;
  sessionId: string;
  items: AgentInputItem[];
  updatedAt: string;
  checksum: string;
}

export interface SessionStoreNotice {
  severity: "info" | "error";
  code: "SESSION_STORE_WRITE_FAILED" | "SESSION_STORE_WRITE_RECOVERED";
  message: string;
  retrying: boolean;
}

export interface SessionStoreOptions {
  onNotice?(notice: SessionStoreNotice): void;
}

export class SessionStoreWriteError extends Error {
  constructor(options?: ErrorOptions) {
    super("SESSION_STORE_WRITE_FAILED: Agent session history could not be written.", options);
    this.name = "SessionStoreWriteError";
  }
}

/** A session file that exists but fails schema/checksum validation. */
export class SessionStoreCorruptError extends Error {
  constructor(readonly file: string, readonly reason: string) {
    super(
      `SESSION_STORE_CORRUPT: Agent session history is unreadable (${reason}). ` +
      "The damaged data was preserved for operator recovery instead of being silently reset."
    );
    this.name = "SessionStoreCorruptError";
  }
}

/** Filename-safe form of a session id (colons and separators collapse to `_`). */
export function sessionFileId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Delete one persisted session file (season reset). True when it existed. */
export function deleteSessionById(sessionId: string, dir = defaultSessionDir()): boolean {
  const file = path.join(dir, `${sessionFileId(sessionId)}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/** Delete every persisted `season-<characterId>` session file. */
export function deleteSeasonSessions(dir = defaultSessionDir()): number {
  if (!existsSync(dir)) return 0;
  let deleted = 0;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("season-") && entry.endsWith(".json")) {
      unlinkSync(path.join(dir, entry));
      deleted += 1;
    }
  }
  return deleted;
}

/**
 * Enforce the tool-calling wire contract (OpenAI spec: function.arguments is
 * a JSON string) on persisted history. Repair preserves the model's intent;
 * "{}" is the last-resort fallback — the paired tool result already reports
 * the parse failure to the model either way. Shared repair logic lives in
 * `wire-json.ts` so the provider fetch layer enforces the same contract.
 */
export function sanitizeFunctionCallArgs(items: AgentInputItem[]): AgentInputItem[] {
  let repaired = 0;
  const out = items.map((item): AgentInputItem => {
    const record = item as unknown as Record<string, unknown>;
    if (record.type === "function_call" && typeof record.arguments === "string") {
      try {
        JSON.parse(record.arguments);
      } catch {
        repaired += 1;
        const fixed = repairJsonText(record.arguments) ?? "{}";
        return { ...item, arguments: fixed } as AgentInputItem;
      }
    }
    if (record.type === "message" && record.role === "system" && Array.isArray(record.content)) {
      // Strict endpoints reject structured content arrays in SYSTEM messages
      // (the compression digest uses this format); flatten text-only arrays
      // to a plain string so a compacted history never 400s every follow-up.
      const content = normalizeInputTextParts(record.content);
      if (content !== record.content) return { ...item, content } as AgentInputItem;
    }
    return item;
  });
  if (repaired > 0) console.warn(`[session-store] repaired ${repaired} malformed function_call argument payload(s) into wire-valid history`);
  return out;
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
  private writeFailed = false;

  constructor(
    private readonly sessionId: string,
    private readonly file: string,
    private readonly options: SessionStoreOptions = {}
  ) {
    const loaded = loadFile(file);
    // Provider-safe history (§16.2): a malformed function_call payload
    // (model truncation mid-arguments) gets rejected wholesale by endpoints
    // that validate replayed tool_calls — poisoning every later request.
    // The paired tool result already reports the parse error to the model.
    this.items = sanitizeFunctionCallArgs(loaded?.sessionId === sessionId ? (loaded.items ?? []) : []);
    openStores.add(new WeakRef(this));
  }

  static open(sessionId: string, dir = defaultSessionDir(), options: SessionStoreOptions = {}): JsonSessionStore {
    const safeId = sessionFileId(sessionId);
    mkdirSync(dir, { recursive: true });
    return new JsonSessionStore(sessionId, path.join(dir, `${safeId}.json`), options);
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
    this.items.push(...structuredClone(sanitizeFunctionCallArgs(items)));
    this.markDirty();
  }

  /** Compaction path: the SDK replaces history with marker + retained suffix. */
  async replaceHistoryWithCompaction(items: AgentInputItem[]): Promise<void> {
    this.items = structuredClone(items);
    this.markDirty();
    this.flush(true);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const item = this.items.pop();
    if (item) {
      this.markDirty();
      this.flush(true);
    }
    return item ? structuredClone(item) : undefined;
  }

  async clearSession(): Promise<void> {
    this.items = [];
    this.markDirty();
    this.flush(true);
  }

  /** Force any pending writes to disk now; safe to call at any time. */
  close(): void {
    this.flush();
  }

  private markDirty(): void {
    this.dirty = true;
    this.scheduleFlush(1_500);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delayMs);
    this.flushTimer.unref?.();
  }

  private flush(throwOnFailure = false): void {
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
      // Windows briefly holds renamed targets (antivirus/indexing), making
      // rename-over-existing fail with EPERM; a few quick retries absorb the
      // blip before it escalates to a visible persistence failure.
      let lastRenameError: unknown;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          renameSync(temporary, this.file);
          lastRenameError = undefined;
          break;
        } catch (renameError) {
          lastRenameError = renameError;
          sleepSync(25);
        }
      }
      if (lastRenameError !== undefined) throw lastRenameError;
      this.dirty = false;
      if (this.writeFailed) {
        this.writeFailed = false;
        this.options.onNotice?.({
          severity: "info",
          code: "SESSION_STORE_WRITE_RECOVERED",
          message: "Agent 会话历史已恢复写入。",
          retrying: false
        });
      }
    } catch (error) {
      this.dirty = true;
      this.scheduleFlush(5_000);
      if (!this.writeFailed) {
        this.writeFailed = true;
        this.options.onNotice?.({
          severity: "error",
          code: "SESSION_STORE_WRITE_FAILED",
          message: "Agent 会话历史写入失败，内存状态仍保留；系统将在后台重试。",
          retrying: true
        });
      }
      if (throwOnFailure) throw new SessionStoreWriteError({ cause: error });
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
