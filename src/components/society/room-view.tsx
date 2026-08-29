import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Cast, Eye, Flag, Globe, Lock, Pause, Play, Radio, Share2, TriangleAlert } from "lucide-react";
import type { ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup
} from "@/components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CausalityPanel } from "./causality-panel";
import { CueBanner, EndgameOverlay, NightRevealBanner, StorylineBar, TensionMeter } from "./cinematics";
import { LiveStream } from "./live-stream";
import { ParticipantsRail, type ModelOption } from "./participants-rail";
import { useArchiveRoom, useRoom, type EffectiveViewer, type RoomConnection, type RoomStreamState, type RoomTension } from "./use-room";
import { ScenarioIcon } from "./shared";

type ViewerChoice = "public" | "omniscient" | "postgame";

/**
 * Live room: one SSE connection with an owner-promotable viewer seat.
 */
export function RoomView({ roomId, token, onBack }: {
  roomId: string;
  token?: string;
  onBack: () => void;
}): ReactNode {
  const [requestedMode, setRequestedMode] = useState<ViewerChoice>("public");

  // The owner seat is privileged: default it to the full live experience once.
  const [autoPromoted, setAutoPromoted] = useState(false);
  const viewerParam = useMemo<{ mode: ViewerChoice }>(() => ({ mode: requestedMode }), [requestedMode]);

  const connection = useRoom(roomId, token, viewerParam);
  const viewer = connection.viewer;

  // Promote privileged viewers to omniscient exactly once, after the server
  // reports what this connection may actually see.
  useEffect(() => {
    if (autoPromoted || !viewer?.privileged || viewer.mode !== "public") return;
    setAutoPromoted(true);
    setRequestedMode("omniscient");
  }, [viewer, autoPromoted]);

  return (
    <RoomShell
      connection={connection}
      requestedMode={requestedMode}
      onModeChange={setRequestedMode}
      onBack={onBack}
      interactive
      routePrefix="rooms"
      routeId={roomId}
    />
  );
}

/**
 * An archived, finished game: the same shell over a read-only connection —
 * no SSE, no controls; the reveal and the static replay come from the
 * archive file, so the full postgame experience survives a restart.
 */
export function ArchiveRoomView({ archiveId, onBack }: { archiveId: string; onBack: () => void }): ReactNode {
  const connection = useArchiveRoom(archiveId);
  return (
    <RoomShell
      connection={connection}
      requestedMode="postgame"
      onModeChange={() => undefined}
      onBack={onBack}
      interactive={false}
      routePrefix="archives"
      routeId={archiveId}
    />
  );
}

/**
 * Room shell: header + three columns. The center LiveStream is the product;
 * the rails answer "who are these people" and "why did it happen".
 */
