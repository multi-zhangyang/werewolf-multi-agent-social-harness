/**
 * Story-beat evidence thresholds (AGENTS.md §8.3 / §23.1 P0-09): scenario
 * settlements may only carry strong social labels (betrayal, promise-kept,
 * alliance, deception-exposed, misplay) when the world holds matching social
 * evidence. Until the Commitment/Deception spine records it, every scenario
 * must downgrade to neutral outcome labels. Deterministic, no model calls:
 * drives the worlds through the same public surface the room uses.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase } from "../../src/society/world";
import type { ScenarioId, StoryBeatKind } from "../../src/society/contracts";

function check(name: string, fn: () => void | Promise<void>): void {
  it(name, fn);
}

function makeWorld(scenarioId: ScenarioId, count: number, rounds = 2): SocialWorldBase {
  const world = createWorld({
    roomId: `r-${scenarioId}`,
    scenarioId,
    profiles: createAgentProfiles(["model-a"], count),
    rounds
  }) as SocialWorldBase;
  world.start();
  return world;
}

/** Drive discussion waves until the next non-discussion activation opens. */
function skipDiscussion(world: SocialWorldBase): void {
  // Day 1 opens with the sheriff election (警长竞选): decline for everyone so
  // the flow lands in the first discussion wave, as the rest of the suite expects.
  const election = world.activation();
  if (election && election.id.endsWith(":sheriff-run")) {
    for (const actor of election.actorIds) {
      void world.performDomainAction(actor, "run_for_sheriff", { run: false, reason: "t" });
    }
    world.completeActivation(election);
  }
  for (let wave = 0; wave < 40; wave += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.includes(":discussion")) return;
    world.completeActivation(activation);
  }
  throw new Error("discussion never ended");
}

/** The vote may leave a last word; complete it silently so the flow advances. */
function passLastWords(world: SocialWorldBase): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.includes(":lastwords:")) return;
    world.completeActivation(activation);
  }
  throw new Error("last words never ended");
}

function lastBeat(world: SocialWorldBase): StoryBeatKind | undefined {
  return world.snapshot().log.at(-1)?.beat;
}

/** Submit one action per actor of a simultaneous activation, then settle it. */
async function settleSimultaneous(
  world: SocialWorldBase,
  action: string,
  payloadFor: (actorId: string, index: number) => Record<string, unknown>
): Promise<void> {
  skipDiscussion(world);
  const activation = world.activation();
  assert.ok(activation, "the choice activation opens after discussion");
  activation.actorIds.forEach((actor, index) => {
    void world.performDomainAction(actor, action, payloadFor(actor, index));
  });
  world.completeActivation(activation);
  await Promise.resolve();
}

// --- prisoners dilemma ---
check("prisoners dilemma: mutual cooperation is a cooperative outcome, not a kept promise", async () => {
  const world = makeWorld("prisoners-dilemma", 2);
  await settleSimultaneous(world, "choose_move", () => ({ move: "cooperate", reason: "t" }));
  assert.equal(lastBeat(world), "cooperative-outcome");
});

check("prisoners dilemma: a unilateral defection is not labeled a betrayal", async () => {
  const world = makeWorld("prisoners-dilemma", 2);
  await settleSimultaneous(world, "choose_move", (_actor, index) => ({ move: index === 0 ? "cooperate" : "defect", reason: "t" }));
  assert.equal(lastBeat(world), "unilateral-defection");
});

// --- stag hunt ---
check("stag hunt: a shared stag hunt is a cooperative outcome, not a kept promise", async () => {
  const world = makeWorld("stag-hunt", 2);
  await settleSimultaneous(world, "hunt_choice", () => ({ choice: "stag", reason: "t" }));
  assert.equal(lastBeat(world), "cooperative-outcome");
});

check("stag hunt: a rabbit defector strands the hunters without a betrayal label", async () => {
  const world = makeWorld("stag-hunt", 2);
  await settleSimultaneous(world, "hunt_choice", (_actor, index) => ({ choice: index === 0 ? "stag" : "rabbit", reason: "t" }));
  assert.equal(lastBeat(world), "unilateral-defection");
});

// --- public goods ---
check("public goods: zero contribution amid generosity is free-riding, not betrayal", async () => {
  const world = makeWorld("public-goods", 3);
  await settleSimultaneous(world, "contribute_to_pool", (_actor, index) => ({ amount: [0, 3, 3][index], reason: "t" }));
  assert.equal(lastBeat(world), "free-riding");
});

check("public goods: even high contributions are a cooperative outcome, not a kept promise", async () => {
  const world = makeWorld("public-goods", 3);
  await settleSimultaneous(world, "contribute_to_pool", () => ({ amount: 4, reason: "t" }));
  assert.equal(lastBeat(world), "cooperative-outcome");
});

// --- negotiation ---
check("negotiation: a struck deal is an agreement, not an alliance", async () => {
  const world = makeWorld("negotiation-game", 2);
  await settleSimultaneous(world, "submit_demand", (_actor, index) => ({ demand: index === 0 ? 4 : 6, reason: "t" }));
  assert.equal(lastBeat(world), "agreement-reached");
});

