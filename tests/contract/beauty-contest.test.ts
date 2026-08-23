/**
 * Beauty-contest behavior chain (AGENTS.md §27/§28): extracted number claims
 * reconcile against the sealed choice; the choice stays sealed until the
 * barrier; mid-state checkpoints round-trip. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 3);
const [P1, P2, P3] = profiles.map((profile) => profile.id);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-bc", scenarioId: "beauty-contest", profiles, rounds: 2 }) as SocialWorldBase;
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

function evidence(world: SocialWorldBase): Array<{ propositionId: string; supports: boolean; sourceType: string }> {
  return (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { evidence: Array<{ propositionId: string; supports: boolean; sourceType: string }> } }).socialCausalityFor(undefined, true).evidence;
}

async function playRound(world: SocialWorldBase, numbers: Record<string, number>): Promise<void> {
  driveDiscussion(world);
  const choice = world.activation();
  assert.ok(choice && choice.id.endsWith(":choice"));
  for (const actor of choice.actorIds) {
    await world.performDomainAction(actor, "choose_number", { number: numbers[actor] ?? 0, reason: "t" });
  }
  world.completeActivation(choice);
}

it("a matched extracted number claim records supporting evidence", async () => {
  const world = makeWorld();
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我会选 33。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "number-33" }
  }]);
  await playRound(world, { [P1]: 33, [P2]: 50, [P3]: 10 });
  assert.ok(
    evidence(world).some((entry) => entry.sourceType === "domain-result" && entry.supports === true),
    "choosing 33 supports the claimed number-33"
  );
});

it("a contradicted extracted number claim records contradiction evidence", async () => {
  const world = makeWorld();
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我会选 66。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "number-66" }
  }]);
  await playRound(world, { [P1]: 20, [P2]: 50, [P3]: 10 });
  assert.ok(
    evidence(world).some((entry) => entry.sourceType === "domain-result" && entry.supports === false),
    "choosing 20 contradicts the claimed number-66"
  );
});

it("sealed numbers never cross an observation boundary", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const choice = world.activation()!;
  await world.performDomainAction(choice.actorIds[0], "choose_number", { number: 77, reason: "t" });
  const publicView = world.snapshotFor(undefined).details as Record<string, unknown>;
  assert.ok(!("pendingChoices" in publicView), "spectators never see choice bookkeeping");
  const povView = world.snapshotFor(choice.actorIds[1]).details as Record<string, unknown>;
  assert.ok(!("pendingChoices" in povView), "another player's POV never sees choice bookkeeping");
  const internal = world.snapshot().details as { pendingChoices: string[] };
  assert.ok(internal.pendingChoices.includes(choice.actorIds[1]), "the world itself still tracks the pending side");
});

it("a sealed choice survives export/restore and settles identically", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const choice = world.activation()!;
  await world.performDomainAction(choice.actorIds[0], "choose_number", { number: 22, reason: "t" });
  const state = world.exportState();
  const restored = createWorld({ roomId: "r-bc", scenarioId: "beauty-contest", profiles, rounds: 2, state }) as SocialWorldBase;
  restored.start();
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const resumed = restored.activation();
  assert.ok(resumed && resumed.id.endsWith(":choice"), "the sealed phase reopens");
  for (const actor of resumed.actorIds) {
    if (actor === choice.actorIds[0]) continue;
    await restored.performDomainAction(actor, "choose_number", { number: 22, reason: "t" });
  }
  restored.completeActivation(resumed);
  assert.equal(restored.snapshot().turn, 2, "round two opens after restore");
});