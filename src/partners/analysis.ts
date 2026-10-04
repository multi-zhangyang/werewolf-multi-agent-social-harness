import type { Mechanism, RunStatus, StudyRow, StudyView } from "./api-types";
import type { ActorId, Deal, WorldEvent, WorldState } from "./contracts";
import type { Forecast, PartnerMind } from "./mind";

export interface StudyAnalysisRun {
  world: WorldState;
  minds: Record<ActorId, PartnerMind>;
}

export const studyMetricNames = ["promiseRatio", "collateral", "returned", "returnRatio", "compensation", "investment", "payoff", "obligationShortfall"] as const;
export type StudyMetric = typeof studyMetricNames[number];
type Condition = StudyRow["condition"];
type Metrics = Record<StudyMetric, number | null>;

export interface Distribution {
  n: number;
  missing: number;
  values: number[];
  mean: number | null;
  median: number | null;
  range: [number, number] | null;
  ci95: [number, number] | null;
  uncertainty: "insufficient" | "bootstrap";
}

export interface PredictionSummary {
  pending: number;
  unscored: number;
  scored: number;
  invalidScored: number;
  brier: Distribution;
}

export interface BehaviorAudit {
  actorId: ActorId;
  round: number;
  eventId: string;
  experimentalSetup: boolean;
  promiseRatio: number | null;
  returned: number | null;
  actualIncome: number | null;
  claimedIncome: number | null;
  claimedMinusActual: number | null;
  breachVerdict: boolean | null;
  voluntarilyDisclosed: boolean;
  priorIntentDeclarations: { eventId: string; revision: number; text: string; actionType: string | null }[];
  mindRevisionsBeforeAction: PartnerMind["changes"];
  mindRevisionsAfterAction: PartnerMind["changes"];
}

export interface AnalyzedBranch {
  runId: string;
  condition: Condition;
  agreeableness: number;
  mechanism: Mechanism;
  repeat: number;
  status: RunStatus;
  error: string | null;
  worldAvailable: boolean;
  dataIssues: string[];
  metrics: Metrics;
  evidence: Record<StudyMetric, string | null>;
  missingReasons: Record<StudyMetric, string | null>;
  predictions: PredictionSummary;
  predictionsByActor: Record<ActorId, PredictionSummary>;
  audit: BehaviorAudit[];
  subjectiveJudgments: null | { willingness: number; capability: number; interpretation: string; alternative: string; sourceIds: string[] };
}

export interface AnalysisGroup {
  condition: Condition;
  agreeableness: number;
  mechanism: Mechanism;
  total: number;
  missingWorlds: number;
  statuses: Record<RunStatus, number>;
  metrics: Record<StudyMetric, Distribution>;
  predictions: PredictionSummary;
}

export interface PairedMetricEffect extends Distribution {
  pairs: { repeat: number; controlRunId: string; treatmentRunId: string; control: number; treatment: number; difference: number }[];
  /** Standardized paired mean difference; null for fewer than two pairs or zero variance. */
  cohensDz: number | null;
}

export interface PairedRepairEffect {
  control: "none";
  treatment: "apology" | "compensation";
  agreeableness: number;
  mechanism: Mechanism;
  repeatKeys: number;
  matchedBranchPairs: number;
  ambiguousRepeatKeys: number;
  metrics: Record<StudyMetric, PairedMetricEffect>;
}

export interface GroupContrast {
  factor: "agreeableness" | "mechanism";
  condition: Condition;
  control: number | Mechanism;
  treatment: number | Mechanism;
  heldConstant: { mechanism: Mechanism } | { agreeableness: number };
  metrics: Record<StudyMetric, { controlN: number; treatmentN: number; meanDifference: number | null }>;
}

export interface StudyAnalysis {
  schemaVersion: 1;
  studyId: string;
  exploratory: true;
  researcherOnly: true;
  targetActorId: "a";
  method: { bootstrapSamples: number; bootstrapSeed: number; interval: "percentile bootstrap of mean, 95%"; minimumForInterval: 2 };
  definitions: Record<StudyMetric, string>;
  notes: string[];
  totals: { rows: number; worldsAvailable: number; statuses: Record<RunStatus, number>; issues: number };
  branches: AnalyzedBranch[];
  groups: AnalysisGroup[];
  pairedRepairEffects: PairedRepairEffect[];
  groupContrasts: GroupContrast[];
  predictions: PredictionSummary;
}

