/**
 * Sealed-bid auction behavior chain (AGENTS.md §27/§28): extracted bid claims
 * reconcile against the sealed bid; bids stay sealed until the barrier;
 * mid-state checkpoints round-trip. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 3);
const [P1, P2, P3] = profiles.map((profile) => profile.id);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-sb", scenarioId: "sealed-bid-auction", profiles, rounds: 2 }) as SocialWorldBase;
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

async function playRound(world: SocialWorldBase, amounts: Record<string, number>): Promise<void> {
  driveDiscussion(world);
  const bid = world.activation();
  assert.ok(bid && bid.id.endsWith(":bid"));
  for (const actor of bid.actorIds) {
    await world.performDomainAction(actor, "submit_bid", { amount: amounts[actor] ?? 0, reason: "t" });
  }
  world.completeActivation(bid);
}

it("a matched extracted bid claim records supporting evidence", async () => {
  const world = makeWorld();
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我会出 20。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "bid-20" }
  }]);
  await playRound(world, { [P1]: 20, [P2]: 18, [P3]: 15 });
  assert.ok(
    evidence(world).some((entry) => entry.sourceType === "domain-result" && entry.supports === true),
    "bidding 20 supports the claimed bid-20"
  );
});

it("a contradicted extracted bid claim records contradiction evidence", async () => {
  const world = makeWorld();
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我势在必得，出 30。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "bid-30" }
  }]);
  await playRound(world, { [P1]: 12, [P2]: 18, [P3]: 15 });
  assert.ok(
    evidence(world).some((entry) => entry.sourceType === "domain-result" && entry.supports === false),
    "bidding 12 contradicts the claimed bid-30"
  );
});

it("sealed bids never cross an observation boundary", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const bid = world.activation()!;
  await world.performDomainAction(bid.actorIds[0], "submit_bid", { amount: 40, reason: "t" });
  const publicView = world.snapshotFor(undefined).details as Record<string, unknown>;
  assert.ok(!("pendingBids" in publicView) && !("bids" in publicView), "spectators never see bid bookkeeping");
  const povView = world.snapshotFor(bid.actorIds[1]).details as Record<string, unknown>;
  assert.ok(!("pendingBids" in povView) && !("bids" in povView), "another player's POV never sees bid bookkeeping");
  const internal = world.snapshot().details as { pendingBids: string[] };
  assert.ok(internal.pendingBids.includes(bid.actorIds[1]), "the world itself still tracks the pending side");
});

it("a sealed bid settles identically once every bidder has bid", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const bid = world.activation()!;
  await world.performDomainAction(bid.actorIds[0], "submit_bid", { amount: 25, reason: "t" });
  for (const actor of bid.actorIds) {
    if (actor === bid.actorIds[0]) continue;
    await world.performDomainAction(actor, "submit_bid", { amount: 10, reason: "t" });
  }
  world.completeActivation(bid);
  assert.equal(world.snapshot().turn, 2, "round two opens after settlement");
});