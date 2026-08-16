import type { ReactNode } from "react";
import { ArrowLeft, Pause, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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
        <div className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-6 px-6 py-8 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
          <div className="space-y-3"><Skeleton className="h-24 rounded-2xl" /><Skeleton className="h-24 rounded-2xl" /></div>
          <div className="space-y-3"><Skeleton className="h-32 rounded-2xl" /><Skeleton className="h-80 rounded-2xl" /></div>
          <div className="space-y-3"><Skeleton className="h-32 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-[#0a0a0a]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-6">
          <Button variant="ghost" size="icon-sm" className="text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          <span className="flex size-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-200">
            <ScenarioIcon id={room.scenarioId} className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold tracking-tight text-zinc-100">{room.title}</p>
              {room.mode === "human" ? (
                <span className="rounded-full border border-zinc-400/20 bg-zinc-400/10 px-2 py-0.5 text-[10px] font-medium text-zinc-300">真人模式</span>
              ) : null}
            </div>
            <p className="flex items-center gap-2 text-xs text-zinc-500">
              <StatusDot status={room.status} />
              <StatusLabel status={room.status} />
              {connection === "reconnecting" ? (
                <span className="ml-1 flex items-center gap-1 text-amber-400/80">
                  <RefreshCw className="size-3 animate-spin" />
                  重连中
                </span>
              ) : null}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.02] px-4 py-1.5 sm:flex">
              <span className={cn("size-1.5 rounded-full", room.world.status === "finished" ? "bg-zinc-500" : "bg-emerald-400")} />
              <span className="font-mono text-xs text-zinc-400">{room.world.phase}</span>
            </div>
            <div className="hidden items-center rounded-full border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 font-mono text-xs text-zinc-400 md:flex">
              R{room.world.turn}/{room.world.totalTurns}
            </div>
            {room.status === "running" ? (
              <Button variant="outline" size="sm" className="rounded-full border-white/10 bg-white/[0.02] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200" onClick={() => void pause()}>
                <Pause className="size-3.5" />
                暂停
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        <aside className="order-2 lg:order-1 lg:max-h-[calc(100vh-5.5rem)] lg:overflow-y-auto">
          <div className="mb-3 flex items-center justify-between px-1">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">参与者</p>
            <span className="font-mono text-[11px] text-zinc-600">{room.participants.length}P</span>
          </div>
          <ParticipantsRail participants={room.participants} humanActorId={room.player?.actorId} />
        </aside>

        <main className="order-1 min-h-[70vh] overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.015] shadow-2xl shadow-black/20 lg:order-2 lg:min-h-0 lg:max-h-[calc(100vh-5.5rem)]">
          <Conversation room={room} activity={activity} onAction={submitAction} />
        </main>

        <aside className="order-3 lg:max-h-[calc(100vh-5.5rem)] lg:overflow-y-auto">
          <WorldPanel room={room} toolCalls={toolCalls} />
        </aside>
      </div>

      {error ? (
        <div className="fixed inset-x-0 bottom-4 z-30 mx-auto w-fit rounded-full border border-red-400/20 bg-[#140a0a] px-5 py-2 text-xs text-red-300 shadow-2xl">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function RoomHeaderSkeleton({ onBack }: { onBack: () => void }): ReactNode {
  return (
    <header className="flex h-16 items-center gap-3 border-b border-white/[0.06] px-6">
      <Button variant="ghost" size="icon-sm" className="text-zinc-500 hover:bg-white/[0.04]" onClick={onBack}>
        <ArrowLeft className="size-4" />
      </Button>
      <Skeleton className="size-9 rounded-xl" />
      <div className="space-y-1.5">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-3 w-24" />
      </div>
    </header>
  );
}
