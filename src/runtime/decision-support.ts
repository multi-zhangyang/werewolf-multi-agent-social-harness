import { z } from "zod";
import type { DecisionStructure, PayoffComparison, PayoffOption } from "../agents/decision-analysis";
import { contributionPayoff, signalingBreakEven, signalingPayoffTable, signalingPayoffText, signalingPayoffs, signalingQualityPrior, trustPayoffs } from "./scenarios/payoffs";
import type { AgentMind } from "../agents/cognition";
import { behaviorBelief, behaviorKey, createBehaviorModel, type BehaviorContext } from "../agents/behavior-model";
import { sameChoice } from "../agents/decision-analysis";
import type { RunSpec, TurnContext } from "./types";

const supported = new Set(["declare_quality", "choose_offer", "invest", "return_funds", "contribute", "repair_transfer"]);
const probability = z.number().min(0).max(1);
const rationale = z.string().trim().min(1).max(600).describe("说明概率假设的依据、替代解释，以及未计入本轮点数的信誉或关系后果；不是要求给出确定结论");
const amountBeliefs = (field: string, max: number) => z.array(z.object({ [field]: z.number().int().min(0).max(max), probability }).strict()).min(1).max(6);
interface Proposal {
  rationale: string;
  otherContributions?: Array<{ otherTotal: number; probability: number }>;
  options: Array<{ label: string; choice: Record<string, unknown>; returns?: Array<{ returned: number; probability: number }> }>;
}

export function signalingDecisionSupport(input: TurnContext, spec: RunSpec, mind?: AgentMind) {
  const facts = input.worldObservation?.facts;
  if (spec.scenario !== "signaling-game" || !facts || !["sender", "receiver"].includes(String(facts.ownRole))) return;
  const role = facts.ownRole as "sender" | "receiver";
  const context: BehaviorContext = { opponentId: String(role === "sender" ? facts.receiverId : facts.senderId), role,
    incentives: spec.signalingIncentives, payoffProfile: spec.signalingPayoffProfile ?? "legacy", objective: spec.experiment.objective ?? "character" };
  const model = mind?.behaviorModels?.[behaviorKey(context)] ?? createBehaviorModel(context);
  const belief = behaviorBelief(model, signalingQualityPrior, signalingBreakEven(context.incentives, context.payoffProfile),
    typeof facts.reportedHighQuality === "boolean" ? facts.reportedHighQuality : undefined);
  const knownQuality = (facts.privateInformation as { highQuality?: boolean } | undefined)?.highQuality;
  if (role === "sender") {
    if (typeof knownQuality !== "boolean") return;
    belief.knownHighQuality = knownQuality;
  }
  const options: PayoffOption[] = [true, false].map(choice => {
    const sender = role === "sender";
    const probability = sender ? (choice ? belief.high : belief.low).probability : belief.highQualityProbability!;
    const branches = [true, false].map((value): PayoffOption["branches"][number] => {
      const payoff = signalingPayoffs(context.incentives, sender ? knownQuality! : value, sender ? value : choice, context.payoffProfile);
      return { probability: value ? probability : 1 - probability, condition: sender ? { accepted: value } : { highQuality: value },
        own: sender ? payoff.sender : payoff.receiver, others: sender ? payoff.receiver : payoff.sender };
    });
    return { label: sender ? choice ? "报告高质量" : "报告低质量" : choice ? "接受" : "拒绝", parameters: sender ? { highQuality: choice } : { accept: choice }, branches,
      expectedOwn: branches.reduce((sum, branch) => sum + branch.probability * branch.own, 0), expectedOthers: branches.reduce((sum, branch) => sum + branch.probability * branch.others, 0),
      ownRange: [Math.min(...branches.map(branch => branch.own)), Math.max(...branches.map(branch => branch.own))],
      ...(sender ? { reportAccurate: choice === knownQuality } : {}) };
  });
  return { belief, options };
}

