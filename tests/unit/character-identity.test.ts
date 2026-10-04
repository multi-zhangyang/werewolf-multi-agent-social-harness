import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "vitest";
import { builtinCharacter } from "../../src/society/profiles";
import { CharacterLibrary } from "../../src/server/characters";
import { EconomicScenario } from "../../src/runtime/scenarios/economic";
import { runtimeCharacter } from "../../src/server/routes/runs";
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

it("two characters may share a display name and keep distinct ids", () => {
  const twinA = customCharacter("char-twin-a", "同名");
  const twinB = customCharacter("char-twin-b", "同名");
  assert.notEqual(twinA.id, twinB.id);
  const profileA = runtimeCharacter(twinA);
  const profileB = runtimeCharacter(twinB);
  assert.equal(profileA.name, profileB.name, "same-name characters coexist");
  assert.notEqual(profileA.id, profileB.id, "and never collapse into one identity");
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

it("trust roles reverse without changing character identities", () => {
 const characters=[builtinCharacter("builtin-01")!,builtinCharacter("builtin-02")!].map(runtimeCharacter);
 const world=new EconomicScenario("trust-game",characters,2);
 assert.ok(world.observe(characters[0].id).includes("本轮林默为投资者"));
 world.advance(); world.apply(characters[0].id,"invest",{amount:5}); world.advance(); world.advance(); world.apply(characters[1].id,"return_funds",{amount:9}); world.advance(); world.advance();
 assert.ok(world.observe(characters[0].id).includes("本轮苏遥为投资者"));
 assert.equal(world.characters[0].id,"builtin-01");
});
