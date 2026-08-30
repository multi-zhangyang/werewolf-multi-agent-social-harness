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
  // Day 1 opens with the sheriff election (警长竞选): decline for everyone so
  // the flow lands in the first discussion wave, as the rest of the suite expects.
  const election = world.activation();
  if (election && election.id.endsWith(":sheriff-run")) {
    for (const actor of election.actorIds) {
      void world.performDomainAction(actor, "run_for_sheriff", { run: false, reason: "t" });
    }
    world.completeActivation(election);
  }
  for (let i = 0; i < 20; i += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.includes(":discussion")) return;
    world.completeActivation(activation!);
  }
  throw new Error("discussion never ended");
}

/**
 * The day vote may leave the eliminated player one last word; the driver
 * completes it silently (silence is a legitimate last word) so the flow can
 * advance to the death shot or the night.
 */
function passLastWords(world: SocialWorldBase): void {
  for (let i = 0; i < 3; i += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.includes(":lastwords:")) return;
    world.completeActivation(activation);
  }
  throw new Error("last words never ended");
}

/**
 * The night opens with the pack's team-channel pact (狼队合谋) whenever at
 * least two wolves live. Silence is a legitimate pact, so the driver
 * completes it quietly — after that the suite's direct night-action calls
 * run against the open nomination window.
 */
function passPackPact(world: SocialWorldBase): void {
  for (let i = 0; i < 4; i += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.endsWith(":night-pact")) return;
    world.completeActivation(activation);
  }
  throw new Error("pack pact never ended");
}

/**
 * After the wolves' nomination round, a split pack earns one realignment
 * round (刀型协调); either way the remaining night roles settle in one final
 * activation — the suite performs those actions inline, so completing it
 * resolves the night.
 */
function settleNightTail(world: SocialWorldBase): void {
  for (let i = 0; i < 4; i += 1) {
    const activation = world.activation();
    if (!activation || !(activation.id.endsWith(":night") || activation.id.endsWith(":night-realign"))) return;
    world.completeActivation(activation);
  }
  throw new Error("night never settled");
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

// --- last words (遗言): the voted-out player speaks once, publicly ---
check("a voted-out player gets one public last word, then the night", async () => {
  const { world, byRole } = makeWerewolf(6);
  skipDiscussion(world);
  const vote = world.activation()!;
  const target = byRole("villager")[0];
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === target ? byRole("villager")[1] : target, reason: "t" });
  }
  world.completeActivation(vote);
  const lastWords = world.activation()!;
  assert.ok(lastWords && lastWords.id.includes(":lastwords:") && lastWords.actorIds[0] === target,
    "the eliminated player is owed one last word before anything else");
  // 遗言 is a public stage: a private attempt is refused.
  await assert.rejects(
    () => world.sendMessage({ senderId: target, text: "悄悄告诉你。", channel: "private", recipientIds: [byRole("wolf")[0]] }),
    /LAST_WORDS_PUBLIC_ONLY/
  );
  const message = await world.sendMessage({ senderId: target, text: "我以性命作保：查他。", channel: "public" });
  assert.ok(message.id, "the last word is a normal public message");
  world.completeActivation(lastWords);
  assert.equal(world.snapshot().phase, "夜晚行动", "the night opens after the last word");
});

// --- tied vote PK (平票 PK): speeches, then a re-vote without the candidates ---
check("a tied vote opens PK speeches, then a re-vote without the candidates", async () => {
  const { world, byRole } = makeWerewolf(6);
  skipDiscussion(world);
  const vote = world.activation()!;
  assert.ok(vote);
  const [a, b] = [byRole("villager")[0], byRole("villager")[1]];
  const voters = [...vote.actorIds];
  assert.equal(voters.length % 2, 0, "an even table can tie");
  for (let index = 0; index < voters.length; index += 1) {
    void world.performDomainAction(voters[index]!, "cast_day_vote", { targetId: index % 2 === 0 ? a : b, reason: "t" });
  }
  world.completeActivation(vote);

  assert.equal(world.snapshot().phase, "平票 PK", "a tied vote opens the PK cycle");
  const pk = world.activation()!;
  assert.ok(pk && pk.id.endsWith(":pk"), "the PK activation opens");
  assert.deepEqual([...pk.actorIds].sort(), [a, b].sort(), "only the tied candidates speak");
  const outsider = voters.find((id) => id !== a && id !== b)!;
  await assert.rejects(() => world.sendMessage({ senderId: outsider, text: "我也想说两句。", channel: "public" }), /PK_SPEAKERS_ONLY/,
    "the audience stays silent during the PK speeches");
  await world.sendMessage({ senderId: a, text: "我不是狼，我的发言记录可以查。", channel: "public" });
  world.completeActivation(pk);

  const reVote = world.activation()!;
  assert.ok(reVote && reVote.id.endsWith(":vote"), "the re-vote opens after the speeches");
  assert.ok(!reVote.actorIds.includes(a) && !reVote.actorIds.includes(b), "the candidates do not vote");
  for (const actor of reVote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: a, reason: "t" });
  }
  world.completeActivation(reVote);
  passLastWords(world);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === a)?.alive, "the re-vote eliminates the accused");
  const history = after.details.history as Array<{ day: number; votes: Record<string, string>; eliminatedId?: string }>;
  const firstDay = history.filter((record) => record.day === 1);
  assert.equal(firstDay.length, 1, "the PK re-vote updates the same day record instead of duplicating it");
  assert.equal(firstDay[0]!.eliminatedId, a, "the merged record carries the final elimination");
});

