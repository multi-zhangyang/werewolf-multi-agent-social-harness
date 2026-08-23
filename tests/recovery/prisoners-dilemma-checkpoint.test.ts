/**
 * Prisoners-dilemma mid-state checkpoint round-trips (AGENTS.md §26): the
 * negotiation with accepted commitments, the sealed choice with one side
 * committed, and the settled round all survive export/restore byte-stably.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 2);
const [P1, P2] = profiles.map((profile) => profile.id);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-pdr", scenarioId: "prisoners-dilemma", profiles, rounds: 2 }) as SocialWorldBase;
  world.start();
  return world;
}

function restore(state: WorldSerializedState): SocialWorldBase {
  const world = createWorld({ roomId: "r-pdr", scenarioId: "prisoners-dilemma", profiles, rounds: 2, state }) as SocialWorldBase;
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

it("negotiation state with an accepted commitment survives a round-trip", async () => {
  const world = makeWorld();
  const declared = await world.performDomainAction(P1, "make_commitment", { move: "cooperate", proposition: "我会合作。" });
  const commitmentId = (declared.result as { commitmentId: string }).commitmentId;
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const restoredActivation = restored.activation();
  assert.ok(restoredActivation?.id.includes(":discussion"), "the negotiation resumes in place");
});

it("the sealed-choice phase with one committed side resumes and settles", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const choice = world.activation()!;
  await world.performDomainAction(choice.actorIds[0], "choose_move", { move: "defect", reason: "t" });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const resumed = restored.activation();
  assert.ok(resumed && resumed.id.endsWith(":choice"), "the sealed phase reopens");
  assert.deepEqual(
    (restored.snapshot().details as { pendingChoices: string[] }).pendingChoices,
    [P2],
    "the committed side is not re-asked"
  );
  await restored.performDomainAction(P2, "choose_move", { move: "cooperate", reason: "t" });
  restored.completeActivation(resumed);
  const scores = (restored.snapshot().details as { scores: Record<string, number> }).scores;
  assert.equal(scores[P1], 5, "defect vs cooperate pays 5 to the defector");
  assert.equal(scores[P2], 0);
});

it("a settled round re-exports stably into round two", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const choice = world.activation()!;
  await world.performDomainAction(choice.actorIds[0], "choose_move", { move: "cooperate", reason: "t" });
  await world.performDomainAction(choice.actorIds[1], "choose_move", { move: "cooperate", reason: "t" });
  world.completeActivation(choice);
  assert.equal(world.snapshot().phase, "谈判", "round two opened");
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const observation = restored.observe(P1);
  assert.ok(observation.privateContext.includes("Past rounds: 1 cooperate"), "round one history survived");
});