import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUp, Check, Eye, MoreHorizontal, Pause, Play, Square, Users } from "lucide-react";
import { Streamdown } from "streamdown";
import { toast } from "sonner";
import { reconcileRun } from "./run-snapshot";
import { apiFetch, storedOwnerToken } from "@/lib/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { selectActivities } from "@/runtime/behavior";
import { AgentActivity, isActivityEvent } from "./activity";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { GameSituation, MindPanel } from "./mind";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton, useMessageScroller } from "@/components/ui/message-scroller";
import { useIsMobile } from "@/hooks/use-mobile";
import { restartRun, headersFor, json, playerTokens, runToken, scenarioNames, statusNames, type RunView } from "./api";
import type { Character, Memory, WorldEvent } from "@/runtime/types";

function useRun(id: string, actor: string, research = false) {
  const [run, setRun] = useState<RunView>(); const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setRun(undefined); setError("");
    const query = new URLSearchParams({ ...(actor ? { actor } : {}), ...(research ? { view: "research" } : {}) });
    const token = runToken(id) ?? (actor ? playerTokens(id)[actor] : undefined);
    async function stream() {
      try {
        const response = await apiFetch(`/api/v2/runs/${id}/events?${query}`, { headers: headersFor(id, token), signal: controller.signal });
        if (!response.ok) throw new Error((await response.json()).message ?? "连接失败");
        const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read(); if (done) throw new Error("连接已断开");
          buffer += decoder.decode(value, { stream: true }); const chunks = buffer.split("\n\n"); buffer = chunks.pop()!;
          for (const chunk of chunks) if (chunk.startsWith("data: ")) setRun(previous => reconcileRun(previous, JSON.parse(chunk.slice(6)) as RunView));
        }
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    }
    void stream(); return () => controller.abort();
  }, [id, actor, research, retry]);
  return { run, error, retry: () => setRetry(n => n + 1) };
}
export { useRun };

