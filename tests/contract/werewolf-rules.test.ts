/**
 * Werewolf + Avalon rule checks (scenario contract suite). Deterministic, no
 * model calls: drives the worlds through the same public surface the room
 * uses (activation / performDomainAction / completeActivation) and pins the
 * researched table rules — decks, night order, guard/witch interactions,
 * hunter shots, jester side-win, parity, and Avalon's official player-count
 * tables.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import type { SocialWorldBase } from "../../src/society/world";
import type { AgentProfile } from "../../src/society/contracts";
import { deckForPlayerCount as avalonDeck, QUEST_TEAM_SIZES, ladyVerdictFor, questFailsNeeded } from "../../src/society/scenarios/avalon";
import { WEREWOLF_DECKS, isWolfRole } from "../../src/society/scenarios/werewolf/roles";

function check(name: string, fn: () => void | Promise<void>): void {
  it(name, fn);
}

function profiles(count: number): AgentProfile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `agent-${String(index + 1).padStart(2, "0")}`,
    displayName: `P${index + 1}`,
    characterId: `char-test-${index + 1}`,
    persona: "test",
    traits: [],
    values: [],
    goals: [],
    temperament: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
    voice: "",
    regulation: "suppress",
    model: "fake-model",
    controller: "agent"
  }));
}

function makeWerewolf(count: number) {
  const world = createWorld({ roomId: "r-ww", scenarioId: "werewolf", profiles: profiles(count), rounds: 2 }) as SocialWorldBase;
  world.start();
  const snapshot = world.snapshot();
  const roles = snapshot.details.roles as Record<string, string>;
  const byRole = (role: string) => Object.entries(roles).filter(([, r]) => r === role).map(([id]) => id);
  return { world, roles, byRole };
}

/** Drive through discussion waves until the vote (or next phase) opens. */
function skipDiscussion(world: SocialWorldBase): void {
  for (let i = 0; i < 20; i += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.includes(":discussion")) return;
    world.completeActivation(activation!);
  }
  throw new Error("discussion never ended");
}

// --- deck composition ---
check("werewolf decks match their player counts and standard wolf tables", () => {
  const expectedWolves: Record<number, number> = { 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 4, 12: 4 };
  for (const deck of WEREWOLF_DECKS) {
    assert.equal(deck.roles.length, deck.playerCount, `${deck.name} role count`);
    const wolves = deck.roles.filter(isWolfRole).length;
    assert.equal(wolves, expectedWolves[deck.playerCount], `${deck.name} wolf count`);
    assert.ok(deck.roles.includes("seer") && deck.roles.includes("witch"), `${deck.name} must include seer and witch`);
  }
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 12)!.roles.includes("wolf-king"), "12P includes the wolf king");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 12)!.roles.includes("knight"), "12P includes the knight");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 12)!.roles.includes("idiot"), "12P includes the idiot");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 12)!.roles.includes("hidden-wolf"), "12P includes the hidden wolf");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 12)!.roles.includes("white-wolf-king"), "12P includes the white wolf king");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 11)!.roles.includes("wolf-beauty"), "11P includes the wolf beauty");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 11)!.roles.includes("spirit-seer"), "11P includes the spirit seer");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 10)!.roles.includes("nightmare"), "10P includes the nightmare");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 11)!.roles.includes("hidden-wolf"), "11P includes the hidden wolf");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 10)!.roles.includes("jester"), "10P includes the jester");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 7), "7P deck exists (生还者 board)");
  assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 11), "11P deck exists (standard board)");
  // Every count in the advertised 6-12 range must resolve to a full deck.
  for (let count = 6; count <= 12; count += 1) {
    const deck = WEREWOLF_DECKS.find((entry) => entry.playerCount === count);
    assert.ok(deck, `deck exists for ${count}P`);
    assert.equal(deck!.roles.length, count, `${count}P deck size`);
  }
});

