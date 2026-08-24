/**
 * Werewolf mid-state checkpoint round-trips (AGENTS.md §26): the sealed day
 * vote with some ballots cast, the night with one wolf target submitted, and
 * the finished game.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 8);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-ww", scenarioId: "werewolf", profiles, rounds: 3 }) as SocialWorldBase;
  world.start();
  return world;
}

function restore(state: WorldSerializedState): SocialWorldBase {
  const world = createWorld({ roomId: "r-ww", scenarioId: "werewolf", profiles, rounds: 3, state }) as SocialWorldBase;
  world.start();
  return world;
}

function rolesOf(world: SocialWorldBase): Record<string, string> {
  return world.snapshot().details.roles as Record<string, string>;
}

function livingVillagers(world: SocialWorldBase, roles: Record<string, string>): string[] {
  return world.snapshot().agents
    .filter((agent) => agent.alive && roles[agent.id] === "villager")
    .map((agent) => agent.id);
}

function skipDiscussion(world: SocialWorldBase): void {
  for (let i = 0; i < 40; i += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.includes(":discussion")) return;
    world.completeActivation(activation);
  }
  throw new Error("discussion never ended");
}

/** Drive the night phase to completion for every night actor (8P: wolves, seer, witch). */
function driveNight(world: SocialWorldBase, roles: Record<string, string>): void {
  const night = world.activation()!;
  assert.ok(night.id.endsWith(":night"), "the night opens");
  const victim = livingVillagers(world, roles)[0];
  for (const actor of night.actorIds) {
    const role = roles[actor];
    if (role === "wolf") {
      void world.performDomainAction(actor, "choose_night_target", { targetId: victim, reason: "t" });
    } else if (role === "seer") {
      void world.performDomainAction(actor, "investigate_identity", { targetId: victim });
    } else if (role === "witch") {
      void world.performDomainAction(actor, "witch_night_choice", {});
    }
  }
  world.completeActivation(night);
}

it("the sealed day vote with some ballots cast resumes and settles", async () => {
  const world = makeWorld();
  const roles = rolesOf(world);
  skipDiscussion(world);
  const vote = world.activation()!;
  assert.ok(vote.id.endsWith(":vote"));
  const target = livingVillagers(world, roles)[0];
  const voters = vote.actorIds.filter((id) => id !== target);
  await world.performDomainAction(voters[0], "cast_day_vote", { targetId: target, reason: "t" });
  await world.performDomainAction(voters[1], "cast_day_vote", { targetId: target, reason: "t" });

  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const resumed = restored.activation();
  assert.ok(resumed && resumed.id.endsWith(":vote"), "the sealed vote reopens");
  const pending = (restored.snapshot().details as { pendingVotes: Record<string, string> }).pendingVotes;
  assert.equal(pending[voters[0]], target, "the first committed ballot survives internally");
  assert.equal(pending[voters[1]], target, "the second committed ballot survives internally");
  assert.ok(!(voters[2] in pending), "the pending side is not yet recorded");
  for (const actor of resumed.actorIds) {
    if (actor === voters[0] || actor === voters[1]) continue;
    await restored.performDomainAction(actor, "cast_day_vote", { targetId: actor === target ? voters[0] : target, reason: "t" });
  }
  restored.completeActivation(resumed);
  const after = restored.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === target)?.alive, "the restored vote settles identically");
  assert.equal(after.phase, "夜晚行动", "the night opens after restore");
});

it("the night with a submitted wolf target resumes and settles", async () => {
  const world = makeWorld();
  const roles = rolesOf(world);
  skipDiscussion(world);
  const vote = world.activation()!;
  const victim = livingVillagers(world, roles)[0];
  for (const actor of vote.actorIds) {
    await world.performDomainAction(actor, "cast_day_vote", { targetId: actor === victim ? livingVillagers(world, roles)[1] : victim, reason: "t" });
  }
  world.completeActivation(vote);
  const night = world.activation()!;
  assert.ok(night.id.endsWith(":night"));
  const wolf = night.actorIds.find((id) => roles[id] === "wolf")!;
  const nightVictim = livingVillagers(world, roles)[0];
  await world.performDomainAction(wolf, "choose_night_target", { targetId: nightVictim, reason: "t" });

  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const resumed = restored.activation();
  assert.ok(resumed && resumed.id.endsWith(":night"), "the night reopens");
  const pendingTargets = (restored.snapshot().details as { pendingNightTargets: Record<string, string> }).pendingNightTargets;
  assert.equal(pendingTargets[wolf], nightVictim, "the committed wolf target survives internally");
  const restoredRoles = rolesOf(restored);
  for (const actor of resumed.actorIds) {
    if (actor === wolf) continue;
    const role = restoredRoles[actor];
    if (role === "wolf") await restored.performDomainAction(actor, "choose_night_target", { targetId: nightVictim, reason: "t" });
    else if (role === "seer") await restored.performDomainAction(actor, "investigate_identity", { targetId: nightVictim });
    else if (role === "witch") await restored.performDomainAction(actor, "witch_night_choice", {});
  }
  restored.completeActivation(resumed);
  const after = restored.snapshot();
  assert.equal(after.phase, "白天讨论", "day two opens after the restored night");
  assert.equal(after.turn, 2, "the day counter advances");
});

it("a finished game re-exports stably without further activations", async () => {
  const world = makeWorld();
  const roles = rolesOf(world);
  const wolfIds = Object.entries(roles).filter(([, role]) => role === "wolf").map(([id]) => id);
  assert.equal(wolfIds.length, 2, "the 8P deck has two wolves");
  // Day one: vote out the first wolf; the pack kills a villager at night.
  skipDiscussion(world);
  const vote1 = world.activation()!;
  for (const actor of vote1.actorIds) {
    await world.performDomainAction(actor, "cast_day_vote", { targetId: actor === wolfIds[0] ? livingVillagers(world, roles)[0] : wolfIds[0], reason: "t" });
  }
  world.completeActivation(vote1);
  driveNight(world, roles);
  // Day two: vote out the second wolf — the pack is gone, the village wins.
  skipDiscussion(world);
  const vote2 = world.activation()!;
  for (const actor of vote2.actorIds) {
    await world.performDomainAction(actor, "cast_day_vote", { targetId: actor === wolfIds[1] ? livingVillagers(world, roles)[0] : wolfIds[1], reason: "t" });
  }
  world.completeActivation(vote2);
  assert.equal(world.snapshot().status, "finished", "the game ends when the pack is gone");

  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  assert.equal(restored.snapshot().status, "finished");
  assert.equal(restored.activation(), null, "a finished game produces no activation");
});