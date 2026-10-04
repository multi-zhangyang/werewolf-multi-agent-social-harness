import { lazy, Suspense, useCallback, useEffect, useState, type CSSProperties } from "react";
import { ArrowRight, Archive, BrainCircuit, ChevronDown, CircleDot, FlaskConical, Handshake, Plus, Settings2, Theater } from "lucide-react";
import { toast } from "sonner";
import type { CreatedRun, RunSummary } from "@/partners/api-types";
import { ThemeToggle } from "@/components/theme-toggle";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { post, rememberRun, request } from "./api";
import { shortDate, statusLabel } from "./format";

const SettingsPage = lazy(() => import("@/components/society/settings-dialog").then(module => ({ default: module.SettingsPage })));
const Room = lazy(() => import("./room").then(module => ({ default: module.PartnersRoom })));
const Studies = lazy(() => import("./studies").then(module => ({ default: module.PartnersStudies })));
const Interventions = lazy(() => import("./interventions").then(module => ({ default: module.PartnersInterventions })));
const Compare = lazy(() => import("./studies").then(module => ({ default: module.PartnersComparison })));
const customTitle = (run: RunSummary) => run.title.trim() && run.title.trim() !== "合伙人：一次失约" ? run.title.trim() : undefined;

function Navigation({ runs, page, onLegacy }: { runs: RunSummary[]; page: string; onLegacy?: () => void }) {
  const { setOpenMobile } = useSidebar();
  const close = () => setOpenMobile(false);
  return <Sidebar collapsible="icon"><SidebarHeader className="px-4 py-6"><a href="#/" onClick={close} className="flex items-center gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Handshake className="size-5" /></span><span className="flex flex-col gap-0.5 group-data-[collapsible=icon]:hidden"><span className="text-sm font-semibold tracking-tight">合伙人</span><span className="text-xs text-muted-foreground">Agent 实验室</span></span></a></SidebarHeader><SidebarContent><SidebarGroup><SidebarGroupContent><SidebarMenu>
    <SidebarMenuItem><SidebarMenuButton asChild isActive={!page}><a href="#/" onClick={close}><Theater /><span>博弈现场</span></a></SidebarMenuButton></SidebarMenuItem>
    <SidebarMenuItem><SidebarMenuButton asChild isActive={page === "partners-intervention"}><a href="#/partners-intervention" onClick={close}><BrainCircuit /><span>心理干预</span></a></SidebarMenuButton></SidebarMenuItem>
    <SidebarMenuItem><SidebarMenuButton asChild isActive={page === "partners-study" || page === "partners-compare"}><a href="#/partners-study" onClick={close}><FlaskConical /><span>对照实验</span></a></SidebarMenuButton></SidebarMenuItem>
  </SidebarMenu></SidebarGroupContent></SidebarGroup><SidebarGroup><SidebarGroupLabel>会话</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{runs.slice(0, 9).map(run => <SidebarMenuItem key={run.id}><SidebarMenuButton asChild isActive={location.hash === "#/partners/" + run.id} tooltip={run.title}><a href={`#/partners/${run.id}`} onClick={close} title={customTitle(run) ?? run.title}><CircleDot /><span className="truncate">{customTitle(run) ?? `${run.mode === "human" ? "我的对局" : "自主博弈"} · ${run.id.slice(0, 4)}`}</span></a></SidebarMenuButton></SidebarMenuItem>)}{!runs.length && <p className="px-2 py-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">暂无会话</p>}</SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent><SidebarFooter className="pb-5"><SidebarMenu>{onLegacy && <SidebarMenuItem><SidebarMenuButton onClick={() => { close(); onLegacy(); }}><Archive /><span>多场景工作台</span></SidebarMenuButton></SidebarMenuItem>}<SidebarMenuItem><SidebarMenuButton asChild isActive={page === "partners-settings"}><a href="#/partners-settings" onClick={close}><Settings2 /><span>模型与连接</span></a></SidebarMenuButton></SidebarMenuItem></SidebarMenu><div className="flex items-center justify-between px-2 pt-3"><SidebarTrigger className="hidden md:inline-flex" /><ThemeToggle /></div></SidebarFooter></Sidebar>;
}