// --- day flow: discussion ends, votes eliminate ---
check("day vote eliminates the plurality target and reveals the role", () => {
  const { world, byRole } = makeWerewolf(8);
  skipDiscussion(world);
  const vote = world.activation()!;
  assert.ok(vote && vote.id.endsWith(":vote"));
  const target = byRole("villager")[0];
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === target ? byRole("villager")[1] : target, reason: "t" });
  }
  world.completeActivation(vote);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === target)?.alive, "voted target is eliminated");
  assert.equal(after.phase, "夜晚行动", "phase advances to night");
});

// --- §28 lie loop: an identity claim contradicted by a reveal becomes a
// born-detected deception episode (claim -> vote-out -> reveal -> reconcile).
function deceptionProjection(world: SocialWorldBase): Array<{
  deceiverActorId: string;
  status: string;
  mode: string;
  executionMessageIds: string[];
  contradictionEventIds: string[];
}> {
  const projection = (world as unknown as {
    socialCausalityFor(actorId?: string, omniscient?: boolean): { deceptions: Array<{
      deceiverActorId: string;
      status: string;
      mode: string;
      executionMessageIds: string[];
      contradictionEventIds: string[];
    }> };
  }).socialCausalityFor(undefined, true);
  return projection.deceptions;
}

function voteOut(world: SocialWorldBase, target: string, byRole: (role: string) => string[]): void {
  skipDiscussion(world);
  const vote = world.activation()!;
  assert.ok(vote && vote.id.endsWith(":vote"));
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === target ? byRole("villager")[0] : target, reason: "t" });
  }
  world.completeActivation(vote);
}

check("a wolf's extracted good-camp claim is detected at the vote-out reveal", async () => {
  const { world, byRole } = makeWerewolf(8);
  const wolf = byRole("wolf")[0];
  const message = await world.sendMessage({ senderId: wolf, channel: "public", text: "我是好人阵营的，别投我。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "identity", subjectId: wolf, predicate: "has-team", object: "good" }
  }]);
  voteOut(world, wolf, byRole);
  const episode = deceptionProjection(world).find((entry) => entry.deceiverActorId === wolf);
  assert.ok(episode, "the false camp claim becomes a deception episode");
  assert.equal(episode.status, "detected");
  assert.equal(episode.mode, "identity-performance");
  assert.ok(episode.executionMessageIds.includes(message.id), "the episode cites the claim's message");
  assert.ok(episode.contradictionEventIds.length >= 1, "the reveal event contradicts the claim");
});

check("a wolf's explicit villager claim is detected at the vote-out reveal", async () => {
  const { world, byRole } = makeWerewolf(8);
  const wolf = byRole("wolf")[0];
  await world.sendMessage({
    senderId: wolf,
    channel: "public",
    text: "我是村民，相信我。",
    socialActs: [{ kind: "assertion", proposition: { kind: "identity", subjectId: wolf, predicate: "has-role", object: "villager" } }]
  });
  voteOut(world, wolf, byRole);
  const episode = deceptionProjection(world).find((entry) => entry.deceiverActorId === wolf);
  assert.ok(episode, "the explicit false-role claim becomes a deception episode");
  assert.equal(episode.status, "detected");
  assert.equal(episode.mode, "identity-performance");
  assert.ok(episode.executionMessageIds.length >= 1, "the episode cites the claim's message");
  assert.ok(episode.contradictionEventIds.length >= 1, "the reveal event contradicts the claim");
});

// --- idiot rules ---
check("idiot voted out flips, survives and loses the vote", async () => {
  const { world, byRole } = makeWerewolf(10);
  skipDiscussion(world);
  const vote = world.activation()!;
  assert.ok(vote && vote.id.endsWith(":vote"));
  const idiot = byRole("idiot")[0];
  assert.ok(vote.actorIds.includes(idiot), "the idiot votes on day one");
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === idiot ? byRole("villager")[0] : idiot, reason: "t" });
  }
  world.completeActivation(vote);
  const after = world.snapshot();
  assert.ok(after.agents.find((agent) => agent.id === idiot)?.alive, "the idiot survives the vote-out");
  assert.ok(after.log.some((entry) => /白痴身份/.test(entry.text)), "the flip is logged");
  await assert.rejects(
    world.performDomainAction(idiot, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" }),
    /IDIOT_CANNOT_VOTE/,
    "the revealed idiot cannot vote again"
  );
});

