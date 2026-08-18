import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Copy, Clapperboard, Flame, Pause, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Conversation } from "./conversation";
import { ParticipantsRail } from "./participants";
import { AgentPresence, ScenarioIcon, StatusDot, StatusLabel } from "./shared";
import { useRoom, type RoomConnection } from "./use-room";
import { WorldPanel } from "./world-panel";

interface RoomViewProps {
  roomId: string;
  token?: string;
  onBack: () => void;
  onReplay?: () => void;
}

export function RoomView({ roomId, token, onBack, onReplay }: RoomViewProps): ReactNode {
  const [viewerMode, setViewerMode] = useState<"public" | "omniscient" | "agent-pov" | "postgame">(token ? "public" : "omniscient");
  const [povAgentId, setPovAgentId] = useState<string>();
  const [stageView, setStageView] = useState<"arena" | "analysis">("arena");
  const [pace, setPace] = useState<0.5 | 1 | 2 | 4>(1);
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

  if (!room) {
    return (
      <div className="flex min-h-screen flex-col">
        <RoomHeaderSkeleton onBack={onBack} />
        <div className="mx-auto grid w-full max-w-[1440px] flex-1 grid-cols-1 gap-5 px-6 py-8 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
          <div className="space-y-3"><Skeleton className="h-24 rounded-lg" /><Skeleton className="h-24 rounded-lg" /></div>
          <div className="space-y-3"><Skeleton className="h-32 rounded-lg" /><Skeleton className="h-80 rounded-lg" /></div>
          <div className="space-y-3"><Skeleton className="h-32 rounded-lg" /><Skeleton className="h-64 rounded-lg" /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background" style={{ "--pace": String(pace) } as React.CSSProperties}>
      <header className="sticky top-0 z-20 border-b border-border/80 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex min-h-16 w-full max-w-[1440px] flex-wrap items-center gap-3 gap-y-2 px-6 py-2">
          <Button variant="ghost" size="icon-sm" aria-label="返回" className="text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <ScenarioIcon id={room.scenarioId} className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold tracking-tight">{room.title}</p>
              {room.mode === "human" ? (
                <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground">真人模式</span>
              ) : null}
              {room.seasonMode === "one-shot" ? (
                <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">单局模式</span>
              ) : null}
            </div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <StatusDot status={room.status} />
              <StatusLabel status={room.status} />
              {connection === "reconnecting" ? (
                <span className="ml-1 flex items-center gap-1 text-amber-400">
                  <RefreshCw className="size-3 animate-spin" />
                  重连中
                </span>
              ) : null}
            </p>
          </div>

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <ViewModeSwitcher
              mode={viewerMode}
              isPlayer={Boolean(token)}
              finished={room.status === "finished"}
              onChange={setViewerMode}
            />
            {viewerMode === "agent-pov" && !token ? (
              <select
                value={povAgentId ?? ""}
                onChange={(event) => setPovAgentId(event.target.value)}
                className="h-8 rounded-lg border border-border bg-card px-2 font-mono text-[11px] text-muted-foreground"
                aria-label="跟随的参与者"
              >
                <option value="">选择跟随的参与者…</option>
                {room.participants.map((participant) => (
                  <option key={participant.profile.id} value={participant.profile.id}>{participant.profile.displayName}</option>
                ))}
              </select>
            ) : null}
            <TensionMeter tension={tension} />
            <div className="hidden items-center gap-3 rounded-full border border-border bg-card px-4 py-1.5 md:flex">
              <span className={cn("size-1.5 rounded-full", room.world.status === "finished" ? "bg-muted-foreground/40" : "bg-emerald-400")} />
              <span className="text-xs font-medium text-foreground/90">{room.world.phase}</span>
              <span className="nums font-mono text-[11px] text-muted-foreground">
                {room.world.turn} / {room.world.totalTurns}
              </span>
              <ActBar turn={room.world.turn} total={room.world.totalTurns} finished={room.world.status === "finished"} />
            </div>
            <PaceControl pace={pace} onChange={setPace} />
            <ShareButton roomId={room.id} />
            {room.status === "running" ? (
              <Button variant="outline" size="sm" aria-label="暂停房间" className="rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void pause()}>
                <Pause className="size-3.5" />
                暂停
              </Button>
            ) : null}
            {room.status === "paused" ? (
              <Button variant="outline" size="sm" aria-label="恢复房间" className="rounded-lg border-amber-400/40 bg-amber-400/10 text-amber-300 hover:bg-amber-400/15 hover:text-amber-200" onClick={() => void resume()}>
                <RefreshCw className="size-3.5" />
                恢复
              </Button>
            ) : null}
            <ViewToggle view={stageView} onChange={setStageView} />
          </div>
        </div>
      </header>

      {stageView === "arena" ? (
        <div className="mx-auto w-full max-w-4xl flex-1 space-y-4 px-6 py-5">
          <ArenaStage room={room} cue={cue} activity={activity} />
          <main className="relative min-h-[56vh] overflow-hidden rounded-xl border border-border bg-card/40">
            <CueBanner cue={cue} finished={room.world.status === "finished"} names={new Map(room.participants.map((participant) => [participant.profile.id, participant.profile.displayName]))} />
            <Conversation room={room} activity={activity} onAction={submitAction} onReplay={onReplay} />
          </main>
          <WorldPanel room={room} toolCalls={toolCalls} timeline={timeline} />
        </div>
      ) : (
      <div className="mx-auto grid w-full max-w-[1440px] flex-1 grid-cols-1 gap-5 px-6 py-5 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
        <aside className="order-2 lg:order-1 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <div className="mb-3 flex items-center justify-between px-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">参与者</p>
            <span className="nums font-mono text-[11px] text-muted-foreground">{room.participants.length}P</span>
          </div>
          <ParticipantsRail
            participants={room.participants}
            humanActorId={room.player?.actorId}
            activity={activity}
            roomPaused={room.status === "paused"}
            roomId={room.id}
            onToggleAgentPause={(actorId, paused) => { void toggleAgentPause(actorId, paused); }}
          />
        </aside>

        <main className="relative order-1 min-h-[72vh] overflow-hidden rounded-xl border border-border bg-card/40 lg:order-2 lg:min-h-0 lg:max-h-[calc(100vh-6rem)]">
          <CueBanner cue={cue} finished={room.world.status === "finished"} names={new Map(room.participants.map((participant) => [participant.profile.id, participant.profile.displayName]))} />
          <Conversation room={room} activity={activity} onAction={submitAction} onReplay={onReplay} />
        </main>

        <aside className="order-3 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <WorldPanel room={room} toolCalls={toolCalls} timeline={timeline} />
        </aside>
      </div>
      )}

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
    <div className="flex items-center rounded-full border border-border bg-card p-0.5">
      {options.map((option) => (
        <Tooltip key={option.value}>
          <TooltipTrigger asChild>
            <button
              disabled={option.disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                mode === option.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          </TooltipTrigger>
          <TooltipContent>{option.hint}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: "arena" | "analysis"; onChange: (view: "arena" | "analysis") => void }): ReactNode {
  return (
    <div className="flex items-center rounded-full border border-border bg-card p-0.5" title="舞台优先；分析视图保留完整三栏">
      <button
        onClick={() => onChange("arena")}
        className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors", view === "arena" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
      >
        舞台
      </button>
      <button
        onClick={() => onChange("analysis")}
        className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors", view === "analysis" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
      >
        分析
      </button>
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
  const names = new Map(room.participants.map((participant) => [participant.profile.id, participant.profile.displayName]));
  return (
    <section className="rounded-xl border border-border bg-card/40 px-4 py-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-foreground/65">舞台席位</p>
        <span className="nums font-mono text-[11px] text-muted-foreground">{room.participants.filter((participant) => participant.alive).length} 人存活</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {room.participants.map((participant, index) => {
          const state = activity[participant.profile.id];
          const speaking = participant.status === "speaking" || participant.status === "acting";
          const focused = focusIds.has(participant.profile.id);
          const dead = !participant.alive;
          return (
            <div
              key={participant.profile.id}
              className={cn(
                "relative flex flex-col items-center rounded-lg border px-2 py-2.5 transition-all",
                dead ? "border-border/50 opacity-45" : "border-border bg-card",
                speaking && "border-emerald-400/50",
                focused && "ring-2 ring-amber-400/60"
              )}
            >
              {focused ? (
                <span className="absolute -top-2 rounded-full border border-amber-400/50 bg-card px-1.5 py-px text-[9px] font-medium text-amber-300">焦点</span>
              ) : null}
              <AgentPresence name={participant.profile.displayName} index={index} size="xl" status={dead ? "finished" : participant.status} />
              <p className="mt-1.5 max-w-full truncate text-xs font-semibold tracking-tight">{participant.profile.displayName}</p>
              <p className="flex max-w-full items-center gap-1 text-[10px] text-foreground/60">
                <StatusDot status={dead ? "finished" : participant.status} />
                <span className="truncate">{participant.role ?? participant.mood ?? "—"}</span>
              </p>
              {state?.thought ? (
                <p className="mt-1 line-clamp-1 w-full text-center text-[10px] leading-4 text-muted-foreground/70" title={state.thought.text}>
                  {state.thought.title}：{state.thought.text}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <DuelStrip room={room} cue={cue} names={names} />
    </section>
  );
}

/**
 * Direct-conflict presentation (§8.8): when the director derives a duel cue
 * from real accusation facts, the stage shows the two sides head-to-head with
 * their latest public statements — derived from the room's own speech, never
 * fabricated. The wide stage and banner remain the default elsewhere.
 */
function DuelStrip({ room, cue, names }: {
  room: SocietyRoomSnapshot;
  cue: RoomConnection["cue"];
  names: Map<string, string>;
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
      {sides.map((side, index) => (
        <div
          key={side.id}
          className={cn(
            "rounded-lg border px-3 py-2",
            index === 0 ? "border-red-400/30 bg-red-400/5 text-left" : "border-sky-400/30 bg-sky-400/5 text-right"
          )}
        >
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-tight">
            {index === 0 ? <SwordsIcon className="size-3 text-red-400" /> : null}
            {side.participant.profile.displayName}
            {side.participant.mood ? <span className="text-[10px] font-normal text-muted-foreground">· {side.participant.mood}</span> : null}
            {index === 1 ? <SwordsIcon className="size-3 text-sky-400" /> : null}
          </p>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground/90">
            {side.lastPublic ? `「${side.lastPublic.text.slice(0, 160)}」` : "尚未公开发言"}
          </p>
        </div>
      ))}
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
  const tone = level === "climax" ? "text-red-400" : level === "tense" ? "text-orange-400" : level === "warm" ? "text-amber-400" : "text-muted-foreground";
  const bar = level === "climax" ? "bg-red-400" : level === "tense" ? "bg-orange-400" : level === "warm" ? "bg-amber-400" : "bg-muted-foreground/40";
  const label = level === "climax" ? "高潮" : level === "tense" ? "紧张" : level === "warm" ? "升温" : "平静";
  return (
    <div className="hidden items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 md:flex" title={tension?.reasons.length ? tension.reasons.join(" · ") : "张力由真实事件推导"}>
      <Flame className={cn("size-3.5", tone)} />
      <div className="h-1 w-14 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all duration-700", bar)} style={{ width: `${Math.round(score * 100)}%` }} />
      </div>
      <span className={cn("text-[11px] font-medium", tone)}>{label}</span>
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
  const tone = cue.priority >= 9
    ? "border-red-400/40 bg-red-400/10 text-red-200"
    : cue.priority >= 7
      ? "border-orange-400/40 bg-orange-400/10 text-orange-200"
      : cue.priority >= 5
        ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
        : "border-border bg-card/90 text-foreground";
  return (
    <div key={cue.id} className="pointer-events-auto absolute inset-x-0 top-12 z-10 flex justify-center px-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="关闭此镜头字幕"
        onClick={() => setVisible(false)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setVisible(false); }}
        className={cn("cue-enter flex max-w-xl cursor-pointer items-center gap-2.5 rounded-xl border px-4 py-2.5 shadow-lg backdrop-blur", tone)}>
        <Clapperboard className="size-4 shrink-0" />
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
                ? "w-5 bg-emerald-400"
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
    <div className="hidden items-center rounded-full border border-border bg-card p-0.5 md:flex" title="播放节奏：只作用于观战动画与流式光标，不改变对局本身">
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          className={cn(
            "rounded-full px-2 py-1 font-mono text-[10px] transition-colors",
            pace === option ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option}×
        </button>
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
        <Button variant="outline" size="icon-sm" aria-label={copied ? "已复制" : "复制房间链接"} className="rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void copy()}>
          {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
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