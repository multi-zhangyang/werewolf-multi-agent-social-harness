/**
 * Trait-adaptation checks: pins the bounded slow-personality-drift engine —
 * step size, cap, decay, effective computation and baseline immutability.
 * No model calls, no network.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import {
  ADAPTATION_CAP,
  MAX_ADAPTATION_STEP,
  adaptTraits,
  effectiveTemperament,
  traitStatesFromTemperament
} from "../../src/society/traits";
import type { AdaptableTrait, AgentTemperament, DecisionBias, SocialEvent } from "../../src/society/contracts";
import { createAgentProfiles } from "../../src/society/profiles";
import { modulateByBiases } from "../../src/society/appraisal";

function check(name: string, fn: () => void): void {
  it(name, fn);
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

check("missing temperament and missing states degrade to no-ops", () => {
  const empty = adaptTraits({ temperament: undefined, events: [event("accused", 1)], turn: 1 });
  assert.equal(Object.keys(empty.states).length, 0);
  assert.equal(empty.moved.length, 0);
  assert.equal(effectiveTemperament(undefined, undefined), undefined);
});

check("event types outside the adaptation rules never move traits", () => {
  const states = adaptTraits({ temperament: TEMPERAMENT, events: [event("defended", 1), event("included", 1)], turn: 1 }).states;
  assert.equal(totalDrift(states), 0, "neutral events do not bend personality");
});

// ── Stable judgment biases ──────────────────────────────────────────────────

const VALID_BIASES: DecisionBias[] = [
  "confirmation",
  "loss-aversion",
  "sunk-cost",
  "in-group",
  "authority-sensitivity",
  "betrayal-hypervigilance",
  "overconfident-lie-detection",
  "self-consistency",
  "recency-weighting"
];

check("every built-in character carries 1-3 valid, fixed decision biases", () => {
  const profiles = createAgentProfiles(["model-a"], 25);
  assert.equal(profiles.length, 25, "the full roster is produced");
  for (const profile of profiles) {
    const biases = profile.decisionBiases ?? [];
    assert.ok(biases.length >= 1 && biases.length <= 3, `${profile.displayName} owns a small fixed set, got ${biases.length}`);
    for (const bias of biases) {
      assert.ok(VALID_BIASES.includes(bias), `${profile.displayName} bias ${bias} is a known bias`);
    }
  }
});

check("bias coverage stays spread across the roster (no bias-granting, no empty roster)", () => {
  const profiles = createAgentProfiles(["model-a"], 25);
  const used = new Set(profiles.flatMap((profile) => profile.decisionBiases ?? []));
  assert.ok(used.size >= 7, `at least 7 of 9 bias kinds appear across characters, got ${used.size}`);
  assert.ok(used.size <= 9, "no unknown bias kinds leaked in");
});

check("betrayal-hypervigilance deepens trust drops and tension; absent bias changes nothing", () => {
  const base = { relationship: { trust: -0.14, tension: 0.12 }, salience: 0.6 };
  const vigilant = modulateByBiases(base, new Set<DecisionBias>(["betrayal-hypervigilance"]));
  assert.ok(vigilant.relationship!.trust! < -0.14, "trust drop deepens");
  assert.ok(vigilant.relationship!.tension! > 0.12, "tension rises further");
  const calm = modulateByBiases(base, new Set<DecisionBias>());
  assert.equal(calm.relationship!.trust, -0.14, "no bias leaves the delta untouched");
  assert.equal(calm.relationship!.tension, 0.12);
});

check("loss-aversion amplifies negative affect only", () => {
  const base = { emotions: { anger: 0.2, fear: 0.1, joy: 0.1 }, salience: 0.5 };
  const averse = modulateByBiases(base, new Set<DecisionBias>(["loss-aversion"]));
  assert.ok(averse.emotions!.anger! > 0.2, "anger amplifies");
  assert.ok(averse.emotions!.fear! > 0.1, "fear amplifies");
  assert.equal(averse.emotions!.joy, 0.1, "positive emotions stay untouched");
});

check("recency-weighting boosts memory salience of fresh events", () => {
  const weighted = modulateByBiases({ salience: 0.5 }, new Set<DecisionBias>(["recency-weighting"]));
  assert.ok(weighted.salience > 0.5 && weighted.salience <= 1, "salience rises within bounds");
  const plain = modulateByBiases({ salience: 0.5 }, new Set<DecisionBias>([]));
  assert.equal(plain.salience, 0.5, "without the bias salience is unchanged");
});

check("every built-in character carries substantive autobiographical anchors", () => {
  const profiles = createAgentProfiles(["model-a"], 25);
  for (const profile of profiles) {
    const anchors = profile.autobiographicalAnchors ?? [];
    assert.ok(anchors.length >= 4, `${profile.displayName} has formative memories, got ${anchors.length}`);
    assert.equal(new Set(anchors).size, anchors.length, `${profile.displayName} anchors are unique`);
    for (const anchor of anchors) {
      assert.ok(anchor.length >= 8, `${profile.displayName} anchor is substantive: ${anchor.slice(0, 12)}…`);
    }
  }
});