check("a second vote-out eliminates the revealed idiot", () => {
  const { world, byRole } = makeWerewolf(10);
  skipDiscussion(world);
  const idiot = byRole("idiot")[0];
  const vote1 = world.activation()!;
  for (const actor of vote1.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === idiot ? byRole("villager")[0] : idiot, reason: "t" });
  }
  world.completeActivation(vote1);
  // A quiet night: wolves kill one villager, witch passes, guard skips.
  const night = world.activation()!;
  for (const wolf of [...byRole("wolf"), ...byRole("wolf-king"), ...byRole("nightmare")]) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("villager")[0], reason: "t" });
  if (byRole("nightmare")[0]) void world.performDomainAction(byRole("nightmare")[0], "dream_curse", {});
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", {});
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  skipDiscussion(world);
  const vote2 = world.activation()!;
  assert.ok(vote2 && vote2.id.endsWith(":vote"));
  assert.ok(!vote2.actorIds.includes(idiot), "the revealed idiot is not asked to vote");
  for (const actor of vote2.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: idiot, reason: "t" });
  }
  world.completeActivation(vote2);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === idiot)?.alive, "the revealed idiot dies on the second vote-out");
});

// --- knight rules ---
check("knight duel eliminates a wolf and the vote then opens", () => {
  const { world, byRole } = makeWerewolf(12);
  skipDiscussion(world);
  const duel = world.activation()!;
  assert.ok(duel && duel.id.endsWith(":knight"), "the knight's duel opens before the vote");
  const knight = byRole("knight")[0];
  const wolf = byRole("wolf")[0];
  void world.performDomainAction(knight, "knight_challenge", { targetId: wolf, reason: "t" });
  world.completeActivation(duel);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === wolf)?.alive, "the challenged wolf is eliminated");
  assert.ok(after.agents.find((agent) => agent.id === knight)?.alive, "the knight survives");
  assert.equal(after.phase, "白天投票", "the vote opens after the duel");
});

check("knight duel against a non-wolf kills the knight", () => {
  const { world, byRole } = makeWerewolf(12);
  skipDiscussion(world);
  const duel = world.activation()!;
  const knight = byRole("knight")[0];
  const villager = byRole("villager")[0];
  void world.performDomainAction(knight, "knight_challenge", { targetId: villager, reason: "t" });
  world.completeActivation(duel!);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === knight)?.alive, "the knight dies");
  assert.ok(after.agents.find((agent) => agent.id === villager)?.alive, "the challenged villager survives");
  assert.equal(after.phase, "白天投票", "the vote opens after the failed duel");
});

check("a knight who passes never gets a second duel", () => {
  const { world, byRole } = makeWerewolf(12);
  skipDiscussion(world);
  const duel = world.activation()!;
  const knight = byRole("knight")[0];
  void world.performDomainAction(knight, "knight_challenge", { reason: "t" });
  world.completeActivation(duel!);
  const after = world.snapshot();
  assert.equal(after.phase, "白天投票", "the vote opens after the pass");
  // A quiet night, then day two must open straight into the vote.
  const vote = world.activation()!;
  const villager = byRole("villager")[0];
  for (const actor of vote.actorIds) void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === villager ? byRole("seer")[0] : villager, reason: "t" });
  world.completeActivation(vote);
  const night = world.activation()!;
  const guard = byRole("guard")[0];
  for (const wolf of [...byRole("wolf"), ...byRole("wolf-king"), ...byRole("hidden-wolf"), ...byRole("white-wolf-king")]) void world.performDomainAction(wolf, "choose_night_target", { targetId: guard, reason: "t" });
  void world.performDomainAction(guard, "guard_tonight", { targetId: byRole("seer")[0] });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  skipDiscussion(world);
  const next = world.activation();
  assert.ok(next && next.id.endsWith(":vote"), "day two goes straight to the vote");
});

// --- witch rules ---
check("witch cannot save herself", async () => {
  const { world, byRole } = makeWerewolf(8);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote);
  const witch = byRole("witch")[0];
  await assert.rejects(
    () => world.performDomainAction(witch, "witch_night_choice", { saveTargetId: witch }),
    /WITCH_NO_SELF_SAVE/
  );
});

