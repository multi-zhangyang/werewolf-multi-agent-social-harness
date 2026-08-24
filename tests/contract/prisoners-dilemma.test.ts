/**
 * Prisoners-dilemma behavior chain (AGENTS.md §27/§28): a cooperation promise
 * → the sealed simultaneous choice → settlement against the accepted promise
 * → promise-kept / promise-broken strong labels only where the evidence
 * exists; neutral labels otherwise; sealed moves never cross observation
 * boundaries; model-extracted action claims are reconciled against the actual
 * move. Deterministic, no model calls.
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
  const world = createWorld({ roomId: "r-pd", scenarioId: "prisoners-dilemma", profiles, rounds }) as SocialWorldBase;
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

async function declare(world: SocialWorldBase, promisor: string, move: "cooperate" | "defect", proposition: string): Promise<string> {
  const commit = await world.performDomainAction(promisor, "make_commitment", { move, proposition });
  return (commit.result as { commitmentId: string }).commitmentId;
}

async function playRound(world: SocialWorldBase, p1Move: "cooperate" | "defect", p2Move: "cooperate" | "defect"): Promise<void> {
  driveDiscussion(world);
  const choice = world.activation();
  assert.ok(choice && choice.id.endsWith(":choice"), "the sealed choice phase opens");
  // Seal the moves one at a time; the barrier holds until both commit.
  await world.performDomainAction(choice.actorIds[0], "choose_move", { move: p1Move, reason: "t" });
  await world.performDomainAction(choice.actorIds[1], "choose_move", { move: p2Move, reason: "t" });
  world.completeActivation(choice);
}

// --- behavior chain: promise → sealed choice → settlement ---
it("an accepted cooperate promise that the promisor honors earns promise-kept", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "cooperate", "我会合作。");
  // The audience must accept before the promise is settlement-eligible.
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, "cooperate", "cooperate");
  const ledger = commitments(world);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].state, "fulfilled");
  assert.equal(ledger[0].settledAtTurn, 1);
  assert.equal(lastBeat(world), "promise-kept");
});

it("a broken cooperation promise earns promise-broken with the violation event", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "cooperate", "我肯定合作，相信我。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, "defect", "cooperate");
  assert.equal(commitments(world)[0].state, "violated");
  assert.equal(lastBeat(world), "promise-broken");
  assert.ok(
    world.eventsFor(P2).some((event) => event.type === "commitment-violated" && event.facts?.commitmentId === commitmentId),
    "the audience receives the violation event citing the commitment"
  );
});

it("a defect promise honored by defecting is fulfilled, not betrayal", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "defect", "这轮我不合作。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, "defect", "defect");
  assert.equal(commitments(world)[0].state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

it("an unaccepted proposal is voided at settlement and never earns a strong label", async () => {
  const world = makeWorld();
  await declare(world, P1, "cooperate", "我会合作。");
  await playRound(world, "cooperate", "cooperate");
  assert.equal(commitments(world)[0].state, "void");
  assert.equal(lastBeat(world), "cooperative-outcome");
});

it("without any commitment the payoff labels stay neutral", async () => {
  const world = makeWorld();
  await playRound(world, "cooperate", "cooperate");
  assert.equal(commitments(world).length, 0);
  assert.equal(lastBeat(world), "cooperative-outcome");
  const world2 = makeWorld();
  await playRound(world2, "defect", "cooperate");
  assert.equal(lastBeat(world2), "unilateral-defection");
});

it("commitment references in the binding choice are validated", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "cooperate", "我会合作。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  driveDiscussion(world);
  const choice = world.activation()!;
  await assert.rejects(
    world.performDomainAction(choice.actorIds[0], "choose_move", {
      move: "cooperate", reason: "t", referencedCommitmentIds: ["commit-bogus"]
    }),
    /COMMITMENT_REFERENCE_INVALID/
  );
  // A valid reference to this round's accepted promise is accepted.
  await world.performDomainAction(choice.actorIds[0], "choose_move", {
    move: "cooperate", reason: "t", referencedCommitmentIds: [commitmentId]
  });
});

// --- sealing: committed moves never cross an observation boundary ---
it("a sealed move stays invisible to the other player and to spectators", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const choice = world.activation()!;
  await world.performDomainAction(choice.actorIds[0], "choose_move", { move: "defect", reason: "t" });
  const publicView = world.snapshotFor(undefined).details as Record<string, unknown>;
  assert.ok(!("pendingChoices" in publicView), "spectators never see the sealed choice bookkeeping");
  assert.ok(!JSON.stringify(publicView).includes('"defect"'), "spectators never see the committed value");
  const povView = world.snapshotFor(choice.actorIds[1]).details as Record<string, unknown>;
  assert.ok(!("pendingChoices" in povView), "the other player's POV never sees the sealed choice bookkeeping");
  assert.ok(!JSON.stringify(povView).includes('"defect"'), "the other player's POV never sees the sealed value");
  const internal = world.snapshot().details as { pendingChoices?: string[] };
  assert.deepEqual(internal.pendingChoices, [choice.actorIds[1]], "the world itself still tracks the pending side");
});

// --- model-extracted action claims are reconciled against the actual move ---
function claimPropositionId(world: SocialWorldBase): string {
  const projection = (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { propositions: Array<{ propositionId: string; predicate: string }> } }).socialCausalityFor(undefined, true);
  const claim = projection.propositions.find((entry) => entry.predicate === "claimed-action");
  assert.ok(claim, "the claimed-action proposition exists");
  return claim.propositionId;
}

function claimEvidence(world: SocialWorldBase): Array<{ propositionId: string; supports: boolean; sourceType: string }> {
  return (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { evidence: Array<{ propositionId: string; supports: boolean; sourceType: string }> } }).socialCausalityFor(undefined, true).evidence;
}

it("a claimed action that the move contradicts records contradiction evidence", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "这轮我肯定合作。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "cooperate" }
  }]);
  const choice = world.activation()!;
  await world.performDomainAction(choice.actorIds[0], "choose_move", { move: "defect", reason: "t" });
  await world.performDomainAction(choice.actorIds[1], "choose_move", { move: "cooperate", reason: "t" });
  world.completeActivation(choice);
  const propositionId = claimPropositionId(world);
  const evidence = claimEvidence(world).filter((entry) => entry.propositionId === propositionId && entry.sourceType === "domain-result");
  assert.ok(evidence.length >= 1, "the settlement reconciles the claim");
  assert.equal(evidence[0].supports, false, "defect contradicts the claimed cooperate");
});

it("a matched action claim records supporting evidence", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我会合作。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "cooperate" }
  }]);
  const choice = world.activation()!;
  await world.performDomainAction(choice.actorIds[0], "choose_move", { move: "cooperate", reason: "t" });
  await world.performDomainAction(choice.actorIds[1], "choose_move", { move: "cooperate", reason: "t" });
  world.completeActivation(choice);
  const propositionId = claimPropositionId(world);
  assert.ok(
    claimEvidence(world).some((entry) => entry.propositionId === propositionId && entry.sourceType === "domain-result" && entry.supports === true),
    "cooperate supports the claimed cooperate"
  );
});

// --- sealed choice: the barrier holds until both moves are in ---
it("commitments and a sealed choice settle identically on the live path", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "cooperate", "我会合作。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  driveDiscussion(world);
  const choice = world.activation()!;
  await world.performDomainAction(choice.actorIds[0], "choose_move", { move: "cooperate", reason: "t" });
  await world.performDomainAction(choice.actorIds[1], "choose_move", { move: "cooperate", reason: "t" });
  world.completeActivation(choice);
  assert.equal(commitments(world)[0].state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

// --- repeated interaction: the next round observes the settled history ---
it("round two observes round one's settlement and honors its own commitments", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "cooperate", "我会合作。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, "defect", "cooperate");
  assert.equal(world.snapshot().phase, "谈判", "round two reopens the negotiation");
  const observation = world.observe(P2);
  assert.ok(observation.privateContext.includes("承诺违约") || observation.privateContext.includes("violated"), "the past violation is visible to the audience");
  const ledger = commitments(world);
  assert.equal(ledger[0].state, "violated", "the violation stays on the record");
});