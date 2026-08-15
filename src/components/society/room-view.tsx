import { useMemo, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  Eye,
  LockKeyhole,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Radio,
  ShieldQuestion,
  Users
} from "lucide-react";
import { AgentAvatar, EmptyPanel, eventLabel, formatClock, ModelLabel, RoleBadge, ScenarioIcon, StatusBadge } from "./shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { AgentRuntimeEvent, SocialMessage, StoryBeat } from "@/society/contracts";
import type { SocietyRoomEventEnvelope, SocietyRoomSnapshot } from "@/society/room";

export function RoomView({
  room,
  events,
  connection,
  onPause,
  onOpenAgents
}: {
  room: SocietyRoomSnapshot;
  events: SocietyRoomEventEnvelope[];
  connection: "connected" | "reconnecting" | "closed";
  onPause(): void;
  onOpenAgents(): void;
}): ReactNode {
  const latestBeat = room.world.story.at(-1);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RoomHeader room={room} connection={connection} onPause={onPause} onOpenAgents={onOpenAgents} />
      {room.error ? (
        <div className="px-5 pt-4 lg:px-7">
          <Alert variant="destructive" className="border-red-500/20 bg-red-500/[0.05]">
            <AlertTitle>房间已停止</AlertTitle>
            <AlertDescription>{room.error}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      <Tabs defaultValue="live" className="min-h-0 flex-1 gap-0">
        <div className="flex items-center justify-between border-b border-white/10 px-5 lg:px-7">
          <TabsList variant="line" className="h-11 gap-5">
            <TabsTrigger value="live" className="px-0 text-xs"><Radio />互动</TabsTrigger>
            <TabsTrigger value="world" className="px-0 text-xs"><Eye />世界</TabsTrigger>
          </TabsList>
          <div className="hidden items-center gap-2 text-[10px] text-muted-foreground sm:flex">
            <Eye className="size-3.5" />
            观察者视角
          </div>
        </div>

        <TabsContent value="live" className="min-h-0 overflow-y-auto p-5 lg:p-7">
          {latestBeat ? <CurrentBeat beat={latestBeat} /> : null}
          <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(280px,.75fr)]">
            <ConversationPanel room={room} />
            <ActivityPanel room={room} events={events} />
          </div>
        </TabsContent>

        <TabsContent value="world" className="min-h-0 overflow-y-auto p-5 lg:p-7">
          <WorldPanel room={room} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RoomHeader({
  room,
  connection,
  onPause,
  onOpenAgents
}: {
  room: SocietyRoomSnapshot;
  connection: "connected" | "reconnecting" | "closed";
  onPause(): void;
  onOpenAgents(): void;
}): ReactNode {
  return (
    <header className="border-b border-white/10 bg-background/70 px-5 py-4 backdrop-blur-xl lg:px-7">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035]">
            <ScenarioIcon id={room.scenarioId} className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight">{room.title}</h1>
              <StatusBadge status={room.status} compact />
              {connection === "reconnecting" ? <Badge variant="outline" className="h-5 border-amber-500/20 text-[10px] text-amber-400">重连中</Badge> : null}
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{room.world.summary}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="hidden items-center gap-4 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2 md:flex">
            <div><p className="font-mono text-[9px] uppercase tracking-wider text-zinc-600">阶段</p><p className="mt-0.5 text-xs">{room.world.phase}</p></div>
            <Separator orientation="vertical" className="h-6" />
            <div><p className="font-mono text-[9px] uppercase tracking-wider text-zinc-600">回合</p><p className="mt-0.5 font-mono text-xs">{Math.min(room.world.turn, room.world.totalTurns)} / {room.world.totalTurns}</p></div>
          </div>
          <Button variant="outline" size="icon-sm" className="xl:hidden" onClick={onOpenAgents} aria-label="查看 Agents"><Users /></Button>
          {room.status === "running" ? <Button variant="outline" size="sm" onClick={onPause}><Pause />暂停</Button> : null}
        </div>
      </div>
      <div className="mt-4 flex gap-2 overflow-x-auto pb-0.5">
        {room.agents.map((agent, index) => (
          <div key={agent.profile.id} className="flex shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-2">
            <AgentAvatar name={agent.profile.displayName} index={index} className="size-7" />
            <div className="min-w-0"><div className="flex items-center gap-1.5"><span className="text-[11px] font-medium">{agent.profile.displayName}</span><RoleBadge role={agent.observerRole} /></div><ModelLabel model={agent.profile.model} compact /></div>
          </div>
        ))}
      </div>
    </header>
  );
}

function CurrentBeat({ beat }: { beat: StoryBeat }): ReactNode {
  return (
    <div className={cn(
      "flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.025] px-4 py-3",
      beat.tone === "danger" && "border-red-500/20 bg-red-500/[0.04]",
      beat.tone === "positive" && "border-emerald-500/20 bg-emerald-500/[0.04]",
      beat.tone === "warning" && "border-amber-500/20 bg-amber-500/[0.04]"
    )}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/20"><Activity className="size-3.5" /></span>
      <div className="min-w-0 flex-1"><p className="text-xs font-medium">{beat.title}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{beat.text}</p></div>
      <span className="font-mono text-[9px] text-zinc-600">T{beat.turn}</span>
    </div>
  );
}

function ConversationPanel({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  return (
    <Card className="gap-0 border-white/10 bg-card/80 py-0 shadow-none">
      <CardHeader className="flex-row items-center justify-between border-b border-white/10 px-4 py-3.5">
        <div><CardTitle className="flex items-center gap-2 text-sm"><MessageCircle className="size-4 text-muted-foreground" />对话</CardTitle><p className="mt-1 text-[10px] text-muted-foreground">公开、私聊与阵营频道</p></div>
        <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-[10px] font-normal text-muted-foreground">{room.world.messages.length} 条消息</Badge>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[calc(100vh-23rem)] min-h-[440px] max-h-[720px]">
          {room.world.messages.length ? (
            <div className="divide-y divide-white/[0.06]">
              {room.world.messages.map((message) => <MessageRow key={message.id} room={room} message={message} />)}
            </div>
          ) : <EmptyPanel icon={<MessageCircle className="size-4" />} title="等待第一条消息" />}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function MessageRow({ room, message }: { room: SocietyRoomSnapshot; message: SocialMessage }): ReactNode {
  const agentIndex = room.agents.findIndex((agent) => agent.profile.id === message.senderId);
  const agent = room.agents[agentIndex];
  const recipients = message.recipientIds?.map((id) => room.agents.find((candidate) => candidate.profile.id === id)?.profile.displayName ?? id).join("、");
  return (
    <div className={cn("flex gap-3 px-4 py-4", message.channel !== "public" && "bg-white/[0.015]")}>
      <AgentAvatar name={message.senderName} index={agentIndex} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">{message.senderName}</span>
          <RoleBadge role={agent?.observerRole} />
          <ChannelBadge channel={message.channel} recipients={recipients} />
          <time className="ml-auto font-mono text-[9px] text-zinc-600">{formatClock(message.createdAt)}</time>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-zinc-300">{message.text}</p>
        <p className="mt-2 font-mono text-[9px] text-zinc-700">TURN {message.turn} · {message.phase}</p>
      </div>
    </div>
  );
}

function ChannelBadge({ channel, recipients }: { channel: SocialMessage["channel"]; recipients?: string }): ReactNode {
  if (channel === "public") return <Badge variant="outline" className="h-5 border-white/10 px-1.5 text-[9px] font-normal text-muted-foreground">公开</Badge>;
  return (
    <Badge variant="outline" className={cn("h-5 gap-1 border-blue-500/20 bg-blue-500/[0.05] px-1.5 text-[9px] font-normal text-blue-300", channel === "team" && "border-violet-500/20 bg-violet-500/[0.05] text-violet-300")}>
      <LockKeyhole className="size-2.5" />
      {channel === "team" ? "阵营" : recipients ? `私聊 ${recipients}` : "私聊"}
    </Badge>
  );
}

function ActivityPanel({ room, events }: { room: SocietyRoomSnapshot; events: SocietyRoomEventEnvelope[] }): ReactNode {
  const visible = useMemo(() => events.filter((entry) => ["world.action", "agent.tool", "agent.note", "room.status"].includes(entry.event.type)).slice(-120).reverse(), [events]);
  return (
    <Card className="gap-0 border-white/10 bg-card/80 py-0 shadow-none">
      <CardHeader className="flex-row items-center justify-between border-b border-white/10 px-4 py-3.5">
        <div><CardTitle className="flex items-center gap-2 text-sm"><Activity className="size-4 text-muted-foreground" />动态</CardTitle><p className="mt-1 text-[10px] text-muted-foreground">工具、行动与决策摘要</p></div>
        <Radio className="live-pulse size-3.5 text-emerald-400" />
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[calc(100vh-23rem)] min-h-[440px] max-h-[720px]">
          {visible.length ? <div className="divide-y divide-white/[0.06]">{visible.map((entry) => <EventRow key={entry.seq} room={room} event={entry.event} />)}</div> : <EmptyPanel title="等待 Agent 行动" />}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function EventRow({ room, event }: { room: SocietyRoomSnapshot; event: AgentRuntimeEvent }): ReactNode {
  const actorId = "actorId" in event ? event.actorId : undefined;
  const actorIndex = actorId ? room.agents.findIndex((agent) => agent.profile.id === actorId) : -1;
  const actor = actorIndex >= 0 ? room.agents[actorIndex] : undefined;
  const content = eventContent(event);
  return (
    <div className="flex gap-2.5 px-3.5 py-3">
      {actor ? <AgentAvatar name={actor.profile.displayName} index={actorIndex} className="size-7" /> : <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.025]"><Bot className="size-3.5 text-muted-foreground" /></span>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="truncate text-[11px] font-medium">{actor?.profile.displayName ?? "房间"}</span><Badge variant="outline" className="h-4 border-white/10 px-1 text-[8px] font-normal text-zinc-500">{content.label}</Badge><time className="ml-auto font-mono text-[8px] text-zinc-700">{"at" in event ? formatClock(event.at) : ""}</time></div>
        <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-muted-foreground">{content.text}</p>
      </div>
    </div>
  );
}

function WorldPanel({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const scores = asNumberRecord(room.world.details.scores);
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1.15fr_.85fr]">
        <Card className="gap-0 border-white/10 bg-card/80 py-0 shadow-none">
          <CardHeader className="border-b border-white/10 px-5 py-4"><CardTitle className="text-sm">参与者</CardTitle></CardHeader>
          <CardContent className="grid gap-2 p-4 sm:grid-cols-2">
            {room.agents.map((agent, index) => {
              const worldAgent = room.world.agents.find((candidate) => candidate.id === agent.profile.id);
              return (
                <div key={agent.profile.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
                  <div className="flex items-start gap-3">
                    <AgentAvatar name={agent.profile.displayName} index={index} className="size-9" />
                    <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="text-xs font-medium">{agent.profile.displayName}</span><RoleBadge role={agent.observerRole} /></div><ModelLabel model={agent.profile.model} /></div>
                    <span className={cn("mt-1 size-2 rounded-full bg-zinc-600", worldAgent?.alive && "bg-emerald-400")} />
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-white/[0.07] pt-2.5 text-[10px] text-muted-foreground"><span>{worldAgent?.alive ? "存活" : "出局"}</span>{scores[agent.profile.id] !== undefined ? <span className="font-mono text-zinc-300">{scores[agent.profile.id]} pts</span> : <StatusBadge status={agent.status} compact />}</div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="gap-0 border-white/10 bg-card/80 py-0 shadow-none">
          <CardHeader className="border-b border-white/10 px-5 py-4"><CardTitle className="text-sm">当前世界</CardTitle></CardHeader>
          <CardContent className="space-y-4 p-5">
            <WorldMetric label="场景" value={room.title} icon={<ScenarioIcon id={room.scenarioId} />} />
            <WorldMetric label="阶段" value={room.world.phase} icon={<Activity />} />
            <WorldMetric label="回合" value={`${Math.min(room.world.turn, room.world.totalTurns)} / ${room.world.totalTurns}`} icon={<MoreHorizontal />} />
            <WorldMetric label="存活" value={`${room.world.agents.filter((agent) => agent.alive).length} / ${room.world.agents.length}`} icon={<Users />} />
            <Separator />
            <p className="text-xs leading-5 text-muted-foreground">{room.world.summary}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="gap-0 border-white/10 bg-card/80 py-0 shadow-none">
        <CardHeader className="border-b border-white/10 px-5 py-4"><CardTitle className="text-sm">进程</CardTitle></CardHeader>
        <CardContent className="p-0">
          {room.world.story.length ? <div className="divide-y divide-white/[0.06]">{room.world.story.slice().reverse().map((beat) => <StoryRow key={beat.id} beat={beat} />)}</div> : <EmptyPanel title="暂无进程" />}
        </CardContent>
      </Card>
    </div>
  );
}

function StoryRow({ beat }: { beat: StoryBeat }): ReactNode {
  return (
    <div className="grid grid-cols-[60px_20px_1fr_auto] items-start gap-2 px-5 py-4">
      <span className="pt-0.5 font-mono text-[10px] text-zinc-600">TURN {beat.turn}</span>
      <span className={cn("mt-1 size-2 rounded-full bg-zinc-500", beat.tone === "danger" && "bg-red-400", beat.tone === "warning" && "bg-amber-400", beat.tone === "positive" && "bg-emerald-400", beat.tone === "complete" && "bg-blue-400")} />
      <div><p className="text-xs font-medium">{beat.title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{beat.text}</p></div>
      <time className="font-mono text-[9px] text-zinc-700">{formatClock(beat.at)}</time>
    </div>
  );
}

function WorldMetric({ label, value, icon }: { label: string; value: string; icon: ReactNode }): ReactNode {
  return <div className="flex items-center gap-3"><span className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.025] text-muted-foreground [&_svg]:size-3.5">{icon}</span><div><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-0.5 text-xs font-medium">{value}</p></div></div>;
}

function eventContent(event: AgentRuntimeEvent): { label: string; text: string } {
  if (event.type === "world.action") return { label: "行动", text: `${eventLabel(event.action)} · ${event.detail}` };
  if (event.type === "agent.tool") return { label: event.phase === "completed" ? "工具完成" : "工具调用", text: `${eventLabel(event.toolName)}${event.summary ? ` · ${event.summary}` : ""}` };
  if (event.type === "agent.note") return { label: event.kind === "decision" ? "决策" : event.kind === "outcome" ? "结果" : "状态", text: event.text };
  if (event.type === "room.status") return { label: "房间", text: event.detail ?? event.status };
  return { label: "事件", text: event.type };
}

function asNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}
