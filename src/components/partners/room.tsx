import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BrainCircuit, ChevronDown, Download, GitBranch, LockKeyhole, PanelRightClose, PanelRightOpen, Pause, Play, ScanEye, SlidersHorizontal, Square, StepForward } from "lucide-react";
import { toast } from "sonner";
import type { ActorId, ActorObservation, Action, WorldState } from "@/partners/contracts";
import type { CheckpointSummary, CreatedRun, PartnerSnapshot } from "@/partners/api-types";
import { useIsMobile } from "@/hooks/use-mobile";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { ActionComposer } from "./action-composer";
import { PartnersConversation } from "./conversation";
import { PartnersInspector } from "./inspector";
import { DecisionCases } from "./cases";
import { credentials, download, post, reconcile, rememberRun, request } from "./api";
import { phaseLabel, statusLabel } from "./format";
import { usePartnerRuntime } from "./use-runtime";

function ForkDialog({ snapshot }: { snapshot: PartnerSnapshot }) {
  const [open, setOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [checkpoint, setCheckpoint] = useState("");
  const [condition, setCondition] = useState("all");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!open) return;
    void request<{ checkpoints: CheckpointSummary[] }>(`/api/partners/${snapshot.id}/checkpoints`, {}, snapshot.id).then(value => { const available = value.checkpoints.filter(item => item.phase === "repair"); setCheckpoints(available); setCheckpoint(available.at(-1)?.id ?? ""); }).catch(error => toast.error(error.message));
  }, [open, snapshot.id]);
  async function fork() {
    setPending(true);
    try {
      const conditions = condition === "all" ? ["none", "apology", "compensation"] as const : [condition as "none" | "apology" | "compensation"];
      if (conditions.includes("compensation")) {
        const source = await request<{ world: WorldState }>(`/api/partners/${snapshot.id}/checkpoints/${encodeURIComponent(checkpoint)}`, {}, snapshot.id);
        if (source.world.actors[source.world.trustee].wallet < 9) throw new Error("这个检查点的经营者不足 9 资源，无法建立真实补偿条件。请另选检查点或仅创建无补偿分支。");
      }
      const children: string[] = [];
      for (const kind of conditions) {
        const result = await post<CreatedRun>(`/api/partners/${snapshot.id}/forks`, { checkpointId: checkpoint, intervention: { kind, ...(kind === "compensation" ? { amount: 9 } : {}) }, autoStart: false }, snapshot.id);
        rememberRun(result); children.push(result.id);
      }
      setOpen(false);
      location.hash = children.length > 1 ? `#/partners-compare/${children.join(",")}` : `#/partners/${children[0]}`;
    } catch (error) { toast.error(error instanceof Error ? error.message : "分支创建失败"); } finally { setPending(false); }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" size="sm"><GitBranch data-icon="inline-start" />分支实验</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>创建修复分支</DialogTitle><DialogDescription>从同一个检查点建立独立对照。</DialogDescription></DialogHeader><FieldGroup><Field><FieldLabel>修复前的检查点</FieldLabel>{checkpoints.length ? <Select value={checkpoint} onValueChange={setCheckpoint}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{checkpoints.map(item => <SelectItem value={item.id} key={item.id}>第 {item.round} 轮 · 结算后 · #{item.revision}</SelectItem>)}</SelectGroup></SelectContent></Select> : <FieldDescription>还没有可用检查点。先完成一次投资与返还。</FieldDescription>}</Field><Field><FieldLabel>施加的修复条件</FieldLabel><Select value={condition} onValueChange={setCondition}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">创建三种条件，进行对照</SelectItem><SelectItem value="none">无道歉，补偿 0</SelectItem><SelectItem value="apology">固定道歉，补偿 0</SelectItem><SelectItem value="compensation">相同道歉，实际补偿 9</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>初始状态：暂停 · 补偿实际到账</FieldDescription></Field></FieldGroup><DialogFooter><Button onClick={() => void fork()} disabled={pending || !checkpoint}>{pending ? <Spinner data-icon="inline-start" /> : <GitBranch data-icon="inline-start" />}创建独立分支</Button></DialogFooter></DialogContent></Dialog>;
}