/** This module has no world handle: calculations see exactly the actor's authorized observation. */
export function decisionStructure(input: TurnContext, spec: RunSpec): DecisionStructure | undefined {
  const facts = input.worldObservation?.facts;
  if (!facts) return;
  const horizon = typeof facts.rounds === "number" ? input.opportunity.stage.round < facts.rounds ? "repeated" : "final" : "unknown";
  if (spec.scenario === "signaling-game") return { information: facts.ownRole === "sender" ? "private-information" : "unverified-claim",
    control: facts.ownRole === "sender" ? "signal" : "accept-or-reject", verification: "after-decision", incentives: spec.signalingIncentives, horizon };
  if (spec.scenario === "public-goods") return { information: "sealed-actions", control: "contribute", verification: "after-decision", incentives: "mixed", horizon };
  if (spec.scenario === "werewolf") return { information: "hidden-roles", control: "social-deduction", verification: "after-decision", incentives: "conflicting", horizon };
  return { information: facts.ownRole === "investor" ? "unverified-claim" : "public-history",
    control: facts.phaseId === "repair" ? "compensate" : facts.phaseId === "pledge" ? "signal" : facts.ownRole === "investor" ? "entrust" : "distribute",
    verification: "public-action", incentives: "mixed", horizon };
}

export function strategicBrief(input: TurnContext, spec: RunSpec, mind?: AgentMind) {
  const structure = decisionStructure(input, spec);
  if (!structure) return;
  const facts = input.worldObservation!.facts;
  const shared = { structure, remainingRounds: typeof facts.rounds === "number" ? facts.rounds - input.opportunity.stage.round : null,
    objective: spec.experiment.objective === "score" ? "唯一决策目标是提高本人的整局累计点数。信誉仅在影响后续所得时有工具价值；诚实、公平或关系不是独立收益。"
      : spec.scenario === "werewolf" ? "依据本人已知身份追求本阵营获胜；陈述、身份猜测和真实身份须分开。"
      : "比较自己的累计所得、风险及人物的关系/公平目标；若牺牲点数换取其他目标，明确承认代价。",
    discipline: "先比较合法选择及对手可能反应，再选实际参数。谨慎、合作或欺骗都不是默认答案。区分已知事实、概率假设和个人偏好。" };
  if (spec.scenario === "signaling-game") {
    const history = (facts.history ?? []) as Array<{ reportedHighQuality: boolean; highQuality: boolean; accepted: boolean }>;
    return { ...shared, independentQualityPrior: signalingQualityPrior, receiverBreakEvenHighProbability: signalingBreakEven(spec.signalingIncentives, spec.signalingPayoffProfile),
      evidenceEstimate: signalingDecisionSupport(input, spec, mind), payoffTable: signalingPayoffTable(spec.signalingIncentives, spec.signalingPayoffProfile),
      observedReports: [true, false].map(report => {
        const rows = history.filter(row => row.reportedHighQuality === report);
        return { reportedHighQuality: report, count: rows.length, actualHigh: rows.filter(row => row.highQuality).length, accepted: rows.filter(row => row.accepted).length };
      }),
      reasoning: `${signalingPayoffText(spec.signalingIncentives, spec.signalingPayoffProfile)}证据概率来自同一对手、角色、收益条件和目标模式的真实结算，Beta(1,1)平滑，历史每轮衰减0.9；零样本是先验，不是掌握了对手心理。接收者按报告似然反推质量，发送者按报告后的接受样本估计；后者只是观察关联，不是换报告的因果效果。说明和标签不能改写概率。公开发言不是新增统计样本，未选动作不会获得虚构反馈。` };
  }
  if (spec.scenario === "trust-game") return { ...shared,
    reasoning: "投资者与不投资得10相比，期望返还高于投资额才增加本轮期望点数；返还比例超过到账的1/3为盈亏平衡。受托者每多返还1点少留1点；未来互惠、承诺与公平另行权衡。承诺不强制执行，补偿真实减少自己的累计所得。" };
  if (spec.scenario === "public-goods") return { ...shared, ownMarginalReturn: -1 + 1.6 / spec.roster.length,
    reasoning: "当轮其他人的密封投入不因你改选而变化；自己的投入每增加1点，全体总收益增加0.6点，但自己的当轮所得减少。未来互惠或惩罚需另作假设，公开发言不等于已投入。" };
  return { ...shared, reasoning: "比较身份假设、阵营动机及下一轮可观察反应。用公开投票、发言和本人获准的信息更新判断；虚构身份与隐瞒可以是游戏策略，但不能改写规则或调用他人私有状态。" };
}

