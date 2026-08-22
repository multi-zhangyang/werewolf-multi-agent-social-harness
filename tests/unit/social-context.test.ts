/**
 * Social-context compilation (AGENTS.md §12.1 / §14.6 step 13): directed
 * relationships, relevant beliefs and open commitments must actually reach
 * the model input — not just live in the mind state. Pure function checks.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { formatSocialContext } from "../../src/society/participant";
import { initialMood } from "../../src/society/affect";
import type { AgentMindState, Commitment, SocialWorld, WorldSnapshot } from "../../src/society/contracts";
import type { SocialCausalityProjection } from "../../src/society/social/contracts";

function mind(): AgentMindState {
  return {
    mood: initialMood(1),
    attention: [],
    goals: [],
    beliefs: [
      { subjectId: "agent-02", proposition: "林默会返还至少 10", confidence: 0.62, updatedAtTurn: 1, source: "他公开承诺过" }
    ],
    memories: [],
    relationships: [{
      targetCharacterId: "char-b",
      trust: 0.7,
      affinity: 0.6,
      respect: 0.55,
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

const snapshot: WorldSnapshot = {
  roomId: "r",
  scenarioId: "trust-game",
  title: "信任博弈",
  status: "running",
  turn: 1,
  totalTurns: 2,
  phase: "协商",
  summary: "s",
  agents: [
    { id: "agent-01", displayName: "苏遥", characterId: "char-a", status: "idle", alive: true },
    { id: "agent-02", displayName: "林默", characterId: "char-b", status: "idle", alive: true }
  ],
  messages: [],
  log: [],
  details: {}
};

const commitment: Commitment = {
  commitmentId: "commit:1:agent-02:1",
  round: 1,
  promisorActorId: "agent-02",
  promisorCharacterId: "char-b",
  audienceActorIds: ["agent-01", "agent-02"],
  proposition: "你投 8，我至少返还 10。",
  promisedAction: { actionType: "return-at-least", amount: 10 },
  state: "proposed",
  createdAtTurn: 1,
  schemaVersion: 1
};

const emptyCausality = {
  schemaVersion: 6,
  lastSequence: 0,
  events: [],
  propositions: [],
  socialActs: [],
  evidence: [],
  beliefUpdates: [],
  actorModels: [],
  directedRelationships: [],
  relationshipDeltas: [],
  commitments: [],
  candidateIntents: [],
  strategyProfileSnapshots: [],
  activeStrategyProfileSnapshotIds: {},
  strategySelections: [],
  decisions: [],
  influenceLinks: [],
  outcomeReconciliations: [],
  deceptions: []
} as unknown as SocialCausalityProjection;

const world = {
  snapshot: () => snapshot,
  openCommitmentsFor: (actorId: string) => (actorId === "agent-01" || actorId === "agent-02" ? [commitment] : []),
  socialCausalityFor: () => emptyCausality
} as unknown as SocialWorld;

it("compiles directed relationships, beliefs and open commitments into the turn input", () => {
  const blocks = formatSocialContext(mind(), world, "agent-01");
  const text = blocks.join("\n");
  assert.ok(text.includes("[SOCIAL STATE]"), "blocks carry the social-state marker");
  assert.ok(text.includes("林默: trust 0.70"), "the directed relationship reaches the input");
  assert.ok(text.includes("林默会返还至少 10 · probability 0.62 · confidence 0.62"), "the relevant belief reaches the input");
  assert.ok(
    text.includes("林默 declared: 你投 8，我至少返还 10。 · proposed"),
    "the open commitment reaches the input with its promisor and state"
  );
});

it("stays honest when the mind and world carry nothing", () => {
  const emptyMind = { ...mind(), relationships: [], beliefs: [] };
  const emptyWorld = {
    snapshot: () => ({ ...snapshot, agents: [snapshot.agents[0]] }),
    openCommitmentsFor: () => [],
    socialCausalityFor: () => emptyCausality
  } as unknown as SocialWorld;
  const blocks = formatSocialContext(emptyMind, emptyWorld, "agent-01");
  assert.deepEqual(blocks, [], "no invented state is injected");
});