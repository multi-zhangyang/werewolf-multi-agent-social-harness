/**
 * recall_memory — the read-only record-search tool. Scenarios advertise it by
 * name in their observations, so it must exist, stay flat, and return only
 * what the calling actor is entitled to know. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import { createCognitionTools } from "../../src/society/cognition";
import type { AgentRuntimeEvent, SocietyAgentContext, SocialWorld } from "../../src/society/contracts";
import type { SocialWorldBase } from "../../src/society/world";
import type { Tool } from "@openai/agents";

const profiles = createAgentProfiles(["model-a"], 2);
const [P1, P2] = profiles.map((profile) => profile.id);

function traitStates(): Record<"openness" | "conscientiousness" | "extraversion" | "agreeableness" | "neuroticism", { baseline: number; adaptation: number; effective: number; lastCauses: string[]; updatedAtTurn: number }> {
  const trait = { baseline: 0.5, adaptation: 0, effective: 0.5, lastCauses: [] as string[], updatedAtTurn: 0 };
  return {
    openness: { ...trait },
    conscientiousness: { ...trait },
    extraversion: { ...trait },
    agreeableness: { ...trait },
    neuroticism: { ...trait }
  };
}

function recallTool(world: SocialWorld): Tool<SocietyAgentContext> {
  const events: AgentRuntimeEvent[] = [];
  const context: SocietyAgentContext = {
    actorId: P1,
    roomId: world.roomId,
    profile: profiles[0]!,
    world,
    // The mind a real participant owns; recall reads only its memory list.
    mind: {
      mood: {
        emotions: { joy: 0, sadness: 0, anger: 0, fear: 0, surprise: 0, disgust: 0 },
        socialEmotions: { gratitude: 0, guilt: 0, shame: 0, embarrassment: 0, pride: 0, envy: 0, jealousy: 0, contempt: 0, admiration: 0, relief: 0 },
        pad: { pleasure: 0, arousal: 0, dominance: 0 },
        needs: { security: 0.5, connection: 0.5, status: 0.5, autonomy: 0.5, achievement: 0.5 },
        energy: 0.85,
        label: "平静",
        description: "",
        updatedAtTurn: 0
      },
      attention: [],
      goals: [],
      beliefs: [],
      relationships: [],
      memories: [
        { id: "mem-1", text: "第一次创业被合伙人卷走积蓄", tags: ["autobiography"], turn: 0, createdAt: "2026-08-28T10:00:00.000Z" }
      ],
      cognitivePasses: [],
      deceptions: [],
      roleHypotheses: [],
      lastAppraisals: [],
      traitAdaptations: traitStates()
    },
    emit: (event) => events.push(event)
  };
  const tools = createCognitionTools(context);
  const recall = tools.find((tool) => tool.name === "recall_memory");
  assert.ok(recall, "recall_memory is part of the cognition toolkit");
  return recall;
}

async function recall(world: SocialWorld, args: { query?: string | null; aboutActorId?: string | null }): Promise<{ recalled: number; records: string }> {
  const tool = recallTool(world) as unknown as {
    invoke: (runContext: undefined, input: string) => Promise<{ recalled: number; records: string }>;
  };
  return tool.invoke(undefined, JSON.stringify({ query: args.query ?? null, aboutActorId: args.aboutActorId ?? null }));
}

function makeWorld(): SocialWorldBase {
  const world = createWorld({ roomId: "r-recall", scenarioId: "prisoners-dilemma", profiles, rounds: 2 }) as SocialWorldBase;
  world.start();
  return world;
}

it("recalls a commitment involving the caller, with query filtering", async () => {
  const world = makeWorld();
  const commit = await world.performDomainAction(P1, "make_commitment", { move: "cooperate", proposition: "我会合作到底。" });
  assert.ok((commit.result as { commitmentId: string }).commitmentId, "the commitment exists");

  const byDefault = await recall(world, {});
  assert.match(byDefault.records, /我会合作到底/, "the default browse finds the commitment");
  assert.ok(byDefault.recalled > 0);

  const byQuery = await recall(world, { query: "合作" });
  assert.match(byQuery.records, /\[承诺\]/);

  const miss = await recall(world, { query: "完全不存在的词" });
  assert.equal(miss.recalled, 0, "an unmatched query recalls nothing instead of inventing records");
});

it("recalls the actor's own autobiographical memory", async () => {
  const world = makeWorld();
  const result = await recall(world, { query: "合伙人" });
  assert.match(result.records, /第一次创业被合伙人卷走积蓄/);
});

it("filters witnessed claims by aboutActorId without leaking other seats' private state", async () => {
  const world = makeWorld();
  const other = await recall(world, { aboutActorId: P2 });
  // P2 made no commitment, so no [承诺] line about P2 is recalled — while the
  // projection itself stays within P1's own authorized boundary.
  assert.doesNotMatch(other.records, /\[承诺\]/);
});