const bootstrapSamples = 2000;
const conditions: Condition[] = ["none", "apology", "compensation"];
const actorIds: ActorId[] = ["a", "b"];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const numeric = (value: unknown): number | null => finite(value) ? value : null;
const metricsFrom = <T>(factory: (metric: StudyMetric) => T): Record<StudyMetric, T> => Object.fromEntries(studyMetricNames.map(metric => [metric, factory(metric)])) as Record<StudyMetric, T>;
const statuses = (): Record<RunStatus, number> => ({ paused: 0, running: 0, "waiting-human": 0, completed: 0, failed: 0, stopped: 0 });

function hash(seed: number, key: string): number {
  let result = seed >>> 0;
  for (const char of key) result = Math.imul(result ^ char.charCodeAt(0), 16777619) >>> 0;
  return result;
}
function quantile(sorted: number[], probability: number): number {
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** Raw values remain in the export; bootstrap never fills in a missing observation. */
export function distribution(values: number[], total: number, seed: number): Distribution {
  const valid = values.filter(finite);
  const sorted = [...valid].sort((a, b) => a - b);
  const n = valid.length;
  let ci95: Distribution["ci95"] = null;
  if (n >= 2) {
    let random = seed >>> 0;
    const means = Array.from({ length: bootstrapSamples }, () => {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        sum += valid[Math.floor(random / 4294967296 * n)];
      }
      return sum / n;
    }).sort((a, b) => a - b);
    ci95 = [quantile(means, 0.025), quantile(means, 0.975)];
  }
  return { n, missing: Math.max(0, total - n), values: [...valid], mean: n ? valid.reduce((a, b) => a + b, 0) / n : null,
    median: n ? quantile(sorted, 0.5) : null, range: n ? [sorted[0], sorted[n - 1]] : null, ci95,
    uncertainty: n >= 2 ? "bootstrap" : "insufficient" };
}

function uniqueDeals(world: WorldState): Deal[] {
  return [...new Map([...world.completedDeals, world.deal].map(deal => [deal.id, deal])).values()];
}
function findEvent(world: WorldState, kind: WorldEvent["kind"], round: number, actorId: ActorId): { event: WorldEvent | null; deal: Deal | null; reason: string | null } {
  const role = kind === "investment" || kind === "response" ? "investor" : "trustee";
  const deals = uniqueDeals(world).filter(deal => deal.round === round && deal[role] === actorId);
  if (deals.length !== 1) return { event: null, deal: null, reason: "该轮合法角色或交易记录缺失" };
  const found = world.events.filter(event => event.kind === kind && event.round === round && event.actor === actorId && event.data.dealId === deals[0].id);
  if (found.length !== 1) return { event: null, deal: deals[0], reason: found.length ? "同一机会存在重复事件，未评分" : "该合法行动机会尚未发生或被跳过" };
  return { event: found[0], deal: deals[0], reason: null };
}

/** Recompute scores against real event evidence, rather than trusting a stored Brier number. */
function verifiedBrier(prediction: Forecast, actorId: ActorId, world: WorldState): number | null {
  if (!finite(prediction.probability) || prediction.probability < 0 || prediction.probability > 1 || !finite(prediction.threshold)) return null;
  const event = world.events.find(event => event.id === prediction.evidenceId && event.revision > prediction.createdRevision
    && event.actor === prediction.targetActorId && event.round === prediction.round && (event.visibility === "public" || event.visibility === actorId));
  const expectedKind = { offer: "offer", invest: "investment", settle: "settlement", repair: "repair", respond: "response" }[prediction.action];
  if (!event || event.kind !== expectedKind) return null;
  const observed = prediction.metric === "continue" ? event.data.choice === "continue" ? 1 : event.data.choice === "exit" ? 0 : null : numeric(event.data[prediction.metric]);
  if (observed === null) return null;
  return (prediction.probability - Number(observed >= prediction.threshold)) ** 2;
}
function predictionSummary(predictions: Forecast[], actorId: ActorId, world: WorldState | undefined, seed: number): PredictionSummary {
  const scored = predictions.filter(prediction => prediction.status === "scored");
  const brier = scored.flatMap(prediction => {
    const value = world ? verifiedBrier(prediction, actorId, world) : null;
    return value === null ? [] : [value];
  });
  return { pending: predictions.filter(prediction => prediction.status === "pending").length,
    unscored: predictions.filter(prediction => prediction.status === "unscored").length,
    scored: scored.length, invalidScored: scored.length - brier.length, brier: distribution(brier, scored.length, seed) };
}
function mergePredictions(summaries: PredictionSummary[], seed: number): PredictionSummary {
  const sum = (key: "pending" | "unscored" | "scored" | "invalidScored") => summaries.reduce((total, summary) => total + summary[key], 0);
  return { pending: sum("pending"), unscored: sum("unscored"), scored: sum("scored"), invalidScored: sum("invalidScored"),
    brier: distribution(summaries.flatMap(summary => summary.brier.values), sum("scored"), seed) };
}

