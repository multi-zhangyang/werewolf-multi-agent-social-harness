import { tool, type RunContext, type Tool } from "@openai/agents";
import { z } from "zod";
import { activeMemories, appraise, appraisalParameters, assessStrategy, bindStrategyAssessments, cognitionForPrompt, completeEpisodeReview, consolidateStrategy, consolidationParameters, enterEpisode, episodeReviewParameters, forecast, memoryForPrompt, memoryParameters, memoryRevisionParameters, opponentParameters,
  memoryOriginEpisode, planParameters, predictionFeedback, predictionParameters, remember, reviseMemory, setPlan, strategies, strategyAssessmentParameters, strategyUsage, updateOpponent, usableStrategyAssessments, type AgentMind, type CognitiveMemory, type PrivateDecision } from "../agents/cognition";
import type { NativeState } from "../agents/sdk";
import { visible, type RunSpec, type StagedActivation, type TurnContext, type WorldEvent } from "./types";
import { historicalMind, ledgerExperience } from "./agent-state";
import { rankRecall, recallCognitiveMemories, selectWorkingMemories } from "../agents/recall";
import { buildExperienceEvidence } from "../agents/experience-evidence";

const decisionFields = { strategy: z.enum(strategies), intent: z.enum(["truthful", "withhold", "bluff", "mixed", "none"]), privateAim: z.string().min(1).max(360) };
export class GeneralAgentContext implements NativeState {
  turn = 0; lastMutationTurn = 0; currentToolCallId?: string; boundaryError?: Error;
  readonly mind: AgentMind; readonly evidence: WorldEvent[]; readonly activation: StagedActivation;
  readonly targets: string[]; appraised = false; finished = false; consolidated = false;
  readonly evidenceRefs = new Map<string, string>();
  readonly revisableMemoryRefs = new Map<string, string>();
  readonly consolidationMemoryRefs = new Map<string, string>();
  readonly consolidationStrategyRefs = new Map<string, string>();
  readonly strategyRefs = new Map<string, string>();
  readonly workingMemories: CognitiveMemory[];
  constructor(readonly input: TurnContext, readonly spec: RunSpec, readonly runId: string) {
    const actorId = input.character.id;
    if (actorId !== input.opportunity.actorId || !input.opportunity.stage.actors.includes(actorId)) throw new Error("当前人物没有这个行动机会");
    if (input.episodeReview && (!input.appraisalOnly || spec.experiment.psychology === "off" || input.opportunity.actions.length || input.opportunity.communications.length)) throw new Error("整局复盘必须是启用心理的私有记录机会，且不能提供动作或通信");
    this.mind = enterEpisode(spec.experiment.psychology === "off" ? undefined : input.cognition ?? historicalMind(input.psychology, actorId, runId), actorId, runId);
    this.targets = spec.roster.map(s => s.characterId).filter(id => id !== actorId);
    const recent = input.recent.filter(event => visible(event, { actorId }) && ["message", "action", "fact"].includes(event.type));
    const query = `${JSON.stringify(input.worldObservation ?? input.observation)}\n${recent.slice(-4).map(event => event.text).join("\n")}`;
    this.workingMemories = spec.experiment.psychology === "off" ? [] : selectWorkingMemories(this.mind, query, spec.cognition?.context === "expanded" ? 64 : 16);
    const memorySources = this.workingMemories.flatMap(memory => memory.sourceIds.flatMap(id => input.lookupEvidence?.(id) ?? []));
    const records = [...recent, ...input.inbox, ...input.memories.filter(m => m.characterId === actorId).flatMap(m => m.sources ?? []), ...memorySources]
      .filter(e => visible(e, { actorId }) && ["message", "action", "fact"].includes(e.type));
    const latestObservation = records.filter(e => e.data.identityScope === runId).sort((a, b) => b.seq - a.seq)[0]?.id;
    this.evidence = [...new Map(records.filter(e => !e.data.identityScope || e.id === latestObservation).map(e => [e.id, e])).values()].sort((a, b) => a.seq - b.seq);
    this.evidence.forEach((event, index) => this.evidenceRefs.set(`e${index + 1}`, event.id));
    this.refreshMemoryReferences();
    this.activation = { id: input.opportunity.id, actorId, stageId: input.opportunity.stage.id, calls: [],
      ...(spec.experiment.psychology !== "off" ? { cognition: this.mind } : {}) };
  }
  refreshMemoryReferences() {
    this.revisableMemoryRefs.clear(); this.strategyRefs.clear(); this.consolidationMemoryRefs.clear(); this.consolidationStrategyRefs.clear();
    const outcomes = new Set(this.evidence.filter(event => event.data.settlement === true).map(event => event.id));
    const available = new Set(activeMemories(this.mind).map(memory => memory.id));
    this.mind.memories.forEach((memory, index) => {
      if (!available.has(memory.id)) return;
      if (memory.kind !== "episodic") this.revisableMemoryRefs.set(`m${index + 1}`, memory.id);
      if (memory.kind === "procedural") this.strategyRefs.set(`m${index + 1}`, memory.id);
      if (memory.kind === "procedural" && memory.scope === "transferable") this.consolidationStrategyRefs.set(`m${index + 1}`, memory.id);
      if (memory.kind === "episodic" && memory.sourceIds.some(id => outcomes.has(id))) this.consolidationMemoryRefs.set(`m${index + 1}`, memory.id);
    });
  }
  get needsAppraisal() { return this.spec.experiment.psychology !== "off" && !this.appraised && this.evidence.some(e => e.runId === this.runId && !this.mind.appraised.includes(e.id)); }
  get experienceEvidence() {
    return buildExperienceEvidence(this.mind, this.evidence.flatMap(event => {
      const experience = ledgerExperience(event, this.spec, this.input.character.id);
      if (!experience) return [];
      // An old source's environment is unknown unless its own observed record retained it.
      if (event.runId !== this.runId) delete experience.environment;
      return [experience];
    }));
  }
  get assessmentCandidates() {
    const inherited = new Set(this.workingMemories.filter(memory => memory.kind === "procedural" && memory.scope === "transferable" &&
      memoryOriginEpisode(memory) !== this.runId).map(memory => memory.id));
    return activeMemories(this.mind).filter(memory => inherited.has(memory.id) && memory.kind === "procedural" && memory.scope === "transferable");
  }
  get needsStrategyAssessment() {
    if (this.spec.experiment.psychology === "off" || this.input.appraisalOnly || this.input.opportunity.stage.kind !== "action") return false;
    const candidates = this.assessmentCandidates;
    return candidates.length > 0 && !(this.mind.strategyAssessments ?? []).some(assessment => assessment.episode === this.runId &&
      assessment.opportunityId === this.input.opportunity.id && candidates.some(memory => memory.id === assessment.memoryId && (memory.revision ?? 1) === assessment.memoryRevision));
  }
  get completionTools() {
    return this.input.episodeReview ? ["finish_episode_review"] : this.input.appraisalOnly ? ["finish_record"]
      : this.input.opportunity.stage.kind === "discussion" ? ["speak", "wait", ...(this.input.opportunity.communications.length ? ["send_message"] : [])]
        : this.input.opportunity.actions.filter(action => !this.activation.calls.some(call => call.name === action.name)).map(action => action.name);
  }
  get actionStrategyAssessments() { return usableStrategyAssessments(this.mind, this.input.opportunity.id); }
  /** Official Agent.instructions reads current local state before each SDK request. */
  get executionProgress() {
    const requiredTool = this.needsAppraisal ? "appraise_event" : this.needsStrategyAssessment ? "assess_strategy" : null;
    const completionOnly = requiredTool === null && !this.withinCompletionBudget("recall");
    return this.displayReferences({ modelTurn: this.turn + 1, remainingModelTurns: this.spec.budgets.maxTurns - this.turn,
      appraisalRequired: this.needsAppraisal, assessmentRequired: this.needsStrategyAssessment,
      assessmentCandidateIds: this.needsStrategyAssessment ? this.assessmentCandidates.map(memory => memory.id) : [],
      usableAssessmentIds: this.actionStrategyAssessments.map(assessment => assessment.id),
      requiredTool, completionTools: this.completionTools, completionAvailable: requiredTool === null, completionOnly,
      next: requiredTool === "appraise_event" ? "先用 appraise_event 评价新证据，读取回执后继续。"
        : requiredTool === "assess_strategy" ? "先用 assess_strategy 检验上述旧策略之一；不适用可以 reject。读取回执后才开放完成工具。"
          : completionOnly ? "必需前置步骤已完成，剩余预算只允许使用当前可用的完成工具。"
            : "必需前置步骤已完成。读取已有回执后使用当前可用的完成工具；也可在剩余预算内作必要的心理更新。",
    });
  }
  /** SDK evaluates tool availability before the next model input increments turn. */
  withinCompletionBudget(name: string) {
    const finishTools = this.completionTools;
    const finishes = this.input.appraisalOnly || this.input.opportunity.stage.kind === "discussion" ? 1 : finishTools.length;
    const needsAssessment = this.needsStrategyAssessment;
    // Revising or retiring an assessed rule can require another verdict before acting.
    // Reserve that turn before offering the mutation, even when the old version was checked.
    const mayInvalidateAssessment = !needsAssessment && !this.input.appraisalOnly && this.input.opportunity.stage.kind === "action" &&
      ["revise_memory", "consolidate_strategy"].includes(name) && this.assessmentCandidates.length > 0;
    const required = Number(this.needsAppraisal) + Number(needsAssessment || mayInvalidateAssessment) + finishes;
    if (this.spec.budgets.maxTurns - this.turn > required) return true;
    if (this.needsAppraisal) return name === "appraise_event";
    if (this.needsStrategyAssessment) return name === "assess_strategy";
    return finishTools.includes(name);
  }
  assertOpen() { this.input.signal.throwIfAborted(); if (this.boundaryError) throw this.boundaryError; if (this.finished) throw new Error("本次激活已经暂存完毕"); }
  validateSources(ids: string[]) {
    this.assertOpen(); const resolved = ids.map(id => this.evidenceRefs.get(id) ?? id);
    if (resolved.some(id => !this.evidence.some(e => e.id === id))) throw new Error(`只可引用本次可见证据编号：${[...this.evidenceRefs.keys()].join(", ")}`);
    return resolved;
  }
  /** Exact domain references, never fuzzy argument repair. Stored evidence keeps its original immutable IDs. */
  displayReferences<T>(value: T): T {
    const aliases = new Map([...this.evidenceRefs].map(([ref, id]) => [id, ref]));
    this.mind.plans.forEach((plan, index) => aliases.set(plan.id, `p${index + 1}`));
    this.mind.memories.forEach((memory, index) => aliases.set(memory.id, `m${index + 1}`));
    this.mind.strategyAssessments?.forEach((assessment, index) => aliases.set(assessment.id, `a${index + 1}`));
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string" ? aliases.get(item) ?? item : item));
  }
  resolvePlanId(id: string | null) { return id?.match(/^p\d+$/) ? this.mind.plans[Number(id.slice(1)) - 1]?.id ?? id : id; }
  changed<T>(result: T): T { this.lastMutationTurn = this.turn; return this.displayReferences(result); }
  ready() { this.assertOpen(); if (this.needsAppraisal) throw new Error("先评价新的可见事件"); if (this.needsStrategyAssessment) throw new Error("先检验一条取回的旧策略；不适用可明确 reject，不必照搬"); if (this.lastMutationTurn >= this.turn) throw new Error("请在下一次响应读取正式心理回执后再行动"); }
  decide(name: string, meta: z.infer<z.ZodObject<typeof decisionFields>>, parameters?: Record<string, unknown>, basis?: PrivateDecision["strategyBasis"] | null) {
    this.ready();
    const decision: PrivateDecision = { id: crypto.randomUUID(), episode: this.runId, round: this.input.opportunity.stage.round,
      action: name, ...meta, ...(parameters ? { parameters: structuredClone(parameters) } : {}),
      predictionIds: this.mind.predictions.filter(p => p.episode === this.runId && p.result === undefined && !p.expired).map(p => p.id) };
    if (parameters && this.spec.experiment.psychology !== "off") decision.strategyBasis = basis ? {
      assessmentIds: basis.assessmentIds.map(ref => this.mind.strategyAssessments?.find((_assessment, index) => ref === `a${index + 1}`)?.id ?? ref),
      reason: basis.reason,
    } : { assessmentIds: [], reason: meta.privateAim };
    bindStrategyAssessments(this.mind, this.input.opportunity.id, decision);
    this.mind.decisions.push(decision); this.mind.revision++;
  }
  modelInput() {
    const actorId = this.input.character.id;
    const memoryLimit = this.spec.cognition?.context === "expanded" ? 64 : 16;
    const { id, name, persona, values, goals, voice } = this.input.character;
    return JSON.stringify(this.displayReferences({ actor: { id, name, persona, values, goals, voice }, observation: this.input.worldObservation ?? this.input.observation,
      opportunity: { ...this.input.opportunity, actions: this.input.opportunity.actions.map(({ parameters: _parameters, ...action }) => action) },
      evidence: this.evidence, targets: this.targets, appraisalRequired: this.needsAppraisal,
      newEvidenceIds: this.evidence.filter(e => e.runId === this.runId && !this.mind.appraised.includes(e.id)).map(e => e.id),
      memoryWindow: memoryLimit,
      ...(this.spec.experiment.psychology !== "off" ? { cognition: cognitionForPrompt(this.mind, memoryLimit, this.workingMemories) } : {}),
      ...(this.spec.experiment.psychology !== "off" ? { strategyLearning: {
        consolidationMemoryIds: [...this.consolidationMemoryRefs.keys()],
        consolidationStrategyIds: [...this.consolidationStrategyRefs.keys()],
        existingStrategies: activeMemories(this.mind).filter(memory => memory.kind === "procedural" && memory.scope === "transferable")
          .map(memory => ({ id: memory.id, revision: memory.revision ?? 1, originEpisode: memoryOriginEpisode(memory),
            text: memory.text, when: memory.when, then: memory.then, sourceOutcomeIds: memory.consolidation?.sourceOutcomeIds ?? [] })),
        outcomeIds: this.evidence.filter(event => event.data.settlement === true).map(event => event.id),
        availableStrategyIds: [...this.strategyRefs.keys()],
        assessmentRequired: this.needsStrategyAssessment,
        assessmentCandidateIds: this.assessmentCandidates.map(memory => memory.id),
        experienceEvidence: this.experienceEvidence,
        predictionFeedback: predictionFeedback(this.mind, Boolean(this.input.episodeReview)),
        note: "经历提炼为可错的条件策略；用当前证据检验适用性后才采用。usage 只计当前版本的采用及实际反馈，不是策略优越性评分。",
      } } : {}),
      ...(this.input.episodeReview ? { episodeReview: {
        summary: this.experienceEvidence.episodes.find(episode => episode.episode === this.runId),
        outcomes: this.evidence.filter(event => event.runId === this.runId && event.data.settlement === true),
        experiences: this.experienceEvidence.outcomes.filter(outcome => outcome.episode === this.runId),
        decisions: this.mind.decisions.filter(decision => decision.episode === this.runId && !["speak", "wait", "send_message"].includes(decision.action)),
        predictions: this.mind.predictions.filter(prediction => prediction.episode === this.runId),
        predictionFeedback: predictionFeedback(this.mind, true),
        note: "世界已结束。比较整局经历、实际结果与预测；可复用的关系和仅本局成立的细节须分开。证据不足可以如实记录。不能改变行动或公开发言。",
      } } : {}),
      rememberedExperience: this.spec.experiment.relationshipMemory ? this.input.memories.filter(m => m.characterId === actorId &&
        !(this.spec.experiment.psychology === "off" && m.kind === "note")).slice(-memoryLimit).map(m => ({ ...m, sources: m.sources?.filter(e => visible(e, { actorId })) })) : [],
      forecastGuide: "未来行动 kind=action，eventName=工具名，field 使用行动参数字段（例如 amount、targetId 或布尔字段），eq 可比较布尔值；未来结算 kind=outcome，eventName=settlement，field=payoffs.人物ID、winners 或结算中的实际字段；只能预测未来首次匹配事件。未出现可验证字段时不会评分。",
      maxModelTurns: this.spec.budgets.maxTurns, purpose: this.input.episodeReview ? "整局私有复盘：检查或提炼有边界的策略，读取回执后调用 finish_episode_review；没有可引用策略时 strategyIds 使用空数组并说明证据不足" : this.input.appraisalOnly ? "只保存评价，再调用 finish_record" : "完成当前合法行动或发言" }));
  }
}
export const generalInstructions = `你在虚构的多人社会环境中扮演当前人物。观察与证据只包含自己实际获知的信息；不知他人的私有心理或未公开行动。
你可合作、竞争、试探、隐瞒或在游戏中虚张声势。对外 text 是发言；privateAim 与 intent 是自己的私有意图，不会对外广播。声明、推断和事实彼此独立，不能用声明改写世界。
需要评价时先 appraise_event；sourceIds 从 newEvidenceIds 的短编号选取（如 e1）。责任归属只用 self/other/shared/situation/unknown 或 null。控制感、责任判断和情绪是主观报告。再读取工具回执的正式状态。update_opponent 记录某人的可错假设并保留另一种解释；角色猜测仅属于本局 scope=episode，保存在 episodeBeliefs，换场景清除。跨情境关系经验才可用 relationship，保存在 relationships。同一个人的两类判断分别修订，不能用身份猜测覆盖过去的关系经验。
set_plan 管理自己的目标与可修订计划，条件用情境语义描述，不套用别的游戏阶段。当前记忆窗口同时考虑相关性、条件策略与近期经历；recall 可查阅更早的本人经历。remember 区分经历、命题和条件策略；仅本局的结论保留 scope=episode，隐藏身份不要当成跨局事实。
consolidate_strategy 从本人实际结算经历创建或修订可迁移的待检验策略。先比较 strategyLearning.existingStrategies：同一原则的新证据、补充条件或反证，strategyId 选择 consolidationStrategyIds 中已有编号，保留该编号并形成新版本；已有原则无需变化时可直接复用，不必再次提炼。只有不同的新原则才填 strategyId=null，不能用换一种说法或多经历一轮来新增重复策略。memoryIds 从 consolidationMemoryIds 选择，程序沿所选经历的可见账本链接保留本次来源；旧版本和原经历保留。rationale 说明为何补充、修正或新增，哪些关系可能可复用、哪些是源情境的偶然细节；when 写适用条件与边界，then 写行动原则。可迁移表示允许在新情境接受检验，不表示已经证明普遍有效。
strategyLearning.experienceEvidence 按原始结算事件分组。episodes 和 episodeReview.summary 给出本人的角色次数、实际动作次数、轮数和分单位收益合计；按这些计数描述经历，不把投资者所得称为受托者所得，不把补偿结算混作交易轮数。outcomes 中的 role、reward 和 facts 是可见事实，records 是个人解释；同一事件的多条记录只算一次结算。先比较谁知道什么、谁承担什么后果、哪些行动可核验，再提炼关系结构。
取回旧策略后，先找当前处境与旧经验共有的决策问题，再用 assess_strategy 判断 apply / adapt / reject。matching 写共有关系，differences 写真正影响选择的差异。场景名、角色名或金额不同本身不足以拒绝；能保留原原则并改变合法动作或风险阈值时，用 adapt 说明如何调整。原原则所需的信息、激励或核验条件缺失且无法调整时用 reject，不编造缺失条件。随后自己选择当前合法动作，发言不计作行动采用。行动的 strategyBasis 仅引用真正影响本次选择的检验回执 a 编号，reason 说明它如何影响实际参数；不采用旧策略时填 null，用 privateAim 说明当前选择。apply / adapt 只表示可用，不会自动算采用；被拒绝、旧机会或旧版本不能作依据。系统只关联明确选择且实际提交的行动和账本反馈。
讨论中的适用性判断只表示准备，不计为行动采用。要在实际行动中采用某条策略，应在提交该动作的机会先检验它，再读回执和提交动作。
strategyLearning.assessmentRequired 为 true 时，先评价新事件，再从 assessmentCandidateIds 选择一条当前取回的旧策略检验。可以 apply、adapt 或 reject，不要求采用。完成这一步并读取回执后才提供世界动作；这保证旧经验被明确检验，不替你选择策略或动作。
判断和条件策略可以被反证。新证据改变了旧判断或适用范围时，用 revise_memory 修订已有 m1 等记忆编号的内容、把握与条件；已不适用的判断可 change=retire、replacement=null 停用。修订要说明新来源和原因，保留历史；经历本身不能改写。不要通过新增一条矛盾记忆来回避修订旧判断。
初次进入一种处境且没有适用计划时，用 set_plan 建立一个自己的计划。有可观察的下一步不确定性时，用 forecast 先登记概率，再根据真实反馈学习。
首次看到新的实际结算后，比较结果与原先预期，并把教训保存到正式记忆。已有条件策略覆盖这类结果时，检查其适用范围，需要补充证据或修正条件就用 consolidate_strategy 更新原 strategyId，原则无需变化可直接复用；尚无覆盖这类结果的策略且有结算经历时才新增有条件和边界的待检验策略，confidence 表达不确定性。若只能支持本局结论，用 remember 保存并说明局限。单次经历不能写成普遍保证；不要为相同教训反复新增策略。仅对外谈论教训、调用 appraise_event 或关闭计划，都不会生成可迁移策略。
forecast 可登记一个尚未发生的可观测事件概率，后续由账本评分。predictionFeedback 区分行动与结算预测、已评分与未验证，并按评分来源事件分组；同一事件的多次预测不能说成多次独立观察，未验证不能算作失败。事后能比较真实结果不表示原预测完成了正式评分。learning 是实际结果反馈；收益均值不证明某策略更优。根据反证修正计划与判断，不需要每次创建新计划或记忆。
输入含 episodeReview 时世界已经结束，这是自己的私有整局复盘。比较提供的整段经历、实际收益、行动和预测，检查现有策略，必要时修订或 consolidate_strategy 提炼；不要重复保存同一教训。读完正式回执后用 finish_episode_review 结束：strategyIds 选择当前有效、可供后续检验的可迁移策略短编号；没有可引用策略时使用空数组并说明证据不足。状态由所选列表生成，不另填 status；保留策略不表示它已经被证明有效，也不要求编造普遍规律。
每次只调用一个工具。所有数字用原生 JSON 数值。工具错误后读错误再修正。预算是 model turns，包括最后行动；SDK 会为尚未完成的评价、旧策略检验和正式结束保留步数，预算不足时只提供下一步必需工具。可以拒绝不适用策略，不要通过重复修改计划回避检验或行动。
先评价新事件，心理/计划/预测变更后读取回执，再使用合法行动工具；讨论用 speak 或 wait。行动仅暂存，完整 SDK 运行成功后一次提交。用简短中文，不输出长篇分析。`;

