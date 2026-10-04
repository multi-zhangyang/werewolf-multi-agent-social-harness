import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, Fingerprint, History, ScanEye } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { emotionLabels, needLabels, psychologyFromEvent, strategyLabels, isHybrid } from "@/runtime/psychology";
import { scorePredictions } from "@/runtime/predictions";
import type { Character, Memory, WorldEvent } from "@/runtime/types";
import { CharacterDetails } from "./character-details";
import type { RunView } from "./api";
import { GeneralCognition } from "./general-cognition";
import type { AgentMind } from "@/agents/cognition";
import { SignalingSituation } from "./signaling-situation";

const publicFaceLabels: Record<string, string> = { truthful: "如实表达", withhold: "保留信息", bluff: "虚张声势", mixed: "混合表达", none: "未作声明" };

export function GameSituation({ run }: { run: RunView }) {
  if (run.scenario === "signaling-game") return <SignalingSituation run={run} />;
  if (run.scenario !== "trust-game") return null;
  const name = (id?: string) => run.characters.find(c => c.id === id)?.name ?? "等待入场";
  const breach = run.events.findLast(e => e.data.commitment && e.data.round === run.world.round)?.data.commitment as { kept: boolean; promised: number; returned: number } | undefined;
  return <section className="game-situation" aria-label="本轮真实局势">
    <div className="arena-kicker"><span>ROUND {String(run.world.round ?? 1).padStart(2, "0")}</span><Badge variant="outline">{run.world.protocol === "pledge-repair" ? "承诺与修复" : "信任博弈"}</Badge></div>
    <div className="transaction-line"><div><span>投资者</span><strong>{name(run.world.investorId)}</strong></div><div className="transaction-amount"><strong>{run.world.investment === undefined ? "尚未投资" : `${run.world.investment} → ${run.world.investment * 3}`}<small>{run.world.investment === undefined ? "" : " 点到账"}</small></strong><ArrowRight /></div><div><span>受托者</span><strong>{name(run.world.trusteeId)}</strong></div></div>
    <div className="transaction-facts"><span>承诺返还 <strong>{run.world.pledge === undefined ? "尚未正式承诺" : `${run.world.pledge}%`}</strong></span><span>实际返还 <strong>{run.world.returned === undefined ? "尚未返还" : `${run.world.returned} 点`}</strong></span><span>额外补偿 <strong>{run.world.repair === undefined ? "尚未补偿" : `${run.world.repair} 点`}</strong></span></div>
    <p className="mt-2 text-xs text-muted-foreground">资金以实际提交和结算为准；聊天中的金额是说法或意向。</p>
    {breach && <div className="commitment-result"><Badge variant={breach.kept ? "secondary" : "default"}>{breach.kept ? "承诺已兑现" : "承诺未兑现"}</Badge><span>至少承诺 {breach.promised} 点，实际返还 {breach.returned} 点</span></div>}
  </section>;
}

