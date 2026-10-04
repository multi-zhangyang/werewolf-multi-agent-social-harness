import { z } from "zod";
import type { ActorId, ActorObservation, WorldEvent } from "./contracts";
import { planContentSchema, type Plan, type PlanLifecycleEvent } from "./plans";

export type PsychologyMode = "hybrid" | "no-inertia" | "off";
const unit = z.number().min(0).max(1);
export const emotionSchema = z.object({ anger: unit, anxiety: unit, guilt: unit, hope: unit }).strict();
export type Emotions = z.infer<typeof emotionSchema>;
export const baselineEmotions: Emotions = { anger: 0.05, anxiety: 0.15, guilt: 0.05, hope: 0.5 };
const planSchema = planContentSchema;
const beliefSchema = z.object({
  willingness: unit, capability: unit, interpretation: z.string().min(1).max(360),
  alternative: z.string().min(1).max(360),
}).strict();
export const forecastSchema = z.object({
  targetActorId: z.enum(["a", "b"]), round: z.number().int().min(1).max(12),
  action: z.enum(["offer", "invest", "settle", "repair", "respond"]),
  metric: z.enum(["promiseRatio", "collateral", "amount", "returnAmount", "compensation", "continue"]),
  threshold: z.number().min(0).max(1000), probability: unit,
}).strict();
export type ForecastProposal = z.infer<typeof forecastSchema>;
export interface Forecast extends ForecastProposal {
  id: string; createdRevision: number; sourceIds: string[];
  status: "pending" | "scored" | "unscored";
  observed?: number; outcome?: boolean; brier?: number; evidenceId?: string; reason?: string;
}
export interface EpisodicMemory {
  id: string; actorId: ActorId; kind: "experience" | "interpretation";
  text: string; sourceIds: string[]; revision: number; supersedes?: string;
}
export type PartnerMemory = EpisodicMemory;
export type PlanConsistency = "consistent" | "no-active-plan" | "active-plan-present" | "no-recorded-revision" | "no-recorded-abandonment";
export interface PlanDecision {
  disposition: "continue" | "revise" | "abandon" | "no-plan" | "create" | "satisfy" | "one-off";
  reason: string; sourceIds: string[]; revision: number; planVersion: number;
  /** Audit only: a mismatch never changes the formal plan or rejects a legal action. */
  consistency?: PlanConsistency;
}
export interface MindState {
  schemaVersion: 1 | 2; version: number; actorId: ActorId; lastRevision: number;
  emotions: Emotions; needs: { security: number; fairness: number; affiliation: number };
  privateGoal: string; conflict: string;
  relationship: z.infer<typeof beliefSchema> & { sourceIds: string[] };
  plan: (z.infer<typeof planSchema> & { sourceIds: string[]; revision: number }) | null;
  regulation: "none" | "reappraise" | "suppress_expression" | "ruminate" | "repair";
  expression: string;
  predictions: Forecast[]; processedEvidenceIds: string[];
  changes: { revision: number; version: number; eventId: string; sourceIds: string[]; reason: string }[];
  lastDecision?: PlanDecision;
  /** Latest observation window deliberately appraised by the actor; distinct from passive game-time decay. */
  lastAppraisalRevision?: number;
  planHistory?: Plan[];
  planEvents?: PlanLifecycleEvent[];
}
export type PartnerMind = MindState;

/** Nullable fields mean retain the previous value; models propose deltas, never a replacement mind. */
export const mindDeltaSchema = z.object({
  eventId: z.string().min(1), sourceIds: z.array(z.string()).min(1).max(8),
  reason: z.string().min(1).max(400),
  emotions: emotionSchema.nullable(),
  needs: z.object({ security: unit, fairness: unit, affiliation: unit }).strict().nullable(),
  relationship: beliefSchema.nullable(), plan: planSchema.nullable(),
  conflict: z.string().max(280).nullable(),
  regulation: z.enum(["none", "reappraise", "suppress_expression", "ruminate", "repair"]).nullable(),
  expression: z.string().max(240).nullable(),
  predictions: z.array(forecastSchema).max(2),
  memory: z.string().max(400).nullable(),
}).strict();
export type MindDelta = z.infer<typeof mindDeltaSchema>;

