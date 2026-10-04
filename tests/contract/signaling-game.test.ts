import { expect, it } from "vitest";
import { SignalingScenario } from "../../src/runtime/scenarios/signaling";
import { ledgerExperience } from "../../src/runtime/agent-state";
import { runSpecSchema, type SignalingIncentives, type WorldEvent } from "../../src/runtime/types";
import { characters } from "../helpers/general-agent-fixture";

const pair = characters.slice(0, 2);
function create(seed = 1, incentives: SignalingIncentives = "conflicting") { return new SignalingScenario(pair, 2, seed, incentives); }
function choose(world: SignalingScenario, report: boolean, accept: boolean) {
  world.apply("self", "declare_quality", { highQuality: report }); world.advance(); world.advance();
  world.apply("peer", "choose_offer", { accept });
  return world.advance()[0];
}

it("keeps opposite private qualities indistinguishable to a receiver until settlement", () => {
  const high = create(0); const low = create(1);
  expect(high.observation("self").facts.privateInformation).toMatchObject({ highQuality: true });
  expect(low.observation("self").facts.privateInformation).toMatchObject({ highQuality: false });
  expect(high.observation("peer")).toEqual(low.observation("peer"));
  expect(high.publicState()).toEqual(low.publicState());
  for (const world of [high, low]) {
    world.apply("self", "declare_quality", { highQuality: true }); world.advance();
  }
  expect(high.observation("peer")).toEqual(low.observation("peer"));
  for (const world of [high, low]) { world.advance(); world.apply("peer", "choose_offer", { accept: false }); }
  expect(high.observation("peer")).toEqual(low.observation("peer"));
  expect(high.publicState().highQuality).toBeUndefined();
  expect(high.advance()[0].data).toMatchObject({ highQuality: true, reportAccurate: true, settlement: true });
  expect(low.advance()[0].data).toMatchObject({ highQuality: false, reportAccurate: false, settlement: true });
  expect(low.observation("peer").facts).toMatchObject({ highQuality: false, reportAccurate: false });
  for (const world of [high, low]) world.advance();
  expect(low.publicState()).toMatchObject({ round: 2, phaseId: "report" });
  expect(low.publicState().highQuality).toBeUndefined();
  expect(low.observation("peer").facts.privateInformation).toBeUndefined();
});

it.each([
  ["aligned", true, true, 6, 6], ["aligned", false, true, 0, 0],
  ["conflicting", true, true, 6, 6], ["conflicting", false, true, 6, 0],
  ["aligned", true, false, 2, 2], ["aligned", false, false, 2, 2],
  ["conflicting", true, false, 2, 2], ["conflicting", false, false, 2, 2],
] as const)("settles %s, quality=%s, accepted=%s from truth rather than the report", (incentives, quality, accepted, sender, receiver) => {
  const world = create(quality ? 0 : 1, incentives);
  const event = choose(world, !quality, accepted);
  expect(event.data).toMatchObject({ highQuality: quality, reportedHighQuality: !quality, reportAccurate: false, accepted, rewardScale: 6, payoffs: { self: sender, peer: receiver } });
  expect(world.publicState().scores).toEqual({ self: sender, peer: receiver });
  const spec = runSpecSchema.parse({ scenario: "signaling-game", signalingIncentives: incentives, roster: pair.map(c => ({ characterId: c.id })) });
  const experience = ledgerExperience({ ...event, id: "outcome", runId: "episode", seq: 1, at: "" } as WorldEvent, spec, "self");
  expect(experience?.reward).toEqual({ value: sender, normalized: sender / 6, unit: "points", scope: "round" });
});

it("rejects invalid actors, stages, malformed booleans and duplicates before changing state", () => {
  const world = create(); const before = world.checkpoint();
  expect(() => world.advance()).toThrow("未完成");
  expect(() => world.apply("peer", "declare_quality", { highQuality: true })).toThrow();
  expect(() => world.apply("self", "choose_offer", { accept: true })).toThrow();
  for (const input of [{ highQuality: "false" }, { highQuality: 1 }, {}, { highQuality: true, extra: false }]) expect(() => world.apply("self", "declare_quality", input)).toThrow();
  expect(world.checkpoint()).toEqual(before);
  world.apply("self", "declare_quality", { highQuality: false }); const submitted = world.checkpoint();
  expect(() => world.apply("self", "declare_quality", { highQuality: true })).toThrow();
  expect(world.checkpoint()).toEqual(submitted);
  expect(() => world.observe("outsider")).toThrow(); expect(world.actions("outsider")).toEqual([]);
});

it("restores pending truth, score and random sequence and settles each round only once", () => {
  const world = create(); const checkpoint = world.checkpoint();
  const first = choose(world, true, true); world.advance();
  const secondTruth = world.observation("self").facts.privateInformation;
  world.restore(checkpoint);
  expect(choose(world, true, true)).toEqual(first); world.advance();
  expect(world.observation("self").facts.privateInformation).toEqual(secondTruth);
  choose(world, false, false); world.advance();
  const completed = world.checkpoint();
  expect(world.stage()).toBeUndefined(); expect(world.advance()).toEqual([]);
  expect(world.checkpoint()).toEqual(completed); expect(world.publicState().history).toHaveLength(2);
  const exposed = world.publicState(); exposed.scores.self = 999; exposed.history[0].payoffs.self = 999;
  expect(world.checkpoint()).toEqual(completed);
});

it("uses the same quality sequence in both incentive conditions without exposing the seed", () => {
  const aligned = create(23, "aligned"); const conflicting = create(23, "conflicting");
  for (let round = 1; round <= 2; round++) {
    expect(aligned.observation("self").facts.privateInformation).toEqual(conflicting.observation("self").facts.privateInformation);
    expect(aligned.observation("self").facts).not.toHaveProperty("randomState");
    expect(aligned.observation("peer").facts).not.toHaveProperty("seed");
    for (const world of [aligned, conflicting]) { choose(world, true, true); world.advance(); }
  }
});

it("permits discussion only in its designated stages and validates the new run configuration", () => {
  const world = create(); expect(world.canMessage("self", "public", [])).toBe(false);
  world.apply("self", "declare_quality", { highQuality: true }); world.advance();
  expect(world.canMessage("self", "public", [])).toBe(true);
  expect(world.canMessage("self", "private", ["peer"])).toBe(true);
  expect(world.canMessage("self", "team", ["peer"])).toBe(false);
  expect(world.canMessage("outsider", "public", [])).toBe(false);
  expect(world.canMessage("self", "private", ["outsider"])).toBe(false);
  const spec = { scenario: "signaling-game", roster: pair.map(c => ({ characterId: c.id })) };
  expect(runSpecSchema.safeParse({ ...spec, signalingIncentives: "not-a-condition" }).success).toBe(false);
  expect(runSpecSchema.safeParse({ ...spec, roster: characters.slice(0, 3).map(c => ({ characterId: c.id })) }).success).toBe(false);
});
