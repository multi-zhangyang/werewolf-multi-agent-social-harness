import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Eye, Globe, Pause, Play, Radio } from "lucide-react";
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
import { LiveStream } from "./live-stream";
import { ParticipantsRail } from "./participants-rail";
import { useRoom, type RoomConnection } from "./use-room";
import { ScenarioIcon } from "./shared";

type ViewerChoice = "public" | "omniscient";

/**
 * Room shell: header + three columns. The center LiveStream is the product;
 * the rails answer "who are these people" and "why did it happen".
 */
export function RoomView({ roomId, token, onBack }: {
  roomId: string;
  token?: string;
  onBack: () => void;
}): ReactNode {
  const [requestedMode, setRequestedMode] = useState<ViewerChoice>("public");
  const [scenarioCatalog, setScenarioCatalog] = useState<ScenarioSummary[]>([]);

  // The owner seat is privileged: default it to the full live experience once.
  const [autoPromoted, setAutoPromoted] = useState(false);
  const viewerParam = useMemo<{ mode: ViewerChoice }>(() => ({ mode: requestedMode }), [requestedMode]);

  const connection = useRoom(roomId, token, viewerParam);
  const { room, viewer, connection: link, stream } = connection;

  useEffect(() => {
    let cancelled = false;
    void apiCatalog()
      .then((scenarios) => { if (!cancelled) setScenarioCatalog(scenarios); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // Promote privileged viewers to omniscient exactly once, after the server
  // reports what this connection may actually see.
  useEffect(() => {
    if (autoPromoted || !viewer?.privileged || viewer.mode !== "public") return;
    setAutoPromoted(true);
    setRequestedMode("omniscient");
  }, [viewer, autoPromoted]);

  const scenario = useMemo(
    () => scenarioCatalog.find((entry) => entry.id === room?.scenarioId),
    [scenarioCatalog, room?.scenarioId]
  );

  const avatarSeedFor = useMemo(() => {
    const seeds = new Map((room?.participants ?? []).map((participant) => [participant.profile.id, participant.profile.characterId]));
    return (actorId: string): string | undefined => seeds.get(actorId);
  }, [room?.participants]);

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
  const canControl = Boolean(viewer?.privileged);
  const paused = room.status === "paused";

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
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
          <h1 className="truncate text-sm font-semibold leading-none">{room.title}</h1>
          <p className="mt-1 truncate text-[11px] leading-none text-muted-foreground">{world.summary}</p>
        </div>
        {scenario ? <Badge variant="outline" className="hidden shrink-0 text-[10px] sm:inline-flex">{scenario.name}</Badge> : null}

        <div className="ml-auto flex items-center gap-1.5">
          <ViewerBadge mode={viewer?.mode ?? "public"} privileged={viewer?.privileged === true} />
          {viewer?.privileged ? (
            <Select value={requestedMode} onValueChange={(value) => setRequestedMode(value as ViewerChoice)}>
              <SelectTrigger size="sm" className="w-28 text-xs" aria-label="切换视角">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="omniscient">全知直播</SelectItem>
                <SelectItem value="public">公开视角</SelectItem>
              </SelectContent>
            </Select>
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

      {link === "reconnecting" ? (
        <p className="shrink-0 bg-amber-500/10 px-4 py-1 text-center text-[11px] text-amber-300">连接中断，正在重连——快照会自愈。</p>
      ) : null}

      <main className="flex min-h-0 flex-1 flex-col md:hidden">
        <div className="min-h-0 flex-1">
          <LiveStream room={room} turns={stream.turns} viewer={viewer} avatarSeedFor={avatarSeedFor} />
        </div>
        <MobileRails
          room={room}
          viewerMode={viewer?.mode}
          viewerPrivileged={viewer?.privileged === true}
          onToggleAgentPause={viewer?.privileged ? connection.toggleAgentPause : undefined}
        />
      </main>

      <main className="hidden min-h-0 flex-1 md:block">
        <ResizablePanelGroup orientation="horizontal" id="society-room-v2">
          <ResizablePanel defaultSize={17} minSize={11} maxSize={26}>
            <ParticipantsRail
              room={room}
              viewerPrivileged={viewer?.privileged === true}
              onToggleAgentPause={viewer?.privileged ? connection.toggleAgentPause : undefined}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={57} minSize={40}>
            <div className="flex h-full min-h-0 flex-col">
              <PhaseStrip room={room} sealed={stream.turns.some((turn) => !turn.completedAt && turn.sealed)} />
              <LiveStream
                room={room}
                turns={stream.turns}
                viewer={viewer}
                onSubmitAction={room.player ? connection.submitAction : undefined}
                avatarSeedFor={avatarSeedFor}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={26} minSize={18} maxSize={36}>
            <CausalityPanel room={room} viewerMode={viewer?.mode} viewerPrivileged={viewer?.privileged === true} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
    </div>
  );
}

async function apiCatalog(): Promise<ScenarioSummary[]> {
  const response = await fetch("/api/scenarios");
  if (!response.ok) return [];
  const payload = await response.json() as { scenarios?: ScenarioSummary[] };
  return payload.scenarios ?? [];
}

/**
 * Narrow screens cannot fit the three-column shell: the rails collapse into
 * two toggleable drawers under the stream instead of being unreachable.
 */
function MobileRails({ room, viewerMode, viewerPrivileged, onToggleAgentPause }: {
  room: SocietyRoomSnapshot;
  viewerMode: string | undefined;
  viewerPrivileged: boolean;
  onToggleAgentPause?: RoomConnection["toggleAgentPause"];
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
            <ParticipantsRail room={room} viewerPrivileged={viewerPrivileged} onToggleAgentPause={onToggleAgentPause} />
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

/** One-line phase strip replacing the old arena stage. */
function PhaseStrip({ room, sealed }: { room: SocietyRoomSnapshot; sealed: boolean }): ReactNode {
  const world = room.world;
  const speakingAgents = world.agents.filter((agent) => agent.status === "speaking" || agent.status === "thinking" || agent.status === "acting");
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-card/30 px-4">
      <span className="nums shrink-0 font-mono text-[11px] text-muted-foreground">R{world.turn}/{world.totalTurns}</span>
      <Badge variant="outline" className="shrink-0 text-[10px]">{world.phase}</Badge>
      {sealed ? (
        <span className="shrink-0 text-[10px] text-violet-300">🔒 密封阶段 · 发言流暂停公开</span>
      ) : speakingAgents.length ? (
        <span className="flex min-w-0 items-center gap-1 text-[10px] text-emerald-300">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" aria-hidden />
          <span className="truncate">{speakingAgents.map((agent) => agent.displayName).join("、")} 直播中</span>
        </span>
      ) : (
        <span className="shrink-0 text-[10px] text-muted-foreground">等待下一个行动者…</span>
      )}
    </div>
  );
}
