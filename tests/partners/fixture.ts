import { randomUUID } from "node:crypto";
import type { Action } from "../../src/partners/contracts";
import type { PartnerDecisionInput, PartnerDecisionResult, PartnerParticipant } from "../../src/partners/agent";
import { createMind } from "../../src/partners/mind";
import { observeWorld } from "../../src/partners/world";

/** Deterministic infrastructure fixture, never live-model or personality evidence. */
export function fixtureDecision(input: PartnerDecisionInput): PartnerDecisionResult {
  const o = observeWorld(input.world, input.actorId);
  let action: Action;
  switch (o.phase) {
    case "offer": action = { type: "offer", promiseRatio: 0.5, collateral: Math.min(2, o.self.wallet), message: "收益对半分，我先放两份担保。" }; break;
    case "invest": action = { type: "invest", amount: Math.min(6, o.self.wallet), message: "先做一笔。" }; break;
    case "settle": action = { type: "settle", returnAmount: Math.min(o.self.wallet, Math.ceil((o.deal.grossIncome ?? 0) / 2)), revealIncome: true, message: "按约定，这是你的份额。" }; break;
    case "repair": action = { type: "repair", compensation: 0 }; break;
    case "respond": action = { type: "respond", choice: "continue" }; break;
    default: throw new Error("fixture has no action");
  }
  const mind = structuredClone(input.mind ?? createMind(input.actorId, o.self.privateObjective));
  return { action, mind, memories: input.memories ?? [], sessionItems: [], decisionCase: {
    id: randomUUID(), worldId: input.world.id, actorId: input.actorId, revision: o.revision, createdAt: new Date().toISOString(),
    sourceHash: "fixture-not-model-evidence", harnessVersion: "test-fixture", observation: o, before: mind, after: mind,
    configuration: { fixture: true }, exchanges: [], activities: [], status: "completed", action,
    inputTokens: 0, outputTokens: 0, durationMs: 0, retries: 0, failures: 0,
  } };
}
export const fixtureParticipant = (): PartnerParticipant => ({ configuration: { fixture: true }, async decide(input) { return fixtureDecision(input); } });
