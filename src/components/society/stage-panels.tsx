/**
 * World stage panels (AGENTS.md §8.12): four stage languages, one per world
 * family. Presentation-only — every value comes from the observer-safe world
 * snapshot; nothing here can influence the game.
 *
 *   hidden-identity  — werewolf / avalon: suspicion heat + vote history + quest board
 *   duel-negotiation — negotiation / trust / ultimatum / prisoners: split-screen duel + stakes
 *   risk-escalation  — liars-dice / centipede / chicken / stag-hunt: pot growth + lives
 *   secret-submit    — public-goods / beauty-contest / sealed-bid: submission grid + reveal
 */
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SocietyRoomSnapshot } from "@/society/room";
import { AgentAvatar } from "./shared";

type Details = Record<string, unknown>;

function scoreOf(details: Details, id: string): number | undefined {
  const scores = details.scores as Record<string, number> | undefined;
  const value = scores?.[id];
  return typeof value === "number" ? value : undefined;
}

function num(details: Details, key: string): number | undefined {
  const value = details[key];
  return typeof value === "number" ? value : undefined;
}

function str(details: Details, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
}

function entries(details: Details, key: string): Record<string, number> {
  const value = details[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, number> : {};
}

function stringList(details: Details, key: string): string[] {
  const value = details[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function historyOf(details: Details): unknown[] {
  const value = details.history;
  return Array.isArray(value) ? value : [];
}

function useNames(room: SocietyRoomSnapshot): { nameOf: (id: string) => string; indexOf: (id: string) => number } {
  const names = new Map(room.participants.map((p) => [p.profile.id, p.profile.displayName]));
  const index = new Map(room.participants.map((p, i) => [p.profile.id, i]));
  return {
    nameOf: (id) => names.get(id) ?? id,
    indexOf: (id) => index.get(id) ?? 0
  };
}

function PanelShell({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <div className="mt-3 rounded-xl border border-white/[0.07] bg-[#080808] p-3.5">
      <div className="mb-2.5 flex items-center justify-between px-0.5">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-foreground/65">{title}</p>
        {hint ? <span className="nums font-mono text-[10px] text-muted-foreground/70">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 1. Hidden-identity round table (werewolf / avalon)                 *
 * ------------------------------------------------------------------ */

function SuspicionBars({ suspicion, room }: { suspicion: Record<string, number>; room: SocietyRoomSnapshot }): ReactNode {
  const { nameOf } = useNames(room);
  const rows = Object.entries(suspicion)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!rows.length) return <p className="text-[11px] text-muted-foreground/60">群体怀疑尚未升温。</p>;
  const max = Math.max(...rows.map(([, score]) => score), 1);
  return (
    <div className="space-y-1.5">
      {rows.map(([id, score]) => (
        <div key={id} className="flex items-center gap-2.5">
          <span className="w-14 shrink-0 truncate text-[11px] text-foreground/85">{nameOf(id)}</span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className={cn("h-full rounded-full transition-all duration-700", score / max > 0.66 ? "bg-rose-400/80" : score / max > 0.33 ? "bg-amber-400/70" : "bg-orange-400/50")}
              style={{ width: `${Math.round((score / max) * 100)}%` }}
            />
          </div>
          <span className="nums w-8 shrink-0 text-right font-mono text-[10px] text-muted-foreground/70">{score.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

function VoteHistory({ details, room }: { details: Details; room: SocietyRoomSnapshot }): ReactNode {
  const { nameOf } = useNames(room);
  const last = historyOf(details).at(-1) as { votes?: Record<string, string>; day?: number } | undefined;
  const votes = last?.votes;
  if (!votes) return null;
  const tally = new Map<string, number>();
  for (const target of Object.values(votes)) tally.set(target, (tally.get(target) ?? 0) + 1);
  const rows = [...tally].sort((a, b) => b[1] - a[1]);
  return (
    <div className="mt-3 border-t border-white/[0.05] pt-2.5">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">最近投票 · 第 {last.day} 天</p>
      <div className="flex flex-wrap gap-1.5">
        {rows.map(([targetId, count]) => (
          <span key={targetId} className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 text-[10px] text-foreground/80">
            <span className="size-1.5 rounded-full bg-rose-400/70" />
            {nameOf(targetId)}
            <span className="nums font-mono text-muted-foreground/70">{count} 票</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function AvalonQuestBoard({ details, room }: { details: Details; room: SocietyRoomSnapshot }): ReactNode {
  const { nameOf, indexOf } = useNames(room);
  const successes = num(details, "successes") ?? 0;
  const failures = num(details, "failures") ?? 0;
  const team = stringList(details, "proposedTeam");
  const teamVotes = entries(details, "pendingTeamVotes");
  const ladyInspectId = str(details, "ladyInspectId") ?? null;
  const maxQuests = 5;
  const currentQuest = successes + failures;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: maxQuests }).map((_, i) => {
          const done = i < currentQuest;
          const failed = i < failures;
          return (
            <span key={i} className={cn("h-1.5 w-6 rounded-full", failed ? "bg-rose-400/80" : done ? "bg-emerald-400/80" : "bg-white/[0.07]")} />
          );
        })}
        <span className="nums ml-1 font-mono text-[10px] text-muted-foreground/70">
          胜 {successes} · 负 {failures} · 第 {currentQuest + 1} 个任务
        </span>
      </div>
      {team.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/60">队伍</span>
          {team.map((id) => (
            <span key={id} className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 text-[10px]">
              <AgentAvatar name={nameOf(id)} index={indexOf(id)} size="sm" />
              {nameOf(id)}
            </span>
          ))}
        </div>
      ) : null}
      {Object.keys(teamVotes).length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/60">表决</span>
          {Object.entries(teamVotes).map(([id, v]) => (
            <span key={id} className={cn("rounded-full border px-2 py-0.5 text-[10px]", v > 0 ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-rose-400/30 bg-rose-400/10 text-rose-300")}>
              {nameOf(id)} {v > 0 ? "赞成" : "反对"}
            </span>
          ))}
        </div>
      ) : null}
      {ladyInspectId ? (
        <p className="text-[10px] text-violet-300/80">湖中仙女正在查验 {nameOf(ladyInspectId)}</p>
      ) : null}
    </div>
  );
}

export function HiddenIdentityStage({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const details = room.world.details as Details;
  if (room.scenarioId === "avalon") {
    return (
      <PanelShell title="任务战线" hint={room.world.phase}>
        <AvalonQuestBoard details={details} room={room} />
      </PanelShell>
    );
  }
  const suspicionRoot = details.suspicion as { scores?: Record<string, number> } | undefined;
  const suspicion = suspicionRoot?.scores ?? {};
  return (
    <PanelShell title="怀疑氛围" hint={room.world.phase}>
      <SuspicionBars suspicion={suspicion} room={room} />
      <VoteHistory details={details} room={room} />
    </PanelShell>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Duel / negotiation split-screen                                 *
 * ------------------------------------------------------------------ */

function SideCard({ room, id, label, detail }: { room: SocietyRoomSnapshot; id: string; label: string; detail?: string }): ReactNode {
  const { nameOf, indexOf } = useNames(room);
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-white/[0.07] bg-white/[0.015] px-3.5 py-3">
      <div className="flex items-center gap-2">
        <AgentAvatar name={nameOf(id)} index={indexOf(id)} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold tracking-tight">{nameOf(id)}</p>
          <p className="text-[10px] text-muted-foreground/75">{label}</p>
        </div>
      </div>
      {detail ? <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-foreground/80">{detail}</p> : null}
    </div>
  );
}

export function DuelStage({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const details = room.world.details as Details;
  const ids = room.participants.map((p) => p.profile.id);
  const [left, right] = ids;
  const leftScore = left ? scoreOf(details, left) : undefined;
  const rightScore = right ? scoreOf(details, right) : undefined;
  const investorId = str(details, "investorId");
  const trusteeId = str(details, "trusteeId");
  const proposerId = str(details, "proposerId");
  const responderId = str(details, "responderId");
  const roleOf = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    if (investorId === id) return "投资人";
    if (trusteeId === id) return "受托人";
    if (proposerId === id) return "提议者";
    if (responderId === id) return "回应者";
    return undefined;
  };
  const detailOf = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    const pending = [...stringList(details, "pendingDemands"), ...stringList(details, "pendingChoices")];
    if (pending.includes(id)) return "已提交绑定行动，等待对方…";
    return undefined;
  };
  const pot = num(details, "pot");
  const endowment = num(details, "endowment");
  const multiplier = num(details, "multiplier");
  const offer = num(details, "offer");
  const hintParts = [
    multiplier !== undefined && room.scenarioId !== "ultimatum-game" ? `×${multiplier}` : null,
    pot !== undefined ? `奖池 ${pot}` : null,
    endowment !== undefined ? `本金 ${endowment}` : null,
    offer !== undefined ? `当前报价 ${offer}` : null
  ].filter(Boolean);
  return (
    <PanelShell title="对局" hint={hintParts.join(" · ") || room.world.phase}>
      <div className="flex items-stretch gap-2.5">
        <SideCard room={room} id={left} label={roleOf(left) ?? "左席"} detail={detailOf(left)} />
        <div className="flex flex-col items-center justify-center gap-1 px-0.5">
          <span className="nums font-mono text-[11px] text-foreground/80">{leftScore ?? "—"}</span>
          <span className="text-[9px] font-bold tracking-widest text-muted-foreground/50">VS</span>
          <span className="nums font-mono text-[11px] text-foreground/80">{rightScore ?? "—"}</span>
        </div>
        <SideCard room={room} id={right} label={roleOf(right) ?? "右席"} detail={detailOf(right)} />
      </div>
    </PanelShell>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Risk escalation (pot growth / lives / thresholds)               *
 * ------------------------------------------------------------------ */

export function RiskStage({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const details = room.world.details as Details;
  const { nameOf, indexOf } = useNames(room);
  if (room.scenarioId === "liars-dice") {
    const lives = entries(details, "lives");
    return (
      <PanelShell title="赌注与生命" hint={room.world.phase}>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(lives).map(([id, livesLeft]) => (
            <span key={id} className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]", livesLeft > 0 ? "border-white/[0.08] bg-white/[0.02] text-foreground/85" : "border-rose-400/30 bg-rose-400/[0.06] text-rose-300/80 line-through")}>
              <AgentAvatar name={nameOf(id)} index={indexOf(id)} size="sm" />
              {nameOf(id)}
              <span className="nums font-mono text-[10px] text-muted-foreground/75">{livesLeft} ❤</span>
            </span>
          ))}
        </div>
      </PanelShell>
    );
  }
  const pot = num(details, "pot");
  const scores = entries(details, "scores");
  const maxScore = Math.max(...Object.values(scores), 1);
  return (
    <PanelShell title="奖池与分数" hint={pot !== undefined ? `当前奖池 ${pot}` : room.world.phase}>
      {Object.keys(scores).length === 0 ? (
        <p className="text-[11px] text-muted-foreground/60">尚未结算。</p>
      ) : (
        <div className="space-y-1.5">
          {Object.entries(scores).map(([id, score]) => (
            <div key={id} className="flex items-center gap-2.5">
              <AgentAvatar name={nameOf(id)} index={indexOf(id)} size="sm" />
              <span className="w-12 shrink-0 truncate text-[11px] text-foreground/85">{nameOf(id)}</span>
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                <div className="h-full rounded-full bg-gradient-to-r from-emerald-400/70 to-emerald-300/60 transition-all duration-700" style={{ width: `${Math.round((score / maxScore) * 100)}%` }} />
              </div>
              <span className="nums w-8 shrink-0 text-right font-mono text-[11px] text-foreground/85">{score}</span>
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

/* ------------------------------------------------------------------ *
 * 4. Secret submission grid (contributions / choices / bids)         *
 * ------------------------------------------------------------------ */

export function SecretStage({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const details = room.world.details as Details;
  const { nameOf, indexOf } = useNames(room);
  const pendingKey = room.scenarioId === "sealed-bid-auction" ? "pendingBids" : room.scenarioId === "public-goods" ? "pendingContributions" : "pendingChoices";
  const pending = stringList(details, pendingKey);
  const submittedIds = new Set(room.participants.map((p) => p.profile.id).filter((id) => !pending.includes(id)));
  const hint = room.scenarioId === "beauty-contest"
    ? "目标 = 平均 × 2/3"
    : room.scenarioId === "sealed-bid-auction"
      ? `出价区间 ${num(details, "minBid") ?? "?"}–${num(details, "maxBid") ?? "?"}`
      : room.scenarioId === "public-goods" && num(details, "multiplier")
        ? `公共池 ×${num(details, "multiplier")}`
        : room.world.phase;
  return (
    <PanelShell title="秘密提交" hint={hint}>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {room.participants.map((p) => {
          const id = p.profile.id;
          const submitted = submittedIds.has(id);
          const score = scoreOf(details, id);
          return (
            <div key={id} className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-1.5", submitted ? "border-emerald-400/25 bg-emerald-400/[0.04]" : "border-white/[0.07] bg-white/[0.015]")}>
              <AgentAvatar name={nameOf(id)} index={indexOf(id)} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium text-foreground/85">{nameOf(id)}</p>
                <p className={cn("text-[10px]", submitted ? "text-emerald-300/80" : "text-muted-foreground/60")}>
                  {room.world.status === "finished" ? (score !== undefined ? `分数 ${score}` : "已揭示") : submitted ? "已密封" : "待提交"}
                </p>
              </div>
              {submitted ? <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" /> : null}
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

/* ------------------------------------------------------------------ *
 * Router                                                             *
 * ------------------------------------------------------------------ */

const HIDDEN_IDENTITY = new Set(["werewolf", "avalon"]);
const DUEL = new Set(["negotiation-game", "trust-game", "ultimatum-game", "prisoners-dilemma"]);
const RISK = new Set(["liars-dice", "centipede-game", "chicken-game", "stag-hunt"]);
const SECRET = new Set(["public-goods", "beauty-contest", "sealed-bid-auction"]);

export function WorldStagePanel({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  if (HIDDEN_IDENTITY.has(room.scenarioId)) return <HiddenIdentityStage room={room} />;
  if (DUEL.has(room.scenarioId)) return <DuelStage room={room} />;
  if (RISK.has(room.scenarioId)) return <RiskStage room={room} />;
  if (SECRET.has(room.scenarioId)) return <SecretStage room={room} />;
  return null;
}