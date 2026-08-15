import type { ReactNode } from "react";
import { ChevronRight, Plus, Radio, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { ScenarioId, ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { relativeTime, ScenarioIcon, StatusBadge } from "./shared";

export function RoomSidebar({
  scenarios,
  rooms,
  activeRoomId,
  onSelectRoom,
  onCreate
}: {
  scenarios: ScenarioSummary[];
  rooms: SocietyRoomSnapshot[];
  activeRoomId?: string;
  onSelectRoom(room: SocietyRoomSnapshot): void;
  onCreate(scenarioId?: ScenarioId): void;
}): ReactNode {
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="px-3 pb-2 pt-4">
        <Button className="w-full justify-between" onClick={() => onCreate()}>
          新建房间
          <Plus className="size-4" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 py-3">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium text-muted-foreground">场景</span>
            <Badge variant="outline" className="h-5 border-white/10 px-1.5 text-[10px] text-muted-foreground">{scenarios.length}</Badge>
          </div>
          <div className="space-y-0.5">
            {scenarios.map((scenario) => (
              <button
                key={scenario.id}
                className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-sidebar-accent"
                onClick={() => onCreate(scenario.id)}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-muted-foreground group-hover:text-foreground">
                  <ScenarioIcon id={scenario.id} className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{scenario.name}</span>
                  <span className="block text-[10px] text-muted-foreground">{scenario.players} 名 Agent</span>
                </span>
                <ChevronRight className="size-3.5 text-zinc-700 group-hover:text-zinc-400" />
              </button>
            ))}
          </div>
        </div>
        <Separator />
        <div className="px-3 py-4">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium text-muted-foreground">房间</span>
            <span className="font-mono text-[10px] text-zinc-600">{rooms.length}</span>
          </div>
          <div className="space-y-0.5">
            {rooms.map((room) => (
              <button
                key={room.id}
                className={cn(
                  "group w-full rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-sidebar-accent",
                  activeRoomId === room.id && "bg-sidebar-accent"
                )}
                onClick={() => onSelectRoom(room)}
              >
                <div className="flex items-center gap-2">
                  <span className={cn("size-1.5 rounded-full bg-zinc-600", room.status === "running" && "live-pulse bg-emerald-400", room.status === "error" && "bg-red-400")} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{room.title}</span>
                  <span className="font-mono text-[9px] text-zinc-600">{relativeTime(room.updatedAt)}</span>
                </div>
                <div className="mt-1.5 flex items-center justify-between pl-3.5">
                  <span className="truncate text-[10px] text-muted-foreground">{room.world.phase} · {room.world.agents.length} 名 Agent</span>
                  {room.status === "running" ? <Radio className="size-3 text-emerald-400" /> : null}
                </div>
              </button>
            ))}
            {!rooms.length ? (
              <div className="rounded-lg border border-dashed border-white/10 px-3 py-5 text-center">
                <Sparkles className="mx-auto size-4 text-zinc-600" />
                <p className="mt-2 text-[11px] text-muted-foreground">暂无房间</p>
              </div>
            ) : null}
          </div>
        </div>
      </ScrollArea>
      <div className="border-t border-sidebar-border px-4 py-3">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>OpenAI Agents SDK</span>
          <StatusBadge status="running" compact />
        </div>
      </div>
    </div>
  );
}
