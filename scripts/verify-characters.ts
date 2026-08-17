/**
 * Character-library checks (run with `npx tsx scripts/verify-characters.ts`).
 * Pins §7.1/§7.2: built-in roster integrity, character→seat profile mapping,
 * and the local library CRUD / roster resolution. No model calls, no network.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinCharacter, builtinCharacters, characterAgentProfile } from "../src/society/profiles";
import { CharacterLibrary } from "../src/server/characters";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const tempDir = mkdtempSync(path.join(tmpdir(), "society-characters-"));
const library = new CharacterLibrary(path.join(tempDir, "characters.json"));

check("built-in roster is complete and every character is a full definition", () => {
  const characters = builtinCharacters();
  assert.equal(characters.length, 25, "25 built-ins");
  for (const character of characters) {
    assert.ok(character.builtIn, `${character.id} is builtIn`);
    assert.ok(character.displayName.length > 0, `${character.id} named`);
    assert.ok(character.persona.length >= 4, `${character.displayName} persona`);
    assert.ok(character.traits.length >= 1, `${character.displayName} traits`);
    assert.ok(character.values.length >= 1, `${character.displayName} values`);
    assert.ok(character.goals.length >= 1, `${character.displayName} goals`);
    assert.ok(character.decisionBiases && character.decisionBiases.length >= 1, `${character.displayName} biases`);
    assert.ok(character.autobiographicalAnchors && character.autobiographicalAnchors.length >= 4, `${character.displayName} anchors`);
  }
  assert.equal(new Set(characters.map((entry) => entry.id)).size, characters.length, "ids unique");
});

check("built-in ids are position-stable and resolvable", () => {
  assert.equal(builtinCharacter("builtin-01")?.displayName, "林默");
  assert.equal(builtinCharacter("builtin-25")?.displayName, "黎光");
  assert.equal(builtinCharacter("builtin-99"), undefined);
  assert.equal(builtinCharacter("char-xyz"), undefined);
});

check("character→seat profile keeps the person and round-robins models", () => {
  const character = builtinCharacter("builtin-04")!;
  const profile = characterAgentProfile(character, 0, ["model-a", "model-b"]);
  assert.equal(profile.id, "agent-01");
  assert.equal(profile.model, "model-a");
  assert.equal(profile.displayName, character.displayName);
  assert.deepEqual(profile.decisionBiases, character.decisionBiases);
  assert.deepEqual(profile.autobiographicalAnchors, character.autobiographicalAnchors);
  const second = characterAgentProfile(character, 1, ["model-a", "model-b"]);
  assert.equal(second.model, "model-b", "round-robin continues");
  assert.equal(second.id, "agent-02");
});

check("library create / copy / update / delete round-trip", () => {
  const created = library.create({
    displayName: "验客",
    persona: "一位只存在于验证脚本里的访客。",
    traits: ["好奇"],
    values: ["验证"],
    goals: ["通过检查"],
    decisionBiases: ["recency-weighting"],
    autobiographicalAnchors: ["曾经在一次验证中失败，从此更谨慎。"]
  });
  assert.equal(created.builtIn, false);
  assert.ok(created.id.startsWith("char-"), "custom ids are namespaced");
  const copy = library.copy(created.id);
  assert.notEqual(copy.id, created.id);
  assert.equal(copy.displayName, "验客2", "copy gets a unique name");
  const updated = library.update(created.id, { ...created, persona: "更新后的底色文字。" });
  assert.equal(updated.persona, "更新后的底色文字。");
  library.remove(created.id);
  library.remove(copy.id);
  assert.equal(library.list().customs.length, 0);
});

check("roster resolves picks, falls back to built-ins, and rejects unknown ids", () => {
  const custom = library.create({
    displayName: "新人甲",
    persona: "一位用于阵容解析验证的临时人物。",
    traits: ["稳健"],
    values: ["秩序"],
    goals: ["活着"]
  });
  const roster = library.roster([custom.id, "builtin-02"], 4);
  assert.equal(roster.length, 4);
  assert.equal(roster[0].id, custom.id);
  assert.equal(roster[1].displayName, "苏遥");
  assert.equal(roster[2].builtIn, true, "remaining seats fall back to built-ins");
  assert.throws(() => library.roster(["char-missing-000"], 2), /CHARACTER_NOT_FOUND/);
  library.remove(custom.id);
});

rmSync(tempDir, { recursive: true, force: true });
console.log(`\nCharacter-library checks: ${passed} passed.`);