check("a second tie eliminates nobody — the PK cycle closes after one round", () => {
  const { world, byRole } = makeWerewolf(6);
  skipDiscussion(world);
  const vote = world.activation()!;
  assert.ok(vote);
  const [a, b] = [byRole("villager")[0], byRole("villager")[1]];
  const voters = [...vote.actorIds];
  for (let index = 0; index < voters.length; index += 1) {
    void world.performDomainAction(voters[index]!, "cast_day_vote", { targetId: index % 2 === 0 ? a : b, reason: "t" });
  }
  world.completeActivation(vote);
  const pk = world.activation()!;
  assert.ok(pk && pk.id.endsWith(":pk"));
  world.completeActivation(pk);
  const reVote = world.activation()!;
  assert.ok(reVote && reVote.id.endsWith(":vote"));
  // The table ties AGAIN: the day closes with nobody eliminated.
  const reVoters = [...reVote.actorIds];
  for (let index = 0; index < reVoters.length; index += 1) {
    void world.performDomainAction(reVoters[index]!, "cast_day_vote", { targetId: index % 2 === 0 ? a : b, reason: "t" });
  }
  world.completeActivation(reVote);
  const after = world.snapshot();
  assert.ok(after.agents.every((agent) => agent.alive), "a second tie eliminates nobody");
  assert.equal(after.phase, "夜晚行动", "the day closes and the night opens");
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
  passLastWords(world);
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
  passLastWords(world);
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

// --- §28 quality metrics: deception outcomes, vote accuracy, belief calibration ---
check("quality metrics score the vote, the lies and the beliefs against ground truth", async () => {
  const { world, byRole } = makeWerewolf(8);
  const wolf = byRole("wolf")[0];
  const villager = byRole("villager")[0];
  // The wolf falsely claims the good camp; the villager mostly believes it.
  const message = await world.sendMessage({ senderId: wolf, channel: "public", text: "我是好人阵营的，别投我。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "identity", subjectId: wolf, predicate: "has-team", object: "good" }
  }]);
  world.recordBeliefUpdate(villager, {
    subjectId: wolf,
    proposition: "has-team",
    kind: "identity",
    object: "good",
    probability: 0.8,
    confidence: 0.7,
    source: "他自称好人",
    sourceMessageIds: [message.id],
    supports: true
  });
  voteOut(world, wolf, byRole);

  const quality = (world as SocialWorldBase).qualityMetrics();
  // Vote accuracy: everyone who voted the true wolf has one hit.
  const voter = quality.voteAccuracy?.find((entry) => entry.actorId === villager);
  assert.ok(voter, "the villager's day vote is scored");
  assert.equal(voter.votesCast, 1);
  assert.equal(voter.hits, 1, "voting out the true wolf counts as a hit");
  // Deception: the revealed false camp claim is one detected episode.
  const deceiver = quality.deception.find((entry) => entry.actorId === wolf);
  assert.ok(deceiver, "the wolf's deception outcome is aggregated");
  assert.equal(deceiver.episodes, 1);
  assert.equal(deceiver.detected, 1);
  // Calibration: the self-report is fused, not taken at face value. The belief
  // cites the wolf's message, which the ledger carries as two events (the
  // utterance plus the extracted identity claim), so confidence 0.7 over two
  // fresh citations earns trust 0.7 × (0.5 + 0.5·0.75) = 0.6125 and the stored
  // belief is 0.6125·0.8 + 0.3875·0.5 = 0.68375. Brier on the falsified claim
  // is 0.68375² ≈ 0.468 — fusion pulls an uncertain overclaim back toward the
  // prior, which scores better than the raw 0.8 report's 0.64.
  const calibration = quality.beliefCalibration.find((entry) => entry.actorId === villager);
  assert.ok(calibration, "the villager's resolved beliefs are scored");
  assert.equal(calibration.resolvedBeliefs, 1);
  assert.equal(calibration.brier, 0.468, "fused p≈0.684 on a falsified claim is Brier ≈ 0.468");
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
  passLastWords(world);
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
  passLastWords(world);
  // A quiet night: wolves kill one villager, witch passes, guard skips.
  passPackPact(world);
  const night = world.activation()!;
  for (const wolf of [...byRole("wolf"), ...byRole("wolf-king"), ...byRole("nightmare")]) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("villager")[0], reason: "t" });
  if (byRole("nightmare")[0]) void world.performDomainAction(byRole("nightmare")[0], "dream_curse", {});
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", {});
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  settleNightTail(world);
  skipDiscussion(world);
  const vote2 = world.activation()!;
  assert.ok(vote2 && vote2.id.endsWith(":vote"));
  assert.ok(!vote2.actorIds.includes(idiot), "the revealed idiot is not asked to vote");
  for (const actor of vote2.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: idiot, reason: "t" });
  }
  world.completeActivation(vote2);
  passLastWords(world);
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
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  const guard = byRole("guard")[0];
  for (const wolf of [...byRole("wolf"), ...byRole("wolf-king"), ...byRole("hidden-wolf"), ...byRole("white-wolf-king")]) void world.performDomainAction(wolf, "choose_night_target", { targetId: guard, reason: "t" });
  void world.performDomainAction(guard, "guard_tonight", { targetId: byRole("seer")[0] });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  settleNightTail(world);
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
  passLastWords(world);
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
  passLastWords(world);
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
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  const wolves = byRole("wolf");
  const victim = byRole("hunter")[0];
  for (const wolf of wolves) void world.performDomainAction(wolf, "choose_night_target", { targetId: victim, reason: "t" });
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", { targetId: victim });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  settleNightTail(world);
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
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  const victim = byRole("hunter")[0];
  for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: victim, reason: "t" });
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", { targetId: victim });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", { saveTargetId: victim });
  world.completeActivation(night!);
  settleNightTail(world);
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
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  const victim = byRole("seer")[0];
  for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: victim, reason: "t" });
  void world.performDomainAction(victim, "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", { saveTargetId: victim });
  world.completeActivation(night!);
  settleNightTail(world);
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
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  const hunter = byRole("hunter")[0];
  for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("villager")[1], reason: "t" });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", { poisonTargetId: hunter });
  world.completeActivation(night!);
  settleNightTail(world);
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
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  const hunter = byRole("hunter")[0];
  for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: hunter, reason: "t" });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  settleNightTail(world);
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
  passLastWords(world);
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