function auditBehavior(world: WorldState, minds: Record<ActorId, PartnerMind>): BehaviorAudit[] {
  const deals = uniqueDeals(world);
  return world.events.filter(event => event.kind === "settlement" && event.actor !== null).map(event => {
    const actorId = event.actor!;
    const deal = deals.find(deal => deal.id === event.data.dealId && deal.trustee === actorId);
    const claimedIncome = numeric(event.data.claimedIncome);
    const actualIncome = numeric(deal?.grossIncome);
    const changes = minds[actorId]?.changes ?? [];
    return { actorId, round: event.round, eventId: event.id, experimentalSetup: event.round === 1,
      promiseRatio: numeric(deal?.promiseRatio), returned: numeric(event.data.returnAmount), actualIncome, claimedIncome,
      claimedMinusActual: claimedIncome !== null && actualIncome !== null ? claimedIncome - actualIncome : null,
      breachVerdict: typeof deal?.breached === "boolean" ? deal.breached : null,
      voluntarilyDisclosed: deal?.incomeRevealed ?? false,
      priorIntentDeclarations: world.events.filter(intent => intent.kind === "intent" && intent.actor === actorId
        && intent.round === event.round && intent.seq < event.seq).map(intent => ({ eventId: intent.id, revision: intent.revision,
        text: typeof intent.data.text === "string" ? intent.data.text : intent.summary,
        actionType: typeof intent.data.actionType === "string" ? intent.data.actionType : null })),
      // A mind change evaluated at the settlement revision saw its result; it is retrospective.
      mindRevisionsBeforeAction: structuredClone(changes.filter(change => change.revision < event.revision)),
      mindRevisionsAfterAction: structuredClone(changes.filter(change => change.revision >= event.revision)),
    };
  });
}

function analyzeBranch(row: StudyRow, run: StudyAnalysisRun | undefined, seed: number, duplicate: boolean): AnalyzedBranch {
  const world = run?.world;
  const metrics: Metrics = metricsFrom(() => null);
  const evidence = metricsFrom<string | null>(() => null);
  const missingReasons = metricsFrom<string | null>(() => world ? "合法行动尚未发生或结果未评分" : duplicate ? "世界标识重复，无法确定对应数据" : "缺少世界记录");
  const dataIssues = world ? [] : [duplicate ? "duplicate_world" : "missing_world"];
  if (world) {
    const assign = (metric: StudyMetric, kind: WorldEvent["kind"], round: number, field: string) => {
      const found = findEvent(world, kind, round, "a");
      const value = numeric(found.event?.data[field]);
      metrics[metric] = value;
      evidence[metric] = value !== null ? found.event!.id : null;
      missingReasons[metric] = value !== null ? null : found.reason ?? "事件未包含有效数值";
      return found;
    };
    assign("promiseRatio", "offer", 2, "promiseRatio");
    assign("collateral", "offer", 2, "collateral");
    const settlement = assign("returned", "settlement", 2, "returnAmount");
    if (metrics.returned !== null && finite(settlement.deal?.grossIncome) && settlement.deal.grossIncome > 0) {
      metrics.returnRatio = metrics.returned / settlement.deal.grossIncome;
      evidence.returnRatio = settlement.event!.id; missingReasons.returnRatio = null;
    } else missingReasons.returnRatio = settlement.deal?.grossIncome === 0 ? "实际到账为 0，返还比例未评分" : settlement.reason ?? "缺少可评分的真实到账或返还事件";
    assign("compensation", "repair", 2, "compensation");
    assign("investment", "investment", 3, "amount");
    const closed = world.events.find(event => event.kind === "closed");
    if (world.phase === "finished" && closed) {
      metrics.payoff = world.actors.a.wallet - world.actors.a.initialWallet;
      metrics.obligationShortfall = world.actors.a.obligationShortfall;
      evidence.payoff = evidence.obligationShortfall = closed.id;
      missingReasons.payoff = missingReasons.obligationShortfall = null;
    } else missingReasons.payoff = missingReasons.obligationShortfall = "对局尚未结清，终局收益未观测";
  }
  const predictionsByActor = Object.fromEntries(actorIds.map(id => [id, predictionSummary(run?.minds[id]?.predictions ?? [], id, world, hash(seed, `${row.runId}:${id}`))])) as Record<ActorId, PredictionSummary>;
  const relationship = row.mechanism !== "no-mind" ? run?.minds.a.relationship : undefined;
  return { runId: row.runId, condition: row.condition, agreeableness: row.agreeableness, mechanism: row.mechanism,
    repeat: row.repeat, status: row.status, error: row.error ?? null, worldAvailable: Boolean(world), dataIssues,
    metrics, evidence, missingReasons, predictionsByActor,
    predictions: mergePredictions(Object.values(predictionsByActor), hash(seed, row.runId)),
    audit: world && run ? auditBehavior(world, run.minds) : [],
    subjectiveJudgments: relationship ? structuredClone(relationship) : null };
}

