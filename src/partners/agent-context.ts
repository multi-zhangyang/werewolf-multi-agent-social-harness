import { randomUUID } from "node:crypto";
import type { Action, ActorObservation } from "./contracts";
import type { PartnerDecisionCase, PartnerDecisionInput } from "./agent-types";
import { chooseMemories, nextCounterpartOpportunity } from "./cognition";
import { addForecast, advanceMind, createMind, reduceMind, resolvePredictions,
  type EpisodicMemory, type ForecastProposal, type MindDelta, type MindState, type PsychologyMode } from "./mind";
import { applyPlanOperation, assessPlan, ownOpportunities, reconcilePlan, type PlanOperation } from "./plans";
import { observeWorld, previewAction } from "./world";

/** One activation owns copies only. The service commits all state in one SQLite transaction. */
export class PartnerAgentContext {
  readonly observation: ActorObservation;
  readonly originalMind: MindState;
  readonly importantEvent?: ActorObservation["events"][number];
  mind: MindState;
  memories: EpisodicMemory[];
  action?: Action;
  recordFinished = false;
  turn = 0;
  lastMutationTurn = -1;
  currentToolCallId?: string;
  boundaryError?: Error;
  readonly evidenceRefs = new Map<string, string>();
  constructor(readonly input: PartnerDecisionInput, readonly mode: PsychologyMode,
    readonly record: PartnerDecisionCase, readonly shadow = false) {
    this.observation = observeWorld(input.world, input.actorId);
    this.observation.events.forEach((event, index) => this.evidenceRefs.set(`e${index + 1}`, event.id));
    this.originalMind = structuredClone(input.mind ?? createMind(input.actorId, this.observation.self.privateObjective));
    if (this.originalMind.actorId !== input.actorId) throw new Error("不能使用另一人物的心理状态");
    this.mind = mode === "off" ? createMind(input.actorId, this.observation.self.privateObjective, this.observation.revision)
      : reconcilePlan(resolvePredictions(advanceMind(this.originalMind, this.observation.revision, mode), this.observation), this.observation);
    this.mind.schemaVersion = 2;
    const visible = new Set(this.observation.events.map(event => event.id));
    this.memories = mode === "off" ? [] : structuredClone((input.memories ?? []).filter(memory =>
      memory.actorId === input.actorId && memory.sourceIds.every(id => visible.has(id))));
    this.importantEvent = mode === "off" ? undefined : this.observation.events.findLast(event => {
      if (event.revision <= (this.mind.lastAppraisalRevision ?? -1) || this.mind.processedEvidenceIds.includes(event.id)) return false;
      const opponent = event.actor !== null && event.actor !== input.actorId;
      const breach = event.kind === "settlement" && opponent && event.data.breached === true;
      const compensation = event.kind === "repair" && opponent && Number(event.data.compensation) > 0;
      const predictionError = this.mind.predictions.some(prediction => prediction.evidenceId === event.id &&
        prediction.status === "scored" && (prediction.brier ?? 0) >= 0.36);
      return breach || compensation || predictionError;
    });
  }
  get appraisalEvent() { return this.importantEvent ?? (this.shadow ? this.observation.events.at(-1) : undefined); }
  get needsAppraisal() {
    return Boolean(this.appraisalEvent && !this.record.appraisal && this.mode !== "off");
  }
  get livePlan() { return Boolean(this.mind.plan && ["active", "needs-review"].includes(this.mind.plan.status)); }
  get finished() { return Boolean(this.action || this.recordFinished); }
  assertOpen() {
    this.input.signal?.throwIfAborted();
    if (this.boundaryError) throw this.boundaryError;
    if (this.finished) throw new Error("本次激活已经结束，不能再次修改或提交");
  }
  assertEvidence(eventId: string) {
    const resolved = this.evidenceRefs.get(eventId) ?? eventId;
    if (!this.observation.events.some(event => event.id === resolved)) throw new Error(`只能引用本人可见的真实事件：${[...this.evidenceRefs.keys()].join(", ")}`);
    return resolved;
  }
  displayReferences<T>(value: T): T {
    const aliases = new Map([...this.evidenceRefs].map(([ref, id]) => [id, ref]));
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string" ? aliases.get(item) ?? item : item));
  }
  appraise(delta: MindDelta) {
    this.assertOpen();
    delta = { ...delta, eventId: this.assertEvidence(delta.eventId), sourceIds: delta.sourceIds.map(id => this.assertEvidence(id)) };
    if (this.needsAppraisal && delta.eventId !== this.appraisalEvent!.id)
      throw new Error(`请先评价当前触发事件 ${this.displayReferences(this.appraisalEvent!.id)}`);
    const before = structuredClone(this.mind);
    const next = reduceMind(before, delta, this.observation, this.mode);
    if (next.version !== before.version) this.lastMutationTurn = this.turn;
    this.mind = next;
    this.record.appraisal = { eventId: delta.eventId, sourceIds: [...delta.sourceIds], reason: delta.reason,
      required: Boolean(this.appraisalEvent), before, after: structuredClone(next) };
    if (delta.memory && !before.processedEvidenceIds.includes(delta.eventId)) this.memories.push({
      id: randomUUID(), actorId: this.input.actorId, kind: "interpretation", text: delta.memory,
      sourceIds: [...delta.sourceIds], revision: this.observation.revision,
    });
    return this.displayReferences({ canonicalMind: this.modelMind(), planAssessment: assessPlan(next.plan, this.observation) });
  }
  plan(operation: PlanOperation, eventId: string, reason: string) {
    this.assertOpen();
    if (this.mode === "off") throw new Error("此次选择不使用心理和计划");
    if (this.needsAppraisal) throw new Error("先评价触发事件，再使用返回的正式状态管理计划");
    eventId = this.assertEvidence(eventId);
    const before = this.mind.version;
    const next = applyPlanOperation(this.mind, operation, this.observation, reason, [eventId]);
    this.mind = next;
    if (before !== next.version) this.lastMutationTurn = this.turn;
    this.record.planOperations ??= [];
    this.record.planOperations.push({ kind: operation.kind, eventId, reason, beforeVersion: before, afterVersion: next.version,
      planId: next.plan?.id, planVersion: next.plan?.version });
    return this.displayReferences({ canonicalMind: this.modelMind(), planAssessment: assessPlan(next.plan, this.observation) });
  }
  forecast(proposal: ForecastProposal, eventId: string) {
    this.assertOpen(); eventId = this.assertEvidence(eventId);
    if (this.mode === "off" || this.shadow) throw new Error("此次会话不登记行为预测");
    if (this.needsAppraisal) throw new Error("先评价触发事件，再登记预测");
    this.mind = addForecast(this.mind, proposal, this.observation, eventId);
    this.lastMutationTurn = this.turn;
    return this.displayReferences({ prediction: this.mind.predictions.at(-1), mindVersion: this.mind.version });
  }
  stage(action: Action, planBasis: "plan" | "one-off") {
    this.assertOpen();
    if (this.shadow) throw new Error("独立心理记录无权决定或修改行动");
    if (this.needsAppraisal) throw new Error("当前触发事件还没有得到评价");
    if (this.lastMutationTurn >= this.turn) throw new Error("先读取正式工具回执，再在下一次模型响应中决定行动");
    const assessment = assessPlan(this.mind.plan, this.observation);
    if (planBasis === "plan" && (this.mode === "off" || !assessment.applicable))
      throw new Error("当前计划不适用于此机会；可以修订计划，或明确选择 one-off");
    const preview = previewAction(this.input.world, this.input.actorId, action);
    if (!preview.legal) throw new Error(preview.reason ?? "行动不合法");
    const current = structuredClone(this.mind);
    this.record.actionMind = this.mode === "off" ? undefined : current;
    const lastPlan = this.record.planOperations?.at(-1);
    const disposition = planBasis === "one-off" ? "one-off" : lastPlan?.kind === "create" ? "create" : lastPlan?.kind === "revise" ? "revise" : "continue";
    if (this.mode !== "off") {
      this.mind.lastDecision = { disposition, reason: lastPlan?.reason ?? action.intent ?? "依据当前可见事实完成选择",
        sourceIds: lastPlan ? [lastPlan.eventId] : this.record.appraisal?.sourceIds ?? [this.observation.events.at(-1)!.id],
        revision: this.observation.revision, planVersion: this.mind.plan?.version ?? 0, consistency: "consistent" };
      this.record.planDecision = structuredClone(this.mind.lastDecision);
      this.record.planConsistency = "consistent"; this.mind.version++;
    }
    const prediction = this.mind.predictions.findLast(item => item.createdRevision === this.observation.revision && item.status === "pending");
    this.record.receipt = { contextId: this.record.id, worldRevision: this.observation.revision,
      mindVersion: this.mode === "off" ? null : current.version, basis: this.mode === "off" ? "facts-only" : planBasis,
      planId: this.mode === "off" ? undefined : current.plan?.id, planVersion: this.mode === "off" ? undefined : current.plan?.version,
      appraisalRequired: Boolean(this.importantEvent), appraised: Boolean(this.record.appraisal),
      ...(prediction ? { predictionId: prediction.id, forecast: prediction } : {}),
      ...(action.type === "settle" ? { claimAudit: { knownIncome: this.observation.deal.grossIncome!,
        claimedIncome: action.claimedIncome ?? null, mismatch: action.claimedIncome == null ? null : action.claimedIncome !== this.observation.deal.grossIncome,
        publiclyDisclosed: action.revealIncome ?? false } } : {}),
    };
    this.action = structuredClone(action);
    return { accepted: true, action: this.action, worldRevision: this.observation.revision, note: "暂存成功；完整 SDK 激活结束后才提交事务" };
  }
  modelMind() {
    const { planHistory: _history, processedEvidenceIds: _processed, ...mind } = this.mind;
    return { ...mind, changes: mind.changes.slice(-4), planEvents: mind.planEvents?.slice(-4) };
  }
  modelInput() {
    const { events, ...observation } = this.observation;
    const selection = chooseMemories(this.mind, this.memories, this.observation, this.mode === "off");
    this.record.attention = selection.attention;
    return JSON.stringify(this.displayReferences({ observation, recentEvents: events.slice(-18).map(event => ({ ...event,
      evidenceType: event.kind === "message" ? "heard_claim" : event.kind === "intent" ? "self_report" : "world_fact",
      ...(event.kind === "settlement" && event.data.claimedIncome !== undefined ? { unverifiedFields: ["claimedIncome"] } : {}),
    })), remainingOpportunities: ownOpportunities(this.observation), nextCounterpartOpportunity: nextCounterpartOpportunity(this.observation),
    ...(this.mode === "off" ? {} : { currentMind: this.modelMind(), planAssessment: assessPlan(this.mind.plan, this.observation),
      relevantExperiences: selection.memories, attention: selection.attention }),
    ...(this.needsAppraisal ? { appraisalRequired: { event: this.appraisalEvent,
      instruction: "先评价此事件；可以保留原值。情绪、判断和计划由你决定，不能把对方收入声明视为凭证。" } } : {}),
    decisionFrame: { role: this.observation.actorId === this.observation.investor ? "investor" : "trustee",
      ownProductivity: this.observation.self.productivity, promiseAmount: this.observation.deal.grossIncome == null || this.observation.deal.promiseRatio == null
        ? null : Math.ceil(this.observation.deal.grossIncome * this.observation.deal.promiseRatio),
      finalRound: this.observation.round === this.observation.maxRounds,
      nextRoundRole: this.observation.round === this.observation.maxRounds ? null : this.observation.actorId === this.observation.investor ? "trustee" : "investor",
      incomeClaim: this.observation.deal.claimedIncome == null ? null : { speakerId: this.observation.trustee,
        amount: this.observation.deal.claimedIncome, evidenceType: "unverified_claim" },
      rule: "承诺按实际收入计算；声称收入不改变履约裁决。退出结束合作。未来机会仅在无人退出时存在。" } }));
  }
}