function RoomShell({ connection, requestedMode, onModeChange, onBack, interactive, routePrefix, routeId }: {
  connection: RoomConnection;
  requestedMode: ViewerChoice;
  onModeChange: (mode: ViewerChoice) => void;
  onBack: () => void;
  /** Live rooms offer mode switching and controls; archives are read-only. */
  interactive: boolean;
  routePrefix: "rooms" | "archives";
  routeId: string;
}): ReactNode {
  const { room, viewer, connection: link, stream } = connection;

  const [scenarioCatalog, setScenarioCatalog] = useState<ScenarioSummary[]>([]);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    void apiCatalog()
      .then((catalog) => {
        if (cancelled) return;
        setScenarioCatalog(catalog.scenarios);
        setModelOptions(catalog.models);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const scenario = useMemo(
    () => scenarioCatalog.find((entry) => entry.id === room?.scenarioId),
    [scenarioCatalog, room?.scenarioId]
  );

  const avatarSeedFor = useMemo(() => {
    const seeds = new Map((room?.participants ?? []).map((participant) => [participant.profile.id, participant.profile.characterId]));
    return (actorId: string): string | undefined => seeds.get(actorId);
  }, [room?.participants]);

  const finished = room?.world.status === "finished" || room?.status === "finished";

  // The reveal screen owns the stage when a game ends; the viewer can always
  // drop into the transcript below, or bring the reveal back from the strip.
  const [endgameDismissed, setEndgameDismissed] = useState(false);
  const roomIdRef = useRef(room?.id);
  if (roomIdRef.current !== room?.id) {
    roomIdRef.current = room?.id;
    if (endgameDismissed) setEndgameDismissed(false);
  }

  if (!room) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background">
        <span className="size-7 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
        <p className={cn("text-sm text-muted-foreground", link === "reconnecting" && "animate-pulse")}>
          {connection.error ?? "连接房间中…"}
        </p>
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-3.5" aria-hidden />返回大厅</Button>
      </div>
    );
  }

  const world = room.world;
  const canControl = interactive && Boolean(viewer?.privileged);
  const paused = room.status === "paused";

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="rule-b flex h-14 shrink-0 items-center gap-2.5 bg-background px-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" onClick={onBack} aria-label="返回大厅">
              <ArrowLeft className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>返回大厅</TooltipContent>
        </Tooltip>
        <ScenarioIcon id={room.scenarioId} className="size-4 text-muted-foreground" />
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold leading-none tracking-tight">{room.title}</h1>
          <p className="mt-1.5 truncate text-[11px] leading-none text-muted-foreground">{world.summary}</p>
        </div>
        {scenario && scenario.name !== room.title ? <Badge variant="outline" className="hidden shrink-0 text-[10px] sm:inline-flex">{scenario.name}</Badge> : null}

        <div className="ml-auto flex items-center gap-1.5">
          {interactive ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="打开主播纯流窗口"
                  onClick={() => {
                    window.open(
                      `#/caster/${encodeURIComponent(routeId)}`,
                      "society-caster",
                      "popup=yes,width=640,height=960"
                    );
                  }}
                >
                  <Cast className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>弹出无剧透纯流窗口 — 直播采集用</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={interactive ? "分享观战链接" : "分享复盘链接"}
                onClick={() => {
                  const url = `${window.location.origin}${window.location.pathname}#/${routePrefix}/${encodeURIComponent(routeId)}`;
                  void navigator.clipboard?.writeText(url)
                    .then(() => toast(interactive ? "观战链接已复制——公开视角无需凭证" : "复盘链接已复制"))
                    .catch(() => toast.error("复制失败，请手动复制地址栏链接"));
                }}
              >
                <Share2 className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{interactive ? "复制观战链接" : "复制复盘链接"}</TooltipContent>
          </Tooltip>
          <ViewerBadge mode={viewer?.mode ?? "public"} privileged={viewer?.privileged === true} />
          {interactive && viewer?.privileged ? (
            <Select value={requestedMode} onValueChange={(value) => onModeChange(value as ViewerChoice)}>
              <SelectTrigger size="sm" className="w-28 text-xs" aria-label="切换视角">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="omniscient">全知直播</SelectItem>
                <SelectItem value="public">公开视角</SelectItem>
                {finished ? <SelectItem value="postgame">赛后复盘</SelectItem> : null}
              </SelectContent>
            </Select>
          ) : interactive && finished ? (
            // Postgame reveals the world to everyone once a game ends; minds
            // stay behind owner permission server-side. Anonymous spectators
            // get a plain toggle instead of the privileged seat's select.
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              aria-pressed={requestedMode === "postgame"}
              onClick={() => onModeChange(requestedMode === "postgame" ? "public" : "postgame")}
            >
              <Radio className="size-3.5" aria-hidden />
              {requestedMode === "postgame" ? "返回公开视角" : "赛后复盘"}
            </Button>
          ) : null}
          {canControl ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void (paused ? connection.resume() : connection.pause());
                toast(paused ? "对局已恢复" : "对局已暂停");
              }}
            >
              {paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
              {paused ? "继续" : "暂停"}
            </Button>
          ) : null}
        </div>
      </header>

      {/* Terminal rooms (finished/archived) have no live stream by design — a reconnect banner there is noise. */}
      {link !== "closed" && world.status !== "finished" && (link === "reconnecting" || connection.error) ? (
        <p className="flex shrink-0 items-center justify-center gap-1.5 bg-warn/10 px-4 py-1 text-center text-[11px] text-warn">
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          {connection.error ?? "连接中断，正在重连——快照会自愈。"}
        </p>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col md:hidden">
        <div className="min-h-0 flex-1">
          <CenterColumn
            room={room}
            stream={stream}
            viewer={viewer}
            finished={Boolean(finished)}
            endgameDismissed={endgameDismissed}
            onDismissEndgame={() => setEndgameDismissed(true)}
            onRevealEndgame={() => setEndgameDismissed(false)}
            avatarSeedFor={avatarSeedFor}
          />
        </div>
        <MobileRails
          room={room}
          viewerMode={viewer?.mode}
          viewerPrivileged={viewer?.privileged === true}
          onToggleAgentPause={viewer?.privileged ? connection.toggleAgentPause : undefined}
          models={modelOptions}
          onSwitchModel={viewer?.privileged ? connection.switchAgentModel : undefined}
        />
      </main>

      <main className="hidden min-h-0 flex-1 md:block">
        <ResizablePanelGroup orientation="horizontal" id="society-room-v2">
          <ResizablePanel defaultSize="16" minSize="11" maxSize="24">
            <ParticipantsRail
              room={room}
              viewerPrivileged={viewer?.privileged === true}
              onToggleAgentPause={viewer?.privileged ? connection.toggleAgentPause : undefined}
              models={modelOptions}
              onSwitchModel={viewer?.privileged ? connection.switchAgentModel : undefined}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="58" minSize="40">
            <CenterColumn
              room={room}
              stream={stream}
              viewer={viewer}
              finished={Boolean(finished)}
              endgameDismissed={endgameDismissed}
              onDismissEndgame={() => setEndgameDismissed(true)}
              onRevealEndgame={() => setEndgameDismissed(false)}
              onSubmitAction={room.player ? connection.submitAction : undefined}
              avatarSeedFor={avatarSeedFor}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="26" minSize="18" maxSize="36">
            <CausalityPanel room={room} viewerMode={viewer?.mode} viewerPrivileged={viewer?.privileged === true} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
    </div>
  );
}

