/**
 * Trait-adaptation checks (run with `npx tsx scripts/verify-traits.ts`).
 * Pins the bounded slow-personality-drift engine (AGENTS.md §4.2.8):
 * step size, cap, decay, effective computation, season-boundary erosion and
 * baseline immutability. No model calls, no network.
 */
import { strict as assert } from "node:assert";
import {
  ADAPTATION_CAP,
  MAX_ADAPTATION_STEP,
  adaptTraits,
  decayAcrossSeason,
  effectiveTemperament,
  traitStatesFromTemperament
} from "../src/society/traits";
import type { AdaptableTrait, AgentTemperament, SocialEvent } from "../src/society/contracts";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const TEMPERAMENT: AgentTemperament = {
  openness: 0.6,
  conscientiousness: 0.7,
  extraversion: 0.5,
  agreeableness: 0.8,
  neuroticism: 0.4
};

function event(type: SocialEvent["type"], turn: number): SocialEvent {
  return {
    id: `e-${turn}-${type}`,
    type,
    turn,
    phase: "day",
    detail: `event ${type} on turn ${turn}`
  };
}

function totalDrift(states: ReturnType<typeof adaptTraits>["states"]): number {
  return (Object.values(states) as Array<{ adaptation: number }>).reduce((sum, state) => sum + Math.abs(state.adaptation), 0);
}

check("initialization seeds every Big Five trait at baseline with zero adaptation", () => {
  const states = traitStatesFromTemperament(TEMPERAMENT, 0);
  for (const trait of Object.keys(TEMPERAMENT) as AdaptableTrait[]) {
    assert.equal(states[trait].baseline, TEMPERAMENT[trait], `${trait} baseline`);
    assert.equal(states[trait].adaptation, 0, `${trait} starts flat`);
    assert.equal(states[trait].effective, TEMPERAMENT[trait], `${trait} effective = baseline`);
  }
});

check("a single accusation moves adaptation by at most the per-event step cap", () => {
  const result = adaptTraits({ temperament: TEMPERAMENT, events: [event("accused", 1)], turn: 1 });
  const neuroticism = result.states.neuroticism;
  assert.ok(neuroticism.adaptation > 0, "an accusation must push neuroticism up");
  assert.ok(neuroticism.adaptation <= MAX_ADAPTATION_STEP, "single event stays within one step");
  assert.ok(result.moved.length > 0, "movement is reported");
  assert.equal(result.states.openness.adaptation, 0, "unrelated traits do not move");
});

check("repeated high-intensity events accumulate toward the bounded cap", () => {
  let states = traitStatesFromTemperament(TEMPERAMENT, 0);
  for (let turn = 1; turn <= 80; turn += 1) {
    states = adaptTraits({
      temperament: TEMPERAMENT,
      events: [event("accused", turn), event("vote-against", turn)],
      turn,
      current: states
    }).states;
  }
  for (const state of Object.values(states)) {
    assert.ok(Math.abs(state.adaptation) <= ADAPTATION_CAP + 1e-9, "adaptation stays bounded");
  }
  assert.ok(states.neuroticism.adaptation > 0.1, "repeated accusations leave a visible drift");
  assert.ok(states.agreeableness.adaptation < 0, "repeated targeting erodes agreeableness");
});

check("unreinforced adaptation decays toward baseline and vanishes when tiny", () => {
  let states = traitStatesFromTemperament(TEMPERAMENT, 0);
  states = adaptTraits({ temperament: TEMPERAMENT, events: [event("accused", 1)], turn: 1, current: states }).states;
  const raised = states.neuroticism.adaptation;
  // No events for the next 4 turns: decay applies only after 3 quiet turns.
  let decayed = raised;
  for (let turn = 2; turn <= 6; turn += 1) {
    states = adaptTraits({ temperament: TEMPERAMENT, events: [], turn, current: states }).states;
    decayed = states.neuroticism.adaptation;
  }
  assert.ok(decayed < raised, "quiet turns erode unreinforced drift");
  for (let turn = 7; turn <= 40; turn += 1) {
    states = adaptTraits({ temperament: TEMPERAMENT, events: [], turn, current: states }).states;
  }
  assert.equal(states.neuroticism.adaptation, 0, "faded drift returns exactly to baseline");
  assert.equal(states.neuroticism.effective, states.neuroticism.baseline);
});

check("effective temperament applies drift without mutating the baseline profile", () => {
  const baseline = { ...TEMPERAMENT };
  const states = traitStatesFromTemperament(TEMPERAMENT, 0);
  states.neuroticism = { ...states.neuroticism, adaptation: 0.2, effective: TEMPERAMENT.neuroticism + 0.2 };
  const effective = effectiveTemperament(TEMPERAMENT, states);
  assert.equal(effective!.neuroticism, TEMPERAMENT.neuroticism + 0.2, "effective value reflects drift");
  assert.deepEqual(TEMPERAMENT, baseline, "the stored baseline is never mutated");
  assert.deepEqual(states.openness, { baseline: TEMPERAMENT.openness, adaptation: 0, effective: TEMPERAMENT.openness, lastCauses: [], updatedAtTurn: 0 }, "undrifted traits stay untouched");
});

check("season-boundary decay erodes drift partway and clears tiny remnants", () => {
  let states = traitStatesFromTemperament(TEMPERAMENT, 0);
  states = adaptTraits({ temperament: TEMPERAMENT, events: [event("accused", 1)], turn: 1, current: states }).states;
  const raised = states.neuroticism.adaptation;
  const carried = decayAcrossSeason(states)!;
  assert.ok(carried.neuroticism.adaptation > 0, "drift survives one game boundary");
  assert.ok(carried.neuroticism.adaptation < raised, "but erodes while away from the table");
  assert.equal(carried.neuroticism.effective, carried.neuroticism.baseline + carried.neuroticism.adaptation, "effective stays consistent");
  assert.equal(carried.neuroticism.lastCauses.length, states.neuroticism.lastCauses.length, "causes are preserved");
  // Tiny drift is cleared entirely.
  states.neuroticism = { ...states.neuroticism, adaptation: 0.002 };
  const cleared = decayAcrossSeason(states)!;
  assert.equal(cleared.neuroticism.adaptation, 0);
  assert.equal(cleared.neuroticism.effective, cleared.neuroticism.baseline);
});

check("missing temperament and missing states degrade to no-ops", () => {
  const empty = adaptTraits({ temperament: undefined, events: [event("accused", 1)], turn: 1 });
  assert.equal(Object.keys(empty.states).length, 0);
  assert.equal(empty.moved.length, 0);
  assert.equal(effectiveTemperament(undefined, undefined), undefined);
  assert.equal(decayAcrossSeason(undefined), undefined);
});

check("event types outside the adaptation rules never move traits", () => {
  const states = adaptTraits({ temperament: TEMPERAMENT, events: [event("defended", 1), event("included", 1)], turn: 1 }).states;
  assert.equal(totalDrift(states), 0, "neutral events do not bend personality");
});

console.log(`\nTrait-adaptation checks: ${passed} passed.`);