check("witch cannot use both potions in the same night", async () => {
  const { world, byRole } = makeWerewolf(8);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote);
  const witch = byRole("witch")[0];
  await assert.rejects(
    () => world.performDomainAction(witch, "witch_night_choice", { saveTargetId: byRole("villager")[1], poisonTargetId: byRole("seer")[0] }),
    /WITCH_BOTH_POTIONS_FORBIDDEN/
  );
});

// --- guard + witch night resolution ---
check("guard blocks the wolf kill", () => {
  const { world, byRole } = makeWerewolf(9);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote);
  const night = world.activation()!;
  const wolves = byRole("wolf");
  const victim = byRole("hunter")[0];
  for (const wolf of wolves) void world.performDomainAction(wolf, "choose_night_target", { targetId: victim, reason: "t" });
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", { targetId: victim });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  const after = world.snapshot();
  assert.ok(after.agents.find((agent) => agent.id === victim)?.alive, "guarded victim survives");
  assert.ok(after.log.some((entry) => /守卫/.test(entry.text)), "log reports the guard");
});

check("同守同救: guard + antidote on the same victim still kills", () => {
  const { world, byRole } = makeWerewolf(9);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote);
  const night = world.activation()!;
  const victim = byRole("hunter")[0];
  for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: victim, reason: "t" });
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", { targetId: victim });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", { saveTargetId: victim });
  world.completeActivation(night!);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === victim)?.alive, "奶穿: the victim dies despite guard + antidote");
  assert.ok(after.log.some((entry) => /奶穿/.test(entry.text)), "log reports the double-protection kill");
});

check("witch antidote saves the wolf victim", () => {
  const { world, byRole } = makeWerewolf(8);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote);
  const night = world.activation()!;
  const victim = byRole("seer")[0];
  for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: victim, reason: "t" });
  void world.performDomainAction(victim, "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", { saveTargetId: victim });
  world.completeActivation(night!);
  const after = world.snapshot();
  assert.ok(after.agents.find((agent) => agent.id === victim)?.alive, "saved victim survives");
  assert.ok(after.log.some((entry) => /解药/.test(entry.text)), "log reports the antidote");
});

check("poisoned hunter dies without a shot", () => {
  const { world, byRole } = makeWerewolf(8);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote);
  const night = world.activation()!;
  const hunter = byRole("hunter")[0];
  for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("villager")[1], reason: "t" });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", { poisonTargetId: hunter });
  world.completeActivation(night!);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === hunter)?.alive, "poisoned hunter dies");
  const next = world.activation();
  assert.ok(!next || !next.id.includes(":shot:"), "a poisoned hunter gets no death shot");
});

check("hunter killed by wolves gets a death shot that eliminates", () => {
  const { world, byRole } = makeWerewolf(8);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote);
  const night = world.activation()!;
  const hunter = byRole("hunter")[0];
  for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: hunter, reason: "t" });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  const shot = world.activation()!;
  assert.ok(shot && shot.id.includes(":shot:"), "the hunter's shot activation opens");
  const shotTarget = byRole("wolf")[0];
  void world.performDomainAction(hunter, "hunter_shoot", { targetId: shotTarget });
  world.completeActivation(shot);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === shotTarget)?.alive, "the hunter's shot eliminates the wolf");
});

check("hunter voted out gets a day shot and the phase then advances", () => {
  const { world, byRole } = makeWerewolf(8);
  skipDiscussion(world);
  const vote = world.activation()!;
  const hunter = byRole("hunter")[0];
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: hunter, reason: "t" });
  }
  world.completeActivation(vote!);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === hunter)?.alive, "hunter is eliminated by vote");
  const shot = world.activation()!;
  assert.ok(shot && shot.id.includes(":shot:"), "the hunter's shot activation opens during the day");
  const shotTarget = byRole("villager")[0];
  void world.performDomainAction(hunter, "hunter_shoot", { targetId: shotTarget });
  world.completeActivation(shot);
  const next = world.snapshot();
  assert.ok(!next.agents.find((agent) => agent.id === shotTarget)?.alive, "the shot eliminates its target");
  assert.equal(next.phase, "夜晚行动", "after the shot the day advances to night");
});

