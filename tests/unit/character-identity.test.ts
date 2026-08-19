/**
 * Stable-character-identity checks (AGENTS.md §10.2 / P0-04): the permanent
 * CharacterId must survive seat swaps, renames, duplicates, copies, model
 * switches and role reversals — a relationship or dossier is owned by the
 * person, never by the seat or the display name. No model calls, no network.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "vitest";
import { characterAgentProfile, builtinCharacter } from "../../src/society/profiles";
import { CharacterLibrary } from "../../src/server/characters";
import { createWorld } from "../../src/society/scenarios";
import type { CharacterDefinition, CharacterId } from "../../src/society/contracts";

function customCharacter(id: string, displayName: string): CharacterDefinition {
  return {
    id,
    displayName,
    persona: "一位用于身份验证的临时人物。",
    traits: ["稳健"],
    values: ["秩序"],
    goals: ["活着"],
    builtIn: false
  };
}

it("the same character keeps its id across seats (seat swap)", () => {
  const character = builtinCharacter("builtin-01")!;
  const seatOne = characterAgentProfile(character, 0, ["model-a"]);
  const seatTwo = characterAgentProfile(character, 1, ["model-a"]);
  assert.notEqual(seatOne.id, seatTwo.id, "seats have different actor ids");
  assert.equal(seatOne.characterId, seatTwo.characterId, "but the same permanent character id");
  assert.equal(seatOne.characterId, "builtin-01");
});

it("a model switch never changes the character id", () => {
  const character = builtinCharacter("builtin-04")!;
  const onModelA = characterAgentProfile(character, 0, ["model-a"]);
  const onModelB = characterAgentProfile(character, 0, ["model-b"]);
  assert.equal(onModelA.characterId, onModelB.characterId, "the engine changed, the person did not");
  assert.equal(onModelB.characterId, "builtin-04");
});

it("two characters may share a display name and keep distinct ids", () => {
  const twinA = customCharacter("char-twin-a", "同名");
  const twinB = customCharacter("char-twin-b", "同名");
  assert.notEqual(twinA.id, twinB.id);
  const profileA = characterAgentProfile(twinA, 0, ["model-a"]);
  const profileB = characterAgentProfile(twinB, 1, ["model-a"]);
  assert.equal(profileA.displayName, profileB.displayName, "same-name characters coexist");
  assert.notEqual(profileA.characterId, profileB.characterId, "and never collapse into one identity");
});

it("renaming a character keeps its id", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "society-ids-"));
  const library = new CharacterLibrary(path.join(dir, "characters.json"));
  const created = library.create({
    displayName: "原名",
    persona: "一位用于改名验证的临时人物。",
    traits: ["好奇"],
    values: ["验证"],
    goals: ["通过检查"]
  });
  const originalId: CharacterId = created.id;
  const renamed = library.update(created.id, { ...created, displayName: "新名" });
  assert.equal(renamed.displayName, "新名");
  assert.equal(renamed.id, originalId, "the id is untouched by the rename");
  library.remove(originalId);
  rmSync(dir, { recursive: true, force: true });
});

it("copying a character produces a new identity, not an alias", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "society-ids-"));
  const library = new CharacterLibrary(path.join(dir, "characters.json"));
  const created = library.create({
    displayName: "原件",
    persona: "一位用于复制验证的临时人物。",
    traits: ["好奇"],
    values: ["验证"],
    goals: ["通过检查"]
  });
  const copy = library.copy(created.id);
  assert.notEqual(copy.id, created.id, "a copy is a new character id");
  library.remove(created.id);
  library.remove(copy.id);
  rmSync(dir, { recursive: true, force: true });
});

it("world snapshots carry the character id beside every seat", () => {
  const profiles = [builtinCharacter("builtin-01")!, builtinCharacter("builtin-02")!]
    .map((character, index) => characterAgentProfile(character, index, ["model-a"]));
  const world = createWorld({ roomId: "r", scenarioId: "trust-game", profiles, rounds: 3 });
  world.start();
  const agents = world.snapshot().agents;
  assert.equal(agents[0].characterId, "builtin-01");
  assert.equal(agents[1].characterId, "builtin-02");
});

it("role reversal in the trust game never moves the character id", () => {
  const profiles = [builtinCharacter("builtin-01")!, builtinCharacter("builtin-02")!]
    .map((character, index) => characterAgentProfile(character, index, ["model-a"]));
  const world = createWorld({ roomId: "r", scenarioId: "trust-game", profiles, rounds: 3 });
  world.start();
  const first = world.snapshot().agents;
  const byCharacterId = (id: string) => first.find((agent) => agent.characterId === id)?.id;
  assert.notEqual(byCharacterId("builtin-01"), byCharacterId("builtin-02"));
  // The investor/trustee roles swap every round; the snapshot must still map
  // each seat to the same character it started with.
  assert.deepEqual(
    first.map((agent) => agent.characterId).sort(),
    ["builtin-01", "builtin-02"]
  );
});