/**
 * Sealed simultaneous-action checks (AGENTS.md §7.2 / §19.4): committed but
 * unsettled votes must never cross an observation boundary. A spectator (or
 * another player's POV) sees who has not committed yet — never the committed
 * values — until the barrier settles. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase } from "../../src/society/world";

function check(name: string, fn: () => void | Promise<void>): void {
  it(name, fn);
}

function makeWorld(scenarioId: "avalon" | "werewolf", count: number): SocialWorldBase {
  const world = createWorld({
    roomId: `r-seal-${scenarioId}`,
    scenarioId,
    profiles: createAgentProfiles(["model-a"], count),
    rounds: 5
  }) as SocialWorldBase;
  world.start();
  return world;
}

function skipDiscussion(world: SocialWorldBase): void {
  for (let wave = 0; wave < 40; wave += 1) {
    const activation = world.activation();
    if (!activation || !activation.id.includes(":discussion")) return;
    world.completeActivation(activation);
  }
  throw new Error("discussion never ended");
}

check("avalon team votes stay sealed until every participant commits", async () => {
  const world = makeWorld("avalon", 5);
  skipDiscussion(world);
  const proposal = world.activation()!;
  const leader = proposal.actorIds[0];
  const agents = world.snapshot().agents;
  const teammate = agents.find((agent) => agent.id !== leader)!.id;
  await world.performDomainAction(leader, "propose_team", { memberIds: [leader, teammate], reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation()!;
  assert.ok(vote.id.endsWith(":vote"), "the round table vote opens");
  // One vote is cast; the barrier has not settled.
  await world.performDomainAction(vote.actorIds[0], "cast_team_vote", { accept: true, reason: "t" });
  const nonVoter = vote.actorIds.find((id) => id !== vote.actorIds[0])!;
  const publicView = world.snapshotFor(undefined).details as Record<string, unknown>;
  assert.ok(!("pendingTeamVotes" in publicView), "spectators never see committed team votes");
  const povView = world.snapshotFor(nonVoter).details as Record<string, unknown>;
  assert.ok(!("pendingTeamVotes" in povView), "another player's POV never sees committed team votes");
  // The internal world still holds the sealed value for settlement.
  const internal = world.snapshot().details as { pendingTeamVotes?: Record<string, boolean> };
  assert.ok(internal.pendingTeamVotes, "the world itself retains the sealed votes");
  assert.equal(internal.pendingTeamVotes[vote.actorIds[0]], true, "the committed value survives internally");
});

check("avalon quest votes stay sealed until the quest settles", async () => {
  const world = makeWorld("avalon", 5);
  skipDiscussion(world);
  const proposal = world.activation()!;
  const leader = proposal.actorIds[0];
  const agents = world.snapshot().agents;
  const teammate = agents.find((agent) => agent.id !== leader)!.id;
  await world.performDomainAction(leader, "propose_team", { memberIds: [leader, teammate], reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) await world.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
  world.completeActivation(vote);
  const quest = world.activation()!;
  assert.ok(quest.id.endsWith(":quest"), "the approved team heads out");
  await world.performDomainAction(quest.actorIds[0], "cast_quest_vote", { choice: "succeed", reason: "t" });
  const outsider = vote.actorIds.find((id) => !quest.actorIds.includes(id))!;
  const publicView = world.snapshotFor(undefined).details as Record<string, unknown>;
  assert.ok(!("pendingQuestVotes" in publicView), "spectators never see committed quest votes");
  const povView = world.snapshotFor(outsider).details as Record<string, unknown>;
  assert.ok(!("pendingQuestVotes" in povView), "a non-team member's POV never sees quest votes");
  const internal = world.snapshot().details as { pendingQuestVotes?: Record<string, string> };
  assert.ok(internal.pendingQuestVotes, "the world itself retains the sealed quest votes");
});

check("werewolf day votes stay sealed (regression guard)", async () => {
  const world = makeWorld("werewolf", 8);
  skipDiscussion(world);
  const vote = world.activation()!;
  assert.ok(vote.id.endsWith(":vote"), "the day vote opens");
  const roles = (world.snapshot().details.roles ?? {}) as Record<string, string>;
  const byRole = (role: string): string[] =>
    Object.entries(roles).filter(([, assigned]) => assigned === role).map(([id]) => id);
  await world.performDomainAction(vote.actorIds[0], "cast_day_vote", { targetId: byRole("villager")[0], reason: "t" });
  const publicView = world.snapshotFor(undefined).details as Record<string, unknown>;
  assert.ok(!("pendingVotes" in publicView), "spectators never see committed day votes");
  const povView = world.snapshotFor(vote.actorIds[1]).details as Record<string, unknown>;
  assert.ok(!("pendingVotes" in povView), "another player's POV never sees committed day votes");
  const internal = world.snapshot().details as { pendingVotes?: Array<[string, string]> };
  assert.ok(internal.pendingVotes, "the world itself retains the sealed votes");
});