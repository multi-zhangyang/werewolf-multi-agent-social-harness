/**
 * Mood-aware discussion personality (Phase 3): the director's per-agent
 * signals must read the world's mood mirror — adapted temperament instead
 * of the static baseline, current PAD mood nudging talkativeness, dominance
 * and sensitivity — and fall back to the profile baseline when no signal
 * has been pushed yet.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { discussionPersonality } from "../../src/society/scenarios/helpers";
import type { AgentProfile, MoodSignal } from "../../src/society/contracts";

const profile: AgentProfile = {
  id: "agent-a",
  displayName: "甲",
  characterId: "char-a",
  persona: "test",
  traits: [],
  values: [],
  goals: [],
  temperament: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.6, agreeableness: 0.5, neuroticism: 0.4 },
  voice: "",
  model: "fake-model",
  controller: "agent"
};

const profiles = new Map([[profile.id, profile]]);

function signal(overrides: Partial<MoodSignal>): MoodSignal {
  return {
    pleasure: 0.5,
    arousal: 0.5,
    dominance: 0.5,
    extraversion: 0.6,
    neuroticism: 0.4,
    conscientiousness: 0.5,
    ...overrides
  };
}

it("without a mood signal the baseline temperament is used unchanged", () => {
  const personality = discussionPersonality(profiles);
  assert.equal(personality.talkativeness("agent-a"), 0.6);
  assert.equal(personality.sensitivity("agent-a"), 0.4);
});

it("the signal's adapted temperament replaces the static baseline", () => {
  const personality = discussionPersonality(profiles, () => signal({ extraversion: 0.8, neuroticism: 0.55 }));
  assert.equal(personality.talkativeness("agent-a"), 0.8, "neutral mood passes the adapted extraversion through");
  assert.ok(personality.sensitivity("agent-a") > 0.5, "adapted neuroticism (0.55, baseline 0.4) drives sensitivity");
});

it("an agitated, pleased agent speaks up; a deflated one goes quiet", () => {
  const up = discussionPersonality(profiles, () => signal({ pleasure: 0.9, arousal: 0.9 }));
  const down = discussionPersonality(profiles, () => signal({ pleasure: 0.1, arousal: 0.1 }));
  assert.ok(up.talkativeness("agent-a") > 0.6, "aroused and pleased raises talkativeness above baseline");
  assert.ok(down.talkativeness("agent-a") < 0.6, "deflated lowers talkativeness below baseline");
});

it("distress sharpens sensitivity; felt command raises dominance", () => {
  const distressed = discussionPersonality(profiles, () => signal({ pleasure: 0.1, dominance: 0.9 }));
  assert.ok(distressed.sensitivity("agent-a") > 0.4, "low pleasure sharpens the sting of being targeted");
  assert.ok(distressed.dominance("agent-a") > 0.5 + (0.6 - 0.5) * 0.6, "high PAD dominance adds force of voice");
});
