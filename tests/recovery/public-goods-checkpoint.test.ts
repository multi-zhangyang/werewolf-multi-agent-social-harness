/**
 * Public-goods mid-state checkpoint round-trips (AGENTS.md §26): the
 * discussion with an accepted contribution promise, the sealed contribution
 * phase with one side committed, and the settled round.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 3);
const [P1, P2, P3] = profiles.map((profile) => profile.id);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-pgr", scenarioId: "public-goods", profiles, rounds: 2 }) as SocialWorldBase;
  world.start();
  return world;
}

function restore(state: WorldSerializedState): SocialWorldBase {
  const world = createWorld({ roomId: "r-pgr", scenarioId: "public-goods", profiles, rounds: 2, state }) as SocialWorldBase;
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

it("discussion state with an accepted contribution promise survives a round-trip", async () => {
  const world = makeWorld();
  const declared = await world.performDomainAction(P1, "make_commitment", { amount: 5, proposition: "我会投 5 点。" });
  const commitmentId = (declared.result as { commitmentId: string }).commitmentId;
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const activation = restored.activation();
  assert.ok(activation?.id.includes(":discussion"), "the negotiation resumes in place");
});

it("the sealed contribution phase with one committed side resumes and settles", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const contribution = world.activation()!;
  await world.performDomainAction(contribution.actorIds[0], "contribute_to_pool", { amount: 9, reason: "t" });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const resumed = restored.activation();
  assert.ok(resumed && resumed.id.endsWith(":contribution"), "the sealed phase reopens");
  const pending = (restored.snapshot().details as { pendingContributions: string[] }).pendingContributions;
  assert.deepEqual([...pending].sort(), [...contribution.actorIds.slice(1)].sort(), "the committed side is not re-asked");
  for (const actor of resumed.actorIds) {
    if (actor === contribution.actorIds[0]) continue;
    await restored.performDomainAction(actor, "contribute_to_pool", { amount: 0, reason: "t" });
  }
  restored.completeActivation(resumed);
  const scores = (restored.snapshot().details as { scores: Record<string, number> }).scores;
  // The social dilemma holds after restore: free-riders keep their endowment
  // plus the multiplied share, so they out-earn the contributor.
  assert.ok(scores[P2] > scores[contribution.actorIds[0]], "the zero contributors out-earn the 9-point contributor");
  assert.equal(scores[P2], scores[P3], "both free-riders earn the same");
});

it("a settled round re-exports stably into round two", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const contribution = world.activation()!;
  for (const actor of contribution.actorIds) {
    await world.performDomainAction(actor, "contribute_to_pool", { amount: 3, reason: "t" });
  }
  world.completeActivation(contribution);
  assert.equal(world.snapshot().phase, "公开协商", "round two opened");
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const observation = restored.observe(P1);
  assert.ok(observation.privateContext.includes("R1=3"), "round one contribution history survived");
});