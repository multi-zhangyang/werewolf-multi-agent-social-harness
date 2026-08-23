/**
 * Centipede mid-state checkpoint round-trips (AGENTS.md §26): the discussion
 * with an accepted promise and the move phase awaiting the mover.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 2);
const [P1, P2] = profiles.map((profile) => profile.id);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-cgr", scenarioId: "centipede-game", profiles, rounds: 4 }) as SocialWorldBase;
  world.start();
  return world;
}

function restore(state: WorldSerializedState): SocialWorldBase {
  const world = createWorld({ roomId: "r-cgr", scenarioId: "centipede-game", profiles, rounds: 4, state }) as SocialWorldBase;
  world.start();
  return world;
}

function driveDiscussion(world: SocialWorldBase): void {
  for (let wave = 0; wave < 40; wave += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.includes(":discussion")) return;
    world.completeActivation(activation);
  }
  throw new Error("discussion never ended");
}

it("discussion state with an accepted promise survives a round-trip", async () => {
  const world = makeWorld();
  const declared = await world.performDomainAction(P1, "make_commitment", { moveAction: "pass", proposition: "我会传递。" });
  const commitmentId = (declared.result as { commitmentId: string }).commitmentId;
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const activation = restored.activation();
  assert.ok(activation?.id.includes(":discussion"), "the negotiation resumes in place");
});

it("the move phase with a pending mover resumes and settles", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  assert.ok(world.snapshot().phase.startsWith("第 1 步"), "the mover holds move one");
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const move = restored.activation();
  assert.ok(move && move.id.endsWith(":move"), "the move reopens");
  await restored.performDomainAction(move.actorIds[0], "centipede_move", { action: "pass", reason: "t" });
  restored.completeActivation(move);
  assert.equal(restored.snapshot().turn, 2, "the pot passes to move two after restore");
});