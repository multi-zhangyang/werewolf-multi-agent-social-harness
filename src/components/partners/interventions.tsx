import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, BrainCircuit, ChevronDown, Download, Pause, Play, Square } from "lucide-react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import type { InterventionAnalysis, InterventionSpec, InterventionView } from "@/partners/intervention-types";
import type { Action } from "@/partners/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChartContainer } from "@/components/ui/chart";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { credentials, download, post, remember, request } from "./api";
import { actionLabel, mechanismLabel, ratio, shortDate } from "./format";

type Source = { runId: string; revision: string; actorId: "a" | "b" };
const names = { willingness: "合作意愿", capability: "履约能力" };
const rowStatus = { pending: "未开始", running: "运行中", completed: "已取样", failed: "失败保留", stopped: "已停止" };

function Setup({ source }: { source?: Source }) {
  const [construct, setConstruct] = useState<InterventionSpec["construct"]>("willingness");
  const [low, setLow] = useState("0.2"); const [high, setHigh] = useState("0.8");
  const [repeats, setRepeats] = useState("3"); const [seed, setSeed] = useState("731");
  const [horizon, setHorizon] = useState<InterventionSpec["horizon"]>("decision");
  const [mechanisms, setMechanisms] = useState<InterventionSpec["mechanisms"]>(["full", "record-only"]);
  const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const [recent, setRecent] = useState<InterventionView[]>();
  const total = 2 * mechanisms.length * Number(repeats);
  useEffect(() => {
    const controller = new AbortController();
    void request<{ experiments: InterventionView[] }>("/api/partners/interventions", { signal: controller.signal })
      .then(value => setRecent(value.experiments)).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, []);
  const invalid = !Number.isFinite(Number(low)) || !Number.isFinite(Number(high)) || Number(low) < 0 || Number(high) > 1 || Number(low) >= Number(high)
    || !Number.isInteger(Number(repeats)) || Number(repeats) < 1 || Number(repeats) > 5 || !mechanisms.length;
  async function create() {
    setPending(true);
    try {
      const result = await post<{ experiment: InterventionView; ownerToken: string }>("/api/partners/interventions", {
        construct, values: [Number(low), Number(high)], repeats: Number(repeats), seed: Number(seed), mechanisms, horizon,
        ...(source ? { sourceRunId: source.runId, checkpointId: `${source.runId}:${source.revision}`, actorId: source.actorId } : { actorId: "a" }),
      });
      remember(result.experiment.id, { ownerToken: result.ownerToken });
      for (const row of result.experiment.rows) remember(row.runId, { ownerToken: result.ownerToken });
      location.hash = `#/partners-intervention/${result.experiment.id}`;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建失败"); } finally { setPending(false); }
  }
  return <main className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-5 py-7 md:px-10 md:py-10" data-testid="intervention-setup">
    <header className="flex items-center gap-3"><BrainCircuit className="size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold tracking-tight">心理干预</h1><Badge variant="outline">探索性</Badge></header>
    {error && <Alert variant="destructive"><AlertTitle>无法准备实验</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.65fr)]">
      <Card><CardHeader><CardTitle>干预配置</CardTitle><CardDescription>{source ? "检查点 " + source.runId.slice(0, 6) + " · 行动 #" + source.revision + " · 人物 " + source.actorId.toUpperCase() : "固定失约场景 · 人物 A"}</CardDescription></CardHeader>
        <CardContent><FieldGroup className="gap-5">
          <Field><FieldLabel htmlFor="intervention-construct">干预变量</FieldLabel><Select value={construct} onValueChange={value => setConstruct(value as InterventionSpec["construct"])}><SelectTrigger id="intervention-construct"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="willingness">对方的合作意愿</SelectItem><SelectItem value="capability">对方的履约能力</SelectItem></SelectGroup></SelectContent></Select></Field>
          <FieldGroup className="grid grid-cols-2 gap-4"><Field data-invalid={Number(low) >= Number(high)}><FieldLabel htmlFor="intervention-low">低值</FieldLabel><Input id="intervention-low" type="number" min="0" max="1" step="0.1" value={low} onChange={event => setLow(event.target.value)} aria-invalid={Number(low) >= Number(high)} /></Field><Field><FieldLabel htmlFor="intervention-high">高值</FieldLabel><Input id="intervention-high" type="number" min="0" max="1" step="0.1" value={high} onChange={event => setHigh(event.target.value)} /></Field></FieldGroup>
          <Field><FieldLabel>机制对照</FieldLabel><ToggleGroup type="multiple" variant="outline" value={mechanisms} onValueChange={value => { if (value.length) setMechanisms(value as InterventionSpec["mechanisms"]); }} aria-label="心理干预机制"><ToggleGroupItem value="full">完整机制</ToggleGroupItem><ToggleGroupItem value="record-only">只记录心理</ToggleGroupItem></ToggleGroup></Field>
          <FieldGroup className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="intervention-repeats">每个组合重复</FieldLabel><Input id="intervention-repeats" type="number" min="1" max="5" value={repeats} onChange={event => setRepeats(event.target.value)} /></Field><Field><FieldLabel htmlFor="intervention-horizon">观察终点</FieldLabel><Select value={horizon} onValueChange={value => setHorizon(value as InterventionSpec["horizon"])}><SelectTrigger id="intervention-horizon"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="decision">一次决定后暂停</SelectItem><SelectItem value="game">整局结束</SelectItem></SelectGroup></SelectContent></Select></Field></FieldGroup>
          <Field><FieldLabel htmlFor="intervention-seed">运行顺序种子</FieldLabel><Input id="intervention-seed" type="number" min="0" max="2147483647" value={seed} onChange={event => setSeed(event.target.value)} /></Field>
        </FieldGroup></CardContent><CardFooter><Button className="w-full" onClick={() => void create()} disabled={pending || invalid}>{pending ? <Spinner data-icon="inline-start" /> : <BrainCircuit data-icon="inline-start" />}准备 {Number.isFinite(total) ? total : "—"} 条独立分支<ArrowRight data-icon="inline-end" /></Button></CardFooter></Card>
      <div className="flex min-w-0 flex-col gap-5">
        <Card><CardHeader><CardTitle>本次实验</CardTitle><CardDescription>外部心理干预</CardDescription></CardHeader><CardContent className="flex flex-col gap-5"><div className="flex items-end justify-between"><span className="text-sm text-muted-foreground">独立分支</span><span className="font-mono text-3xl">{Number.isFinite(total) ? total : "—"}</span></div><dl className="flex flex-col gap-3 text-sm">{[["变量", names[construct]], ["干预值", low + " / " + high], ["机制", mechanisms.length + " 种"], ["每组重复", repeats + " 次"]].map(([label, value]) => <div key={label} className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}</dl></CardContent></Card>
        {!source && <Card><CardHeader><CardTitle>共同前态</CardTitle><CardDescription>实验设置 · 第一轮失约后</CardDescription></CardHeader><CardContent><dl className="grid grid-cols-2 gap-4">{[["承诺", "50%"], ["投入", "6"], ["返还", "0"], ["补偿", "0"]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-xl">{value}</dd></div>)}</dl></CardContent></Card>}
        <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />实验方法</Button></CollapsibleTrigger><CollapsibleContent className="flex flex-col gap-3 pt-3 text-sm text-muted-foreground"><p>只改变指定判断的数值，保留事实、人格、目标和记忆。模型可以重新评价，结果同时记录注入值与行动采用值。</p><p>完整机制读取正式心理；只记录条件先固定行动，再由独立会话记录心理。每条分支有独立账本。</p><p>此处操控的是外部心理状态。运行顺序种子不控制模型采样；一次行为差异不足以证明心理的因果作用。</p></CollapsibleContent></Collapsible>
      </div>
    </div>
    <section className="flex flex-col gap-4"><h2 className="text-sm font-medium">最近实验</h2>{!recent ? <Skeleton className="h-20 w-full" /> : recent.length ? <div className="overflow-hidden rounded-lg border"><Table><TableHeader><TableRow><TableHead>变量</TableHead><TableHead>取样 / 总数</TableHead><TableHead>失败</TableHead><TableHead className="hidden sm:table-cell">时间</TableHead><TableHead><span className="sr-only">打开</span></TableHead></TableRow></TableHeader><TableBody>{recent.map(item => <TableRow key={item.id}><TableCell><a href={"#/partners-intervention/" + item.id}>{names[item.spec.construct]} · {ratio(item.spec.values[0])} / {ratio(item.spec.values[1])}</a></TableCell><TableCell>{item.completed} / {item.total}</TableCell><TableCell>{item.failed}</TableCell><TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{shortDate(item.createdAt)}</TableCell><TableCell><Button variant="ghost" size="icon-sm" asChild><a href={"#/partners-intervention/" + item.id} aria-label="打开心理干预实验"><ArrowRight /></a></Button></TableCell></TableRow>)}</TableBody></Table></div> : <Empty className="rounded-lg border py-8"><EmptyHeader><EmptyTitle>暂无实验</EmptyTitle></EmptyHeader></Empty>}</section>
  </main>;
}

function Comparison({ experiment }: { experiment: InterventionView }) {
  const [analysis, setAnalysis] = useState<InterventionAnalysis>(); const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void request<InterventionAnalysis>(`/api/partners/interventions/${experiment.id}/analysis`, { signal: controller.signal }, experiment.id)
      .then(value => { setAnalysis(value); setError(""); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [experiment.id, experiment.completed, experiment.failed, experiment.stopped]);
  if (error) return <Alert><AlertDescription>{error}</AlertDescription></Alert>;
  if (!analysis) return <Skeleton className="h-52 w-full" />;
  return <div className="flex flex-col gap-6"><Collapsible><div className="flex items-center justify-between gap-3"><Badge variant="outline">探索性结果</Badge><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />统计方法</Button></CollapsibleTrigger></div><CollapsibleContent className="pt-3 text-sm text-muted-foreground">{analysis.note}</CollapsibleContent></Collapsible>
    <div className="grid gap-5 md:grid-cols-2">{analysis.paired.map(pair => <Card key={pair.mechanism}><CardHeader><CardTitle>{mechanismLabel[pair.mechanism]} · 配对比较</CardTitle><CardDescription>相同重复编号中，高档与低档的实际选择</CardDescription></CardHeader><CardContent><p className="text-3xl font-medium tabular-nums">{ratio(pair.actionChanged.mean)}</p><p className="mt-2 text-sm text-muted-foreground">选择发生变化 · 有效配对 {pair.matched} / {experiment.spec.repeats}</p><p className="mt-4 text-xs text-muted-foreground">均值的 95% bootstrap 区间：{pair.actionChanged.ci95 ? `${ratio(pair.actionChanged.ci95[0])}—${ratio(pair.actionChanged.ci95[1])}` : "有效样本不足"}</p></CardContent></Card>)}</div>
    {analysis.groups.some(group => group.walletChange.n > 0) && <Card><CardHeader><CardTitle>余额变化</CardTitle><CardDescription>行动后的实际余额变化均值</CardDescription></CardHeader><CardContent><ChartContainer config={{ value: { label: "余额变化", color: "var(--foreground)" } }} className="h-52 w-full"><BarChart accessibilityLayer data={analysis.groups.filter(group => group.walletChange.mean !== null).map(group => ({ name: `${group.mechanism === "full" ? "完整" : "只记录"} ${ratio(group.value)}`, value: group.walletChange.mean }))}><XAxis dataKey="name" tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} /><Bar dataKey="value" fill="var(--color-value)" radius={3} isAnimationActive={false} /></BarChart></ChartContainer></CardContent></Card>}
    <Table><TableHeader><TableRow><TableHead>条件</TableHead><TableHead>有效 / 总数</TableHead><TableHead>真实动作分布</TableHead><TableHead>缺失收益</TableHead></TableRow></TableHeader><TableBody>{analysis.groups.map(group => <TableRow key={`${group.mechanism}:${group.value}`}><TableCell>{mechanismLabel[group.mechanism]} · {ratio(group.value)}</TableCell><TableCell>{group.completed} / {group.total}</TableCell><TableCell className="whitespace-normal">{group.actions.length ? group.actions.map(item => <p key={item.action} className="text-xs leading-6">{actionLabel(JSON.parse(item.action) as Action)} × {item.count}</p>) : "没有已提交行动"}</TableCell><TableCell>{group.payoff.missing}</TableCell></TableRow>)}</TableBody></Table>
  </div>;
}

function Experiment({ id }: { id: string }) {
  const [experiment, setExperiment] = useState<InterventionView>(); const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await request<InterventionView>(`/api/partners/interventions/${id}`, { signal: controller.signal }, id);
        setExperiment(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value); setError("");
        const auth = credentials(id); if (auth) for (const row of value.rows) remember(row.runId, auth);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "实验读取失败"); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000); }
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id]);
  async function control(command: "pause" | "resume" | "stop") {
    setPending(true);
    try { setExperiment(await post<InterventionView>(`/api/partners/interventions/${id}/control`, { command }, id)); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "操作失败"); } finally { setPending(false); }
  }
  if (!experiment) return <main className="p-8">{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : <Skeleton className="h-72 w-full" />}</main>;
  const finished = experiment.status === "completed" || experiment.status === "stopped";
  const seconds = experiment.rows.reduce((sum, row) => sum + row.durationMs, 0) / 1000;
  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-7 px-5 py-9 md:px-10" data-testid="intervention-experiment">
    <header className="flex flex-wrap items-start justify-between gap-5"><div className="flex items-start gap-3"><Button variant="ghost" size="icon-sm" asChild><a href="#/partners-intervention" aria-label="返回心理干预实验"><ArrowLeft /></a></Button><div><h1 className="text-xl font-semibold tracking-tight">{names[experiment.spec.construct]} · {ratio(experiment.spec.values[0])} / {ratio(experiment.spec.values[1])}</h1><p className="mt-2 text-sm text-muted-foreground">同一前态 · {experiment.spec.repeats} 次重复 · {experiment.spec.horizon === "decision" ? "观察一次决定" : "观察到整局结束"}</p></div></div><div className="flex flex-wrap items-center gap-2">{!finished && <><Button disabled={pending} onClick={() => void control(experiment.status === "running" ? "pause" : "resume")}>{pending ? <Spinner data-icon="inline-start" /> : experiment.status === "running" ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}{experiment.status === "running" ? "暂停实验" : "开始实验"}</Button><Button variant="outline" size="icon" aria-label="停止心理干预实验" disabled={pending} onClick={() => void control("stop")}><Square /></Button></>}<Button variant="outline" onClick={() => void download(`/api/partners/interventions/${id}/export`, `intervention-${id}.json`, id).catch(cause => toast.error(cause.message))}><Download data-icon="inline-start" />导出</Button></div></header>
    {error && <Alert><AlertDescription>{error} · 保留当前结果并重连。</AlertDescription></Alert>}
    <Card><CardHeader><CardTitle>{experiment.status === "running" ? "逐条运行独立分支" : experiment.status === "completed" ? "本批次已结束" : experiment.status === "stopped" ? "本批次已停止" : "配置已保存，等待开始"}</CardTitle><CardDescription>已取样 {experiment.completed} · 失败 {experiment.failed} · 已停止 {experiment.stopped} · 共 {experiment.total} 条</CardDescription></CardHeader><CardContent><Progress value={(experiment.completed + experiment.failed + experiment.stopped) / experiment.total * 100} aria-label="心理干预实验进度" /><p className="mt-4 text-xs text-muted-foreground">模型调用累计 {seconds.toFixed(1)} 秒 · 独立心理记录失败 {experiment.shadowFailures} 次{experiment.spec.horizon === "decision" ? " · 一次决定后暂停" : ""}</p></CardContent></Card>
    <Tabs defaultValue="branches"><TabsList><TabsTrigger value="branches">逐条分支</TabsTrigger><TabsTrigger value="comparison">行为对照</TabsTrigger><TabsTrigger value="protocol">前态与干预</TabsTrigger></TabsList>
      <TabsContent value="branches" className="pt-5"><Table><TableHeader><TableRow><TableHead>条件 / 重复</TableHead><TableHead>实际动作</TableHead><TableHead>行动采用的估计</TableHead><TableHead>状态</TableHead><TableHead>检查</TableHead></TableRow></TableHeader><TableBody>{experiment.rows.map(row => <TableRow key={row.runId} data-run-id={row.runId}><TableCell><div className="flex flex-col gap-2"><Badge variant="outline">{mechanismLabel[row.mechanism]}</Badge><span className="text-xs">注入 {ratio(row.value)} · 重复 {row.repeat + 1}</span></div></TableCell><TableCell className="min-w-32 whitespace-normal"><p className="text-sm">{actionLabel(row.action)}</p>{row.error && <p className="mt-2 text-xs text-destructive">{row.error}</p>}</TableCell><TableCell>{row.mechanism === "record-only" ? <div className="flex flex-col gap-1"><span className="text-xs">未进入行动输入</span><span className="text-xs text-muted-foreground">{row.shadowFailed ? "独立记录失败" : `独立记录 ${ratio(row.shadowBelief)}`}</span></div> : ratio(row.decisionBelief)}</TableCell><TableCell><div className="flex flex-col items-start gap-2"><Badge variant={row.status === "failed" ? "destructive" : "outline"}>{row.status === "running" && <Spinner data-icon="inline-start" />}{rowStatus[row.status]}</Badge>{row.durationMs > 0 && <span className="text-xs text-muted-foreground">{(row.durationMs / 1000).toFixed(1)} 秒 · 重试 {row.retries}</span>}</div></TableCell><TableCell><Button size="sm" variant="ghost" asChild><a href={`#/partners/${row.runId}`}>进入分支<ArrowRight data-icon="inline-end" /></a></Button></TableCell></TableRow>)}</TableBody></Table></TabsContent>
      <TabsContent value="comparison" className="pt-5"><Comparison experiment={experiment} /></TabsContent>
      <TabsContent value="protocol" className="pt-5"><Card><CardHeader><CardTitle>预先保存的实验设置</CardTitle></CardHeader><CardContent className="flex flex-col gap-5"><p className="text-sm leading-8">{experiment.note}</p><dl className="flex flex-col gap-3 text-sm"><div><dt className="text-xs text-muted-foreground">当前干预人物</dt><dd>{experiment.spec.actorId.toUpperCase()} · {names[experiment.spec.construct]}</dd></div><div><dt className="text-xs text-muted-foreground">来源检查点</dt><dd className="break-all font-mono text-xs">{experiment.checkpointId}</dd></div><div><dt className="text-xs text-muted-foreground">来源内容校验</dt><dd className="break-all font-mono text-xs">{experiment.sourceHash}</dd></div></dl><p className="text-xs text-muted-foreground">注入值改变正式状态，不改写既往解释。模型可能根据证据修订它；研究时需检查干预后实际使用的值。</p></CardContent></Card></TabsContent>
    </Tabs>
  </main>;
}

export function PartnersInterventions({ id, source }: { id?: string; source?: Source }) { return id ? <Experiment id={id} /> : <Setup source={source} />; }