export function createMind(actorId: ActorId, privateGoal: string, revision = 0): MindState {
  return { schemaVersion: 1, version: 0, actorId, lastRevision: revision,
    emotions: { ...baselineEmotions }, needs: { security: 0.5, fairness: 0.5, affiliation: 0.5 },
    privateGoal, conflict: "", relationship: { willingness: 0.5, capability: 0.5,
      interpretation: "尚未形成判断", alternative: "需要更多可见证据", sourceIds: [] },
    plan: null, regulation: "none", expression: "", predictions: [], processedEvidenceIds: [], changes: [] };
}
export const defaultMind = createMind;

/** Game revisions, not wall clock, govern decay. Relationship/needs/intentions do not passively reset. */
export function advanceMind(state: MindState, revision: number, mode: PsychologyMode = "hybrid"): MindState {
  if (revision <= state.lastRevision || mode === "off") return structuredClone(state);
  const next = structuredClone(state);
  if (mode === "hybrid") {
    const retention = Math.pow(0.9, revision - state.lastRevision);
    for (const key of Object.keys(baselineEmotions) as (keyof Emotions)[])
      next.emotions[key] = round(baselineEmotions[key] + (state.emotions[key] - baselineEmotions[key]) * retention);
  }
  next.lastRevision = revision;
  next.version++;
  return next;
}
function round(value: number) { return Math.round(value * 1000000) / 1000000; }

export function reduceMind(previous: MindState, proposal: MindDelta, observation: ActorObservation, mode: PsychologyMode = "hybrid"): MindState {
  if (mode === "off") throw new Error("心理模块已关闭");
  if (previous.actorId !== observation.actorId) throw new Error("心理状态不属于当前人物");
  const delta = mindDeltaSchema.parse(proposal);
  const visible = new Set(observation.events.map(event => event.id));
  if (![delta.eventId, ...delta.sourceIds].every(id => visible.has(id))) throw new Error("心理评价引用了不可见或不存在的事件");
  if (!delta.sourceIds.includes(delta.eventId)) throw new Error("sourceIds 必须包含本次评价的 eventId");
  const next = advanceMind(previous, observation.revision, mode);
  // Repeating an event is a read, not an additional emotional stimulus.
  if (next.processedEvidenceIds.includes(delta.eventId)) return next;
  if (delta.emotions) for (const key of Object.keys(baselineEmotions) as (keyof Emotions)[]) {
    next.emotions[key] = round(mode === "hybrid" ? next.emotions[key] * 0.6 + delta.emotions[key] * 0.4 : delta.emotions[key]);
  }
  if (delta.needs) next.needs = { ...delta.needs };
  if (delta.relationship) next.relationship = { ...delta.relationship, sourceIds: [...delta.sourceIds] };
  if (delta.plan) next.plan = { ...delta.plan, sourceIds: [...delta.sourceIds], revision: observation.revision };
  if (delta.conflict !== null) next.conflict = delta.conflict;
  if (delta.regulation !== null) next.regulation = delta.regulation;
  if (delta.expression !== null) next.expression = delta.expression;
  for (const prediction of delta.predictions) {
    validateForecast(prediction, observation);
    // Revisions of the same forecast remain separate preregistered estimates.
    next.predictions.push({ ...prediction, id: `${observation.worldId}:${observation.actorId}:p${next.predictions.length + 1}`,
      createdRevision: observation.revision, sourceIds: [...delta.sourceIds], status: "pending" });
  }
  next.processedEvidenceIds.push(delta.eventId);
  next.lastAppraisalRevision = observation.revision;
  next.version++;
  next.changes.push({ revision: observation.revision, version: next.version, eventId: delta.eventId, sourceIds: [...delta.sourceIds], reason: delta.reason });
  return next;
}

