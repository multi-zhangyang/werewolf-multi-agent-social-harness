import { useEffect, useRef, useState, type ReactNode } from "react";
import { Brain, Clapperboard, Crosshair, Drama, FlaskConical, HeartHandshake, Megaphone, Moon, Skull, Swords, Trophy, Users, Vote, X } from "lucide-react";
import type { CinematicCue, WorldSnapshot } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AgentAvatar, CollapsibleSection, formatTime, roleLabelZh } from "./shared";
import type { RoomTension } from "./use-room";

/**
 * The cinematic layer, rendered. The tension engine and director have always
 * computed their output from public facts; these components are the missing
 * consumers — a HUD for tension, a transient banner for camera cues, and the
 * endgame reveal that pays a whole game off.
 */

const TENSION_LEVELS = [
  { level: "calm", label: "平静" },
  { level: "warm", label: "升温" },
  { level: "tense", label: "紧张" },
  { level: "climax", label: "高潮" }
] as const;

/** Mirrors reasonLabel in tension-engine.ts — kept client-side so the browser
 * bundle never imports the server's director module. */
const TENSION_REASON_LABELS: Record<string, string> = {
  "direct-accusation": "公开指控",
  contradiction: "前后矛盾",
  betrayal: "背叛",
  "alliance-break": "联盟破裂",
  "vote-swing": "票型翻转",
  "role-action": "角色行动",
  "deception-exposed": "谎言揭穿",
  save: "绝处逢生",
  elimination: "淘汰",
  "win-condition-near": "胜负一线",
  "emotional-spike": "情绪爆发"
};

const TENSION_BAR_CLASSES = ["bg-foreground/35", "bg-foreground/55", "bg-warn/85", "bg-live"];
const TENSION_LABEL_CLASSES = ["text-muted-foreground/70", "text-muted-foreground", "text-warn", "text-live"];

/** Compact four-bar tension HUD for the phase strip. */
export function TensionMeter({ tension }: { tension: RoomTension | null }): ReactNode {
  if (!tension) return null;
  const levelIndex = TENSION_LEVELS.findIndex((entry) => entry.level === tension.level);
  if (levelIndex < 0) return null;
  const barClass = TENSION_BAR_CLASSES[levelIndex]!;
  const reasons = tension.reasons.map((reason) => TENSION_REASON_LABELS[reason] ?? reason);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex shrink-0 items-center gap-1.5"
          aria-label={`当前张力：${TENSION_LEVELS[levelIndex]!.label}`}
        >
          <span className="flex items-end gap-[2px]" aria-hidden>
            {TENSION_LEVELS.map((_, bar) => (
              <span
                key={bar}
                className={cn("w-[3px] rounded-full transition-colors duration-500", bar <= levelIndex ? barClass : "bg-foreground/12")}
                style={{ height: `${3 + bar * 2.5}px` }}
              />
            ))}
          </span>
          <span className={cn("text-[10px] leading-none transition-colors duration-500", TENSION_LABEL_CLASSES[levelIndex]!)}>
            {TENSION_LEVELS[levelIndex]!.label}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        <p className="font-medium">{TENSION_LEVELS[levelIndex]!.label} · {Math.round(tension.score * 100)}%</p>
        {reasons.length ? <p className="mt-0.5 text-muted-foreground">{reasons.join(" · ")}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}

const CAMERA_META: Record<string, { icon: typeof Brain; className: string }> = {
  speaker: { icon: Megaphone, className: "text-muted-foreground" },
  "tool-action": { icon: Megaphone, className: "text-muted-foreground" },
  duel: { icon: Swords, className: "text-warn" },
  "vote-board": { icon: Vote, className: "text-warn" },
  "role-reveal": { icon: Drama, className: "text-secret" },
  elimination: { icon: Skull, className: "text-warn" },
  "wide-table": { icon: Users, className: "text-muted-foreground" },
  "agent-mind": { icon: Brain, className: "text-secret" },
  endgame: { icon: Trophy, className: "text-warn" },
  relationship: { icon: HeartHandshake, className: "text-live" }
};

/**
 * Transient banner for the director's camera cues. The server already
 * throttles to one cue per 900ms; the banner holds each for its own
 * minimum duration (floor 3s, ceiling 6s) and never intercepts clicks.
 * Low-priority speaker cues stay out — every turn would be noise.
 */
export function CueBanner({ cue, names, minPriority = 4 }: {
  cue: CinematicCue | null;
  names: Map<string, string>;
  minPriority?: number;
}): ReactNode {
  const [visible, setVisible] = useState(false);
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cue || cue.id === lastIdRef.current) return;
    lastIdRef.current = cue.id;
    setVisible(true);
  }, [cue]);

  useEffect(() => {
    if (!cue) return;
    const duration = Math.min(Math.max(cue.minimumDurationMs, 3_000), 6_000);
    const timer = window.setTimeout(() => setVisible(false), duration);
    return () => window.clearTimeout(timer);
  }, [cue]);

  if (!cue || !visible || cue.priority < minPriority) return null;
  const meta = CAMERA_META[cue.camera] ?? { icon: Clapperboard, className: "text-muted-foreground" };
  const focus = cue.focusAgentIds.map((id) => names.get(id) ?? id).slice(0, 4);
  return (
    <div key={cue.id} className="cue-enter pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-5" aria-live="polite">
      <div className="flex max-w-lg items-center gap-2.5 rounded-full border border-border/70 bg-card/85 py-1.5 pl-3 pr-4 shadow-[0_10px_30px_-12px_oklch(0_0_0/0.55)] backdrop-blur-md">
        <meta.icon className={cn("size-3.5 shrink-0", meta.className)} aria-hidden />
        <span className="min-w-0 shrink-0 text-xs font-medium tracking-tight">{cue.title}</span>
        {cue.subtitle
          ? <span className="min-w-0 truncate text-[11px] text-muted-foreground">{cue.subtitle}</span>
          : focus.length
            ? <span className="min-w-0 truncate text-[11px] text-muted-foreground">{focus.join(" · ")}</span>
            : null}
      </div>
    </div>
  );
}

