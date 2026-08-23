/**
 * Ultimatum mid-state checkpoint round-trips (AGENTS.md §26): the discussion
 * with an accepted promise, the sealed offer, and the settled round.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 2);
const [P1, P2] = profiles.map((profile) => profile.id);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-ugr", scenarioId: "ultimatum-game", profiles, rounds: 2 }) as SocialWorldBase;
  world.start();
  return world;
}

function restore(state: WorldSerializedState): SocialWorldBase {
  const world = createWorld({ roomId: "r-ugr", scenarioId: "ultimatum-game", profiles, rounds: 2, state }) as SocialWorldBase;
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
  const declared = await world.performDomainAction(P1, "make_commitment", { commitmentType: "offer-at-least", amount: 4, proposition: "我至少给你 4。" });
  const commitmentId = (declared.result as { commitmentId: string }).commitmentId;
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const activation = restored.activation();
  assert.ok(activation?.id.includes(":discussion"), "the negotiation resumes in place");
});

it("a sealed offer survives a round-trip into the response phase", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const propose = world.activation()!;
  await world.performDomainAction(propose.actorIds[0], "propose_split", { offer: 5, reason: "t" });
  world.completeActivation(propose);
  assert.equal(world.snapshot().phase, "回应", "the response phase opens");
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const respond = restored.activation();
  assert.ok(respond && respond.id.endsWith(":respond"), "the response reopens");
  await restored.performDomainAction(respond.actorIds[0], "respond_to_offer", { accept: true, reason: "t" });
  restored.completeActivation(respond);
  const scores = (restored.snapshot().details as { scores: Record<string, number> }).scores;
  assert.equal(scores[P1], 5, "the accepted 5/5 split pays both sides");
  assert.equal(scores[P2], 5);
});

it("a settled round re-exports stably into round two", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const propose = world.activation()!;
  await world.performDomainAction(propose.actorIds[0], "propose_split", { offer: 4, reason: "t" });
  world.completeActivation(propose);
  const respond = world.activation()!;
  await world.performDomainAction(respond.actorIds[0], "respond_to_offer", { accept: true, reason: "t" });
  world.completeActivation(respond);
  assert.equal(world.snapshot().phase, "谈判", "round two opened");
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const observation = restored.observe(P1);
  assert.ok(observation.privateContext.includes("R1"), "round one history survived");
});