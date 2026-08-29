/**
 * Extracted-act perception feedback (Phase 0 closed loop): a sidecar-extracted
 * social act feeds the same stack a declared act feeds — appraisal events for
 * the people concerned, the scenario hook (werewolf suspicion) — while
 * duplicates of the speaker's own declarations and low-confidence extractions
 * stay display-only. Deterministic, no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import type { SocialWorldBase } from "../../src/society/world";
import type { AgentProfile, SocialMessage } from "../../src/society/contracts";
import type { SocialActDeclaration } from "../../src/society/social/contracts";

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

function accusation(target: string, confidence: number): SocialActDeclaration {
  return {
    kind: "accusation",
    targetActorIds: [target],
    proposition: { kind: "evaluation", subjectId: target, predicate: "上一轮背叛过", object: null },
    confidence
  };
}

async function speak(world: SocialWorldBase, senderId: string, socialActs: SocialActDeclaration[]): Promise<SocialMessage> {
  // Direct send: the command-gateway epoch in performAction belongs to the
  // room's activation loop, not to these perception tests.
  return world.sendMessage({
    senderId,
    text: "你上一轮背叛了我，别装了。",
    channel: "public",
    socialActs
  });
}

it("an undeclared accusation still lands as an appraisal event once extracted", async () => {
  const world = createWorld({ roomId: "r-fb1", scenarioId: "prisoners-dilemma", profiles: profiles(2), rounds: 2 }) as SocialWorldBase;
  world.start();
  const [P1, P2] = world.snapshot().agents.map((agent) => agent.id);

  const message = await speak(world, P1, []);
  assert.equal(
    world.eventsFor(P2).filter((event) => event.type === "accused").length,
    0,
    "no declaration, no appraisal yet — perception waits for the extraction"
  );

  world.recordExtractedSocialActs(message.id, [accusation(P2, 0.9)]);
  assert.ok(
    world.eventsFor(P2).some((event) => event.type === "accused" && event.actorId === P1 && event.facts?.messageId === message.id),
    "the confident extracted accusation queues the appraisal event for its target"
  );
});

it("an extracted act duplicating the speaker's own declaration does not double-count", async () => {
  const world = createWorld({ roomId: "r-fb2", scenarioId: "prisoners-dilemma", profiles: profiles(2), rounds: 2 }) as SocialWorldBase;
  world.start();
  const [P1, P2] = world.snapshot().agents.map((agent) => agent.id);

  const message = await speak(world, P1, [accusation(P2, 1)]);
  // eventsFor drains the queue, so count in two reads: the declaration first…
  const declared = world.eventsFor(P2).filter((event) => event.type === "accused").length;
  assert.ok(declared > 0, "the declaration itself queues the appraisal");

  world.recordExtractedSocialActs(message.id, [accusation(P2, 0.95)]);
  // …and the duplicate extraction must add nothing new.
  assert.equal(
    world.eventsFor(P2).filter((event) => event.type === "accused").length,
    0,
    "the duplicate extraction is dropped — one utterance, one reaction"
  );
});

it("low-confidence extractions stay display-only", async () => {
  const world = createWorld({ roomId: "r-fb3", scenarioId: "prisoners-dilemma", profiles: profiles(2), rounds: 2 }) as SocialWorldBase;
  world.start();
  const [P1, P2] = world.snapshot().agents.map((agent) => agent.id);

  const message = await speak(world, P1, []);
  world.recordExtractedSocialActs(message.id, [accusation(P2, 0.55)]);
  assert.equal(
    world.eventsFor(P2).filter((event) => event.type === "accused").length,
    0,
    "an extraction below the feedback threshold never stirs perception"
  );
});

it("werewolf: an extracted accusation raises the public suspicion climate", async () => {
  const world = createWorld({ roomId: "r-fb4", scenarioId: "werewolf", profiles: profiles(6), rounds: 2 }) as SocialWorldBase;
  world.start();
  const agents = world.snapshot().agents.map((agent) => agent.id);
  const [P1, P2] = [agents[0]!, agents[1]!];
  assert.ok(String(world.snapshot().phase).includes("讨论"), "the first day opens with discussion");

  const before = (world.snapshot().details.suspicion as { entries?: unknown[] }).entries?.length ?? 0;
  const message = await speak(world, P1, []);
  world.recordExtractedSocialActs(message.id, [accusation(P2, 0.9)]);

  const suspicion = world.snapshot().details.suspicion as {
    entries?: Array<{ kind: string; accuser: string; target: string }>;
    scores?: Record<string, number>;
  };
  assert.ok(
    suspicion.entries?.some((entry) => entry.kind === "speech" && entry.accuser === P1 && entry.target === P2),
    "the extracted accusation enters the public suspicion ledger"
  );
  assert.ok((suspicion.scores?.[P2] ?? 0) > 0, "and the accused actually rises in the climate");
  assert.ok((suspicion.entries?.length ?? 0) > before);
});