function Home({ runs, onChanged }: { runs: RunSummary[]; onChanged: () => void }) {
  const [creating, setCreating] = useState<"human" | "observe">();
  const [goals, setGoals] = useState({ a: "", b: "" });
  const [traits, setTraits] = useState({ a: "0.2", b: "0.8" });
  async function create(mode: "human" | "observe") {
    setCreating(mode);
    try { const run = await post<CreatedRun>("/api/partners", { mode, maxRounds: 3, agreeableness: [Number(traits.a), Number(traits.b)], actorSettings: { ...(goals.a.trim() ? { a: { privateObjective: goals.a.trim() } } : {}), ...(goals.b.trim() ? { b: { privateObjective: goals.b.trim() } } : {}) }, mechanism: "full", autoStart: true }); rememberRun(run); onChanged(); location.hash = "#/partners/" + run.id; } catch (cause) { toast.error(cause instanceof Error ? cause.message : "无法创建对局"); } finally { setCreating(undefined); }
  }
  return <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-7 md:px-10 md:py-10">
    <header className="flex items-center justify-between gap-4"><div><p className="mb-2 text-xs text-muted-foreground">WORKSPACE</p><h1 className="text-2xl font-semibold tracking-tight">博弈实验室</h1></div><Button variant="outline" asChild><a href="#/partners-study"><FlaskConical data-icon="inline-start" />新建实验</a></Button></header>
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2"><h2 className="text-sm font-medium">开始一场合作</h2><Badge variant="secondary">双人 · 三轮</Badge></div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="gap-5"><CardHeader><div className="mb-3 flex items-center gap-2"><Avatar><AvatarFallback>你</AvatarFallback></Avatar><span className="text-xs text-muted-foreground">×</span><Avatar><AvatarFallback>沈</AvatarFallback></Avatar></div><CardTitle>你与 Agent</CardTitle><CardDescription>亲自谈判、投资与分配收益。</CardDescription></CardHeader><CardFooter><Button className="w-full" onClick={() => void create("human")} disabled={Boolean(creating)}>{creating === "human" ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}开始我的合作<ArrowRight data-icon="inline-end" /></Button></CardFooter></Card>
        <Card className="gap-5"><CardHeader><div className="mb-3 flex items-center gap-2"><Avatar><AvatarFallback>林</AvatarFallback></Avatar><span className="text-xs text-muted-foreground">×</span><Avatar><AvatarFallback>沈</AvatarFallback></Avatar></div><CardTitle>Agent 与 Agent</CardTitle><CardDescription>观察自主对话、心理变化与策略。</CardDescription></CardHeader><CardFooter><Button variant="outline" className="w-full" onClick={() => void create("observe")} disabled={Boolean(creating)}>{creating === "observe" ? <Spinner data-icon="inline-start" /> : <Theater data-icon="inline-start" />}让人物自己博弈<ArrowRight data-icon="inline-end" /></Button></CardFooter></Card>
      </div>
      <Collapsible className="rounded-lg border"><CollapsibleTrigger asChild><Button variant="ghost" className="h-auto w-full justify-between px-4 py-3"><span className="flex items-center gap-2"><Settings2 className="size-4" />设定人物的私下目标</span><ChevronDown data-icon="inline-end" /></Button></CollapsibleTrigger><CollapsibleContent className="p-4 pt-1"><FieldGroup className="grid gap-5 md:grid-cols-2">{(["a", "b"] as const).map(actor => <Field key={actor}><FieldLabel htmlFor={"private-goal-" + actor}>{actor === "a" ? "人物 A · 林舟 / 你" : "人物 B · 沈言"}</FieldLabel><Textarea id={"private-goal-" + actor} value={goals[actor]} onChange={event => setGoals(previous => ({ ...previous, [actor]: event.target.value }))} placeholder="私下目标（留空使用默认）" maxLength={600} rows={2} /><Select value={traits[actor]} onValueChange={value => setTraits(previous => ({ ...previous, [actor]: value }))}><SelectTrigger aria-label={"人物 " + actor.toUpperCase() + " 的宜人性"}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="0.2">宜人性 0.2</SelectItem><SelectItem value="0.5">宜人性 0.5</SelectItem><SelectItem value="0.8">宜人性 0.8</SelectItem></SelectGroup></SelectContent></Select></Field>)}</FieldGroup></CollapsibleContent></Collapsible>
    </section>
    <section className="grid gap-4 md:grid-cols-2">
      <Button variant="outline" className="h-auto justify-between gap-4 p-4" asChild><a href="#/partners-intervention"><span className="flex items-center gap-3"><BrainCircuit className="size-5" /><span className="flex flex-col items-start gap-1"><span>心理干预</span><span className="text-xs font-normal text-muted-foreground">改变判断，比较同一局面的选择</span></span></span><ArrowRight /></a></Button>
      <Button variant="outline" className="h-auto justify-between gap-4 p-4" asChild><a href="#/partners-study"><span className="flex items-center gap-3"><FlaskConical className="size-5" /><span className="flex flex-col items-start gap-1"><span>修复实验</span><span className="text-xs font-normal text-muted-foreground">道歉、补偿与人格对照</span></span></span><ArrowRight /></a></Button>
    </section>
    <section className="flex flex-col gap-4"><div className="flex items-center justify-between gap-4"><h2 className="text-sm font-medium">最近会话</h2><span className="text-xs text-muted-foreground">{runs.length} 场</span></div>
      {runs.length ? <div className="overflow-hidden rounded-lg border"><Table><TableHeader><TableRow><TableHead>会话</TableHead><TableHead className="hidden md:table-cell">模式</TableHead><TableHead>状态</TableHead><TableHead className="hidden sm:table-cell">时间</TableHead><TableHead className="w-10"><span className="sr-only">打开</span></TableHead></TableRow></TableHeader><TableBody>{runs.slice(0, 12).map(run => <TableRow key={run.id}><TableCell><a href={"#/partners/" + run.id} className="flex min-w-0 flex-col gap-1 py-1"><span className="text-sm font-medium">{customTitle(run) ?? run.actors.map(actor => actor.name).join(" × ")}</span><span className="text-xs text-muted-foreground">第 {run.round} 轮 · {run.id.slice(0, 6)}</span></a></TableCell><TableCell className="hidden text-xs text-muted-foreground md:table-cell">{run.mode === "human" ? "人机博弈" : "自主博弈"}</TableCell><TableCell><Badge variant="outline">{statusLabel[run.status] ?? run.status}</Badge></TableCell><TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{shortDate(run.createdAt)}</TableCell><TableCell><Button variant="ghost" size="icon-sm" asChild><a href={"#/partners/" + run.id} aria-label="打开会话"><ArrowRight /></a></Button></TableCell></TableRow>)}</TableBody></Table></div> : <Empty className="rounded-lg border py-10"><EmptyHeader><EmptyTitle>尚无会话</EmptyTitle><EmptyDescription>新建对局后，会话会保存在这里。</EmptyDescription></EmptyHeader></Empty>}
    </section>
  </main>;
}

