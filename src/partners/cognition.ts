import type { Action, ActorId, ActorObservation } from "./contracts";
import type { EpisodicMemory, ForecastProposal, MindState } from "./mind";
import type { PlanOperation, PlanAssessment } from "./plans";
import type { PartnerActivity } from "./agent";

/** Old identifiers are retained only for historical documents. */
export type CognitiveProtocol = "responses-v1" | "legacy-v8" | "cognitive-v1";
export interface AttentionSelection {
  policy: "state-informed" | "facts-only";
  focus: { need: string; weight: number }[];
  selectedMemoryIds: string[];
}
export interface InfluenceIntent { targetActorId: ActorId; targetBelief: "income" | "willingness" | "capability"; desiredBelief: string }
export interface PreparedCandidate {
  id: string; action: Action; expectedOutcome: string; risk: string;
  forecast: ForecastProposal | null; influence: InfluenceIntent | null;
  directConsequence: { walletChange: number; nextPhase: string; ownWallet: number };
}
export interface CognitivePreparation {
  contextId: string; eventId: string; reason: string; worldRevision: number; previousMindVersion: number; mindVersion: number;
  required: boolean;
  planOperation: PlanOperation["kind"]; planId?: string; planVersion?: number; planAssessment: PlanAssessment;
  candidates: PreparedCandidate[]; before: MindState; after: MindState;
}
export interface CognitiveReceipt {
  contextId: string; worldRevision: number; mindVersion: number | null; planId?: string; planVersion?: number;
  appraisalRequired?: boolean; appraised?: boolean;
  preparationRequired?: boolean; prepared?: boolean; basis: "plan" | "one-off" | "facts-only";
  candidateId?: string; predictionId?: string; forecast?: ForecastProposal; influence?: InfluenceIntent;
  /** Ledger comparison and a self-report are separate observations, not a deception verdict. */
  claimAudit?: { knownIncome: number; claimedIncome: number | null; mismatch: boolean | null; publiclyDisclosed: boolean };
}
export interface ShadowAppraisal {
  timing: "after-decision-before-settlement"; status: "completed" | "failed"; error?: string;
  inputTokens: number; outputTokens: number; durationMs: number; before: MindState; after?: MindState;
  /** Kept outside decision exchanges and never returned to the action-deciding session. */
  exchanges: { request: unknown; response?: unknown; error?: string }[];
  activities?: PartnerActivity[];
}

export function chooseMemories(mind: MindState, memories: EpisodicMemory[], observation: ActorObservation, masked: boolean) {
  if (masked) return { memories: [] as EpisodicMemory[], attention: { policy: "facts-only", focus: [], selectedMemoryIds: [] } as AttentionSelection };
  const visible = new Set(observation.events.map(event => event.id));
  const byId = new Map(observation.events.map(event => [event.id, event]));
  const scored = memories.filter(memory => memory.actorId === observation.actorId && memory.sourceIds.every(id => visible.has(id))).map(memory => {
    let score = 1 / (1 + Math.max(0, observation.revision - memory.revision));
    if (memory.sourceIds.some(id => mind.plan?.sourceIds.includes(id))) score += 2;
    for (const id of memory.sourceIds) {
      const event = byId.get(id)!;
      if (event.kind === "collateral" || event.kind === "settlement" && event.data.breached === true) score += mind.needs.security;
      if (event.kind === "settlement") score += mind.needs.fairness;
      if (event.kind === "repair" || event.kind === "message") score += mind.needs.affiliation;
    }
    return { memory, score };
  }).sort((a, b) => b.score - a.score || b.memory.revision - a.memory.revision).slice(0, 5).map(item => item.memory);
  return { memories: scored, attention: { policy: "state-informed", focus: Object.entries(mind.needs).map(([need, weight]) => ({ need, weight })),
    selectedMemoryIds: scored.map(memory => memory.id) } as AttentionSelection };
}
export function nextCounterpartOpportunity(observation: ActorObservation) {
  const phases = ["offer", "invest", "settle", "repair", "respond"] as const;
  const other: ActorId = observation.actorId === "a" ? "b" : "a";
  for (let round = observation.round; round <= observation.maxRounds; round++) {
    const trustee = (round - observation.round) % 2 === 0 ? observation.trustee : observation.investor;
    for (const phase of phases) {
      if (round === observation.round && phases.indexOf(phase) <= phases.indexOf(observation.phase as typeof phases[number])) continue;
      const actor = ["offer", "settle", "repair"].includes(phase) ? trustee : trustee === "a" ? "b" : "a";
      if (actor === other) return { targetActorId: other, round, action: phase,
        metric: ({ offer: "promiseRatio", invest: "amount", settle: "returnAmount", repair: "compensation", respond: "continue" } as const)[phase] };
    }
  }
  return null;
}
export function endsRelationship(action: Action) { return action.type === "exit" || action.type === "respond" && action.choice === "exit"; }
export function actionSignature(action: Action) {
  const { message: _message, intent: _intent, ...choice } = action;
  return JSON.stringify(Object.fromEntries(Object.entries(choice).sort(([a], [b]) => a.localeCompare(b))));
}
