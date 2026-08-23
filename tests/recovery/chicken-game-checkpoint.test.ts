/**
 * Chicken-game mid-state checkpoint round-trips (AGENTS.md §26).
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 2);
const [P1, P2] = profiles.map((profile) => profile.id);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-ckr", scenarioId: "chicken-game", profiles, rounds: 2 }) as SocialWorldBase;
  world.start();
  return world;
}

function restore(state: WorldSerializedState): SocialWorldBase {
  const world = createWorld({ roomId: "r-ckr", scenarioId: "chicken-game", profiles, rounds: 2, state }) as SocialWorldBase;
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

it("the sealed choice with one side committed resumes and settles", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const choice = world.activation()!;
  await world.performDomainAction(choice.actorIds[0], "chicken_choice", { choice: "swerve", reason: "t" });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const resumed = restored.activation();
  assert.ok(resumed && resumed.id.endsWith(":choice"), "the sealed phase reopens");
  await restored.performDomainAction(resumed.actorIds[1], "chicken_choice", { choice: "swerve", reason: "t" });
  restored.completeActivation(resumed);
  const scores = (restored.snapshot().details as { scores: Record<string, number> }).scores;
  assert.equal(scores[P1], 2, "swerve/swerve pays both sides the chicken payoff");
  assert.equal(scores[P2], 2);
});