export function PartnersApp({ onLegacy }: { onLegacy?: () => void }) {
  const [hash, setHash] = useState(location.hash);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(() => { void request<{ runs: RunSummary[] }>("/api/partners").then(value => { setRuns(value.runs); setError(""); }).catch(cause => setError(cause.message)); }, []);
  useEffect(() => { const change = () => { setHash(location.hash); refresh(); }; window.addEventListener("hashchange", change); refresh(); return () => window.removeEventListener("hashchange", change); }, [refresh]);
  const route = hash.replace(/^#\/?/, "").split("/"); const page = route[0] ?? "";
  const content = page === "partners" && route[1] ? <Room key={route[1]} id={route[1]} onChanged={refresh} /> : page === "partners-intervention" ? <Interventions key={route.slice(1).join("/") || "create"} id={route[1] === "new" ? undefined : route[1]} source={route[1] === "new" && route[2] ? { runId: route[2], revision: route[3], actorId: route[4] === "b" ? "b" : "a" } : undefined} /> : page === "partners-study" ? <Studies key={route[1] ?? "create"} id={route[1]} /> : page === "partners-compare" && route[1] ? <Compare key={route[1]} ids={route[1].split(",")} /> : page === "partners-settings" ? <SettingsPage onBack={() => { location.hash = "#/"; }} onSaved={refresh} /> : <Home runs={runs} onChanged={refresh} />;
  return <SidebarProvider style={{ "--sidebar-width": "13rem" } as CSSProperties}><Navigation runs={runs} page={page} onLegacy={onLegacy} /><SidebarInset className="min-w-0"><div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:hidden"><SidebarTrigger /><a href="#/" className="text-sm font-medium">合伙人</a><div className="ml-auto"><ThemeToggle /></div></div>{error && !["partners", "partners-compare"].includes(page) && <Alert className="mx-5 mt-5 w-auto"><AlertDescription>{error}</AlertDescription></Alert>}<Suspense fallback={<div className="p-8"><Skeleton className="h-80 w-full" /></div>}>{content}</Suspense></SidebarInset></SidebarProvider>;
}