// A held shot (压枪) must cascade exactly like a fired one: the regression
// behind the phantom second day vote — the phase stayed on day-vote and the
// room opened another binding vote on the same day.
check("a voted-out hunter who holds the shot ends the day — no phantom second vote", () => {
  const { world, byRole } = makeWerewolf(8);
  skipDiscussion(world);
  const vote = world.activation()!;
  const hunter = byRole("hunter")[0];
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: hunter, reason: "t" });
  }
  world.completeActivation(vote!);
  passLastWords(world);
  const shot = world.activation()!;
  assert.ok(shot && shot.id.includes(":shot:"), "the hunter's shot activation opens");
  void world.performDomainAction(hunter, "hunter_shoot", {});
  world.completeActivation(shot);
  const next = world.activation()!;
  assert.ok(next && next.id.includes(":night"), "a held shot still advances to the night");
  const after = world.snapshot();
  const day1 = (after.details.history as Array<{ day: number; eliminatedId?: string }>).find((record) => record.day === 1);
  assert.equal(day1?.eliminatedId, hunter, "exactly one elimination is recorded for the day");
  assert.equal(after.agents.filter((agent) => !agent.alive).length, 1, "nobody else was voted out");
});

check("a night-killed hunter who holds the shot still lets the night resolve", () => {
  const { world, byRole } = makeWerewolf(8);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote!);
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  const hunter = byRole("hunter")[0];
  for (const wolf of byRole("wolf")) {
    void world.performDomainAction(wolf, "choose_night_target", { targetId: hunter, reason: "t" });
  }
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night);
  settleNightTail(world);
  const shot = world.activation()!;
  assert.ok(shot && shot.id.includes(":shot:"), "the night-killed hunter's shot activation opens");
  void world.performDomainAction(hunter, "hunter_shoot", {});
  world.completeActivation(shot);
  const next = world.activation()!;
  assert.ok(next && next.id.startsWith("ww:2:"), "a held night shot still advances to day 2");
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
  passLastWords(world);
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
  passLastWords(world);
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
  passLastWords(world);
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
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  const nightmare = byRole("nightmare")[0];
  for (const wolf of [...byRole("wolf"), ...byRole("wolf-king"), nightmare]) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" });
  void world.performDomainAction(nightmare, "dream_curse", { targetId: byRole("witch")[0] });
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", {});
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  settleNightTail(world);
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
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  const beauty = byRole("wolf-beauty")[0];
  for (const wolf of [...byRole("wolf"), ...byRole("hidden-wolf"), ...byRole("wolf-king"), beauty]) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" });
  void world.performDomainAction(beauty, "charm_target", { targetId: byRole("guard")[0] });
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", {});
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("spirit-seer")[0], "investigate_dead_identity", { targetId: byRole("villager")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  settleNightTail(world);
  skipDiscussion(world);
  const vote2 = world.activation()!;
  assert.ok(vote2 && vote2.id.endsWith(":vote"), "the next day votes open");
  const guard = byRole("guard")[0];
  for (const actor of vote2.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === beauty ? guard : beauty, reason: "t" });
  }
  world.completeActivation(vote2);
  passLastWords(world);
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
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  const spirit = byRole("spirit-seer")[0];
  for (const wolf of [...byRole("wolf"), ...byRole("hidden-wolf"), ...byRole("wolf-king")]) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("witch")[0], reason: "t" });
  void world.performDomainAction(byRole("guard")[0], "guard_tonight", {});
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(spirit, "investigate_dead_identity", { targetId: target });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  settleNightTail(world);
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
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night!);
  settleNightTail(world);
  const after = world.snapshot();
  assert.equal(after.status, "finished", "parity ends the game");
  assert.ok(/狼人阵营获胜/.test(after.details.outcome as string), "wolves win by parity");
});

