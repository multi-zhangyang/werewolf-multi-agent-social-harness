import { tool, type Tool, type RunContext } from "@openai/agents";
import { z } from "zod";
import { PartnerAgentContext } from "./agent-context";
import { emotionSchema, forecastSchema, type MindDelta } from "./mind";
import { planDraftSchema } from "./plans";

const unit = z.number().min(0).max(1);
const amount = z.number().int().min(0).max(1_000_000);
const text = (max: number) => z.string().max(max).nullable();
export const appraisalSchema = z.object({
  eventId: z.string().min(1).describe("从可见事件选择短编号，如 e1；不要自行生成编号"), reason: z.string().min(1).max(400),
  emotions: emotionSchema.nullable(),
  needs: z.object({ security: unit, fairness: unit, affiliation: unit }).strict().nullable(),
  relationship: z.object({ willingness: unit, capability: unit, interpretation: z.string().min(1).max(360),
    alternative: z.string().min(1).max(360) }).strict().nullable(),
  conflict: text(280), regulation: z.enum(["none", "reappraise", "suppress_expression", "ruminate", "repair"]).nullable(),
  expression: text(240), memory: text(400),
}).strict();
const planFields = planDraftSchema.shape;
const planSchema = z.object({
  aim: planFields.aim, nextStep: planFields.nextStep,
  continueWhen: z.string().min(1).max(240), reviseWhen: z.string().min(1).max(240), abandonWhen: z.string().min(1).max(240),
  role: z.enum(["investor", "trustee", "any"]), fromRound: z.number().int().min(1), throughRound: z.number().int().min(1),
  phases: z.array(z.enum(["offer", "invest", "settle", "repair", "respond"])).min(1).max(5),
  /** A single optional financial precondition keeps the tool schema flat and unambiguous. */
  minimumWallet: amount.nullable(), targetWallet: amount.nullable(),
  eventId: z.string().min(1), reason: z.string().min(1).max(400),
}).strict();
type PlanInput = z.infer<typeof planSchema>;
function planDraft(value: PlanInput) {
  return { aim: value.aim, nextStep: value.nextStep, continueWhen: value.continueWhen,
    reviseWhen: value.reviseWhen, abandonWhen: value.abandonWhen,
    scope: { role: value.role, fromRound: value.fromRound, throughRound: value.throughRound, phases: value.phases },
    conditions: value.minimumWallet === null ? [] : [{ kind: "own-wallet-at-least" as const, amount: value.minimumWallet }],
    success: value.targetWallet === null ? null : { kind: "own-wallet-at-least" as const, amount: value.targetWallet } };
}
const existingPlan = { version: z.number().int().min(1), eventId: z.string().min(1), reason: z.string().min(1).max(400) };
const actionFields = { message: text(600), intent: text(600), basis: z.enum(["plan", "one-off"]) };
const isAction = new Set(["offer", "invest", "settle", "repair", "respond", "exit"]);
export const actionToolNames = [...isAction];
export const decisionInstructions = `你是合伙人世界中的当前人物。使用本人可见事实、私有目标和工具返回的正式心理与计划作出当前选择。
金额按 observation.legalActions 的范围填写。经营者收益是投资额乘自身固定生产率；承诺返还按实际收益计算。对方的收入声明和发言是声明，不能改写账本事实。你不知道对方私有心理和收入。
情绪与关系估计是你对可见事件的主观评价，没有规定应该更信任或更愤怒。appraise_event 中 null 保持原值；计划另用 create_plan、revise_plan、keep_plan、close_plan 管理。允许只作本次 one-off 选择。
出现 appraisalRequired 时先调用 appraise_event，读回执后再行动。修改心理、计划或预测后，在下一次响应中使用正式回执。每次只调用一个工具。工具错误返回后根据错误修正参数，不要重复同一无效请求。
可用 recall 查阅自己的可见旧事，forecast 登记一项对方未来真实机会的概率；预测可选，不能给已发生结果补写概率。
最后调用当前阶段的行动工具或 exit。basis=plan 表示使用有效计划，basis=one-off 表示仅作当前选择。message 是对外自然发言，intent 是私下目的。行动只暂存，完整运行结束后由规则与数据库提交。请用简短中文。`;
export const shadowInstructions = `这是独立的心理记录会话。行动已在另一个隔离会话中决定；你不能修改行动、登记预测或查看决定过程。
使用当前人物自己的可见事件和心理评价 appraisalRequired 事件。appraise_event 的 null 保持原值，计划另用对应工具操作；无需强制改变任何状态。
读取正式心理与计划回执后调用 finish_record 完成记录。每次只调用一个工具。用简短中文。`;

