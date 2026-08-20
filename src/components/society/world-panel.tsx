import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, BarChart3, BrainCircuit, Clapperboard, Crosshair, Flame, GitBranch, History, ListOrdered, MessageSquare, Network, Radio, Sparkles, Wrench } from "lucide-react";
import type { ScenarioId, WorldSnapshot } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import type { SocialCausalityProjection } from "@/society/social/contracts";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { RoomConnection, TimelineEntry } from "./use-room";
import { AgentAvatar, StatusDot, StatusLabel, eventLabel, roleLabelZh } from "./shared";
import { RelationshipNetwork } from "./network";
import { timelineContextAround } from "@/society/spectator/projection";
import { toast } from "sonner";

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

export function WorldPanel({ room, toolCalls = [], timeline = [], onJumpToAt }: { room: SocietyRoomSnapshot; toolCalls?: RoomConnection["toolCalls"]; timeline?: TimelineEntry[]; onJumpToAt?: (at: string) => void }): ReactNode {
  const world = room.world;
  const names = new Map(world.agents.map((agent) => [agent.id, agent.displayName]));
  const avatarSeeds = new Map(room.participants.map((participant) => [participant.profile.id, participant.profile.characterId]));

  return (
    <div className="flex flex-col gap-3">
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
          <div className="mt-2 flex items-end justify-between">
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
          <TabsList className="grid h-auto w-full grid-cols-4 gap-1 bg-transparent p-0">
            <TabsTrigger value="network">
              <Network />
              关系
            </TabsTrigger>
            <TabsTrigger value="scores">
              <BarChart3 />
              战况
            </TabsTrigger>
            <TabsTrigger value="activity">
              <Radio />
              动态
            </TabsTrigger>
            <TabsTrigger value="timeline">
              <ListOrdered />
              时间线
            </TabsTrigger>
            <TabsTrigger value="highlights">
              <Sparkles />
              高光
            </TabsTrigger>
            <TabsTrigger value="history">
              <History />
              进程
            </TabsTrigger>
            <TabsTrigger value="causality">
              <GitBranch />
              因果
            </TabsTrigger>
          </TabsList>
          <TabsContent value="network" className="pt-3">
            <RelationshipNetwork participants={room.participants} />
          </TabsContent>
          <TabsContent value="scores" className="pt-3">
            <ScoreCard world={world} />
          </TabsContent>
          <TabsContent value="activity" className="pt-3">
            <ActivityCard toolCalls={toolCalls} names={names} avatarSeeds={avatarSeeds} />
          </TabsContent>
          <TabsContent value="timeline" className="pt-3">
            <TimelineCard timeline={timeline} names={names} />
          </TabsContent>
          <TabsContent value="highlights" className="pt-3">
            <HighlightsCard highlights={room.highlights ?? []} timeline={timeline} names={names} onJumpToAt={onJumpToAt} />
          </TabsContent>
          <TabsContent value="history" className="pt-3">
            <HistoryCard world={world} names={names} scenarioId={room.scenarioId} />
          </TabsContent>
          <TabsContent value="causality" className="pt-3">
            <CausalityCard room={room} />
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

interface ProjectedCommitment {
  commitmentId: string;
  promisorActorId: string;
  proposition: string;
  state: "proposed" | "fulfilled" | "violated" | "void";
}

function CausalityCard({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const projection = room.world.details.socialCausality as SocialCausalityProjection | undefined;
  const legacyCommitments = Array.isArray(room.world.details.commitments)
    ? room.world.details.commitments.filter((entry): entry is ProjectedCommitment => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const value = entry as Record<string, unknown>;
        return typeof value.commitmentId === "string"
          && typeof value.promisorActorId === "string"
          && typeof value.proposition === "string"
          && ["proposed", "fulfilled", "violated", "void"].includes(String(value.state));
      })
    : [];
  const commitments: ProjectedCommitment[] = projection?.commitments.length ? projection.commitments : legacyCommitments;
  const actorNames = new Map(room.participants.map((participant) => [participant.profile.id, participant.profile.displayName]));
  const characterNames = new Map(room.participants.map((participant) => [participant.profile.characterId, participant.profile.displayName]));
  const propositions = new Map((projection?.propositions ?? []).map((proposition) => [proposition.propositionId, proposition]));
  const socialActs = (projection?.socialActs ?? []).slice(-5).reverse();
  const beliefUpdates = (projection?.beliefUpdates ?? []).slice(-4).reverse();
  const deceptions = (projection?.deceptions ?? []).slice(-3).reverse();
  const decisions = (projection?.decisions ?? []).slice(-3).reverse();
  const hasRecords = commitments.length + socialActs.length + beliefUpdates.length + deceptions.length + decisions.length > 0;

  if (!hasRecords) {
    return (
      <Empty className="min-h-48">
        <EmptyHeader>
          <EmptyMedia variant="icon"><GitBranch /></EmptyMedia>
          <EmptyTitle>等待第一条因果记录</EmptyTitle>
          <EmptyDescription>消息、信念和绑定行动发生后，这里会显示来源与后果。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-1.5">
        <CausalityMetric label="行为" value={projection?.socialActs.length ?? 0} />
        <CausalityMetric label="信念" value={projection?.beliefUpdates.length ?? 0} />
        <CausalityMetric label="决定" value={projection?.decisions.length ?? 0} />
      </div>

      {deceptions.length ? (
        <CausalitySection title="欺骗生命周期" provenance="Agent 自述">
          {deceptions.map((episode) => (
            <div key={episode.deceptionId} className="rounded-md border border-border bg-card px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-medium">{actorNames.get(episode.deceiverActorId) ?? episode.deceiverActorId}</p>
                <Badge variant="outline">{deceptionStatusLabel(episode.status)}</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                {episode.intendedFalseBeliefIds.map((id) => propositions.get(id)?.predicate).filter(Boolean).join("；") || episode.mode}
              </p>
              <p className="mt-1 font-mono text-[9px] text-muted-foreground/70">
                消息 {episode.executionMessageIds.length} · 识破证据 {episode.detectionEventIds.length}
              </p>
            </div>
          ))}
        </CausalitySection>
      ) : null}

      {commitments.length ? (
        <CausalitySection title="承诺结算" provenance="世界事实">
          {commitments.slice(-4).reverse().map((commitment) => (
            <div key={commitment.commitmentId} className="rounded-md border border-border bg-card px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-medium">{actorNames.get(commitment.promisorActorId) ?? commitment.promisorActorId}</p>
                <Badge variant={commitment.state === "violated" ? "destructive" : "outline"}>{commitmentStateLabel(commitment.state)}</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{commitment.proposition}</p>
            </div>
          ))}
        </CausalitySection>
      ) : null}

      {beliefUpdates.length ? (
        <CausalitySection title="信念变化" provenance="Agent 自述">
          {beliefUpdates.map((belief) => (
            <div key={belief.beliefUpdateId} className="rounded-md border border-border bg-card px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-medium">{characterNames.get(belief.ownerCharacterId) ?? belief.ownerCharacterId}</p>
                <span className="font-mono text-[10px] text-muted-foreground">{Math.round(belief.beforeProbability * 100)} → {Math.round(belief.afterProbability * 100)}%</span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{propositions.get(belief.propositionId)?.predicate ?? belief.propositionId}</p>
              <p className="mt-1 font-mono text-[9px] text-muted-foreground/70">置信 {Math.round(belief.confidence * 100)}% · 证据 {belief.addedEvidenceIds.length}</p>
            </div>
          ))}
        </CausalitySection>
      ) : null}

      {socialActs.length ? (
        <CausalitySection title="消息行为" provenance="消息主张">
          {socialActs.map((act) => (
            <div key={act.socialActId} className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2.5">
              <Badge variant="secondary">{socialActLabel(act.kind)}</Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{actorNames.get(act.actorId) ?? act.actorId}</p>
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                  {act.propositionIds.map((id) => propositions.get(id)?.predicate).filter(Boolean).join("；") || `面向 ${act.audienceActorIds.length} 人`}
                </p>
              </div>
            </div>
          ))}
        </CausalitySection>
      ) : null}

      {decisions.length ? (
        <CausalitySection title="绑定决定" provenance="Agent 自述">
          {decisions.map((decision) => (
            <div key={decision.decisionId} className="rounded-md border border-border bg-card px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-medium">{actorNames.get(decision.actorId) ?? decision.actorId}</p>
                <Badge variant="outline">{eventLabel(decision.action)}</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{decision.selectedIntent.summary}</p>
            </div>
          ))}
        </CausalitySection>
      ) : null}
    </div>
  );
}

function CausalityMetric({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-2">
      <p className="font-mono text-base text-foreground">{String(value).padStart(2, "0")}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

function CausalitySection({ title, provenance, children }: { title: string; provenance: string; children: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between px-0.5">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
        <Badge variant="outline">{provenance}</Badge>
      </div>
      {children}
    </section>
  );
}

function socialActLabel(kind: string): string {
  const labels: Record<string, string> = {
    assertion: "主张", denial: "否认", question: "提问", answer: "回应", promise: "承诺",
    offer: "提议", acceptance: "接受", rejection: "拒绝", request: "请求", threat: "威胁",
    accusation: "指控", defense: "辩护", apology: "道歉", "alliance-proposal": "结盟",
    disclosure: "披露", endorsement: "背书", warning: "警告", silence: "沉默"
  };
  return labels[kind] ?? kind;
}

function deceptionStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planned: "计划中", attempted: "已执行", received: "已接收", believed: "已相信",
    "behaviorally-effective": "已影响行动", failed: "未奏效", abandoned: "已放弃",
    detected: "已识破", repaired: "已修复"
  };
  return labels[status] ?? status;
}

function commitmentStateLabel(state: ProjectedCommitment["state"]): string {
  return state === "proposed" ? "待结算" : state === "fulfilled" ? "已履约" : state === "violated" ? "已违约" : "已作废";
}

function ActivityCard({ toolCalls, names, avatarSeeds }: { toolCalls: RoomConnection["toolCalls"]; names: Map<string, string>; avatarSeeds: Map<string, string> }): ReactNode {
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
          <AgentAvatar name={call.actorName || names.get(call.actorId) || call.actorId} index={indexOf(call.actorId)} seed={avatarSeeds.get(call.actorId)} size="sm" />
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

/**
 * Endgame/high-tension moments, derived from real cues. Each highlight can be
 * expanded to show the surrounding timeline entries — the cause before it and
 * what followed — so the drama is clickable rather than just listed (§8.7).
 */
function HighlightsCard({ highlights, timeline, names, onJumpToAt }: { highlights: SocietyRoomSnapshot["highlights"]; timeline: TimelineEntry[]; names: Map<string, string>; onJumpToAt?: (at: string) => void }): ReactNode {
  const [expandedId, setExpandedId] = useState<string>();
  if (!highlights?.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-xs text-muted-foreground/80">
        <Sparkles className="size-3.5" />
        高光由高优先级镜头自动生成（淘汰、背叛、谎言揭穿、终局）——它们只会来自真实事件。
      </div>
    );
  }
  const contextAround = (at: string): TimelineEntry[] => timelineContextAround(timeline, at);
  return (
    <div className="space-y-1.5">
      {[...highlights].reverse().map((highlight) => {
        const open = expandedId === highlight.id;
        const context = open ? contextAround(highlight.at) : [];
        return (
          <div key={highlight.id} className="rounded-lg border border-border bg-card px-3 py-2.5">
            <button
              type="button"
              onClick={() => setExpandedId(open ? undefined : highlight.id)}
              className="flex w-full items-center gap-2 text-left"
              aria-expanded={open}
              title={open ? "收起前因后果" : "展开前因后果"}
            >
              <Clapperboard className="size-3.5 shrink-0 text-rose-400" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-foreground/90">{highlight.title}</span>
                {!open && highlight.subtitle ? <span className="mt-0.5 block truncate text-xs leading-5 text-muted-foreground">{highlight.subtitle}</span> : null}
              </span>
              <span className="nums shrink-0 font-mono text-[10px] font-normal text-muted-foreground/60">{formatTime(highlight.at)}</span>
              {onJumpToAt ? (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="定位到对话"
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-sky-300/80 transition-colors hover:bg-sky-400/10 hover:text-sky-200"
                  onClick={(e) => { e.stopPropagation(); onJumpToAt(highlight.at); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onJumpToAt(highlight.at); } }}
                >
                  定位
                </span>
              ) : null}
              <span className={cn("shrink-0 text-[10px] text-muted-foreground/70 transition-transform", open && "rotate-180")}>▾</span>
            </button>
            {open ? (
              <div className="mt-2 border-t border-border/60 pt-2">
                {highlight.subtitle ? <p className="text-xs leading-5 text-muted-foreground">{highlight.subtitle}</p> : null}
                {highlight.focusAgentIds.length ? (
                  <p className="mt-1 text-[11px] text-muted-foreground/70">焦点：{highlight.focusAgentIds.map((id) => names.get(id) ?? id).join("、")}</p>
                ) : null}
                {context.length ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/60">前因后果</p>
                    {context.map((entry) => (
                      <div key={`${entry.id}-${entry.at}`} className="flex items-start gap-2 rounded-md bg-muted/40 px-2 py-1.5">
                        <span className="nums mt-px shrink-0 font-mono text-[9px] text-muted-foreground/60">{formatTime(entry.at)}</span>
                        <span className="min-w-0 text-[11px] leading-4 text-muted-foreground">
                          {entry.actorId && names.get(entry.actorId) ? <span className="text-foreground/75">{names.get(entry.actorId)} · </span> : null}
                          <span className="font-medium text-foreground/75">{entry.label}</span>
                          {entry.detail ? <span className="text-muted-foreground"> — {entry.detail}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-muted-foreground/60">时间线缓冲区里没有更早的条目（较早事件已被窗口裁剪）。</p>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
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
  const seenRef = useRef<number>(0);

  useEffect(() => {
    if (world.status === "finished") return; // the finale belongs to the result card
    if (history.length <= seenRef.current) return;
    seenRef.current = history.length;
    const latest = history.at(-1);
    if (!latest) return;
    const text = beatText(latest, names, scenarioId);
    if (!text) return;
    toast(text, { id: `world-beat-${scenarioId}-${history.length}`, duration: 3_200 });
  }, [history, names, scenarioId, world]);

  return null;
}

function beatText(entry: Record<string, unknown>, names: Map<string, string>, scenarioId: ScenarioId): string | null {
  if (scenarioId === "werewolf") {
    const eliminated = entry.eliminatedId as string | undefined;
    if (entry.idiotSurvived) return `${names.get(eliminated ?? "") ?? eliminated} 亮出白痴身份，免死并失去投票权`;
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
      : `任务成功 —— 但胜负仍要等刺客的最后一剑`;
  }
  if (typeof entry.text === "string" && entry.text) return entry.text;
  return null;
}

function indexOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}
