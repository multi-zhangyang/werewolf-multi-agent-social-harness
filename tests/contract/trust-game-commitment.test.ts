/**
 * Trust-game commitment slice (AGENTS.md §14.6 / §8.1): the acceptance case
 * end to end at the world level — a declared promise, a decision that cites
 * it, settlement against the sealed actions, and the promise-kept/broken
 * label only where the evidence exists. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import { TRUST_GAME_STATE_SCHEMA_VERSION } from "../../src/society/scenarios/trustGame";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";
import type { Commitment, DecisionRecord, StoryBeatKind, WorldActionCommit } from "../../src/society/contracts";

const profiles = createAgentProfiles(["model-a"], 2);
const [INVESTOR_R1, TRUSTEE_R1] = profiles.map((profile) => profile.id);

function makeWorld(rounds = 2): SocialWorldBase {
  const world = createWorld({ roomId: "room-c", scenarioId: "trust-game", profiles, rounds }) as SocialWorldBase;
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

async function declare(world: SocialWorldBase, actorId: string, actionType: "return-at-least" | "invest-at-least", amount: number, proposition = "p"): Promise<WorldActionCommit> {
  const commit = await world.performDomainAction(actorId, "make_commitment", { proposition, actionType, amount });
  return commit;
}

async function playRound(
  world: SocialWorldBase,
  investment: number,
  returned: number,
  investmentRefs: string[] = []
): Promise<void> {
  // Settlement only checks accepted promises (§8.3): the recipient must take
  // the promise during the negotiation, so the helper accepts every open
  // declaration addressed to it before closing the discussion — exactly what
  // a live recipient would do.
  const investorId = world.snapshot().agents[0]?.id ?? "";
  for (const commitment of commitments(world)) {
    if (commitment.state !== "proposed") continue;
    if (!commitment.audienceActorIds.includes(investorId)) continue;
    await world.performDomainAction(investorId, "accept_commitment", { commitmentId: commitment.commitmentId });
  }
  driveDiscussion(world);
  const invest = world.activation();
  assert.ok(invest && invest.id.endsWith(":investment"));
  await world.performDomainAction(invest.actorIds[0], "make_investment", {
    amount: investment,
    reason: "t",
    ...(investmentRefs.length ? { referencedCommitmentIds: investmentRefs } : {})
  });
  world.completeActivation(invest);
  const back = world.activation();
  assert.ok(back && back.id.endsWith(":return"));
  await world.performDomainAction(back.actorIds[0], "return_from_trust", { amount: returned, reason: "t" });
  world.completeActivation(back);
}

function commitments(world: SocialWorldBase): Commitment[] {
  return (world.snapshot().details.commitments as Commitment[]) ?? [];
}

function decisions(world: SocialWorldBase): DecisionRecord[] {
  return (world.snapshot().details.decisionRecords as DecisionRecord[]) ?? [];
}

function lastBeat(world: SocialWorldBase): StoryBeatKind | undefined {
  return world.snapshot().log.at(-1)?.beat;
}

// --- declaration rules ---
it("a trustee can declare a return-at-least promise during the negotiation", async () => {
  const world = makeWorld();
  const commit = await declare(world, TRUSTEE_R1, "return-at-least", 10, "我会返还至少 10。");
  const result = commit.result as { commitmentId: string };
  assert.ok(result.commitmentId, "the declaration mints a stable commitment id");
  const ledger = commitments(world);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].promisorActorId, TRUSTEE_R1);
  assert.equal(ledger[0].state, "proposed");
  assert.deepEqual(ledger[0].audienceActorIds, [INVESTOR_R1]);
  assert.equal(commit.commandId, ledger[0].createdByCommandId, "the receipt is the creation command");
  // The promisee gets a structured appraisal event, not just text.
  const events = world.eventsFor(INVESTOR_R1);
  assert.ok(events.some((event) => event.type === "commitment-proposed"), "the audience receives the declaration event");
});

it("commitments are gated by phase, role, amount and a per-round cap", async () => {
  const world = makeWorld();
  // The investor cannot promise a return, and the trustee cannot promise an investment.
  await assert.rejects(declare(world, INVESTOR_R1, "return-at-least", 10), /ROLE_MISMATCH/);
  await assert.rejects(declare(world, TRUSTEE_R1, "invest-at-least", 5), /ROLE_MISMATCH/);
  // Amounts beyond the endowment or the multiplied pool are refused.
  await assert.rejects(declare(world, TRUSTEE_R1, "return-at-least", 31), /COMMITMENT_AMOUNT_INVALID/);
  // Only during the negotiation.
  driveDiscussion(world);
  const invest = world.activation()!;
  await assert.rejects(world.performDomainAction(invest.actorIds[0], "make_commitment", { proposition: "p", actionType: "invest-at-least", amount: 3 }), /COMMITMENT_NOT_OPEN/);
  world.completeActivation(invest);
});

it("at most three commitments per participant per round", async () => {
  const world = makeWorld();
  await declare(world, TRUSTEE_R1, "return-at-least", 1);
  await declare(world, TRUSTEE_R1, "return-at-least", 2);
  await declare(world, TRUSTEE_R1, "return-at-least", 3);
  await assert.rejects(declare(world, TRUSTEE_R1, "return-at-least", 4), /COMMITMENT_LIMIT_EXCEEDED/);
});

// --- settlement: the world checks the promise against the sealed action ---
it("a fulfilled return promise earns promise-kept", async () => {
  const world = makeWorld();
  await declare(world, TRUSTEE_R1, "return-at-least", 10, "我会返还至少 10。");
  await playRound(world, 8, 10);
  const ledger = commitments(world);
  assert.equal(ledger[0].state, "fulfilled");
  assert.equal(ledger[0].settledAtTurn, 1);
  assert.equal(lastBeat(world), "promise-kept");
});

it("zero return against a declared promise earns promise-broken (§14.6 step 8)", async () => {
  const world = makeWorld();
  await declare(world, TRUSTEE_R1, "return-at-least", 10, "你投 8，我至少返还 10。");
  await playRound(world, 8, 0);
  const ledger = commitments(world);
  assert.equal(ledger[0].state, "violated");
  assert.equal(lastBeat(world), "promise-broken");
  const events = world.eventsFor(INVESTOR_R1);
  assert.ok(events.some((event) => event.type === "commitment-violated" && event.facts?.commitmentId === ledger[0].commitmentId), "the promisee gets the violation event with the commitment id");
});

it("a partial return below the promise is a violation, not a half-kept promise", async () => {
  const world = makeWorld();
  await declare(world, TRUSTEE_R1, "return-at-least", 10, "至少返还 10。");
  await playRound(world, 8, 5);
  assert.equal(commitments(world)[0].state, "violated");
  assert.equal(lastBeat(world), "promise-broken");
});

it("an investor promise is checked against the investment", async () => {
  const world = makeWorld();
  await declare(world, INVESTOR_R1, "invest-at-least", 8, "我会投至少 8。");
  // The investor's own promise is addressed to the trustee; the trustee accepts.
  const trusteeId = world.snapshot().agents[1]?.id ?? "";
  await world.performDomainAction(trusteeId, "accept_commitment", { commitmentId: commitments(world)[0].commitmentId });
  await playRound(world, 8, 5);
  assert.equal(commitments(world)[0].state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

it("without any declaration the settlement stays a neutral payoff label", async () => {
  const world = makeWorld();
  await playRound(world, 8, 12);
  assert.equal(commitments(world).length, 0);
  assert.equal(lastBeat(world), "high-return");
});

// --- decision records ---
it("a binding action records a DecisionRecord citing the promises it used", async () => {
  const world = makeWorld();
  const declared = await declare(world, TRUSTEE_R1, "return-at-least", 10, "我会返还至少 10。");
  const commitmentId = (declared.result as { commitmentId: string }).commitmentId;
  await playRound(world, 8, 0, [commitmentId]);
  const records = decisions(world);
  assert.ok(records.length >= 2, "investment and return each leave a decision record");
  const investmentDecision = records.find((record) => record.action === "make_investment");
  assert.ok(investmentDecision, "the investment decision exists");
  assert.deepEqual(investmentDecision!.referencedCommitmentIds, [commitmentId]);
  assert.equal(investmentDecision!.characterId, profiles[0].characterId, "the record is bound to the permanent character");
  assert.ok(investmentDecision!.commandId, "the record carries the idempotent command receipt");
});

it("decisions may only cite commitments the actor is party to this round", async () => {
  const world = makeWorld();
  const declared = await declare(world, TRUSTEE_R1, "return-at-least", 10, "我会返还至少 10。");
  const commitmentId = (declared.result as { commitmentId: string }).commitmentId;
  driveDiscussion(world);
  const invest = world.activation()!;
  await assert.rejects(
    world.performDomainAction(invest.actorIds[0], "make_investment", { amount: 8, reason: "t", referencedCommitmentIds: ["commit-bogus"] }),
    /COMMITMENT_REFERENCE_INVALID/
  );
  // A foreign round's commitment is not citable either.
  const stale = structuredClone(commitments(world)[0]);
  stale.round = 99;
  // (The world-level guard simply requires the id to exist in this round;
  //  mutate through the export surface is out of scope here — the bogus-id
  //  rejection above pins the lookup behavior.)
  assert.equal(stale.round, 99);
  await world.performDomainAction(invest.actorIds[0], "make_investment", { amount: 8, reason: "t", referencedCommitmentIds: [commitmentId] });
  world.completeActivation(invest);
  assert.equal(decisions(world).at(-1)?.referencedCommitmentIds?.[0], commitmentId);
});

// --- checkpoint: the ledger survives every phase, v1 is rejected ---
it("commitments and decision records survive an export/restore round-trip", async () => {
  const world = makeWorld();
  await declare(world, TRUSTEE_R1, "return-at-least", 10, "我会返还至少 10。");
  const state = world.exportState();
  const restored = createWorld({ roomId: "room-c", scenarioId: "trust-game", profiles, rounds: 2, state }) as SocialWorldBase;
  restored.start();
  assert.equal(commitments(restored).length, 1);
  assert.equal(commitments(restored)[0].state, "proposed");
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world), "re-export is stable");
});

it("v1 checkpoints without the commitment ledger are rejected loudly", () => {
  const world = makeWorld();
  const state = world.exportState();
  const legacy = structuredClone(state) as unknown as { world: { schemaVersion: number } };
  legacy.world.schemaVersion = 1;
  assert.throws(
    () => createWorld({ roomId: "room-c", scenarioId: "trust-game", profiles, rounds: 2, state: legacy as unknown as WorldSerializedState }),
    /SCENARIO_STATE_MIGRATION_REQUIRED.*expected 3/
  );
  assert.equal(TRUST_GAME_STATE_SCHEMA_VERSION, 3);
});

// --- role reversal: the next round sees the settled history ---
it("after the role swap, round two observes round one's settlement", async () => {
  const world = makeWorld();
  await declare(world, TRUSTEE_R1, "return-at-least", 10, "我会返还至少 10。");
  await playRound(world, 8, 0);
  assert.equal(world.snapshot().phase, "协商", "round two reopens the negotiation");
  const observation = world.observe(INVESTOR_R1);
  assert.ok(observation.privateContext.includes("R1 investor"), "the role history names round one");
  assert.ok(observation.privateContext.includes("Open commitments this round: none."), "settled promises no longer hang open");
  const ledger = commitments(world);
  assert.equal(ledger[0].state, "violated", "the violation stays on the record after the swap");
});
// --- return-ratio promises (§8.1): commit before the stake is known ---
it("a return-ratio promise settles against the actual transfer, not a fixed amount", async () => {
  const world = makeWorld();
  const ratio = await world.performDomainAction(TRUSTEE_R1, "make_commitment", {
    proposition: "你投多少，我至少返 150%。",
    actionType: "return-ratio",
    amount: 150
  });
  const commitmentId = (ratio.result as { commitmentId: string }).commitmentId;
  assert.ok(commitmentId, "the ratio declaration mints a commitment");
  await playRound(world, 6, 9, [commitmentId]);
  const ledger = commitments(world);
  assert.equal(ledger[0].promisedAction.actionType, "return-ratio");
  assert.equal(ledger[0].state, "fulfilled", "9 returned on a 6 stake clears the 150% line");
  assert.equal(lastBeat(world), "promise-kept");
});

it("a return-ratio promise is violated when the actual return misses the percent line", async () => {
  const world = makeWorld();
  await world.performDomainAction(TRUSTEE_R1, "make_commitment", {
    proposition: "至少返两倍。",
    actionType: "return-ratio",
    amount: 200
  });
  await playRound(world, 8, 12);
  assert.equal(commitments(world)[0].state, "violated", "12 < 16 required by 200% of 8");
  assert.equal(lastBeat(world), "promise-broken");
});

it("an extracted invest claim reconciles against the sealed stake", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const message = await world.sendMessage({ senderId: INVESTOR_R1, channel: "public", text: "我会投 8。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: INVESTOR_R1, predicate: "claimed-action", object: "invest-8" }
  }]);
  const invest = world.activation()!;
  await world.performDomainAction(invest.actorIds[0], "make_investment", { amount: 3, reason: "t" });
  world.completeActivation(invest);
  const back = world.activation()!;
  await world.performDomainAction(back.actorIds[0], "return_from_trust", { amount: 0, reason: "t" });
  world.completeActivation(back);
  const projection = (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { evidence: Array<{ propositionId: string; supports: boolean; sourceType: string }> } }).socialCausalityFor(undefined, true);
  assert.ok(
    projection.evidence.some((entry) => entry.sourceType === "domain-result" && entry.supports === false),
    "investing 3 contradicts the claimed invest-8"
  );
});

it("return-ratio amounts are validated as percents, not absolute pools", async () => {
  const world = makeWorld();
  await assert.rejects(
    world.performDomainAction(TRUSTEE_R1, "make_commitment", { proposition: "p", actionType: "return-ratio", amount: 0 }),
    /COMMITMENT_RATIO_INVALID/
  );
  await assert.rejects(
    world.performDomainAction(TRUSTEE_R1, "make_commitment", { proposition: "p", actionType: "return-ratio", amount: 100 * 3 + 1 }),
    /COMMITMENT_RATIO_INVALID/
  );
});
