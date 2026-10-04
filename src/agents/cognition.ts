import { z } from "zod";
import { payoffFeedback, type DecisionStructure, type PayoffComparison } from "./decision-analysis";

export const cognitionVersion = "psychology-responses-v16";
const unit = z.number().min(0).max(1);
const text = (limit: number) => z.string().trim().min(1).max(limit);
const sources = z.array(text(160)).min(1).max(8).describe("从本次 evidence.id / newEvidenceIds 选择短证据编号，例如 e1；不要自行生成编号");
export const emotions = ["calm", "hurt", "anger", "anxiety", "guilt", "gratitude", "hope"] as const;
export const needs = ["security", "fairness", "belonging", "autonomy", "achievement"] as const;
export const strategies = ["observe", "probe", "cooperate", "protect", "repair", "compete", "deceive", "withdraw"] as const;
export type Strategy = typeof strategies[number];
export const appraisalParameters = z.object({
  sourceIds: sources, interpretation: text(360), desirability: z.number().min(-1).max(1),
  control: unit, certainty: unit, responsibility: z.enum(["self", "other", "shared", "situation", "unknown"]).nullable().describe("主观责任归属：自己、他人、共同、情境或未知；不是人物姓名或 ID"),
  emotions: z.array(z.object({ emotion: z.enum(emotions), intensity: unit }).strict()).min(1).max(4),
  needs: z.array(z.object({ need: z.enum(needs), tension: unit }).strict()).max(5),
  regulation: z.enum(["none", "reappraise", "suppress", "ruminate", "repair"]),
}).strict();
export const opponentParameters = z.object({ targetId: text(120), sourceIds: sources,
  willingness: unit, competence: unit, hypothesis: text(240), alternative: text(240), confidence: unit,
  scope: z.enum(["episode", "relationship"]),
}).strict();
export const planParameters = z.object({ id: z.string().max(160).nullable(), sourceIds: sources,
  goal: text(240), strategy: z.enum(strategies), steps: z.array(text(180)).min(1).max(4),
  when: text(200), reviseWhen: text(200), stopWhen: text(200), portable: z.boolean(),
}).strict();
export const memoryParameters = z.object({ kind: z.enum(["episodic", "semantic", "procedural"]),
  sourceIds: sources, text: text(600), confidence: unit, tags: z.array(text(60)).max(6),
  scope: z.enum(["episode", "transferable"]), when: z.string().max(200).nullable(), then: z.string().max(200).nullable(),
}).strict();
export const memoryRevisionParameters = z.object({ id: text(160), change: z.enum(["revise", "retire"]), sourceIds: sources,
  reason: text(360), replacement: memoryParameters.omit({ sourceIds: true }).extend({ kind: z.enum(["semantic", "procedural"]) }).nullable(),
}).strict();
export const consolidationParameters = memoryParameters.pick({ text: true, confidence: true, tags: true }).extend({
  strategyId: text(160).nullable().describe("补充或修正已有原则时选择其记忆编号；仅新增不同原则时使用 null"),
  memoryIds: z.array(text(160)).min(1).max(6), rationale: text(360),
  when: text(200).describe("可复用的情境条件与适用边界，不把上一局身份、金额或具体动作名称当成通用规则"),
  then: text(200).describe("条件成立时可尝试的行动原则，由当前环境的合法动作实现"),
}).strict();
export const strategyAssessmentParameters = z.object({ id: text(160), sourceIds: sources,
  verdict: z.enum(["apply", "adapt", "reject"]), matching: text(240), differences: text(240),
  adaptation: text(240).nullable().describe("adapt 时说明如何调整；apply / reject 填 null"),
}).strict();
export const episodeReviewParameters = z.object({
  status: z.enum(["ready", "insufficient"]), sourceIds: sources,
  strategyIds: z.array(text(160)).max(6), summary: text(900),
}).strict();
export const predictionParameters = z.object({ sourceIds: sources, targetId: z.string().max(120).nullable().describe("行动的实际执行者；全局结算可用 null，具体人物收益由 field 指定"),
  kind: z.enum(["action", "outcome"]), eventName: text(120), field: text(160),
  operator: z.enum(["gte", "eq", "includes"]), expected: z.union([z.number().finite(), z.string().max(160), z.boolean()]), probability: unit,
}).strict();
export interface Experience {
  id: string; episode: string; seq: number; round: number; actorId?: string;
  environment?: string;
  role?: string;
  kind: "observation" | "message" | "action" | "outcome"; name: string; text: string; data: Record<string, unknown>;
  reward?: { value: number; normalized: number; unit: string; scope?: "round" | "episode" };
}
export interface CognitiveMemory extends z.infer<typeof memoryParameters> {
  id: string; episode: string; revision?: number; status?: "active" | "retired";
  origin?: "ledger" | "agent";
  observation?: { sourceId: string; round: number; environment?: string;
    actions: Array<Pick<PrivateDecision, "id" | "action" | "parameters"> & { round?: number }>; reward: NonNullable<Experience["reward"]>;
    decisionStructures?: DecisionStructure[]; comparisons?: Array<{ decisionId: string; analysis: PayoffComparison; feedback: ReturnType<typeof payoffFeedback> }> };
  consolidation?: { episode: string; rationale: string; sourceMemories: Array<{ id: string; revision: number }>; sourceOutcomeIds?: string[] };
  revisions?: Array<{ atRevision: number; episode: string; change: "revise" | "retire"; reason: string; sourceIds: string[];
    previous: Omit<CognitiveMemory, "revisions"> }>;
}
export interface CognitivePlan extends z.infer<typeof planParameters> { id: string; episode: string; revision: number; status: "active" | "closed"; closeReason?: string }
export interface OpponentModel extends z.infer<typeof opponentParameters> { episode: string; updates: number }
export interface Prediction extends z.infer<typeof predictionParameters> {
  id: string; episode: string; afterSeq: number; result?: boolean; sourceId?: string; brier?: number; expired?: boolean;
}
export interface PrivateDecision {
  id: string; episode: string; round: number; action: string; strategy: Strategy;
  parameters?: Record<string, unknown>;
  intent: "truthful" | "withhold" | "bluff" | "mixed" | "none"; privateAim: string;
  predictionIds: string[]; reward?: number; feedbackId?: string; assessmentIds?: string[];
  strategyBasis?: { assessmentIds: string[]; reason: string };
  decisionStructure?: DecisionStructure;
  payoffComparison?: PayoffComparison;
}
export interface StrategyAssessment extends Omit<z.infer<typeof strategyAssessmentParameters>, "id"> {
  id: string; episode: string; opportunityId: string; round: number;
  memoryId: string; memoryRevision: number; memoryEpisode: string; memoryOriginEpisode?: string;
  memory: Pick<CognitiveMemory, "text" | "when" | "then">;
  decisionIds: string[]; predictionIds: string[];
  feedback: Array<{ sourceId: string; decisionIds: string[]; value: number; normalized: number; unit: string }>;
  predictions: Array<{ id: string; sourceId: string; result: boolean; brier: number }>;
}
export interface PredictionFeedback {
  forecastCount: number; actionForecastCount: number; outcomeForecastCount: number;
  scoredForecastCount: number; uniqueScoredEventCount: number; unscoredForecastCount: number; meanBrier: number | null;
  eventGroups: Array<{ sourceId: string; predictionIds: string[] }>;
  unscored: Array<{ id: string; kind: Prediction["kind"]; eventName: string; field: string; status: "pending" | "unverified" }>;
  note: string;
}
export interface AgentMind {
  version: typeof cognitionVersion | "psychology-responses-v1" | "psychology-responses-v2" | "psychology-responses-v3" | "psychology-responses-v4" | "psychology-responses-v5" | "psychology-responses-v6" | "psychology-responses-v7" | "psychology-responses-v8" | "psychology-responses-v9" | "psychology-responses-v10" | "psychology-responses-v11" | "psychology-responses-v12" | "psychology-responses-v13" | "psychology-responses-v14" | "psychology-responses-v15"; actorId: string; episode: string; revision: number;
  emotions: Record<typeof emotions[number], number>; needs: Record<typeof needs[number], number>;
  appraisal?: z.infer<typeof appraisalParameters>;
  dynamics?: { inertia: number; decay: number; freshSourceIds: string[] };
  relationships: Record<string, OpponentModel>; episodeBeliefs?: Record<string, OpponentModel>; plans: CognitivePlan[]; memories: CognitiveMemory[];
  predictions: Prediction[]; decisions: PrivateDecision[]; strategyAssessments?: StrategyAssessment[];
  episodeReviews?: Array<Omit<z.infer<typeof episodeReviewParameters>, "strategyIds"> & {
    episode: string; opportunityId: string; strategies: Array<{ id: string; revision: number }>; predictionFeedback?: PredictionFeedback;
  }>;
  learning: { episodes: string[]; observed: number; scored: number; brierSum: number;
    strategies: Partial<Record<Strategy, { samples: number; meanReturn: number; unit: "normalized-environment-return" }>> };
  cursors: Record<string, number>; appraised: string[];
}
const clamp = (n: number) => Math.min(1, Math.max(0, n));
export function createAgentMind(actorId: string, episode: string): AgentMind {
  return { version: cognitionVersion, actorId, episode, revision: 0,
    emotions: { calm: .5, hurt: 0, anger: 0, anxiety: .1, guilt: 0, gratitude: 0, hope: .3 },
    needs: { security: .3, fairness: .3, belonging: .3, autonomy: .3, achievement: .5 },
    relationships: {}, episodeBeliefs: {}, plans: [], memories: [], predictions: [], decisions: [], strategyAssessments: [], episodeReviews: [], appraised: [], cursors: {},
    learning: { episodes: [], observed: 0, scored: 0, brierSum: 0, strategies: {} } };
}
/** Read old snapshots without rewriting them. Durable relationships and local hypotheses have separate slots. */
export function opponentViews(mind: AgentMind) {
  const relationships: Record<string, OpponentModel> = {};
  const episodeBeliefs: Record<string, OpponentModel> = {};
  for (const model of [...Object.values(mind.relationships), ...Object.values(mind.episodeBeliefs ?? {})]) {
    if (model.scope === "relationship") relationships[model.targetId] = model;
    else if (model.episode === mind.episode) episodeBeliefs[model.targetId] = model;
  }
  return { relationships, episodeBeliefs };
}
/** A new environment clears local identities and plans; evidence-linked skills can transfer. */
export function enterEpisode(previous: AgentMind | undefined, actorId: string, episode: string): AgentMind {
  if (previous && previous.actorId !== actorId) throw new Error("不能继承其他人物的心理状态");
  const mind = structuredClone(previous ?? createAgentMind(actorId, episode));
  Object.assign(mind, opponentViews(mind)); mind.version = cognitionVersion;
  mind.strategyAssessments ??= [];
  mind.episodeReviews ??= [];
  if (mind.episode === episode) return mind;
  mind.episode = episode; mind.appraisal = undefined; mind.appraised = [];
  for (const emotion of emotions) mind.emotions[emotion] *= .6;
  mind.episodeBeliefs = {};
  for (const plan of mind.plans) if (!plan.portable && plan.status === "active") { plan.status = "closed"; plan.closeReason = "原情境已结束"; }
  mind.revision++;
  return mind;
}
/** Appraisal is a model report. Inertia and regulation are explicit simulation rules, not clinical measurements. */
export function appraise(mind: AgentMind, proposal: z.infer<typeof appraisalParameters>, inertia = .6, decay = .1) {
  const fresh = proposal.sourceIds.filter(id => !mind.appraised.includes(id));
  if (!fresh.length) throw new Error("这些事件已评价；请选择新证据，避免重复放大同一情绪");
  const prior = { ...mind.emotions };
  for (const emotion of emotions) mind.emotions[emotion] = clamp(prior[emotion] * (1 - decay));
  for (const item of proposal.emotions) {
    const negative = ["hurt", "anger", "anxiety", "guilt"].includes(item.emotion);
    const regulation = negative && proposal.regulation === "reappraise" ? .85 : negative && proposal.regulation === "ruminate" ? 1.08 : 1;
    // Suppression changes expression, not the stored emotion itself.
    mind.emotions[item.emotion] = clamp((inertia * prior[item.emotion] + (1 - inertia) * item.intensity) * regulation);
  }
  for (const item of proposal.needs) mind.needs[item.need] = clamp(inertia * mind.needs[item.need] + (1 - inertia) * item.tension);
  mind.appraisal = structuredClone(proposal); mind.dynamics = { inertia, decay, freshSourceIds: fresh }; mind.appraised.push(...fresh); mind.revision++;
  return { revision: mind.revision, appraisal: mind.appraisal, emotions: mind.emotions, needs: mind.needs, freshSourceIds: fresh };
}
export function updateOpponent(mind: AgentMind, proposal: z.infer<typeof opponentParameters>) {
  Object.assign(mind, opponentViews(mind));
  const models = proposal.scope === "relationship" ? mind.relationships : mind.episodeBeliefs!;
  const old = models[proposal.targetId];
  const model = { ...structuredClone(proposal), episode: mind.episode, updates: (old?.updates ?? 0) + 1 };
  models[proposal.targetId] = model; mind.revision++; return model;
}
export function setPlan(mind: AgentMind, proposal: z.infer<typeof planParameters>) {
  const old = proposal.id ? mind.plans.find(plan => plan.id === proposal.id && plan.status === "active") : undefined;
  if (proposal.id && !old) throw new Error("指定计划不存在或已关闭");
  if (!old && mind.plans.filter(p => p.status === "active").length >= 3) throw new Error("最多保留 3 个活动计划；先修订或关闭已有计划");
  const plan: CognitivePlan = { ...structuredClone(proposal), id: old?.id ?? crypto.randomUUID(),
    episode: mind.episode, revision: (old?.revision ?? 0) + 1, status: "active" };
  if (old) mind.plans[mind.plans.indexOf(old)] = plan; else mind.plans.push(plan);
  mind.revision++; return plan;
}
function validateMemory(proposal: z.infer<typeof memoryParameters> | NonNullable<z.infer<typeof memoryRevisionParameters>["replacement"]>) {
  if (proposal.kind === "procedural" && (!proposal.when?.trim() || !proposal.then?.trim())) throw new Error("程序性记忆需要明确 when 和 then");
}
export function activeMemories(mind: AgentMind) {
  return mind.memories.filter(memory => memory.status !== "retired" && (memory.episode === mind.episode || memory.scope === "transferable"));
}
/** Revisions change a rule's current evidence, not where its stable identity originated. */
export function memoryOriginEpisode(memory: CognitiveMemory) {
  return memory.revisions?.[0]?.previous.episode ?? memory.episode;
}
/** Historical revisions remain available to research, not as competing current beliefs in model input. */
export function memoryForPrompt(memory: CognitiveMemory) {
  const { revisions: _history, ...current } = memory;
  if (!current.observation?.comparisons) return current;
  // Full alternatives live in decision evidence; ordinary recall only needs the grounded feedback.
  return { ...current, observation: { ...current.observation, comparisons: current.observation.comparisons.map(({ decisionId, analysis, feedback }) =>
    ({ decisionId, action: analysis.action, rationale: analysis.rationale, feedback })) } };
}
export function remember(mind: AgentMind, proposal: z.infer<typeof memoryParameters>) {
  validateMemory(proposal);
  const memory: CognitiveMemory = { ...structuredClone(proposal), id: crypto.randomUUID(), episode: mind.episode, origin: "agent" };
  mind.memories.push(memory); mind.revision++; return memory;
}
/** The agent selects experiences; their visible ledger links determine provenance. */
export function consolidateStrategy(mind: AgentMind, proposal: z.infer<typeof consolidationParameters>, visibleOutcomeIds: readonly string[]) {
  const selected = proposal.memoryIds.map(id => activeMemories(mind).find(memory => memory.id === id));
  if (new Set(proposal.memoryIds).size !== proposal.memoryIds.length || selected.some(memory => !memory || memory.kind !== "episodic"))
    throw new Error("提炼须引用本人当前可用且不重复的经历记忆");
  const experiences = selected as CognitiveMemory[];
  const outcomes = new Set(visibleOutcomeIds);
  const linked = experiences.map(memory => memory.sourceIds.filter(id => outcomes.has(id)));
  if (linked.some(ids => ids.length === 0)) throw new Error("所选经历必须有本人可见的真实结算来源");
  const sourceIds = [...new Set(linked.flat())];
  const { memoryIds: _ids, strategyId, rationale, ...rule } = proposal;
  const target = strategyId === null ? undefined : activeMemories(mind).find(memory => memory.id === strategyId && memory.kind === "procedural" && memory.scope === "transferable");
  if (strategyId !== null && !target) throw new Error("只能更新本人当前有效的可迁移条件策略");
  const replacement = { ...rule, kind: "procedural" as const, scope: "transferable" as const };
  const memory = target ? reviseMemory(mind, { id: target.id, change: "revise", sourceIds, reason: rationale, replacement })
    : remember(mind, { ...replacement, sourceIds });
  memory.consolidation = { episode: mind.episode, rationale,
    sourceMemories: experiences.map(memory => ({ id: memory.id, revision: memory.revision ?? 1 })), sourceOutcomeIds: sourceIds };
  return memory;
}
/** An applicability judgment is a model report; adoption requires a later committed decision. */
export function assessStrategy(mind: AgentMind, proposal: z.infer<typeof strategyAssessmentParameters>, opportunityId: string, round: number) {
  const memory = activeMemories(mind).find(memory => memory.id === proposal.id && memory.kind === "procedural");
  if (!memory) throw new Error("只能检验本人当前可用的条件策略");
  if (proposal.verdict === "adapt" ? !proposal.adaptation?.trim() : proposal.adaptation !== null)
    throw new Error("adapt 需要调整说明，apply / reject 的 adaptation 必须为 null");
  const { id: _id, ...judgment } = proposal;
  const assessment: StrategyAssessment = { ...structuredClone(judgment), id: crypto.randomUUID(), episode: mind.episode, opportunityId, round,
    memoryId: memory.id, memoryRevision: memory.revision ?? 1, memoryEpisode: memory.episode, memoryOriginEpisode: memoryOriginEpisode(memory),
    memory: { text: memory.text, when: memory.when, then: memory.then }, decisionIds: [], predictionIds: [], feedback: [], predictions: [] };
  (mind.strategyAssessments ??= []).push(assessment); mind.revision++; return assessment;
}
/** Applicability is not adoption. Only explicitly selected, current judgments can explain an action. */
export function usableStrategyAssessments(mind: AgentMind, opportunityId: string) {
  const latest = new Map((mind.strategyAssessments ?? []).filter(item => item.episode === mind.episode && item.opportunityId === opportunityId)
    .map(item => [item.memoryId, item]));
  return [...latest.values()].filter(item => item.verdict !== "reject" && activeMemories(mind)
    .some(memory => memory.id === item.memoryId && memory.kind === "procedural" && (memory.revision ?? 1) === item.memoryRevision));
}
export function bindStrategyAssessments(mind: AgentMind, opportunityId: string, decision: PrivateDecision) {
  if (!isWorldDecision(decision)) return;
  const selected = decision.strategyBasis?.assessmentIds ?? [];
  const available = usableStrategyAssessments(mind, opportunityId);
  const adopted = available.filter(item => selected.includes(item.id));
  if (new Set(selected).size !== selected.length || adopted.length !== selected.length)
    throw new Error("行动依据只能选择本次机会已检验、未拒绝且版本仍有效的策略回执；无采用策略时使用空数组");
  decision.assessmentIds = [...selected];
  for (const item of adopted) {
    item.decisionIds.push(decision.id);
    item.predictionIds = [...new Set([...item.predictionIds, ...decision.predictionIds])];
  }
}
export function isWorldDecision(decision: PrivateDecision) { return !["speak", "send_message", "wait"].includes(decision.action); }
export function strategyUsage(mind: AgentMind, memory: CognitiveMemory) {
  const judgments = (mind.strategyAssessments ?? []).filter(item => item.memoryId === memory.id && item.memoryRevision === (memory.revision ?? 1));
  const decisions = new Set(mind.decisions.filter(decision => isWorldDecision(decision) && decision.strategyBasis).map(decision => decision.id));
  const adopted = judgments.filter(item => item.decisionIds.some(id => decisions.has(id)));
  return { assessed: judgments.length, adopted: adopted.length,
    rejected: judgments.filter(item => item.verdict === "reject").length,
    outcomeSamples: new Set(adopted.flatMap(item => item.feedback.filter(feedback => feedback.decisionIds.some(id => decisions.has(id))).map(feedback => feedback.sourceId))).size,
    scoredPredictions: new Set(adopted.flatMap(item => item.predictions.map(prediction => prediction.id))).size };
}
/** Change an interpretation or conditional strategy without rewriting experience or losing its prior versions. */
export function reviseMemory(mind: AgentMind, proposal: z.infer<typeof memoryRevisionParameters>) {
  const old = activeMemories(mind).find(memory => memory.id === proposal.id);
  if (!old) throw new Error("只能修订本人当前可用的记忆");
  if (old.kind === "episodic") throw new Error("经历记录不可改写；请将新的解释记为判断或条件策略");
  if (proposal.change === "revise" && !proposal.replacement) throw new Error("修订需要提供 replacement");
  if (proposal.change === "retire" && proposal.replacement) throw new Error("停用时 replacement 必须为 null");
  if (proposal.replacement) validateMemory(proposal.replacement);
  const { revisions = [], ...previous } = structuredClone(old);
  const next: CognitiveMemory = { ...previous,
    ...(proposal.replacement ? { ...structuredClone(proposal.replacement), sourceIds: [...proposal.sourceIds], episode: mind.episode, consolidation: undefined } : {}),
    revision: (old.revision ?? 1) + 1, status: proposal.change === "retire" ? "retired" : "active",
    revisions: [...revisions, { atRevision: mind.revision + 1, episode: mind.episode, change: proposal.change,
      reason: proposal.reason, sourceIds: [...proposal.sourceIds], previous }] };
  mind.memories[mind.memories.indexOf(old)] = next; mind.revision++; return next;
}
export function forecast(mind: AgentMind, proposal: z.infer<typeof predictionParameters>, afterSeq: number) {
  if (proposal.operator === "gte" && typeof proposal.expected !== "number") throw new Error("gte 预测必须使用数值 expected");
  if (mind.predictions.filter(p => p.episode === mind.episode && p.result === undefined && !p.expired).length >= 8) throw new Error("已有 8 项待验证预测，先等待实际反馈");
  const value: Prediction = { ...structuredClone(proposal), id: crypto.randomUUID(), episode: mind.episode, afterSeq };
  mind.predictions.push(value); mind.revision++; return value;
}
/** Read recorded scoring only; duplicate forecasts do not create additional observed events. */
export function predictionFeedback(mind: AgentMind, closed = false): PredictionFeedback {
  const current = mind.predictions.filter(prediction => prediction.episode === mind.episode);
  const scored = current.filter(prediction => typeof prediction.result === "boolean" && prediction.sourceId && Number.isFinite(prediction.brier));
  const scoredIds = new Set(scored.map(prediction => prediction.id));
  const groups = new Map<string, string[]>();
  for (const prediction of scored) groups.set(prediction.sourceId!, [...(groups.get(prediction.sourceId!) ?? []), prediction.id]);
  const unscored = current.filter(prediction => !scoredIds.has(prediction.id)).map(prediction => ({ id: prediction.id,
    kind: prediction.kind, eventName: prediction.eventName, field: prediction.field, status: closed || prediction.expired ? "unverified" as const : "pending" as const }));
  return { forecastCount: current.length, actionForecastCount: current.filter(prediction => prediction.kind === "action").length,
    outcomeForecastCount: current.filter(prediction => prediction.kind === "outcome").length, scoredForecastCount: scored.length,
    uniqueScoredEventCount: groups.size, unscoredForecastCount: unscored.length,
    meanBrier: scored.length ? scored.reduce((sum, prediction) => sum + prediction.brier!, 0) / scored.length : null,
    eventGroups: [...groups].map(([sourceId, predictionIds]) => ({ sourceId, predictionIds })), unscored,
    note: "只统计本局正式账本评分。预测条数、唯一被验证事件数与结算次数不同；重复预测同一事件不增加事件样本。action 是行动预测，outcome 是结算预测。未验证不等于预测失败；叙述中的事后比较不补写评分。" };
}
function fieldValue(data: Record<string, unknown>, field: string): unknown {
  let value: unknown = data;
  for (const key of field.split(".")) {
    if (!value || typeof value !== "object" || ["__proto__", "prototype", "constructor"].includes(key) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
/** Outcomes come only from the visible environment ledger. A model cannot award itself a reward. */
export function integrateExperience(mind: AgentMind, event: Experience) {
  if (event.episode !== mind.episode || event.seq <= (mind.cursors[event.episode] ?? 0)) return false;
  mind.cursors[event.episode] = event.seq; mind.learning.observed++;
  for (const prediction of mind.predictions) {
    if (prediction.episode !== event.episode || prediction.afterSeq >= event.seq || prediction.result !== undefined || prediction.expired ||
      prediction.kind !== event.kind || prediction.eventName !== event.name || prediction.targetId &&
        (event.kind === "action" || event.actorId !== undefined) && prediction.targetId !== event.actorId) continue;
    const value = fieldValue(event.data, prediction.field);
    if (value === undefined || prediction.operator === "gte" && typeof value !== "number" || prediction.operator === "includes" && !Array.isArray(value)) continue;
    prediction.result = prediction.operator === "gte" ? (value as number) >= Number(prediction.expected)
      : prediction.operator === "includes" ? (value as unknown[]).includes(prediction.expected) : value === prediction.expected;
    prediction.sourceId = event.id; prediction.brier = (prediction.probability - Number(prediction.result)) ** 2;
    mind.learning.scored++; mind.learning.brierSum += prediction.brier;
  }
  for (const assessment of mind.strategyAssessments ?? []) {
    if (assessment.episode !== mind.episode || !assessment.decisionIds.length) continue;
    assessment.predictions = mind.predictions.filter(prediction => assessment.predictionIds.includes(prediction.id) && prediction.result !== undefined && prediction.sourceId && prediction.brier !== undefined)
      .map(prediction => ({ id: prediction.id, sourceId: prediction.sourceId!, result: prediction.result!, brier: prediction.brier! }));
  }
  if (event.reward) {
    const decisions = mind.decisions.filter(d => d.episode === event.episode && d.feedbackId === undefined &&
      (event.reward!.scope === "episode" ? d.round <= event.round : d.round === event.round));
    const decision = decisions.findLast(d => !["speak", "send_message", "wait"].includes(d.action));
    for (const item of decisions) { item.reward = event.reward.normalized; item.feedbackId = event.id; }
    for (const assessment of mind.strategyAssessments ?? []) {
      const related = decisions.filter(decision => isWorldDecision(decision) && decision.strategyBasis?.assessmentIds.includes(assessment.id));
      if (assessment.episode === event.episode && related.length && !assessment.feedback.some(feedback => feedback.sourceId === event.id))
        assessment.feedback.push({ sourceId: event.id, decisionIds: related.map(decision => decision.id), ...event.reward });
    }
    if (decision) {
      const aggregate = mind.learning.strategies[decision.strategy] ?? { samples: 0, meanReturn: 0, unit: "normalized-environment-return" as const };
      aggregate.samples++; aggregate.meanReturn += (event.reward.normalized - aggregate.meanReturn) / aggregate.samples;
      mind.learning.strategies[decision.strategy] = aggregate;
    }
    const actions = decisions.filter(isWorldDecision).map(({ id, action, round, parameters }) => ({ id, action, round, ...(parameters ? { parameters: structuredClone(parameters) } : {}) }));
    const decisionStructures = decisions.filter(isWorldDecision).flatMap(decision => decision.decisionStructure ? [structuredClone(decision.decisionStructure)] : []);
    const comparisons = decisions.filter(isWorldDecision).flatMap(decision => decision.payoffComparison && decision.parameters ? [{ decisionId: decision.id,
      analysis: structuredClone(decision.payoffComparison), feedback: payoffFeedback(decision.payoffComparison, decision.parameters, event.data, event.reward!.value) }] : []);
    const actionText = actions.length ? `本人实际行动：${actions.map(item => `第 ${item.round} 轮 ${item.action}${item.parameters ? ` ${JSON.stringify(item.parameters)}` : ""}`).join("；")}` : "这次结算没有待关联的本人实质行动";
    mind.memories.push({ id: crypto.randomUUID(), episode: mind.episode, kind: "episodic", scope: "transferable", origin: "ledger",
      sourceIds: [event.id], text: `${event.environment ? `${event.environment}，` : ""}第 ${event.round} 轮：${event.text}\n${actionText}。本次结算的本人回报 ${event.reward.value} ${event.reward.unit}（归一值 ${event.reward.normalized.toFixed(3)}）。这是关联样本，不是策略优越性的证明。`,
      observation: { sourceId: event.id, round: event.round, ...(event.environment ? { environment: event.environment } : {}), actions, reward: structuredClone(event.reward),
        ...(decisionStructures.length ? { decisionStructures } : {}), ...(comparisons.length ? { comparisons } : {}) },
      confidence: 1, tags: [...(decision ? [decision.strategy] : []), "observed-feedback"], when: null, then: null });
  }
  mind.revision++; return true;
}
/** Ready means a bounded hypothesis is available for later testing, never that it is effective. */
export function completeEpisodeReview(mind: AgentMind, proposal: z.infer<typeof episodeReviewParameters>, opportunityId: string) {
  const { strategyIds, ...record } = episodeReviewParameters.parse(proposal);
  if (mind.episodeReviews?.some(review => review.episode === mind.episode)) throw new Error("本局已经完成整局复盘");
  if (new Set(strategyIds).size !== strategyIds.length) throw new Error("复盘策略编号不能重复");
  const available = activeMemories(mind).filter(memory => memory.kind === "procedural" && memory.scope === "transferable" && memory.when && memory.then);
  const selected = strategyIds.map(id => available.find(memory => memory.id === id));
  if (selected.some(memory => !memory)) throw new Error("复盘只能引用当前有效的可迁移条件策略");
  if (record.status === "ready" && !selected.length) throw new Error("ready 须引用至少一条可供后续检验的策略；证据不足时使用 insufficient");
  if (record.status === "insufficient" && selected.length) throw new Error("insufficient 的 strategyIds 须为空，并在 summary 说明证据局限");
  const review = { ...record, episode: mind.episode, opportunityId, strategies: selected.map(memory => ({ id: memory!.id, revision: memory!.revision ?? 1 })),
    predictionFeedback: predictionFeedback(mind, true) };
  (mind.episodeReviews ??= []).push(review); mind.revision++; return review;
}
export function finishEpisode(mind: AgentMind) {
  if (!mind.learning.episodes.includes(mind.episode)) mind.learning.episodes.push(mind.episode);
  for (const prediction of mind.predictions) if (prediction.episode === mind.episode && prediction.result === undefined) prediction.expired = true;
  mind.revision++;
}
export function cognitionForPrompt(mind: AgentMind, memoryLimit = 16, selected?: readonly CognitiveMemory[]) {
  const limit = Math.max(0, Math.floor(memoryLimit)); const active = activeMemories(mind);
  const memories = selected ? selected.flatMap(memory => active.find(item => item.id === memory.id) ?? []) : limit ? active.slice(-limit) : [];
  return { version: mind.version, revision: mind.revision, emotions: mind.emotions, needs: mind.needs, appraisal: mind.appraisal,
    ...opponentViews(mind), plans: mind.plans.filter(p => p.status === "active"),
    memories: memories.slice(0, limit).map(memory => ({ ...memoryForPrompt(memory), ...(memory.kind === "procedural" ? { usage: strategyUsage(mind, memory) } : {}) })),
    strategyAssessments: (mind.strategyAssessments ?? []).filter(item => item.episode === mind.episode).slice(-4),
    episodeReview: mind.episodeReviews?.find(review => review.episode === mind.episode),
    predictions: mind.predictions.filter(p => p.episode === mind.episode && !p.expired).slice(-12), learning: mind.learning,
    note: "记忆是带来源的个人记录；推断、私人意图和公开声明都不等于世界事实。收益均值是观测关联，未作因果归因。" };
}
