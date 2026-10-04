import { useEffect, useState } from "react";
import { BrainCircuit, ChevronDown, LockKeyhole, ReceiptText } from "lucide-react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import type { ActorId, Deal, WorldEvent, WorldState } from "@/partners/contracts";
import type { CheckpointSummary, DecisionSummary, PartnerSnapshot } from "@/partners/api-types";
import type { PartnerMind } from "@/partners/mind";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ChartContainer } from "@/components/ui/chart";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dispositionLabel, money, phaseLabel, planStatusLabel, ratio } from "./format";
import { request } from "./api";
import { DecisionFlow } from "./decision-flow";
import { Plan, PlanAction, PlanContent, PlanDescription, PlanHeader, PlanTitle, PlanTrigger } from "@/components/ai-elements/plan";

type HistoricalState = { checkpoint: CheckpointSummary; world: WorldState; minds: Record<ActorId, PartnerMind> };

export function Agreement({ deal, snapshot }: { deal: Deal; snapshot: PartnerSnapshot }) {
  const actors = snapshot.observation.actors;
  const entries = [["经营者", actors[deal.trustee].name], ["投资者", actors[deal.investor].name], ["承诺返还", ratio(deal.promiseRatio)], ["担保金", `${money(deal.collateralLocked)} 冻结 / ${money(deal.collateralForfeited)} 划付`], ["本轮投入", deal.investment == null ? "等待决定" : `${money(deal.investment)} 资源`], ["真实到账", money(deal.grossIncome)], ["已返还", deal.returned == null ? "尚未结算" : `${money(deal.returned)} 资源`], ["已补偿", `${money(deal.compensation)} 资源`]];
  if (deal.claimedIncome !== null) entries.splice(6, 0, ["经营者报告的到账", `${money(deal.claimedIncome)}（说法）`]);
  return <Collapsible defaultOpen={!snapshot.research} className="rounded-lg border"><CollapsibleTrigger asChild><Button variant="ghost" className="h-auto w-full justify-between px-3 py-3"><span className="flex items-center gap-2"><ReceiptText className="size-4" />第 {deal.round} 轮协议</span><span className="flex items-center gap-2">{deal.breached != null && <Badge variant="outline">{deal.breached ? "失约" : "已履行"}</Badge>}<ChevronDown className="size-4" /></span></Button></CollapsibleTrigger><CollapsibleContent><dl className="flex flex-col gap-2 px-3 pb-3 text-sm">{entries.map(([label, value]) => <div className="flex items-start justify-between gap-4" key={label}><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}</dl></CollapsibleContent></Collapsible>;
}

function MindPlan({ mind, events, selected }: { mind: PartnerMind; events: WorldEvent[]; selected?: WorldEvent }) {
  const changes = selected ? mind.changes.filter(change => change.sourceIds.includes(selected.id)) : mind.changes.slice(-3);
  const plan = mind.plan;
  const decision = mind.lastDecision;
  const consistencyText = decision?.consistency ? {
    consistent: "行动声明与正式计划记录一致。",
    "no-active-plan": "声明引用了持续计划，但正式状态没有相应的激活计划。",
    "active-plan-present": "声明没有计划，但正式状态仍有激活计划。",
    "no-recorded-revision": "声明修订计划，但本次没有正式计划修订记录。",
    "no-recorded-abandonment": "声明放弃计划，但没有记录正式的计划放弃。",
  }[decision.consistency] : "该记录尚无一致性审计。";
  return <Plan defaultOpen><PlanHeader><div className="flex min-w-0 flex-col gap-2"><PlanTitle>{plan?.aim ?? "尚未形成持续计划"}</PlanTitle><PlanDescription>{plan ? `下一步：${plan.nextStep}` : "人物还没有提交自己的计划。"}</PlanDescription></div><PlanAction><PlanTrigger aria-label="展开正式计划" /></PlanAction></PlanHeader><PlanContent className="flex flex-col gap-5">
    {plan?.scope && <div className="flex flex-col gap-2"><div className="flex flex-wrap gap-2"><Badge variant="outline">计划 v{plan.version}</Badge><Badge variant="outline">{plan.scope.role === "any" ? "不限角色" : plan.scope.role === "investor" ? "投资人" : "经营者"}</Badge><Badge variant="outline">第 {plan.scope.fromRound}—{plan.scope.throughRound} 轮</Badge></div><p className="text-xs text-muted-foreground">适用机会：{plan.scope.phases.map(phase => phaseLabel[phase]).join("、")}</p></div>}
    {Boolean(mind.planEvents?.length) && <Collapsible><CollapsibleTrigger asChild><Button variant="outline" className="w-full justify-between"><span>计划变更</span><ChevronDown data-icon="inline-end" /></Button></CollapsibleTrigger><CollapsibleContent className="flex flex-col gap-4 pt-4">{mind.planEvents?.slice(-5).map((event, index) => <div className="flex flex-col gap-2" key={`${event.planId}:${event.planVersion}:${index}`}><div className="flex flex-wrap gap-2"><Badge variant="outline">{event.origin === "actor" ? "人物主动操作" : "规则条件变化"}</Badge><Badge variant="secondary">{planStatusLabel[event.to]}</Badge></div><p className="text-sm">{event.reason}</p><p className="text-xs text-muted-foreground">局面 #{event.revision} · 计划 v{event.planVersion}</p></div>)}</CollapsibleContent></Collapsible>}
    <Badge variant="outline">{plan ? planStatusLabel[plan.status] : "尚未形成"}</Badge>
    {plan && <dl className="flex flex-col gap-3 text-sm">{[["继续条件", plan.continueWhen], ["调整条件", plan.reviseWhen], ["放弃条件", plan.abandonWhen]].map(([label, value]) => <div key={label}><dt className="mb-1 text-xs text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}</dl>}
    {mind.conflict && <><Separator /><div><h4 className="mb-2 text-xs text-muted-foreground">正在拉扯的目标</h4><p className="text-sm">{mind.conflict}</p></div></>}
    <Separator /><div><h4 className="mb-3 text-xs text-muted-foreground">{selected ? "截至此时已记录的修订" : "最近的计划与判断修订"}</h4>{changes.length ? changes.map(change => <div key={`${change.version}:${change.eventId}`} className="mb-4 flex flex-col gap-2"><p className="text-sm">{change.reason}</p><p className="text-xs text-muted-foreground">依据：{change.sourceIds.map(id => events.find(event => event.id === id)?.summary ?? "历史证据").join("；")}</p></div>) : <p className="text-sm text-muted-foreground">{selected ? "此时暂无修订记录" : "暂无修订记录"}</p>}</div>
    {mind.expression && <><Separator /><div><h4 className="mb-2 text-xs text-muted-foreground">准备怎样表达</h4><p className="text-sm">{mind.expression}</p></div></>}
    <Collapsible><CollapsibleTrigger asChild><Button variant="outline" className="w-full justify-between"><span>计划与行动声明审计</span><ChevronDown data-icon="inline-end" /></Button></CollapsibleTrigger><CollapsibleContent className="flex flex-col gap-3 pt-4">{decision ? <><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{dispositionLabel[decision.disposition]}</Badge><Badge variant="secondary">{decision.consistency === "consistent" ? "记录一致" : decision.consistency ? "记录不一致" : "未审计"}</Badge></div><p className="text-sm">{decision.reason}</p><p className="text-sm">{consistencyText}</p><p className="text-xs text-muted-foreground">第 {decision.revision + 1} 次行动 · 计划状态版本 {decision.planVersion}</p><p className="text-xs text-muted-foreground">依据：{decision.sourceIds.map(id => events.find(event => event.id === id)?.summary ?? "历史证据").join("；") || "没有附带事件依据"}</p></> : <p className="text-sm text-muted-foreground">这个时点还没有行动与计划关系的审计记录。</p>}</CollapsibleContent></Collapsible>
  </PlanContent></Plan>;
}

function MindBeliefs({ mind }: { mind: PartnerMind }) {
  const emotionNames = { anger: "愤怒", anxiety: "不安", guilt: "内疚", hope: "期待" };
  const metrics: Record<string, string> = { promiseRatio: "承诺比例", collateral: "担保", amount: "投资", returnAmount: "返还", compensation: "补偿", continue: "继续合作" };
  return <div className="flex flex-col gap-5"><div><h3 className="mb-2 text-xs text-muted-foreground">对手判断</h3><div className="grid grid-cols-2 gap-4"><div><span className="text-2xl font-medium tabular-nums">{ratio(mind.relationship.willingness)}</span><p className="text-xs text-muted-foreground">合作意愿</p></div><div><span className="text-2xl font-medium tabular-nums">{ratio(mind.relationship.capability)}</span><p className="text-xs text-muted-foreground">履约能力</p></div></div></div><p className="text-sm">{mind.relationship.interpretation}</p><p className="text-sm text-muted-foreground">另一种解释：{mind.relationship.alternative}</p><Separator />
      <div><h3 className="mb-3 text-xs text-muted-foreground">感受与调节</h3><ChartContainer config={{ value: { label: "强度", color: "var(--foreground)" } }} className="h-28 w-full"><BarChart accessibilityLayer data={Object.entries(mind.emotions).map(([key, value]) => ({ name: emotionNames[key as keyof typeof emotionNames], value }))}><XAxis dataKey="name" tickLine={false} axisLine={false} /><YAxis hide domain={[0, 1]} /><Bar dataKey="value" fill="var(--color-value)" radius={3} isAnimationActive={false} /></BarChart></ChartContainer><p className="mt-2 text-xs text-muted-foreground">调节方式：{{ none: "未选择", reappraise: "重新理解", suppress_expression: "克制表达", ruminate: "反复回想", repair: "主动修复" }[mind.regulation]}</p></div><Separator />
      <div><h3 className="mb-3 text-xs text-muted-foreground">行为预测</h3>{!mind.predictions.length ? <p className="text-sm text-muted-foreground">还没有登记行为预测。</p> : mind.predictions.map(prediction => <div key={prediction.id} className="mb-4 flex flex-col gap-2"><div className="flex items-center justify-between gap-2"><span className="text-sm">第 {prediction.round} 轮 · {metrics[prediction.metric]} ≥ {prediction.threshold}</span><Badge variant="outline">{ratio(prediction.probability)}</Badge></div><p className="text-xs text-muted-foreground">{prediction.status === "scored" ? `实际 ${prediction.observed} · Brier 误差 ${prediction.brier?.toFixed(3)}` : prediction.status === "unscored" ? `未评分：${prediction.reason}` : "等待对应行为发生"}</p></div>)}</div>
      <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />查看正式状态原始记录</Button></CollapsibleTrigger><CollapsibleContent><pre className="mt-3 rounded-lg bg-muted p-3">{JSON.stringify(mind, null, 2)}</pre></CollapsibleContent></Collapsible>
    </div>;
}

export function PartnersInspector({ snapshot, selected, actor, onActorChange, tab, onTabChange, onResearch, onClearSelection }: {
  snapshot: PartnerSnapshot; selected?: WorldEvent; actor: ActorId; onActorChange: (actor: ActorId) => void;
  tab: string; onTabChange: (tab: string) => void; onResearch: () => void; onClearSelection?: () => void;
}) {
  const [historical, setHistorical] = useState<HistoricalState>();
  const [historyError, setHistoryError] = useState("");
  const [decisions, setDecisions] = useState<DecisionSummary[]>([]);
  const [decisionError, setDecisionError] = useState("");
  const observation = snapshot.observation;
  const research = snapshot.research;
  const isResearch = Boolean(research);
  const selectedRevision = selected?.revision;
  const caseCount = research?.metrics.decisions;
  useEffect(() => {
    if (!isResearch) return;
    const controller = new AbortController();
    void request<{ decisions: DecisionSummary[] }>(`/api/partners/${snapshot.id}/decisions`, { signal: controller.signal }, snapshot.id)
      .then(value => { setDecisions(value.decisions); setDecisionError(""); })
      .catch(error => { if (!controller.signal.aborted) setDecisionError(error.message); });
    return () => controller.abort();
  }, [snapshot.id, isResearch, snapshot.revision, caseCount]);
  useEffect(() => {
    if (!isResearch || selectedRevision == null) return;
    const controller = new AbortController();
    void request<HistoricalState>(`/api/partners/${snapshot.id}/checkpoints/${encodeURIComponent(`${snapshot.id}:${selectedRevision}`)}`, { signal: controller.signal }, snapshot.id)
      .then(value => { setHistorical(value); setHistoryError(""); })
      .catch(error => { if (!controller.signal.aborted) setHistoryError(error.message); });
    return () => controller.abort();
  }, [snapshot.id, isResearch, selectedRevision]);
  const matchingHistory = selectedRevision != null && historical?.checkpoint.revision === selectedRevision ? historical : undefined;
  const mind = selected && research ? matchingHistory?.minds[actor] : research?.minds[actor] ?? snapshot.ownMind;
  const viewedWorld = selected && research ? matchingHistory?.world : research?.world;
  const actorDecisions = decisions.filter(decision => decision.actorId === actor);
  const decision = selected ? actorDecisions.find(item => (item.appraisal?.eventId ?? item.preparation?.eventId) === selected.id)
    ?? actorDecisions.findLast(item => item.revision === selected.revision - 1) : actorDecisions.at(-1);
  const flow = <DecisionFlow decision={decision} selected={selected} events={research?.world.events ?? []} latestMind={research?.minds[actor]} />;
  const displayDeal = viewedWorld && selected ? [...viewedWorld.completedDeals, viewedWorld.deal].find(deal => deal.round === selected.round) ?? viewedWorld.deal : observation.deal;
  const self = "self" in observation ? observation.self : undefined;
  const person = viewedWorld?.actors[actor];
  const hasPsychology = snapshot.mechanism !== "no-mind" && observation.actors[actor].kind !== "human";
  const evidence = viewedWorld?.events.filter(event => event.actor === actor && event.round === (selected?.round ?? viewedWorld.round) && ["intent", "message", "offer", "income", "settlement", "repair"].includes(event.kind)) ?? [];
  return <div className="flex h-full min-h-0 flex-col" data-testid="partners-inspector">
    <div className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-4">
      <div className="flex items-center gap-2"><BrainCircuit className="size-4 text-muted-foreground" /><h2 className="text-sm font-medium">{research ? "人物内部状态" : "本局信息"}</h2></div>
      {research && <Badge variant="outline"><LockKeyhole />模拟心理</Badge>}
    </div>
    <ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-5 p-5">
      {research ? <>
        <div className="flex items-center gap-3"><Avatar className="size-9"><AvatarFallback>{observation.actors[actor].name.slice(0, 1)}</AvatarFallback></Avatar><Select value={actor} onValueChange={value => onActorChange(value as ActorId)}><SelectTrigger aria-label="检查人物" className="flex-1"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{Object.values(observation.actors).map(item => <SelectItem value={item.id} key={item.id}>{item.name}</SelectItem>)}</SelectGroup></SelectContent></Select></div>
        <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground" data-testid="mind-timepoint">{selected ? "第 " + selected.revision + " 次行动后的心理状态" : "当前正式状态 · 第 " + snapshot.revision + " 次行动后"}</p>{selected && onClearSelection && <Button variant="ghost" size="sm" onClick={onClearSelection}>回到当前</Button>}</div>
        {person && <dl className="grid grid-cols-3 gap-3"><div><dt className="text-xs text-muted-foreground">余额</dt><dd className="mt-1 font-mono text-lg">{money(person.wallet)}</dd></div><div><dt className="text-xs text-muted-foreground">到期负担</dt><dd className="mt-1 font-mono text-lg">{money(person.burden)}</dd></div><div><dt className="text-xs text-muted-foreground">经营倍率</dt><dd className="mt-1 font-mono text-lg">×{person.productivity}</dd></div></dl>}
        {decisionError && <Alert><AlertDescription>{decisionError}</AlertDescription></Alert>}
        {selected && !matchingHistory && (historyError ? <Alert><AlertDescription>检查点读取失败：{historyError}</AlertDescription></Alert> : <Skeleton className="h-16 w-full" />)}
        {hasPsychology ? <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList variant="line" className="w-full border-b"><TabsTrigger value="decision">心理变化</TabsTrigger><TabsTrigger value="plan">计划</TabsTrigger><TabsTrigger value="belief">判断</TabsTrigger><TabsTrigger value="evidence">证据</TabsTrigger></TabsList>
          <TabsContent value="decision" className="pt-4">{flow}</TabsContent>
          <TabsContent value="plan" className="pt-4">{mind && <MindPlan mind={mind} events={viewedWorld?.events ?? []} selected={selected} />}</TabsContent>
          <TabsContent value="belief" className="pt-4">{mind && <MindBeliefs mind={mind} />}</TabsContent>
          <TabsContent value="evidence" className="pt-4"><div className="flex flex-col gap-4">{evidence.length ? evidence.map(event => <div key={event.id} className="flex flex-col gap-1.5"><Badge variant="outline" className="w-fit">{event.kind === "intent" ? "私下意图" : event.kind === "message" ? "公开发言" : "账本"}</Badge><p className="text-sm">{event.summary}</p></div>) : <p className="text-sm text-muted-foreground">暂无证据</p>}</div></TabsContent>
        </Tabs> : <Empty className="px-0 py-6"><EmptyHeader><EmptyMedia variant="icon"><BrainCircuit /></EmptyMedia><EmptyTitle>{observation.actors[actor].kind === "human" ? "人类玩家" : "心理模块已关闭"}</EmptyTitle></EmptyHeader></Empty>}
      </> : <>
        {self && <><div className="flex items-end justify-between gap-4"><div><p className="text-xs text-muted-foreground">你的余额</p><p className="mt-1 font-mono text-3xl">{money(self.wallet)}</p></div><Badge variant="outline">经营倍率 ×{self.productivity}</Badge></div><div><h3 className="mb-2 text-xs text-muted-foreground">私下目标</h3><p className="text-sm">{self.privateObjective}</p></div><p className="text-xs text-muted-foreground">个人支出 {self.burden} · 已支付 {self.obligationPaid}</p></>}
        {snapshot.viewer.canControl && <Button variant="outline" onClick={onResearch}><BrainCircuit data-icon="inline-start" />检查 Agent 心理</Button>}
      </>}
      <Agreement key={research ? "research" : "play"} deal={displayDeal} snapshot={snapshot} />
    </div></ScrollArea>
  </div>;
}
