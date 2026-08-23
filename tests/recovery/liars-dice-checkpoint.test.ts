/**
 * Liars-dice mid-state checkpoint round-trips (AGENTS.md §26): the bidding
 * round with a pending bidder and a settled round.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 3);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-ldr", scenarioId: "liars-dice", profiles, rounds: 2 }) as SocialWorldBase;
  world.start();
  return world;
}

function restore(state: WorldSerializedState): SocialWorldBase {
  const world = createWorld({ roomId: "r-ldr", scenarioId: "liars-dice", profiles, rounds: 2, state }) as SocialWorldBase;
  world.start();
  return world;
}

it("the bidding round with a pending bidder resumes after restore", async () => {
  const world = makeWorld();
  const opening = world.activation();
  assert.ok(opening && opening.actorIds.length === 1);
  const opener = opening.actorIds[0];
  await world.performDomainAction(opener, "liars_move", { move: "bid", quantity: 2, face: 5, reason: "t" });
  world.completeActivation(opening);
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const resumed = restored.activation();
  assert.ok(resumed && resumed.actorIds.length === 1, "the next bidder reopens");
  assert.notEqual(resumed.actorIds[0], opener, "the same next actor holds the move");
});

it("a settled round re-exports stably into the next round", async () => {
  const world = makeWorld();
  const opening = world.activation()!;
  const opener = opening.actorIds[0];
  await world.performDomainAction(opener, "liars_move", { move: "bid", quantity: 2, face: 5, reason: "t" });
  world.completeActivation(opening);
  const next = world.activation()!;
  await world.performDomainAction(next.actorIds[0], "liars_move", { move: "bid", quantity: 3, face: 5, reason: "t" });
  world.completeActivation(next);
  const third = world.activation()!;
  await world.performDomainAction(third.actorIds[0], "liars_move", { move: "bid", quantity: 4, face: 5, reason: "t" });
  world.completeActivation(third);
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
});