// --- 狼队合谋 (pack pact) & 刀型协调 (kill realignment) ---
check("the night opens with the pack's pact: an early nomination is refused until the round closes", async () => {
  const { world, byRole } = makeWerewolf(6);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote);
  passLastWords(world);
  const pact = world.activation()!;
  assert.ok(pact && pact.id.endsWith(":night-pact"), "the night opens with the pack's team-channel pact");
  assert.deepEqual([...pact.actorIds].sort(), [...byRole("wolf")].sort(), "only living wolves sit in the pact");
  await assert.rejects(
    () => world.performDomainAction(byRole("wolf")[0], "choose_night_target", { targetId: byRole("villager")[1], reason: "t" }),
    /NIGHT_TARGET_EARLY/,
    "no nomination before the pact round closes"
  );
  // The pact is a talk round: teammates coordinate on the team channel.
  await world.sendMessage({ senderId: byRole("wolf")[0], text: "今晚刀预言家，别暴露。", channel: "team" });
  world.completeActivation(pact);
  const nomination = world.activation()!;
  assert.ok(nomination && nomination.id.endsWith(":night-wolves"), "nominations open after the pact");
  void world.performDomainAction(byRole("wolf")[0], "choose_night_target", { targetId: byRole("villager")[1], reason: "t" });
  void world.performDomainAction(byRole("wolf")[1], "choose_night_target", { targetId: byRole("villager")[1], reason: "t" });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(nomination);
  settleNightTail(world);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === byRole("villager")[1])?.alive, "the discussed kill lands");
});

check("a split pack earns exactly one realignment round, then the lock returns", async () => {
  const { world, byRole } = makeWerewolf(6);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  }
  world.completeActivation(vote);
  passLastWords(world);
  passPackPact(world);
  const nomination = world.activation()!;
  const [wolfA, wolfB] = byRole("wolf");
  void world.performDomainAction(wolfA, "choose_night_target", { targetId: byRole("villager")[1], reason: "t" });
  await assert.rejects(
    () => world.performDomainAction(wolfA, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" }),
    /NIGHT_TARGET_ALREADY_CHOSEN/,
    "the nomination is fixed during the round"
  );
  void world.performDomainAction(wolfB, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" });
  world.completeActivation(nomination);
  const realign = world.activation()!;
  assert.ok(realign && realign.id.endsWith(":night-realign"), "a split plurality opens the realignment round");
  void world.performDomainAction(wolfA, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" });
  world.completeActivation(realign);
  await assert.rejects(
    () => world.performDomainAction(wolfA, "choose_night_target", { targetId: byRole("villager")[1], reason: "t" }),
    /NIGHT_TARGET_ALREADY_CHOSEN/,
    "the lock returns after the single realignment round"
  );
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: wolfA });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  settleNightTail(world);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === byRole("seer")[0])?.alive, "the converged kill lands on the realigned target");
});

check("a lone wolf nominates without the pact ceremony", async () => {
  const { world, byRole } = makeWerewolf(6);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("wolf")[1], reason: "t" });
  }
  world.completeActivation(vote);
  passLastWords(world);
  const nomination = world.activation()!;
  assert.ok(nomination && nomination.id.endsWith(":night-wolves"), "no pact for a lone wolf — nominations open directly");
  void world.performDomainAction(byRole("wolf")[0], "choose_night_target", { targetId: byRole("villager")[0], reason: "t" });
  void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(nomination);
  settleNightTail(world);
  const after = world.snapshot();
  assert.ok(!after.agents.find((agent) => agent.id === byRole("villager")[0])?.alive, "the lone wolf's kill lands");
});

// --- 警长竞选 (sheriff election) / 警徽流 (badge flow) ---/** Drive the run decisions; two given candidates stay on the ballot. */
async function runForSheriff(world: SocialWorldBase, runnerIds: string[]): Promise<void> {
  const run = world.activation()!;
  for (const actor of run.actorIds) {
    await world.performDomainAction(actor, "run_for_sheriff", { run: runnerIds.includes(actor), reason: "t" });
  }
  world.completeActivation(run);
}

/** Skip the campaign and withdrawal stages with everyone staying put. */
async function stayOnBallot(world: SocialWorldBase): Promise<void> {
  world.completeActivation(world.activation()!); // campaign speeches
  const withdraw = world.activation()!;
  for (const actor of withdraw.actorIds) {
    await world.performDomainAction(actor, "withdraw_sheriff_run", { withdraw: false, reason: "t" });
  }
  world.completeActivation(withdraw);
}

function sheriffDetail(world: SocialWorldBase): string | undefined {
  return (world.snapshot().details as { sheriffId?: string }).sheriffId;
}

