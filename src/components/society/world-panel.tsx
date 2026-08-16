import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, BarChart3, Flame, History, Radio, Sparkles } from "lucide-react";
import type { ScenarioId, WorldSnapshot } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { RoomConnection } from "./use-room";
import { AgentAvatar, StatusDot, StatusLabel, eventLabel } from "./shared";

interface DiscussionState {
  wave: number;
  open: boolean;
  messageCount: number;
  urgency: Record<string, number>;
  spokeCounts: Record<string, number>;
}

export function WorldPanel({ room, toolCalls = [] }: { room: SocietyRoomSnapshot; toolCalls?: RoomConnection["toolCalls"] }): ReactNode {
  const world = room.world;
  const names = new Map(world.agents.map((agent) => [agent.id, agent.displayName]));

  return (
    <div className="space-y-4">
      <section>
        <div className="px-1 pb-3">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">
              <Radio className="size-3.5" />
              实时局势
            </p>
            <span className="flex items-center gap-1.5 text-xs text-zinc-400">
              <StatusDot status={world.status} />
              <StatusLabel status={world.status} />
            </span>
          </div>
          <div className="mt-3 flex items-end justify-between">
            <div>
              <p className="text-2xl font-semibold tracking-tight">{world.phase}</p>
              <p className="nums mt-1 font-mono text-xs text-zinc-400">第 {world.turn} / {world.totalTurns} 轮</p>
            </div>
            <ActBar turn={world.turn} total={world.totalTurns} finished={world.status === "finished"} />
          </div>
        </div>

        <DiscussionHeat world={world} names={names} />

        <Tabs defaultValue="scores">
          <TabsList className="justify-start gap-1 bg-transparent p-0">
            <TabsTrigger value="scores" className="rounded-lg border border-transparent px-3 py-1 text-xs data-[state=active]:border-zinc-200 data-[state=active]:bg-white data-[state=active]:text-zinc-900">
              <BarChart3 className="size-3.5" />
              战况
            </TabsTrigger>
            <TabsTrigger value="activity" className="rounded-lg border border-transparent px-3 py-1 text-xs data-[state=active]:border-zinc-200 data-[state=active]:bg-white data-[state=active]:text-zinc-900">
              <Radio className="size-3.5" />
              动态
            </TabsTrigger>
            <TabsTrigger value="history" className="rounded-lg border border-transparent px-3 py-1 text-xs data-[state=active]:border-zinc-200 data-[state=active]:bg-white data-[state=active]:text-zinc-900">
              <History className="size-3.5" />
              进程
            </TabsTrigger>
          </TabsList>
          <TabsContent value="scores" className="pt-3">
            <ScoreCard world={world} />
          </TabsContent>
          <TabsContent value="activity" className="pt-3">
            <ActivityCard toolCalls={toolCalls} names={names} />
          </TabsContent>
          <TabsContent value="history" className="pt-3">
            <HistoryCard world={world} names={names} scenarioId={room.scenarioId} />
          </TabsContent>
        </Tabs>
      </section>
      <BeatOverlay world={world} names={names} scenarioId={room.scenarioId} />
    </div>
  );
}

/**
 * Live social temperature of the room: the discussion director's response
 * pressure per participant. Reads who is being challenged, who is under
 * suspicion, and whether the conversation is still open — at a glance.
 */