export function RunRoom({ id }: { id: string }) {
  const [actor, setActor] = useState(Object.keys(playerTokens(id))[0] ?? "");
  const [research, setResearch] = useState(() => Boolean(runToken(id) || storedOwnerToken()) && !Object.keys(playerTokens(id)).length);
  const { run, error, retry } = useRun(id, actor, research);
  const [selected, setSelected] = useState<string>(); const [peopleOpen, setPeopleOpen] = useState(false); const mobile = useIsMobile();
  const [focusSeq, setFocusSeq] = useState<number>();
  const details = useMemo<Memory[]>(() => {
    if (!selected || !run) return [];
    if (selected === actor) return run.memories;
    return run.events.filter(e => e.visibility === "public" && (e.actorId === selected || e.data.actorId === selected) && ["message", "fact", "action"].includes(e.type)).map(e => ({ id: e.id, characterId: selected, runId: id, kind: "experience", text: e.text, sourceIds: [e.id], about: [], at: e.at }));
  }, [selected, actor, run, id]);
  const selectPerson = useCallback((personId: string) => { setSelected(personId); setFocusSeq(undefined); }, []);
  const defaultPerson = run?.characters.find(c => !run.spec?.roster.some(s => s.characterId === c.id && s.human))?.id ?? run?.characters[0]?.id;
  const inspectEvent = useCallback((event: WorldEvent) => { setFocusSeq(event.seq); setSelected(selected && selected !== "closed" ? selected : actor || defaultPerson); }, [selected, actor, defaultPerson]);
  if (!run) return <div className="page-content">{error ? <Alert><AlertDescription>{error}<Button variant="link" onClick={retry}>重连</Button></AlertDescription></Alert> : <Skeleton className="h-80 w-full" />}</div>;
  const activities = new Map(selectActivities(run.events).map(e => [e.id, e]));
  const people = <div className="people-list"><div className="people-heading">在场 · {run.characters.length}</div>{run.characters.map((c, i) => <Button variant="ghost" key={c.id} className="person-row" data-selected={selected === c.id} onClick={() => { setSelected(c.id); setPeopleOpen(false); }}><Avatar className="size-10" data-tone={i % 5}><AvatarFallback>{c.name.slice(-2)}</AvatarFallback></Avatar><span><strong>{c.name}</strong><small>{run.world.alive && !run.world.alive.includes(c.id) ? "已出局" : run.world.scores?.[c.id] !== undefined ? `${run.world.scores[c.id]} 点` : "在场"}</small></span>{run.active.some(a => a.actorId === c.id) && <span className="typing-dot" aria-label="正在输入" />}</Button>)}</div>;
  const chosen = run.characters.find(c => c.id === selected) ?? (!mobile && research && selected !== "closed" ? run.characters.find(c => c.id === defaultPerson) : undefined);
  async function control(action: string) { try { await json(`/api/v2/runs/${id}/control`, { method: "POST", headers: headersFor(id), body: JSON.stringify({ action }) }); } catch (e) { toast.error((e as Error).message); } }
  async function restart(play = false) { try { await restartRun(id, play); } catch (e) { toast.error((e as Error).message); } }
  const ended = !["running", "paused"].includes(run.status);

  return <section className="room-shell">
    <header className="room-heading"><div className="flex min-w-0 items-center gap-3"><Button variant="ghost" size="icon-sm" aria-label="返回互动" onClick={() => { location.hash = "#/"; }}><ArrowLeft /></Button><div><h1>{scenarioNames[run.scenario]} {ended && <Badge variant="outline">只读回放</Badge>}</h1><p>{run.world.round ? `第 ${run.world.round} 轮 · ` : ""}{run.status === "running" ? run.world.phase : statusNames[run.status]}</p></div></div>
      <div className="flex items-center gap-2"><Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="查看人物" onClick={() => { setSelected(undefined); setPeopleOpen(true); }}><Users /></Button>
        <Select value={research ? "research" : actor || "public"} onValueChange={v => { setResearch(v === "research"); setActor(v === "public" || v === "research" ? "" : v); }}><SelectTrigger className="w-44" aria-label="观看视角"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="public">公开视角</SelectItem>{(runToken(id) || storedOwnerToken()) && <SelectItem value="research">研究视角 · 含工具</SelectItem>}{run.characters.filter(c => runToken(id) || storedOwnerToken() || playerTokens(id)[c.id]).map(c => <SelectItem key={c.id} value={c.id}>{c.name}的视角</SelectItem>)}</SelectGroup></SelectContent></Select>
        {mobile ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="对局操作"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>
          {(runToken(id) || storedOwnerToken()) && !ended && <><DropdownMenuItem onSelect={() => void control(run.status === "paused" ? "resume" : "pause")}>{run.status === "paused" ? <Play /> : <Pause />}{run.status === "paused" ? "恢复对局" : "暂停对局"}</DropdownMenuItem><DropdownMenuItem onSelect={() => void control("stop")}><Square />停止对局</DropdownMenuItem></>}
          <DropdownMenuItem onSelect={() => { location.hash = `#/research/${id}`; }}><Eye />打开研究记录</DropdownMenuItem>
        </DropdownMenuGroup></DropdownMenuContent></DropdownMenu> : <>{(runToken(id) || storedOwnerToken()) && !ended && <><Button variant="ghost" size="icon-sm" aria-label={run.status === "paused" ? "恢复" : "暂停"} onClick={() => void control(run.status === "paused" ? "resume" : "pause")}>{run.status === "paused" ? <Play /> : <Pause />}</Button><Button variant="ghost" size="icon-sm" aria-label="停止" onClick={() => void control("stop")}><Square /></Button></>}<Button variant="ghost" size="icon-sm" aria-label="研究视角" onClick={() => { location.hash = `#/research/${id}`; }}><Eye /></Button></>}
      </div>
    </header>
    {ended && <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-sm"><span>{run.status === "completed" ? "这场对局已结束。" : "这场对局提前结束，保留了当时的发言和结算。"}当前页面不会继续行动。</span><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => void restart(true)}>同组人物 · 我来对局</Button><Button variant="ghost" size="sm" onClick={() => void restart()}>重新运行实验</Button></div></div>}
    {error && <Alert><AlertDescription>{error}<Button variant="link" onClick={retry}>重连</Button></AlertDescription></Alert>}
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      {!mobile && run.scenario !== "trust-game" && <><ResizablePanel defaultSize="16%" minSize="160px" maxSize="220px">{people}</ResizablePanel><ResizableHandle /></>}
      <ResizablePanel minSize="280px"><div className="conversation-column">{!mobile && run.scenario === "trust-game" && <div className="arena-roster">{people}</div>}<GameSituation run={run} /><Conversation events={run.events.filter(e => e.type === "message" || (activities.has(e.id) && e.data.kind !== "psychology" && e.text !== "update_mind") || e.visibility === "public" && ["fact", "phase", "status"].includes(e.type)).map(e => activities.get(e.id) ?? e)} characters={run.characters} actor={actor} select={selectPerson} inspect={inspectEvent} /><div className="typing-status" aria-live="polite">{run.active.length > 0 && <Marker><Spinner /><MarkerContent>{run.active.map(a => run.characters.find(c => c.id === a.actorId)?.name).join("、")} 正在回应</MarkerContent></Marker>}</div>
        {run.opportunities.find(o => playerTokens(id)[o.actorId]) ? <HumanComposer key={run.opportunities.find(o => playerTokens(id)[o.actorId])!.id} run={run} opportunity={run.opportunities.find(o => playerTokens(id)[o.actorId])!} /> : <div className="room-bottom"><Badge variant="secondary">{statusNames[run.status]}</Badge>{["incomplete", "interrupted", "stopped"].includes(run.status) && (runToken(id) || storedOwnerToken()) && <Button variant="outline" size="sm" onClick={() => void restart()}>从起点重开</Button>}</div>}
      </div></ResizablePanel>
      {!mobile && chosen && <><ResizableHandle /><ResizablePanel defaultSize="33%" minSize="300px" maxSize="480px"><MindPanel key={chosen.id} character={chosen} characters={run.characters} events={run.events} memories={details} focusSeq={focusSeq} close={() => setSelected("closed")} /></ResizablePanel></>}
    </ResizablePanelGroup>
    <Sheet open={mobile && Boolean(peopleOpen || chosen)} onOpenChange={open => { if (!open) { setPeopleOpen(false); setSelected(undefined); } }}><SheetContent><SheetHeader><SheetTitle>{chosen?.name ?? "人物"}</SheetTitle></SheetHeader>{chosen ? <MindPanel key={chosen.id} character={chosen} characters={run.characters} events={run.events} memories={details} focusSeq={focusSeq} /> : people}</SheetContent></Sheet>
  </section>;
}

export function Conversation({ events, characters, actor, select, inspect }: { events: WorldEvent[]; characters: Character[]; actor?: string; select?(id: string): void; inspect?(event: WorldEvent): void }) {
  const visibleEvents = events.filter((e, index) => !(e.type === "status" && e.data.status === "completed" && events[index - 1]?.type === "fact" && events[index - 1]?.text === e.text));
  return <MessageScrollerProvider autoScroll><MessageScroller><MessageScrollerViewport><MessageScrollerContent className="mx-auto max-w-4xl px-5 py-8 md:px-10">{visibleEvents.map(e => <MessageScrollerItem key={e.id} messageId={e.id}><ConversationEvent event={e} characters={characters} actor={actor} select={select} inspect={inspect} /></MessageScrollerItem>)}</MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton /></MessageScroller></MessageScrollerProvider>;
}
const ConversationEvent = memo(function ConversationEvent({ event: e, characters, actor, select, inspect }: { event: WorldEvent; characters: Character[]; actor?: string; select?(id: string): void; inspect?(event: WorldEvent): void }) {
  const scroller = useMessageScroller();
  const character = characters.find(c => c.id === e.actorId); const index = characters.indexOf(character!);
  if (isActivityEvent(e)) return <div className="flex flex-col gap-2"><AgentActivity event={e} character={character} />{inspect && e.type === "action" && <Button variant="ghost" size="sm" className="w-fit" onClick={() => inspect(e)}>查看这次行动后的心理</Button>}</div>;
  if (e.type !== "message") return <Marker variant="separator"><MarkerContent>{e.text}{inspect && Boolean(e.data.commitment || e.data.repair) && <Button variant="link" size="sm" onClick={() => inspect(e)}>查看人物回应</Button>}</MarkerContent></Marker>;
  const mine = actor === e.actorId;
  return <Message align={mine ? "end" : "start"}><MessageAvatar><Button variant="ghost" size="icon" aria-label={`查看${character?.name ?? "人物"}`} onClick={() => e.actorId && select?.(e.actorId)}><Avatar className="size-9" data-tone={index % 5}><AvatarFallback>{character?.name.slice(-2) ?? "·"}</AvatarFallback></Avatar></Button></MessageAvatar><MessageContent><MessageHeader><Button variant="link" size="sm" onClick={() => e.actorId && select?.(e.actorId)}>{character?.name ?? "人物"}</Button>{e.data.channel !== "public" && <span className="ml-2">{e.data.channel === "team" ? "队内" : "私聊"}</span>}</MessageHeader><Bubble variant={mine ? "secondary" : "outline"} align={mine ? "end" : "start"}><BubbleContent><Streamdown mode="static">{e.text}</Streamdown></BubbleContent></Bubble>{typeof e.data.replyTo === "string" && <Button variant="ghost" size="xs" className="w-fit" onClick={() => { void scroller.scrollToMessage(e.data.replyTo as string); }}>查看上文</Button>}</MessageContent></Message>;
});

function HumanComposer({ run, opportunity }: { run: RunView; opportunity: RunView["opportunities"][number] }) {
  const [text, setText] = useState(""); const [recipient, setRecipient] = useState("current"); const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const ownObservation = run.events.findLast(event => event.type === "fact" && event.data.identityScope === run.id && event.data.stageId === opportunity.stage.id && Array.isArray(event.visibility) && event.visibility.includes(opportunity.actorId));
  const contacts = opportunity.communications.flatMap(c => c.channel === "private"
    ? c.recipients.filter(id => !(opportunity.channel === "private" && opportunity.recipients.length === 2 && opportunity.recipients.includes(id))).map(id => ({ value: `private:${id}`, label: `私聊 · ${run.characters.find(p => p.id === id)?.name}`, channel: c.channel, recipients: [id] }))
    : [{ value: c.channel, label: c.channel === "public" ? "公开频道" : "队内", channel: c.channel, recipients: c.channel === "public" ? [] : c.recipients }]);
  async function submit(action: string, input = {}) {
    setBusy(true);
    try { await json(`/api/v2/runs/${run.id}/actions`, { method: "POST", headers: headersFor(run.id, playerTokens(run.id)[opportunity.actorId]), body: JSON.stringify({ opportunityId: opportunity.id, action, input }) }); setText(""); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  function send() {
    if (recipient === "current") { void submit("speak", { text }); return; }
    const contact = contacts.find(c => c.value === recipient)!;
    void submit("send_message", { channel: contact.channel, recipients: contact.recipients, text });
  }
  return <div className="human-composer"><p className="mb-3 text-sm font-medium">轮到你了 · {opportunity.stage.label}</p>
    {ownObservation && <Collapsible className="mb-3"><CollapsibleTrigger asChild><Button variant="outline" size="sm"><Eye data-icon="inline-start" />查看本轮本人信息</Button></CollapsibleTrigger><CollapsibleContent className="mt-2 max-h-44 overflow-y-auto"><p className="text-sm text-muted-foreground" data-testid="human-observation">{ownObservation.text}</p></CollapsibleContent></Collapsible>}
    {opportunity.actions.length ? <FieldGroup>{opportunity.actions.map(a => <Field key={a.name}>
    <FieldLabel>{a.label}</FieldLabel><p className="text-xs text-muted-foreground">{run.scenario === "signaling-game" ? a.name === "declare_quality" ? "公开报告本轮质量。报告不改变真实质量，结算时会核验。" : "决定是否接受本轮交易。提交后不可撤回。" : a.description}</p><div className="flex gap-2">{a.fields.map(f => f.type === "number" ?
      <Input key={f.name} type="number" step={1} placeholder={`${f.min ?? 0}–${f.max ?? ""}`} aria-label={f.label} min={f.min} max={f.max} value={values[a.name] ?? ""} onChange={e => setValues(v => ({ ...v, [a.name]: e.target.value }))} /> :
      <Select key={f.name} value={values[a.name] ?? ""} onValueChange={value => setValues(v => ({ ...v, [a.name]: value }))}><SelectTrigger aria-label={f.label}><SelectValue placeholder="选择" /></SelectTrigger><SelectContent><SelectGroup>{f.options?.map((o, i) => <SelectItem key={i} value={JSON.stringify(o.value)}>{o.label}</SelectItem>)}</SelectGroup></SelectContent></Select>)}
      <Button disabled={busy || values[a.name] === undefined || values[a.name] === "" || a.fields.some(f => f.type === "number" && (!Number.isInteger(Number(values[a.name])) || Number(values[a.name]) < (f.min ?? -Infinity) || Number(values[a.name]) > (f.max ?? Infinity))) || run.status !== "running"} onClick={() => void submit(a.name, Object.fromEntries(a.fields.map(f => [f.name, f.type === "number" ? Number(values[a.name]) : JSON.parse(values[a.name])])))}><Check data-icon="inline-start" />提交</Button>
    </div></Field>)}</FieldGroup> : <>
    <InputGroup><InputGroupTextarea aria-label="说点什么" placeholder="说点什么…" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim() && !busy && run.status === "running") send(); }} />
    <InputGroupAddon align="block-end" className="justify-between"><Select value={recipient} onValueChange={setRecipient}><SelectTrigger className="w-32" aria-label="发给谁"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="current">当前频道</SelectItem>{contacts.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectGroup></SelectContent></Select>
      <div className="flex gap-2"><InputGroupButton disabled={busy || run.status !== "running"} onClick={() => void submit("wait")}>先听听</InputGroupButton><InputGroupButton variant="default" size="icon-sm" aria-label="发送" disabled={busy || !text.trim() || run.status !== "running"} onClick={send}>{busy ? <Spinner /> : <ArrowUp />}</InputGroupButton></div>
    </InputGroupAddon></InputGroup></>}</div>;
}