const metricForAction: Record<ForecastProposal["action"], ForecastProposal["metric"][]> = {
  offer: ["promiseRatio", "collateral"], invest: ["amount"], settle: ["returnAmount"], repair: ["compensation"], respond: ["continue"],
};
const phaseOrder = ["offer", "invest", "settle", "repair", "respond", "finished"];
function validateForecast(prediction: ForecastProposal, observation: ActorObservation) {
  if (prediction.targetActorId === observation.actorId) throw new Error("预测应指向对方未来的行为");
  if (!metricForAction[prediction.action].includes(prediction.metric)) throw new Error("预测行动与指标不匹配");
  if (prediction.round > observation.maxRounds || prediction.round < observation.round ||
      prediction.round === observation.round && phaseOrder.indexOf(prediction.action) < phaseOrder.indexOf(observation.phase))
    throw new Error("不能给已经结束的机会或不存在的轮次补写预测");
  const trustee = prediction.round % 2 === observation.round % 2 ? observation.trustee : observation.investor;
  const responsible = ["offer", "settle", "repair"].includes(prediction.action) ? trustee : trustee === "a" ? "b" : "a";
  if (responsible !== prediction.targetActorId) throw new Error("该人物在目标轮次没有预测的行动角色");
  if (["promiseRatio", "continue"].includes(prediction.metric) && prediction.threshold > 1) throw new Error("比例/继续合作指标的阈值必须在 0 到 1 之间");
}

export function addForecast(previous: MindState, proposal: ForecastProposal, observation: ActorObservation, sourceId: string): MindState {
  if (previous.actorId !== observation.actorId) throw new Error("心理状态不属于当前人物");
  if (!observation.events.some(event => event.id === sourceId)) throw new Error("预测来源必须是自己可见的事件");
  const prediction = forecastSchema.parse(proposal);
  validateForecast(prediction, observation);
  const next = structuredClone(previous);
  next.predictions.push({ ...prediction, id: `${observation.worldId}:${observation.actorId}:p${next.predictions.length + 1}`,
    createdRevision: observation.revision, sourceIds: [sourceId], status: "pending" });
  next.version++;
  return next;
}

function observedValue(prediction: Forecast, event: WorldEvent): number | undefined {
  const kind = { offer: "offer", invest: "investment", settle: "settlement", repair: "repair", respond: "response" }[prediction.action];
  if (event.kind !== kind || event.actor !== prediction.targetActorId || event.round !== prediction.round) return undefined;
  if (prediction.metric === "continue") return event.data.choice === "continue" ? 1 : event.data.choice === "exit" ? 0 : undefined;
  const value = event.data[prediction.metric];
  return typeof value === "number" ? value : undefined;
}

/** Scoring feeds the next actor input. Missing/skipped opportunities are not fabricated negative outcomes. */
export function resolvePredictions(previous: MindState, observation: ActorObservation): MindState {
  const next = structuredClone(previous);
  let changed = false;
  for (const prediction of next.predictions) {
    if (prediction.status !== "pending") continue;
    const event = observation.events.find(event => event.revision > prediction.createdRevision && observedValue(prediction, event) !== undefined);
    if (event) {
      const observed = observedValue(prediction, event)!;
      const outcome = observed >= prediction.threshold;
      Object.assign(prediction, { status: "scored", observed, outcome, brier: round((prediction.probability - Number(outcome)) ** 2), evidenceId: event.id });
      changed = true;
    } else if (observation.finishReason || observation.round > prediction.round ||
      observation.round === prediction.round && phaseOrder.indexOf(observation.phase) > phaseOrder.indexOf(prediction.action)) {
      Object.assign(prediction, { status: "unscored", reason: "目标机会未发生，或结果对当前人物不可判定" });
      changed = true;
    }
  }
  if (changed) next.version++;
  return next;
}

export function assessmentTriggers(state: MindState, observation: ActorObservation): string[] {
  const unprocessed = observation.events.filter(event => !state.processedEvidenceIds.includes(event.id));
  const triggers: string[] = [];
  if (!state.plan || state.plan.status !== "active") triggers.push("尚无持续计划，可以确立目标与下一步条件");
  if (unprocessed.some(event => event.kind === "collateral" && event.data.breached === true)) triggers.push("出现违约证据，需要区分能力与意愿");
  if (unprocessed.some(event => event.kind === "repair" && Number(event.data.compensation) > 0)) triggers.push("发生真实补偿，可检验或修订旧计划");
  if (state.predictions.some(prediction => prediction.status === "scored" && (prediction.brier ?? 0) >= 0.36 &&
    prediction.evidenceId && !state.processedEvidenceIds.includes(prediction.evidenceId))) triggers.push("行为预测出现明显误差");
  return triggers;
}