check("the sheriff election campaigns, withdraws and elects by sealed ballot", async () => {
  const { world, byRole } = makeWerewolf(6);
  const [a, b] = [byRole("villager")[0], byRole("villager")[1]];
  const run = world.activation()!;
  assert.equal(run.mode, "parallel", "run decisions are sealed and simultaneous");
  for (const actor of run.actorIds) {
    await world.performDomainAction(actor, "run_for_sheriff", { run: actor === a || actor === b, reason: "t" });
  }
  world.completeActivation(run);
  const campaign = world.activation()!;
  assert.ok(campaign.id.endsWith(":sheriff-campaign") && campaign.mode === "sequential", "two runners campaign in seat order");
  assert.deepEqual([...campaign.actorIds].sort(), [a, b].sort(), "only the candidates hold the floor");
  await assert.rejects(
    () => world.sendMessage({ senderId: byRole("seer")[0], text: "我推荐 P1。", channel: "public" }),
    /SHERIFF_CAMPAIGN_SPEAKERS_ONLY/
  );
  await world.sendMessage({ senderId: a, text: "我的发言记录干净，警徽给我。", channel: "public" });
  world.completeActivation(campaign);
  const withdraw = world.activation()!;
  assert.ok(withdraw.id.endsWith(":sheriff-withdraw"), "candidates decide whether to stay");
  for (const actor of withdraw.actorIds) {
    await world.performDomainAction(actor, "withdraw_sheriff_run", { withdraw: false, reason: "t" });
  }
  world.completeActivation(withdraw);
  const vote = world.activation()!;
  assert.ok(vote.id.endsWith(":sheriff-vote"), "the never-ran electors vote");
  assert.ok(!vote.actorIds.includes(a) && !vote.actorIds.includes(b), "candidates cannot vote in their own election");
  for (const voter of vote.actorIds) {
    await world.performDomainAction(voter, "cast_sheriff_vote", { targetId: a, reason: "t" });
  }
  world.completeActivation(vote);
  const snap = world.snapshot();
  assert.equal((snap.details as { sheriffId?: string }).sheriffId, a, "the badge is a public detail");
  assert.ok(String(snap.phase).includes("讨论"), "the election flows into the day discussion");
  const day1 = (snap.details.history as Array<{ day: number; sheriffElectedId?: string }>).find((record) => record.day === 1);
  assert.equal(day1?.sheriffElectedId, a, "the day record remembers the election");
  assert.ok(world.observe(byRole("wolf")[0]).privateContext.includes("sheriff"), "observations announce the sitting sheriff");
  const events = (world as unknown as {
    socialCausalityFor(actorId?: string, omniscient?: boolean): { events: Array<{ type: string }> };
  }).socialCausalityFor(undefined, true).events;
  assert.ok(events.some((event) => event.type === "werewolf.sheriff-elected"), "the election is a public world fact");
});

check("an election nobody enters leaves the village without a sheriff", async () => {
  const { world } = makeWerewolf(6);
  await runForSheriff(world, []);
  const snap = world.snapshot();
  assert.ok(String(snap.phase).includes("讨论"), "the day opens straight into discussion");
  assert.ok(!("sheriffId" in snap.details), "no badge was handed out");
  assert.ok(snap.log.some((entry) => entry.text.includes("无人上警")), "the day log explains why");
});

check("a single runner takes the badge without a vote", async () => {
  const { world, byRole } = makeWerewolf(6);
  const solo = byRole("villager")[0];
  await runForSheriff(world, [solo]);
  const snap = world.snapshot();
  assert.equal((snap.details as { sheriffId?: string }).sheriffId, solo, "elected unopposed");
  assert.ok(String(snap.phase).includes("讨论"), "no campaign or vote was held");
  assert.ok(snap.log.some((entry) => entry.text.includes("唯一上警者直接当选")), "the log notes the uncontested election");
});

check("withdrawal elects the last candidate standing; the last one cannot withdraw", async () => {
  const { world, byRole } = makeWerewolf(6);
  const [a, b] = [byRole("villager")[0], byRole("villager")[1]];
  await runForSheriff(world, [a, b]);
  world.completeActivation(world.activation()!); // campaign
  const withdraw = world.activation()!;
  await assert.rejects(
    () => world.performDomainAction(byRole("witch")[0], "withdraw_sheriff_run", { withdraw: true, reason: "t" }),
    /SHERIFF_WITHDRAW_FORBIDDEN/
  );
  await world.performDomainAction(a, "withdraw_sheriff_run", { withdraw: true, reason: "t" });
  // a quit: b is the last candidate standing and cannot quit.
  await assert.rejects(
    () => world.performDomainAction(b, "withdraw_sheriff_run", { withdraw: true, reason: "t" }),
    /LAST_CANDIDATE_CANNOT_WITHDRAW/
  );
  await world.performDomainAction(b, "withdraw_sheriff_run", { withdraw: false, reason: "t" });
  world.completeActivation(withdraw);
  const snap = world.snapshot();
  assert.equal((snap.details as { sheriffId?: string }).sheriffId, b, "the remaining candidate takes the badge");
  assert.ok(snap.log.some((entry) => entry.text.includes("唯一留任者")), "the log notes the walkover");
});

