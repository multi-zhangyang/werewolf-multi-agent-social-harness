/**
 * Relationship modulation in the appraisal engine (Phase 3): the same act no
 * longer lands identically regardless of who did it. OCC "fortunes-of-others"
 * + trust-violation amplification, as measurable multipliers inside [0.6, 1.4]:
 *
 *  - hostile act from a warm ally → amplified anger + amplified trust cost
 *    (betrayal), from a cold rival → dampened (expected harm);
 *  - goodwill act from a warm ally → amplified gratitude but damped trust
 *    gain (marginal), from a cold rival → damped gratitude but amplified
 *    trust gain (informative reconciliation);
 *  - neutral / self events are never modulated.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { appraiseEvents } from "../../src/society/appraisal";
import { initialMood } from "../../src/society/affect";
import type { AgentMindState, AgentProfile, SocialEvent } from "../../src/society/contracts";

function profile(): AgentProfile {
  return {
    id: "agent-a",
    displayName: "甲",
    characterId: "char-a",
    persona: "test",
    traits: [],
    values: [],
    goals: [],
    // Neutral temperament: the appraisal table's own trait modulation is 1×
    // so the test isolates the relationship multipliers.
    temperament: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
    voice: "",
    regulation: "reappraise",
    model: "fake-model",
    controller: "agent"
  };
}

function mind(warmth: number | undefined): AgentMindState {
  return {
    mood: initialMood(1),
    attention: [],
    goals: [],
    beliefs: [],
    memories: [],
    relationships: warmth === undefined ? [] : [{
      targetCharacterId: "char-b",
      trust: warmth,
      affinity: warmth,
      respect: 0.5,
      tension: 0.2,
      familiarity: 0.5,
      updatedAtTurn: 1,
      note: ""
    }],
    cognitivePasses: [],
    deceptions: [],
    roleHypotheses: [],
    lastAppraisals: []
  };
}

function socialEvent(type: SocialEvent["type"]): SocialEvent {
  return {
    id: `ev-${type}`,
    type,
    turn: 1,
    phase: "讨论",
    actorId: "agent-b",
    targetId: "agent-a",
    facts: {},
    detail: `${type} event from agent-b`
  };
}

const resolveCharacterId = (actorId: string): string | undefined => (actorId === "agent-b" ? "char-b" : "char-a");

it("an accusation from a warm ally cuts deeper than the same accusation from a cold rival", () => {
  const warm = mind(0.9);
  const cold = mind(0.1);
  appraiseEvents(warm, profile(), [socialEvent("accused")], 1, undefined, resolveCharacterId);
  appraiseEvents(cold, profile(), [socialEvent("accused")], 1, undefined, resolveCharacterId);
  assert.ok(
    warm.mood.emotions.anger > cold.mood.emotions.anger,
    `ally's accusation anger ${warm.mood.emotions.anger} must exceed rival's ${cold.mood.emotions.anger}`
  );
  const warmRel = warm.relationships.find((entry) => entry.targetCharacterId === "char-b")!;
  const coldRel = cold.relationships.find((entry) => entry.targetCharacterId === "char-b")!;
  const warmDrop = 0.9 - warmRel.trust;
  const coldDrop = 0.1 - coldRel.trust;
  assert.ok(warmDrop > coldDrop, `betrayal by an ally costs more trust (ally drop ${warmDrop} > rival drop ${coldDrop})`);
  const warmTension = warmRel.tension - 0.2;
  const coldTension = coldRel.tension - 0.2;
  assert.ok(warmTension > coldTension, "betrayal by an ally raises more tension");
});

it("an accusation with no relationship history lands at the baseline", () => {
  const stranger = mind(undefined);
  appraiseEvents(stranger, profile(), [socialEvent("accused")], 1, undefined, resolveCharacterId);
  assert.ok(stranger.mood.emotions.anger > 0, "the accusation still registers");
  const relationship = stranger.relationships.find((entry) => entry.targetCharacterId === "char-b");
  assert.equal(relationship, undefined, "no relationship is invented by the modulation step");
});

it("a hostile act from a rival still drops trust — the multiplier never flips a sign", () => {
  const cold = mind(0.1);
  appraiseEvents(cold, profile(), [socialEvent("accused")], 1, undefined, resolveCharacterId);
  const relationship = cold.relationships.find((entry) => entry.targetCharacterId === "char-b")!;
  assert.ok(relationship.trust < 0.1, `rival accusation still costs trust (trust=${relationship.trust})`);
});

it("an ally's endorsement feels better but moves trust less than a rival's", () => {
  const warm = mind(0.9);
  const cold = mind(0.1);
  appraiseEvents(warm, profile(), [socialEvent("endorsed")], 1, undefined, resolveCharacterId);
  appraiseEvents(cold, profile(), [socialEvent("endorsed")], 1, undefined, resolveCharacterId);
  assert.ok(
    warm.mood.socialEmotions.gratitude > cold.mood.socialEmotions.gratitude,
    "an ally's support lands with more gratitude"
  );
  const warmGain = warm.relationships.find((entry) => entry.targetCharacterId === "char-b")!.trust - 0.9;
  const coldGain = cold.relationships.find((entry) => entry.targetCharacterId === "char-b")!.trust - 0.1;
  assert.ok(coldGain > warmGain, `cooperation from a rival is more informative (rival gain ${coldGain} > ally gain ${warmGain})`);
});

it("neutral and self events are never relationship-modulated", () => {
  const warm = mind(0.9);
  const stranger = mind(undefined);
  appraiseEvents(warm, profile(), [socialEvent("vote-cast")], 1, undefined, resolveCharacterId);
  appraiseEvents(stranger, profile(), [socialEvent("vote-cast")], 1, undefined, resolveCharacterId);
  assert.equal(warm.mood.emotions.anger, stranger.mood.emotions.anger, "self events skip the relationship multiplier");
});
