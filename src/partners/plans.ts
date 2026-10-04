import { z } from "zod";
import type { ActorObservation, Phase } from "./contracts";
import type { MindState } from "./mind";

const stages = ["offer", "invest", "settle", "repair", "respond"] as const;
export const planStatusSchema = z.enum(["active", "needs-review", "satisfied", "abandoned", "expired"]);
export const planConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("own-wallet-at-least"), amount: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("own-obligation-paid"), amount: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("visible-return-at-least"), round: z.number().int().min(1), amount: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("collateral-at-least"), round: z.number().int().min(1), amount: z.number().int().min(0) }).strict(),
]);
export const planScopeSchema = z.object({
  role: z.enum(["investor", "trustee", "any"]), fromRound: z.number().int().min(1), throughRound: z.number().int().min(1),
  phases: z.array(z.enum(stages)).min(1).max(5),
}).strict().refine(scope => scope.throughRound >= scope.fromRound, "计划结束轮次不能早于开始轮次");
const words = { aim: z.string().min(1).max(240), nextStep: z.string().min(1).max(240),
  continueWhen: z.string().min(1).max(240), reviseWhen: z.string().min(1).max(240), abandonWhen: z.string().min(1).max(240) };
export const planContentSchema = z.object({ ...words, status: planStatusSchema,
  id: z.string().optional(), version: z.number().int().min(1).optional(), scope: planScopeSchema.optional(),
  conditions: z.array(planConditionSchema).max(4).optional(), success: planConditionSchema.nullable().optional(),
}).strict();
export const planDraftSchema = z.object({ aim: words.aim, nextStep: words.nextStep,
  continueWhen: words.continueWhen.default("参见可执行范围与前提"), reviseWhen: words.reviseWhen.default("前提变化时重新考虑"),
  abandonWhen: words.abandonWhen.default("由人物主动决定"), scope: planScopeSchema, conditions: z.array(planConditionSchema).max(4).default([]),
  success: planConditionSchema.nullable().default(null) }).strict();
export type Plan = z.infer<typeof planContentSchema> & { sourceIds: string[]; revision: number };
export type PlanCondition = z.infer<typeof planConditionSchema>;
export type PlanScope = z.infer<typeof planScopeSchema>;
const existingPlanOperations = [
  z.object({ kind: z.literal("keep"), version: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("abandon"), version: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("satisfy"), version: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("act-once") }).strict(),
] as const;
export const planOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), plan: planDraftSchema }).strict(),
  z.object({ kind: z.literal("revise"), version: z.number().int().min(0), plan: planDraftSchema }).strict(),
  ...existingPlanOperations,
]);
export type PlanOperation = z.infer<typeof planOperationSchema>;
/** Public tool contract uses one plan object; persistence keeps its established operation shape. */
export const planOperationWireSchema = z.discriminatedUnion("kind", [
  planDraftSchema.extend({ kind: z.literal("create") }).strict(),
  planDraftSchema.extend({ kind: z.literal("revise"), version: z.number().int().min(0) }).strict(),
  ...existingPlanOperations,
]);
export function canonicalPlanOperation(raw: z.infer<typeof planOperationWireSchema>): PlanOperation {
  if (raw.kind === "create") { const { kind, ...plan } = raw; return { kind, plan }; }
  if (raw.kind === "revise") { const { kind, version, ...plan } = raw; return { kind, version, plan }; }
  return raw;
}
export interface PlanLifecycleEvent {
  revision: number; planId?: string; planVersion: number; from: Plan["status"] | "none"; to: Plan["status"];
  reason: string; sourceIds: string[]; origin: "rules" | "actor";
}
export interface PlanAssessment { applicable: boolean; needsReview: boolean; reasons: string[]; remainingOpportunities: { round: number; role: string; phase: Phase }[] }

