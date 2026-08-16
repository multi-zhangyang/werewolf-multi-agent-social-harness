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
}

export function RoomView({ roomId, token, onBack }: RoomViewProps): ReactNode {
  const { room, connection, error, activity, toolCalls, pause, submitAction } = useRoom(roomId, token);

  if (!room) {
    return (
      <div className="flex min-h-screen flex-col">
        <RoomHeaderSkeleton onBack={onBack} />
        <div className="mx-auto grid w-full max-w-[1440px] flex-1 grid-cols-1 gap-5 px-6 py-8 lg:grid-cols-[264px_minmax(0,1fr)_340px]">
          <div className="space-y-3"><Skeleton className="h-24 rounded-lg" /><Skeleton className="h-24 rounded-lg" /></div>
          <div className="space-y-3"><Skeleton className="h-32 rounded-lg" /><Skeleton className="h-80 rounded-lg" /></div>
          <div className="space-y-3"><Skeleton className="h-32 rounded-lg" /><Skeleton className="h-64 rounded-lg" /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center gap-3 px-6">
          <Button variant="ghost" size="icon-sm" aria-label="返回" className="text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <span className="flex size-9 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-600">
            <ScenarioIcon id={room.scenarioId} className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold tracking-tight">{room.title}</p>
              {room.mode === "human" ? (
                <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-500">真人模式</span>
              ) : null}
            </div>
            <p className="flex items-center gap-2 text-xs text-zinc-400">
              <StatusDot status={room.status} />
              <StatusLabel status={room.status} />
              {connection === "reconnecting" ? (
                <span className="ml-1 flex items-center gap-1 text-amber-600">
                  <RefreshCw className="size-3 animate-spin" />
                  重连中
                </span>
              ) : null}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-4 py-1.5 md:flex">
              <span className={cn("size-1.5 rounded-full", room.world.status === "finished" ? "bg-zinc-400" : "bg-emerald-500")} />
              <span className="text-xs font-medium text-zinc-600">{room.world.phase}</span>
            </div>
            <ActBar room={room} />
            <ShareButton roomId={room.id} />
            {room.status === "running" ? (
              <Button variant="outline" size="sm" aria-label="暂停房间" className="rounded-lg border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900" onClick={() => void pause()}>
                <Pause className="size-3.5" />
                暂停
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-fit items-center gap-2 pt-4">
        <div className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-1.5 text-xs text-zinc-400">
          <span className="live-pulse size-1.5 rounded-full bg-emerald-500" />
          观察模式 · 身份已隐藏，智能体不知道你的存在
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-[1440px] flex-1 grid-cols-1 gap-5 px-6 py-5 lg:grid-cols-[264px_minmax(0,1fr)_340px]">
        <aside className="order-2 lg:order-1 lg:max-h-[calc(100vh-9rem)] lg:overflow-y-auto">
          <div className="mb-3 flex items-center justify-between px-1">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">参与者</p>
            <span className="nums font-mono text-[11px] text-zinc-400">{room.participants.length}P</span>
          </div>
          <ParticipantsRail participants={room.participants} humanActorId={room.player?.actorId} />
        </aside>

        <main className="order-1 min-h-[72vh] overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/40 lg:order-2 lg:min-h-0 lg:max-h-[calc(100vh-9rem)]">
          <Conversation room={room} activity={activity} onAction={submitAction} />
        </main>

        <aside className="order-3 lg:max-h-[calc(100vh-9rem)] lg:overflow-y-auto">
          <WorldPanel room={room} toolCalls={toolCalls} />
        </aside>
      </div>

      {error ? (
        <div className="fixed inset-x-0 bottom-4 z-30 mx-auto w-fit rounded-full border border-red-200 bg-white px-5 py-2 text-xs text-red-600 shadow-lg">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function ActBar({ room }: { room: NonNullable<ReturnType<typeof useRoom>["room"]> }): ReactNode {
  const turn = room.world.turn;
  const total = room.world.totalTurns;
  return (
    <div className="hidden items-center gap-1 sm:flex" aria-label={`第 ${turn} / ${total} 轮`}>
      {Array.from({ length: Math.max(1, total) }).map((_, index) => (
        <span
          key={index}
          className={cn(
            "h-1 rounded-full transition-all duration-500",
            room.world.status === "finished" || index < turn
              ? "w-5 bg-zinc-700"
              : index === turn
                ? "w-5 bg-emerald-500"
                : "w-2 bg-zinc-200"
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
        <Button variant="outline" size="icon-sm" aria-label={copied ? "已复制" : "复制房间链接"} className="rounded-lg border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900" onClick={() => void copy()}>
          {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "已复制" : "复制房间链接"}</TooltipContent>
    </Tooltip>
  );
}

function RoomHeaderSkeleton({ onBack }: { onBack: () => void }): ReactNode {
  return (
    <header className="flex h-16 items-center gap-3 border-b border-zinc-200 px-6">
      <Button variant="ghost" size="icon-sm" className="text-zinc-400 hover:bg-zinc-100" onClick={onBack}>
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
