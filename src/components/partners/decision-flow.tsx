import { ArrowRight, ChevronDown, CircleCheck, GitBranch } from "lucide-react";
import type { DecisionSummary } from "@/partners/api-types";
import type { WorldEvent } from "@/partners/contracts";
import type { PartnerMind } from "@/partners/mind";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { actionLabel, money, planOperationLabel, ratio } from "./format";

export function DecisionFlow({ decision, events, latestMind, selected }: { decision?: DecisionSummary; events: WorldEvent[]; latestMind?: PartnerMind; selected?: WorldEvent }) {
  if (!decision) return <Empty className="px-0 py-8"><EmptyHeader><EmptyTitle>尚无决策</EmptyTitle><EmptyDescription>{selected ? "此时还没有该人物的决策记录。" : "等待人物完成第一次选择。"}</EmptyDescription></EmptyHeader></Empty>;
  const preparation = decision.preparation; const receipt = decision.receipt;
  const appraisal = decision.appraisal; const eventId = appraisal?.eventId ?? preparation?.eventId;
  const evidence = eventId ? events.find(event => event.id === eventId) : events.findLast(event => event.revision <= decision.revision);
  const before = appraisal?.before ?? preparation?.before ?? decision.before; const after = decision.actionMind ?? appraisal?.after ?? preparation?.after ?? decision.after;
  const prediction = receipt?.predictionId ? latestMind?.predictions.find(item => item.id === receipt.predictionId) : undefined;
  const metric = receipt?.forecast?.metric;
  const metricNames = { promiseRatio: "承诺比例", collateral: "担保", amount: "投资", returnAmount: "返还", compensation: "补偿", continue: "继续合作" };
  const changes = before && after ? [
    ...Object.entries(after.emotions).flatMap(([key, value]) => value === before.emotions[key as keyof typeof before.emotions] ? [] : [{ label: { anger: "愤怒", anxiety: "不安", guilt: "内疚", hope: "期待" }[key], before: before.emotions[key as keyof typeof before.emotions], after: value }]),
    ...(["willingness", "capability"] as const).flatMap(key => before.relationship[key] === after.relationship[key] ? [] : [{ label: key === "willingness" ? "合作意愿" : "履约能力", before: before.relationship[key], after: after.relationship[key] }]),
  ] : [];
  return <div className="flex flex-col gap-5" data-testid="decision-flow" data-case-id={decision.id}>
    <div className="flex items-center justify-between gap-2"><Badge variant={decision.status === "failed" ? "destructive" : "outline"}>{decision.status === "failed" ? "未提交" : "已提交"}</Badge><span className="font-mono text-xs text-muted-foreground">#{decision.revision + 1} · {(decision.durationMs / 1000).toFixed(1)}s</span></div>
    {selected && eventId === selected.id && <Badge variant="secondary" className="w-fit">后续回应 · 行动 #{decision.revision + 1}</Badge>}
    {decision.error && <Alert variant="destructive"><AlertDescription>{decision.error}</AlertDescription></Alert>}
    {decision.shadow && <Badge variant="outline" className="w-fit">{decision.shadow.status === "failed" ? "独立心理记录失败" : "独立心理记录 · 未参与行动"}</Badge>}
    <section className="flex flex-col gap-2"><h3 className="text-xs text-muted-foreground">触发事件</h3><p className="text-sm">{evidence?.summary ?? "开场"}</p></section>
    <Separator />
    <section className="flex flex-col gap-3"><h3 className="text-xs text-muted-foreground">他的判断</h3>
      {receipt?.basis === "facts-only" ? <p className="text-sm text-muted-foreground">心理模块未参与此次选择</p> : <p className="text-sm">{appraisal?.reason ?? preparation?.reason ?? after?.relationship.interpretation ?? "沿用当前判断"}</p>}
      {changes.length > 0 && <dl className="flex flex-col gap-2">{changes.map(change => <div className="flex items-center justify-between gap-3 text-sm" key={change.label}><dt className="text-muted-foreground">{change.label}</dt><dd className="flex items-center gap-2 tabular-nums"><span className="text-muted-foreground">{ratio(change.before)}</span><ArrowRight className="size-3" />{ratio(change.after)}</dd></div>)}</dl>}
      {after?.conflict && receipt?.basis !== "facts-only" && <p className="border-l-2 pl-3 text-sm text-muted-foreground">{after.conflict}</p>}
    </section>
    {(after?.plan || preparation) && receipt?.basis !== "facts-only" && <><Separator /><section className="flex flex-col gap-2"><div className="flex items-center justify-between gap-2"><h3 className="text-xs text-muted-foreground">策略</h3>{preparation && <Badge variant="outline"><GitBranch />{planOperationLabel[preparation.planOperation]}</Badge>}</div><p className="text-sm">{after?.plan?.nextStep ?? "本次单独选择"}</p></section></>}
    {decision.planOperations?.length ? <div className="flex flex-col gap-2">{decision.planOperations.map((operation, index) => <p className="text-sm" key={index}><Badge variant="outline">{planOperationLabel[operation.kind]}</Badge> {operation.reason}</p>)}</div> : null}
    <Separator /><section className="flex flex-col gap-2"><h3 className="text-xs text-muted-foreground">实际选择</h3><p className="text-sm font-medium">{decision.status === "completed" ? actionLabel(decision.action) : "未执行"}</p>{decision.action?.intent && <p className="text-sm text-muted-foreground">{decision.action.intent}</p>}{receipt?.influence && <p className="text-sm"><span className="text-muted-foreground">希望对方相信：</span>{receipt.influence.desiredBelief}</p>}</section>
    {receipt?.claimAudit && <dl className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm"><div><dt className="mb-1 text-xs text-muted-foreground">已知收入</dt><dd className="font-mono">{money(receipt.claimAudit.knownIncome)}</dd></div><div><dt className="mb-1 text-xs text-muted-foreground">声称收入</dt><dd className="font-mono">{money(receipt.claimAudit.claimedIncome)}</dd></div><div className="col-span-2 flex gap-2"><Badge variant="outline">{receipt.claimAudit.publiclyDisclosed ? "已披露凭证" : "未披露凭证"}</Badge>{receipt.claimAudit.mismatch && <Badge variant="outline">金额不一致</Badge>}</div></dl>}
    {preparation && <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="w-full justify-between px-0"><span>候选决策 · {preparation.candidates.length}</span><ChevronDown data-icon="inline-end" /></Button></CollapsibleTrigger><CollapsibleContent className="pt-2"><Table><TableHeader><TableRow><TableHead>行动</TableHead><TableHead>预期 / 风险</TableHead></TableRow></TableHeader><TableBody>{preparation.candidates.map(candidate => <TableRow key={candidate.id} data-state={receipt?.candidateId === candidate.id ? "selected" : undefined}><TableCell className="whitespace-normal align-top"><p className="text-xs">{actionLabel(candidate.action)}</p>{receipt?.candidateId === candidate.id && <CircleCheck className="mt-1 size-3.5" aria-label="实际选择" />}</TableCell><TableCell className="whitespace-normal align-top"><p className="text-xs">{candidate.expectedOutcome}</p><p className="mt-1 text-xs text-muted-foreground">{candidate.risk}</p></TableCell></TableRow>)}</TableBody></Table></CollapsibleContent></Collapsible>}
    {receipt?.forecast && metric && <><Separator /><section className="flex flex-col gap-2"><div className="flex items-center justify-between"><h3 className="text-xs text-muted-foreground">行为预测</h3><Badge variant="outline">{ratio(receipt.forecast.probability)}</Badge></div><p className="text-sm">第 {receipt.forecast.round} 轮 · {metricNames[metric]} ≥ {receipt.forecast.threshold}</p><p className="text-xs text-muted-foreground">{prediction?.status === "scored" ? "实际 " + prediction.observed + " · Brier " + prediction.brier?.toFixed(3) : prediction?.status === "unscored" ? "未评分：" + prediction.reason : "等待验证"}</p></section></>}
    <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="w-full justify-between px-0"><span>运行记录</span><ChevronDown data-icon="inline-end" /></Button></CollapsibleTrigger><CollapsibleContent className="flex flex-col gap-2 pt-2"><p className="break-all font-mono text-xs">{decision.harnessVersion} · {decision.sourceHash.slice(0, 12)}</p><p className="text-xs text-muted-foreground">{decision.inputTokens.toLocaleString()} 输入 / {decision.outputTokens.toLocaleString()} 输出 · 重试 {decision.retries} · 错误 {decision.failures}</p>{!receipt && <Badge variant="outline" className="w-fit">历史协议</Badge>}</CollapsibleContent></Collapsible>
  </div>;
}