async function apiCatalog(): Promise<{ scenarios: ScenarioSummary[]; models: ModelOption[] }> {
  const response = await fetch("/api/scenarios");
  if (!response.ok) return { scenarios: [], models: [] };
  const payload = await response.json() as { scenarios?: ScenarioSummary[]; models?: ModelOption[] };
  return { scenarios: payload.scenarios ?? [], models: payload.models ?? [] };
}

/**
 * The product column: phase HUD on top, the live stream as the body, with the
 * director's cue banner floating over it — and, when a game ends, the reveal
 * screen taking the stage above the transcript. Shared by the live room and
 * the caster broadcast surface.
 */
export function CenterColumn({ room, stream, viewer, finished, endgameDismissed, onDismissEndgame, onRevealEndgame, onSubmitAction, avatarSeedFor }: {
  room: SocietyRoomSnapshot;
  stream: RoomStreamState;
  viewer: EffectiveViewer | null;
  finished: boolean;
  endgameDismissed: boolean;
  onDismissEndgame: () => void;
  onRevealEndgame: () => void;
  onSubmitAction?: RoomConnection["submitAction"];
  avatarSeedFor: (actorId: string) => string | undefined;
}): ReactNode {
  const names = useMemo(
    () => new Map(room.world.agents.map((agent) => [agent.id, agent.displayName])),
    [room.world.agents]
  );
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <PhaseStrip
        room={room}
        sealed={stream.turns.some((turn) => !turn.completedAt && turn.sealed)}
        tension={stream.tension}
        finished={finished}
        onRevealEndgame={onRevealEndgame}
      />
      <StorylineBar world={room.world} />
      <div className="relative min-h-0 flex-1">
        <LiveStream
          room={room}
          turns={stream.turns}
          viewer={viewer}
          onSubmitAction={onSubmitAction}
          avatarSeedFor={avatarSeedFor}
        />
        {!finished ? (
          <>
            <NightRevealBanner world={room.world} />
            <CueBanner cue={stream.cue} names={names} />
          </>
        ) : null}
        {finished && !endgameDismissed ? (
          <EndgameOverlay room={room} avatarSeedFor={avatarSeedFor} onDismiss={onDismissEndgame} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Narrow screens cannot fit the three-column shell: the rails collapse into
 * two toggleable drawers under the stream instead of being unreachable.
 */
function MobileRails({ room, viewerMode, viewerPrivileged, onToggleAgentPause, models, onSwitchModel }: {
  room: SocietyRoomSnapshot;
  viewerMode: string | undefined;
  viewerPrivileged: boolean;
  onToggleAgentPause?: RoomConnection["toggleAgentPause"];
  models: ModelOption[];
  onSwitchModel?: RoomConnection["switchAgentModel"];
}): ReactNode {
  const [tab, setTab] = useState<"none" | "people" | "causality">("none");
  return (
    <div className="shrink-0 border-t border-border bg-background">
      <div className="grid grid-cols-2 gap-1.5 p-1.5">
        <Button
          variant="outline"
          size="sm"
          aria-pressed={tab === "people"}
          className={cn("rounded-lg", tab === "people" && "border-foreground/40 bg-muted text-foreground")}
          onClick={() => setTab((current) => (current === "people" ? "none" : "people"))}
        >
          参与者
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={tab === "causality"}
          className={cn("rounded-lg", tab === "causality" && "border-foreground/40 bg-muted text-foreground")}
          onClick={() => setTab((current) => (current === "causality" ? "none" : "causality"))}
        >
          因果
        </Button>
      </div>
      {tab !== "none" ? (
        <div className="h-[46vh] border-t border-border">
          {tab === "people" ? (
            <ParticipantsRail
              room={room}
              viewerPrivileged={viewerPrivileged}
              onToggleAgentPause={onToggleAgentPause}
              models={models}
              onSwitchModel={onSwitchModel}
            />
          ) : (
            <CausalityPanel room={room} viewerMode={viewerMode} viewerPrivileged={viewerPrivileged} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The boundary actually granted by the server — never the one requested. */
function ViewerBadge({ mode, privileged }: { mode: string; privileged: boolean }): ReactNode {
  const labels: Record<string, { label: string; icon: ReactNode }> = {
    omniscient: { label: "全知直播", icon: <Eye className="size-3" aria-hidden /> },
    "agent-pov": { label: "Agent 视角", icon: <Eye className="size-3" aria-hidden /> },
    postgame: { label: "赛后复盘", icon: <Radio className="size-3" aria-hidden /> },
    public: { label: "公开视角", icon: <Globe className="size-3" aria-hidden /> }
  };
  const entry = labels[mode] ?? labels.public;
  return (
    <Badge variant={privileged ? "secondary" : "outline"} className="gap-1 text-[10px]">
      {entry.icon}{entry.label}
    </Badge>
  );
}

/** One-line phase strip: game state on the left, the tension HUD on the right. */
function PhaseStrip({ room, sealed, tension, finished, onRevealEndgame }: {
  room: SocietyRoomSnapshot;
  sealed: boolean;
  tension: RoomTension | null;
  finished: boolean;
  onRevealEndgame: () => void;
}): ReactNode {
  const world = room.world;
  const speakingAgents = world.agents.filter((agent) => agent.status === "speaking" || agent.status === "thinking" || agent.status === "acting");
  const progress = world.totalTurns > 0 ? Math.min(100, Math.round((world.turn / world.totalTurns) * 100)) : 0;
  return (
    <div className="rule-b flex h-10 shrink-0 items-center gap-2.5 overflow-hidden bg-transparent px-5">
      <span className="nums flex shrink-0 items-center gap-2 font-mono text-[11px] tracking-wide text-muted-foreground">
        R{world.turn}
        <span className="relative inline-block h-1.5 w-16 overflow-hidden rounded-full bg-foreground/10 align-middle">
          <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/60 transition-[width] duration-700 ease-out" style={{ width: `${progress}%` }} />
        </span>
        <span className="text-muted-foreground/50">{world.totalTurns}</span>
      </span>
      <Badge variant="outline" className="shrink-0 rounded-full border-border/70 bg-transparent font-normal text-muted-foreground">{world.phase}</Badge>
      {finished ? (
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 gap-1.5 rounded-full border-warn/30 bg-warn/10 px-2 text-[10px] font-normal text-warn hover:bg-warn/20 hover:text-warn"
          onClick={onRevealEndgame}
        >
          <Flag className="size-3" aria-hidden />
          终局揭晓
        </Button>
      ) : room.status === "paused" ? (
        <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-[10px] text-warn">
          <Pause className="size-3" aria-hidden />
          对局已暂停
        </span>
      ) : sealed ? (
        <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-secret/30 bg-secret/10 px-2 py-0.5 text-[10px] text-secret"><Lock className="size-3" aria-hidden />密封阶段 · 发言流暂停公开</span>
      ) : speakingAgents.length ? (
        <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-live">
          <span className="eq shrink-0" aria-hidden><span /><span /><span /></span>
          <span className="truncate">{speakingAgents.map((agent) => agent.displayName).join("、")} 直播中</span>
        </span>
      ) : (
        <span className="shrink-0 text-[10px] text-muted-foreground">等待下一个行动者…</span>
      )}
      {!finished ? <span className="ml-auto flex shrink-0 items-center"><TensionMeter tension={tension} /></span> : null}
    </div>
  );
}