check("jester voted out wins solo and the game continues", () => {
  const { world, byRole } = makeWerewolf(8);
  skipDiscussion(world);
  const vote = world.activation()!;
  const jester = byRole("jester")[0];
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: jester, reason: "t" });
  }
  world.completeActivation(vote!);
  const after = world.snapshot();
  assert.equal(after.status, "running", "the game continues after a jester win");
  assert.equal((after.details.jesterWon), true, "the solo win is recorded");
  assert.ok(after.log.some((entry) => /单独获胜/.test(entry.text)), "log reports the solo win");
});

check("white wolf king explodes on vote-out and takes its voters", () => {
  const { world, byRole } = makeWerewolf(12);
  skipDiscussion(world);
  // 12P opens with the knight duel: pass it, then the vote opens.
  const activation = world.activation();
  if (activation && activation.id.endsWith(":knight")) {
    void world.performDomainAction(byRole("knight")[0], "knight_challenge", { reason: "t" });
    world.completeActivation(activation!);
  }
  const vote = world.activation()!;
  const wwk = byRole("white-wolf-king")[0];
  // Seven voters line up against the white wolf king; they must die in the boom.
  const voters = vote.actorIds.filter((id) => id !== wwk).slice(0, 7);
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: voters.includes(actor) ? wwk : byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === wwk)?.alive, "the white wolf king is voted out");
  for (const voter of voters) {
    assert.ok(!after.agents.find((agent) => agent.id === voter)?.alive, `voter ${voter} died in the boom`);
  }
  assert.ok(after.log.some((entry) => /自爆/.test(entry.text)), "log reports the explosion");
});

check("white wolf king explosion silences death skills", () => {
  const { world, byRole } = makeWerewolf(12);
  skipDiscussion(world);
  const activation = world.activation();
  if (activation && activation.id.endsWith(":knight")) {
    void world.performDomainAction(byRole("knight")[0], "knight_challenge", { reason: "t" });
    world.completeActivation(activation!);
  }
  const vote = world.activation()!;
  const wwk = byRole("white-wolf-king")[0];
  // The hunter votes the white wolf king and must die without a shot.
  // Seven votes land on the white wolf king so the boom actually triggers.
  const boomVoters = vote.actorIds.filter((id) => id !== wwk).slice(0, 7);
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: boomVoters.includes(actor) ? wwk : byRole("seer")[0], reason: "t" });
  }
  world.completeActivation(vote);
  const next = world.activation();
  assert.ok(!next?.id.includes(":shot:"), "no hunter shot after being exploded");
});

check("nightmare curse blocks the next day's vote", async () => {
  const { world, byRole } = makeWerewolf(10);
  skipDiscussion(world);
  const vote1 = world.activation()!;
  const villager = byRole("villager")[0];
  for (const actor of vote1.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === villager ? byRole("seer")[0] : villager, reason: "t" });
  }
  world.completeActivation(vote1);
  const night = world.activation()!;
  const nightmare = byRole("nightmare")[0];
  for (const wolf of [...byRole("wolf"), ...byRole("wolf-king"), nightmare]) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" });
  void world.performDomainAction(nightmare, "dream_curse", { targetId: byRole("witch")[0] });
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", {});
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  skipDiscussion(world);
  const vote2 = world.activation()!;
  assert.ok(vote2 && vote2.id.endsWith(":vote"), "the next day votes open");
  const cursed = byRole("witch")[0];
  assert.ok(!vote2.actorIds.includes(cursed), "the cursed witch is not asked to vote");
  await assert.rejects(
    world.performDomainAction(cursed, "cast_day_vote", { targetId: byRole("seer")[0], reason: "t" }),
    /NIGHTMARE_CURSED/,
    "the cursed witch cannot vote"
  );
});