export function createPartnerTools(context: PartnerAgentContext, reportError: (name: string, error: unknown, args?: unknown) => string): Tool<PartnerAgentContext>[] {
  const evidenceRef = z.enum([...context.evidenceRefs.keys()] as [string, ...string[]])
    .describe("已经观察到的证据编号；从 recentEvents / appraisalRequired 选择。不是轮次 ID，也不是未来事件 ID。");
  const scopedPlanSchema = planSchema.extend({ eventId: evidenceRef });
  const common = (name: string) => ({
    isEnabled: () => !context.finished && (isAction.has(name) ? !context.shadow && !context.needsAppraisal &&
      (name === "exit" || context.observation.phase === name) : name === "appraise_event" ? context.mode !== "off" && !context.record.appraisal
      : name === "finish_record" ? context.shadow && !context.needsAppraisal
      : name === "create_plan" ? context.mode !== "off" && !context.needsAppraisal && !context.livePlan
      : ["revise_plan", "keep_plan", "close_plan"].includes(name) ? context.mode !== "off" && !context.needsAppraisal && context.livePlan
      : name === "forecast" ? context.mode !== "off" && !context.shadow && !context.needsAppraisal
      : name === "recall"),
    errorFunction: (ctx: RunContext<PartnerAgentContext>, error: unknown) => {
      return JSON.stringify({ ...JSON.parse(reportError(name, error, ctx.toolInput)),
        allowedEvidenceIds: [...context.evidenceRefs.keys()], legalActions: context.observation.legalActions });
    },
  });
  const tools: Tool<PartnerAgentContext>[] = [
    tool({ name: "recall", description: "检索本人可见的旧事件和个人经历，不读取对方私有信息。", parameters: z.object({ query: z.string().min(1).max(100) }).strict(),
      ...common("recall"), execute: async ({ query }) => {
        context.assertOpen();
        return context.displayReferences({ events: context.observation.events.filter(event => event.summary.includes(query)).slice(-8),
          memories: context.memories.filter(memory => memory.text.includes(query)).slice(-5) });
      } }),
    tool({ name: "appraise_event", description: "评价一个本人可见事件。nullable 分组填写 null 就保留旧值；填写对象则提供该组完整字段。只更新心理，计划使用独立工具。", parameters: appraisalSchema.extend({ eventId: evidenceRef }),
      ...common("appraise_event"), execute: async raw => context.appraise({ ...raw, sourceIds: [raw.eventId], plan: null, predictions: [] } as MindDelta) }),
    tool({ name: "create_plan", description: "新建自己的持续计划，范围必须含未来合法机会。minimumWallet 为前提，targetWallet 为完成条件；null 表示无该条件。", parameters: scopedPlanSchema,
      ...common("create_plan"), execute: async raw => context.plan({ kind: "create", plan: planDraft(raw) }, raw.eventId, raw.reason) }),
    tool({ name: "revise_plan", description: "按正式 version 修订已有计划。填写完整的新计划，不能用 create_plan 覆盖已有计划。", parameters: scopedPlanSchema.extend({ version: existingPlan.version }).strict(),
      ...common("revise_plan"), execute: async raw => context.plan({ kind: "revise", version: raw.version, plan: planDraft(raw) }, raw.eventId, raw.reason) }),
    tool({ name: "keep_plan", description: "确认继续有效的正式计划。过期或不适用计划需修订、关闭或作 one-off 选择。", parameters: z.object({ ...existingPlan, eventId: evidenceRef }).strict(),
      ...common("keep_plan"), execute: async raw => context.plan({ kind: "keep", version: raw.version }, raw.eventId, raw.reason) }),
    tool({ name: "close_plan", description: "关闭已有计划。abandon 表示主动放弃；satisfy 表示已完成，已登记完成条件须满足。", parameters: z.object({ ...existingPlan, eventId: evidenceRef, reasonForClosing: z.enum(["abandon", "satisfy"]) }).strict(),
      ...common("close_plan"), execute: async raw => context.plan({ kind: raw.reasonForClosing, version: raw.version }, raw.eventId, raw.reason) }),
    tool({ name: "forecast", description: "根据已观察证据，登记对方未来合法机会的概率；eventId 是既有证据编号，metric 达到 threshold 算发生，continue 的阈值用 1。", parameters: forecastSchema.extend({ eventId: evidenceRef }).strict(),
      ...common("forecast"), execute: async ({ eventId, ...proposal }) => context.forecast(proposal, eventId) }),
    tool({ name: "offer", description: "经营者报价并冻结自己的担保；违约时担保赔给本轮投资人。暂存当前真实行动。", parameters: z.object({ promiseRatio: unit, collateral: amount, ...actionFields }).strict(),
      ...common("offer"), execute: async ({ message, intent, basis, ...action }) => context.stage({ type: "offer", ...action, ...(message ? { message } : {}), ...(intent ? { intent } : {}) }, basis) }),
    tool({ name: "invest", description: "投资人投入整数金额，范围见合法行动。暂存当前真实行动。", parameters: z.object({ amount, ...actionFields }).strict(),
      ...common("invest"), execute: async ({ message, intent, basis, ...action }) => context.stage({ type: "invest", ...action, ...(message ? { message } : {}), ...(intent ? { intent } : {}) }, basis) }),
    tool({ name: "settle", description: "经营者实际返还资金。claimedIncome 为对外收入声明或 null；revealIncome 决定是否公开真实凭证。声明无法改变规则裁决。", parameters: z.object({ returnAmount: amount, claimedIncome: amount.nullable(), revealIncome: z.boolean(), ...actionFields }).strict(),
      ...common("settle"), execute: async ({ message, intent, basis, claimedIncome, ...action }) => context.stage({ type: "settle", ...action, ...(claimedIncome !== null ? { claimedIncome } : {}), ...(message ? { message } : {}), ...(intent ? { intent } : {}) }, basis) }),
    tool({ name: "repair", description: "经营者付出真实补偿，可以填 0；message 可表达道歉，不替代资金行为。", parameters: z.object({ compensation: amount, ...actionFields }).strict(),
      ...common("repair"), execute: async ({ message, intent, basis, ...action }) => context.stage({ type: "repair", ...action, ...(message ? { message } : {}), ...(intent ? { intent } : {}) }, basis) }),
    tool({ name: "respond", description: "投资人决定继续或结束合作。最后一轮 continue 后也会结算并结束。", parameters: z.object({ choice: z.enum(["continue", "exit"]), ...actionFields }).strict(),
      ...common("respond"), execute: async ({ message, intent, basis, ...action }) => context.stage({ type: "respond", ...action, ...(message ? { message } : {}), ...(intent ? { intent } : {}) }, basis) }),
    tool({ name: "exit", description: "立即结束合作并结算到期负担。暂存真实行动，不能用作试算。", parameters: z.object(actionFields).strict(),
      ...common("exit"), execute: async ({ message, intent, basis }) => context.stage({ type: "exit", ...(message ? { message } : {}), ...(intent ? { intent } : {}) }, basis) }),
    tool({ name: "finish_record", description: "读取正式心理与计划回执后结束独立记录，不决定行动。", parameters: z.object({}).strict(),
      ...common("finish_record"), execute: async () => {
        context.assertOpen();
        if (context.needsAppraisal || context.lastMutationTurn >= context.turn) throw new Error("先读取正式心理回执，再结束记录");
        context.recordFinished = true; return { recorded: true, mindVersion: context.mind.version };
      } }),
  ];
  return tools;
}
