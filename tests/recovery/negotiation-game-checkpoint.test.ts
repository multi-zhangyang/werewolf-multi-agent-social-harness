/**
 * Negotiation mid-state checkpoint round-trips (AGENTS.md §26): the
 * bargaining phase with an accepted offer (mutual commitments), the sealed
 * demand phase with one side committed, and the settled round.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 2);
const [P1, P2] = profiles.map((profile) => profile.id);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-ngr", scenarioId: "negotiation-game", profiles, rounds: 2 }) as SocialWorldBase;
  world.start();
  return world;
}

function restore(state: WorldSerializedState): SocialWorldBase {
  const world = createWorld({ roomId: "r-ngr", scenarioId: "negotiation-game", profiles, rounds: 2, state }) as SocialWorldBase;
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

it("bargaining state with an accepted offer survives a round-trip", async () => {
  const world = makeWorld();
  const made = await world.performDomainAction(P1, "make_offer", { recipientId: P2, proposerDemand: 5, recipientDemand: 5, message: "五五分成。" });
  await world.performDomainAction(P2, "respond_to_offer", { offerId: (made.result as { offerId: string }).offerId, response: "accept" });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const activation = restored.activation();
  assert.ok(activation?.id.includes(":discussion"), "the bargaining resumes in place");
});

it("the sealed demand phase with one side committed resumes and settles", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const demand = world.activation()!;
  await world.performDomainAction(demand.actorIds[0], "submit_demand", { demand: 6, reason: "t" });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const resumed = restored.activation();
  assert.ok(resumed && resumed.id.endsWith(":demand"), "the sealed phase reopens");
  assert.deepEqual(
    (restored.snapshot().details as { pendingDemands: string[] }).pendingDemands,
    [P2],
    "the committed side is not re-asked"
  );
  await restored.performDomainAction(P2, "submit_demand", { demand: 4, reason: "t" });
  restored.completeActivation(resumed);
  const scores = (restored.snapshot().details as { scores: Record<string, number> }).scores;
  assert.equal(scores[P1], 6, "the 6/4 split pays each side its claim");
  assert.equal(scores[P2], 4);
});

it("a settled round re-exports stably into round two", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const demand = world.activation()!;
  await world.performDomainAction(demand.actorIds[0], "submit_demand", { demand: 5, reason: "t" });
  await world.performDomainAction(demand.actorIds[1], "submit_demand", { demand: 5, reason: "t" });
  world.completeActivation(demand);
  assert.equal(world.snapshot().phase, "谈判", "round two opened");
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const observation = restored.observe(P1);
  assert.ok(observation.privateContext.includes("R1 claim 5"), "round one demand history survived");
});