export function PartnersRoom({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [snapshot, setSnapshot] = useState<PartnerSnapshot>();
  const [researchPreference, setResearch] = useState<boolean>();
  const research = researchPreference ?? Boolean(snapshot?.mode === "observe" && snapshot.viewer.canControl);
  const [selectedEvent, setSelectedEvent] = useState<string>();
  const [inspectedActor, setInspectedActor] = useState<ActorId>("b");
  const [inspectorTab, setInspectorTab] = useState("decision");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const mobile = useIsMobile();
  const runtime = usePartnerRuntime(id, research && Boolean(snapshot?.research));
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await request<PartnerSnapshot>(`/api/partners/${id}${research ? "?view=research" : ""}`, { signal }, id, research ? "owner" : "player");
    setSnapshot(previous => reconcile(previous, next)); setError("");
  }, [id, research]);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() { try { await refresh(abort.signal); } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "无法连接到对局"); } finally { if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 1800); } }
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [refresh]);
  const selectEvent = useCallback((eventId: string) => { setSelectedEvent(eventId); if (window.innerWidth < 768) setInspectorOpen(true); }, []);
  async function control(command: "pause" | "resume" | "step" | "stop") {
    setPending(true);
    try { await post(`/api/partners/${id}/control`, { command }, id); await refresh(); onChanged(); } catch (cause) { toast.error(cause instanceof Error ? cause.message : "操作失败"); } finally { setPending(false); }
  }
  async function continueInIsolation() {
    setPending(true);
    try {
      const { checkpoints } = await request<{ checkpoints: CheckpointSummary[] }>(`/api/partners/${id}/checkpoints`, {}, id);
      const checkpoint = [...checkpoints].sort((a, b) => b.revision - a.revision)[0];
      if (!checkpoint) throw new Error("没有可用于隔离续跑的已提交检查点。");
      const fork = await post<CreatedRun>(`/api/partners/${id}/forks`, { checkpointId: checkpoint.id, autoStart: true }, id);
      rememberRun(fork); onChanged(); location.hash = `#/partners/${fork.id}`;
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "无法创建隔离续跑"); } finally { setPending(false); }
  }
  async function act(action: Action) {
    if (!snapshot) return;
    setPending(true);
    try { await post(`/api/partners/${id}/actions`, { expectedRevision: snapshot.revision, commandId: crypto.randomUUID(), action }, id, "player"); await refresh(); onChanged(); } catch (cause) { toast.error(cause instanceof Error ? cause.message : "提交失败"); await refresh().catch(() => undefined); } finally { setPending(false); }
  }
  if (!snapshot) return <div className="flex min-h-[70dvh] flex-col p-8">{error ? <Empty><EmptyHeader><EmptyTitle>暂时无法打开对局</EmptyTitle><EmptyDescription>{error}</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={() => void refresh().catch(cause => setError(cause.message))}>重新连接</Button></EmptyContent></Empty> : <div className="flex flex-col gap-6"><Skeleton className="h-14 w-full" /><Skeleton className="h-80 w-full" /></div>}</div>;
  const observation = snapshot.observation;
  const playerView = "self" in observation ? observation as ActorObservation : undefined;
  const canAct = snapshot.viewer.canAct && playerView && snapshot.status === "waiting-human";
  const terminal = ["completed", "stopped"].includes(snapshot.status);
  const streamingActor = runtime.activities.findLast(activity => activity.revision === snapshot.revision && activity.status === "running")?.actorId;
  const generating = snapshot.status === "running" || Boolean(streamingActor);
  const active = generating || snapshot.status === "waiting-human";
  const canControl = snapshot.viewer.canControl || Boolean(credentials(id)?.ownerToken);
  const selected = observation.events.find(event => event.id === selectedEvent);
  const inspector = <PartnersInspector snapshot={research ? snapshot : { ...snapshot, research: undefined }} selected={selected} actor={inspectedActor} onActorChange={setInspectedActor} tab={inspectorTab} onTabChange={setInspectorTab} onResearch={() => setResearch(true)} onClearSelection={() => setSelectedEvent(undefined)} />;
  const conversation = <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 md:px-6" data-testid="participants-strip">
      {(["a", "b"] as const).map(actorId => <Button key={actorId} variant="ghost" size="sm" className={cn("h-auto min-w-0 flex-1 justify-start gap-2 py-2", research && inspectedActor === actorId && "bg-muted")} onClick={() => { setInspectedActor(actorId); setInspectorVisible(true); if (mobile) setInspectorOpen(true); }}>
        <Avatar className="size-7"><AvatarFallback>{observation.actors[actorId].name.slice(0, 1)}</AvatarFallback></Avatar>
        <span className="flex min-w-0 flex-col items-start gap-0.5"><span className="truncate">{observation.actors[actorId].name}</span><span className="text-[11px] font-normal text-muted-foreground">{observation.trustee === actorId ? "经营者" : "投资人"}</span></span>
        {(streamingActor ?? snapshot.activeActor) === actorId && <Badge variant="outline" className="ml-auto"><Spinner />思考中</Badge>}
      </Button>)}
    </div>
    <div className="min-h-0 flex-1"><PartnersConversation events={observation.events} actors={observation.actors} self={snapshot.viewer.actorId} selectedEvent={selectedEvent} onSelect={selectEvent} activities={research ? runtime.activities : []} active={active} /></div>
    {runtime.error && <Alert className="mx-4 mb-3 w-auto"><AlertDescription>{runtime.error}</AlertDescription></Alert>}
    {error && <Alert className="mx-4 mb-3 w-auto"><AlertTitle>正在重连</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {snapshot.error && <Alert variant="destructive" className="mx-4 mb-3 w-auto"><AlertTitle>本次决策未完成</AlertTitle><AlertDescription>{snapshot.error}</AlertDescription></Alert>}
    {canAct ? <ActionComposer key={id + ":" + snapshot.revision} observation={playerView} pending={pending} onSubmit={act} /> : <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-t px-5 py-3">
      <div className="flex items-center gap-2 text-sm">{generating && <Spinner />}<span>{terminal ? snapshot.status === "completed" ? "本局已结束" : "已停止" : generating ? observation.actors[streamingActor ?? snapshot.activeActor ?? observation.currentActor ?? "b"].name + "正在决策" : snapshot.status === "paused" ? "对局已暂停" : snapshot.status === "failed" ? "决策失败" : "等待你的选择"}</span></div>
      {research && snapshot.mode === "human" && snapshot.status === "waiting-human" ? <Button variant="outline" size="sm" onClick={() => setResearch(false)}>回到游玩</Button> : <span className="font-mono text-xs text-muted-foreground">{snapshot.revision} 次行动</span>}
    </div>}
  </div>;
  return <section className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col md:h-dvh" data-testid="partners-room">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-5">
      <div className="flex min-w-0 items-center gap-3"><SidebarTrigger className="hidden md:inline-flex" /><Button variant="ghost" size="icon-sm" asChild><a href="#/" aria-label="返回首页"><ArrowLeft /></a></Button><div><h1 className="text-sm font-semibold">{observation.actors.a.name} <span className="px-1 text-muted-foreground">×</span> {observation.actors.b.name}</h1><div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><span>第 {observation.round} / {observation.maxRounds} 轮</span><span>·</span><span>{terminal ? statusLabel[snapshot.status] : phaseLabel[observation.phase]}</span></div></div></div>
      <div className="flex items-center gap-2">
        {canControl && <ToggleGroup type="single" variant="outline" size="sm" value={research ? "research" : "play"} onValueChange={value => { if (value) setResearch(value === "research"); }}><ToggleGroupItem value="play">{snapshot.mode === "human" ? "游玩" : "现场"}</ToggleGroupItem><ToggleGroupItem value="research">研究</ToggleGroupItem></ToggleGroup>}
        {research && snapshot.research && <><span className="hidden xl:inline-flex"><DecisionCases id={id} /></span><div className="hidden lg:block"><ForkDialog snapshot={snapshot} /></div></>}
        {canControl && snapshot.status === "failed" ? <Button variant="outline" size="sm" aria-label="隔离续跑" disabled={pending} onClick={() => void continueInIsolation()}>{pending ? <Spinner data-icon="inline-start" /> : <GitBranch data-icon="inline-start" />}隔离续跑</Button> : canControl && !terminal && <Button variant="outline" size="icon-sm" aria-label={active ? "暂停对局" : "继续对局"} disabled={pending} onClick={() => void control(active ? "pause" : "resume")}>{active ? <Pause /> : <Play />}</Button>}
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="对局操作"><ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>{canControl && <><DropdownMenuItem onSelect={() => setResearch(!research)}><ScanEye />{research ? "回到现场" : "进入研究视角"}</DropdownMenuItem>{!terminal && snapshot.status !== "failed" && <DropdownMenuItem disabled={pending || snapshot.status === "running"} onSelect={() => void control("step")}><StepForward />推进一次决定</DropdownMenuItem>}<DropdownMenuItem onSelect={() => void download("/api/partners/" + id + "/export", "partners-" + id + ".json", id).catch(cause => toast.error(cause.message))}><Download />导出研究记录</DropdownMenuItem><DropdownMenuSeparator />{!terminal && snapshot.status !== "failed" && <DropdownMenuItem disabled={pending} onSelect={() => void control("stop")}><Square />停止对局</DropdownMenuItem>}</>}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
        <Button variant="ghost" size="icon-sm" className="hidden md:inline-flex" aria-label={inspectorVisible ? "收起详情" : "展开详情"} onClick={() => setInspectorVisible(value => !value)}>{inspectorVisible ? <PanelRightClose /> : <PanelRightOpen />}</Button>
        <Sheet open={mobile && inspectorOpen} onOpenChange={setInspectorOpen}><SheetTrigger asChild><Button variant="outline" size="icon-sm" className="md:hidden" aria-label="协议与人物详情"><SlidersHorizontal /></Button></SheetTrigger><SheetContent className="w-full p-0 sm:max-w-md"><SheetHeader className="border-b"><SheetTitle>人物详情</SheetTitle></SheetHeader><div className="min-h-0 flex-1">{mobile && inspector}</div></SheetContent></Sheet>
      </div>
    </header>
    {research && snapshot.research && <div className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-1.5" data-testid="research-toolbar"><span className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground sm:flex"><LockKeyhole className="size-3" />研究视角</span><div className="flex items-center gap-2"><span className="xl:hidden"><DecisionCases id={id} /></span>{observation.currentActor && observation.actors[observation.currentActor].kind === "ai" && <Button variant="ghost" size="sm" asChild><a href={"#/partners-intervention/new/" + id + "/" + snapshot.revision + "/" + observation.currentActor}><BrainCircuit data-icon="inline-start" />心理干预</a></Button>}<div className="lg:hidden"><ForkDialog snapshot={snapshot} /></div></div></div>}
    <div className="min-h-0 flex-1"><ResizablePanelGroup orientation="horizontal"><ResizablePanel id="conversation" defaultSize="70%" minSize="42%">{conversation}</ResizablePanel>{!mobile && inspectorVisible && <><ResizableHandle withHandle /><ResizablePanel id="inspector" defaultSize="30%" minSize="320px" maxSize="45%">{inspector}</ResizablePanel></>}</ResizablePanelGroup></div>
  </section>;
}
