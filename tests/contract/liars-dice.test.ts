/**
 * Liars-dice behavior chain (AGENTS.md §27/§28): a bid statement extracted as
 * a claimed-action reconciles against the dice when a challenge reveals them —
 * the verdict is computed from the world's own dice, deterministically. The
 * typed bid and the reveal are world truth; no intent is imputed.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 3);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-ld", scenarioId: "liars-dice", profiles, rounds: 2 }) as SocialWorldBase;
  world.start();
  return world;
}

function evidence(world: SocialWorldBase): Array<{ propositionId: string; supports: boolean; sourceType: string }> {
  return (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { evidence: Array<{ propositionId: string; supports: boolean; sourceType: string }> } }).socialCausalityFor(undefined, true).evidence;
}

it("a bid claim is reconciled against the revealed dice on challenge", async () => {
  const world = makeWorld();
  // The opener is random; whoever opens claims "at least 4 fives" in chat.
  const opening = world.activation();
  assert.ok(opening && opening.actorIds.length === 1, "the opening bidder gets the move");
  const opener = opening.actorIds[0];
  const message = await world.sendMessage({ senderId: opener, channel: "public", text: "我这里至少有 4 个 5。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: opener, predicate: "claimed-action", object: "bid-4-5" }
  }]);
  await world.performDomainAction(opener, "liars_move", { move: "bid", quantity: 4, face: 5, reason: "t" });
  world.completeActivation(opening);
  // The next actor challenges the 4×5 bid.
  const challengerActivation = world.activation();
  assert.ok(challengerActivation && challengerActivation.actorIds.length === 1);
  const challenger = challengerActivation.actorIds[0];
  assert.notEqual(challenger, opener, "the next actor holds the move");
  await world.performDomainAction(challenger, "liars_move", { move: "challenge", reason: "t" });
  world.completeActivation(challengerActivation);
  // Compute the verdict from the world's own dice: a challenge reveals them.
  const exported = (world.exportState().world as unknown as { dice: Array<[string, number]> }).dice;
  const actualCount = exported.filter(([, die]) => die === 5).length;
  const reconciled = evidence(world).filter((entry) => entry.sourceType === "domain-result");
  assert.ok(reconciled.length >= 1, "the challenge reconciles the bidder's claim");
  assert.equal(
    reconciled.some((entry) => entry.supports === (actualCount >= 4)),
    true,
    `the verdict matches the dice truth (${actualCount} fives)`
  );
});

it("an uncontested raise never reconciles a claim", async () => {
  const world = makeWorld();
  const opening = world.activation()!;
  const opener = opening.actorIds[0];
  const message = await world.sendMessage({ senderId: opener, channel: "public", text: "我这里至少有 2 个 6。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: opener, predicate: "claimed-action", object: "bid-2-6" }
  }]);
  await world.performDomainAction(opener, "liars_move", { move: "bid", quantity: 2, face: 6, reason: "t" });
  world.completeActivation(opening);
  const next = world.activation()!;
  await world.performDomainAction(next.actorIds[0], "liars_move", { move: "bid", quantity: 3, face: 6, reason: "t" });
  world.completeActivation(next);
  // Without a challenge the dice are never revealed and the claim stays open.
  const projection = (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { propositions: Array<{ propositionId: string; predicate: string }> } }).socialCausalityFor(undefined, true);
  const claim = projection.propositions.find((entry) => entry.predicate === "claimed-action");
  assert.ok(claim, "the claim proposition exists");
  assert.equal(
    evidence(world).some((entry) => entry.sourceType === "domain-result" && entry.propositionId === claim.propositionId),
    false,
    "no reconciliation without a reveal"
  );
});