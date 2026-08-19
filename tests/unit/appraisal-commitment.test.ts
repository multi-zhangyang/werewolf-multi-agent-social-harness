/**
 * Appraisal branches for the trust-game commitment slice (AGENTS.md §14.6
 * step 11 / §10.2): a violated promise must leave a traceable relationship
 * delta (before/after on trust, tension, a note citing the event) and an
 * appraisal note with the cause. Pure deterministic check on appraiseEvents.
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
    temperament: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
    voice: "",
    regulation: "suppress",
    model: "fake-model",
    controller: "agent"
  };
}

function mind(): AgentMindState {
  return {
    mood: initialMood(1),
    attention: [],
    goals: [],
    beliefs: [],
    relationships: [{
      targetCharacterId: "char-b",
      trust: 0.7,
      affinity: 0.6,
      respect: 0.6,
      tension: 0.2,
      familiarity: 0.5,
      updatedAtTurn: 1,
      note: ""
    }],
    memories: [],
    cognitivePasses: [],
    deceptions: [],
    roleHypotheses: [],
    lastAppraisals: []
  };
}

function event(type: SocialEvent["type"], detail: string): SocialEvent {
  return {
    id: `ev-${type}`,
    type,
    turn: 1,
    phase: "返还",
    actorId: "agent-b",
    targetId: "agent-a",
    facts: { commitmentId: "commit:1", promised: 10, actual: 0 },
    detail
  };
}

const resolveCharacterId = (actorId: string): string | undefined => (actorId === "agent-b" ? "char-b" : "char-a");

it("a violated promise drops trust and raises tension with a citable note", () => {
  const state = mind();
  const summary = appraiseEvents(
    state,
    profile(),
    [event("commitment-violated", "承诺破裂：agent-b 承诺「返还至少 10」，实际只有 0。")],
    1,
    undefined,
    resolveCharacterId
  );
  const relationship = state.relationships.find((entry) => entry.targetCharacterId === "char-b");
  assert.ok(relationship, "the directed relationship exists");
  assert.equal(relationship!.trust, 0.7 - 0.25, "trust dropped by the violation delta");
  assert.equal(relationship!.tension, 0.2 + 0.2, "tension rose by the violation delta");
  assert.ok(relationship!.note.includes("承诺破裂"), "the note cites the violation");
  assert.ok(state.lastAppraisals.some((note) => note.text.includes("承诺破裂")), "the appraisal note records the cause");
  assert.equal(summary.changed, true, "the appraisal reports a real change");
});

it("a fulfilled promise raises trust and records the kept promise", () => {
  const state = mind();
  appraiseEvents(
    state,
    profile(),
    [event("commitment-fulfilled", "承诺兑现：agent-b 承诺「返还至少 10」，实际 10。")],
    1,
    undefined,
    resolveCharacterId
  );
  const relationship = state.relationships.find((entry) => entry.targetCharacterId === "char-b")!;
  assert.equal(relationship.trust, 0.7 + 0.12, "trust rose by the fulfillment delta");
  assert.ok(state.lastAppraisals.some((note) => note.text.includes("承诺兑现")), "the kept promise is recorded");
});

it("a declaration alone moves no relationship — nothing has been kept yet", () => {
  const state = mind();
  appraiseEvents(
    state,
    profile(),
    [event("commitment-proposed", "agent-b 公开承诺：返还至少 10。")],
    1,
    undefined,
    resolveCharacterId
  );
  const relationship = state.relationships.find((entry) => entry.targetCharacterId === "char-b")!;
  assert.equal(relationship.trust, 0.7, "a promise is only a claim until it settles");
});