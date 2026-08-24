/**
 * Stag-hunt behavior chain (AGENTS.md §27/§28): a stag promise settles
 * against the sealed simultaneous choice — kept/broken only where the
 * evidence exists; unaccepted proposals void; extracted claims reconcile
 * against the actual choice. Deterministic, no model calls.
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
  const world = createWorld({ roomId: "r-sh", scenarioId: "stag-hunt", profiles, rounds }) as SocialWorldBase;
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

async function declare(world: SocialWorldBase, promisor: string, choice: string, proposition: string): Promise<string> {
  const declared = await world.performDomainAction(promisor, "make_commitment", { choice, proposition });
  return (declared.result as { commitmentId: string }).commitmentId;
}

async function playRound(world: SocialWorldBase, p1Choice: string, p2Choice: string): Promise<void> {
  driveDiscussion(world);
  const choice = world.activation();
  assert.ok(choice && choice.id.endsWith(":choice"));
  await world.performDomainAction(choice.actorIds[0], "hunt_choice", { choice: p1Choice, reason: "t" });
  await world.performDomainAction(choice.actorIds[1], "hunt_choice", { choice: p2Choice, reason: "t" });
  world.completeActivation(choice);
}

it("an honored stag promise earns promise-kept", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "stag", "我肯定去猎鹿。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, "stag", "stag");
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

it("a broken stag promise earns promise-broken", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "stag", "我肯定去猎鹿。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playRound(world, "rabbit", "stag");
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "violated");
  assert.equal(lastBeat(world), "promise-broken");
});

it("an unaccepted stag promise is voided at settlement", async () => {
  const world = makeWorld();
  await declare(world, P1, "stag", "我肯定去猎鹿。");
  await playRound(world, "stag", "stag");
  assert.equal(commitments(world)[0].state, "void");
});

it("a contradicted extracted claim records contradiction evidence", async () => {
  const world = makeWorld();
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "我肯定去猎鹿。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "stag" }
  }]);
  await playRound(world, "rabbit", "stag");
  const projection = (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { evidence: Array<{ propositionId: string; supports: boolean; sourceType: string }> } }).socialCausalityFor(undefined, true);
  assert.ok(
    projection.evidence.some((entry) => entry.sourceType === "domain-result" && entry.supports === false),
    "choosing rabbit contradicts the claimed stag"
  );
});

it("commitments and a sealed choice settle identically on the live path", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "stag", "我肯定去猎鹿。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  driveDiscussion(world);
  const choice = world.activation()!;
  await world.performDomainAction(choice.actorIds[0], "hunt_choice", { choice: "stag", reason: "t" });
  await world.performDomainAction(choice.actorIds[1], "hunt_choice", { choice: "stag", reason: "t" });
  world.completeActivation(choice);
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});
