/**
 * Durable JSON session store implementing the SDK `Session` interface.
 *
 * Each peer agent's session is persisted to its own file under
 * `data/sessions/<sessionId>.json` (gitignored), so an agent's conversation
 * history survives process restarts. Writes are coalesced: appends mark the
 * store dirty and flush within a short window; compaction (history rewrite)
 * and clears flush immediately. The store never sees provider secrets — it
 * holds the same model-visible items the SDK session holds.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentInputItem, Session } from "@openai/agents";

export interface SessionStoreFile {
  sessionId: string;
  items: AgentInputItem[];
  updatedAt: string;
}

export function defaultSessionDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "data", "sessions");
}

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
  }

  static open(sessionId: string, dir = defaultSessionDir()): JsonSessionStore {
    const safeId = sessionId.replace(/[^A-Za-z0-9_.:-]/g, "_");
    mkdirSync(dir, { recursive: true });
    return new JsonSessionStore(sessionId, path.join(dir, `${safeId}.json`));
  }

  get sessionFilePath(): string {
    return this.file;
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
    this.flush();
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const item = this.items.pop();
    if (item) this.flush();
    return item ? structuredClone(item) : undefined;
  }

  async clearSession(): Promise<void> {
    this.items = [];
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
    this.dirty = false;
    const payload: SessionStoreFile = {
      sessionId: this.sessionId,
      items: this.items,
      updatedAt: new Date().toISOString()
    };
    const temporary = `${this.file}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      // A failed flush keeps the store dirty; the next write retries.
      this.dirty = true;
    }
  }
}

function loadFile(file: string): SessionStoreFile | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionStoreFile>;
    if (typeof parsed.sessionId !== "string" || !Array.isArray(parsed.items)) return undefined;
    return { sessionId: parsed.sessionId, items: parsed.items, updatedAt: parsed.updatedAt ?? "" };
  } catch {
    return undefined;
  }
}