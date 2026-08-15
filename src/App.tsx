import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Braces, Menu, Plus, Radio, Users, X } from "lucide-react";
import { AgentInspector } from "./components/society/agent-inspector";
import { CreateRoomDialog } from "./components/society/create-room-dialog";
import { RoomView } from "./components/society/room-view";
import { RoomSidebar } from "./components/society/sidebar";
import { ScenarioIcon, StatusBadge } from "./components/society/shared";
import type { ModelOption } from "./components/society/types";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./components/ui/sheet";
import { Skeleton } from "./components/ui/skeleton";
import { cn } from "./lib/utils";
import type { AgentRuntimeEvent, ScenarioId, ScenarioSummary } from "./society/contracts";
import type { SocietyRoomEventEnvelope, SocietyRoomSnapshot } from "./society/room";

interface CatalogResponse {
  scenarios: ScenarioSummary[];
  models: ModelOption[];
}

export function App(): ReactNode {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [rooms, setRooms] = useState<SocietyRoomSnapshot[]>([]);
  const [room, setRoom] = useState<SocietyRoomSnapshot | null>(null);
  const [events, setEvents] = useState<SocietyRoomEventEnvelope[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [initialScenarioId, setInitialScenarioId] = useState<ScenarioId>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [connection, setConnection] = useState<"connected" | "reconnecting" | "closed">("closed");
  const sourceRef = useRef<EventSource | null>(null);

  const upsertRoom = useCallback((next: SocietyRoomSnapshot) => {
    setRoom(next);
    setRooms((current) => [next, ...current.filter((candidate) => candidate.id !== next.id)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getJson<CatalogResponse>("/api/scenarios"),
      getJson<{ rooms: SocietyRoomSnapshot[] }>("/api/rooms")
    ]).then(([catalog, roomList]) => {
      if (!active) return;
      setScenarios(catalog.scenarios);
      setModels(catalog.models);
      setRooms(roomList.rooms);
      if (roomList.rooms[0]) {
        setRoom(roomList.rooms[0]);
        setEvents(roomList.rooms[0].recentEvents);
        setSelectedAgentId(roomList.rooms[0].agents[0]?.profile.id);
      }
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    sourceRef.current?.close();
    setConnection("closed");
    if (!room?.id) return;
    const source = new EventSource(`/api/rooms/${encodeURIComponent(room.id)}/events`);
    sourceRef.current = source;
    source.onopen = () => setConnection("connected");
    source.addEventListener("snapshot", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as SocietyRoomSnapshot;
      upsertRoom(next);
      setEvents(next.recentEvents);
      setSelectedAgentId((current) => current && next.agents.some((agent) => agent.profile.id === current) ? current : next.agents[0]?.profile.id);
    });
    source.addEventListener("room", (event) => {
      const envelope = JSON.parse((event as MessageEvent).data) as SocietyRoomEventEnvelope;
      setEvents((current) => appendEvent(current, envelope));
      setRoom((current) => {
        if (!current || current.id !== envelope.event.roomId) return current;
        const next = reduceRoom(current, envelope.event);
        setRooms((list) => [next, ...list.filter((candidate) => candidate.id !== next.id)]);
        return next;
      });
    });
    source.onerror = () => setConnection("reconnecting");
    return () => {
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
    };
  }, [room?.id, upsertRoom]);

  const openCreate = useCallback((scenarioId?: ScenarioId) => {
    setInitialScenarioId(scenarioId);
    setCreateOpen(true);
    setSidebarOpen(false);
  }, []);

  const selectRoom = useCallback((next: SocietyRoomSnapshot) => {
    setRoom(next);
    setEvents(next.recentEvents);
    setSelectedAgentId(next.agents[0]?.profile.id);
    setSidebarOpen(false);
  }, []);

  const createRoom = async (input: { scenarioId: ScenarioId; models: string[]; rounds: number }): Promise<void> => {
    setCreating(true);
    setError(undefined);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });
      const payload = await response.json() as SocietyRoomSnapshot & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? `创建失败 (${response.status})`);
      upsertRoom(payload);
      setEvents(payload.recentEvents);
      setSelectedAgentId(payload.agents[0]?.profile.id);
      setCreateOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };

  const pauseRoom = async (): Promise<void> => {
    if (!room) return;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/pause`, { method: "POST" });
      const payload = await response.json() as SocietyRoomSnapshot & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? `暂停失败 (${response.status})`);
      upsertRoom(payload);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const sidebar = (
    <RoomSidebar
      scenarios={scenarios}
      rooms={rooms}
      activeRoomId={room?.id}
      onSelectRoom={selectRoom}
      onCreate={openCreate}
    />
  );

  return (
    <div className="flex h-screen min-h-[620px] flex-col overflow-hidden bg-background">
      <Topbar room={room} onMenu={() => setSidebarOpen(true)} onCreate={() => openCreate()} />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 border-r border-sidebar-border lg:block">{sidebar}</aside>
        <main className="flex min-w-0 flex-1">
          {loading ? <LoadingView /> : room ? (
            <RoomView room={room} events={events} connection={connection} onPause={() => void pauseRoom()} onOpenAgents={() => setAgentsOpen(true)} />
          ) : (
            <HomeView scenarios={scenarios} error={error} onCreate={openCreate} />
          )}
          {room ? (
            <div className="hidden w-[360px] shrink-0 xl:block">
              <AgentInspector room={room} events={events} selectedAgentId={selectedAgentId} onSelectAgent={setSelectedAgentId} />
            </div>
          ) : null}
        </main>
      </div>

      {error && room ? (
        <div className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-red-500/20 bg-zinc-950 px-3 py-2.5 shadow-2xl">
          <span className="size-1.5 rounded-full bg-red-400" />
          <span className="max-w-[70vw] truncate text-xs text-zinc-300">{error}</span>
          <Button variant="ghost" size="icon-xs" onClick={() => setError(undefined)}><X /></Button>
        </div>
      ) : null}

      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-72 border-white/10 p-0" showCloseButton={false}>
          <SheetHeader className="sr-only"><SheetTitle>导航</SheetTitle></SheetHeader>
          {sidebar}
        </SheetContent>
      </Sheet>

      <Sheet open={agentsOpen} onOpenChange={setAgentsOpen}>
        <SheetContent side="right" className="w-[min(92vw,380px)] border-white/10 p-0" showCloseButton={false}>
          <SheetHeader className="sr-only"><SheetTitle>参与者</SheetTitle></SheetHeader>
          {room ? <AgentInspector room={room} events={events} selectedAgentId={selectedAgentId} onSelectAgent={setSelectedAgentId} /> : null}
        </SheetContent>
      </Sheet>

      <CreateRoomDialog
        open={createOpen}
        scenarios={scenarios}
        models={models}
        initialScenarioId={initialScenarioId}
        loading={creating}
        onOpenChange={setCreateOpen}
        onSubmit={createRoom}
      />
    </div>
  );
}

function Topbar({ room, onMenu, onCreate }: { room: SocietyRoomSnapshot | null; onMenu(): void; onCreate(): void }): ReactNode {
  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center border-b border-white/10 bg-background/85 px-3 backdrop-blur-xl sm:px-4">
      <Button variant="ghost" size="icon-sm" className="mr-2 lg:hidden" onClick={onMenu}><Menu /></Button>
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 grid-cols-2 gap-0.5 rounded-md border border-white/20 bg-white p-1.5">
          <i className="rounded-[1px] bg-black" /><i className="rounded-[1px] bg-black/45" /><i className="rounded-[1px] bg-black/45" /><i className="rounded-[1px] bg-black" />
        </span>
        <span className="text-sm font-semibold tracking-tight">Society</span>
        <Badge variant="outline" className="hidden h-5 border-white/10 px-1.5 font-mono text-[9px] font-normal text-zinc-600 sm:inline-flex">AGENTS SDK</Badge>
      </div>
      <div className="ml-5 hidden min-w-0 flex-1 items-center gap-2 border-l border-white/10 pl-5 text-xs text-muted-foreground md:flex">
        {room ? <><ScenarioIcon id={room.scenarioId} className="size-3.5" /><span className="truncate">{room.title}</span><span className="text-zinc-700">/</span><span className="truncate text-zinc-500">{room.world.phase}</span></> : <span>Multi-agent social worlds</span>}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {room ? <StatusBadge status={room.status} compact /> : null}
        <Button size="sm" onClick={onCreate}><Plus />新建</Button>
      </div>
    </header>
  );
}

function HomeView({ scenarios, error, onCreate }: { scenarios: ScenarioSummary[]; error?: string; onCreate(scenarioId?: ScenarioId): void }): ReactNode {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8 lg:py-20">
        {error ? (
          <Alert variant="destructive" className="mb-8 border-red-500/20 bg-red-500/[0.05]"><AlertTitle>无法连接服务</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
        ) : null}
        <div className="max-w-3xl">
          <Badge variant="outline" className="mb-5 gap-2 border-white/10 bg-white/[0.025] px-2.5 py-1 font-normal text-muted-foreground"><Radio className="size-3 text-emerald-400" />实时多 Agent 世界</Badge>
          <h1 className="text-balance text-4xl font-semibold tracking-[-0.045em] sm:text-5xl lg:text-6xl">观察 Agents 如何协商、结盟与背叛</h1>
          <p className="mt-5 max-w-2xl text-balance text-sm leading-7 text-muted-foreground sm:text-base">每名参与者由独立模型、session、记忆和工具驱动。发言、私聊、决策与行动实时呈现在同一个世界中。</p>
          <Button size="lg" className="mt-7" onClick={() => onCreate()}>创建房间<ArrowRight /></Button>
        </div>

        <div className="mt-14 grid gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 sm:grid-cols-2">
          {scenarios.map((scenario) => (
            <button key={scenario.id} className="group bg-background p-5 text-left transition-colors hover:bg-zinc-900/90" onClick={() => onCreate(scenario.id)}>
              <div className="flex items-start justify-between gap-4">
                <span className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03]"><ScenarioIcon id={scenario.id} className="size-4" /></span>
                <ArrowRight className="size-4 text-zinc-700 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-300" />
              </div>
              <h2 className="mt-5 text-sm font-semibold">{scenario.name}</h2>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{scenario.description}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">{scenario.capabilities.map((capability) => <Badge key={capability} variant="outline" className="border-white/10 bg-white/[0.02] text-[10px] font-normal text-zinc-500">{capability}</Badge>)}</div>
              <div className="mt-5 flex items-center gap-4 font-mono text-[10px] text-zinc-600"><span className="flex items-center gap-1.5"><Users className="size-3" />{scenario.players} 名 Agent</span><span>{scenario.defaultRounds} 回合</span></div>
            </button>
          ))}
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-3">
          <Feature icon={<Braces />} title="OpenAI Agents SDK" detail="真实工具循环与独立会话" />
          <Feature icon={<Radio />} title="实时交互" detail="SSE 推送发言、工具与行动" />
          <Feature icon={<Users />} title="持续心智" detail="目标、信念、关系与记忆" />
        </div>
      </div>
    </div>
  );
}

function Feature({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }): ReactNode {
  return <Card className="gap-0 border-white/10 bg-white/[0.02] p-4 shadow-none"><span className="text-muted-foreground [&_svg]:size-4">{icon}</span><p className="mt-4 text-xs font-medium">{title}</p><p className="mt-1 text-[11px] text-muted-foreground">{detail}</p></Card>;
}

function LoadingView(): ReactNode {
  return (
    <div className="flex min-w-0 flex-1 flex-col p-6">
      <div className="flex items-center gap-3"><Skeleton className="size-10 rounded-xl" /><div><Skeleton className="h-4 w-40" /><Skeleton className="mt-2 h-3 w-64" /></div></div>
      <div className="mt-8 grid flex-1 gap-4 xl:grid-cols-[1.4fr_.7fr]"><Skeleton className="min-h-[480px] rounded-xl" /><Skeleton className="min-h-[480px] rounded-xl" /></div>
    </div>
  );
}

function appendEvent(events: SocietyRoomEventEnvelope[], event: SocietyRoomEventEnvelope): SocietyRoomEventEnvelope[] {
  if (events.some((candidate) => candidate.seq === event.seq)) return events;
  return [...events, event].slice(-600);
}

function reduceRoom(room: SocietyRoomSnapshot, event: AgentRuntimeEvent): SocietyRoomSnapshot {
  const updatedAt = "at" in event && typeof event.at === "string" ? event.at : new Date().toISOString();
  if (event.type === "world.updated") return { ...room, world: event.snapshot, updatedAt };
  if (event.type === "room.status") return { ...room, status: event.status, updatedAt, ...(event.status === "error" && event.detail ? { error: event.detail } : {}) };
  if (event.type === "agent.status") return { ...room, updatedAt, agents: room.agents.map((agent) => agent.profile.id === event.actorId ? { ...agent, status: event.status } : agent) };
  if (event.type === "agent.updated") {
    return {
      ...room,
      updatedAt,
      agents: room.agents.map((agent) => agent.profile.id === event.actorId
        ? { ...agent, status: event.status, mind: event.mind, turnCount: event.turnCount, totalTokens: event.totalTokens, ...(event.lastOutput === undefined ? {} : { lastOutput: event.lastOutput }) }
        : agent)
    };
  }
  if (event.type === "agent.note") return { ...room, updatedAt, agents: room.agents.map((agent) => agent.profile.id === event.actorId ? { ...agent, latestNote: event } : agent) };
  if (event.type === "agent.tool") return { ...room, updatedAt, agents: room.agents.map((agent) => agent.profile.id === event.actorId ? { ...agent, latestTool: event } : agent) };
  if (event.type === "agent.message" && !room.world.messages.some((message) => message.id === event.message.id)) {
    return { ...room, updatedAt, world: { ...room.world, messages: [...room.world.messages, event.message] } };
  }
  return { ...room, updatedAt };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `请求失败 (${response.status})`);
  return payload;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
