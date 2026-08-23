/**
 * Room archive summary fast path (AGENTS.md §31): the landing room list must
 * never parse full checkpoints — save() writes a tiny summary beside each
 * checkpoint and list() reads only those; legacy rooms without a summary are
 * parsed once and get a summary written back.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { RoomArchiveStore as RoomArchive, type RoomCheckpoint } from "../../src/society/persistence/room-archive";

function checkpoint(roomId: string, overrides: Partial<RoomCheckpoint> = {}): RoomCheckpoint {
  return {
    roomId,
    archivedAt: "2026-08-23T00:00:00.000Z",
    status: "finished",
    snapshot: {
      id: roomId,
      scenarioId: "trust-game",
      title: "信任博弈",
      mode: "ai",
      seasonMode: "one-shot",
      status: "finished",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      world: { messages: [{ id: "m1" }], log: [{ id: "l1" }] },
      participants: [
        { profile: { id: "agent-01", displayName: "林默", model: "model-a", characterId: "c-1", controller: "agent" } },
        { profile: { id: "agent-02", displayName: "苏遥", model: "model-a", characterId: "c-2", controller: "agent" } }
      ]
    } as unknown as RoomCheckpoint["snapshot"],
    envelopes: [],
    agentMinds: {},
    sessionFiles: {},
    ...overrides
  };
}

describe("room archive summaries", () => {
  it("save writes a summary and list reads it without touching the checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      const archive = new RoomArchive(dir);
      archive.save(checkpoint("room-a"));
      assert.ok(existsSync(join(dir, "room-a", "summary.json")), "a summary file is written at save time");
      const listed = archive.list();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].roomId, "room-a");
      assert.equal(listed[0].title, "信任博弈");
      assert.equal(listed[0].participants[0].displayName, "林默");
      // list() must work even if the checkpoint is gone — it only reads summaries.
      rmSync(join(dir, "room-a", "checkpoint.json"));
      assert.equal(archive.list().length, 1, "the list still serves from the summary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacy rooms without a summary are parsed once and get one written back", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      mkdirSync(join(dir, "room-legacy"));
      writeFileSync(join(dir, "room-legacy", "checkpoint.json"), JSON.stringify(checkpoint("room-legacy")));
      const archive = new RoomArchive(dir);
      const listed = archive.list();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].scenarioId, "trust-game");
      assert.ok(existsSync(join(dir, "room-legacy", "summary.json")), "the legacy summary is materialized");
      assert.equal(archive.list()[0].roomId, "room-legacy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a corrupt checkpoint is skipped from the list but stays operator-visible via diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      mkdirSync(join(dir, "room-bad"));
      writeFileSync(join(dir, "room-bad", "checkpoint.json"), "{ not json");
      const archive = new RoomArchive(dir);
      assert.equal(archive.list().length, 0, "the corrupt room is not in the landing list");
      assert.equal(archive.diagnostics().length, 1, "the corruption is recorded as a failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("summary staleness never masks a newer checkpoint save", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      const archive = new RoomArchive(dir);
      archive.save(checkpoint("room-a", { status: "running" }));
      archive.save(checkpoint("room-a", { status: "finished" }));
      const listed = archive.list();
      assert.equal(listed[0].status, "finished", "the latest save's summary wins");
      const onDisk = JSON.parse(readFileSync(join(dir, "room-a", "summary.json"), "utf8"));
      assert.equal(onDisk.status, "finished");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("restart recovery candidates (interrupted)", () => {
  it("summaries carry the recovery pre-filter fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      const archive = new RoomArchive(dir);
      archive.save(checkpoint("room-a", {
        status: "paused",
        recoverable: true,
        profiles: [{ id: "a1" }, { id: "a2" }] as RoomCheckpoint["profiles"],
        worldState: { phase: "mid" } as unknown as RoomCheckpoint["worldState"]
      }));
      const onDisk = JSON.parse(readFileSync(join(dir, "room-a", "summary.json"), "utf8"));
      assert.equal(onDisk.mode, "ai");
      assert.equal(onDisk.recoverable, true);
      assert.equal(onDisk.profileCount, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("terminal rooms are never parsed — only real candidates are read", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      const archive = new RoomArchive(dir);
      // A genuinely interrupted, recoverable room.
      archive.save(checkpoint("room-live", {
        status: "paused",
        recoverable: true,
        profiles: [{ id: "a1" }, { id: "a2" }] as RoomCheckpoint["profiles"],
        worldState: { phase: "mid" } as unknown as RoomCheckpoint["worldState"]
      }));
      // A finished room whose checkpoint is deleted afterwards: if
      // interrupted() tried to parse it, it would just be skipped — but the
      // contract is that it is filtered out by its summary alone.
      archive.save(checkpoint("room-done", { status: "finished" }));
      rmSync(join(dir, "room-done", "checkpoint.json"));
      const candidates = archive.interrupted();
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].roomId, "room-live");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disposed and human-mode rooms are excluded by their summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      const archive = new RoomArchive(dir);
      archive.save(checkpoint("room-disposed", {
        status: "paused",
        recoverable: false,
        profiles: [{ id: "a1" }, { id: "a2" }] as RoomCheckpoint["profiles"],
        worldState: { phase: "mid" } as unknown as RoomCheckpoint["worldState"]
      }));
      archive.save(checkpoint("room-human", {
        status: "running",
        recoverable: true,
        profiles: [{ id: "a1" }, { id: "a2" }] as RoomCheckpoint["profiles"],
        worldState: { phase: "mid" } as unknown as RoomCheckpoint["worldState"],
        snapshot: { ...checkpoint("room-human").snapshot, mode: "human" } as RoomCheckpoint["snapshot"]
      }));
      assert.equal(archive.interrupted().length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a legacy summary without recovery fields falls back to the checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      const archive = new RoomArchive(dir);
      archive.save(checkpoint("room-legacy", {
        status: "paused",
        recoverable: true,
        profiles: [{ id: "a1" }, { id: "a2" }] as RoomCheckpoint["profiles"],
        worldState: { phase: "mid" } as unknown as RoomCheckpoint["worldState"]
      }));
      // Strip the newer summary fields, as an old archive would look.
      const summaryPath = join(dir, "room-legacy", "summary.json");
      const legacy = JSON.parse(readFileSync(summaryPath, "utf8"));
      delete legacy.recoverable;
      delete legacy.mode;
      delete legacy.profileCount;
      writeFileSync(summaryPath, JSON.stringify(legacy));
      const candidates = archive.interrupted();
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].roomId, "room-legacy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("archive retention (reap)", () => {
  it("keeps the newest terminal rooms and deletes the oldest beyond the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      const archive = new RoomArchive(dir);
      for (let index = 0; index < 5; index += 1) {
        archive.save(checkpoint(`room-${index}`, {
          status: "finished",
          archivedAt: `2026-08-2${index}T00:00:00.000Z`
        }));
      }
      const removed = archive.reap({ maxRooms: 2 });
      assert.deepEqual(removed.map((entry) => entry.roomId), ["room-2", "room-1", "room-0"]);
      assert.ok(!existsSync(join(dir, "room-0")), "the oldest room directory is deleted");
      assert.ok(!existsSync(join(dir, "room-2")), "only the newest two survive the cap");
      assert.ok(existsSync(join(dir, "room-4")), "the newest rooms survive");
      assert.equal(archive.list().length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never reaps recoverable rooms, even beyond the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      const archive = new RoomArchive(dir);
      archive.save(checkpoint("room-interrupted", {
        status: "paused",
        recoverable: true,
        profiles: [{ id: "a1" }, { id: "a2" }] as RoomCheckpoint["profiles"],
        worldState: { phase: "mid" } as unknown as RoomCheckpoint["worldState"]
      }));
      // Legacy paused room without a recoverable flag: presumed recoverable.
      archive.save(checkpoint("room-legacy", { status: "paused" }));
      archive.save(checkpoint("room-done", { status: "finished" }));
      const removed = archive.reap({ maxRooms: 0 });
      // Only the finished room may be reaped at cap 0.
      assert.deepEqual(removed.map((entry) => entry.roomId), ["room-done"]);
      assert.ok(existsSync(join(dir, "room-interrupted")));
      assert.ok(existsSync(join(dir, "room-legacy")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaps explicitly disposed rooms (recoverable=false), including paused ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "society-archive-"));
    try {
      const archive = new RoomArchive(dir);
      archive.save(checkpoint("room-disposed-running", {
        status: "paused",
        recoverable: false,
        profiles: [{ id: "a1" }, { id: "a2" }] as RoomCheckpoint["profiles"],
        worldState: { phase: "mid" } as unknown as RoomCheckpoint["worldState"]
      }));
      const removed = archive.reap({ maxRooms: 0 });
      assert.deepEqual(removed.map((entry) => entry.roomId), ["room-disposed-running"]);
      assert.ok(!existsSync(join(dir, "room-disposed-running")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});