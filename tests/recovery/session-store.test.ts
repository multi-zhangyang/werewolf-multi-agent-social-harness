/**
 * Session-store durability checks (recovery suite, AGENTS.md §16.2 / P0-01).
 * Pins the dirty/flush contract: clean-store mutations must still persist,
 * failed writes must keep the store dirty, and corrupt files must be
 * preserved aside with a diagnosable error — never silently reset.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, vi } from "vitest";
import type { AgentInputItem } from "@openai/agents";
import {
  JsonSessionStore,
  SESSION_STORE_SCHEMA_VERSION,
  SessionStoreCorruptError
} from "../../src/society/persistence/session-store";

function item(text: string): AgentInputItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] } as unknown as AgentInputItem;
}

function textOf(entry: AgentInputItem | undefined): string | undefined {
  if (!entry || entry.type !== "message") return undefined;
  const content = (entry as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text;
}

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "society-session-"));
}

async function itemsOf(store: JsonSessionStore): Promise<AgentInputItem[]> {
  return store.getItems();
}

it("clean store: clearSession persists immediately (no dirty flag lost)", async () => {
  const dir = freshDir();
  const file = path.join(dir, "s1.json");
  try {
    const store = new JsonSessionStore("s1", file);
    await store.addItems([item("a"), item("b")]);
    store.close(); // reach the clean state where the bug lived
    assert.equal(store.needsFlush, false);
    await store.clearSession();
    const reopened = new JsonSessionStore("s1", file);
    assert.deepEqual(await itemsOf(reopened), [], "a cleared clean store must stay cleared after reopen");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("clean store: replaceHistoryWithCompaction persists immediately", async () => {
  const dir = freshDir();
  const file = path.join(dir, "s1.json");
  try {
    const store = new JsonSessionStore("s1", file);
    await store.addItems([item("old-1"), item("old-2")]);
    store.close();
    await store.replaceHistoryWithCompaction([item("digest"), item("recent")]);
    const reopened = new JsonSessionStore("s1", file);
    const texts = (await itemsOf(reopened)).map((entry) => textOf(entry));
    assert.deepEqual(texts, ["digest", "recent"], "the compacted history must survive reopen");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("clean store: popItem persists immediately", async () => {
  const dir = freshDir();
  const file = path.join(dir, "s1.json");
  try {
    const store = new JsonSessionStore("s1", file);
    await store.addItems([item("a"), item("b")]);
    store.close();
    const popped = await store.popItem();
    assert.equal(textOf(popped), "b");
    const reopened = new JsonSessionStore("s1", file);
    assert.equal((await itemsOf(reopened)).length, 1, "the pop must survive reopen");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("a failed flush keeps the store dirty and a later close() persists", async () => {
  vi.useFakeTimers();
  try {
    const dir = freshDir();
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x"); // a file where a directory is needed
    const file = path.join(blocker, "s1.json");
    const store = new JsonSessionStore("s1", file);
    await store.addItems([item("a")]);
    await vi.advanceTimersByTimeAsync(2_000); // debounce flush fires and fails
    assert.equal(store.needsFlush, true, "a failed flush must keep the store dirty");
    unlinkSync(blocker); // obstacle removed
    store.close();
    assert.equal(store.needsFlush, false);
    assert.ok(existsSync(file), "the retry on close() must write the file");
    const reopened = new JsonSessionStore("s1", file);
    assert.equal((await itemsOf(reopened)).length, 1);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    vi.useRealTimers();
  }
});

it("rapid mixed mutations land as one coherent final state", async () => {
  const dir = freshDir();
  const file = path.join(dir, "s1.json");
  try {
    const store = new JsonSessionStore("s1", file);
    await store.addItems([item("1"), item("2")]);
    await store.replaceHistoryWithCompaction([item("compact")]);
    await store.clearSession();
    await store.addItems([item("3"), item("4")]);
    store.close();
    const reopened = new JsonSessionStore("s1", file);
    const texts = (await itemsOf(reopened)).map((entry) => textOf(entry));
    assert.deepEqual(texts, ["3", "4"], "the final state is exactly the last two appends");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("compaction survives a reopen (the P0-01 deadlock path)", async () => {
  const dir = freshDir();
  const file = path.join(dir, "s1.json");
  try {
    const store = new JsonSessionStore("s1", file);
    await store.addItems([item("long history")]);
    store.close();
    await store.replaceHistoryWithCompaction([item("digest"), item("kept recent")]);
    const reopened = new JsonSessionStore("s1", file);
    const texts = (await itemsOf(reopened)).map((entry) => textOf(entry));
    assert.deepEqual(texts, ["digest", "kept recent"], "restart must see the compacted history, not the pre-compaction one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("a missing file opens as a fresh empty store without error", async () => {
  const dir = freshDir();
  try {
    const store = new JsonSessionStore("s1", path.join(dir, "never-written.json"));
    assert.deepEqual(await itemsOf(store), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("invalid JSON is preserved aside and reported, never silently reset", () => {
  const dir = freshDir();
  const file = path.join(dir, "s1.json");
  try {
    writeFileSync(file, "{ this is not json");
    assert.throws(() => new JsonSessionStore("s1", file), (error: unknown) => {
      assert.ok(error instanceof SessionStoreCorruptError, "must throw the diagnosable error");
      assert.match(error.message, /SESSION_STORE_CORRUPT/);
      return true;
    });
    const entries = readdirSync(dir);
    assert.equal(entries.filter((name) => name.startsWith("s1.json.corrupt-")).length, 1, "the corrupt file is preserved aside");
    assert.ok(!existsSync(file), "the original path is cleared for a fresh start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("a checksum mismatch is reported instead of trusted", () => {
  const dir = freshDir();
  const file = path.join(dir, "s1.json");
  try {
    writeFileSync(file, JSON.stringify({
      schemaVersion: SESSION_STORE_SCHEMA_VERSION,
      sessionId: "s1",
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "tampered" }] }],
      updatedAt: new Date().toISOString(),
      checksum: "deadbeef"
    }));
    assert.throws(() => new JsonSessionStore("s1", file), /checksum mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("an unsupported schema version is refused loudly", () => {
  const dir = freshDir();
  const file = path.join(dir, "s1.json");
  try {
    writeFileSync(file, JSON.stringify({
      schemaVersion: 99,
      sessionId: "s1",
      items: [],
      updatedAt: new Date().toISOString(),
      checksum: "x"
    }));
    assert.throws(() => new JsonSessionStore("s1", file), /unsupported schema version 99/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the durable envelope carries schema version and a verifying checksum", async () => {
  const dir = freshDir();
  const file = path.join(dir, "s1.json");
  try {
    const store = new JsonSessionStore("s1", file);
    await store.addItems([item("hello")]);
    store.close();
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion: number; sessionId: string; checksum: string; items: AgentInputItem[] };
    assert.equal(onDisk.schemaVersion, SESSION_STORE_SCHEMA_VERSION);
    assert.equal(onDisk.sessionId, "s1");
    assert.ok(typeof onDisk.checksum === "string" && onDisk.checksum.length === 64, "sha256 checksum present");
    assert.equal(onDisk.items.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});