check("a tied election goes to PK; a second tie leaves no sheriff", async () => {
  const { world, byRole } = makeWerewolf(6);
  const [a, b] = [byRole("villager")[0], byRole("villager")[1]];
  await runForSheriff(world, [a, b]);
  await stayOnBallot(world);
  const vote = world.activation()!;
  const electors = [...vote.actorIds];
  assert.equal(electors.length, 4, "the four never-ran players elect");
  for (let index = 0; index < electors.length; index += 1) {
    await world.performDomainAction(electors[index], "cast_sheriff_vote", { targetId: index % 2 === 0 ? a : b, reason: "t" });
  }
  world.completeActivation(vote);
  const pk = world.activation()!;
  assert.ok(pk.id.endsWith(":sheriff-pk") && pk.actorIds.length === 2, "the tied candidates give PK speeches");
  await assert.rejects(
    () => world.sendMessage({ senderId: byRole("seer")[0], text: "我投 P1。", channel: "public" }),
    /SHERIFF_PK_SPEAKERS_ONLY/
  );
  await world.sendMessage({ senderId: a, text: "最后一句话：警徽给我。", channel: "public" });
  world.completeActivation(pk);
  const reVote = world.activation()!;
  assert.ok(reVote.id.endsWith(":sheriff-vote"), "the electors vote again after the PK");
  for (const voter of reVote.actorIds) {
    const index = electors.indexOf(voter);
    await world.performDomainAction(voter, "cast_sheriff_vote", { targetId: index % 2 === 0 ? a : b, reason: "t" });
  }
  world.completeActivation(reVote);
  const snap = world.snapshot();
  assert.ok(!("sheriffId" in snap.details), "two ties mean no sheriff this game");
  assert.ok(String(snap.phase).includes("讨论"), "the day moves on without a badge");
  assert.ok(snap.log.some((entry) => entry.text.includes("两次平票")), "the log explains the outcome");
});

check("the sheriff's day vote counts 1.5 and breaks a would-be tie", async () => {
  const { world, byRole } = makeWerewolf(6);
  const sheriff = byRole("villager")[0];
  await runForSheriff(world, [sheriff]);
  skipDiscussion(world);
  const vote = world.activation()!;
  assert.ok(vote.id.endsWith(":vote"), "the day vote opens");
  const doomed = byRole("villager")[1];
  const rival = byRole("seer")[0];
  // 3 plain votes for the rival vs 2 plain + the sheriff's 1.5 for the doomed:
  // without the badge this table ties 3:3 and goes to PK.
  for (const actor of vote.actorIds) {
    const target = actor === sheriff || actor === byRole("witch")[0] || actor === byRole("wolf")[0] ? doomed : rival;
    await world.performDomainAction(actor, "cast_day_vote", { targetId: target, reason: "t" });
  }
  world.completeActivation(vote);
  const snap = world.snapshot();
  const day1 = (snap.details.history as Array<{ day: number; eliminatedId?: string }>).find((record) => record.day === 1);
  assert.equal(day1?.eliminatedId, doomed, "the weighted 3.5 beats the plain 3 without a PK");
  passLastWords(world);
  assert.ok(world.activation()!.id.includes(":night"), "no PK round opened — the tie was broken");
});

check("a sheriff killed at night hands the badge on before the day advances", async () => {
  const { world, byRole } = makeWerewolf(6);
  const sheriff = byRole("villager")[0];
  const heir = byRole("villager")[1];
  await runForSheriff(world, [sheriff]);
  skipDiscussion(world);
  // Vote out one wolf so a single wolf remains to do the night kill.
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    await world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("wolf")[1], reason: "t" });
  }
  world.completeActivation(vote);
  passLastWords(world);
  passPackPact(world);
  const night = world.activation()!;
  await world.performDomainAction(byRole("wolf")[0], "choose_night_target", { targetId: sheriff, reason: "t" });
  await world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
  await world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
  world.completeActivation(night);
  settleNightTail(world);
  const badge = world.activation()!;
  assert.ok(badge.id.includes(":badge:") && badge.actorIds[0] === sheriff, "the dying sheriff owes the badge first");
  // The decision is exclusive: a target XOR tearing, never both, never neither.
  await assert.rejects(
    () => world.performDomainAction(sheriff, "pass_badge", { targetId: heir, tear: true, reason: "t" }),
    /BADGE_DECISION_CONFLICT/
  );
  await assert.rejects(
    () => world.performDomainAction(sheriff, "pass_badge", { reason: "t" }),
    /BADGE_DECISION_REQUIRED/
  );
  await assert.rejects(
    () => world.performDomainAction(sheriff, "pass_badge", { targetId: byRole("wolf")[1], reason: "t" }),
    /TARGET_INACTIVE/
  );
  await world.performDomainAction(sheriff, "pass_badge", { targetId: heir, reason: "t" });
  world.completeActivation(badge);
  assert.equal(sheriffDetail(world), heir, "the heir wears the badge");
  // The badge decision carried the night: day 2 opens normally, no re-election.
  skipDiscussion(world);
  const vote2 = world.activation()!;
  assert.ok(vote2.id.endsWith(":vote"), "day 2 votes normally");
  const doomed2 = byRole("witch")[0];
  const rival2 = byRole("seer")[0];
  for (const actor of vote2.actorIds) {
    const target = actor === heir || actor === byRole("wolf")[0] ? doomed2 : rival2;
    await world.performDomainAction(actor, "cast_day_vote", { targetId: target, reason: "t" });
  }
  world.completeActivation(vote2);
  const day2 = (world.snapshot().details.history as Array<{ day: number; eliminatedId?: string }>).find((record) => record.day === 2);
  assert.equal(day2?.eliminatedId, doomed2, "the inherited badge still weighs 1.5");
});

