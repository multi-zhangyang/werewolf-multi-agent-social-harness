/**
 * Centipede behavior chain (AGENTS.md §27/§28): a take/pass promise settles
 * against the irreversible typed move — kept/broken only where the evidence
 * exists; unaccepted proposals void; extracted move claims reconcile against
 * the actual move. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { SocialWorldBase } from "../../src/society/world";
import type { Commitment, StoryBeatKind } from "../../src/society/contracts";

const profiles = createAgentProfiles(["model-a"], 2);
const [P1, P2] = profiles.map((profile) => profile.id);

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-cg", scenarioId: "centipede-game", profiles, rounds: 4 }) as SocialWorldBase;
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

async function declare(world: SocialWorldBase, promisor: string, moveAction: "take" | "pass", proposition: string): Promise<string> {
  const declared = await world.performDomainAction(promisor, "make_commitment", { moveAction, proposition });
  return (declared.result as { commitmentId: string }).commitmentId;
}

async function playMove(world: SocialWorldBase, action: "take" | "pass"): Promise<void> {
  driveDiscussion(world);
  const move = world.activation();
  assert.ok(move && move.id.endsWith(":move"));
  await world.performDomainAction(move.actorIds[0], "centipede_move", { action, reason: "t" });
  world.completeActivation(move);
}

it("a take promise the mover honors earns promise-kept", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "take", "我会拿走。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playMove(world, "take");
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "fulfilled");
  assert.equal(lastBeat(world), "promise-kept");
});

it("a pass promise broken by taking earns promise-broken", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "pass", "我保证继续传递。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  await playMove(world, "take");
  assert.equal(commitments(world).find((entry) => entry.commitmentId === commitmentId)?.state, "violated");
  assert.equal(lastBeat(world), "promise-broken");
});

it("an unaccepted move promise is voided at settlement", async () => {
  const world = makeWorld();
  await declare(world, P1, "pass", "我会传递。");
  await playMove(world, "take");
  assert.equal(commitments(world)[0].state, "void");
});

it("an extracted move claim reconciles against the actual move", async () => {
  const world = makeWorld();
  const message = await world.sendMessage({ senderId: P1, channel: "public", text: "这步我会拿走。" });
  world.recordExtractedSocialActs(message.id, [{
    kind: "assertion",
    proposition: { kind: "future-action", subjectId: P1, predicate: "claimed-action", object: "take" }
  }]);
  await playMove(world, "pass");
  const projection = (world as unknown as { socialCausalityFor(actorId?: string, omniscient?: boolean): { evidence: Array<{ propositionId: string; supports: boolean; sourceType: string }> } }).socialCausalityFor(undefined, true);
  assert.ok(
    projection.evidence.some((entry) => entry.sourceType === "domain-result" && entry.supports === false),
    "passing contradicts the claimed take"
  );
});

it("commitments and a pending move survive export/restore", async () => {
  const world = makeWorld();
  const commitmentId = await declare(world, P1, "pass", "我会传递。");
  await world.performDomainAction(P2, "accept_commitment", { commitmentId });
  const state = world.exportState();
  const restored = createWorld({ roomId: "r-cg", scenarioId: "centipede-game", profiles, rounds: 4, state }) as SocialWorldBase;
  restored.start();
  assert.equal(JSON.stringify(restored.exportState().world), JSON.stringify(state.world));
  assert.equal(commitments(restored).find((entry) => entry.commitmentId === commitmentId)?.state, "accepted");
  await playMove(restored, "pass");
  assert.equal(commitments(restored).find((entry) => entry.commitmentId === commitmentId)?.state, "fulfilled");
  assert.equal(lastBeat(restored), "promise-kept");
});