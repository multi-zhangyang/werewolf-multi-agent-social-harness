import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Copy, Clapperboard, Flame, ListOrdered, Pause, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Conversation } from "./conversation";
import { ParticipantsRail } from "./participants";
import { AgentPresence, ScenarioIcon, StatusDot, StatusLabel } from "./shared";
import { WorldStagePanel } from "./stage-panels";
import { useRoom, type RoomConnection } from "./use-room";
import { WorldPanel } from "./world-panel";

interface RoomViewProps {
  roomId: string;
  token?: string;
  onBack: () => void;
  onReplay?: () => void;
}

export function RoomView({ roomId, token, onBack, onReplay }: RoomViewProps): ReactNode {
  const [viewerMode, setViewerMode] = useState<"public" | "omniscient" | "agent-pov" | "postgame">("public");
  const [autoSwitchedToPostgame, setAutoSwitchedToPostgame] = useState(false);
  const [povAgentId, setPovAgentId] = useState<string>();
  const [stageView, setStageView] = useState<"arena" | "analysis">("arena");
  const [pace, setPace] = useState<0.5 | 1 | 2 | 4>(1);
  const [jumpToAt, setJumpToAt] = useState<string>();
  const { room, connection, error, activity, toolCalls, tension, cue, timeline, pause, resume, toggleAgentPause, submitAction } = useRoom(
    roomId,
    token,
    { mode: viewerMode, agentId: viewerMode === "agent-pov" ? povAgentId : undefined }
  );

  useEffect(() => {
    if (viewerMode === "agent-pov" && !povAgentId && room?.player?.actorId) {
      setPovAgentId(room.player.actorId);
    }
  }, [viewerMode, povAgentId, room?.player?.actorId]);

  // Once the game ends, step the default viewer into the postgame truth
  // layer exactly once; the user can still switch back to any other mode.
  useEffect(() => {
    if (!autoSwitchedToPostgame && room?.status === "finished" && viewerMode !== "postgame") {
      setAutoSwitchedToPostgame(true);
      setViewerMode("postgame");
    }
  }, [room?.status, viewerMode, autoSwitchedToPostgame]);

  // High-tension moments snap playback back to 1× so nobody misses the beat
  // while skipping ahead (§8.9).
  const previousTension = useRef(tension?.level);
  useEffect(() => {
    const level = tension?.level;
    if ((level === "tense" || level === "climax") && previousTension.current !== level) {
      setPace(1);
    }
    previousTension.current = level;
  }, [tension?.level]);
  if (!room) {
    return (
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
        <RoomHeaderSkeleton onBack={onBack} />
        <div className="mx-auto grid min-h-0 w-full max-w-[1800px] flex-1 grid-cols-1 gap-3 overflow-hidden p-3 lg:grid-cols-[260px_minmax(0,1fr)_360px]">
          <div className="hidden flex-col gap-3 lg:flex"><Skeleton className="h-24 rounded-lg" /><Skeleton className="h-24 rounded-lg" /></div>
          <div className="flex min-h-0 flex-col gap-3"><Skeleton className="h-40 rounded-lg" /><Skeleton className="min-h-0 flex-1 rounded-lg" /></div>
          <div className="hidden flex-col gap-3 lg:flex"><Skeleton className="h-32 rounded-lg" /><Skeleton className="min-h-0 flex-1 rounded-lg" /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background" style={{ "--pace": String(pace) } as React.CSSProperties}>
      <header className="shrink-0 border-b bg-background">
        <div className="mx-auto flex h-14 w-full max-w-[1920px] items-center gap-2 px-3">
          <Button variant="ghost" size="icon-sm" aria-label="返回" onClick={onBack}>
            <ArrowLeft />
          </Button>
          <span className="flex size-8 items-center justify-center rounded-md border bg-muted text-muted-foreground">
            <ScenarioIcon id={room.scenarioId} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="max-w-52 truncate text-sm font-semibold tracking-tight xl:max-w-72">{room.title}</p>
              {room.mode === "human" ? (
                <Badge variant="outline">真人</Badge>
              ) : null}
              {room.seasonMode === "one-shot" ? (
                <Badge variant="outline">单局</Badge>
              ) : null}
            </div>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <StatusDot status={room.status} />
              <StatusLabel status={room.status} />
              {connection === "reconnecting" ? (
                <span className="ml-1 flex items-center gap-1">
                  <RefreshCw className="animate-spin" />
                  重连中
                </span>
              ) : null}
            </p>
          </div>

          <div className="ml-auto flex min-w-0 items-center justify-end gap-1.5">
            <ViewModeSwitcher
              mode={viewerMode}
              isPlayer={Boolean(token)}
              finished={room.status === "finished"}
              onChange={setViewerMode}
            />
            {viewerMode === "agent-pov" && !token ? (
              <Select value={povAgentId ?? ""} onValueChange={setPovAgentId}>
                <SelectTrigger className="hidden w-32 md:flex" aria-label="跟随的参与者">
                  <SelectValue placeholder="选择视角" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {room.participants.map((participant) => (
                      <SelectItem key={participant.profile.id} value={participant.profile.id}>{participant.profile.displayName}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
            <div className="hidden h-8 items-center gap-2 rounded-md border bg-card px-3 lg:flex">
              <span className={cn("size-1.5 rounded-full", room.world.status === "finished" ? "bg-muted-foreground/40" : "bg-foreground")} />
              <span className="max-w-28 truncate text-xs font-medium">{room.world.phase}</span>
              <span className="nums font-mono text-[11px] text-muted-foreground">
                {room.world.turn} / {room.world.totalTurns}
              </span>
              <ActBar turn={room.world.turn} total={room.world.totalTurns} finished={room.world.status === "finished"} />
            </div>
            {room.status !== "finished" ? <TensionMeter tension={tension} /> : null}
            {room.status !== "finished" ? <PaceControl pace={pace} onChange={setPace} /> : null}
            <ShareButton roomId={room.id} />
            {room.status === "running" ? (
              <Button variant="outline" size="sm" aria-label="暂停房间" onClick={() => void pause()}>
                <Pause data-icon="inline-start" />
                <span className="hidden xl:inline">暂停</span>
              </Button>
            ) : null}
            {room.status === "paused" ? (
              <Button variant="default" size="sm" aria-label="恢复房间" onClick={() => void resume()}>
                <RefreshCw data-icon="inline-start" />
                <span className="hidden xl:inline">恢复</span>
              </Button>
            ) : null}
            <ViewToggle view={stageView} onChange={setStageView} />
          </div>
        </div>
      </header>

      <div className="mx-auto grid min-h-0 w-full max-w-[1920px] flex-1 grid-cols-1 overflow-hidden border-x lg:grid-cols-[248px_minmax(0,1fr)_352px]">
        <aside className="hidden min-h-0 overflow-hidden border-r bg-card/20 lg:flex lg:flex-col">
          <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">持续人物</p>
            <span className="nums font-mono text-[11px] text-muted-foreground">{room.participants.length}P</span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-2">
              <ParticipantsRail
                participants={room.participants}
                humanActorId={room.player?.actorId}
                activity={activity}
                roomPaused={room.status === "paused"}
                roomId={room.id}
                onToggleAgentPause={(actorId, paused) => { void toggleAgentPause(actorId, paused); }}
              />
            </div>
          </ScrollArea>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          {stageView === "arena" ? (
            <div className="max-h-[32vh] shrink-0 overflow-y-auto border-b">
              <ArenaStage room={room} cue={cue} activity={activity} />
            </div>
          ) : null}
          <main className="relative min-h-0 flex-1 overflow-hidden bg-card/20">
            <CueBanner cue={cue} finished={room.world.status === "finished"} names={new Map(room.participants.map((participant) => [participant.profile.id, participant.profile.displayName]))} />
            <Conversation room={room} activity={activity} onAction={submitAction} onReplay={onReplay} jumpToAt={jumpToAt} />
          </main>
        </section>

        <aside className="hidden min-h-0 overflow-hidden border-l bg-card/10 lg:block">
          <ScrollArea className="h-full">
            <div className="p-3">
              <WorldPanel room={room} toolCalls={toolCalls} timeline={timeline} onJumpToAt={setJumpToAt} />
            </div>
          </ScrollArea>
        </aside>

        <div className="fixed inset-x-0 bottom-3 flex justify-center lg:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" className="h-10 rounded-full px-5 text-xs shadow-lg backdrop-blur-xl">
                <ListOrdered data-icon="inline-start" />
                战况 · 时间线 · 高光
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[76vh] overflow-y-auto rounded-t-2xl">
              <SheetHeader>
                <SheetTitle>实时战况与社会时间线</SheetTitle>
              </SheetHeader>
              <WorldPanel room={room} toolCalls={toolCalls} timeline={timeline} onJumpToAt={setJumpToAt} />
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {error ? (
        <div className="fixed inset-x-0 bottom-4 z-30 mx-auto w-fit rounded-full border border-red-400/30 bg-card px-5 py-2 text-xs text-red-400 shadow-lg">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function ViewModeSwitcher({ mode, isPlayer, finished, onChange }: {
  mode: "public" | "omniscient" | "agent-pov" | "postgame";
  isPlayer: boolean;
  finished: boolean;
  onChange: (mode: "public" | "omniscient" | "agent-pov" | "postgame") => void;
}): ReactNode {
  const options: Array<{ value: "public" | "omniscient" | "agent-pov" | "postgame"; label: string; disabled: boolean; hint: string }> = [
    { value: "public", label: "公开", disabled: false, hint: "不显示隐藏身份、私聊与私有心智" },
    { value: "omniscient", label: "全知", disabled: isPlayer, hint: isPlayer ? "真人玩家在对局中不能进入全知席位" : "显示所有频道与结构化思考摘要" },
    { value: "agent-pov", label: "跟随", disabled: false, hint: "只看到该参与者的可见信息" },
    { value: "postgame", label: "终局", disabled: !finished, hint: finished ? "终局解锁全部真相与高光" : "对局结束后解锁" }
  ];
  return (
    <div className="hidden items-center rounded-md border bg-card p-0.5 md:flex">
      {options.map((option) => (
        <Tooltip key={option.value}>
          <TooltipTrigger asChild>
            <Button
              variant={mode === option.value ? "secondary" : "ghost"}
              size="xs"
              disabled={option.disabled}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{option.hint}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: "arena" | "analysis"; onChange: (view: "arena" | "analysis") => void }): ReactNode {
  return (
    <div className="hidden items-center rounded-md border bg-card p-0.5 2xl:flex" title="舞台优先；分析视图保留完整三栏">
      <Button
        variant={view === "arena" ? "secondary" : "ghost"}
        size="xs"
        onClick={() => onChange("arena")}
      >
        舞台
      </Button>
      <Button
        variant={view === "analysis" ? "secondary" : "ghost"}
        size="xs"
        onClick={() => onChange("analysis")}
      >
        分析
      </Button>
    </div>
  );
}

/** The stage-first view: all seats as a focal band, director focus highlighted. */
function ArenaStage({ room, cue, activity }: {
  room: SocietyRoomSnapshot;
  cue: RoomConnection["cue"];
  activity: RoomConnection["activity"];
}): ReactNode {
  const focusIds = new Set(cue?.focusAgentIds ?? []);
  // Suspicion-driven seat states (§8.11): the most suspect seats carry an
  // explicit 被围攻 marker instead of relying on mood text alone.
  const suspicionScores = (() => {
    const root = room.world.details?.suspicion as { scores?: Record<string, number> } | undefined;
    const scores = Object.entries(root?.scores ?? {});
    if (!scores.length) return new Map<string, number>();
    const top = scores.sort((a, b) => b[1] - a[1]).slice(0, 2);
    return new Map(top);
  })();
  return (
    <section className="bg-card/20 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-foreground/65">舞台席位</p>
        <span className="nums font-mono text-[11px] text-muted-foreground">
          {room.participants.some((participant) => !participant.alive)
            ? `${room.participants.filter((participant) => participant.alive).length} 人存活`
            : `${room.participants.length} 人在场`}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-1.5">
        {room.participants.map((participant, index) => {
          const state = activity[participant.profile.id];
          const speaking = participant.status === "speaking" || participant.status === "acting";
          const focused = focusIds.has(participant.profile.id);
          const dead = !participant.alive;
          return (
            <div
              key={participant.profile.id}
              className={cn(
                "relative flex min-w-0 flex-col items-center rounded-md border px-2 py-2 transition-all",
                dead ? "opacity-40" : "bg-card",
                speaking && "border-foreground/60",
                focused && "ring-1 ring-foreground"
              )}
            >
              {focused ? (
                <Badge className="absolute -top-2 left-1/2 -translate-x-1/2" variant="secondary">焦点</Badge>
              ) : null}
              {dead ? (
                <Badge className="absolute right-1 top-1" variant="outline">出局</Badge>
              ) : suspicionScores.has(participant.profile.id) ? (
                <Badge className="absolute right-1 top-1" variant="outline">焦点</Badge>
              ) : null}
              <AgentPresence name={participant.profile.displayName} index={index} seed={participant.profile.characterId} size="lg" status={dead || room.status === "finished" ? "finished" : participant.status} />
              <p className="mt-1 max-w-full truncate text-xs font-semibold tracking-tight">{participant.profile.displayName}</p>
              <p className="flex max-w-full items-center gap-1 text-[10px] text-foreground/60">
                <StatusDot status={dead ? "finished" : participant.status} />
                <span className="truncate">{participant.role ?? participant.mood ?? "—"}</span>
              </p>
              {state?.thought ? (
                <p className="mt-0.5 w-full truncate text-center text-[9px] leading-4 text-muted-foreground" title={state.thought.text}>
                  {state.thought.title}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <DuelStrip room={room} cue={cue} />
      <WorldStagePanel room={room} />
    </section>
  );
}

/**
 * Direct-conflict presentation (§8.8): when the director derives a duel cue
 * from real accusation facts, the stage shows the two sides head-to-head with
 * their latest public statements — derived from the room's own speech, never
 * fabricated. The wide stage and banner remain the default elsewhere.
 */
function DuelStrip({ room, cue }: {
  room: SocietyRoomSnapshot;
  cue: RoomConnection["cue"];
}): ReactNode {
  if (cue?.camera !== "duel" || cue.focusAgentIds.length < 2) return null;
  const sides = cue.focusAgentIds.slice(0, 2)
    .map((id) => {
      const participant = room.participants.find((entry) => entry.profile.id === id);
      const lastPublic = [...room.world.messages].reverse().find((message) => message.senderId === id && message.channel === "public");
      return { id, participant, lastPublic };
    })
    .filter((side): side is { id: string; participant: NonNullable<typeof side.participant>; lastPublic: typeof side.lastPublic } => Boolean(side.participant));
  if (sides.length < 2) return null;
  return (
    <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
      {sides[0] ? (
        <div
          className="rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-left"
        >
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-tight">
            <SwordsIcon className="size-3 text-red-400" />
            {sides[0].participant.profile.displayName}
            {sides[0].participant.mood ? <span className="text-[10px] font-normal text-muted-foreground">· {sides[0].participant.mood}</span> : null}
          </p>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground/90">
            {sides[0].lastPublic ? `「${sides[0].lastPublic.text.slice(0, 160)}」` : "尚未公开发言"}
          </p>
        </div>
      ) : null}
      <div className="flex items-center justify-center self-center text-[10px] font-bold tracking-widest text-muted-foreground/60">VS</div>
      {sides[1] ? (
        <div
          className="rounded-lg border border-sky-400/30 bg-sky-400/5 px-3 py-2 text-right"
        >
          <p className="flex items-center justify-end gap-1.5 text-xs font-semibold tracking-tight">
            {sides[1].participant.profile.displayName}
            {sides[1].participant.mood ? <span className="text-[10px] font-normal text-muted-foreground">· {sides[1].participant.mood}</span> : null}
            <SwordsIcon className="size-3 text-sky-400" />
          </p>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground/90">
            {sides[1].lastPublic ? `「${sides[1].lastPublic.text.slice(0, 160)}」` : "尚未公开发言"}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SwordsIcon({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" />
      <line x1="13" y1="19" x2="19" y2="13" />
      <line x1="16" y1="16" x2="20" y2="20" />
      <line x1="19" y1="21" x2="21" y2="19" />
    </svg>
  );
}

function TensionMeter({ tension }: { tension: RoomConnection["tension"] }): ReactNode {
  const score = tension?.score ?? 0;
  const level = tension?.level ?? "calm";
  const label = level === "climax" ? "高潮" : level === "tense" ? "紧张" : level === "warm" ? "升温" : "平静";
  return (
    <div className="hidden h-8 items-center gap-2 rounded-md border bg-card px-2.5 xl:flex" title={tension?.reasons.length ? tension.reasons.join(" · ") : "张力由真实事件推导"}>
      <Flame className="text-muted-foreground" />
      <div className="h-1 w-10 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground transition-all duration-700" style={{ width: `${Math.round(score * 100)}%` }} />
      </div>
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

function CueBanner({ cue, names, finished = false }: { cue: RoomConnection["cue"]; names: Map<string, string>; finished?: boolean }): ReactNode {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!cue) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), cue.maximumDurationMs);
    return () => clearTimeout(timer);
  }, [cue]);
  if (!cue || !visible) return null;
  // Once the world ends, only the finale-level cue (win / final misplay) may
  // stay on stage: a mid-game quest cue would contradict the settlement.
  if (finished && cue.priority < 11) return null;
  const focusNames = cue.focusAgentIds.map((id) => names.get(id) ?? id);
  return (
    <div key={cue.id} className="pointer-events-auto absolute inset-x-0 top-12 flex justify-center px-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="关闭此镜头字幕"
        onClick={() => setVisible(false)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setVisible(false); }}
        className="cue-enter flex max-w-xl cursor-pointer items-center gap-2.5 rounded-md border bg-popover px-4 py-2.5 shadow-xl">
        <Clapperboard className="shrink-0" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-4">{cue.title}</p>
          {cue.subtitle || focusNames.length ? (
            <p className="truncate text-[11px] leading-4 opacity-80">
              {[cue.subtitle, focusNames.length ? `焦点：${focusNames.join("、")}` : ""].filter(Boolean).join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActBar({ turn, total, finished }: { turn: number; total: number; finished: boolean }): ReactNode {
  return (
    <div className="flex items-center gap-1" aria-label={`第 ${turn} / ${total} 轮`}>
      {Array.from({ length: Math.max(1, total) }).map((_, index) => (
        <span
          key={index}
          className={cn(
            "h-1 rounded-full transition-all duration-500",
            finished || index < turn
              ? "w-5 bg-foreground/70"
              : index === turn
                ? "w-5 bg-foreground"
                : "w-2 bg-border"
          )}
        />
      ))}
    </div>
  );
}

function PaceControl({ pace, onChange }: { pace: 0.5 | 1 | 2 | 4; onChange: (pace: 0.5 | 1 | 2 | 4) => void }): ReactNode {
  const options: Array<0.5 | 1 | 2 | 4> = [0.5, 1, 2, 4];
  return (
    <div className="hidden items-center rounded-md border bg-card p-0.5 2xl:flex" title="播放节奏：只作用于观战动画与流式光标，不改变对局本身">
      {options.map((option) => (
        <Button
          key={option}
          variant={pace === option ? "secondary" : "ghost"}
          size="xs"
          onClick={() => onChange(option)}
        >
          {option}×
        </Button>
      ))}
    </div>
  );
}

function ShareButton({ roomId }: { roomId: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}#/rooms/${encodeURIComponent(roomId)}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable in some embedded contexts; ignore.
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={copied ? "已复制" : "复制房间链接"} onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "已复制" : "复制房间链接"}</TooltipContent>
    </Tooltip>
  );
}

function RoomHeaderSkeleton({ onBack }: { onBack: () => void }): ReactNode {
  return (
    <header className="flex h-16 items-center gap-3 border-b border-border px-6">
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-muted" onClick={onBack}>
        <ArrowLeft className="size-4" />
      </Button>
      <Skeleton className="size-9 rounded-lg" />
      <div className="space-y-1.5">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-3 w-24" />
      </div>
    </header>
  );
}