check("a voted-out sheriff decides the badge before speaking, and can tear it", async () => {
  const { world, byRole } = makeWerewolf(6);
  const sheriff = byRole("villager")[0];
  await runForSheriff(world, [sheriff]);
  skipDiscussion(world);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    await world.performDomainAction(actor, "cast_day_vote", { targetId: sheriff, reason: "t" });
  }
  world.completeActivation(vote);
  const badge = world.activation()!;
  assert.ok(badge.id.includes(":badge:"), "the badge decision precedes everything else");
  assert.deepEqual(world.domainActionsFor(sheriff).map((spec) => spec.name), ["pass_badge"], "the dying sheriff's seat offers exactly the badge");
  await assert.rejects(
    () => world.performDomainAction(byRole("seer")[0], "pass_badge", { targetId: byRole("witch")[0], reason: "t" }),
    /BADGE_PASS_FORBIDDEN/
  );
  await world.performDomainAction(sheriff, "pass_badge", { tear: true, reason: "t" });
  world.completeActivation(badge);
  const snap = world.snapshot();
  assert.ok(!("sheriffId" in snap.details), "a torn badge means no sheriff for the rest of the game");
  assert.ok(snap.log.some((entry) => entry.text.includes("撕掉") || entry.text.includes("撕了")), "the log records the tearing");
  const lastWords = world.activation()!;
  assert.ok(lastWords.id.includes(":lastwords:") && lastWords.actorIds[0] === sheriff, "last words follow the badge");
  await world.sendMessage({ senderId: sheriff, text: "撕了警徽，你们自己看着办。", channel: "public" });
  world.completeActivation(lastWords);
  assert.ok(world.activation()!.id.includes(":night"), "the night follows the last words");
});

check("the election's action guards reject cross-phase and duplicate attempts", async () => {
  const { world, byRole } = makeWerewolf(6);
  const [a, b] = [byRole("villager")[0], byRole("villager")[1]];
  const outsider = byRole("seer")[0];
  const run = world.activation()!;
  await assert.rejects(
    () => world.performDomainAction(byRole("witch")[0], "withdraw_sheriff_run", { withdraw: true, reason: "t" }),
    /SHERIFF_WITHDRAW_NOT_OPEN/
  );
  await assert.rejects(
    () => world.performDomainAction(outsider, "cast_sheriff_vote", { targetId: a, reason: "t" }),
    /SHERIFF_VOTE_NOT_OPEN/
  );
  await world.performDomainAction(a, "run_for_sheriff", { run: true, reason: "t" });
  await assert.rejects(
    () => world.performDomainAction(a, "run_for_sheriff", { run: false, reason: "t" }),
    /SHERIFF_RUN_LOCKED/
  );
  for (const actor of run.actorIds) {
    if (actor !== a) await world.performDomainAction(actor, "run_for_sheriff", { run: actor === b, reason: "t" });
  }
  world.completeActivation(run);
  world.completeActivation(world.activation()!); // campaign: no speech is a valid campaign
  const withdraw = world.activation()!;
  await world.performDomainAction(a, "withdraw_sheriff_run", { withdraw: false, reason: "t" });
  // A stay is sealed exactly like a quit: the decision cannot be revisited.
  await assert.rejects(
    () => world.performDomainAction(a, "withdraw_sheriff_run", { withdraw: false, reason: "t" }),
    /SHERIFF_WITHDRAW_LOCKED/
  );
  await world.performDomainAction(b, "withdraw_sheriff_run", { withdraw: false, reason: "t" });
  world.completeActivation(withdraw);
  const vote = world.activation()!;
  await assert.rejects(
    () => world.performDomainAction(vote.actorIds[0], "cast_sheriff_vote", { targetId: outsider, reason: "t" }),
    /INVALID_SHERIFF_VOTE_TARGET/
  );
  await world.performDomainAction(vote.actorIds[0], "cast_sheriff_vote", { targetId: a, reason: "t" });
  await assert.rejects(
    () => world.performDomainAction(vote.actorIds[0], "cast_sheriff_vote", { targetId: a, reason: "t" }),
    /SHERIFF_VOTE_ALREADY_CAST/
  );
  for (const voter of vote.actorIds.slice(1)) {
    await world.performDomainAction(voter, "cast_sheriff_vote", { targetId: a, reason: "t" });
  }
  world.completeActivation(vote);
  // The election is over: standing now is refused.
  await assert.rejects(
    () => world.performDomainAction(outsider, "run_for_sheriff", { run: true, reason: "t" }),
    /SHERIFF_ELECTION_NOT_OPEN/
  );
});

check("an election everyone joins cannot be voted on — the village plays without a sheriff", async () => {
  const { world } = makeWerewolf(6);
  await runForSheriff(world, world.snapshot().agents.map((agent) => agent.id));
  await stayOnBallot(world);
  const snap = world.snapshot();
  assert.ok(!("sheriffId" in snap.details), "no electors means no badge");
  assert.ok(String(snap.phase).includes("讨论"), "the day continues without a sheriff");
  assert.ok(snap.log.some((entry) => entry.text.includes("全员上警")), "the log explains the walkout");
});

