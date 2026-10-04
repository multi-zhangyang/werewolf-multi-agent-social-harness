import { describe, expect, it } from "vitest";
import { WerewolfScenario, shuffled } from "../../src/runtime/scenarios/werewolf";
import { deckForPlayerCount, isWolfRole } from "../../src/society/scenarios/werewolf/roles";
import type { Character } from "../../src/runtime/types";

function board(n = 10) {
  const characters: Character[] = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `人${i}`, persona: "", values: [], goals: [], voice: "" }));
  const roles = shuffled(deckForPlayerCount(n).roles, 42);
  const world = new WerewolfScenario(characters, 2, 42);
  const id = (role: string) => characters[roles.indexOf(role as typeof roles[number])].id;
  return { world, id, characters, roles };
}
function skipElection(world: WerewolfScenario) { for (const id of world.stage()!.actors) world.apply(id, "run_for_sheriff", { run: false }); world.advance(); }
function vote(world: WerewolfScenario, target: string) { for (const id of world.stage()!.actors) world.apply(id, "vote", { targetId: target }); return world.advance(); }
function night(world: WerewolfScenario, wolfVictim: string) {
  while (world.stage()?.label === "遗言") world.advance();
  expect(world.stage()?.label).toBe("狼队交流"); world.advance();
  for (const id of world.stage()!.actors) world.apply(id, "attack", { targetId: wolfVictim }); world.advance();
}
describe("werewolf rules independent of agents", () => {
  it("seals votes, preserves idiot immunity and removes their voting right", () => {
    const { world, id } = board(); skipElection(world); world.advance();
    expect(world.stage()?.label).toBe("投票中");
    for (const actor of world.stage()!.actors) expect(world.apply(actor, "vote", { targetId: id("idiot") })[0].visibility).toEqual([actor]);
    const result = world.advance();
    expect(result.some(e => e.text.includes("免死"))).toBe(true);
    expect(world.publicState().alive).toContain(id("idiot"));
  });
  it("reveals the hidden wolf as villager only to the seer, and guards cannot repeat targets", () => {
    const { world, id } = board(11); skipElection(world); world.advance(); vote(world, id("villager")); night(world, id("seer"));
    const result = world.apply(id("seer"), "inspect", { targetId: id("hidden-wolf") });
    expect(result[1].data.role).toBe("villager"); expect(result[1].visibility).toEqual([id("seer")]);
    world.apply(id("guard"), "guard", { targetId: id("seer") });
    world.apply(id("wolf-beauty"), "charm", { targetId: null });
    world.apply(id("spirit-seer"), "inspect_dead", { targetId: id("villager") });
    world.advance(); world.apply(id("witch"), "potion", { choice: "pass" }); world.advance(); world.advance();
    world.advance(); vote(world, id("hidden-wolf")); night(world, id("seer"));
    expect(() => world.apply(id("guard"), "guard", { targetId: id("seer") })).toThrow();
  });
  it("applies guard plus antidote cancellation and disallows witch self-save", () => {
    const { world, id } = board(9); skipElection(world); world.advance(); vote(world, id("villager")); night(world, id("seer"));
    world.apply(id("guard"), "guard", { targetId: id("seer") }); world.apply(id("seer"), "inspect", { targetId: id("wolf") }); world.advance();
    world.apply(id("witch"), "potion", { choice: "save" }); const events = world.advance();
    expect(events.some(e => e.data.actorId === id("seer") && e.data.cause === "night")).toBe(true);
    const second = board(9); skipElection(second.world); second.world.advance(); vote(second.world, second.id("villager")); night(second.world, second.id("witch"));
    second.world.apply(second.id("guard"), "guard", { targetId: null }); second.world.apply(second.id("seer"), "inspect", { targetId: second.id("wolf") }); second.world.advance();
    expect(() => second.world.apply(second.id("witch"), "potion", { choice: "save" })).toThrow();
  });
  it("elects sheriff and lets a poisoned hunter die without firing", () => {
    const { world, id } = board(9);
    for (const actor of world.stage()!.actors) world.apply(actor, "run_for_sheriff", { run: actor === id("seer") });
    world.advance(); expect(world.publicState().sheriff).toBe(id("seer")); world.advance(); vote(world, id("villager")); night(world, id("guard"));
    world.apply(id("guard"), "guard", { targetId: id("guard") }); world.apply(id("seer"), "inspect", { targetId: id("wolf") }); world.advance();
    world.apply(id("witch"), "potion", { choice: `poison:${id("hunter")}` }); world.advance();
    expect(world.stage()?.label).not.toBe("开枪决定"); expect(world.publicState().alive).not.toContain(id("hunter"));
  });
  it("re-votes once on a tie and then eliminates nobody", () => {
    const { world, characters } = board(6); skipElection(world); world.advance();
    characters.forEach((c, i) => world.apply(c.id, "vote", { targetId: characters[i % 2].id })); world.advance();
    expect(world.stage()?.label).toBe("平票陈词"); world.advance();
    const voters = world.stage()!.actors; expect(voters).toHaveLength(4);
    voters.forEach((id, i) => world.apply(id, "vote", { targetId: characters[i % 2].id })); world.advance();
    expect(world.publicState().alive).toHaveLength(6); expect(world.stage()?.label).toBe("狼队交流");
  });
  it("enforces pack-only team communication without leaking roles publicly", () => {
    const { world, characters, roles } = board(6); skipElection(world); world.advance();
    const village = characters.find((_, i) => !isWolfRole(roles[i]))!.id;
    vote(world, village); night(world, characters.find((c, i) => c.id !== village && !isWolfRole(roles[i]))!.id);
    expect(world.canMessage(village, "team", [characters[0].id])).toBe(false);
    expect(world.publicState()).not.toHaveProperty("roles");
  });
  it("only grants idiot immunity once and gives a voted-out jester no last words", () => {
    const { world, id } = board(); skipElection(world); world.advance(); vote(world, id("idiot")); night(world, id("seer"));
    world.apply(id("guard"), "guard", { targetId: id("seer") }); world.apply(id("seer"), "inspect", { targetId: id("wolf") }); world.apply(id("nightmare"), "curse", { targetId: null });
    world.advance(); world.apply(id("witch"), "potion", { choice: "pass" }); world.advance(); world.advance(); world.advance();
    expect(world.stage()?.actors).not.toContain(id("idiot")); vote(world, id("idiot"));
    expect(world.publicState().alive).not.toContain(id("idiot")); expect(world.stage()?.turnLimit).toBe(1);
    const j = board(8); skipElection(j.world); j.world.advance();
    expect(vote(j.world, j.id("jester")).some(e => e.data.winner === j.id("jester"))).toBe(true);
    expect(j.world.stage()?.label).toBe("狼队交流");
  });
  it("resolves badge, last words and hunter/wolf-king shots before checking the winning side", () => {
    const { world, id } = board();
    for (const actor of world.stage()!.actors) world.apply(actor, "run_for_sheriff", { run: actor === id("hunter") });
    world.advance(); world.advance(); vote(world, id("hunter"));
    expect(world.stage()?.label).toBe("移交警徽"); world.apply(id("hunter"), "pass_badge", { targetId: id("seer") });
    expect(world.stage()?.label).toBe("遗言"); world.advance();
    expect(world.stage()?.label).toBe("开枪决定"); world.apply(id("hunter"), "shoot", { targetId: id("wolf-king") });
    expect(world.stage()?.actors).toEqual([id("wolf-king")]); world.apply(id("wolf-king"), "shoot", { targetId: id("seer") });
    expect(world.stage()?.label).toBe("移交警徽"); world.apply(id("seer"), "pass_badge", { targetId: null });
    expect(world.stage()?.label).toBe("狼队交流"); expect(world.publicState().sheriff).toBeUndefined();
  });
});