check("wolf beauty's charmed companion dies with her on vote-out", () => {
  const { world, byRole } = makeWerewolf(11);
  skipDiscussion(world);
  const vote1 = world.activation()!;
  const target = byRole("villager")[0];
  for (const actor of vote1.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === target ? byRole("seer")[0] : target, reason: "t" });
  }
  world.completeActivation(vote1);
  const night = world.activation()!;
  const beauty = byRole("wolf-beauty")[0];
  for (const wolf of [...byRole("wolf"), ...byRole("hidden-wolf"), ...byRole("wolf-king"), beauty]) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" });
  void world.performDomainAction(beauty, "charm_target", { targetId: byRole("guard")[0] });
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", {});
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("spirit-seer")[0], "investigate_dead_identity", { targetId: byRole("villager")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  skipDiscussion(world);
  const vote2 = world.activation()!;
  assert.ok(vote2 && vote2.id.endsWith(":vote"), "the next day votes open");
  const guard = byRole("guard")[0];
  for (const actor of vote2.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === beauty ? guard : beauty, reason: "t" });
  }
  world.completeActivation(vote2);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === beauty)?.alive, "the wolf beauty is voted out");
  assert.ok(!after.agents.find((agent) => agent.id === guard)?.alive, "the charmed guard dies with her");
  assert.ok(after.log.some((entry) => /魅惑/.test(entry.text)), "the charm is logged");
});

check("spirit seer reads a dead player's true role", async () => {
  const { world, byRole } = makeWerewolf(11);
  skipDiscussion(world);
  const vote1 = world.activation()!;
  const target = byRole("villager")[0];
  for (const actor of vote1.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === target ? byRole("seer")[0] : target, reason: "t" });
  }
  world.completeActivation(vote1);
  const night = world.activation()!;
  const spirit = byRole("spirit-seer")[0];
  for (const wolf of [...byRole("wolf"), ...byRole("hidden-wolf"), ...byRole("wolf-king")]) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("witch")[0], reason: "t" });
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", {});
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(spirit, "investigate_dead_identity", { targetId: target });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === target)?.alive, "the dead player stays dead");
  await assert.rejects(
    world.performDomainAction(spirit, "investigate_dead_identity", { targetId: byRole("wolf")[0] }),
    /SPIRIT_INVESTIGATION_ALREADY_USED/,
    "one communion per night"
  );
});

check("wolves win at parity after a night kill", () => {
  const { world, byRole } = makeWerewolf(6);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote!);
  const night = world.activation()!;
  for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  const after = world.snapshot();
  assert.equal(after.status, "finished", "parity ends the game");
  assert.ok(/狼人阵营获胜/.test(after.details.outcome as string), "wolves win by parity");
});

// --- avalon official tables ---
check("avalon decks match the official good/evil split", () => {
  const expected: Record<number, [number, number]> = { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] };
  for (const count of [5, 6, 7, 8, 9, 10]) {
    const deck = avalonDeck(count);
    assert.equal(deck.length, count, `${count}P deck size`);
    const good = deck.filter((role) => role === "merlin" || role === "percival" || role === "servant").length;
    const evil = deck.length - good;
    assert.deepEqual([good, evil], expected[count], `${count}P good/evil split`);
    assert.ok(deck.includes("merlin") && deck.includes("assassin"), `${count}P has Merlin and the Assassin`);
    assert.ok(deck.includes("percival") && deck.includes("morgana"), `${count}P has Percival and Morgana`);
    if (count === 7 || count === 10) assert.ok(deck.includes("oberon"), `${count}P has Oberon`);
    if ([8, 9, 10].includes(count)) assert.ok(deck.includes("mordred"), `${count}P has Mordred`);
  }
});

check("avalon quest team sizes follow the official table", () => {
  assert.deepEqual(QUEST_TEAM_SIZES[5], [2, 3, 2, 3, 3]);
  assert.deepEqual(QUEST_TEAM_SIZES[6], [2, 3, 4, 3, 4]);
  assert.deepEqual(QUEST_TEAM_SIZES[7], [2, 3, 3, 4, 4]);
  assert.deepEqual(QUEST_TEAM_SIZES[8], [3, 4, 4, 5, 5]);
  assert.deepEqual(QUEST_TEAM_SIZES[9], [3, 4, 4, 5, 5]);
  assert.deepEqual(QUEST_TEAM_SIZES[10], [3, 4, 4, 5, 5]);
});

