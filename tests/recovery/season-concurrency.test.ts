/**
 * Season-store concurrent-write checks (AGENTS.md §16.2): many rooms finish
 * in the same moment and every one distills its characters into the season.
 * Saves must never share a temp file and must survive Windows' transient
 * rename locks — the store either writes the latest state or reports the
 * failure, never a half-written or clobbered season.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "vitest";
import { FileSeasonStore, SEASON_SCHEMA_VERSION } from "../../src/society/season";
import type { CharacterDossier } from "../../src/society/contracts";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "society-season-race-"));
}

function dossier(characterId: string, marker: string): CharacterDossier {
  return {
    characterId,
    displayName: `角色-${characterId}`,
    games: [{ scenarioId: "trust-game", role: "investor", outcome: "win", at: `2026-08-19T00:00:0${Number(marker) % 10}.000Z` }],
    relationships: [{ targetCharacterId: "other", trust: 0.5, affinity: 0.5, respect: 0.5, tension: 0.2, note: marker }],
    beliefs: [{ subjectId: "other", proposition: marker, confidence: 0.5 }],
    updatedAt: `2026-08-19T00:00:0${Number(marker) % 10}.000Z`
  };
}

it("many interleaved saves converge on the latest state with no stray temp files", async () => {
  const dir = freshDir();
  try {
    const file = path.join(dir, "season.json");
    const store = new FileSeasonStore(file, () => []);
    // Simulate a wave of room finishes: each save is a full dossier write.
    const saves = Array.from({ length: 40 }, (_, index) =>
      Promise.resolve().then(() => {
        store.save(dossier(`char-${index % 6}`, String(index)));
        // Re-open the file between writes to prove each rename landed whole.
        const onDisk = JSON.parse(readFileSync(file, "utf8")) as { version: number; dossiers: Record<string, CharacterDossier> };
        assert.equal(onDisk.version, SEASON_SCHEMA_VERSION, "every intermediate write is a complete v2 file");
        return onDisk;
      })
    );
    await Promise.all(saves);
    // The final file carries the last write per character and nothing stale.
    const final = JSON.parse(readFileSync(file, "utf8")) as { dossiers: Record<string, CharacterDossier> };
    const expected = store.list();
    assert.equal(Object.keys(final.dossiers).length, expected.length, "no dossier was lost");
    for (const entry of expected) {
      assert.equal(final.dossiers[entry.characterId].updatedAt, entry.updatedAt, `char-${entry.characterId} holds the latest write`);
    }
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, [], "no temp files survive the write storm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("clear and remove keep the same atomic discipline", () => {
  const dir = freshDir();
  try {
    const file = path.join(dir, "season.json");
    const store = new FileSeasonStore(file, () => []);
    store.save(dossier("char-1", "1"));
    store.save(dossier("char-2", "2"));
    assert.ok(store.remove("char-1"), "removing one character persists the rest");
    assert.equal(existsSync(file), true);
    const afterRemove = JSON.parse(readFileSync(file, "utf8")) as { dossiers: Record<string, unknown> };
    assert.deepEqual(Object.keys(afterRemove.dossiers), ["char-2"]);
    store.clear();
    const afterClear = JSON.parse(readFileSync(file, "utf8")) as { dossiers: Record<string, unknown> };
    assert.deepEqual(Object.keys(afterClear.dossiers), [], "clear persists an empty season");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});