/**
 * Flat binding-tool contract (post strategy-form refactor): every scenario's
 * world tools are plain typed actions. The strategy-decision form — candidate
 * intents, a selected-intent index, predicted consequences and reference lists
 * for evidence/belief/actor-model/relationship ids — must not reappear in any
 * binding tool's parameters JSON schema. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld, SCENARIO_METADATA } from "../../src/society/scenarios";
import type { AgentProfile, SocialWorld } from "../../src/society/contracts";

/** Fields of the deleted strategy form that must never resurface in a tool schema. */
const BANNED_STRATEGY_FIELDS = [
  "candidateIntents",
  "selectedIntentIndex",
  "predictedConsequences",
  "referencedEvidenceIds",
  "referencedBeliefIds",
  "referencedActorModelIds",
  "referencedRelationshipIds"
] as const;

/** Minimal seat roster helper (same shape as tests/contract/werewolf-rules.test.ts). */
function profiles(count: number): AgentProfile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `agent-${String(index + 1).padStart(2, "0")}`,
    displayName: `P${index + 1}`,
    characterId: `char-test-${index + 1}`,
    persona: "test",
    traits: [],
    values: [],
    goals: [],
    temperament: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
    voice: "",
    regulation: "suppress",
    model: "fake-model",
    controller: "agent"
  }));
}

interface FlatToolShape {
  name: string;
  parameters: unknown;
}

function toolsJson(world: SocialWorld, actorId: string): Array<{ name: string; parametersJson: string }> {
  const tools = world.toolsFor(actorId) as unknown as FlatToolShape[];
  assert.ok(tools.length > 0, `actor ${actorId} has binding tools`);
  return tools.map((tool) => ({ name: tool.name, parametersJson: JSON.stringify(tool.parameters ?? {}) }));
}

it("no binding tool in any of the 13 scenarios exposes a strategy-form field", () => {
  const scenarioIds = Object.keys(SCENARIO_METADATA);
  assert.equal(scenarioIds.length, 13, "all 13 scenarios are covered");
  for (const scenarioId of scenarioIds) {
    const metadata = SCENARIO_METADATA[scenarioId as keyof typeof SCENARIO_METADATA];
    const seatCount = metadata.playerRange?.min ?? metadata.players;
    const world = createWorld({
      roomId: `r-flat-${scenarioId}`,
      scenarioId: scenarioId as keyof typeof SCENARIO_METADATA,
      profiles: profiles(seatCount),
      rounds: metadata.minRounds
    });
    world.start();
    const actorId = world.snapshot().agents[0].id;
    const tools = toolsJson(world, actorId);
    for (const { name, parametersJson } of tools) {
      for (const banned of BANNED_STRATEGY_FIELDS) {
        assert.ok(
          !parametersJson.includes(`"${banned}"`),
          `${scenarioId} tool ${name} must not expose "${banned}" in its parameters schema`
        );
      }
    }
  }
});

it("binding tools keep their flat typed payloads (amount/reason style), not nested strategy blocks", () => {
  // Spot-check every scenario: each binding tool's parameters schema is a
  // shallow flat object of primitive fields — never a nested object block.
  const scenarioIds = Object.keys(SCENARIO_METADATA);
  for (const scenarioId of scenarioIds) {
    const metadata = SCENARIO_METADATA[scenarioId as keyof typeof SCENARIO_METADATA];
    const seatCount = metadata.playerRange?.min ?? metadata.players;
    const world = createWorld({
      roomId: `r-flat2-${scenarioId}`,
      scenarioId: scenarioId as keyof typeof SCENARIO_METADATA,
      profiles: profiles(seatCount),
      rounds: metadata.minRounds
    });
    world.start();
    const actorId = world.snapshot().agents[0].id;
    for (const { name, parametersJson } of toolsJson(world, actorId)) {
      const schema = JSON.parse(parametersJson) as { properties?: Record<string, { type?: string; properties?: unknown }> };
      const properties = schema.properties ?? {};
      const nested = Object.entries(properties).filter(([, field]) => field.type === "object" || field.properties !== undefined);
      assert.equal(
        nested.length,
        0,
        `${scenarioId} tool ${name} must stay flat (no nested object blocks: ${nested.map(([key]) => key).join(", ") || "none"})`
      );
    }
  }
});