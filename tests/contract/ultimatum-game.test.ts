/**
 * Ultimatum behavior chain (AGENTS.md §27/§28): proposer offer-at-least and
 * responder accept-at-least promises settle against the sealed offer and
 * response — kept/broken/void exactly where the evidence exists; role
 * mismatches are refused; extracted offer claims are reconciled against the
 * actual split. Deterministic, no model calls.
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
  const world = createWorld({ roomId: "r-ug", scenarioId: "ultimatum-game", profiles, rounds }) as SocialWorldBase;
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

async function declare(world: SocialWorldBase, promisor: string, commitmentType: "offer-at-least" | "accept-at-least", amount: number, proposition: string): Promise<string> {
  const declared = await world.performDomainAction(promisor, "make_commitment", { commitmentType, amount, proposition });
  return (declared.result as { commitmentId: string }).commitmentId;
}

async function playRound(world: SocialWorldBase, offer: number, accept: boolean): Promise<void> {
  driveDiscussion(world);
  const propose = world.activation();
  assert.ok(propose && propose.id.endsWith(":propose"));
  await world.performDomainAction(propose.actorIds[0], "propose_split", { offer, reason: "t" });
  world.completeActivation(propose);
  const respond = world.activation();
  assert.ok(respond && respond.id.endsWith(":respond"));
  await world.performDomainAction(respond.actorIds[0], "respond_to_offer", { accept, reason: "t" });
  world.completeActivation(respond);
}

// --- proposer promises ---
it("an offer-at-least promise the proposer honors earns promise-kept", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "offer-at-least", 4, "我至少给你 4。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, 5, true);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

it("an offer below the promised floor is a violation", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "offer-at-least", 6, "我至少给你 6。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, 3, true);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "violated");
  assert.equal(lastBeat(world), "promise-broken");
});

// --- responder promises ---
it("an accept-at-least promise honored by accepting earns promise-kept", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P2, "accept-at-least", 4, "你给 4 以上我就接受。");
  await world.performDomainAction(P1, "accept_commitment", { commitmentId });
  await playRound(world, 5, true);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

it("an accept-at-least promise broken by rejecting is a violation", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P2, "accept-at-least", 4, "4 以上我必接受。");
  await world.performDomainAction(P1, "accept_commitment", { commitmentId });
  await playRound(world, 5, false);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "violated");
  assert.equal(lastBeat(world), "promise-broken");
});

it("an accept-at-least promise whose threshold the offer never reaches is voided", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P2, "accept-at-least", 6, "低于 6 我绝不接受。");
  await world.performDomainAction(P1, "accept_commitment", { commitmentId });
  await playRound(world, 3, false);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "void");
  assert.equal(lastBeat(world), "negotiation-failed");
});

// --- role gating ---
it("role mismatches are refused at declaration time", async () => {
  const world = makeWorld();
  assert.throws(
    () => world.performDomainAction(P2, "make_commitment", { commitmentType: "offer-at-least", amount: 4, proposition: "我提议。" }),
    /ROLE_MISMATCH/
  );
  assert.throws(
    () => world.performDomainAction(P1, "make_commitment", { commitmentType: "accept-at-least", amount: 4, proposition: "我接受。" }),
    /ROLE_MISMATCH/
  );
});

it("an unaccepted promise is voided at settlement", async () => {
  const world = makeWorld();
  await declare(world, P1, "offer-at-least", 4, "我至少给你 4。");
  await playRound(world, 5, true);
  assert.equal(commitments(world)[0].state, "void");
  assert.equal(lastBeat(world), "agreement-reached");
});

// --- extracted offer claims are reconciled against the actual split ---
it("a contradicted offer claim records contradiction evidence", async () => {
  const world = makeWorld();
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我会给你 4。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "offer-4" }
  }]);
  await playRound(world, 6, true);
  const projection = (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { evidence: Array<{ propositionId: string; supports: boolean; sourceType: string }> } }).socialCausalityFor(undefined, true);
  assert.ok(
    projection.evidence.some((entry) => entry.sourceType === "domain-result" && entry.supports === false),
    "offering 6 contradicts the claimed offer-4"
  );
});

// --- sealed offer: the barrier holds until the response is in ---
it("an accepted promise and a sealed offer settle identically on the live path", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "offer-at-least", 4, "我至少给你 4。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  driveDiscussion(world);
  const propose = world.activation()!;
  await world.performDomainAction(propose.actorIds[0], "propose_split", { offer: 5, reason: "t" });
  world.completeActivation(propose);
  const respond = world.activation();
  assert.ok(respond && respond.id.endsWith(":respond"), "the response phase opens");
  await world.performDomainAction(respond.actorIds[0], "respond_to_offer", { accept: true, reason: "t" });
  world.completeActivation(respond);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});