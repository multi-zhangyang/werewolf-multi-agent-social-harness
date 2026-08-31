/**
 * Avalon behavior chain (AGENTS.md §27/§28): typed team-vote and quest-outcome
 * promises settle against the sealed votes — kept/broken only where the
 * evidence exists; a minion who claimed loyalty is exposed by the end-game
 * reveal (planless deception detection); loyal participants cannot promise to
 * fail a quest. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase } from "../../src/society/world";
import type { Commitment, StoryBeatKind } from "../../src/society/contracts";

const profiles = createAgentProfiles(["model-a"], 5);
const ids = profiles.map((profile) => profile.id);
const [P1, P2] = ids;

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-av", scenarioId: "avalon", profiles, rounds: 5 }) as SocialWorldBase;
  world.start();
  return world;
}

function rolesOf(world: SocialWorldBase): Record<string, string> {
  return (world.snapshot().details.roles ?? {}) as Record<string, string>;
}

function byRole(world: SocialWorldBase, role: string): string[] {
  return Object.entries(rolesOf(world)).filter(([, assigned]) => assigned === role).map(([id]) => id);
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

/** Official 5-player quest sizes: quests 1..5 are 2/3/2/3/3 members. */
const QUEST_SIZES_5 = [2, 3, 2, 3, 3];

function questTeamFor(world: SocialWorldBase, leader: string, excluded: string[] = []): string[] {
  const quest = world.snapshot().turn;
  const size = QUEST_SIZES_5[quest - 1] ?? 3;
  return [...new Set([leader, ...ids.filter((id) => id !== leader && !excluded.includes(id))])].slice(0, size);
}


/** Drive the current quest to success by having every team member succeed. */
async function succeedQuest(world: SocialWorldBase): Promise<void> {
  const quest = world.activation();
  assert.ok(quest && quest.id.endsWith(":quest"));
  for (const actor of quest.actorIds) {
    await world.performDomainAction(actor, "cast_quest_vote", { choice: "succeed", reason: "t" });
  }
  world.completeActivation(quest);
}

it("the Lady phase exposes an explicit tool for both inspect and decline choices", async () => {
  const world = makeWorld();
  for (let questNumber = 1; questNumber <= 2; questNumber += 1) {
    driveDiscussion(world);
    const proposal = world.activation()!;
    const leader = proposal.actorIds[0];
    await world.performDomainAction(leader, "propose_team", { memberIds: questTeamFor(world, leader), reason: "t" });
    world.completeActivation(proposal);
    const vote = world.activation()!;
    for (const actor of vote.actorIds) await world.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
    world.completeActivation(vote);
    await succeedQuest(world);
  }

  const lady = world.activation();
  assert.ok(lady && lady.id.endsWith(":lady"));
  const holder = lady.actorIds[0];
  const toolNames = world.toolsFor(holder).map((entry) => entry.name);
  assert.ok(toolNames.includes("inspect_with_lady"));
  assert.ok(toolNames.includes("decline_lady"), "every advertised domain action has a real SDK tool");
  await world.performDomainAction(holder, "decline_lady", { reason: "skip this inspection" });
  world.completeActivation(lady);
  assert.notEqual(world.snapshot().phase, "湖中仙女", "explicit decline resolves the phase");
});

async function declareAndAccept(world: SocialWorldBase, promisor: string, commitmentType: "team-vote" | "quest-outcome", choice: string, proposition: string, acceptor = P2): Promise<string> {
  const declared = await world.performDomainAction(promisor, "make_commitment", { commitmentType, choice, proposition });
  const commitmentId = (declared.result as { commitmentId: string }).commitmentId;
  await world.performDomainAction(acceptor, "accept_commitment", { commitmentId });
  return commitmentId;
}

