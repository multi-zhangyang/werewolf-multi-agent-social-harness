/**
 * Archive contract (opt-in persistence): a room with an archiveSink hands
 * its finished state over exactly once — omniscient room for the owner,
 * postgame public room for everyone else, token-stream-free envelopes for the
 * static replay — and the disk layer (write/list/read/delete + owner hash)
 * round-trips it. Deterministic, no model calls.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ScriptedModel } from "@openai/agents/testing";
import { ActivationLimiter } from "../../src/society/activation-limiter";
import { clearFastTurns, installFastTurns, testRoom, twoRoundScript, waitFor } from "../helpers/scripted-room";
import type { SocietyRoomArchive } from "../../src/society/room";
import {
  deleteRoomArchive,
  isArchiveOwner,
  listRoomArchives,
  readRoomArchive,
  writeRoomArchive
} from "../../src/server/archives";
import { StorageHealth } from "../../src/server/storage";

let tempDir: string;
const previousDir = process.env.SOCIETY_ARCHIVE_DIR;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "society-archives-"));
  process.env.SOCIETY_ARCHIVE_DIR = tempDir;
});

afterAll(async () => {
  if (previousDir === undefined) delete process.env.SOCIETY_ARCHIVE_DIR;
  else process.env.SOCIETY_ARCHIVE_DIR = previousDir;
  await rm(tempDir, { recursive: true, force: true });
});

it("a finished room with a sink produces one archive with the right information boundaries", async () => {
  installFastTurns();
  const archives: SocietyRoomArchive[] = [];
  const limiter = new ActivationLimiter(1);
  const { room, cleanup } = testRoom(new ScriptedModel(twoRoundScript()), limiter, {
    archiveSink: (archive) => archives.push(archive)
  });
  try {
    void room.start();
    await waitFor(() => room.currentStatus() === "finished", 30_000);
    await waitFor(() => archives.length === 1, 5_000);

    const archive = archives[0]!;
    expect(archive.schemaVersion).toBe(1);
    expect(archive.scenarioId).toBe("trust-game");
    // The hash matches the owner token the room issued at creation.
    const ownerToken = room.creationResult().ownerToken;
    expect(archive.ownerTokenHash).toBe(createHash("sha256").update(ownerToken).digest("hex"));

    // Owner seat: full minds. Public seat: the world stays, the minds do not.
    expect(archive.room.participants.every((participant) => participant.mind !== undefined)).toBe(true);
    expect(archive.publicRoom.participants.every((participant) => participant.mind === undefined)).toBe(true);
    // The postgame public room still reveals the finished world's roles.
    expect(archive.publicRoom.world.status).toBe("finished");

    // Envelopes carry the presentation stream, never token deltas or snapshots.
    const types = new Set(archive.envelopes.map((envelope) => envelope.event.type));
    expect(types.has("world.action") || types.has("agent.tool")).toBe(true);
    expect(types.has("agent.delta")).toBe(false);
    expect(types.has("agent.reasoning-content")).toBe(false);
    expect(types.has("world.updated")).toBe(false);

    // A room WITHOUT a sink writes nothing — the zero-disk default.
    const bare = new ActivationLimiter(1);
    const plain = testRoom(new ScriptedModel(twoRoundScript()), bare);
    try {
      void plain.room.start();
      await waitFor(() => plain.room.currentStatus() === "finished", 30_000);
      // No sink was provided, so there is nothing to await; the assertion is
      // simply that nothing crashed and no file appeared for this room.
      expect(await readRoomArchive(plain.room.id)).toBeUndefined();
    } finally {
      plain.cleanup();
      clearFastTurns();
    }
  } finally {
    cleanup();
  }
});

it("the disk layer round-trips: write, list, owner check, read, delete", async () => {
  const archive = {
    schemaVersion: 1,
    id: "room_test-archive-0001",
    scenarioId: "werewolf",
    title: "测试归档",
    createdAt: "2026-08-29T10:00:00.000Z",
    finishedAt: "2026-08-29T10:30:00.000Z",
    ownerTokenHash: createHash("sha256").update("correct-token").digest("hex"),
    room: { id: "room_test-archive-0001" },
    publicRoom: { id: "room_test-archive-0001" },
    envelopes: []
  } as unknown as SocietyRoomArchive;

  await writeRoomArchive(archive);
  expect((await readdir(tempDir)).some((entry) => entry.endsWith(".tmp"))).toBe(false);

  const list = await listRoomArchives();
  expect(list.find((meta) => meta.id === archive.id)?.title).toBe("测试归档");

  const loaded = await readRoomArchive(archive.id);
  expect(loaded?.ownerTokenHash).toBe(archive.ownerTokenHash);
  expect(isArchiveOwner(loaded!, "correct-token")).toBe(true);
  expect(isArchiveOwner(loaded!, "wrong-token")).toBe(false);
  expect(isArchiveOwner(loaded!, undefined)).toBe(false);

  expect(await deleteRoomArchive(archive.id)).toBe(true);
  expect(await readRoomArchive(archive.id)).toBeUndefined();
  expect(await deleteRoomArchive(archive.id)).toBe(false);
});

it("a corrupt archive is quarantined and degrades health without breaking the list", async () => {
  const file = join(tempDir, "room_corrupt-archive.json");
  await writeFile(file, "{broken-json", "utf8");
  const health = new StorageHealth();
  const list = await listRoomArchives(health);
  expect(Array.isArray(list)).toBe(true);
  expect(health.snapshot()).toEqual({
    status: "degraded",
    issues: [{ store: "archives", code: "CORRUPT_FILE_QUARANTINED" }]
  });
  expect((await readdir(tempDir)).some((entry) => entry.startsWith("room_corrupt-archive.corrupt-"))).toBe(true);
});

it("path-traversal ids are rejected by every disk operation", async () => {
  const evil = { ...({} as SocietyRoomArchive), id: "../../etc/passwd", schemaVersion: 1 as const };
  await expect(writeRoomArchive(evil)).rejects.toThrow(/ARCHIVE_ID_INVALID/);
  expect(await readRoomArchive("../../etc/passwd")).toBeUndefined();
  expect(await deleteRoomArchive("..\\windows\\system32")).toBe(false);
});