export function payoffTool(input: TurnContext, spec: RunSpec, mind?: AgentMind) {
  if (!input.worldObservation || input.appraisalOnly || input.opportunity.stage.kind !== "action") return;
  const action = input.opportunity.actions.find(item => supported.has(item.name));
  if (!action) return;
  if (!action.fields.some(field => field.type === "number" ? field.max! > field.min! : (field.options?.length ?? 0) > 1)) return;
  const facts = input.worldObservation.facts;
  const option = z.object({ label: z.string().trim().min(1).max(80), choice: action.parameters }).strict();
  const options = action.name === "invest" ? option.extend({ returns: amountBeliefs("returned", 30).describe("本投资额下返还的可能整数金额及概率，总概率须为1，返还不能超过3倍投资") }) : option;
  const base = z.object({ rationale, options: z.array(options).min(2).max(6) }).strict();
  const parameters = action.name === "contribute" ? base.extend({ otherContributions: amountBeliefs("otherTotal", (spec.roster.length - 1) * 10).describe("其他人本轮密封投入总额的假设分布；所有候选共用，不读取实际密封投入") }) : base;
  return { parameters, compare(raw: unknown): PayoffComparison {
    const proposal = parameters.parse(raw) as Proposal;
    const signal = signalingDecisionSupport(input, spec, mind);
    if (action.name === "declare_quality" || action.name === "choose_offer") {
      if (!signal) throw new Error("缺少当前人物获准的信息交易观察");
      if (proposal.options.length !== 2 || sameChoice(proposal.options[0].choice, proposal.options[1].choice)) throw new Error("请各比较一次两个不同的合法选项");
      return { action: action.name, rationale: proposal.rationale, beliefSnapshot: signal.belief,
        options: proposal.options.map(candidate => ({ ...signal.options.find(option => sameChoice(option.parameters, candidate.choice))!, label: candidate.label })),
        note: "概率由可见结算证据计算，不由 rationale 指定；包含先验与样本量。只计算当轮点数，未计未来信誉或个人偏好；未选动作没有观测反馈。" };
    }
    const evaluated = proposal.options.map(candidate => {
      const choice = candidate.choice;
      const amount = Number(choice.amount);
      let branches: PayoffOption["branches"];
      if (action.name === "invest") {
        branches = candidate.returns!.map(belief => {
          if (belief.returned > amount * 3) throw new Error("假设返还不能超过该选项实际到账额");
          const payoff = trustPayoffs(amount, belief.returned);
          return { probability: belief.probability, condition: { returned: belief.returned }, own: payoff.investor, others: payoff.trustee };
        });
      } else if (action.name === "return_funds") {
        const payoff = trustPayoffs(Number(facts.investment), amount);
        branches = [{ probability: 1, condition: {}, own: payoff.trustee, others: payoff.investor }];
      } else if (action.name === "repair_transfer") {
        branches = [{ probability: 1, condition: {}, own: -amount, others: amount }];
      } else {
        branches = proposal.otherContributions!.map(belief => {
          const total = amount + belief.otherTotal;
          const own = contributionPayoff(amount, total, spec.roster.length);
          return { probability: belief.probability, condition: { otherTotal: belief.otherTotal }, own, others: spec.roster.length * 10 + .6 * total - own };
        });
      }
      if (Math.abs(branches.reduce((sum, branch) => sum + branch.probability, 0) - 1) > 1e-6) throw new Error("每个假设分布的概率合计必须为1");
      return { label: candidate.label, parameters: choice, branches,
        expectedOwn: branches.reduce((sum, branch) => sum + branch.probability * branch.own, 0),
        expectedOthers: branches.reduce((sum, branch) => sum + branch.probability * branch.others, 0),
        ownRange: [Math.min(...branches.map(branch => branch.own)), Math.max(...branches.map(branch => branch.own))] as [number, number],
      };
    });
    if (new Set(evaluated.map(option => JSON.stringify(option.parameters))).size !== evaluated.length) throw new Error("请比较不同的合法行动参数，不要重复同一个选择");
    return { action: action.name, rationale: proposal.rationale, options: evaluated,
      note: "本轮点数由真实规则计算；概率是你的假设，范围只覆盖所列情形，不含未来信誉、互惠或情绪效用。others 是其他人所得合计。未选分支不算经历，工具不代选动作。" };
  } };
}

export function actionReadback(input: TurnContext, name: string, parameters: Record<string, unknown>) {
  const knownQuality = (input.worldObservation?.facts.privateInformation as { highQuality?: boolean } | undefined)?.highQuality;
  return { action: name, parameters: structuredClone(parameters),
    ...(name === "declare_quality" && typeof knownQuality === "boolean" ? { reportedHighQuality: parameters.highQuality, knownHighQuality: knownQuality,
      reportAccurate: parameters.highQuality === knownQuality, meaning: parameters.highQuality ? "实际提交：报告高质量" : "实际提交：报告低质量" } : {}) };
}
