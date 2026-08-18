/**
 * Werewolf + Avalon rule checks (run with `npx tsx scripts/verify-werewolf-rules.ts`).
 * Deterministic, no model calls: drives the worlds through the same public
 * surface the room uses (activation / performDomainAction / completeActivation)
 * and pins the researched table rules — decks, night order, guard/witch
 * interactions, hunter shots, jester side-win, parity, and Avalon's official
 * player-count tables.
 */
import { strict as assert } from "node:assert";
import { createWorld } from "../src/society/scenarios";
import type { AgentProfile } from "../src/society/contracts";
import { deckForPlayerCount as avalonDeck, QUEST_TEAM_SIZES, ladyVerdictFor, questFailsNeeded } from "../src/society/scenarios/avalon";
import { WEREWOLF_DECKS, isVillageRole, isWolfRole } from "../src/society/scenarios/werewolf/roles";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ok  ${name}`);
  }).catch((cause) => {
    console.error(`  FAIL ${name}:`, cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  });
}

function profiles(count: number): AgentProfile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `agent-${String(index + 1).padStart(2, "0")}`,
    displayName: `P${index + 1}`,
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
  const world = createWorld({ roomId: "r-ww", scenarioId: "werewolf", profiles: profiles(count), rounds: 2 });
  world.start();
  const snapshot = world.snapshot();
  const roles = snapshot.details.roles as Record<string, string>;
  const byRole = (role: string) => Object.entries(roles).filter(([, r]) => r === role).map(([id]) => id);
  return { world, roles, byRole };
}

/** Drive through discussion waves until the vote (or next phase) opens. */
function skipDiscussion(world: ReturnType<typeof createWorld>): void {
  for (let i = 0; i < 20; i += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.includes(":discussion")) return;
    world.completeActivation(activation);
  }
  throw new Error("discussion never ended");
}

async function run() {
  // --- deck composition ---
  await check("werewolf decks match their player counts and standard wolf tables", () => {
    const expectedWolves: Record<number, number> = { 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 4, 12: 4 };
    for (const deck of WEREWOLF_DECKS) {
      assert.equal(deck.roles.length, deck.playerCount, `${deck.name} role count`);
      const wolves = deck.roles.filter(isWolfRole).length;
      assert.equal(wolves, expectedWolves[deck.playerCount], `${deck.name} wolf count`);
      assert.ok(deck.roles.includes("seer") && deck.roles.includes("witch"), `${deck.name} must include seer and witch`);
    }
    assert.ok(WEREWOLF_DECKS.find((deck) => deck.playerCount === 12)!.roles.includes("wolf-king"), "12P includes the wolf king");
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
  await check("day vote eliminates the plurality target and reveals the role", () => {
    const { world, byRole } = makeWerewolf(8);
    skipDiscussion(world);
    const vote = world.activation();
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

  // --- idiot rules ---
  await check("idiot voted out flips, survives and loses the vote", async () => {
    const { world, byRole } = makeWerewolf(10);
    skipDiscussion(world);
    const vote = world.activation();
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

  await check("a second vote-out eliminates the revealed idiot", async () => {
    const { world, byRole } = makeWerewolf(10);
    skipDiscussion(world);
    const idiot = byRole("idiot")[0];
    const vote1 = world.activation();
    for (const actor of vote1.actorIds) {
      void world.performDomainAction(actor, "cast_day_vote", { targetId: actor === idiot ? byRole("villager")[0] : idiot, reason: "t" });
    }
    world.completeActivation(vote1);
    // A quiet night: wolves kill one villager, witch passes.
    const night = world.activation();
    for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("villager")[0], reason: "t" });
    void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
    void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
    world.completeActivation(night!);
    skipDiscussion(world);
    const vote2 = world.activation();
    assert.ok(vote2 && vote2.id.endsWith(":vote"));
    assert.ok(!vote2.actorIds.includes(idiot), "the revealed idiot is not asked to vote");
    for (const actor of vote2.actorIds) {
      void world.performDomainAction(actor, "cast_day_vote", { targetId: idiot, reason: "t" });
    }
    world.completeActivation(vote2);
    const after = world.snapshot();
    assert.ok(!after.agents.find((agent) => agent.id === idiot)?.alive, "the revealed idiot dies on the second vote-out");
  });

  // --- witch rules ---
  await check("witch cannot save herself", async () => {
    const { world, byRole } = makeWerewolf(8);
    skipDiscussion(world);
    const vote = world.activation();
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

  await check("witch cannot use both potions in the same night", async () => {
    const { world, byRole } = makeWerewolf(8);
    skipDiscussion(world);
    const vote = world.activation();
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
  await check("guard blocks the wolf kill", () => {
    const { world, byRole } = makeWerewolf(9);
    skipDiscussion(world);
    const vote = world.activation();
    for (const actor of vote.actorIds) {
      void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
    }
    world.completeActivation(vote);
    const night = world.activation();
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

  await check("同守同救: guard + antidote on the same victim still kills", () => {
    const { world, byRole } = makeWerewolf(9);
    skipDiscussion(world);
    const vote = world.activation();
    for (const actor of vote.actorIds) {
      void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
    }
    world.completeActivation(vote);
    const night = world.activation();
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

  await check("witch antidote saves the wolf victim", () => {
    const { world, byRole } = makeWerewolf(8);
    skipDiscussion(world);
    const vote = world.activation();
    for (const actor of vote.actorIds) {
      void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
    }
    world.completeActivation(vote);
    const night = world.activation();
    const victim = byRole("seer")[0];
    for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: victim, reason: "t" });
    void world.performDomainAction(victim, "investigate_identity", { targetId: byRole("wolf")[0] });
    void world.performDomainAction(byRole("witch")[0], "witch_night_choice", { saveTargetId: victim });
    world.completeActivation(night!);
    const after = world.snapshot();
    assert.ok(after.agents.find((agent) => agent.id === victim)?.alive, "saved victim survives");
    assert.ok(after.log.some((entry) => /解药/.test(entry.text)), "log reports the antidote");
  });

  await check("poisoned hunter dies without a shot", () => {
    const { world, byRole } = makeWerewolf(8);
    skipDiscussion(world);
    const vote = world.activation();
    for (const actor of vote.actorIds) {
      void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
    }
    world.completeActivation(vote);
    const night = world.activation();
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

  await check("hunter killed by wolves gets a death shot that eliminates", () => {
    const { world, byRole } = makeWerewolf(8);
    skipDiscussion(world);
    const vote = world.activation();
    for (const actor of vote.actorIds) {
      void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
    }
    world.completeActivation(vote);
    const night = world.activation();
    const hunter = byRole("hunter")[0];
    for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: hunter, reason: "t" });
    void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
    void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
    world.completeActivation(night!);
    const shot = world.activation();
    assert.ok(shot && shot.id.includes(":shot:"), "the hunter's shot activation opens");
    const shotTarget = byRole("wolf")[0];
    void world.performDomainAction(hunter, "hunter_shoot", { targetId: shotTarget });
    world.completeActivation(shot);
    const after = world.snapshot();
    assert.ok(!after.agents.find((agent) => agent.id === shotTarget)?.alive, "the hunter's shot eliminates the wolf");
  });

  await check("hunter voted out gets a day shot and the phase then advances", () => {
    const { world, byRole } = makeWerewolf(8);
    skipDiscussion(world);
    const vote = world.activation();
    const hunter = byRole("hunter")[0];
    for (const actor of vote.actorIds) {
      void world.performDomainAction(actor, "cast_day_vote", { targetId: hunter, reason: "t" });
    }
    world.completeActivation(vote!);
    const after = world.snapshot();
    assert.ok(!after.agents.find((agent) => agent.id === hunter)?.alive, "hunter is eliminated by vote");
    const shot = world.activation();
    assert.ok(shot && shot.id.includes(":shot:"), "the hunter's shot activation opens during the day");
    const shotTarget = byRole("villager")[0];
    void world.performDomainAction(hunter, "hunter_shoot", { targetId: shotTarget });
    world.completeActivation(shot);
    const next = world.snapshot();
    assert.ok(!next.agents.find((agent) => agent.id === shotTarget)?.alive, "the shot eliminates its target");
    assert.equal(next.phase, "夜晚行动", "after the shot the day advances to night");
  });

  await check("jester voted out wins solo and the game continues", () => {
    const { world, byRole } = makeWerewolf(8);
    skipDiscussion(world);
    const vote = world.activation();
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

  await check("wolves win at parity after a night kill", () => {
    const { world, byRole } = makeWerewolf(6);
    skipDiscussion(world);
    const vote = world.activation();
    for (const actor of vote.actorIds) {
      void world.performDomainAction(actor, "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
    }
    world.completeActivation(vote!);
    const night = world.activation();
    for (const wolf of byRole("wolf")) void world.performDomainAction(wolf, "choose_night_target", { targetId: byRole("seer")[0], reason: "t" });
    void world.performDomainAction(byRole("seer")[0], "investigate_identity", { targetId: byRole("wolf")[0] });
    void world.performDomainAction(byRole("witch")[0], "witch_night_choice", {});
    world.completeActivation(night!);
    const after = world.snapshot();
    assert.equal(after.status, "finished", "parity ends the game");
    assert.ok(/狼人阵营获胜/.test(after.details.outcome as string), "wolves win by parity");
  });

  // --- avalon official tables ---
  await check("avalon decks match the official good/evil split", () => {
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

  await check("avalon quest team sizes follow the official table", () => {
    assert.deepEqual(QUEST_TEAM_SIZES[5], [2, 3, 2, 3, 3]);
    assert.deepEqual(QUEST_TEAM_SIZES[6], [2, 3, 4, 3, 4]);
    assert.deepEqual(QUEST_TEAM_SIZES[7], [2, 3, 3, 4, 4]);
    assert.deepEqual(QUEST_TEAM_SIZES[8], [3, 4, 4, 5, 5]);
    assert.deepEqual(QUEST_TEAM_SIZES[9], [3, 4, 4, 5, 5]);
    assert.deepEqual(QUEST_TEAM_SIZES[10], [3, 4, 4, 5, 5]);
  });

  await check("avalon fourth quest needs two fails at 7+ players", () => {
    for (const count of [5, 6]) assert.equal(questFailsNeeded(count, 4), 1, `${count}P quest 4`);
    for (const count of [7, 8, 9, 10]) assert.equal(questFailsNeeded(count, 4), 2, `${count}P quest 4`);
    assert.equal(questFailsNeeded(7, 1), 1, "other quests need one fail");
  });

  await check("lady of the lake verdict follows the official loyalty rule", () => {
    assert.equal(ladyVerdictFor("servant"), "loyal");
    assert.equal(ladyVerdictFor("merlin"), "loyal", "the Lady reads loyalty — Merlin is loyal");
    assert.equal(ladyVerdictFor("percival"), "loyal");
    assert.equal(ladyVerdictFor("assassin"), "evil");
    assert.equal(ladyVerdictFor("mordred"), "evil");
    assert.equal(ladyVerdictFor("morgana"), "evil");
    assert.equal(ladyVerdictFor("minion"), "evil");
    assert.equal(ladyVerdictFor("oberon"), "loyal", "Oberon reads as good even to the Lady");
  });

  await check("avalon knowledge follows the official setup (Merlin / Percival / Oberon)", () => {
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
    assert.ok(merlinContext.includes("你已知的内奸"), "Merlin knows the agents of evil");
    for (const id of [...byRole("assassin"), ...byRole("morgana")]) assert.ok(merlinContext.includes(nameFor(id)), `Merlin sees ${roles.get(id)}`);
    assert.ok(!merlinContext.includes(nameFor(oberonId)), "Merlin does not see Oberon");
    if (mordred[0]) assert.ok(!merlinContext.includes(nameFor(mordred[0])), "Merlin does not see Mordred");
    const percivalContext = context(percivalId);
    assert.ok(percivalContext.includes("看见两个人自称梅林"), "Percival sees Merlin and Morgana without telling them apart");
    assert.ok(percivalContext.includes(nameFor(merlinId)) && percivalContext.includes(nameFor(byRole("morgana")[0])), "Percival's sights name both");
    const oberonContext = context(oberonId);
    assert.ok(!oberonContext.includes("你已知的内奸"), "Oberon knows no fellow agents of evil");
    for (const id of [...byRole("assassin"), ...byRole("morgana")]) assert.ok(!context(id).includes(nameFor(oberonId)), `${roles.get(id)} does not know Oberon`);
  });

  await check("lady of the lake starts with the player to the right of the first leader", () => {
    const seats = profiles(5);
    const world = createWorld({ roomId: "r-av", scenarioId: "avalon", profiles: seats, rounds: 5 });
    world.start();
    const state = world.exportState();
    const worldState = state.world as { ladyHolderId: string };
    assert.equal(worldState.ladyHolderId, seats.at(-1)!.id, "token starts right of the first leader");
  });

  await check("werewolf rejects out-of-range player counts with a clear error", () => {
    assert.throws(() => createWorld({ roomId: "r", scenarioId: "werewolf", profiles: profiles(5), rounds: 2 }), /PLAYER_COUNT_INVALID/);
    assert.throws(() => createWorld({ roomId: "r", scenarioId: "werewolf", profiles: profiles(13), rounds: 2 }), /PLAYER_COUNT_INVALID/);
  });

  console.log(`\nWerewolf/Avalon rule checks: ${passed} passed.`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
