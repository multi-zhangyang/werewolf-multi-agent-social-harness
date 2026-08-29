/**
 * Slow personality adaptation.
 *
 * A character's Big Five baseline must not flip after a single game. Repeated,
 * high-intensity experiences only shift a small bounded "adaptation" that
 * decays back toward the baseline unless reinforced. `effective = baseline +
 * bounded(adaptation)` is what actually feeds the discussion director, the
 * appraisal modulators and the model-facing temperament context — so behavior
 * changes slowly, with a recorded cause for every movement.
 *
 * Rules:
 *  - adaptation moves by at most `MAX_ADAPTATION_STEP` per event;
 *  - total adaptation is bounded to ±ADAPTATION_CAP (e.g. ±0.25);
 *  - unreinforced adaptation decays a fraction back toward baseline each turn;
 *  - only repeated, high-salience events drive lasting change; a single
 *    isolated outcome produces only a small, short-lived nudge.
 */
import type { AdaptableTrait, AgentTemperament, SocialEvent, TraitState } from "./contracts";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export const ADAPTATION_CAP = 0.25;
export const MAX_ADAPTATION_STEP = 0.05;

export interface TraitAdaptationInput {
  temperament: AgentTemperament | undefined;
  events: SocialEvent[];
  turn: number;
  /** Existing trait states, keyed by trait; created on first contact. */
  current?: Record<AdaptableTrait, TraitState>;
}

export interface TraitAdaptationResult {
  states: Record<AdaptableTrait, TraitState>;
  /** The trait states that actually moved this pass. */
  moved: Array<{ trait: AdaptableTrait; state: TraitState }>;
}

/** Trait movement rules per event type. Conservative by design. */
const TRAIT_RULES: Record<string, Array<{ trait: AdaptableTrait; delta: number; cause: (event: SocialEvent) => string }>> = {
  accused: [
    { trait: "neuroticism", delta: 0.012, cause: () => "被公开指控后对威胁更敏感" },
    { trait: "agreeableness", delta: -0.01, cause: () => "反复被指控让人更提防他人" }
  ],
  "vote-against": [
    { trait: "neuroticism", delta: 0.012, cause: () => "被投票针对让人更警惕" },
    { trait: "agreeableness", delta: -0.014, cause: () => "被投票针对削弱了对群体的信任" }
  ],
  eliminated: [
    { trait: "neuroticism", delta: 0.02, cause: () => "被淘汰后更害怕再次出局" },
    { trait: "conscientiousness", delta: 0.012, cause: () => "失利后更谨慎、更想做好准备" }
  ],
  "eliminated-other": [
    { trait: "neuroticism", delta: 0.008, cause: () => "目睹淘汰后风险感上升" }
  ],
  win: [
    { trait: "extraversion", delta: 0.012, cause: () => "获胜让人更愿意表达与主导" },
    { trait: "neuroticism", delta: -0.01, cause: () => "获胜缓解了对失败的担忧" }
  ],
  lose: [
    { trait: "neuroticism", delta: 0.014, cause: () => "失利让人更担心重蹈覆辙" }
  ],
  "quest-failed": [
    { trait: "neuroticism", delta: 0.01, cause: () => "任务失败让人更紧张" },
    { trait: "conscientiousness", delta: 0.008, cause: () => "任务失败后更重视细节" }
  ]
};

export function adaptTraits(input: TraitAdaptationInput): TraitAdaptationResult {
  const temperament = input.temperament;
  const states: Record<AdaptableTrait, TraitState> = {} as Record<AdaptableTrait, TraitState>;
  if (temperament) {
    for (const trait of Object.keys(temperament) as AdaptableTrait[]) {
      const baseline = temperament[trait];
      const existing = input.current?.[trait];
      states[trait] = existing
        ? { ...existing }
        : { baseline, adaptation: 0, effective: baseline, lastCauses: [], updatedAtTurn: input.turn };
    }
  }
  if (Object.keys(states).length === 0) return { states, moved: [] };

  const moved: Array<{ trait: AdaptableTrait; state: TraitState }> = [];
  for (const event of input.events) {
    // Only high-salience social events drive lasting adaptation.
    if (!isAdaptationTrigger(event)) continue;
    const rules = TRAIT_RULES[event.type];
    if (!rules) continue;
    for (const rule of rules) {
      const state = states[rule.trait];
      if (!state) continue;
      const step = Math.max(-MAX_ADAPTATION_STEP, Math.min(MAX_ADAPTATION_STEP, rule.delta));
      const nextAdaptation = clamp(state.adaptation + step, -ADAPTATION_CAP, ADAPTATION_CAP);
      state.adaptation = nextAdaptation;
      state.effective = clamp(state.baseline + nextAdaptation, 0, 1);
      state.lastCauses = [rule.cause(event), ...state.lastCauses].slice(0, 4);
      state.updatedAtTurn = input.turn;
      moved.push({ trait: rule.trait, state: { ...state } });
    }
  }

  // Decay unreinforced adaptation back toward baseline each pass, so a single
  // isolated outcome nudges behavior only briefly.
  const turn = input.turn;
  for (const trait of Object.keys(states) as AdaptableTrait[]) {
    const state = states[trait];
    if (turn - state.updatedAtTurn < 3) continue;
    if (Math.abs(state.adaptation) < 0.004) {
      if (state.adaptation !== 0) {
        state.adaptation = 0;
        state.effective = state.baseline;
        state.updatedAtTurn = turn;
        moved.push({ trait, state: { ...state } });
      }
      continue;
    }
    const decayed = state.adaptation * 0.85;
    state.adaptation = decayed;
    state.effective = clamp(state.baseline + decayed, 0, 1);
    state.updatedAtTurn = turn;
    moved.push({ trait, state: { ...state } });
  }

  return { states, moved };
}

/** Effective temperament with adaptations applied (never mutates the baseline). */
export function effectiveTemperament(
  temperament: AgentTemperament | undefined,
  adaptations: Record<AdaptableTrait, TraitState> | undefined
): AgentTemperament | undefined {
  if (!temperament) return undefined;
  const effective = { ...temperament };
  if (adaptations) {
    for (const trait of Object.keys(effective) as AdaptableTrait[]) {
      const state = adaptations[trait];
      if (state) effective[trait] = state.effective;
    }
  }
  return effective;
}

export function traitStatesFromTemperament(temperament: AgentTemperament | undefined, turn: number): Record<AdaptableTrait, TraitState> {
  const states: Record<AdaptableTrait, TraitState> = {} as Record<AdaptableTrait, TraitState>;
  if (!temperament) return states;
  for (const trait of Object.keys(temperament) as AdaptableTrait[]) {
    const baseline = temperament[trait];
    states[trait] = { baseline, adaptation: 0, effective: baseline, lastCauses: [], updatedAtTurn: turn };
  }
  return states;
}

/** Which event types can drive lasting adaptation at all. */
function isAdaptationTrigger(event: SocialEvent): boolean {
  return event.type in TRAIT_RULES;
}