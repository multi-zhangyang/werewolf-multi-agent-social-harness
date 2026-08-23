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
      participants: [{
        profile: { id: "agent-01", displayName: "林默", model: "model-a", characterId: "c-1", controller: "agent" }
      }]
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