check("negotiation: a collapsed deal is a failed negotiation, not a misplay", async () => {
  const world = makeWorld("negotiation-game", 2);
  await settleSimultaneous(world, "submit_demand", () => ({ demand: 6, reason: "t" }));
  assert.equal(lastBeat(world), "negotiation-failed");
});

// --- ultimatum ---
check("ultimatum: an accepted split is an agreement, not an alliance", async () => {
  const world = makeWorld("ultimatum-game", 2);
  skipDiscussion(world);
  const propose = world.activation();
  assert.ok(propose && propose.id.endsWith(":propose"), "the proposer opens");
  await world.performDomainAction(propose.actorIds[0], "propose_split", { offer: 5, reason: "t" });
  world.completeActivation(propose);
  const respond = world.activation();
  assert.ok(respond && respond.id.endsWith(":respond"), "the responder answers");
  await world.performDomainAction(respond.actorIds[0], "respond_to_offer", { accept: true, reason: "t" });
  world.completeActivation(respond);
  assert.equal(lastBeat(world), "agreement-reached");
});

check("ultimatum: a rejected split is a failed negotiation, not a misplay", async () => {
  const world = makeWorld("ultimatum-game", 2);
  skipDiscussion(world);
  const propose = world.activation()!;
  await world.performDomainAction(propose.actorIds[0], "propose_split", { offer: 1, reason: "t" });
  world.completeActivation(propose);
  const respond = world.activation()!;
  await world.performDomainAction(respond.actorIds[0], "respond_to_offer", { accept: false, reason: "t" });
  world.completeActivation(respond);
  assert.equal(lastBeat(world), "negotiation-failed");
});

// --- chicken ---
check("chicken: a head-on collision is an adverse outcome, not a misplay", async () => {
  const world = makeWorld("chicken-game", 2);
  await settleSimultaneous(world, "chicken_choice", () => ({ choice: "straight", reason: "t" }));
  assert.equal(lastBeat(world), "adverse-outcome");
});

// --- sealed bid auction (winner's curse needs a deterministic setup) ---
check("sealed bid auction: paying above your private value is an adverse outcome, not a misplay", async () => {
  const world = makeWorld("sealed-bid-auction", 3);
  // Each actor's private value is readable only through their own POV.
  const values = new Map<string, number>();
  for (const agent of world.snapshot().agents) {
    const match = /Your private value this round: (\d+)/.exec(world.observe(agent.id).privateContext);
    assert.ok(match, `each actor's private value is readable through their own POV (${agent.id})`);
    values.set(agent.id, Number(match[1]));
  }
  const winner = [...values.entries()].sort((a, b) => a[1] - b[1])[0];
  if (winner[1] >= 100) {
    // Degenerate draw: every value is maxed, the curse is unreachable — the
    // normal win label must stand instead.
    await settleSimultaneous(world, "submit_bid", () => ({ amount: 10, reason: "t" }));
    assert.equal(lastBeat(world), "win");
    return;
  }
  await settleSimultaneous(world, "submit_bid", (actor) => ({
    amount: actor === winner[0] ? 100 : Math.min(100, winner[1] + 1),
    reason: "t"
  }));
  assert.equal(lastBeat(world), "adverse-outcome");
});

// --- trust game: no commitment exists, so returns are only payoff outcomes ---
async function playRound(world: SocialWorldBase, investment: number, returned: number): Promise<void> {
  skipDiscussion(world);
  const invest = world.activation();
  assert.ok(invest && invest.id.endsWith(":investment"), "the investor opens");
  await world.performDomainAction(invest.actorIds[0], "make_investment", { amount: investment, reason: "t" });
  world.completeActivation(invest);
  const back = world.activation();
  assert.ok(back && back.id.endsWith(":return"), "the trustee answers");
  await world.performDomainAction(back.actorIds[0], "return_from_trust", { amount: returned, reason: "t" });
  world.completeActivation(back);
}

check("trust game: zero return without a commitment is an adverse outcome, never a broken promise", async () => {
  const world = makeWorld("trust-game", 2);
  await playRound(world, 8, 0);
  assert.equal(lastBeat(world), "adverse-outcome");
});

check("trust game: a generous return without a commitment is a high return, never a kept promise", async () => {
  const world = makeWorld("trust-game", 2);
  await playRound(world, 8, 12);
  assert.equal(lastBeat(world), "high-return");
});

check("trust game: a partial return without a commitment is a low return", async () => {
  const world = makeWorld("trust-game", 2);
  await playRound(world, 8, 3);
  assert.equal(lastBeat(world), "low-return");
});

// --- werewolf ---
function makeWerewolf(count: number): { world: SocialWorldBase; byRole: (role: string) => string[] } {
  const world = makeWorld("werewolf", count);
  const roles = (world.snapshot().details.roles ?? {}) as Record<string, string>;
  const byRole = (role: string): string[] =>
    Object.entries(roles).filter(([, assigned]) => assigned === role).map(([id]) => id);
  return { world, byRole };
}

