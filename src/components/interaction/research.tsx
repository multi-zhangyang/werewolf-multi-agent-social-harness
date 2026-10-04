import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CommitmentAudit } from "./commitment-audit";
import { AgentActivity } from "./activity";
import { selectActivities } from "@/runtime/behavior";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { headersFor, json, scenarioNames, type RunSummary } from "./api";
import { useRun } from "./room";
import { BehaviorComparison } from "./behavior";
import { MindPanel } from "./mind";
import { DecisionCases } from "./decision-cases";
import { BehaviorLearning } from "./behavior-learning";
import type { AgentMind } from "@/agents/cognition";

export function Research({ id, runs }: { id?: string; runs: RunSummary[] }) {
  return <div className="page-content"><header className="page-heading"><h1>研究</h1><Select value={id ?? ""} onValueChange={v => { location.hash = `#/research/${v}`; }}><SelectTrigger className="w-72"><SelectValue placeholder="选择对局" /></SelectTrigger><SelectContent><SelectGroup>{runs.map(r => <SelectItem key={r.id} value={r.id}>{scenarioNames[r.scenario]} · {new Date(r.createdAt).toLocaleString("zh-CN")}</SelectItem>)}</SelectGroup></SelectContent></Select></header>{id ? <RunResearch key={id} id={id} /> : <p className="text-muted-foreground">选择一场对局</p>}</div>;
}
function RunResearch({ id }: { id: string }) {
  const { run, error, retry } = useRun(id, "", true);
  const [source, setSource] = useState(""); const [outcome, setOutcome] = useState(""); const [fulfillment, setFulfillment] = useState("indeterminate"); const [note, setNote] = useState("");
  const [annotations, setAnnotations] = useState<Record<string, unknown>[]>([]);
  useEffect(() => { void json<{ annotations: Record<string, unknown>[] }>(`/api/v2/runs/${id}/annotations`, { headers: headersFor(id) }).then(r => setAnnotations(r.annotations)).catch(e => toast.error(e.message)); }, [id]);
  if (error) return <Alert><AlertDescription>{error}<Button variant="link" onClick={retry}>重试</Button></AlertDescription></Alert>;
  if (!run) return <Skeleton className="h-64 w-full" />;
  const activities = selectActivities(run.events);
  const turns = run.events.filter(e => e.type === "trace" && ["turn", "missing-action"].includes(e.text));
  const receipts = run.events.filter(e => e.type === "trace" && e.text === "model-response");
  const usage = receipts.length ? receipts : turns;
  const input = usage.reduce((n, e) => n + Number(e.data.inputTokens ?? 0), 0); const output = usage.reduce((n, e) => n + Number(e.data.outputTokens ?? 0), 0);
  const messages = run.events.filter(e => e.type === "message"); const outcomes = run.events.filter(e => e.type === "action" || e.data.settlement);
  const policyLabels: Record<string, string> = { "scripted round 1; production Agent round 2": "第 1 轮采用固定策略，第 2 轮由模型自主决策", "fixed scripted peer": "采用固定策略" };
  const policies = Object.entries(run.modelConfigs ?? {}).flatMap(([actorId, config]) => typeof config.experimentPolicy === "string"
    ? [{ actorId, name: run.characters.find(character => character.id === actorId)?.name ?? actorId, description: policyLabels[config.experimentPolicy] ?? config.experimentPolicy }] : []);
  const syntheticPrior = run.events.some(event => event.data.researchIntervention === "synthetic-memory-prior");
  async function save() { try { const annotation = await json<Record<string, unknown>>(`/api/v2/runs/${id}/annotations`, { method: "POST", headers: headersFor(id), body: JSON.stringify({ sourceId: source, outcomeId: outcome, fulfillment, note }) }); setAnnotations(a => [...a, annotation]); toast.success("标注已保存"); } catch (e) { toast.error((e as Error).message); } }
  function download() { const url = URL.createObjectURL(new Blob([JSON.stringify({ run, annotations }, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `society-${id}.json`; link.click(); URL.revokeObjectURL(url); }
  return <div className="flex flex-col gap-7"><div className="research-metrics"><div><small>发言</small><strong>{messages.length}</strong></div><div><small>平均响应</small><strong>{turns.length ? (turns.reduce((n, e) => n + Number(e.data.durationMs), 0) / turns.length / 1000).toFixed(1) : "—"}<span> s</span></strong></div><div><small>输入 / 输出 token</small><strong>{input.toLocaleString()} / {output.toLocaleString()}</strong></div><Button variant="outline" onClick={download}><Download data-icon="inline-start" />导出</Button></div>
    {policies.length > 0 && <Alert data-testid="experiment-origin"><AlertTitle>本局的实验设置</AlertTitle><AlertDescription><div className="flex flex-col gap-2">{syntheticPrior && <p>旧判断和无关记忆由研究者设定；反证来自按规则实际执行后的结算。</p>}<ul className="list-inside list-disc">{policies.map(policy => <li key={policy.actorId}>{policy.name}：{policy.description}</li>)}</ul></div></AlertDescription></Alert>}
    <Tabs defaultValue={run.scenario === "signaling-game" && run.events.some(e => (e.data.cognition as AgentMind | undefined)?.behaviorModels) ? "beliefs" : run.events.some(e => e.data.kind === "psychology") ? "mind" : "behavior"}><TabsList className="max-w-full justify-start overflow-x-auto">{run.scenario === "signaling-game" && <TabsTrigger value="beliefs">证据与预测</TabsTrigger>}<TabsTrigger value="mind">心理与决策</TabsTrigger><TabsTrigger value="behavior">人物与行动</TabsTrigger><TabsTrigger value="commitments">意图与承诺</TabsTrigger><TabsTrigger value="trace">轨迹</TabsTrigger><TabsTrigger value="annotation">履约标注</TabsTrigger><TabsTrigger value="config">实验配置</TabsTrigger><TabsTrigger value="cases">决策案例</TabsTrigger><TabsTrigger value="events">原始事件</TabsTrigger></TabsList>
      <TabsContent value="beliefs" className="flex min-w-0 flex-col gap-8 pt-4">{run.characters.map(character => {
        const mind = run.events.findLast(e => e.actorId === character.id && e.data.cognition)?.data.cognition as AgentMind | undefined;
        return <section key={character.id} className="flex min-w-0 flex-col gap-3"><h2 className="text-lg font-semibold">{character.name}</h2>{mind?.behaviorModels || mind?.decisions.some(d => d.beliefSnapshot) ? <BehaviorLearning mind={mind!} characters={run.characters} /> : <p className="text-sm text-muted-foreground">暂无证据模型记录</p>}</section>;
      })}</TabsContent>
      <TabsContent value="mind"><div className="mind-comparison">{run.characters.map(character => <MindPanel key={character.id} character={character} characters={run.characters} events={run.events} memories={[]} />)}</div></TabsContent>
      <TabsContent value="commitments"><CommitmentAudit events={run.events} characters={run.characters} /></TabsContent><TabsContent value="behavior"><BehaviorComparison run={run} /></TabsContent>
      <TabsContent value="trace" className="flex flex-col gap-6 pt-6">{activities.length ? activities.map(e => <AgentActivity key={e.id} event={e} character={run.characters.find(c => c.id === e.actorId)} />) : <Empty><EmptyHeader><EmptyTitle>还没有工具活动</EmptyTitle><EmptyDescription>工具返回、行动与笔记会在这里按时间出现。</EmptyDescription></EmptyHeader></Empty>}</TabsContent>
      <TabsContent value="annotation" className="pt-6"><FieldGroup><Field><FieldLabel>原话</FieldLabel><Select value={source} onValueChange={setSource}><SelectTrigger><SelectValue placeholder="选择发言" /></SelectTrigger><SelectContent><SelectGroup>{messages.map(e => <SelectItem key={e.id} value={e.id}>{e.text.slice(0, 65)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel>实际结果</FieldLabel><Select value={outcome} onValueChange={setOutcome}><SelectTrigger><SelectValue placeholder="选择结果" /></SelectTrigger><SelectContent><SelectGroup>{outcomes.map(e => <SelectItem key={e.id} value={e.id}>{e.text.slice(0, 65)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel>履约判断</FieldLabel><Select value={fulfillment} onValueChange={setFulfillment}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="indeterminate">无法判定</SelectItem><SelectItem value="fulfilled">兑现</SelectItem><SelectItem value="violated">违约</SelectItem></SelectGroup></SelectContent></Select></Field><Field><FieldLabel htmlFor="annotation-note">备注</FieldLabel><Textarea id="annotation-note" value={note} onChange={e => setNote(e.target.value)} /></Field><Button disabled={!source || !outcome} onClick={() => void save()}>保存标注</Button><p className="text-muted-foreground">{annotations.length} 条标注</p></FieldGroup></TabsContent>
      <TabsContent value="cases"><DecisionCases runId={id} /></TabsContent><TabsContent value="config"><pre className="data-panel">{JSON.stringify({ spec: run.spec, models: run.modelConfigs }, null, 2)}</pre></TabsContent><TabsContent value="events"><pre className="data-panel">{JSON.stringify(run.events, null, 2)}</pre></TabsContent>
    </Tabs>
  </div>;
}
