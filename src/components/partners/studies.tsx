import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, Download, FlaskConical, GitBranch, Pause, Play, Square } from "lucide-react";
import { toast } from "sonner";
import type { Mechanism, PartnerSnapshot, StudyView } from "@/partners/api-types";
import type { ActorId } from "@/partners/contracts";
import type { PartnerMind } from "@/partners/mind";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { credentials, download, post, remember, request } from "./api";
import { money, ratio, statusLabel } from "./format";
import { StudyStatistics } from "./analysis";

const conditions = { none: "无道歉", apology: "只有道歉", compensation: "道歉 + 补偿 9" };
const mechanisms: Record<Mechanism, string> = { full: "完整机制", "no-inertia": "关闭惯性", "no-mind": "关闭心理", "record-only": "只记录心理" };

function StudySetup() {
  const [repeats, setRepeats] = useState("1");
  const [selected, setSelected] = useState<Mechanism[]>(["full"]);
  const [seed, setSeed] = useState("4103");
  const [pending, setPending] = useState(false);
  const [recent, setRecent] = useState<StudyView[]>([]);
  useEffect(() => { const controller = new AbortController(); void request<{ studies: StudyView[] }>("/api/partners/studies", { signal: controller.signal }).then(value => setRecent(value.studies)).catch(() => undefined); return () => controller.abort(); }, []);
  async function create() {
    setPending(true);
    try { const result = await post<{ study: StudyView; ownerToken: string }>("/api/partners/studies", { repeats: Number(repeats), agreeableness: [0.2, 0.8], mechanisms: selected, maxRounds: 3, seed: Number(seed) }); remember(result.study.id, { ownerToken: result.ownerToken }); location.hash = "#/partners-study/" + result.study.id; } catch (cause) { toast.error(cause instanceof Error ? cause.message : "无法创建实验"); } finally { setPending(false); }
  }
  const total = Number(repeats) * 2 * selected.length * 3;
  return <main className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-5 py-7 md:px-10 md:py-10" data-testid="study-setup">
    <header className="flex items-center gap-3"><FlaskConical className="size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold tracking-tight">修复实验</h1><Badge variant="outline">探索性</Badge></header>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.65fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <Card><CardHeader><CardTitle>共同前态</CardTitle><CardDescription>实验设置 · 第一轮结算后</CardDescription></CardHeader><CardContent><dl className="grid grid-cols-3 gap-4">{[["承诺返还", "50%"], ["实际投入", "6"], ["实际返还", "0"]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 font-mono text-2xl">{value}</dd></div>)}</dl></CardContent></Card>
        <div className="overflow-hidden rounded-lg border"><Table><TableHeader><TableRow><TableHead>修复条件</TableHead><TableHead>道歉</TableHead><TableHead className="text-right">实际补偿</TableHead></TableRow></TableHeader><TableBody>{Object.entries(conditions).map(([kind, title]) => <TableRow key={kind}><TableCell className="font-medium">{title}</TableCell><TableCell>{kind === "none" ? "无" : "相同道歉"}</TableCell><TableCell className="text-right font-mono">{kind === "compensation" ? 9 : 0}</TableCell></TableRow>)}</TableBody></Table></div>
        <Card><CardHeader><CardTitle>观察指标</CardTitle></CardHeader><CardContent className="flex flex-wrap gap-2">{["返还比例", "补偿", "后续投资", "最终收益", "预测误差", "策略修订"].map(metric => <Badge key={metric} variant="secondary">{metric}</Badge>)}</CardContent></Card>
        <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />实验方法</Button></CollapsibleTrigger><CollapsibleContent className="flex flex-col gap-3 pt-3 text-sm text-muted-foreground"><p>前段由规则引擎执行。三个分支从相同检查点出发，分别拥有独立世界与记忆，后续由模型选择。</p><p>只操控宜人性 0.2 / 0.8；其余人格、身份与目标一致。角色互换后观察返还，再到合法投资轮次观察后续投资。</p><p>补偿同时改变资源与社会信号。低返还不直接归类为报复；保留所有失败与无差异结果。</p></CollapsibleContent></Collapsible>
      </div>
      <form onSubmit={event => { event.preventDefault(); void create(); }}><Card><CardHeader><CardTitle>实验配置</CardTitle><CardDescription>2 档宜人性 × 3 种修复条件</CardDescription></CardHeader><CardContent><FieldGroup className="gap-5">
        <Field><FieldLabel>机制对照</FieldLabel><ToggleGroup type="multiple" variant="outline" value={selected} onValueChange={value => { if (value.length) setSelected(value as Mechanism[]); }} className="flex-wrap"><ToggleGroupItem value="full">完整机制</ToggleGroupItem><ToggleGroupItem value="no-inertia">关闭惯性</ToggleGroupItem><ToggleGroupItem value="no-mind">关闭心理</ToggleGroupItem></ToggleGroup></Field>
        <Field><FieldLabel>每个组合重复</FieldLabel><Select value={repeats} onValueChange={setRepeats}><SelectTrigger aria-label="每个组合重复"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="1">1 次</SelectItem><SelectItem value="5">5 次</SelectItem></SelectGroup></SelectContent></Select></Field>
        <Field><FieldLabel htmlFor="study-seed">运行顺序种子</FieldLabel><Input id="study-seed" type="number" min={0} max={2147483647} step={1} required value={seed} onChange={event => setSeed(event.target.value)} /></Field>
        <Separator /><div className="flex items-end justify-between"><span className="text-sm text-muted-foreground">独立分支</span><span className="font-mono text-3xl">{total}</span></div>
      </FieldGroup></CardContent><CardFooter><Button className="w-full" type="submit" disabled={pending}>{pending ? <Spinner data-icon="inline-start" /> : <GitBranch data-icon="inline-start" />}创建 {total} 条独立分支<ArrowRight data-icon="inline-end" /></Button></CardFooter></Card></form>
    </div>
    {recent.length > 0 && <section className="flex flex-col gap-4"><h2 className="text-sm font-medium">最近实验</h2><div className="overflow-hidden rounded-lg border"><Table><TableHeader><TableRow><TableHead>实验</TableHead><TableHead>状态</TableHead><TableHead>完成 / 总数</TableHead><TableHead>失败</TableHead><TableHead><span className="sr-only">打开</span></TableHead></TableRow></TableHeader><TableBody>{recent.map(study => <TableRow key={study.id}><TableCell className="font-mono text-xs">{study.id.slice(0, 8)}</TableCell><TableCell><Badge variant="outline">{statusLabel[study.status] ?? study.status}</Badge></TableCell><TableCell>{study.completed} / {study.total}</TableCell><TableCell>{study.failed}</TableCell><TableCell><Button variant="ghost" size="icon-sm" asChild><a href={"#/partners-study/" + study.id} aria-label="打开实验"><ArrowRight /></a></Button></TableCell></TableRow>)}</TableBody></Table></div></section>}
  </main>;
}

export function PartnersStudies({ id }: { id?: string }) {
  const [study, setStudy] = useState<StudyView>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const refresh = useCallback(async () => { if (id) { const next = await request<StudyView>("/api/partners/studies/" + id, {}, id); const auth = credentials(id); if (auth) for (const row of next.rows) remember(row.runId, auth); setStudy(next); setError(""); } }, [id]);
  useEffect(() => {
    if (!id) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    async function poll() { try { await refresh(); } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : "读取失败"); } finally { if (!disposed) timer = setTimeout(() => void poll(), 2500); } }
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [refresh, id]);
  if (!id) return <StudySetup />;
  async function control(command: "resume" | "pause" | "stop") { setPending(true); try { await post("/api/partners/studies/" + id + "/control", { command }, id); await refresh(); } catch (cause) { toast.error(cause instanceof Error ? cause.message : "操作失败"); } finally { setPending(false); } }
  if (!study) return <div className="p-8">{error ? <Alert><AlertTitle>无法读取实验</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : <Skeleton className="h-96 w-full" />}</div>;
  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-7 md:px-10 md:py-10" data-testid="repair-study">
    <header className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-3"><Button variant="ghost" size="icon-sm" asChild><a href="#/partners-study" aria-label="返回实验配置"><ArrowLeft /></a></Button><div><h1 className="text-xl font-semibold tracking-tight">修复实验</h1><p className="mt-1 font-mono text-xs text-muted-foreground">{id.slice(0, 8)} · {study.total} 条分支</p></div></div><div className="flex items-center gap-2">{study.status !== "completed" && study.status !== "stopped" && <><Button disabled={pending} onClick={() => void control(study.status === "running" ? "pause" : "resume")}>{pending ? <Spinner data-icon="inline-start" /> : study.status === "running" ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}{study.status === "running" ? "暂停实验" : "开始 / 继续"}</Button><Button variant="outline" size="icon" aria-label="停止实验" disabled={pending} onClick={() => void control("stop")}><Square /></Button></>}<Button variant="outline" onClick={() => void download("/api/partners/studies/" + id + "/export", "partners-study-" + id + ".json", id).catch(cause => toast.error(cause.message))}><Download data-icon="inline-start" />导出</Button></div></header>
    {error && <Alert><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="flex flex-col gap-4 rounded-lg border p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-baseline gap-2"><span className="font-mono text-3xl">{study.completed}</span><span className="text-sm text-muted-foreground">/ {study.total} 已完成</span></div><div className="flex items-center gap-3"><Badge variant="outline">{statusLabel[study.status] ?? study.status}</Badge><span className="text-xs text-muted-foreground">失败 {study.failed}</span></div></div><Progress value={(study.completed + study.failed) / Math.max(1, study.total) * 100} aria-label="实验进度" /></div>
    <Tabs defaultValue="samples"><TabsList variant="line" className="w-full justify-start border-b"><TabsTrigger value="samples">全部样本</TabsTrigger><TabsTrigger value="statistics">统计</TabsTrigger><TabsTrigger value="protocol">实验设置</TabsTrigger></TabsList>
      <TabsContent value="samples" className="pt-4"><div className="overflow-hidden rounded-lg border"><Table><TableHeader><TableRow><TableHead>修复条件</TableHead><TableHead>宜人性 / 机制</TableHead><TableHead>状态</TableHead><TableHead>返还</TableHead><TableHead>补偿</TableHead><TableHead>后续投资</TableHead><TableHead>收益</TableHead><TableHead>耗时</TableHead><TableHead>记录</TableHead></TableRow></TableHeader><TableBody>{study.rows.map(row => <TableRow key={row.runId}><TableCell>{conditions[row.condition]}<p className="text-xs text-muted-foreground">重复 {row.repeat + 1}</p></TableCell><TableCell>{row.agreeableness} · {mechanisms[row.mechanism]}</TableCell><TableCell><Badge variant={row.status === "failed" ? "destructive" : "outline"}>{statusLabel[row.status] ?? row.status}</Badge>{row.error && <p className="mt-2 max-w-52 whitespace-normal text-xs text-destructive">{row.error}</p>}</TableCell><TableCell>{row.returned ?? "—"}</TableCell><TableCell>{row.compensation ?? "—"}</TableCell><TableCell>{row.investment ?? "—"}</TableCell><TableCell>{row.payoff ?? "—"}</TableCell><TableCell>{(row.durationMs / 1000).toFixed(1)}s</TableCell><TableCell><Button variant="ghost" size="icon-sm" asChild><a href={"#/partners/" + row.runId} aria-label="打开分支"><ArrowRight /></a></Button></TableCell></TableRow>)}</TableBody></Table></div></TabsContent>
      <TabsContent value="statistics" className="pt-5"><StudyStatistics id={id} /></TabsContent>
      <TabsContent value="protocol" className="pt-5"><div className="flex flex-col gap-5"><div className="flex flex-wrap gap-2"><Badge variant="secondary">宜人性 {study.spec.agreeableness.join(" / ")}</Badge>{study.spec.mechanisms.map(mechanism => <Badge key={mechanism} variant="secondary">{mechanisms[mechanism]}</Badge>)}<Badge variant="secondary">重复 {study.spec.repeats} 次</Badge><Badge variant="secondary">种子 {study.spec.seed}</Badge></div><p className="max-w-3xl text-sm text-muted-foreground">{study.note}</p></div></TabsContent>
    </Tabs>
  </main>;
}

function ComparisonBranch({ snapshot, round, actor }: { snapshot: PartnerSnapshot; round: number; actor: ActorId }) {
  const world = snapshot.research?.world;
  const observed = world ? [...world.completedDeals, world.deal].find(deal => deal.round === round) : undefined;
  const events = world?.events.filter(event => event.round === round) ?? [];
  const checkpointRevision = events.at(-1)?.revision;
  const checkpointKey = checkpointRevision == null ? undefined : snapshot.id + ":" + checkpointRevision;
  const [checkpoint, setCheckpoint] = useState<{ key: string; minds: Record<ActorId, PartnerMind> }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!checkpointKey) return;
    const controller = new AbortController();
    void request<{ minds: Record<ActorId, PartnerMind> }>("/api/partners/" + snapshot.id + "/checkpoints/" + encodeURIComponent(checkpointKey), { signal: controller.signal }, snapshot.id)
      .then(value => { setCheckpoint({ key: checkpointKey, minds: value.minds }); setError(""); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [checkpointKey, snapshot.id]);
  const canInspect = snapshot.observation.actors[actor].kind === "ai" && snapshot.mechanism !== "no-mind";
  const mind = canInspect && checkpoint?.key === checkpointKey ? checkpoint?.minds[actor] : undefined;
  const title = snapshot.condition && snapshot.condition in conditions ? conditions[snapshot.condition as keyof typeof conditions] : snapshot.condition ?? "对照分支";
  return <Card className="min-w-0 gap-5" data-branch-id={snapshot.id} data-checkpoint-revision={checkpointRevision}>
    <CardHeader><div className="flex items-center justify-between gap-2"><CardTitle>{title}</CardTitle><Badge variant={snapshot.status === "failed" ? "destructive" : "outline"}>{statusLabel[snapshot.status] ?? snapshot.status}</Badge></div><CardDescription>第 {round} 轮{checkpointRevision != null ? " · 行动 #" + checkpointRevision : " · 尚未到达"}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5">
      {snapshot.error && <Alert variant="destructive"><AlertDescription>{snapshot.error}</AlertDescription></Alert>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-5">{[["承诺比例", ratio(observed?.promiseRatio)], ["实际返还", observed?.returned == null ? "—" : money(observed.returned)], ["补偿", events.some(event => event.kind === "repair") ? money(observed?.compensation) : "—"], ["投资", observed?.investment == null ? "—" : money(observed.investment)]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-xl">{value}</dd></div>)}</dl>
      <Separator />
      <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{snapshot.observation.actors[actor].name}</span><Badge variant="outline">模拟心理</Badge></div>
      {!canInspect ? <p className="text-sm text-muted-foreground">{snapshot.observation.actors[actor].kind === "human" ? "人类玩家 · 无模拟心理" : "心理模块已关闭"}</p> : error ? <Alert><AlertDescription>{error}</AlertDescription></Alert> : !checkpointKey ? <p className="text-sm text-muted-foreground">尚未到达此轮</p> : !mind ? <Skeleton className="h-32 w-full" /> : <>
        <dl className="grid grid-cols-2 gap-3"><div><dt className="text-xs text-muted-foreground">合作意愿</dt><dd className="mt-1 font-mono text-lg">{ratio(mind.relationship.willingness)}</dd></div><div><dt className="text-xs text-muted-foreground">履约能力</dt><dd className="mt-1 font-mono text-lg">{ratio(mind.relationship.capability)}</dd></div></dl>
        <p className="text-sm">{mind.relationship.interpretation}</p><div><h3 className="mb-2 text-xs text-muted-foreground">下一步</h3><p className="text-sm">{mind.plan?.nextStep ?? "尚无计划"}</p></div>
      </>}
      {snapshot.research?.experimentNote && <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="px-0"><ChevronDown data-icon="inline-start" />实验设置</Button></CollapsibleTrigger><CollapsibleContent className="pt-2 text-xs text-muted-foreground">{snapshot.research.experimentNote}</CollapsibleContent></Collapsible>}
    </CardContent><CardFooter className="mt-auto"><Button variant="outline" className="w-full" asChild><a href={"#/partners/" + snapshot.id}>打开分支<ArrowRight data-icon="inline-end" /></a></Button></CardFooter>
  </Card>;
}

export function PartnersComparison({ ids }: { ids: string[] }) {
  const [snapshots, setSnapshots] = useState<PartnerSnapshot[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [round, setRound] = useState("2");
  const [actor, setActor] = useState<ActorId>("a");
  const stableIds = ids.join(",");
  const refresh = useCallback(async () => { const results = await Promise.all(stableIds.split(",").map(id => request<PartnerSnapshot>("/api/partners/" + id + "?view=research", {}, id))); setSnapshots(results); setError(""); }, [stableIds]);
  useEffect(() => { let disposed = false; let timer: ReturnType<typeof setTimeout>; async function poll() { try { await refresh(); } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : "比较读取失败"); } finally { if (!disposed) timer = setTimeout(() => void poll(), 2200); } } void poll(); return () => { disposed = true; clearTimeout(timer); }; }, [refresh]);
  async function resume() { setPending(true); try { for (const snapshot of snapshots.filter(item => !["failed", "completed", "stopped", "running"].includes(item.status))) await post("/api/partners/" + snapshot.id + "/control", { command: "resume" }, snapshot.id); await refresh(); } catch (cause) { toast.error(cause instanceof Error ? cause.message : "无法开始分支"); } finally { setPending(false); } }
  const runnable = snapshots.some(snapshot => !["failed", "completed", "stopped", "running"].includes(snapshot.status));
  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-7 md:px-10 md:py-10" data-testid="branch-comparison">
    <header className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-3"><GitBranch className="size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold tracking-tight">分支比较</h1><Badge variant="outline">{ids.length} 条分支</Badge></div><Button disabled={pending || !runnable} onClick={() => void resume()}>{pending ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}开始这些分支</Button></header>
    <div className="flex flex-wrap items-center justify-between gap-4"><Tabs value={round} onValueChange={setRound}><TabsList variant="line">{Array.from({ length: Math.max(3, ...snapshots.map(snapshot => snapshot.maxRounds)) }, (_, index) => <TabsTrigger key={index} value={String(index + 1)}>第 {index + 1} 轮</TabsTrigger>)}</TabsList></Tabs><Select value={actor} onValueChange={value => setActor(value as ActorId)}><SelectTrigger aria-label="比较人物" className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{(["a", "b"] as const).map(id => <SelectItem key={id} value={id}>{snapshots[0]?.observation.actors[id].name ?? "人物 " + id.toUpperCase()}</SelectItem>)}</SelectGroup></SelectContent></Select></div>
    {error && <Alert><AlertDescription>{error}</AlertDescription></Alert>}
    <section className="grid items-stretch gap-5 lg:grid-cols-3">{!snapshots.length && !error && ids.map(id => <Skeleton key={id} className="h-96 w-full" />)}{snapshots.map(snapshot => <ComparisonBranch key={snapshot.id} snapshot={snapshot} round={Number(round)} actor={actor} />)}</section>
  </main>;
}