check("werewolf: a knight duel that reveals a wolf is a role reveal, not a caught lie", async () => {
  const { world, byRole } = makeWerewolf(12);
  skipDiscussion(world);
  const duel = world.activation();
  assert.ok(duel && duel.id.endsWith(":knight"), "12P opens with the knight duel");
  await world.performDomainAction(byRole("knight")[0], "knight_challenge", { targetId: byRole("wolf")[0], reason: "t" });
  world.completeActivation(duel);
  assert.equal(lastBeat(world), "hidden-role-revealed");
});

check("werewolf: a knight dying against an innocent is an adverse outcome, not a misplay", async () => {
  const { world, byRole } = makeWerewolf(12);
  skipDiscussion(world);
  const duel = world.activation()!;
  await world.performDomainAction(byRole("knight")[0], "knight_challenge", { targetId: byRole("villager")[0], reason: "t" });
  world.completeActivation(duel);
  assert.equal(lastBeat(world), "adverse-outcome");
});

async function voteOut(world: SocialWorldBase, target: string, fallback: string): Promise<void> {
  skipDiscussion(world);
  const vote = world.activation();
  assert.ok(vote && vote.id.endsWith(":vote"), "the vote opens");
  for (const actor of vote.actorIds) {
    await world.performDomainAction(actor, "cast_day_vote", { targetId: actor === target ? fallback : target, reason: "t" });
  }
  world.completeActivation(vote);
  passLastWords(world);
}

check("werewolf: voting out a wolf is a role reveal, not a caught lie", async () => {
  const { world, byRole } = makeWerewolf(8);
  await voteOut(world, byRole("wolf")[0], byRole("villager")[0]);
  assert.equal(lastBeat(world), "hidden-role-revealed");
});

check("werewolf: voting out an innocent is an adverse outcome, not a misplay", async () => {
  const { world, byRole } = makeWerewolf(8);
  await voteOut(world, byRole("villager")[0], byRole("villager")[1]);
  assert.equal(lastBeat(world), "adverse-outcome");
});

check("werewolf: a night kill is an adverse outcome, not a betrayal", async () => {
  const { world, byRole } = makeWerewolf(8);
  await voteOut(world, byRole("villager")[0], byRole("villager")[1]);
  const night = world.activation()!;
  for (const wolf of byRole("wolf")) {
    await world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" });
  }
  if (byRole("guard")[0]) await world.performDomainAction(byRole("guard")[0], "guard_tonight", {});
  await world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  await world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night);
  assert.equal(lastBeat(world), "adverse-outcome");
});

// --- avalon ---
function makeAvalon(count: number): { world: SocialWorldBase; byRole: (role: string) => string[] } {
  const world = makeWorld("avalon", count, 5);
  const roles = new Map<string, string>();
  for (const profile of createAgentProfiles(["model-a"], count)) {
    roles.set(profile.id, String(world.observe(profile.id).self.role));
  }
  const byRole = (role: string): string[] =>
    [...roles].filter(([, assigned]) => assigned === role).map(([id]) => id);
  return { world, byRole };
}

check("avalon: an approved team is an agreement, not an alliance", async () => {
  const { world } = makeAvalon(5);
  skipDiscussion(world);
  const proposal = world.activation();
  assert.ok(proposal && proposal.id.endsWith(":proposal"), "the leader proposes");
  const leader = proposal.actorIds[0];
  await world.performDomainAction(leader, "propose_team", { memberIds: [leader, leader === world.snapshot().agents[0].id ? world.snapshot().agents[1].id : world.snapshot().agents[0].id], reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation();
  assert.ok(vote && vote.id.endsWith(":vote"), "the round table votes");
  for (const actor of vote.actorIds) await world.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
  world.completeActivation(vote);
  assert.equal(lastBeat(world), "agreement-reached");
});

check("avalon: a failed quest is a unilateral defection, not a betrayal", async () => {
  const { world, byRole } = makeAvalon(5);
  skipDiscussion(world);
  const proposal = world.activation()!;
  const leader = proposal.actorIds[0];
  // Roles are dealt randomly: the leader may itself be evil, so the saboteur
  // must be a different evil member (a team needs two distinct members).
  const evil = [...byRole("morgana"), ...byRole("assassin")];
  const saboteur = evil.find((id) => id !== leader) ?? evil[0];
  await world.performDomainAction(leader, "propose_team", { memberIds: [leader, saboteur], reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) await world.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
  world.completeActivation(vote);
  const quest = world.activation();
  assert.ok(quest && quest.id.endsWith(":quest"), "the approved team heads out");
  for (const actor of quest.actorIds) {
    await world.performDomainAction(actor, "cast_quest_vote", { choice: actor === saboteur ? "fail" : "succeed", reason: "t" });
  }
  world.completeActivation(quest);
  assert.equal(lastBeat(world), "unilateral-defection");
});