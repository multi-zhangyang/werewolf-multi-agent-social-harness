/**
 * Trust-game checkpoint recovery checks (AGENTS.md §14.4 / P0-02): every
 * phase-local state must survive an export/restore round-trip, including the
 * in-flight investment and return. A restart between investment and return
 * must come back with the same sealed actions and the same legal tool sets.
 * No model calls, no network.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import { TRUST_GAME_STATE_SCHEMA_VERSION } from "../../src/society/scenarios/trustGame";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";
import type { WorldActivation } from "../../src/society/contracts";

const profiles = createAgentProfiles(["model-a"], 2);
const [AGENT_A, AGENT_B] = profiles.map((profile) => profile.id);

function makeWorld(rounds = 3): SocialWorldBase {
  const world = createWorld({ roomId: "room-t", scenarioId: "trust-game", profiles, rounds }) as SocialWorldBase;
  world.start();
  return world;
}

/** Drive discussion waves until the next non-discussion activation opens. */
function driveDiscussion(world: SocialWorldBase): WorldActivation | null {
  for (let wave = 0; wave < 20; wave += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.includes(":discussion")) return activation;
    world.completeActivation(activation);
  }
  throw new Error("discussion never ended");
}

async function playRound(world: SocialWorldBase, investment: number, returned: number): Promise<void> {
  const investActivation = driveDiscussion(world);
  assert.ok(investActivation && investActivation.id.endsWith(":investment"));
  await world.performDomainAction(investActivation.actorIds[0], "make_investment", { amount: investment, reason: "t" });
  world.completeActivation(investActivation);
  const returnActivation = world.activation();
  assert.ok(returnActivation && returnActivation.id.endsWith(":return"));
  await world.performDomainAction(returnActivation.actorIds[0], "return_from_trust", { amount: returned, reason: "t" });
  world.completeActivation(returnActivation);
}

/** The legal action surface for an actor: typed domain actions + observed tools. */
function actionSurface(world: SocialWorldBase, actorId: string): string[] {
  return [
    ...world.domainActionsFor(actorId).map((action) => `domain:${action.name}`),
    ...world.observe(actorId).availableActions.map((action) => `tool:${action}`)
  ].sort();
}

/** Export, restore, and pin state + legal-action equality at a phase point. */
function assertRoundTrip(world: SocialWorldBase, label: string, options: { start?: boolean } = {}): { state: unknown } {
  const state = world.exportState();
  const restored = createWorld({
    roomId: "room-t", scenarioId: "trust-game", profiles, rounds: 3, state
  }) as SocialWorldBase;
  if (options.start !== false) restored.start();
  assert.equal(JSON.stringify(restored.exportState()), JSON.stringify(state), `${label}: restored state must re-export identically`);
  for (const actorId of [AGENT_A, AGENT_B]) {
    assert.deepEqual(actionSurface(restored, actorId), actionSurface(world, actorId), `${label}: ${actorId} legal actions survive restore`);
  }
  return { state };
}

it("round-trips before the negotiation (discussion, nothing committed)", () => {
  const world = makeWorld(3);
  assert.equal(world.snapshot().phase, "协商");
  assertRoundTrip(world, "pre-negotiation");
});

it("round-trips with the investment committed and the return pending", async () => {
  const world = makeWorld(3);
  const investActivation = driveDiscussion(world);
  assert.ok(investActivation && investActivation.id.endsWith(":investment"));
  await world.performDomainAction(investActivation.actorIds[0], "make_investment", { amount: 8, reason: "t" });
  // The investment is sealed but the phase has not advanced yet.
  assert.equal(world.snapshot().phase, "投资");
  const { state } = assertRoundTrip(world, "investment-committed");
  assert.equal((state as { world: { investment: number } }).world.investment, 8, "the sealed investment survives the checkpoint");
});

it("round-trips with the return committed and the settlement pending", async () => {
  const world = makeWorld(3);
  const investActivation = driveDiscussion(world)!;
  await world.performDomainAction(investActivation.actorIds[0], "make_investment", { amount: 8, reason: "t" });
  world.completeActivation(investActivation);
  const returnActivation = world.activation();
  assert.ok(returnActivation && returnActivation.id.endsWith(":return"));
  await world.performDomainAction(returnActivation.actorIds[0], "return_from_trust", { amount: 3, reason: "t" });
  assert.equal(world.snapshot().phase, "返还");
  const { state } = assertRoundTrip(world, "return-committed");
  const worldState = (state as { world: { investment: number; returnedAmount: number } }).world;
  assert.equal(worldState.investment, 8, "investment survives");
  assert.equal(worldState.returnedAmount, 3, "the sealed return survives");
});

it("round-trips after a round switch (roles reversed, fresh discussion)", async () => {
  const world = makeWorld(3);
  await playRound(world, 8, 3);
  assert.equal(world.snapshot().phase, "协商", "round two reopens negotiation");
  const snapshot = world.snapshot();
  const details = snapshot.details as { investorId: string; round?: number };
  assert.equal(details.investorId, AGENT_B, "roles reverse on the second round");
  assertRoundTrip(world, "round-switch");
});

it("round-trips a finished game without disturbing the finale", async () => {
  const world = makeWorld(2);
  await playRound(world, 5, 5);
  await playRound(world, 5, 5);
  assert.equal(world.snapshot().status, "finished");
  assertRoundTrip(world, "finished", { start: false });
});

it("rejects legacy checkpoints without a schema version instead of corrupting the world", async () => {
  const world = makeWorld(3);
  const investActivation = driveDiscussion(world)!;
  await world.performDomainAction(investActivation.actorIds[0], "make_investment", { amount: 8, reason: "t" });
  const state = world.exportState();
  const legacy = structuredClone(state) as unknown as { world: { schemaVersion?: number } };
  delete legacy.world.schemaVersion;
  assert.throws(
    () => createWorld({ roomId: "room-t", scenarioId: "trust-game", profiles, rounds: 3, state: legacy as unknown as WorldSerializedState }),
    /SCENARIO_STATE_MIGRATION_REQUIRED.*legacy/
  );
});

it("rejects future schema versions with a clear error", () => {
  const world = makeWorld(3);
  const state = world.exportState();
  const future = structuredClone(state) as unknown as { world: { schemaVersion: number } };
  future.world.schemaVersion = TRUST_GAME_STATE_SCHEMA_VERSION + 1;
  assert.throws(
    () => createWorld({ roomId: "room-t", scenarioId: "trust-game", profiles, rounds: 3, state: future as unknown as WorldSerializedState }),
    /SCENARIO_STATE_MIGRATION_REQUIRED/
  );
});