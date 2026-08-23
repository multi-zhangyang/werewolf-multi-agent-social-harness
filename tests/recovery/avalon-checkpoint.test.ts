/**
 * Avalon mid-state checkpoint round-trips (AGENTS.md §26): the discussion
 * with an accepted promise, the sealed team vote with one side committed,
 * and the approved team heading into the quest.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase, WorldSerializedState } from "../../src/society/world";

const profiles = createAgentProfiles(["model-a"], 5);
const ids = profiles.map((profile) => profile.id);
const [P1, P2] = ids;

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-avr", scenarioId: "avalon", profiles, rounds: 5 }) as SocialWorldBase;
  world.start();
  return world;
}

function restore(state: WorldSerializedState): SocialWorldBase {
  const world = createWorld({ roomId: "r-avr", scenarioId: "avalon", profiles, rounds: 5, state }) as SocialWorldBase;
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

it("discussion state with an accepted promise survives a round-trip", async () => {
  const world = makeWorld();
  const declared = await world.performDomainAction(P1, "make_commitment", { commitmentType: "team-vote", choice: "approve", proposition: "我会赞成队伍。" });
  const commitmentId = (declared.result as { commitmentId: string }).commitmentId;
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const activation = restored.activation();
  assert.ok(activation?.id.includes(":discussion"), "the round-table discussion resumes in place");
});

it("the sealed team vote with one side committed resumes and settles", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const proposal = world.activation()!;
  const leader = proposal.actorIds[0];
  const team = [...new Set([leader, ...ids.filter((id) => id !== leader)])].slice(0, 2);
  await world.performDomainAction(leader, "propose_team", { memberIds: team, reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation()!;
  await world.performDomainAction(vote.actorIds[0], "cast_team_vote", { accept: true, reason: "t" });
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const resumed = restored.activation();
  assert.ok(resumed && resumed.id.endsWith(":vote"), "the sealed vote reopens");
  const pending = (restored.snapshot().details as { pendingTeamVotes: Record<string, boolean> }).pendingTeamVotes;
  assert.equal(pending[vote.actorIds[0]], true, "the committed vote survives internally");
  assert.ok(!(vote.actorIds[1] in pending), "the pending side is not yet recorded");
  for (const actor of resumed.actorIds) {
    if (actor === vote.actorIds[0]) continue;
    await restored.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
  }
  restored.completeActivation(resumed);
  assert.equal(restored.snapshot().phase, "任务执行", "the approved team heads out after restore");
});

it("an approved team waiting on the quest re-exports stably", async () => {
  const world = makeWorld();
  driveDiscussion(world);
  const proposal = world.activation()!;
  const leader = proposal.actorIds[0];
  const team = [...new Set([leader, ...ids.filter((id) => id !== leader)])].slice(0, 2);
  await world.performDomainAction(leader, "propose_team", { memberIds: team, reason: "t" });
  world.completeActivation(proposal);
  const vote = world.activation()!;
  for (const actor of vote.actorIds) await world.performDomainAction(actor, "cast_team_vote", { accept: true, reason: "t" });
  world.completeActivation(vote);
  assert.equal(world.snapshot().phase, "任务执行", "the quest opens");
  const state = world.exportState();
  const restored = restore(state);
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  const quest = restored.activation();
  assert.ok(quest && quest.id.endsWith(":quest"), "the quest reopens");
  for (const actor of quest.actorIds) {
    await restored.performDomainAction(actor, "cast_quest_vote", { choice: "succeed", reason: "t" });
  }
  restored.completeActivation(quest);
  assert.ok(restored.snapshot().status === "running", "the game continues after restore");
});