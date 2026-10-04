import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { betaEstimate } from "@/agents/behavior-model";
import type { AgentMind } from "@/agents/cognition";
import type { Character } from "@/runtime/types";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
export function BehaviorLearning({ mind, characters }: { mind: AgentMind; characters: Character[] }) {
  const decisions = mind.decisions.filter(d => d.episode === mind.episode && d.beliefSnapshot);
  const models = Object.values(mind.behaviorModels ?? {});
  if (!decisions.length && !models.length) return null;
  const feedback = decisions.flatMap(d => d.beliefFeedback ? [d.beliefFeedback] : []);
  return <section className="flex min-w-0 flex-col gap-4" data-testid="behavior-learning" aria-label="信息交易证据与预测">
    <h3 className="text-base font-semibold">信息交易 · 证据与预测</h3>
    <div className="flex flex-wrap gap-2">{(["quality", "acceptance"] as const).map(kind => {
      const rows = feedback.filter(f => f.kind === kind);
      return <Badge key={kind} variant="outline">{kind === "quality" ? "质量" : "接受"} Brier：{rows.length ? (rows.reduce((sum, f) => sum + f.brier, 0) / rows.length).toFixed(3) : "待核验"} · {rows.length} 次</Badge>;
    })}</div>
    {models.map(model => <div key={JSON.stringify(model.context)} className="flex min-w-0 flex-col gap-2">
      <p className="text-sm">对手：{characters.find(c => c.id === model.context.opponentId)?.name ?? model.context.opponentId} · 本人{model.context.role === "sender" ? "发送" : "接收"} · {model.context.incentives === "aligned" ? "利益一致" : "利益冲突"} · {model.context.payoffProfile === "diagnostic" ? "诊断收益" : "经典收益"} · {model.context.objective === "score" ? "收益目标" : "人物目标"} · 版本 {model.revision}</p>
      <Table><TableHeader><TableRow><TableHead>条件</TableHead><TableHead>{model.context.role === "sender" ? "接受概率" : "报告高的概率"}</TableHead><TableHead>原始样本</TableHead><TableHead>有效样本</TableHead></TableRow></TableHeader><TableBody>{(["high", "low"] as const).map(key => {
        const estimate = betaEstimate(model[key]);
        return <TableRow key={key}><TableCell>{model.context.role === "sender" ? "报告" : "真实"}{key === "high" ? "高质量" : "低质量"}</TableCell><TableCell>{percent(estimate.probability)}{estimate.priorOnly && <Badge variant="outline" className="ml-2">先验</Badge>}</TableCell><TableCell>{estimate.samples}</TableCell><TableCell>{estimate.effectiveSamples.toFixed(2)}</TableCell></TableRow>;
      })}</TableBody></Table>
      <details className="text-xs text-muted-foreground"><summary>结算来源 · {model.sourceIds.length}</summary><ul className="mt-2 flex flex-col gap-1">{model.sourceIds.map(id => <li key={id} className="break-all">{id}</li>)}</ul></details>
    </div>)}
    <Table aria-label="行动前预测与实际反馈"><TableHeader><TableRow><TableHead>轮次 / 版本</TableHead><TableHead>行动 / 策略</TableHead><TableHead>事前预测</TableHead><TableHead>样本 · 原始 / 有效</TableHead><TableHead>实际结果</TableHead><TableHead>Brier</TableHead><TableHead>期望 / 实得</TableHead><TableHead>预计当轮代价</TableHead></TableRow></TableHeader><TableBody>{decisions.map(d => {
      const b = d.beliefSnapshot!, f = d.beliefFeedback, sender = b.context.role === "sender";
      const row = d.parameters?.highQuality ? b.high : b.low;
      const probability = sender ? row.probability : b.highQualityProbability!;
      const samples = sender ? row.samples : b.high.samples + b.low.samples;
      const effective = sender ? row.effectiveSamples : b.high.effectiveSamples + b.low.effectiveSamples;
      return <TableRow key={d.id}><TableCell>{d.round} / v{b.modelRevision}</TableCell><TableCell>{sender ? d.parameters?.highQuality ? "报告高" : "报告低" : d.parameters?.accept ? "接受" : "拒绝"}{d.strategy === "probe" && <Badge variant="outline" className="ml-2">试探</Badge>}</TableCell><TableCell>{sender ? "接受" : "高质量"} {percent(probability)}{samples === 0 ? " · 先验" : ""}</TableCell><TableCell>{samples} / {effective.toFixed(2)}</TableCell><TableCell>{f ? sender ? f.outcome ? "接受" : "拒绝" : f.outcome ? "高质量" : "低质量" : "待结算"}</TableCell><TableCell>{f?.brier.toFixed(3) ?? "-"}</TableCell><TableCell>{d.expectedOwnPayoff?.toFixed(2) ?? "-"} / {f?.actualPayoff ?? "-"}</TableCell><TableCell>{d.estimatedImmediateCost?.toFixed(2) ?? "-"}</TableCell></TableRow>;
    })}</TableBody></Table>
    <p className="text-xs text-muted-foreground">本局知情虚报 {feedback.filter(f => f.knownFalseReport).length} 次 · 虚报成交 {feedback.filter(f => f.falseReportAccepted).length} 次 · 低质成交且报告使估计越过接受门槛 {feedback.filter(f => f.lowQualityAcceptedWithRaisedBelief).length} 次。上述关联不等于因果证明，成交不自动表示成功骗过。</p>
  </section>;
}