check("avalon fourth quest needs two fails at 7+ players", () => {
  for (const count of [5, 6]) assert.equal(questFailsNeeded(count, 4), 1, `${count}P quest 4`);
  for (const count of [7, 8, 9, 10]) assert.equal(questFailsNeeded(count, 4), 2, `${count}P quest 4`);
  assert.equal(questFailsNeeded(7, 1), 1, "other quests need one fail");
});

check("lady of the lake verdict follows the official loyalty rule", () => {
  assert.equal(ladyVerdictFor("servant"), "loyal");
  assert.equal(ladyVerdictFor("merlin"), "loyal", "the Lady reads loyalty — Merlin is loyal");
  assert.equal(ladyVerdictFor("percival"), "loyal");
  assert.equal(ladyVerdictFor("assassin"), "evil");
  assert.equal(ladyVerdictFor("mordred"), "evil");
  assert.equal(ladyVerdictFor("morgana"), "evil");
  assert.equal(ladyVerdictFor("minion"), "evil");
  assert.equal(ladyVerdictFor("oberon"), "loyal", "Oberon reads as good even to the Lady");
});

check("avalon knowledge follows the official setup (Merlin / Percival / Oberon)", () => {
  const seats = profiles(7); // merlin, percival, 2 servants, morgana, assassin, oberon
  const world = createWorld({ roomId: "r-av2", scenarioId: "avalon", profiles: seats, rounds: 5 });
  world.start();
  const roles = new Map<string, string>();
  for (const seat of seats) roles.set(seat.id, String(world.observe(seat.id).self.role));
  const byRole = (role: string): string[] => [...roles].filter(([, r]) => r === role).map(([id]) => id);
  const context = (id: string): string => world.observe(id).privateContext;
  const merlinId = byRole("merlin")[0];
  const percivalId = byRole("percival")[0];
  const oberonId = byRole("oberon")[0];
  const mordred = byRole("mordred");
  const merlinContext = context(merlinId);
  const nameFor = (id: string): string => seats.find((seat) => seat.id === id)?.displayName ?? id;
  // Merlin's knowledge boundary is the 你已知的内奸 roster — the context may
  // legitimately name any player elsewhere (e.g. as the Lady-of-the-Lake
  // token holder, which is randomly seated), so assert on the roster line.
  const knownEvilLine = merlinContext.split("\n").find((line) => line.startsWith("你已知的内奸"));
  assert.ok(knownEvilLine, "Merlin knows the agents of evil");
  for (const id of [...byRole("assassin"), ...byRole("morgana")]) assert.ok(knownEvilLine.includes(nameFor(id)), `Merlin sees ${roles.get(id)}`);
  assert.ok(!knownEvilLine.includes(nameFor(oberonId)), "Merlin does not see Oberon");
  if (mordred[0]) assert.ok(!knownEvilLine.includes(nameFor(mordred[0])), "Merlin does not see Mordred");
  const percivalContext = context(percivalId);
  assert.ok(percivalContext.includes("看见两个人自称梅林"), "Percival sees Merlin and Morgana without telling them apart");
  assert.ok(percivalContext.includes(nameFor(merlinId)) && percivalContext.includes(nameFor(byRole("morgana")[0])), "Percival's sights name both");
  const oberonContext = context(oberonId);
  assert.ok(!oberonContext.includes("你已知的内奸"), "Oberon knows no fellow agents of evil");
  // The evil roster line must never name Oberon; elsewhere the context may
  // legitimately mention any player (e.g. the randomly seated Lady holder).
  for (const id of [...byRole("assassin"), ...byRole("morgana")]) {
    const evilLine = context(id).split("\n").find((line) => line.startsWith("你已知的内奸"));
    assert.ok(evilLine, `${roles.get(id)} knows the agents of evil`);
    assert.ok(!evilLine.includes(nameFor(oberonId)), `${roles.get(id)} does not know Oberon`);
  }
});

