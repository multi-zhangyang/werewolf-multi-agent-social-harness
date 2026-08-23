/**
 * Public-goods behavior chain (AGENTS.md §27/§28): a contribution promise →
 * sealed contributions → settlement against the accepted promise →
 * promise-kept / promise-broken only where the evidence exists; zero
 * contribution is free-riding, never betrayal; sealed contributions never
 * cross observation boundaries; extracted contribution claims are reconciled
 * against the actual amount. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase } from "../../src/society/world";
import type { Commitment, StoryBeatKind } from "../../src/society/contracts";

const profiles = createAgentProfiles(["model-a"], 3);
const [P1, P2, P3] = profiles.map((profile) => profile.id);

function makeWorld(rounds = 2): SocialWorldBase {
  const world = createWorld({ roomId: "r-pg", scenarioId: "public-goods", profiles, rounds }) as SocialWorldBase;
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

async function declare(world: SocialWorldBase, promisor: string, amount: number, proposition: string): Promise<string> {
  const commit = await world.performDomainAction(promisor, "make_commitment", { amount, proposition });
  return (commit.result as { commitmentId: string }).commitmentId;
}

async function playRound(world: SocialWorldBase, amounts: Record<string, number>): Promise<void> {
  driveDiscussion(world);
  const contribution = world.activation();
  assert.ok(contribution && contribution.id.endsWith(":contribution"), "the sealed contribution phase opens");
  for (const actor of contribution.actorIds) {
    await world.performDomainAction(actor, "contribute_to_pool", { amount: amounts[actor] ?? 0, reason: "t" });
  }
  world.completeActivation(contribution);
}

// --- behavior chain ---
it("an accepted contribution promise that the promisor honors earns promise-kept", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, 5, "我会投 5 点。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, { [P1]: 5, [P2]: 0, [P3]: 0 });
  assert.equal(commitments(world)[0].state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

it("contributing below the promised floor is a violation, not a partial promise", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, 5, "我至少投 5 点。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, { [P1]: 2, [P2]: 3, [P3]: 0 });
  assert.equal(commitments(world)[0].state, "violated");
  assert.equal(lastBeat(world), "promise-broken");
});

it("zero contribution is free-riding, not betrayal, when no promise is broken", async () => {
  const world = makeWorld();
  await playRound(world, { [P1]: 8, [P2]: 6, [P3]: 0 });
  assert.equal(commitments(world).length, 0);
  assert.equal(lastBeat(world), "free-riding");
});

it("a round without any zero contributor is a cooperative outcome", async () => {
  const world = makeWorld();
  await playRound(world, { [P1]: 3, [P2]: 3, [P3]: 3 });
  assert.equal(lastBeat(world), "cooperative-outcome");
});

it("an unaccepted contribution promise is voided at settlement", async () => {
  const world = makeWorld();
  await declare(world, P1, 5, "我会投 5 点。");
  await playRound(world, { [P1]: 5, [P2]: 0, [P3]: 0 });
  assert.equal(commitments(world)[0].state, "void");
  assert.equal(lastBeat(world), "free-riding");
});

// --- sealing ---
it("sealed contributions never cross an observation boundary", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const contribution = world.activation()!;
  await world.performDomainAction(contribution.actorIds[0], "contribute_to_pool", { amount: 9, reason: "t" });
  const publicView = world.snapshotFor(undefined).details as Record<string, unknown>;
  assert.ok(!("pendingContributions" in publicView), "spectators never see contribution bookkeeping");
  assert.ok(!("contributionCommandIds" in publicView), "spectators never see the sealed command ids");
  const povView = world.snapshotFor(contribution.actorIds[1]).details as Record<string, unknown>;
  assert.ok(!("pendingContributions" in povView), "another participant's POV never sees contribution bookkeeping");
  const internal = world.snapshot().details as { pendingContributions: string[] };
  assert.deepEqual(
    [...internal.pendingContributions].sort(),
    [...contribution.actorIds.slice(1)].sort(),
    "the world itself still tracks the pending side"
  );
});

// --- model-extracted contribution claims are reconciled against the actual amount ---
function claimEvidence(world: SocialWorldBase): Array<{ propositionId: string; supports: boolean; sourceType: string }> {
  return (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { evidence: Array<{ propositionId: string; supports: boolean; sourceType: string }> } }).socialCausalityFor(undefined, true).evidence;
}

it("a contradicted contribution claim records contradiction evidence", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我会投 5 点。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "contribute-5" }
  }]);
  const contribution = world.activation()!;
  await world.performDomainAction(P1, "contribute_to_pool", { amount: 0, reason: "t" });
  await world.performDomainAction(P2, "contribute_to_pool", { amount: 0, reason: "t" });
  await world.performDomainAction(P3, "contribute_to_pool", { amount: 0, reason: "t" });
  world.completeActivation(contribution);
  const reconciled = claimEvidence(world).filter((entry) => entry.sourceType === "domain-result");
  assert.ok(reconciled.some((entry) => entry.supports === false), "contributing 0 contradicts the claimed contribute-5");
});

it("a matched contribution claim records supporting evidence", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我会投 3 点。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "contribute-3" }
  }]);
  const contribution = world.activation()!;
  await world.performDomainAction(P1, "contribute_to_pool", { amount: 3, reason: "t" });
  await world.performDomainAction(P2, "contribute_to_pool", { amount: 0, reason: "t" });
  await world.performDomainAction(P3, "contribute_to_pool", { amount: 0, reason: "t" });
  world.completeActivation(contribution);
  assert.ok(
    claimEvidence(world).some((entry) => entry.sourceType === "domain-result" && entry.supports === true),
    "contributing 3 supports the claimed contribute-3"
  );
});

// --- checkpoint: mid-state round-trip ---
it("an accepted promise and a sealed contribution survive export/restore and settle identically", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, 5, "我会投 5 点。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  driveDiscussion(world);
  const contribution = world.activation()!;
  await world.performDomainAction(contribution.actorIds[0], "contribute_to_pool", { amount: 5, reason: "t" });
  const state = world.exportState();
  const restored = createWorld({ roomId: "r-pg", scenarioId: "public-goods", profiles, rounds: 2, state }) as SocialWorldBase;
  restored.start();
  assert.equal(commitments(restored)[0].state, "accepted", "the accepted promise survives");
  const resumed = restored.activation();
  assert.ok(resumed && resumed.id.endsWith(":contribution"), "the sealed phase reopens");
  for (const actor of resumed.actorIds) {
    if (actor === contribution.actorIds[0]) continue;
    await restored.performDomainAction(actor, "contribute_to_pool", { amount: 0, reason: "t" });
  }
  restored.completeActivation(resumed);
  assert.equal(commitments(restored)[0].state, "fulfilled", "settlement after restore matches the live path");
  assert.equal(lastBeat(restored), "promise-kept");
});

// --- repeated interaction: the next round observes the settled history ---
it("round two observes round one's settled commitments", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, 5, "我至少投 5 点。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, { [P1]: 2, [P2]: 3, [P3]: 0 });
  assert.equal(world.snapshot().phase, "公开协商", "round two reopens the negotiation");
  const observation = world.observe(P2);
  assert.ok(observation.privateContext.includes("violated"), "the past violation is visible to the audience");
  assert.equal(commitments(world)[0].state, "violated", "the violation stays on the record");
});