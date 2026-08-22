/**
 * Season-store migration checks (AGENTS.md §10.2 / P0-04): a v1 season file
 * keyed by display name must migrate to stable character ids — only a UNIQUE
 * name match is adopted; ambiguous or unknown names are isolated and reported
 * instead of being merged into someone else's history.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "vitest";
import { FileSeasonStore, SEASON_SCHEMA_VERSION } from "../../src/society/season";
import type { CharacterDossier } from "../../src/society/contracts";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "society-season-"));
}

/** A simulated v1 dossier: keyed and self-labeled by display name. */
function v1Dossier(displayName: string, trust = 0.8): Record<string, unknown> {
  return {
    characterKey: displayName,
    games: [{ scenarioId: "trust-game", role: "investor", outcome: "win", at: "2026-08-01T00:00:00.000Z" }],
    relationships: [{ agentId: "someone", trust, affinity: 0.5, respect: 0.5, tension: 0.2, note: "v1" }],
    beliefs: [],
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
}

function v1File(dir: string, dossiers: Record<string, unknown>): string {
  const file = path.join(dir, "season.json");
  writeFileSync(file, JSON.stringify({ version: 1, updatedAt: "2026-08-01T00:00:00.000Z", dossiers }));
  return file;
}

it("a v1 file migrates a uniquely-matching display name to its character id", () => {
  const dir = freshDir();
  try {
    const file = v1File(dir, { "林默": v1Dossier("林默") });
    const store = new FileSeasonStore(file, (name) => (name === "林默" ? ["builtin-01"] : []));
    const migrated = store.get("builtin-01");
    assert.ok(migrated, "the unique match is adopted under its character id");
    assert.equal(migrated.characterId, "builtin-01");
    assert.equal(migrated.displayName, "林默");
    assert.equal(migrated.games.length, 1, "history is preserved through the migration");
    assert.equal(store.listIsolated().length, 0);
    // The migrated shape is persisted as v2, and the v1 original is backed up.
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { version: number };
    assert.equal(onDisk.version, SEASON_SCHEMA_VERSION);
    const backups = readdirSync(dir).filter((name) => name.includes(".v1-backup-"));
    assert.equal(backups.length, 1, "the pre-migration file is preserved once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("an ambiguous display name is isolated, never merged into one identity", () => {
  const dir = freshDir();
  try {
    const file = v1File(dir, { "同名": v1Dossier("同名") });
    const store = new FileSeasonStore(file, () => ["char-twin-a", "char-twin-b"]);
    assert.equal(store.list().length, 0, "no character silently inherits an ambiguous history");
    const isolated = store.listIsolated();
    assert.equal(isolated.length, 1);
    assert.equal(isolated[0].legacyKey, "同名");
    assert.equal(isolated[0].reason, "ambiguous");
    assert.deepEqual(isolated[0].candidateIds, ["char-twin-a", "char-twin-b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("an unknown display name is isolated and reported", () => {
  const dir = freshDir();
  try {
    const file = v1File(dir, { "无名氏": v1Dossier("无名氏") });
    const store = new FileSeasonStore(file, () => []);
    assert.equal(store.list().length, 0);
    const isolated = store.listIsolated();
    assert.equal(isolated[0].legacyKey, "无名氏");
    assert.equal(isolated[0].reason, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("v2 dossiers round-trip by character id, including the isolated report", () => {
  const dir = freshDir();
  try {
    const file = path.join(dir, "season.json");
    const store = new FileSeasonStore(file, () => ["builtin-01"]);
    store.save({
      characterId: "builtin-01",
      displayName: "林默",
      games: [{ scenarioId: "werewolf", role: "wolf", outcome: "lose", at: "2026-08-02T00:00:00.000Z" }],
      relationships: [],
      beliefs: [],
      updatedAt: "2026-08-02T00:00:00.000Z"
    });
    const reopened = new FileSeasonStore(file, () => ["builtin-01"]);
    assert.equal(reopened.get("builtin-01")?.displayName, "林默");
    assert.equal(reopened.get("builtin-01")?.games.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("remove and clear are keyed by character id", () => {
  const dir = freshDir();
  try {
    const file = path.join(dir, "season.json");
    const store = new FileSeasonStore(file, () => []);
    const dossier = (id: string, name: string): CharacterDossier => ({
      characterId: id,
      displayName: name,
      games: [],
      relationships: [],
      beliefs: [],
      updatedAt: "2026-08-01T00:00:00.000Z"
    });
    store.save(dossier("builtin-01", "林默"));
    store.save(dossier("builtin-02", "苏遥"));
    assert.equal(store.remove("builtin-01"), true);
    assert.equal(store.get("builtin-01"), undefined);
    assert.ok(store.get("builtin-02"), "the other character keeps their history");
    store.clear();
    assert.equal(store.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("a missing season file is a fresh season, not an error", () => {
  const dir = freshDir();
  try {
    const store = new FileSeasonStore(path.join(dir, "never.json"), () => []);
    assert.equal(store.list().length, 0);
    assert.equal(existsSync(path.join(dir, "never.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});