export interface EndgameSummary {
  /** The decisive line — the win beat from the world log when one exists. */
  headline: string;
}

export function buildEndgameSummary(world: Pick<WorldSnapshot, "log">): EndgameSummary {
  for (let index = world.log.length - 1; index >= 0; index -= 1) {
    const entry = world.log[index];
    if (entry?.beat === "win") return { headline: entry.text };
  }
  const last = world.log[world.log.length - 1];
  return { headline: last?.text ?? "对局已结束" };
}

/**
 * The payoff screen: winner line, full role roster and the highlight reel.
 * Data arrives from snapshots — observerRole is only present where the
 * viewer's boundary permits it, so what this shows is always what the
 * viewer may see.
 */
export function EndgameOverlay({ room, avatarSeedFor, onDismiss }: {
  room: SocietyRoomSnapshot;
  avatarSeedFor: (actorId: string) => string | undefined;
  onDismiss: () => void;
}): ReactNode {
  const world = room.world;
  const summary = buildEndgameSummary(world);
  const highlights = room.highlights ?? [];
  const agents = [...world.agents].sort((left, right) => Number(left.alive) - Number(right.alive));

  // Model-vs-model standings for THIS game: faction winners plus scores,
  // aggregated per engine. Public end-of-game facts only.
  const winners = new Set((world.details.winners as string[] | undefined) ?? []);
  const perModel = new Map<string, { seats: number; wins: number; scoreSum: number; scoreCount: number }>();
  for (const participant of room.participants) {
    const model = participant.profile.model;
    if (!model || model === "human") continue;
    const entry = perModel.get(model) ?? { seats: 0, wins: 0, scoreSum: 0, scoreCount: 0 };
    entry.seats += 1;
    if (winners.has(participant.profile.id)) entry.wins += 1;
    const score = world.agents.find((agent) => agent.id === participant.profile.id)?.score;
    if (typeof score === "number") {
      entry.scoreSum += score;
      entry.scoreCount += 1;
    }
    perModel.set(model, entry);
  }
  const modelRows = [...perModel.entries()]
    .map(([model, entry]) => ({
      model,
      seats: entry.seats,
      wins: entry.wins,
      avgScore: entry.scoreCount ? entry.scoreSum / entry.scoreCount : undefined
    }))
    .sort((left, right) => right.wins - left.wins || (right.avgScore ?? 0) - (left.avgScore ?? 0));
  const humanSeats = room.participants.filter((participant) => participant.profile.model === "human").length;
  return (
    <div className="absolute inset-0 z-20 overflow-y-auto bg-background/92 backdrop-blur-md">
      <div className="reveal-up mx-auto flex w-full max-w-xl flex-col gap-7 px-6 py-10">
        <div className="flex flex-col items-center gap-2.5 text-center">
          <span className="flex size-11 items-center justify-center rounded-2xl border border-warn/25 bg-warn/10">
            <Trophy className="size-5 text-warn" aria-hidden />
          </span>
          <p className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground">终局揭晓</p>
          <h2 className="max-w-md text-balance text-xl font-semibold leading-snug tracking-tight">{summary.headline}</h2>
        </div>

        <section aria-label="身份揭晓" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {agents.map((agent) => {
            const roleLine = agent.observerRole
              ? roleLabelZh(agent.observerRole)
              : agent.alive
                ? "存活 · 身份随视角公开"
                : "出局";
            return (
              <div
                key={agent.id}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border px-3 py-2",
                  agent.alive ? "border-border/60 bg-card/40" : "border-border/60 bg-muted/30"
                )}
              >
                <AgentAvatar name={agent.displayName} seed={avatarSeedFor(agent.id)} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium leading-tight">{agent.displayName}</p>
                  <p className="mt-1 truncate text-[11px] leading-none text-muted-foreground">{roleLine}</p>
                </div>
                {agent.score !== undefined ? <span className="nums shrink-0 font-mono text-xs">{agent.score}</span> : null}
              </div>
            );
          })}
        </section>

        {modelRows.length ? (
          <section aria-label="模型战绩" className="flex flex-col gap-2">
            <p className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground">模型战绩</p>
            <ul className="flex flex-col gap-1.5">
              {modelRows.map((row) => (
                <li key={row.model} className="flex items-baseline gap-2.5 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight">{row.model}</span>
                  <span className="nums shrink-0 font-mono text-[11px] text-muted-foreground">
                    {row.seats} 席{winners.size ? ` · 胜 ${row.wins}` : ""}{row.avgScore !== undefined ? ` · 均分 ${Math.round(row.avgScore * 100) / 100}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {humanSeats ? <p className="text-[11px] leading-4 text-muted-foreground/70">{humanSeats} 个真人席位不计入模型战绩。</p> : null}
          </section>
        ) : null}

        {highlights.length ? (
          <section aria-label="本场高光" className="flex flex-col gap-2">
            <p className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground">本场高光</p>
            <ol className="flex flex-col gap-1.5">
              {highlights.map((highlight) => (
                <li key={highlight.id} className="flex items-baseline gap-2.5 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
                  <time className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{formatTime(highlight.at, { seconds: false })}</time>
                  <span className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium leading-tight">{highlight.title}</span>
                    {highlight.subtitle
                      ? <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground">{highlight.subtitle}</span>
                      : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <Button variant="outline" size="sm" className="mx-auto" onClick={onDismiss}>
          查看完整对局记录
        </Button>
      </div>
    </div>
  );
}

/** What one published day-record says happened (werewolf / avalon style worlds). */
export interface DayHistoryRecord {
  day: number;
  votes?: Record<string, string>;
  eliminatedId?: string;
  eliminatedRole?: string;
  idiotSurvived?: boolean;
  nightKillId?: string;
  nightKillRole?: string;
  poisonId?: string;
  shotId?: string;
  shotRole?: string;
  boomVictims?: string[];
  charmVictim?: string;
}

export function dayHistory(details: Record<string, unknown>): DayHistoryRecord[] {
  const value = details.history;
  if (!Array.isArray(value)) return [];
  return value.filter((record): record is DayHistoryRecord =>
    Boolean(record) && typeof (record as DayHistoryRecord).day === "number"
  );
}

function nightEvents(record: DayHistoryRecord): Array<{ key: string; icon: typeof Skull; label: string; detail: string; role?: string; tone: "kill" | "side" }> {
  const events: Array<{ key: string; icon: typeof Skull; label: string; detail: string; role?: string; tone: "kill" | "side" }> = [];
  if (record.nightKillId) {
    events.push({ key: "kill", icon: Skull, label: "遇袭", detail: "夜里被狼人杀害", role: record.nightKillRole, tone: "kill" });
  }
  if (record.poisonId) {
    events.push({ key: "poison", icon: FlaskConical, label: "中毒", detail: "被女巫毒杀", role: undefined, tone: "kill" });
  }
  if (record.shotId) {
    events.push({ key: "shot", icon: Crosshair, label: "开枪", detail: "猎人临终带走", role: record.shotRole, tone: "kill" });
  }
  if (record.boomVictims?.length) {
    events.push({ key: "boom", icon: Skull, label: "引爆", detail: `白狼王引爆带走 ${record.boomVictims.length} 人`, tone: "side" });
  }
  if (record.charmVictim) {
    events.push({ key: "charm", icon: HeartHandshake, label: "魅惑", detail: "狼美人魅惑了同伴", tone: "side" });
  }
  return events;
}

/**
 * Dawn reveal: when a day-record gains its night results, the resolution takes
 * the stage above the stream for a moment. Only already-public facts — the
 * world announces these in the same snapshot's log.
 */
export function NightRevealBanner({ world }: { world: SocietyRoomSnapshot["world"] }): ReactNode {
  const history = dayHistory(world.details);
  const last = history.at(-1);
  const names = new Map(world.agents.map((agent) => [agent.id, agent.displayName]));
  const [visible, setVisible] = useState(false);
  const [record, setRecord] = useState<DayHistoryRecord | null>(null);
  const signatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!last) return;
    const signature = [last.day, last.nightKillId, last.poisonId, last.shotId, last.boomVictims?.join(","), last.charmVictim].join("|");
    if (signature === signatureRef.current) return;
    signatureRef.current = signature;
    if (!nightEvents(last).length) return;
    setRecord(last);
    setVisible(true);
  }, [last]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!record || !visible) return null;
  const events = nightEvents(record);
  const nameOf = (id: string): string => names.get(id) ?? id;
  return (
    <div className="reveal-up absolute inset-x-0 top-3 z-10 mx-auto flex w-[min(94%,30rem)] flex-col gap-2.5 rounded-xl border border-warn/30 bg-card/95 p-4 shadow-[0_18px_50px_-16px_oklch(0_0_0/0.6)] backdrop-blur-md" role="status" aria-live="polite">
      <header className="flex items-center gap-2">
        <Moon className="size-3.5 text-warn" aria-hidden />
        <span className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground">第 {record.day} 天 · 夜晚结算</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6 text-muted-foreground/70 hover:text-foreground"
          aria-label="关闭夜晚结算"
          onClick={() => setVisible(false)}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </header>
      <ul className="flex flex-col gap-1.5">
        {events.map((event) => {
          const id = event.key === "kill" ? record.nightKillId
            : event.key === "poison" ? record.poisonId
              : event.key === "shot" ? record.shotId
                : event.key === "charm" ? record.charmVictim
                  : undefined;
          return (
            <li key={event.key} className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/25 px-3 py-2">
              <event.icon className={cn("size-4 shrink-0", event.tone === "kill" ? "text-warn" : "text-secret")} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {id ? <span className="font-medium">{nameOf(id)}</span> : null}
                <span className="text-muted-foreground"> · {event.detail}</span>
              </span>
              {event.role ? <Badge variant="outline" className="shrink-0 text-[10px]">{roleLabelZh(event.role)}</Badge> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Beat-tinted storyline markers; unlisted beats stay neutral. */
const BEAT_TONE: Record<string, string> = {
  win: "bg-warn",
  betrayal: "bg-warn",
  "deception-exposed": "bg-warn",
  "promise-broken": "bg-warn",
  comeback: "bg-live",
  "promise-kept": "bg-live",
  alliance: "bg-live",
  "hidden-role-revealed": "bg-secret"
};

/**
 * In-page chapter navigation: one marker per world-log entry, tinted by its
 * story beat; clicking scrolls the stream to that retained moment. The strip
 * stays glued to the newest marker.
 */
export function StorylineBar({ world }: { world: SocietyRoomSnapshot["world"] }): ReactNode {
  const barRef = useRef<HTMLDivElement>(null);
  const log = world.log;
  const logKey = `${log.length}:${log.at(-1)?.id ?? ""}`;

  useEffect(() => {
    const bar = barRef.current;
    if (bar) bar.scrollLeft = bar.scrollWidth;
  }, [logKey]);

  if (log.length < 2) return null;
  let lastTurn = -1;
  return (
    <div
      ref={barRef}
      className="rule-b flex h-7 shrink-0 items-center gap-1 overflow-x-auto px-5 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="故事线导航"
    >
      <span className="shrink-0 pr-0.5 font-mono text-[10px] text-muted-foreground/60">故事线</span>
      {log.map((entry) => {
        const turnBoundary = entry.turn !== lastTurn;
        lastTurn = entry.turn;
        return (
          <span key={entry.id} className="flex shrink-0 items-center gap-1">
            {turnBoundary ? <span className="nums font-mono text-[9px] text-muted-foreground/40">R{entry.turn}</span> : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  aria-label={`跳转到：${entry.text}`}
                  className="group size-3 rounded-full p-0"
                  onClick={() => document.getElementById(`anchor:log:${entry.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                >
                  <span className={cn("size-1.5 rounded-full transition-transform duration-200 group-hover:scale-[1.8]", BEAT_TONE[entry.beat ?? ""] ?? "bg-foreground/25")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                <p className="font-mono text-[10px] text-muted-foreground">{formatTime(entry.at, { seconds: false })}</p>
                <p className="mt-0.5">{entry.text}</p>
              </TooltipContent>
            </Tooltip>
          </span>
        );
      })}
    </div>
  );
}

/**
 * The game's calendar for the causality rail: one day chip per record; the
 * selected day shows its night results and the full vote board. Renders
 * nothing for worlds without a published history.
 */
export function DayHistorySection({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const history = dayHistory(room.world.details);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  if (!history.length) return null;
  const active = history.find((record) => record.day === selectedDay) ?? history[history.length - 1]!;
  const names = new Map(room.world.agents.map((agent) => [agent.id, agent.displayName]));
  const nameOf = (id: string): string => names.get(id) ?? id;

  const tally = new Map<string, string[]>();
  for (const [voter, target] of Object.entries(active.votes ?? {})) {
    tally.set(target, [...(tally.get(target) ?? []), voter]);
  }
  const rows = [...tally.entries()].sort((left, right) => right[1].length - left[1].length);
  const maxCount = rows[0]?.[1].length ?? 1;
  const events = nightEvents(active);

  return (
    <CollapsibleSection title="对局日历" count={history.length} defaultOpen contentClassName="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {history.map((record) => (
          <Button
            key={record.day}
            variant="outline"
            size="sm"
            aria-pressed={record.day === active.day}
            onClick={() => setSelectedDay(record.day)}
            className={cn(
              "h-6 gap-1.5 rounded-full px-2.5 font-mono text-[11px] font-normal",
              record.day === active.day
                ? "border-foreground/35 bg-muted text-foreground"
                : "border-border/70 bg-transparent text-muted-foreground"
            )}
          >
            D{record.day}
            {nightEvents(record).length ? <Skull className="size-3 text-warn/80" aria-hidden /> : null}
            {record.eliminatedId && !record.idiotSurvived ? <Vote className="size-3 text-muted-foreground/70" aria-hidden /> : null}
          </Button>
        ))}
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground">第 {active.day} 天 · 夜晚</p>
        {events.length ? (
          <ul className="space-y-1">
            {events.map((event) => {
              const id = event.key === "kill" ? active.nightKillId
                : event.key === "poison" ? active.poisonId
                  : event.key === "shot" ? active.shotId
                    : event.key === "charm" ? active.charmVictim
                      : undefined;
              return (
                <li key={event.key} className="flex items-center gap-2 text-xs leading-5">
                  <event.icon className="size-3 shrink-0 text-warn/80" aria-hidden />
                  <span className="truncate">{id ? <span className="font-medium">{nameOf(id)}</span> : null}<span className="text-muted-foreground"> · {event.detail}</span></span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">平安夜——没有夜间事件。</p>
        )}
      </div>

      {rows.length ? (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground">放逐投票</p>
          <ul className="space-y-1.5">
            {rows.map(([target, voters]) => (
              <li key={target} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className={cn("w-16 shrink-0 truncate text-xs", target === active.eliminatedId ? "font-semibold text-warn" : "font-medium")}>{nameOf(target)}</span>
                  <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/8">
                    <span
                      className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-700", target === active.eliminatedId ? "bg-warn/80" : "bg-foreground/45")}
                      style={{ width: `${Math.max(6, (voters.length / maxCount) * 100)}%` }}
                    />
                  </span>
                  <span className="nums shrink-0 font-mono text-[11px] text-muted-foreground">{voters.length}</span>
                </div>
                <p className="truncate pl-[4.5rem] text-[11px] leading-4 text-muted-foreground/80">{voters.map(nameOf).join(" · ")}</p>
              </li>
            ))}
          </ul>
          {active.idiotSurvived ? <p className="text-[11px] text-warn">白痴翻牌——免于放逐，但失去投票权。</p> : null}
          {!active.eliminatedId && !active.idiotSurvived ? <p className="text-[11px] text-muted-foreground">平票——本日无人出局。</p> : null}
        </div>
      ) : null}
    </CollapsibleSection>
  );
}