// --- team-vote commitments settle against the sealed vote ---
it("an approved-team promise that the promisor honors earns promise-kept", async () => {
  const world = makeWorld();
  const commitmentId = await declareAndAccept(world, P1, "team-vote", "approve", "我会赞成队伍。");
  driveDiscussion(world);
  const proposal = world.activation()!;
  const leader = proposal.actorIds[0];
  const team = questTeamFor(world, leader);
  await world.performDomainAction(leader, "propose_team", { memberIds: team, reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    await world.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
  }
  world.completeActivation(vote);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

it("an approved-team promise broken by a reject vote earns promise-broken", async () => {
  const world = makeWorld();
  const commitmentId = await declareAndAccept(world, P1, "team-vote", "approve", "我保证赞成。");
  driveDiscussion(world);
  const proposal = world.activation()!;
  const leader = proposal.actorIds[0];
  const team = questTeamFor(world, leader);
  await world.performDomainAction(leader, "propose_team", { memberIds: team, reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) {
    // P1 breaks their promise; everyone else approves.
    await world.performDomainAction(actor, "cast_team_vote", { accept: actor !== P1, reason: "t" });
  }
  world.completeActivation(vote);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "violated");
  assert.equal(lastBeat(world), "promise-broken");
});

it("an unaccepted team-vote promise is voided at settlement", async () => {
  const world = makeWorld();
  const declared = await world.performDomainAction(P1, "make_commitment", { commitmentType: "team-vote", choice: "approve", proposition: "我会赞成。" });
  driveDiscussion(world);
  const commitmentId = (declared.result as { commitmentId: string }).commitmentId;
  const proposal = world.activation()!;
  const leader = proposal.actorIds[0];
  const team = questTeamFor(world, leader);
  await world.performDomainAction(leader, "propose_team", { memberIds: team, reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) await world.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
  world.completeActivation(vote);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "void");
});

// --- quest-outcome commitments settle against the quest vote ---
it("a minion who promised to fail and did keeps the promise", async () => {
  const world = makeWorld();
  const minion = byRole(world, "minion")[0] ?? byRole(world, "assassin")[0];
  const loyal = byRole(world, "servant")[0] ?? ids.find((id) => id !== minion)!;
  const commitmentId = await declareAndAccept(world, minion, "quest-outcome", "fail", "我会让这次任务失败。", loyal);
  driveDiscussion(world);
  const proposal = world.activation()!;
  const leader = proposal.actorIds[0];
  const questTeam = [...new Set([leader, minion, ...ids.filter((id) => id !== leader && id !== minion)])].slice(0, 2);
  await world.performDomainAction(leader, "propose_team", { memberIds: questTeam, reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) await world.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
  world.completeActivation(vote);
  const quest = world.activation()!;
  for (const actor of quest.actorIds) {
    await world.performDomainAction(actor, "cast_quest_vote", { choice: actor === minion ? "fail" : "succeed", reason: "t" });
  }
  world.completeActivation(quest);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

it("loyal participants cannot promise to fail a quest", async () => {
  const world = makeWorld();
  const loyal = byRole(world, "servant")[0];
  await assert.rejects(
    world.performDomainAction(loyal, "make_commitment", { commitmentType: "quest-outcome", choice: "fail", proposition: "我会让任务失败。" }),
    /LOYAL_CANNOT_PROMISE_FAIL/
  );
});

// --- end-game reveal reconciles extracted camp claims (§28) ---
it("a minion who claimed loyalty is exposed by the reveal", async () => {
  const world = makeWorld();
  const minion = byRole(world, "minion")[0] ?? byRole(world, "assassin")[0];
  const message = await world.sendMessage({ senderId: minion, channel: "public", text: "我是忠诚阵营的，相信我。" });
  driveDiscussion(world);
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "identity", subjectId: minion, predicate: "has-team", object: "loyal" }
  }]);
  // Drive three successful quests with evil-free teams, then the assassination.
  for (let quest = 0; quest < 3; quest += 1) {
    const lady = world.activation();
    if (lady && lady.id.endsWith(":lady")) world.completeActivation(lady);
    driveDiscussion(world);
    const evil = byRole(world, "minion")[0] ?? byRole(world, "assassin")[0];
    const proposer = world.activation();
    assert.ok(proposer && proposer.id.endsWith(":proposal"));
    const leader = proposer.actorIds[0];
    const questTeam = questTeamFor(world, leader, [evil]);
    await world.performDomainAction(leader, "propose_team", { memberIds: questTeam, reason: "t" });
    world.completeActivation(proposer);
    const vote = world.activation();
    assert.ok(vote && vote.id.endsWith(":vote"));
    for (const actor of vote.actorIds) await world.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
    world.completeActivation(vote);
    await succeedQuest(world);
  }
  const assassination = world.activation();
  assert.ok(assassination && assassination.id.endsWith(":assassination"), "three successes open the assassination");
  const assassin = assassination.actorIds[0];
  // Miss Merlin: target another loyal player so loyal wins and the reveal runs.
  const merlin = byRole(world, "merlin")[0];
  const servants = byRole(world, "servant");
  const otherLoyal = servants.find((id) => id !== merlin);
  await world.performDomainAction(assassin, "assassinate_merlin", { targetId: otherLoyal, reason: "t" });
  world.completeActivation(assassination);
  assert.equal(world.snapshot().status, "finished", "the game ends");
  const projection = (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { deceptions: Array<{ deceiverActorId: string; status: string; mode: string; contradictionEventIds: string[] }> } }).socialCausalityFor(undefined, true);
  const episode = projection.deceptions.find((entry) => entry.deceiverActorId === minion);
  assert.ok(episode, "the minion's false loyalty claim becomes a deception episode");
  assert.equal(episode.status, "detected");
  assert.equal(episode.mode, "identity-performance");
  assert.ok(episode.contradictionEventIds.length >= 1, "the reveal event contradicts the claim");
});

// --- sealed team vote: the barrier holds until every vote is in ---
it("a sealed team vote settles the accepted promise once every vote is in", async () => {
  const world = makeWorld();
  const commitmentId = await declareAndAccept(world, P1, "team-vote", "approve", "我会赞成队伍。");
  driveDiscussion(world);
  const proposal = world.activation()!;
  const leader = proposal.actorIds[0];
  const team = questTeamFor(world, leader);
  await world.performDomainAction(leader, "propose_team", { memberIds: team, reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation()!;
  await world.performDomainAction(vote.actorIds[0], "cast_team_vote", { accept: true, reason: "t" });
  for (const actor of vote.actorIds) {
    if (actor === vote.actorIds[0]) continue;
    await world.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
  }
  world.completeActivation(vote);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "fulfilled");
});
