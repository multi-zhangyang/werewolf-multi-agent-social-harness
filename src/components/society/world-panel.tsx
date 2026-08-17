import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, BarChart3, BrainCircuit, Clapperboard, Crosshair, Flame, History, ListOrdered, MessageSquare, Network, Radio, Sparkles, Wrench } from "lucide-react";
import type { ScenarioId, WorldSnapshot } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { RoomConnection, TimelineEntry } from "./use-room";
import { AgentAvatar, StatusDot, StatusLabel, eventLabel, roleLabelZh } from "./shared";
import { RelationshipNetwork } from "./network";

interface DiscussionState {
  wave: number;
  open: boolean;
  messageCount: number;
  urgency: Record<string, number>;
  spokeCounts: Record<string, number>;
}

interface SuspicionState {
  scores: Record<string, number>;
  entries: Array<{ turn: number; accuser: string; target: string; kind: "speech" | "vote" | "outcome" }>;
}

export function WorldPanel({ room, toolCalls = [], timeline = [] }: { room: SocietyRoomSnapshot; toolCalls?: RoomConnection["toolCalls"]; timeline?: TimelineEntry[] }): ReactNode {
  const world = room.world;
  const names = new Map(world.agents.map((agent) => [agent.id, agent.displayName]));

  return (
    <div className="space-y-4">
      <section>
        <div className="px-1 pb-3">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
              <Radio className="size-3.5" />
              实时局势
            </p>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
              <StatusDot status={world.status} />
              <StatusLabel status={world.status} />
            </span>
          </div>
          <div className="mt-3 flex items-end justify-between">
            <div>
              <p className="text-lg font-semibold tracking-tight">{world.phase}</p>
              <p className="nums mt-1 font-mono text-xs text-muted-foreground/80">第 {world.turn} / {world.totalTurns} 轮</p>
            </div>
            <ActBar turn={world.turn} total={world.totalTurns} finished={world.status === "finished"} />
          </div>
        </div>

        <DiscussionHeat world={world} names={names} />
        <SuspicionGraph world={world} names={names} />
        <SuspicionPanel world={world} names={names} />

        <Tabs defaultValue="network">
          <TabsList className="justify-start gap-1 bg-transparent p-0">
            <TabsTrigger value="network" className="rounded-lg border border-transparent px-3 py-1 text-xs data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:text-foreground">
              <Network className="size-3.5" />
              关系
            </TabsTrigger>
            <TabsTrigger value="scores" className="rounded-lg border border-transparent px-3 py-1 text-xs data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:text-foreground">
              <BarChart3 className="size-3.5" />
              战况
            </TabsTrigger>
            <TabsTrigger value="activity" className="rounded-lg border border-transparent px-3 py-1 text-xs data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:text-foreground">
              <Radio className="size-3.5" />
              动态
            </TabsTrigger>
            <TabsTrigger value="timeline" className="rounded-lg border border-transparent px-3 py-1 text-xs data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:text-foreground">
              <ListOrdered className="size-3.5" />
              时间线
            </TabsTrigger>
            <TabsTrigger value="highlights" className="rounded-lg border border-transparent px-3 py-1 text-xs data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:text-foreground">
              <Sparkles className="size-3.5" />
              高光
            </TabsTrigger>
            <TabsTrigger value="history" className="rounded-lg border border-transparent px-3 py-1 text-xs data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:text-foreground">
              <History className="size-3.5" />
              进程
            </TabsTrigger>
          </TabsList>
          <TabsContent value="network" className="pt-3">
            <RelationshipNetwork participants={room.participants} />
          </TabsContent>
          <TabsContent value="scores" className="pt-3">
            <ScoreCard world={world} />
          </TabsContent>
          <TabsContent value="activity" className="pt-3">
            <ActivityCard toolCalls={toolCalls} names={names} />
          </TabsContent>
          <TabsContent value="timeline" className="pt-3">
            <TimelineCard timeline={timeline} names={names} />
          </TabsContent>
          <TabsContent value="highlights" className="pt-3">
            <HighlightsCard highlights={room.highlights ?? []} names={names} />
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
    <div className="mb-3 rounded-lg border border-border bg-card p-3.5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Flame className={cn("size-3.5", discussion.open ? "text-orange-500" : "text-muted-foreground/50")} />
          讨论热度
        </p>
        <span className="nums font-mono text-[10px] text-muted-foreground/80">
          {discussion.open ? `第 ${discussion.wave} 轮 · ${discussion.messageCount} 条` : "已收场"}
        </span>
      </div>
      {entries.length ? (
        <div className="mt-2.5 space-y-1.5">
          {entries.map(([id, value]) => (
            <div key={id} className="flex items-center gap-2">
              <span className="w-14 truncate text-[11px] text-muted-foreground">{names.get(id) ?? id}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full transition-all duration-500", value > 0.55 ? "bg-orange-400" : value > 0.25 ? "bg-amber-400" : "bg-muted-foreground/40")}
                  style={{ width: `${Math.max(6, value * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground/80">没有人被点名，对话趋于平静</p>
      )}
    </div>
  );
}

/**
 * The accusation web: a directed graph of who pointed at whom. Nodes are the
 * characters arranged in a circle; edges are the latest public accusations,
 * votes and outcomes, colored by kind and faded by age — the room's argument
 * structure at a glance.
 */
function SuspicionGraph({ world, names }: { world: WorldSnapshot; names: Map<string, string> }): ReactNode {
  const suspicion = world.details.suspicion as SuspicionState | undefined;
  if (!suspicion) return null;
  const ids = world.agents.map((agent) => agent.id);
  const n = Math.max(2, ids.length);
  const cx = 100;
  const cy = 90;
  const radius = 62;
  const position = (id: string): { x: number; y: number } => {
    const index = ids.indexOf(id);
    if (index === -1) return { x: cx, y: cy };
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / n;
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  };
  const entries = suspicion.entries.slice(-14);
  const edgeColor: Record<string, string> = { speech: "#f59e0b", vote: "#e11d48", outcome: "#a1a1aa" };
  return (
    <div className="mb-3 rounded-lg border border-border bg-card p-3.5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Network className="size-3.5 text-muted-foreground/80" />
          怀疑网络
        </p>
        <span className="nums font-mono text-[10px] text-muted-foreground/80">{entries.length} 条指控</span>
      </div>
      <svg viewBox="0 0 200 184" className="mt-1 w-full" role="img" aria-label="谁指控谁">
        <defs>
          <marker id="arrow-speech" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="#f59e0b" />
          </marker>
          <marker id="arrow-vote" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="#e11d48" />
          </marker>
        </defs>
        {entries.map((entry, index) => {
          if (!ids.includes(entry.accuser)) return null;
          const from = position(entry.accuser);
          const to = position(entry.target);
          const opacity = 0.25 + 0.75 * ((index + 1) / entries.length);
          return (
            <line
              key={index}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={edgeColor[entry.kind] ?? "#a1a1aa"}
              strokeOpacity={opacity}
              strokeWidth={1.4}
              markerEnd={entry.kind === "vote" ? "url(#arrow-vote)" : "url(#arrow-speech)"}
            />
          );
        })}
        {ids.map((id) => {
          const point = position(id);
          const score = suspicion.scores[id] ?? 0;
          const ring = score > 0.5 ? "#e11d48" : score > 0.25 ? "#f59e0b" : "#d4d4d8";
          return (
            <g key={id}>
              <circle
                cx={point.x}
                cy={point.y}
                r={score > 0 ? 13 : 10.5}
                fill="#0a0a0a"
                stroke={ring}
                strokeWidth={score > 0 ? 2.2 : 1.2}
              />
              <text
                x={point.x}
                y={point.y + 24}
                textAnchor="middle"
                fontSize="8.5"
                className="fill-white/55"
              >
                {names.get(id) ?? id}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground/80">
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-amber-400" />指控</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-rose-400" />投票</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-muted-foreground/40" />结果</span>
      </div>
    </div>
  );
}

/**
 * The room's suspicion climate: who the group is currently leaning against,
 * derived from public accusations, votes and outcomes. The accusation feed
 * shows the live chains ("who pointed at whom") for observers.
 */
function SuspicionPanel({ world, names }: { world: WorldSnapshot; names: Map<string, string> }): ReactNode {
  const suspicion = world.details.suspicion as SuspicionState | undefined;
  if (!suspicion) return null;
  const ranked = Object.entries(suspicion.scores)
    .sort((left, right) => right[1] - left[1])
    .filter(([, value]) => value > 0);
  const feed = suspicion.entries.slice(-6).reverse();
  return (
    <div className="mb-3 rounded-lg border border-border bg-card p-3.5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Crosshair className={cn("size-3.5", ranked.length ? "text-rose-400" : "text-muted-foreground/50")} />
          怀疑氛围
        </p>
        <span className="nums font-mono text-[10px] text-muted-foreground/80">
          {ranked.length ? `${ranked.length} 人被点名` : "风平浪静"}
        </span>
      </div>
      {ranked.length ? (
        <div className="mt-2.5 space-y-1.5">
          {ranked.slice(0, 5).map(([id, value]) => (
            <div key={id} className="flex items-center gap-2">
              <span className="w-14 truncate text-[11px] text-muted-foreground">{names.get(id) ?? id}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full transition-all duration-500", value > 0.55 ? "bg-rose-400" : value > 0.25 ? "bg-orange-400" : "bg-muted-foreground/40")}
                  style={{ width: `${Math.max(6, value * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground/80">还没有公开指控或异常票型</p>
      )}
      {feed.length ? (
        <div className="mt-3 space-y-1 border-t border-border/60 pt-2.5">
          {feed.map((entry, index) => {
            const accuser = names.get(entry.accuser) ?? entry.accuser;
            const target = names.get(entry.target) ?? entry.target;
            const kindLabel = entry.kind === "vote" ? "投票" : entry.kind === "outcome" ? "结果" : "指控";
            return (
              <p key={index} className="truncate text-[11px] text-muted-foreground/80">
                <span className="text-muted-foreground">{accuser}</span>
                <span className="mx-1 text-muted-foreground/50">→</span>
                <span className="text-rose-400/90">{target}</span>
                <span className={cn("ml-1.5 rounded px-1 py-px font-mono text-[9px]", entry.kind === "vote" ? "bg-muted text-muted-foreground" : entry.kind === "outcome" ? "bg-orange-400/10 text-orange-400" : "bg-rose-400/10 text-rose-400")}>
                  {kindLabel}
                </span>
              </p>
            );
          })}
        </div>
      ) : null}
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

function ScoreCard({ world }: { world: WorldSnapshot }): ReactNode {
  const scored = world.agents.filter((agent) => agent.score !== undefined);
  if (!scored.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-xs text-muted-foreground/80">
        <Activity className="size-3.5" />
        本场景暂无公开分数
      </div>
    );
  }
  const sorted = [...scored].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const max = sorted[0]?.score ?? 0;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      {sorted.map((agent, index) => (
        <div key={agent.id} className={cn("flex items-center gap-3 rounded-md px-2 py-1.5", index === 0 && "leader-wash")}>
          <span className={cn("nums w-5 font-mono text-xs", index === 0 ? "text-amber-400" : "text-muted-foreground/80")}>
            {index + 1}
          </span>
          <span className="w-20 truncate text-sm text-foreground/80">{agent.displayName}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground/70 transition-all duration-700"
              style={{ width: `${max > 0 ? ((agent.score ?? 0) / max) * 100 : 0}%` }}
            />
          </div>
          <span className="nums w-10 text-right font-mono text-sm text-foreground">{agent.score}</span>
        </div>
      ))}
    </div>
  );
}

function ActivityCard({ toolCalls, names }: { toolCalls: RoomConnection["toolCalls"]; names: Map<string, string> }): ReactNode {
  if (!toolCalls.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-xs text-muted-foreground/80">
        <Radio className="size-3.5" />
        等待智能体活动…
      </div>
    );
  }
  return (
    <div className="space-y-0.5 rounded-lg border border-border bg-card p-1.5">
      {toolCalls.slice(0, 20).map((call, index) => (
        <div key={`${call.at}-${index}`} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs hover:bg-muted">
          <AgentAvatar name={call.actorName || names.get(call.actorId) || call.actorId} index={indexOf(call.actorId)} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-muted-foreground">
              <span className="font-medium text-foreground/90">{names.get(call.actorId) ?? call.actorId}</span>
              <span className="mx-1 text-muted-foreground/50">·</span>
              {eventLabel(call.toolName)}
            </p>
          </div>
          <span className={cn("size-1.5 rounded-full", call.phase === "started" ? "bg-emerald-400" : "bg-muted-foreground/40")} />
        </div>
      ))}
    </div>
  );
}

function TimelineCard({ timeline, names }: { timeline: TimelineEntry[]; names: Map<string, string> }): ReactNode {
  if (!timeline.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-xs text-muted-foreground/80">
        <ListOrdered className="size-3.5" />
        思考、记忆、工具与行动会按发生顺序汇聚到这里…
      </div>
    );
  }
  const ICONS: Record<TimelineEntry["kind"], ReactNode> = {
    thought: <BrainCircuit className="size-3.5 text-violet-400" />,
    tool: <Wrench className="size-3.5 text-sky-400" />,
    message: <MessageSquare className="size-3.5 text-emerald-400" />,
    action: <Crosshair className="size-3.5 text-amber-400" />,
    cue: <Clapperboard className="size-3.5 text-rose-400" />,
    memory: <BrainCircuit className="size-3.5 text-teal-400" />,
    pressure: <Flame className="size-3.5 text-orange-400" />
  };
  return (
    <div className="space-y-0.5 rounded-lg border border-border bg-card p-1.5">
      {timeline.slice(0, 40).map((entry) => (
        <div key={entry.id} className="flex items-start gap-2.5 rounded-md px-2 py-1.5 text-xs hover:bg-muted">
          <span className="mt-0.5 shrink-0">{ICONS[entry.kind]}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-muted-foreground">
              {entry.actorId ? <span className="font-medium text-foreground/90">{names.get(entry.actorId) ?? entry.actorId}</span> : null}
              {entry.actorId ? <span className="mx-1 text-muted-foreground/50">·</span> : null}
              {entry.label}
            </p>
            {entry.detail ? <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground/70">{entry.detail}</p> : null}
          </div>
          <span className="nums mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground/50">{formatTime(entry.at)}</span>
        </div>
      ))}
    </div>
  );
}

function HighlightsCard({ highlights, names }: { highlights: SocietyRoomSnapshot["highlights"]; names: Map<string, string> }): ReactNode {
  if (!highlights?.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-xs text-muted-foreground/80">
        <Sparkles className="size-3.5" />
        高光由高优先级镜头自动生成（淘汰、背叛、谎言揭穿、终局）——它们只会来自真实事件。
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {[...highlights].reverse().map((highlight) => (
        <div key={highlight.id} className="rounded-lg border border-border bg-card px-3 py-2.5">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-foreground/90">
            <Clapperboard className="size-3.5 text-rose-400" />
            {highlight.title}
            <span className="nums ml-auto font-mono text-[10px] font-normal text-muted-foreground/60">{formatTime(highlight.at)}</span>
          </p>
          {highlight.subtitle ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{highlight.subtitle}</p> : null}
          {highlight.focusAgentIds.length ? (
            <p className="mt-1 text-[11px] text-muted-foreground/70">焦点：{highlight.focusAgentIds.map((id) => names.get(id) ?? id).join("、")}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function formatTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function HistoryCard({ world, names, scenarioId }: { world: WorldSnapshot; names: Map<string, string>; scenarioId: ScenarioId }): ReactNode {
  const history = (world.details.history ?? []) as Array<Record<string, unknown>>;
  if (!history.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-xs text-muted-foreground/80">
        <Activity className="size-3.5" />
        还没有历史回合
      </div>
    );
  }
  return (
    <div className="space-y-1 rounded-lg border border-border bg-card p-1.5">
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
      <div className="flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5 hover:bg-muted">
        <span className="nums mt-0.5 font-mono text-[10px] text-muted-foreground/80">D{String(entry.day)}</span>
        <div className="flex-1 text-muted-foreground">
          {eliminated ? (
            <p><span className="font-medium text-foreground/90">{names.get(eliminated) ?? eliminated}</span> 被投票淘汰（{roleLabelZh(String(entry.eliminatedRole))}）</p>
          ) : (
            <p className="text-muted-foreground/80">投票平局，无人淘汰</p>
          )}
          {night ? (
            <p className="mt-0.5 text-muted-foreground/80">夜晚：<span className="font-medium text-rose-400">{names.get(night) ?? night}</span> 被淘汰（{roleLabelZh(String(entry.nightTargetRole))}）</p>
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
      <div className="flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5 hover:bg-muted">
        <span className="nums mt-0.5 font-mono text-[10px] text-muted-foreground/80">R{String(entry.round)}</span>
        <div className="flex-1">
          <p className="text-muted-foreground">
            {winnerId ? <span className="font-medium text-foreground/90">{names.get(winnerId) ?? winnerId}</span> : "无人"} 以 <span className="nums font-mono text-foreground/90">{price}</span> 点拍得
          </p>
          {bids ? (
            <p className="nums mt-0.5 font-mono text-[10px] text-muted-foreground/80">
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
      <div className="flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5 hover:bg-muted">
        <span className="nums mt-0.5 font-mono text-[10px] text-muted-foreground/80">R{String(entry.round)}</span>
        <div className="flex-1">
          {detail ? <p className="text-muted-foreground">{detail}</p> : null}
          {payoffs ? (
            <p className="nums mt-0.5 font-mono text-[10px] text-muted-foreground/80">
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
      <div className="flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5 hover:bg-muted">
        <span className="nums mt-0.5 font-mono text-[10px] text-muted-foreground/80">R{String(entry.round)}</span>
        <div className="flex-1 text-muted-foreground">
          <p>公共池 {String(entry.pool)} · 每人返还 {String(entry.share)}</p>
          {contributions ? (
            <p className="nums mt-0.5 font-mono text-[10px] text-muted-foreground/80">
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
      <div className="flex items-start gap-2 rounded-md px-2 py-2 text-xs leading-5 text-muted-foreground hover:bg-muted">
        <span className="nums mt-0.5 font-mono text-[10px] text-muted-foreground/80">{roundLabel(entry)}</span>
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
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
      <div className="reveal-up relative mx-6 max-w-md rounded-xl border border-border bg-card px-10 py-8 text-center shadow-2xl shadow-black/10">
        <Sparkles className="mx-auto size-5 text-amber-500" />
        <p className="mt-3 text-lg font-medium leading-7 tracking-tight text-foreground">{beat}</p>
      </div>
    </div>
  );
}

function beatText(entry: Record<string, unknown>, names: Map<string, string>, scenarioId: ScenarioId, world: WorldSnapshot): string | null {
  if (scenarioId === "werewolf") {
    const eliminated = entry.eliminatedId as string | undefined;
    if (eliminated) return `${names.get(eliminated) ?? eliminated} 被投票淘汰，身份揭晓：${roleLabelZh(String(entry.eliminatedRole))}`;
    const night = entry.nightTargetId as string | undefined;
    if (night) return `夜晚降临，${names.get(night) ?? night} 遇害，身份：${roleLabelZh(String(entry.nightTargetRole))}`;
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