function DiscussionHeat({ world, names }: { world: WorldSnapshot; names: Map<string, string> }): ReactNode {
  const discussion = world.details.discussion as DiscussionState | undefined;
  if (!discussion) return null;
  const entries = Object.entries(discussion.urgency)
    .sort((left, right) => right[1] - left[1])
    .filter(([, value]) => value > 0);
  return (
    <div className="mb-3 rounded-lg border border-zinc-200 bg-white p-3.5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
          <Flame className={cn("size-3.5", discussion.open ? "text-orange-500" : "text-zinc-300")} />
          讨论热度
        </p>
        <span className="nums font-mono text-[10px] text-zinc-400">
          {discussion.open ? `第 ${discussion.wave} 轮 · ${discussion.messageCount} 条` : "已收场"}
        </span>
      </div>
      {entries.length ? (
        <div className="mt-2.5 space-y-1.5">
          {entries.map(([id, value]) => (
            <div key={id} className="flex items-center gap-2">
              <span className="w-14 truncate text-[11px] text-zinc-500">{names.get(id) ?? id}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-100">
                <div
                  className={cn("h-full rounded-full transition-all duration-500", value > 0.55 ? "bg-orange-500" : value > 0.25 ? "bg-amber-500" : "bg-zinc-400")}
                  style={{ width: `${Math.max(6, value * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-zinc-400">没有人被点名，对话趋于平静</p>
      )}
    </div>
  );
}

function ActBar({ turn, total, finished }: { turn: number; total: number; finished: boolean }): ReactNode {
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: Math.max(1, total) }).map((_, index) => (
        <span
          key={index}
          className={cn(
            "h-1 rounded-full transition-all duration-500",
            finished || index < turn
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

function ScoreCard({ world }: { world: WorldSnapshot }): ReactNode {
  const scored = world.agents.filter((agent) => agent.score !== undefined);
  if (!scored.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-6 text-xs text-zinc-400">
        <Activity className="size-3.5" />
        本场景暂无公开分数
      </div>
    );
  }
  const sorted = [...scored].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const max = sorted[0]?.score ?? 0;
  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-3">
      {sorted.map((agent, index) => (
        <div key={agent.id} className={cn("flex items-center gap-3 rounded-md px-2 py-1.5", index === 0 && "leader-wash")}>
          <span className={cn("nums w-5 font-mono text-xs", index === 0 ? "text-amber-600" : "text-zinc-400")}>
            {index + 1}
          </span>
          <span className="w-20 truncate text-sm text-zinc-700">{agent.displayName}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-zinc-700 transition-all duration-700"
              style={{ width: `${max > 0 ? ((agent.score ?? 0) / max) * 100 : 0}%` }}
            />
          </div>
          <span className="nums w-10 text-right font-mono text-sm text-zinc-900">{agent.score}</span>
        </div>
      ))}
    </div>
  );
}

function ActivityCard({ toolCalls, names }: { toolCalls: RoomConnection["toolCalls"]; names: Map<string, string> }): ReactNode {
  if (!toolCalls.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-6 text-xs text-zinc-400">
        <Radio className="size-3.5" />
        等待智能体活动…
      </div>
    );
  }
  return (
    <div className="space-y-0.5 rounded-lg border border-zinc-200 bg-white p-1.5">
      {toolCalls.slice(0, 20).map((call, index) => (
        <div key={`${call.at}-${index}`} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs hover:bg-zinc-50">
          <AgentAvatar name={call.actorName || names.get(call.actorId) || call.actorId} index={indexOf(call.actorId)} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-zinc-600">
              <span className="font-medium text-zinc-800">{names.get(call.actorId) ?? call.actorId}</span>
              <span className="mx-1 text-zinc-300">·</span>
              {eventLabel(call.toolName)}
            </p>
          </div>
          <span className={cn("size-1.5 rounded-full", call.phase === "started" ? "bg-emerald-500" : "bg-zinc-300")} />
        </div>
      ))}
    </div>
  );
}

function HistoryCard({ world, names, scenarioId }: { world: WorldSnapshot; names: Map<string, string>; scenarioId: ScenarioId }): ReactNode {
  const history = (world.details.history ?? []) as Array<Record<string, unknown>>;
  if (!history.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-6 text-xs text-zinc-400">
        <Activity className="size-3.5" />
        还没有历史回合
      </div>
    );
  }
  return (
    <div className="space-y-1 rounded-lg border border-zinc-200 bg-white p-1.5">
      {history.map((entry, index) => (
        <HistoryRow key={index} entry={entry} names={names} scenarioId={scenarioId} />
      ))}
    </div>
  );
}

function HistoryRow({ entry, names, scenarioId }: { entry: Record<string, unknown>; names: Map<string, string>; scenarioId: ScenarioId }): ReactNode {
  if (scenarioId === "werewolf") {
    const eliminated = entry.eliminatedId as string | undefined;
    const night = entry.nightTargetId as string | undefined;
    return (
      <div className="flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5 hover:bg-zinc-50">
        <span className="nums mt-0.5 font-mono text-[10px] text-zinc-400">D{String(entry.day)}</span>
        <div className="flex-1 text-zinc-500">
          {eliminated ? (
            <p><span className="font-medium text-zinc-800">{names.get(eliminated) ?? eliminated}</span> 被投票淘汰（{String(entry.eliminatedRole)}）</p>
          ) : (
            <p className="text-zinc-400">投票平局，无人淘汰</p>
          )}
          {night ? (
            <p className="mt-0.5 text-zinc-400">夜晚：<span className="font-medium text-rose-500">{names.get(night) ?? night}</span> 被淘汰（{String(entry.nightTargetRole)}）</p>
          ) : null}
        </div>
      </div>
    );
  }
  if (scenarioId === "sealed-bid-auction") {
    const winnerId = entry.winnerId as string | undefined;
    const price = entry.price as number | undefined;
    const bids = entry.bids as Record<string, number> | undefined;
    return (
      <div className="flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5 hover:bg-zinc-50">
        <span className="nums mt-0.5 font-mono text-[10px] text-zinc-400">R{String(entry.round)}</span>
        <div className="flex-1">
          <p className="text-zinc-600">
            {winnerId ? <span className="font-medium text-zinc-800">{names.get(winnerId) ?? winnerId}</span> : "无人"} 以 <span className="nums font-mono text-zinc-800">{price}</span> 点拍得
          </p>
          {bids ? (
            <p className="nums mt-0.5 font-mono text-[10px] text-zinc-400">
              {Object.entries(bids).map(([id, value]) => `${names.get(id) ?? id} ${value}`).join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
    );
  }
  if (scenarioId === "prisoners-dilemma" || scenarioId === "trust-game" || scenarioId === "ultimatum-game" || scenarioId === "chicken-game" || scenarioId === "stag-hunt") {
    const payoffs = entry.payoffs as Record<string, number> | undefined;
    const detail = entry.text as string | undefined;
    return (
      <div className="flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5 hover:bg-zinc-50">
        <span className="nums mt-0.5 font-mono text-[10px] text-zinc-400">R{String(entry.round)}</span>
        <div className="flex-1">
          {detail ? <p className="text-zinc-600">{detail}</p> : null}
          {payoffs ? (
            <p className="nums mt-0.5 font-mono text-[10px] text-zinc-400">
              {Object.entries(payoffs).map(([id, value]) => `${names.get(id) ?? id} ${value}`).join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
    );
  }
  if (scenarioId === "public-goods") {
    const contributions = entry.contributions as Record<string, number> | undefined;
    return (
      <div className="flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5 hover:bg-zinc-50">
        <span className="nums mt-0.5 font-mono text-[10px] text-zinc-400">R{String(entry.round)}</span>
        <div className="flex-1 text-zinc-600">
          <p>公共池 {String(entry.pool)} · 每人返还 {String(entry.share)}</p>
          {contributions ? (
            <p className="nums mt-0.5 font-mono text-[10px] text-zinc-400">
              {Object.entries(contributions).map(([id, value]) => `${names.get(id) ?? id} ${value}`).join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
    );
  }
  const text = typeof entry.text === "string" ? entry.text : undefined;
  if (text) {
    return (
      <div className="flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5 text-zinc-500 hover:bg-zinc-50">
        <span className="nums mt-0.5 font-mono text-[10px] text-zinc-400">{roundLabel(entry)}</span>
        <div className="flex-1">{text}</div>
      </div>
    );
  }
  return null;
}

function roundLabel(entry: Record<string, unknown>): string {
  const round = entry.round ?? entry.move ?? entry.quest ?? entry.day;
  return round === undefined ? "·" : String(round);
}

/** Cinematic beat: dim the stage for a second and announce the latest outcome. */
function BeatOverlay({ world, names, scenarioId }: { world: WorldSnapshot; names: Map<string, string>; scenarioId: ScenarioId }): ReactNode {
  const history = (world.details.history ?? []) as Array<Record<string, unknown>>;
  const [beat, setBeat] = useState<string | null>(null);
  const seenRef = useRef<number>(0);

  useEffect(() => {
    if (history.length <= seenRef.current) return;
    seenRef.current = history.length;
    const latest = history.at(-1);
    if (!latest) return;
    const text = beatText(latest, names, scenarioId, world);
    if (!text) return;
    setBeat(text);
    const timer = window.setTimeout(() => setBeat(null), 4_200);
    return () => window.clearTimeout(timer);
  }, [history, names, scenarioId, world]);

  if (!beat) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" />
      <div className="reveal-up relative mx-6 max-w-md rounded-xl border border-zinc-200 bg-white px-10 py-8 text-center shadow-2xl shadow-black/10">
        <Sparkles className="mx-auto size-5 text-amber-500" />
        <p className="mt-3 text-lg font-medium leading-7 tracking-tight text-zinc-900">{beat}</p>
      </div>
    </div>
  );
}

function beatText(entry: Record<string, unknown>, names: Map<string, string>, scenarioId: ScenarioId, world: WorldSnapshot): string | null {
  if (scenarioId === "werewolf") {
    const eliminated = entry.eliminatedId as string | undefined;
    if (eliminated) return `${names.get(eliminated) ?? eliminated} 被投票淘汰，身份揭晓：${String(entry.eliminatedRole)}`;
    const night = entry.nightTargetId as string | undefined;
    if (night) return `夜晚降临，${names.get(night) ?? night} 遇害，身份：${String(entry.nightTargetRole)}`;
    return null;
  }
  if (scenarioId === "avalon") {
    const outcome = entry.outcome as string | undefined;
    if (!outcome) return null;
    return outcome === "fail"
      ? `任务失败 —— ${String(entry.failCount)} 张黑票悄然出现`
      : `任务成功 —— 忠诚经受住了考验`;
  }
  if (typeof entry.text === "string" && entry.text) return entry.text;
  return null;
}

function indexOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}
