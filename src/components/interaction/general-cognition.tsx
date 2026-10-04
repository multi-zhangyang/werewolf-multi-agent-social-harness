import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isWorldDecision, opponentViews, strategyUsage, type AgentMind, type Strategy } from "@/agents/cognition";
import type { Character } from "@/runtime/types";

const strategyLabels: Record<Strategy, string> = { observe: "观察", probe: "试探", cooperate: "合作", protect: "自保", repair: "修复", compete: "竞争", deceive: "误导", withdraw: "退出" };
const intentLabels = { truthful: "如实表达", withhold: "保留信息", bluff: "虚张声势", mixed: "混合表达", none: "未作声明" };
export function GeneralCognition({ mind, characters }: { mind: AgentMind; characters: Character[] }) {
  const name = (id: string | null) => characters.find(c => c.id === id)?.name ?? id ?? "可见结果";
  const decision = mind.decisions.at(-1);
  const beliefs = opponentViews(mind);
  const targets = [...new Set([...Object.keys(beliefs.relationships), ...Object.keys(beliefs.episodeBeliefs)])];
  const worldDecisionIds = new Set(mind.decisions.filter(item => isWorldDecision(item) && item.strategyBasis).map(item => item.id));
  const legacyDecisionIds = new Set(mind.decisions.filter(item => isWorldDecision(item) && !item.strategyBasis).map(item => item.id));
  const assessments = (mind.strategyAssessments ?? []).slice(-6).reverse().map(item => ({ ...item,
    actionIds: item.decisionIds.filter(id => worldDecisionIds.has(id)),
    legacyActionIds: item.decisionIds.filter(id => legacyDecisionIds.has(id)),
    actionFeedback: item.feedback.filter(feedback => feedback.decisionIds.some(id => worldDecisionIds.has(id))),
  }));
  const review = mind.episodeReviews?.find(item => item.episode === mind.episode);
  const revisions = mind.memories.flatMap(memory => (memory.revisions ?? []).map((change, index, history) => ({
    key: `${memory.id}:${index}`, change, after: history[index + 1]?.previous ?? memory,
  }))).sort((a, b) => b.change.atRevision - a.change.atRevision).slice(0, 8);
  return <div className="flex flex-col gap-4" data-testid="general-cognition">
    {review && <Card data-testid="episode-review"><CardHeader><CardDescription>对局结束后的私有学习记录</CardDescription><CardTitle>整局复盘</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">
      <Badge variant="secondary" className="w-fit">{review.status === "ready" ? "可供后续检验" : "证据不足"}</Badge>
      <p className="text-sm">{review.summary}</p>
      {review.strategies.map(reference => { const memory = mind.memories.find(item => item.id === reference.id); return <p key={reference.id} className="text-sm">{memory?.text ?? "已引用的条件策略"} · 版本 {reference.revision}</p>; })}
      <p className="text-xs text-muted-foreground">引用 {review.sourceIds.length} 条本局结算。可供检验表示保留了有边界的假设，实际效果需要之后的行动与结果验证。</p>
    </CardContent></Card>}
    <Card><CardHeader><CardDescription>本人的私有记录</CardDescription><CardTitle>目标与策略</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">
      {decision && <div className="flex flex-col gap-2"><div className="flex flex-wrap gap-2"><Badge>{strategyLabels[decision.strategy]}</Badge><Badge variant="outline">{intentLabels[decision.intent]}</Badge></div><p className="text-sm">{decision.privateAim}</p><p className="text-xs text-muted-foreground">这是人物自己的意图报告，公开发言与真实结果另行记录。</p></div>}
      {decision?.strategyBasis && <div className="flex flex-col gap-2">
        <p className="text-sm">选择理由：{decision.strategyBasis.reason}</p>
        {decision.strategyBasis.assessmentIds.length === 0 ? <Badge variant="outline" className="w-fit">本次未采用经验策略</Badge>
          : decision.strategyBasis.assessmentIds.map(id => { const assessment = mind.strategyAssessments?.find(item => item.id === id); return assessment && <p key={id} className="text-xs text-muted-foreground">策略依据：{assessment.memory.text} · 版本 {assessment.memoryRevision}</p>; })}
      </div>}
      {mind.plans.filter(plan => plan.status === "active").map(plan => <div key={plan.id} className="flex flex-col gap-2"><p className="text-sm font-medium">{plan.goal}</p><p className="text-sm">{plan.steps.join(" → ")}</p><p className="text-xs text-muted-foreground">适用：{plan.when} · 修订：{plan.reviseWhen} · 结束：{plan.stopWhen}</p><Badge variant="secondary" className="w-fit">{plan.portable ? "可跨场景" : "本局计划"} · 版本 {plan.revision}</Badge></div>)}
      {!mind.plans.some(plan => plan.status === "active") && <p className="text-sm text-muted-foreground">尚无持续计划；当前选择按本次处境作出。</p>}
    </CardContent></Card>
    {assessments.length > 0 && <Card data-testid="strategy-assessments"><CardHeader><CardDescription>旧经验在当前处境中的适用性</CardDescription><CardTitle>经验策略的检验</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">{assessments.map(assessment => <div key={assessment.id} className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2"><Badge variant="secondary">{assessment.verdict === "reject" ? "不适用" : assessment.actionIds.length ? assessment.verdict === "adapt" ? "调整后采用" : "采用" : assessment.legacyActionIds.length ? "历史自动关联" : assessment.verdict === "adapt" ? "可调整" : "可适用"}</Badge><Badge variant="outline">策略版本 {assessment.memoryRevision}</Badge>{(assessment.memoryOriginEpisode ?? assessment.memoryEpisode) !== assessment.episode && <Badge variant="outline">来自此前经历</Badge>}</div>
      <p className="text-sm">{assessment.memory.text}</p><p className="text-xs text-muted-foreground">相符之处：{assessment.matching}</p><p className="text-xs text-muted-foreground">差异与未知：{assessment.differences}</p>
      {assessment.adaptation && <p className="text-sm">本次调整：{assessment.adaptation}</p>}
      <p className="text-xs text-muted-foreground">{assessment.actionIds.length ? `明确采用 ${assessment.actionIds.length} 次实际行动` : assessment.verdict === "reject" ? "未采用这条策略" : assessment.legacyActionIds.length ? `历史自动关联 ${assessment.legacyActionIds.length} 次，不计明确采用` : "尚未明确采用"} · {assessment.sourceIds.length} 条当前证据</p>
      {assessment.actionFeedback.map(feedback => <p key={feedback.sourceId} className="text-xs text-muted-foreground">实际结算：{feedback.value} {feedback.unit === "points" ? "点" : feedback.unit} · 归一回报 {feedback.normalized.toFixed(3)}</p>)}
      {assessment.predictions.length > 0 && <p className="text-xs text-muted-foreground">相关预测已获反馈：{assessment.predictions.length} 项</p>}
    </div>)}<p className="text-xs text-muted-foreground">适用性是人物的判断；结算与预测反馈来自真实账本。结果关联不等于已经证明策略更优。</p></CardContent></Card>}
    {targets.length > 0 && <Card><CardHeader><CardDescription>有证据的主观判断</CardDescription><CardTitle>关系经验与本局假设</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">{targets.map(id => <div key={id} className="flex flex-col gap-3"><p className="text-sm font-medium">{name(id)}</p>{[beliefs.relationships[id], beliefs.episodeBeliefs[id]].filter(Boolean).map(belief => <div key={belief.scope} className="flex flex-col gap-1 text-sm"><Badge variant="outline" className="w-fit">{belief.scope === "relationship" ? "跨场景关系" : "仅本局假设"}</Badge><p>{belief.hypothesis}</p><p className="text-xs text-muted-foreground">另一种解释：{belief.alternative} · 把握 {Math.round(belief.confidence * 100)}%</p></div>)}</div>)}<p className="text-xs text-muted-foreground">两类判断分别修订。本局身份猜测不会覆盖既有关系，也不会带入下一局。</p></CardContent></Card>}
    <Card><CardHeader><CardDescription>来自实际反馈</CardDescription><CardTitle>学习与预测</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">
      <p className="text-sm">已经历 {mind.learning.episodes.length} 局，处理 {mind.learning.observed} 条可见事件。</p>
      <p className="text-sm">已验证 {mind.learning.scored} 项概率预测{mind.learning.scored > 0 ? ` · 平均 Brier ${(mind.learning.brierSum / mind.learning.scored).toFixed(3)}` : ""}</p>
      {Object.keys(mind.learning.strategies).length > 0 && <Table><TableHeader><TableRow><TableHead>策略</TableHead><TableHead>反馈样本</TableHead><TableHead>平均回报</TableHead></TableRow></TableHeader><TableBody>{Object.entries(mind.learning.strategies).map(([strategy, result]) => <TableRow key={strategy}><TableCell>{strategyLabels[strategy as Strategy]}</TableCell><TableCell>{result.samples}</TableCell><TableCell>{result.meanReturn.toFixed(3)}</TableCell></TableRow>)}</TableBody></Table>}
      <p className="text-xs text-muted-foreground">回报按场景规则归一化。样本记录了策略之后的结果，不代表已证明策略更优。Brier 越低，概率预测误差越小。</p>
      {mind.predictions.slice(-5).map(prediction => <div key={prediction.id} className="flex flex-col gap-1 text-sm"><div className="flex flex-wrap gap-2"><Badge variant="outline">{prediction.result === undefined ? prediction.expired ? "未能验证" : "等待反馈" : "已验证"}</Badge><span>{Math.round(prediction.probability * 100)}%</span></div><p>{name(prediction.targetId)} · {prediction.eventName} · {prediction.field} {prediction.operator === "gte" ? "≥" : prediction.operator === "includes" ? "包含" : "="} {String(prediction.expected)}</p>{prediction.brier !== undefined && <p className="text-xs text-muted-foreground">实际：{prediction.result ? "发生" : "未发生"} · Brier {prediction.brier.toFixed(3)}</p>}</div>)}
    </CardContent></Card>
    {revisions.length > 0 && <Card data-testid="memory-revisions"><CardHeader><CardDescription>依据新证据改变判断</CardDescription><CardTitle>判断的修订记录</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">{revisions.map(({ key, change, after }) => <div key={key} className="flex flex-col gap-2"><div className="flex flex-wrap gap-2"><Badge variant="secondary">{change.change === "retire" ? "停用判断" : "修订判断"}</Badge><Badge variant="outline">版本 {after.revision ?? 1}</Badge></div><p className="text-sm">{change.reason}</p><p className="text-xs text-muted-foreground">{change.sourceIds.length} 条新来源 · 把握 {Math.round(change.previous.confidence * 100)}% → {Math.round(after.confidence * 100)}%</p><Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm">查看前后版本</Button></CollapsibleTrigger><CollapsibleContent className="flex flex-col gap-2"><p className="text-sm">原判断：{change.previous.text}</p>{change.change === "revise" && <p className="text-sm">修订后：{after.text}</p>}{after.when && change.change === "revise" && <p className="text-xs text-muted-foreground">当{after.when}，{after.then}</p>}</CollapsibleContent></Collapsible></div>)}<p className="text-xs text-muted-foreground">旧版本仍可回看；停用的判断不再进入下一次决策。修订属于人物自己的解释，不会改写实际经历。</p></CardContent></Card>}
    <Card><CardHeader><CardDescription>带来源的个人记录</CardDescription><CardTitle>经历与可迁移记忆</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">{mind.memories.slice(-8).map(memory => <div key={memory.id} className="flex flex-col gap-2"><div className="flex flex-wrap gap-2"><Badge variant="secondary">{{ episodic: "经历", semantic: "判断", procedural: "条件策略" }[memory.kind]}</Badge><Badge variant="outline">{memory.status === "retired" ? "已停用" : memory.scope === "transferable" ? "可迁移" : "仅本局"}</Badge>{memory.revision && <Badge variant="outline">版本 {memory.revision}</Badge>}</div><p className="text-sm">{memory.text}</p>{memory.when && <p className="text-xs text-muted-foreground">当{memory.when}，{memory.then}</p>}
      {memory.origin && <p className="text-xs text-muted-foreground">{memory.origin === "ledger" ? "来自实际结算的记录" : "人物自己写入的记录与解释"}</p>}
      {memory.consolidation && <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm">{memory.consolidation.sourceOutcomeIds ? `由 ${memory.consolidation.sourceOutcomeIds.length} 次结算、${memory.consolidation.sourceMemories.length} 条记录提炼` : `由 ${memory.consolidation.sourceMemories.length} 条来源记录提炼`}</Button></CollapsibleTrigger><CollapsibleContent><p className="text-xs text-muted-foreground">{memory.consolidation.rationale}</p><p className="text-xs text-muted-foreground">同一次结算可以有多条记录，不能重复计作新经历。</p></CollapsibleContent></Collapsible>}
      {memory.kind === "procedural" && <p className="text-xs text-muted-foreground">当前版本：采用 {strategyUsage(mind, memory).adopted} 次 · {strategyUsage(mind, memory).outcomeSamples} 个实际结算反馈</p>}
      <p className="text-xs text-muted-foreground">{memory.sourceIds.length} 条来源 · 把握 {Math.round(memory.confidence * 100)}%</p></div>)}{!mind.memories.length && <p className="text-sm text-muted-foreground">尚未形成个人记忆。</p>}</CardContent></Card>
  </div>;
}