export function generalTools(c: GeneralAgentContext, report: (name: string, error: unknown, args?: unknown) => string): Tool<GeneralAgentContext>[] {
  // Rebuild exact references after each SDK tool receipt, including newly written memories.
  c.refreshMemoryReferences();
  const evidenceRef = z.enum([...c.evidenceRefs.keys()] as [string, ...string[]]);
  const sourceIds = z.array(evidenceRef).min(1).max(8).describe("只引用本次已经可见的证据编号；不可使用轮次、计划或预测 ID");
  const newEvidenceRefs = [...c.evidenceRefs].filter(([, id]) => c.evidence.some(event => event.id === id && event.runId === c.runId && !c.mind.appraised.includes(id))).map(([ref]) => ref);
  const appraisalSources = z.array(z.enum(newEvidenceRefs as [string, ...string[]])).min(1).max(8);
  const forecastTargets = [c.input.character.id, ...c.targets] as [string, ...string[]];
  const common = (name: string, available = () => true) => ({ isEnabled: () => !c.finished && available() && c.withinCompletionBudget(name),
    errorFunction: (context: RunContext<GeneralAgentContext>, error: unknown) => JSON.stringify({
      ...JSON.parse(report(name, error, context.toolInput)), allowedEvidenceIds: [...c.evidenceRefs.keys()],
      revisableMemoryIds: [...c.revisableMemoryRefs.keys()],
      requiredStrategyIds: c.displayReferences(c.needsStrategyAssessment ? c.assessmentCandidates.map(memory => memory.id) : []),
      otherActorIds: c.targets, communications: c.input.opportunity.communications,
    }) });
  const psychological = () => c.spec.experiment.psychology !== "off";
  const tools: Tool<GeneralAgentContext>[] = [];
  if (psychological()) tools.push(
    tool({ name: "appraise_event", description: "评价新的可见证据，正式状态按情绪惯性与调节规则更新。", parameters: appraisalParameters.extend({ sourceIds: appraisalSources }),
      ...common("appraise_event", () => c.needsAppraisal), execute: async args => { args = { ...args, sourceIds: c.validateSources(args.sourceIds) };
        if (c.needsAppraisal && !args.sourceIds.some(id => c.evidence.some(e => e.id === id && e.runId === c.runId && !c.mind.appraised.includes(id)))) throw new Error("请从 newEvidenceIds 选择本局尚未评价的新证据");
        const instant = c.spec.experiment.psychology === "appraisal";
        const result = appraise(c.mind, args, instant ? 0 : c.spec.cognition?.inertia ?? .6, instant ? 0 : c.spec.cognition?.decay ?? .1); c.appraised = true; return c.changed(result); } }),
    tool({ name: "update_opponent", description: "更新一个具体他人的意图假设与替代解释；这是估计，不是读心。", parameters: opponentParameters.extend({ sourceIds, targetId: z.enum(c.targets as [string, ...string[]]) }),
      ...common("update_opponent"), execute: async args => { args = { ...args, sourceIds: c.validateSources(args.sourceIds) }; if (!c.targets.includes(args.targetId)) throw new Error("关系对象必须是在场他人"); return c.changed(updateOpponent(c.mind, args)); } }),
    tool({ name: "set_plan", description: "创建或修订最多 3 个活动计划。新建 id=null，修订填写已有 id；portable 仅用于跨情境策略。", parameters: planParameters.extend({ sourceIds }),
      ...common("set_plan"), execute: async args => { args = { ...args, sourceIds: c.validateSources(args.sourceIds), id: c.resolvePlanId(args.id) }; return c.changed(setPlan(c.mind, args)); } }),
    tool({ name: "close_plan", description: "关闭已经完成或不再适用的计划。", parameters: z.object({ id: z.string(), reason: z.string().min(1).max(240), sourceIds }).strict(),
      ...common("close_plan"), execute: async args => { c.validateSources(args.sourceIds); const plan = c.mind.plans.find(p => p.id === c.resolvePlanId(args.id) && p.status === "active"); if (!plan) throw new Error("没有这个活动计划"); plan.status = "closed"; plan.closeReason = args.reason; plan.revision++; c.mind.revision++; return c.changed(plan); } }),
    tool({ name: "remember", description: "写入带来源的个人经历、命题或条件策略；可错推断须降低 confidence。", parameters: memoryParameters.extend({ sourceIds }),
      ...common("remember"), execute: async args => { args = { ...args, sourceIds: c.validateSources(args.sourceIds) }; return c.changed(remember(c.mind, args)); } }),
    tool({ name: "forecast", description: "登记未来首次匹配事件的概率，结果由可见账本验证；可以预测自己或他人的收益。不是对已发生结果补写概率。", parameters: predictionParameters.extend({ sourceIds, targetId: z.enum(forecastTargets).nullable() }),
      ...common("forecast", () => !c.input.appraisalOnly), execute: async args => { args = { ...args, sourceIds: c.validateSources(args.sourceIds) }; if (args.targetId && !forecastTargets.includes(args.targetId)) throw new Error("预测对象必须为在场人物或 null");
        return c.changed(forecast(c.mind, args, Math.max(0, ...c.evidence.filter(e => e.runId === c.runId).map(e => e.seq)))); } }),
  );
  if (psychological() && c.revisableMemoryRefs.size) tools.push(tool({ name: "revise_memory", description: "根据新证据修订或停用已有判断/条件策略，保留原文与理由；不能改写经历。revise 需 replacement，retire 需 null。",
    parameters: memoryRevisionParameters.extend({ id: z.enum([...c.revisableMemoryRefs.keys()] as [string, ...string[]]), sourceIds }),
    ...common("revise_memory"), execute: async args => {
      const sources = c.validateSources(args.sourceIds);
      const memory = reviseMemory(c.mind, { ...args, id: c.revisableMemoryRefs.get(args.id) ?? args.id, sourceIds: sources });
      return c.changed({ ...memoryForPrompt(memory), change: args.change, reason: args.reason });
    } }));
  if (psychological() && c.consolidationMemoryRefs.size) {
    const outcomeIds = c.evidence.filter(event => event.data.settlement === true).map(event => event.id);
    const strategyId = c.consolidationStrategyRefs.size ? z.enum([...c.consolidationStrategyRefs.keys()] as [string, ...string[]]).nullable() : z.null();
    tools.push(tool({ name: "consolidate_strategy", description: "选择真实结算经历，补充或修订已有条件策略；已有原则选 strategyId，仅不同的新原则使用 null。保留稳定编号、旧版本及结算来源，每次机会最多一条。",
      parameters: consolidationParameters.extend({ strategyId, memoryIds: z.array(z.enum([...c.consolidationMemoryRefs.keys()] as [string, ...string[]])).min(1).max(6) }),
      ...common("consolidate_strategy", () => !c.needsAppraisal && !c.consolidated), execute: async args => {
        c.assertOpen();
        const result = consolidateStrategy(c.mind, { ...args, strategyId: args.strategyId === null ? null : c.consolidationStrategyRefs.get(args.strategyId) ?? args.strategyId,
          memoryIds: args.memoryIds.map(id => c.consolidationMemoryRefs.get(id) ?? id) }, outcomeIds);
        c.consolidated = true; return c.changed(memoryForPrompt(result));
      } }));
  }
  if (psychological() && c.strategyRefs.size && !c.input.appraisalOnly) {
    const requiredCandidates = new Set(c.assessmentCandidates.map(memory => memory.id));
    const assessableRefs = [...c.strategyRefs].filter(([, id]) => !c.needsStrategyAssessment || requiredCandidates.has(id));
    const currentRefs = [...c.evidenceRefs].filter(([, id]) => c.evidence.some(event => event.id === id && event.runId === c.runId)).map(([ref]) => ref);
    if (currentRefs.length) tools.push(tool({ name: "assess_strategy", description: "检验策略适用性：apply / adapt / reject；引用当前情境证据。只有行动的 strategyBasis 明确选择这条回执后才计采用，并由真实账本反馈。",
      parameters: strategyAssessmentParameters.extend({ id: z.enum(assessableRefs.map(([ref]) => ref) as [string, ...string[]]),
        sourceIds: z.array(z.enum(currentRefs as [string, ...string[]])).min(1).max(8) }),
      ...common("assess_strategy", () => !c.needsAppraisal), execute: async args => c.changed(assessStrategy(c.mind,
        { ...args, id: c.strategyRefs.get(args.id) ?? args.id, sourceIds: c.validateSources(args.sourceIds) }, c.input.opportunity.id, c.input.opportunity.stage.round)) }));
  }
  tools.push(tool({ name: "recall", description: "检索本人可见经历与可迁移记忆；不访问其他人的私有内容。", parameters: z.object({ query: z.string().min(1).max(120) }).strict(),
    ...common("recall"), execute: async ({ query }) => { c.assertOpen(); return c.displayReferences({ evidence: rankRecall(c.evidence, query, event => event.text),
      memories: psychological() ? recallCognitiveMemories(c.mind, query).map(memory => ({ ...memoryForPrompt(memory),
        ...(memory.kind === "procedural" ? { usage: strategyUsage(c.mind, memory) } : {}) })) : [],
      ...(psychological() ? { experienceEvidence: c.experienceEvidence } : {}) }); } }));
  if (c.input.episodeReview) {
    const outcomeRefs = [...c.evidenceRefs].filter(([, id]) => c.evidence.some(event => event.id === id && event.runId === c.runId && event.data.settlement === true)).map(([ref]) => ref);
    tools.push(tool({ name: "finish_episode_review", description: "完成整局私有复盘。strategyIds 引用可供后续检验的可迁移策略；没有可引用策略则使用空数组并说明证据不足。状态由选择结果生成。引用本局真实结算，不能用发言代替。",
      parameters: episodeReviewParameters.omit({ status: true }).extend({ sourceIds: z.array(z.enum(outcomeRefs as [string, ...string[]])).min(1).max(8),
        strategyIds: z.array(z.string().regex(/^m[1-9]\d*$/).describe("使用当前记忆或刚返回的工具回执中的精确 m 编号")).max(6) }),
      ...common("finish_episode_review", () => !c.needsAppraisal), execute: async args => {
        c.ready();
        const sourceIds = c.validateSources(args.sourceIds);
        if (sourceIds.some(id => !c.evidence.some(event => event.id === id && event.runId === c.runId && event.data.settlement === true))) throw new Error("整局复盘必须引用本人可见的本局真实结算");
        const review = completeEpisodeReview(c.mind, { ...args, sourceIds, status: args.strategyIds.length ? "ready" : "insufficient",
          strategyIds: args.strategyIds.map(ref => c.mind.memories[Number(ref.slice(1)) - 1]?.id ?? ref) }, c.input.opportunity.id);
        c.finished = true; c.activation.waited = true;
        return { staged: true, review: c.displayReferences(review), revision: c.mind.revision };
      } }));
  } else if (c.input.appraisalOnly) tools.push(tool({ name: "finish_record", description: "读取正式心理回执后结束评价，不发言、不改变世界。", parameters: z.object({}).strict(),
    ...common("finish_record", () => !c.needsAppraisal), execute: async () => { c.ready(); c.finished = true; c.activation.waited = true; return { staged: true, revision: c.mind.revision }; } }));
  else if (c.input.opportunity.stage.kind === "discussion") {
    tools.push(tool({ name: "speak", description: "向当前对话发言。私有意图仅自己与研究者可见，text 是唯一公开内容。", parameters: z.object({ text: z.string().trim().min(1).max(2000), ...decisionFields }).strict(),
      ...common("speak", () => !c.needsAppraisal), execute: async ({ text, ...meta }) => { c.decide("speak", meta); c.activation.text = text; c.finished = true; return { staged: true }; } }),
    tool({ name: "wait", description: "本次暂不发言。", parameters: z.object(decisionFields).strict(),
      ...common("wait", () => !c.needsAppraisal), execute: async meta => { c.decide("wait", meta); c.activation.waited = true; c.finished = true; return { staged: true }; } }));
    if (c.input.opportunity.communications.length) tools.push(tool({ name: "send_message", description: "仅向额外允许的频道或对象发言；在当前对话发言使用 speak。结束本次机会。", parameters: z.object({
      channel: z.enum([...new Set(c.input.opportunity.communications.map(option => option.channel))] as ["public" | "private" | "team", ...Array<"public" | "private" | "team">]),
      recipients: z.array(z.enum([...new Set(c.input.opportunity.communications.flatMap(option => option.recipients))] as [string, ...string[]])).min(1).max(12),
      text: z.string().trim().min(1).max(2000), ...decisionFields }).strict(),
      ...common("send_message", () => !c.needsAppraisal), execute: async ({ channel, recipients, text, ...meta }) => {
        const allowed = c.input.opportunity.communications.some(o => o.channel === channel && recipients.every(id => o.recipients.includes(id)) && (channel !== "private" || recipients.length > 0));
        if (!allowed) throw new Error("目标频道或接收者不在本次允许范围内"); c.decide("send_message", meta); c.activation.calls.push({ name: "send_message", args: { channel, recipients, text } }); c.finished = true; return { staged: true }; } }));
  } else for (const action of c.input.opportunity.actions) {
    const assessmentRefs = c.displayReferences(c.actionStrategyAssessments.map(assessment => assessment.id));
    const strategyBasisSchema = psychological() && assessmentRefs.length ? z.object({
      assessmentIds: z.array(z.enum(assessmentRefs as [string, ...string[]])).min(1).max(assessmentRefs.length).describe("本次真正采用的检验回执 a 编号，不要填记忆 m 编号"),
      reason: z.string().trim().min(1).max(360).describe("这些策略如何影响本次实际行动参数"),
    }).strict().nullable().describe("明确采用已检验策略时填写；不采用时填 null，由 privateAim 说明当前选择") : z.null();
    tools.push(tool({ name: action.name, description: action.description,
    parameters: action.parameters.extend({ ...decisionFields, strategyBasis: strategyBasisSchema }).strict(),
    ...common(action.name, () => !c.needsAppraisal && !c.needsStrategyAssessment && !c.activation.calls.some(call => call.name === action.name)),
    execute: async ({ strategy, intent, privateAim, strategyBasis, ...args }) => { const parsed = action.parameters.parse(args) as Record<string, unknown>;
      c.decide(action.name, z.object(decisionFields).parse({ strategy, intent, privateAim }), parsed, strategyBasisSchema.parse(strategyBasis)); c.activation.calls.push({ name: action.name, args: parsed });
      c.finished = c.input.opportunity.actions.every(a => c.activation.calls.some(call => call.name === a.name));
      return { staged: true, remaining: c.input.opportunity.actions.filter(a => !c.activation.calls.some(call => call.name === a.name)).map(a => a.name) }; } }));
  }
  return tools;
}