function pairedEffects(branches: AnalyzedBranch[], seed: number): PairedRepairEffect[] {
  const factors = [...new Map(branches.map(branch => [`${branch.agreeableness}:${branch.mechanism}`, { agreeableness: branch.agreeableness, mechanism: branch.mechanism }])).values()];
  return factors.flatMap(factor => (["apology", "compensation"] as const).map(treatment => {
    const candidates = branches.filter(branch => branch.agreeableness === factor.agreeableness && branch.mechanism === factor.mechanism
      && (branch.condition === "none" || branch.condition === treatment));
    const repeats = [...new Set(candidates.map(branch => branch.repeat))].sort((a, b) => a - b);
    let ambiguousRepeatKeys = 0;
    const matched = repeats.flatMap(repeat => {
      const control = candidates.filter(branch => branch.repeat === repeat && branch.condition === "none");
      const treated = candidates.filter(branch => branch.repeat === repeat && branch.condition === treatment);
      if (control.length > 1 || treated.length > 1) ambiguousRepeatKeys++;
      return control.length === 1 && treated.length === 1 ? [{ repeat, control: control[0], treatment: treated[0] }] : [];
    });
    return { control: "none" as const, treatment, ...factor, repeatKeys: repeats.length, matchedBranchPairs: matched.length, ambiguousRepeatKeys,
      metrics: metricsFrom(metric => {
        const pairs = matched.flatMap(pair => {
          const control = pair.control.metrics[metric], treated = pair.treatment.metrics[metric];
          return control !== null && treated !== null ? [{ repeat: pair.repeat, controlRunId: pair.control.runId, treatmentRunId: pair.treatment.runId,
            control, treatment: treated, difference: treated - control }] : [];
        });
        const result = distribution(pairs.map(pair => pair.difference), repeats.length, hash(seed, `${factor.agreeableness}:${factor.mechanism}:${treatment}:${metric}`));
        const variance = result.n >= 2 ? result.values.reduce((sum, value) => sum + (value - result.mean!) ** 2, 0) / (result.n - 1) : 0;
        return { ...result, pairs, cohensDz: variance > 0 ? result.mean! / Math.sqrt(variance) : null };
      }) };
  }));
}

function contrasts(groups: AnalysisGroup[]): GroupContrast[] {
  const result: GroupContrast[] = [];
  for (const condition of conditions) {
    const selected = groups.filter(group => group.condition === condition);
    const add = (control: AnalysisGroup, treatment: AnalysisGroup, factor: GroupContrast["factor"]) => result.push({ factor, condition,
      control: control[factor], treatment: treatment[factor],
      heldConstant: factor === "agreeableness" ? { mechanism: control.mechanism } : { agreeableness: control.agreeableness },
      metrics: metricsFrom(metric => ({ controlN: control.metrics[metric].n, treatmentN: treatment.metrics[metric].n,
        meanDifference: control.metrics[metric].mean !== null && treatment.metrics[metric].mean !== null ? treatment.metrics[metric].mean! - control.metrics[metric].mean! : null })) });
    for (const mechanism of [...new Set(selected.map(group => group.mechanism))]) {
      const ordered = selected.filter(group => group.mechanism === mechanism).sort((a, b) => a.agreeableness - b.agreeableness);
      for (let i = 1; i < ordered.length; i++) add(ordered[0], ordered[i], "agreeableness");
    }
    for (const agreeableness of [...new Set(selected.map(group => group.agreeableness))]) {
      const full = selected.find(group => group.agreeableness === agreeableness && group.mechanism === "full");
      if (full) for (const comparison of selected.filter(group => group.agreeableness === agreeableness && group.mechanism !== "full")) add(full, comparison, "mechanism");
    }
  }
  return result;
}