/** This schedule contains possible opportunities, never predictions of another actor's choices. */
export function ownOpportunities(observation: ActorObservation) {
  if (observation.phase === "finished") return [];
  const result: { round: number; role: "investor" | "trustee"; phase: typeof stages[number] }[] = [];
  for (let round = observation.round; round <= observation.maxRounds; round++) {
    const trustee = (round - observation.round) % 2 === 0 ? observation.trustee : observation.investor;
    const role = trustee === observation.actorId ? "trustee" : "investor";
    for (const phase of stages) if ((round > observation.round || stages.indexOf(phase) >= stages.indexOf(observation.phase)) &&
      (role === "trustee" ? ["offer", "settle", "repair"].includes(phase) : ["invest", "respond"].includes(phase))) result.push({ round, role, phase });
  }
  return result;
}
function inScope(scope: PlanScope, opportunity: { round: number; role: string; phase: Phase }) {
  return opportunity.round >= scope.fromRound && opportunity.round <= scope.throughRound && (scope.role === "any" || scope.role === opportunity.role) &&
    scope.phases.includes(opportunity.phase as typeof stages[number]);
}
export function evaluatePlanCondition(condition: PlanCondition, observation: ActorObservation): "true" | "false" | "unknown" {
  if (condition.kind === "own-wallet-at-least") return observation.self.wallet >= condition.amount ? "true" : "false";
  if (condition.kind === "own-obligation-paid") return observation.self.obligationPaid >= condition.amount ? "true" : "false";
  const deal = [...observation.completedDeals, observation.deal].find(deal => deal.round === condition.round);
  const value = condition.kind === "visible-return-at-least" ? deal?.returned : deal?.promiseRatio == null ? null : deal.collateral;
  return value == null ? "unknown" : value >= condition.amount ? "true" : "false";
}
export function assessPlan(plan: Plan | null, observation: ActorObservation): PlanAssessment {
  if (!plan) return { applicable: false, needsReview: false, reasons: [], remainingOpportunities: [] };
  const remaining = plan.scope ? ownOpportunities(observation).filter(opportunity => inScope(plan.scope!, opportunity)) : [];
  const reasons: string[] = [];
  if (!plan.scope) reasons.push("旧计划没有可执行的角色与轮次范围，需要人物确认。");
  else if (plan.status === "active" || plan.status === "needs-review") {
    if (!remaining.length) reasons.push("计划范围内已没有剩余合法机会。");
    else if (!inScope(plan.scope, { round: observation.round, phase: observation.phase, role: observation.actorId === observation.investor ? "investor" : "trustee" }))
      reasons.push("本次角色或阶段不在计划适用范围内。");
    for (const condition of plan.conditions ?? []) if (evaluatePlanCondition(condition, observation) !== "true")
      reasons.push(`计划前提${evaluatePlanCondition(condition, observation) === "false" ? "已不成立" : "尚不可判定"}：${condition.kind}。`);
  }
  const live = plan.status === "active" || plan.status === "needs-review";
  return { applicable: live && reasons.length === 0 && plan.status === "active", needsReview: live && (reasons.length > 0 || plan.status === "needs-review"), reasons, remainingOpportunities: remaining };
}
function transition(mind: MindState, status: Plan["status"], reason: string, observation: ActorObservation, origin: "rules" | "actor", sourceIds: string[]) {
  const plan = mind.plan!; const from = plan.status;
  plan.status = status; plan.version = (plan.version ?? 0) + 1; plan.revision = observation.revision;
  mind.planEvents = [...(mind.planEvents ?? []), { revision: observation.revision, planId: plan.id, planVersion: plan.version, from, to: status, reason, origin, sourceIds }];
  mind.version++;
}
/** Objective expiration never masquerades as a voluntary decision to abandon a plan. */
export function reconcilePlan(previous: MindState, observation: ActorObservation): MindState {
  const mind = structuredClone(previous); const plan = mind.plan;
  if (!plan || !["active", "needs-review"].includes(plan.status)) return mind;
  if (plan.success && evaluatePlanCondition(plan.success, observation) === "true")
    transition(mind, "satisfied", "规则证据满足了预先登记的目标条件。", observation, "rules", []);
  else if (observation.phase === "finished" || plan.scope && !assessPlan(plan, observation).remainingOpportunities.length)
    transition(mind, "expired", "世界已结束或计划范围内不再有合法机会。", observation, "rules", []);
  else if (observation.currentActor === observation.actorId && plan.status === "active" && assessPlan(plan, observation).needsReview)
    transition(mind, "needs-review", assessPlan(plan, observation).reasons.join(" "), observation, "rules", []);
  return mind;
}
export function applyPlanOperation(previous: MindState, input: PlanOperation, observation: ActorObservation, reason: string, sourceIds: string[]): MindState {
  const operation = planOperationSchema.parse(input); const mind = structuredClone(previous);
  if (!sourceIds.length || sourceIds.some(id => !observation.events.some(event => event.id === id))) throw new Error("计划操作必须引用本人可见的真实事件");
  if (operation.kind === "act-once") return mind;
  if (operation.kind !== "create" && (!mind.plan || operation.version !== (mind.plan.version ?? 0))) throw new Error("计划版本已变化或计划不存在，请使用正式版本");
  if (operation.kind !== "create" && !["active", "needs-review"].includes(mind.plan!.status)) throw new Error("该计划已经结束，新的意图应新建计划");
  if (operation.kind === "keep") {
    if (!assessPlan({ ...mind.plan!, status: "active" }, observation).applicable) throw new Error("计划已失效或不适用于本次机会；可修订、放弃或明确仅作本次选择");
    if (mind.plan!.status === "needs-review") transition(mind, "active", reason, observation, "actor", sourceIds);
    return mind;
  }
  if (operation.kind === "abandon" || operation.kind === "satisfy") {
    if (operation.kind === "satisfy" && mind.plan!.success && evaluatePlanCondition(mind.plan!.success, observation) !== "true") throw new Error("已登记的完成条件尚未被可见事实满足");
    transition(mind, operation.kind === "abandon" ? "abandoned" : "satisfied", reason, observation, "actor", sourceIds); return mind;
  }
  if (operation.plan.scope.throughRound > observation.maxRounds) throw new Error("计划包含不存在的轮次");
  if (!ownOpportunities(observation).some(opportunity => inScope(operation.plan.scope, opportunity))) throw new Error("计划没有任何剩余合法机会，不能建立或续期");
  if (operation.kind === "create" && mind.plan && ["active", "needs-review"].includes(mind.plan.status)) throw new Error("已有计划需使用 revise 或 abandon，不能用 create 无声覆盖");
  const old = mind.plan;
  if (old) mind.planHistory = [...(mind.planHistory ?? []), structuredClone(old)];
  mind.plan = { ...operation.plan, id: operation.kind === "revise" && old?.id ? old.id : crypto.randomUUID(),
    version: operation.kind === "revise" ? (old?.version ?? 0) + 1 : 1, status: "active", sourceIds, revision: observation.revision };
  mind.planEvents = [...(mind.planEvents ?? []), { revision: observation.revision, planId: mind.plan.id, planVersion: mind.plan.version!,
    from: old?.status ?? "none", to: "active", reason, sourceIds, origin: "actor" }];
  mind.version++;
  return reconcilePlan(mind, observation);
}