check("lady of the lake starts with the player to the right of the first leader", () => {
  const seats = profiles(5);
  const world = createWorld({ roomId: "r-av", scenarioId: "avalon", profiles: seats, rounds: 5 });
  world.start();
  const state = world.exportState();
  const worldState = state.world as { ladyHolderId: string };
  assert.equal(worldState.ladyHolderId, seats.at(-1)!.id, "token starts right of the first leader");
});

check("werewolf rejects out-of-range player counts with a clear error", () => {
  assert.throws(() => createWorld({ roomId: "r", scenarioId: "werewolf", profiles: profiles(5), rounds: 2 }), /PLAYER_COUNT_INVALID/);
  assert.throws(() => createWorld({ roomId: "r", scenarioId: "werewolf", profiles: profiles(13), rounds: 2 }), /PLAYER_COUNT_INVALID/);
});


check("werewolf target fields reject sentinels and names at parse time", async () => {
  const { world, byRole } = makeWerewolf(6);
  const toolset = world as unknown as {
    toolsFor(id: string): Array<{ name: string; invoke(context: unknown, input: string): Promise<unknown> }>;
  };
  const base = {
    reason: "test",
    candidateIntents: [
      { action: "save", targetId: "agent-02", goal: "g1", summary: "s1", exposureRisk: 0, relationshipRisk: 0 },
      { action: "pass", targetId: null, goal: "g2", summary: "s2", exposureRisk: 0, relationshipRisk: 0 }
    ],
    selectedIntentIndex: 0,
    predictedConsequences: [{ outcomeKey: "save-prevented-wolf-kill", proposition: "p", probability: 0.5 }]
  };
  const call = async (tool: { invoke(context: unknown, input: string): Promise<unknown> }, input: unknown) =>
    String(await tool.invoke(undefined, JSON.stringify(input)));
  // The witch wedge regression: a stringified "null" sentinel must be rejected
  // at parse time as retryable validation feedback, never silently accepted.
  const witch = toolset.toolsFor(byRole("witch")[0]).find((t) => t.name === "witch_night_choice");
  assert.ok(witch, "witch_night_choice is available");
  assert.match(
    await call(witch, { ...base, candidateIntents: [{ ...base.candidateIntents[0], targetId: "null" }, base.candidateIntents[1]] }),
    /rejected by schema validation/,
    '"null" sentinel rejected'
  );
  assert.match(
    await call(witch, { ...base, candidateIntents: [{ ...base.candidateIntents[0], targetId: "P3" }, base.candidateIntents[1]] }),
    /rejected by schema validation/,
    "display names rejected"
  );
  assert.match(
    await call(witch, { ...base, candidateIntents: [{ ...base.candidateIntents[0], action: "heal" }, base.candidateIntents[1]] }),
    /rejected by schema validation/,
    "unknown potion actions rejected"
  );
  // The selected intent is the single source of truth: save and poison can no
  // longer be submitted together (inexpressible in the schema), and a valid
  // selection passes straight through.
  assert.ok(!await call(witch, base).then((out) => out.includes("rejected by schema validation")), "real ids and explicit pass pass the schema");
  assert.ok(
    !await call(witch, { ...base, candidateIntents: [{ action: "poison", targetId: null, goal: "g1", summary: "s1", exposureRisk: 0, relationshipRisk: 0 }, base.candidateIntents[1]] }).then((out) => out.includes("rejected by schema validation")),
    "explicit null targets pass the schema"
  );
  // Required-target tools reject the sentinel too.
  const voter = Object.keys((world.snapshot().details as { roles: Record<string, string> }).roles)[0];
  const vote = toolset.toolsFor(voter).find((t) => t.name === "cast_day_vote");
  assert.ok(vote, "cast_day_vote is available");
  const voteBase = {
    ...base,
    candidateIntents: base.candidateIntents.map(({ action: _action, ...rest }) => ({ ...rest, targetId: "agent-02" })),
    predictedConsequences: [{ outcomeKey: "vote-matched-plurality", proposition: "p", probability: 0.5 }]
  };
  assert.match(await call(vote, { ...voteBase, targetId: "null" }), /rejected by schema validation/, "sentinel vote rejected");
  assert.ok(!await call(vote, { ...voteBase, targetId: "agent-02" }).then((out) => out.includes("rejected by schema validation")), "valid vote passes the schema");
});