export function MindPanel({ character, characters, events, memories, close, focusSeq }: { character: Character; characters: Character[]; events: WorldEvent[]; memories: Memory[]; close?(): void; focusSeq?: number }) {
  const states = events.filter(e => e.actorId === character.id && psychologyFromEvent(e));
  const [tab, setTab] = useState("mind");
  const [focusedId, setFocusedId] = useState<string>();
  const [ignoreLinked, setIgnoreLinked] = useState(false);
  useEffect(() => { setIgnoreLinked(false); }, [focusSeq]);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.scrollTo({ top: 0 }); }, [tab, focusedId]);
  const linked = focusSeq === undefined || ignoreLinked ? undefined : states.find(e => e.seq > focusSeq) ?? states.findLast(e => e.seq <= focusSeq);
  const current = states.find(e => e.id === focusedId) ?? linked ?? states.at(-1);
  const state = psychologyFromEvent(current);
  const historical = Boolean((focusedId || linked) && current?.id !== states.at(-1)?.id);
  const name = (id: string) => characters.find(c => c.id === id)?.name ?? "既往人物";
  return <aside ref={panel} className="mind-panel" aria-label={`${character.name}的心理视角`}>
    <div className="mind-heading"><Avatar className="size-10"><AvatarFallback>{character.name.slice(-2)}</AvatarFallback></Avatar><div><h2>{character.name}</h2><span>心理视角 · 主观模拟</span></div>{close && <Button variant="ghost" size="sm" onClick={close} aria-label="关闭人物详情">收起</Button>}</div>
    <Tabs value={tab} onValueChange={setTab}><TabsList className="w-full"><TabsTrigger value="mind"><ScanEye />{historical ? "当时" : "此刻"}</TabsTrigger><TabsTrigger value="history"><History />变化</TabsTrigger><TabsTrigger value="character"><Fingerprint />人物设定</TabsTrigger></TabsList>
      <TabsContent value="mind" className="mind-content">
        {state && current ? <>
          {(focusedId || linked) && <Button variant="outline" size="sm" onClick={() => { setFocusedId(undefined); setIgnoreLinked(true); }}>回到此刻</Button>}
          {linked && !focusedId && focusSeq !== undefined && <Card><CardHeader><CardTitle>事件与回应</CardTitle></CardHeader><CardContent className="event-chain"><p>{events.find(e => e.seq === focusSeq)?.text}</p><p>{current.seq > focusSeq ? "下方为该事件之后的首次心理记录。" : "该事件之后尚无心理更新，下方保留此前状态。"}</p>{events.filter(e => e.actorId === character.id && e.seq > current.seq && e.seq < (states.find(e => e.seq > current.seq)?.seq ?? Infinity) && ["message", "action"].includes(e.type)).map(e => <p key={e.id}><Badge variant="outline">{e.type === "message" ? "对外说法" : "实际行动"}</Badge> {e.text}</p>)}</CardContent></Card>}
          <div className="mind-appraisal"><div className="arena-kicker"><span>{historical ? "他当时如何理解" : "他如何理解此刻"}</span><Badge variant="outline">{current.data.origin === "researcher-intervention" ? "实验注入" : "决策前"} · #{states.indexOf(current) + 1}</Badge></div><small>{momentLabel(current, events)} · {historical ? "历史记录" : "最近保存"}</small><p>{state.appraisal}</p></div>
          <section className="mind-strategy"><div className="arena-kicker"><span>{historical ? "当时的策略倾向" : "此刻的策略倾向"}</span><Badge>{strategyLabels[state.strategy.kind]}</Badge></div><h4>私下想达到</h4><p>{state.strategy.aim}</p><h4>打算对外表现</h4><p>{publicFaceLabels[state.strategy.publicFace] ?? state.strategy.publicFace}</p><h4>改变策略的条件</h4><p>{state.strategy.boundary}</p></section>
          {isHybrid(state) && <Card><CardHeader><CardTitle>此刻的拉扯</CardTitle></CardHeader><CardContent className="flex flex-col gap-3"><p>{state.conflict}</p><Badge variant="outline" className="w-fit">{{ reappraise: "重新理解", suppress: "克制表达", ruminate: "反复回想", repair: "主动修复", none: "暂不调节" }[state.regulation]}</Badge><p className="text-sm text-muted-foreground">本次加入 {state.dynamics.newSourceIds.length} 条经历；保留 {Math.round(state.dynamics.inertia * 100)}% 前态。参数为实验假设。</p></CardContent></Card>}
          <div className="mind-measures"><div><h3>情绪</h3>{state.emotions.map(e => <div className="mind-meter" key={e.emotion}><div><span>{emotionLabels[e.emotion]}</span><small>{degree(e.intensity)}</small></div><Progress value={e.intensity * 100} aria-label={`${emotionLabels[e.emotion]}强度`} /></div>)}</div><div><h3>尚未满足的需要</h3>{state.needs.map(n => <div className="mind-meter" key={n.need}><div><span>{needLabels[n.need]}</span><small>{degree(n.tension)}</small></div><Progress value={n.tension * 100} aria-label={`${needLabels[n.need]}的紧张程度`} /></div>)}</div></div>
          <Separator />
          {state.relationships.map(r => <Card key={r.targetId} className="mind-relation"><CardHeader><CardDescription>对他人的主观判断</CardDescription><CardTitle>{name(r.targetId)}</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">{"willingness" in r ? <>{[["合作意愿", r.willingness], ["履约能力", r.competence]].map(([label, value]) => <div key={String(label)} className="mind-meter"><div><span>{label}</span><small>{Number(value).toFixed(2)}</small></div><Progress value={Number(value) * 100} aria-label={String(label)} /></div>)}</> : <div className="mind-meter"><div><span>信任 · 旧版记录</span><small>{r.trust < -.3 ? "戒备" : r.trust > .3 ? "愿意相信" : "保留判断"}</small></div><Progress value={(r.trust + 1) * 50} aria-label="主观信任" /></div>}<div><h4>我猜他在想</h4><p>{r.hypothesis}</p><small>把握：{degree(r.confidence)}</small></div><div><h4>也可能是</h4><p>{r.alternative}</p></div><div><h4>我预期他下一步</h4><p>{r.expectedNextMove}</p></div></CardContent></Card>)}
          {isHybrid(state) && <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm">行为预测与结果 · {state.predictions.length}</Button></CollapsibleTrigger><CollapsibleContent className="flex flex-col gap-3">{scorePredictions(events).filter(p => p.sourceId === current.id).map(p => <div key={p.id} className="text-sm"><Badge variant="outline">{p.status === "scored" ? "已结算" : "未评分"}</Badge><p>第 {p.prediction.round} 轮 · {name(p.prediction.targetId)} · {{ invest: "投资", return_funds: "返还", repair_transfer: "额外补偿" }[p.prediction.action]} ≥ {p.prediction.threshold}{p.prediction.unit === "points" ? " 点" : " 到账比例"}</p><p>预期概率 {Math.round(p.prediction.probability * 100)}%{p.brier !== undefined ? ` · Brier ${p.brier.toFixed(3)}` : " · 等待可判定行动"}</p></div>)}</CollapsibleContent></Collapsible>}

          {current.data.cognition && <GeneralCognition mind={current.data.cognition as AgentMind} characters={characters} />}
          <Evidence event={current} events={events} />
        </> : <Empty><EmptyHeader><EmptyMedia variant="icon"><ScanEye /></EmptyMedia><EmptyTitle>等待人物形成判断</EmptyTitle><EmptyDescription>心理状态仅对本人和研究视角开放。开启心理机制后，人物会在决定之前留下主观状态。</EmptyDescription></EmptyHeader></Empty>}
      </TabsContent>
      <TabsContent value="history" className="mind-content">
        <p className="text-xs text-muted-foreground">从最近一次往回看。信任数值是人物的主观估计；点击记录可回看当时的完整心理状态。</p>
        {states.toReversed().map((event, i) => {
          const index = states.length - i - 1;
          const m = psychologyFromEvent(event)!;
          const previous = psychologyFromEvent(states[index - 1]);
          const end = states[index + 1]?.seq ?? Infinity;
          const next = events.filter(e => e.seq > event.seq && e.seq < end && e.actorId === character.id && (e.type === "action" || e.type === "message"));
          return <Card key={event.id} data-psychology-event={event.id}>
            <CardHeader><CardDescription>{momentLabel(event, events)} · 更新 {index + 1}</CardDescription><CardTitle>{previous && previous.strategy.kind !== m.strategy.kind ? `${strategyLabels[previous.strategy.kind]} → ` : ""}{strategyLabels[m.strategy.kind]}</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p>{m.appraisal}</p>
              <div className="flex flex-wrap gap-2">{m.emotions.map(e => <Badge key={e.emotion} variant="outline">{emotionLabels[e.emotion]} · {degree(e.intensity)}</Badge>)}</div>
              {m.relationships.map(r => {
                const before = previous?.relationships.find(p => p.targetId === r.targetId);
                return <div key={r.targetId} className="mind-history-trust"><span>对{name(r.targetId)}的{"willingness" in r ? "合作意愿判断" : "主观信任"}</span><strong>{before ? `${trustNumber("willingness" in before ? before.willingness : before.trust)} → ` : ""}{trustNumber("willingness" in r ? r.willingness : r.trust)}</strong></div>;
              })}
              {next.length > 0 && <div className="flex flex-col gap-2"><h4>随后实际发生</h4>{next.map(e => <p key={e.id}>{e.text}</p>)}</div>}
              <Evidence event={event} events={events} />
            </CardContent>
            <CardFooter><Button variant="outline" size="sm" className="w-full" aria-label={`查看更新 ${index + 1} 的心理状态`} onClick={() => { setFocusedId(event.id); setTab("mind"); }}>查看当时心理<ArrowRight data-icon="inline-end" /></Button></CardFooter>
          </Card>;
        })}
      </TabsContent>
      <TabsContent value="character"><CharacterDetails character={character} memories={memories} /></TabsContent>
    </Tabs>
  </aside>;
}
function degree(value: number) { return value >= .7 ? "高" : value >= .35 ? "中" : "低"; }
function trustNumber(value: number) { return `${value > 0 ? "+" : ""}${value.toFixed(2)}`; }
function momentLabel(event: WorldEvent, events: WorldEvent[]) {
  const phase = events.findLast(e => e.type === "phase" && e.seq <= event.seq);
  return `第 ${String(event.data.round ?? "—")} 轮${phase ? ` · ${phase.text}` : ""}`;
}
function Evidence({ event, events }: { event: WorldEvent; events: WorldEvent[] }) {
  const state = psychologyFromEvent(event)!;
  return <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />触发判断的经历 · {state.sourceIds.length}</Button></CollapsibleTrigger><CollapsibleContent><div className="mind-evidence">{state.sourceIds.map(id => <p key={id}>{events.find(e => e.id === id)?.text ?? "来自已有经历；当前回放未包含该事件"}</p>)}</div></CollapsibleContent></Collapsible>;
}
