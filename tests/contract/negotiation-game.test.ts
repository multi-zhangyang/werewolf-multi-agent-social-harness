/**
 * Negotiation behavior chain (AGENTS.md §27/§28): an accepted typed offer
 * creates mutual demand commitments (offer-derivation) that settle against
 * the sealed demands — kept or broken only where the evidence exists;
 * a deal is an agreement, never an alliance; sealed demands never cross
 * observation boundaries; extracted demand claims are reconciled against
 * the actual claim. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase } from "../../src/society/world";
import type { Commitment, StoryBeatKind } from "../../src/society/contracts";

const profiles = createAgentProfiles(["model-a"], 2);
const [P1, P2] = profiles.map((profile) => profile.id);

function makeWorld(rounds = 2): SocialWorldBase {
  const world = createWorld({ roomId: "r-ng", scenarioId: "negotiation-game", profiles, rounds }) as SocialWorldBase;
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

function commitments(world: SocialWorldBase): Commitment[] {
  return (world.snapshot().details.commitments as Commitment[]) ?? [];
}

function lastBeat(world: SocialWorldBase): StoryBeatKind | undefined {
  return world.snapshot().log.at(-1)?.beat;
}

async function offerAndAccept(world: SocialWorldBase, proposerDemand: number, recipientDemand: number): Promise<string> {
  const made = await world.performDomainAction(P1, "make_offer", {
    recipientId: P2, proposerDemand, recipientDemand, message: "成交吧。"
  });
  const offerId = (made.result as { offerId: string }).offerId;
  await world.performDomainAction(P2, "respond_to_offer", { offerId, response: "accept" });
  return offerId;
}

async function playRound(world: SocialWorldBase, p1Demand: number, p2Demand: number): Promise<void> {
  driveDiscussion(world);
  const demand = world.activation();
  assert.ok(demand && demand.id.endsWith(":demand"), "the sealed demand phase opens");
  await world.performDomainAction(demand.actorIds[0], "submit_demand", { demand: p1Demand, reason: "t" });
  await world.performDomainAction(demand.actorIds[1], "submit_demand", { demand: p2Demand, reason: "t" });
  world.completeActivation(demand);
}

// --- behavior chain: accepted offer → mutual commitments → settlement ---
it("an accepted split that both sides honor earns promise-kept", async () => {
  const world = makeWorld();
  await offerAndAccept(world, 5, 5);
  await playRound(world, 5, 5);
  const ledger = commitments(world);
  assert.equal(ledger.length, 2, "acceptance mints one commitment per side");
  assert.ok(ledger.every((entry) => entry.state === "fulfilled"), "both sides honored the split");
  assert.equal(lastBeat(world), "promise-kept");
});

it("one side deviating from the accepted split is a violation, not a failed negotiation", async () => {
  const world = makeWorld();
  await offerAndAccept(world, 6, 4);
  await playRound(world, 7, 4);
  const ledger = commitments(world);
  const p1Commitment = ledger.find((entry) => entry.promisorActorId === P1)!;
  const p2Commitment = ledger.find((entry) => entry.promisorActorId === P2)!;
  assert.equal(p1Commitment.state, "violated", "claiming 7 breaks the accepted 6");
  assert.equal(p2Commitment.state, "fulfilled", "claiming 4 honors the accepted 4");
  assert.equal(lastBeat(world), "promise-broken");
});

it("without an accepted offer the settlement is a neutral deal/failure label", async () => {
  const world = makeWorld();
  await playRound(world, 4, 4);
  assert.equal(commitments(world).length, 0);
  assert.equal(lastBeat(world), "agreement-reached");
  const world2 = makeWorld();
  await playRound(world2, 6, 5);
  assert.equal(lastBeat(world2), "negotiation-failed");
});

it("an explicitly rejected offer creates no commitment at all", async () => {
  const world = makeWorld();
  const made = await world.performDomainAction(P1, "make_offer", {
    recipientId: P2, proposerDemand: 6, recipientDemand: 4, message: "6/4 成交？"
  });
  await world.performDomainAction(P2, "respond_to_offer", { offerId: (made.result as { offerId: string }).offerId, response: "reject" });
  await playRound(world, 6, 4);
  assert.equal(commitments(world).length, 0, "rejection creates no promise, no alliance, no betrayal");
  assert.equal(lastBeat(world), "agreement-reached");
});

// --- sealing ---
it("a sealed demand never crosses an observation boundary", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const demand = world.activation()!;
  await world.performDomainAction(demand.actorIds[0], "submit_demand", { demand: 8, reason: "t" });
  const publicView = world.snapshotFor(undefined).details as Record<string, unknown>;
  assert.ok(!("pendingDemands" in publicView), "spectators never see demand bookkeeping");
  const povView = world.snapshotFor(demand.actorIds[1]).details as Record<string, unknown>;
  assert.ok(!("pendingDemands" in povView), "the other player's POV never sees demand bookkeeping");
  const internal = world.snapshot().details as { pendingDemands: string[] };
  assert.deepEqual(internal.pendingDemands, [demand.actorIds[1]], "the world itself still tracks the pending side");
});

// --- model-extracted demand claims are reconciled against the actual claim ---
function claimEvidence(world: SocialWorldBase): Array<{ propositionId: string; supports: boolean; sourceType: string }> {
  return (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { evidence: Array<{ propositionId: string; supports: boolean; sourceType: string }> } }).socialCausalityFor(undefined, true).evidence;
}

it("a contradicted demand claim records contradiction evidence", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我至少要 7。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "demand-7" }
  }]);
  const demand = world.activation()!;
  await world.performDomainAction(P1, "submit_demand", { demand: 4, reason: "t" });
  await world.performDomainAction(P2, "submit_demand", { demand: 4, reason: "t" });
  world.completeActivation(demand);
  assert.ok(
    claimEvidence(world).some((entry) => entry.sourceType === "domain-result" && entry.supports === false),
    "demanding 4 contradicts the claimed demand-7"
  );
});

it("a matched demand claim records supporting evidence", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我就要 5。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "demand-5" }
  }]);
  const demand = world.activation()!;
  await world.performDomainAction(P1, "submit_demand", { demand: 5, reason: "t" });
  await world.performDomainAction(P2, "submit_demand", { demand: 5, reason: "t" });
  world.completeActivation(demand);
  assert.ok(
    claimEvidence(world).some((entry) => entry.sourceType === "domain-result" && entry.supports === true),
    "demanding 5 supports the claimed demand-5"
  );
});

// --- sealed demands: the barrier holds until both are in ---
it("an accepted offer settles against the sealed demands on the live path", async () => {
  const world = makeWorld();
  await offerAndAccept(world, 5, 5);
  driveDiscussion(world);
  const demand = world.activation()!;
  await world.performDomainAction(demand.actorIds[0], "submit_demand", { demand: 5, reason: "t" });
  await world.performDomainAction(demand.actorIds[1], "submit_demand", { demand: 5, reason: "t" });
  world.completeActivation(demand);
  assert.ok(commitments(world).every((entry) => entry.state === "fulfilled"), "the mutual commitments settle fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

// --- repeated interaction: the next round observes the settled history ---
it("round two observes round one's settled commitments", async () => {
  const world = makeWorld();
  await offerAndAccept(world, 5, 5);
  await playRound(world, 7, 3);
  assert.equal(world.snapshot().phase, "谈判", "round two reopens the bargaining");
  const observation = world.observe(P2);
  assert.ok(observation.privateContext.includes("violated"), "the past violation is visible to the audience");
  const ledger = commitments(world);
  assert.ok(ledger.some((entry) => entry.state === "violated"), "the violation stays on the record");
});