check("the election exposes its choices to human seats at the right moments", async () => {
  const { world, byRole } = makeWerewolf(6);
  const [a, b] = [byRole("villager")[0], byRole("villager")[1]];
  const outsider = byRole("seer")[0];
  const seat = (id: string) => world.domainActionsFor(id).map((spec) => spec.name);
  assert.deepEqual(seat(a), ["run_for_sheriff"], "the run decision is offered");
  await runForSheriff(world, [a, b]);
  assert.deepEqual(seat(a), [], "campaigners speak, they do not click");
  assert.deepEqual(seat(outsider), [], "and spectators act in no election phase");
  await stayOnBallot(world);
  assert.deepEqual(seat(outsider), ["cast_sheriff_vote"], "electors get the ballot");
  assert.deepEqual(seat(a), [], "candidates do not");
});

check("a seat's agent toolset is phase-agnostic from construction time (room snapshot contract)", () => {
  const { world, roles } = makeWerewolf(6);
  // The room snapshots world.toolsFor(actorId) exactly once, when the seat is
  // constructed — before the first activation, while the phase is sheriff-run.
  // Every tool any later phase will need must already be in that snapshot:
  // a phase-gated tool is missing from the agent precisely when its phase
  // arrives, and the model's tool call dies with "Tool not found".
  const universal = ["run_for_sheriff", "withdraw_sheriff_run", "cast_sheriff_vote", "pass_badge", "cast_day_vote"];
  const byRoleTools: Record<string, string> = {
    wolf: "choose_night_target",
    "wolf-king": "choose_night_target",
    "hidden-wolf": "choose_night_target",
    "white-wolf-king": "choose_night_target",
    "wolf-beauty": "charm_target",
    seer: "investigate_identity",
    "spirit-seer": "investigate_dead_identity",
    witch: "witch_night_choice",
    guard: "guard_tonight",
    nightmare: "dream_curse",
    hunter: "hunter_shoot"
  };
  for (const [seat, role] of Object.entries(roles)) {
    const names = new Set(world.toolsFor(seat).map((entry) => entry.name));
    for (const required of [...universal, ...(byRoleTools[role] ? [byRoleTools[role]] : [])]) {
      assert.ok(names.has(required), `${required} must be in ${seat}'s (${role}) construction-time toolset`);
    }
  }
});

// --- avalon official tables ---
check("avalon teaches the extractor its allegiance vocabulary", () => {
  const world = createWorld({ roomId: "r-av-hints", scenarioId: "avalon", profiles: profiles(5), rounds: 3 });
  const hints = (world as unknown as { extractionHints?: () => string }).extractionHints?.();
  assert.ok(hints, "avalon publishes extraction hints");
  assert.ok(hints.includes("loyal") && hints.includes("evil"), "the hints use the camp vocabulary the reveal reconciliation checks");
  assert.ok(hints.includes("梅林"), "merlin-style claims are covered");
});

// --- avalon tables ---
check("avalon decks match the official good/evil split", () => {  const expected: Record<number, [number, number]> = { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] };
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
  const details = world.snapshot().details as { ladyHolderId?: string };
  assert.equal(details.ladyHolderId, seats.at(-1)!.id, "token starts right of the first leader");
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
  const call = async (tool: { invoke(context: unknown, input: string): Promise<unknown> }, input: unknown) =>
    String(await tool.invoke(undefined, JSON.stringify(input)));
  // The witch wedge regression: a stringified "null" sentinel must be rejected
  // at parse time as retryable validation feedback, never silently accepted.
  const witch = toolset.toolsFor(byRole("witch")[0]).find((t) => t.name === "witch_night_choice");
  assert.ok(witch, "witch_night_choice is available");
  assert.match(
    await call(witch, { action: "save", targetId: "null", reason: "test" }),
    /rejected by schema validation/,
    '"null" sentinel rejected'
  );
  assert.match(
    await call(witch, { action: "save", targetId: "P3", reason: "test" }),
    /rejected by schema validation/,
    "display names rejected"
  );
  assert.match(
    await call(witch, { action: "heal", targetId: byRole("wolf")[0], reason: "test" }),
    /rejected by schema validation/,
    "unknown potion actions rejected"
  );
  // The flat action field is the single source of truth: save and poison can
  // no longer be submitted together (inexpressible in the schema), and a valid
  // selection passes straight through.
  assert.ok(!await call(witch, { action: "save", targetId: byRole("wolf")[0], reason: "test" }).then((out) => out.includes("rejected by schema validation")), "real ids pass the schema");
  assert.ok(
    !await call(witch, { action: "pass", targetId: null, reason: "test" }).then((out) => out.includes("rejected by schema validation")),
    "explicit null targets pass the schema"
  );
  // Required-target tools reject the sentinel too.
  const voter = Object.keys((world.snapshot().details as { roles: Record<string, string> }).roles)[0];
  const voteTarget = Object.keys((world.snapshot().details as { roles: Record<string, string> }).roles).find((id) => id !== voter)!;
  const vote = toolset.toolsFor(voter).find((t) => t.name === "cast_day_vote");
  assert.ok(vote, "cast_day_vote is available");
  assert.match(await call(vote, { targetId: "null", reason: "test" }), /rejected by schema validation/, "sentinel vote rejected");
  assert.ok(!await call(vote, { targetId: voteTarget, reason: "test" }).then((out) => out.includes("rejected by schema validation")), "valid vote passes the schema");
});
