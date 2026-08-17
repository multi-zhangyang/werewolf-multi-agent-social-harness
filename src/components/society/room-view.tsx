import { useState, type ReactNode } from "react";
import { ArrowLeft, Check, Copy, Pause, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Conversation } from "./conversation";
import { ParticipantsRail } from "./participants";
import { ScenarioIcon, StatusDot, StatusLabel } from "./shared";
import { useRoom } from "./use-room";
import { WorldPanel } from "./world-panel";

interface RoomViewProps {
  roomId: string;
  token?: string;
  onBack: () => void;
  onReplay?: () => void;
}

export function RoomView({ roomId, token, onBack, onReplay }: RoomViewProps): ReactNode {
  const { room, connection, error, activity, toolCalls, pause, submitAction } = useRoom(roomId, token);

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
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-20 border-b border-border/80 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center gap-3 px-6">
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

          <div className="ml-auto flex items-center gap-2">
            <div className="hidden items-center gap-3 rounded-full border border-border bg-card px-4 py-1.5 md:flex">
              <span className={cn("size-1.5 rounded-full", room.world.status === "finished" ? "bg-muted-foreground/40" : "bg-emerald-400")} />
              <span className="text-xs font-medium text-foreground/90">{room.world.phase}</span>
              <span className="nums font-mono text-[11px] text-muted-foreground">
                {room.world.turn} / {room.world.totalTurns}
              </span>
              <ActBar turn={room.world.turn} total={room.world.totalTurns} finished={room.world.status === "finished"} />
            </div>
            <ShareButton roomId={room.id} />
            {room.status === "running" ? (
              <Button variant="outline" size="sm" aria-label="暂停房间" className="rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void pause()}>
                <Pause className="size-3.5" />
                暂停
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1440px] flex-1 grid-cols-1 gap-5 px-6 py-5 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
        <aside className="order-2 lg:order-1 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <div className="mb-3 flex items-center justify-between px-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">参与者</p>
            <span className="nums font-mono text-[11px] text-muted-foreground">{room.participants.length}P</span>
          </div>
          <ParticipantsRail participants={room.participants} humanActorId={room.player?.actorId} />
        </aside>

        <main className="order-1 min-h-[72vh] overflow-hidden rounded-xl border border-border bg-card/40 lg:order-2 lg:min-h-0 lg:max-h-[calc(100vh-6rem)]">
          <Conversation room={room} activity={activity} onAction={submitAction} onReplay={onReplay} />
        </main>

        <aside className="order-3 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <WorldPanel room={room} toolCalls={toolCalls} />
        </aside>
      </div>

      {error ? (
        <div className="fixed inset-x-0 bottom-4 z-30 mx-auto w-fit rounded-full border border-red-400/30 bg-card px-5 py-2 text-xs text-red-400 shadow-lg">
          {error}
        </div>
      ) : null}
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