/** Research-only analysis. Failed branches remain in denominators; no outcome is imputed. */
export function analyzeStudy(study: StudyView, runs: StudyAnalysisRun[]): StudyAnalysis {
  const seed = study.spec.seed >>> 0;
  const byId = new Map<string, StudyAnalysisRun>();
  const duplicates = new Set<string>();
  for (const run of runs) { if (byId.has(run.world.id)) duplicates.add(run.world.id); byId.set(run.world.id, run); }
  const branches = study.rows.map(row => analyzeBranch(row, duplicates.has(row.runId) ? undefined : byId.get(row.runId), seed, duplicates.has(row.runId)));
  const groupMap = new Map<string, AnalyzedBranch[]>();
  for (const branch of branches) {
    const key = `${branch.condition}:${branch.agreeableness}:${branch.mechanism}`;
    groupMap.set(key, [...(groupMap.get(key) ?? []), branch]);
  }
  const groups = [...groupMap.entries()].map(([key, group]): AnalysisGroup => {
    const first = group[0], statusCounts = statuses();
    for (const branch of group) statusCounts[branch.status]++;
    return { condition: first.condition, agreeableness: first.agreeableness, mechanism: first.mechanism, total: group.length,
      missingWorlds: group.filter(branch => !branch.worldAvailable).length, statuses: statusCounts,
      metrics: metricsFrom(metric => distribution(group.flatMap(branch => branch.metrics[metric] === null ? [] : [branch.metrics[metric]!]), group.length, hash(seed, `${key}:${metric}`))),
      predictions: mergePredictions(group.map(branch => branch.predictions), hash(seed, `${key}:predictions`)) };
  });
  const statusCounts = statuses();
  for (const branch of branches) statusCounts[branch.status]++;
  return { schemaVersion: 1, studyId: study.id, exploratory: true, researcherOnly: true, targetActorId: "a",
    method: { bootstrapSamples, bootstrapSeed: seed, interval: "percentile bootstrap of mean, 95%", minimumForInterval: 2 },
    definitions: {
      promiseRatio: "目标人物 a 在第二轮经营角色实际提出的承诺比例。",
      collateral: "目标人物 a 在第二轮经营角色实际冻结的担保资源。",
      returned: "目标人物 a 在第二轮实际返还的资源。",
      returnRatio: "第二轮实际返还 / 研究账本中的实际到账；实际到账为 0 则未评分，额外自有资金返还可能使比例大于 1。",
      compensation: "目标人物 a 在第二轮 repair 行动实际追加的补偿；尚未出现 repair 事件时为缺失。",
      investment: "目标人物 a 在第三轮合法投资机会实际投入的资源；退出或未到该机会为缺失。",
      payoff: "终局结清私人负担后的剩余余额减初始余额；未结清时为缺失。",
      obligationShortfall: "终局未付清的私人负担，独立于余额收益报告。",
    },
    notes: [
      "本报告是探索性描述，行为差异或无差异都是结果；不按显著性或戏剧性筛选样本。",
      "失败、停止和未完成分支保留。仅已实际发生的行为进入对应指标分布，missing 明示未观察数量；这不保证缺失是随机的。",
      "修复条件效应为 treatment − none，按 repeat、宜人性和机制配对。补偿同时改变资源和社会信号，不能分离解释为道歉效果。",
      "95% 区间为固定种子的 2000 次百分位 bootstrap，按分支观测或配对差值重采样；n < 2 标记 insufficient，小样本区间仅供探索。",
      "groupContrasts 是组均值差描述，尚未调整缺失、运行顺序、多重比较或任何其他混杂因素。",
      "第一轮的失约是实验设置；审计只列原话数字与账本差异、事前意图声明和时间对齐的心理修订，不将失约或低返还自动标为欺骗、报复。意图声明本身也是自我报告。",
      "收入差异审计只比较结构化 claimedIncome 与实际到账，不自动解析自由发言中的金额或推定说话者的真实动机。",
      "Brier 只对带有真实可见事件证据的 scored 预测重新计算；pending、unscored 和无法验证的 scored 不计入均分。",
      "预测分数的 bootstrap 按预测条目重采样，未校正同一人物和分支内的相关性；它是诊断性描述，不用于独立样本的显著性推断。",
      "合作意愿与能力是模拟主体的主观判断。此版本的私人负担影响保留动机和终局收益，没有操控客观履约能力冲击。",
    ],
    totals: { rows: branches.length, worldsAvailable: branches.filter(branch => branch.worldAvailable).length, statuses: statusCounts,
      issues: branches.reduce((sum, branch) => sum + branch.dataIssues.length, 0) },
    branches, groups, pairedRepairEffects: pairedEffects(branches, seed), groupContrasts: contrasts(groups),
    predictions: mergePredictions(branches.map(branch => branch.predictions), hash(seed, "all-predictions")) };
}
