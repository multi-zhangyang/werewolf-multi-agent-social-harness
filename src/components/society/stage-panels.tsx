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
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
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

function useNames(room: SocietyRoomSnapshot): { nameOf: (id: string) => string; indexOf: (id: string) => number; seedOf: (id: string) => string | undefined } {
  const names = new Map(room.participants.map((p) => [p.profile.id, p.profile.displayName]));
  const index = new Map(room.participants.map((p, i) => [p.profile.id, i]));
  const seeds = new Map(room.participants.map((p) => [p.profile.id, p.profile.characterId]));
  return {
    nameOf: (id) => names.get(id) ?? id,
    indexOf: (id) => index.get(id) ?? 0,
    seedOf: (id) => seeds.get(id)
  };
}

function PanelShell({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <Card className="mt-3 gap-2.5 rounded-xl py-3.5 shadow-none">
      <CardHeader className="px-3.5">
        <CardTitle className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{title}</CardTitle>
        {hint ? <CardAction><span className="nums font-mono text-[10px] text-muted-foreground">{hint}</span></CardAction> : null}
      </CardHeader>
      <CardContent className="px-3.5">{children}</CardContent>
    </Card>
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
  if (!rows.length) return <p className="text-[11px] text-muted-foreground">群体怀疑尚未升温。</p>;
  const max = Math.max(...rows.map(([, score]) => score), 1);
  return (
    <div className="space-y-1.5">
      {rows.map(([id, score]) => (
        <div key={id} className="flex items-center gap-2.5">
          <span className="w-14 shrink-0 truncate text-[11px] text-foreground/85">{nameOf(id)}</span>
          <Progress
            value={Math.round((score / max) * 100)}
            className={cn(
              "h-1.5 min-w-0 flex-1",
              score / max > 0.66
                ? "[&>[data-slot=progress-indicator]]:bg-rose-400/80"
                : score / max > 0.33
                  ? "[&>[data-slot=progress-indicator]]:bg-amber-400/70"
                  : "[&>[data-slot=progress-indicator]]:bg-orange-400/50"
            )}
            aria-label={`${nameOf(id)} 被怀疑程度 ${score.toFixed(1)}`}
          />
          <span className="nums w-8 shrink-0 text-right font-mono text-[10px] text-muted-foreground">{score.toFixed(1)}</span>
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
    <div className="mt-3">
      <Separator className="mb-2.5" />
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">最近投票 · 第 {last.day} 天</p>
      <div className="flex flex-wrap gap-1.5">
        {rows.map(([targetId, count]) => (
          <Badge key={targetId} variant="outline" className="gap-1 rounded-full px-2 py-0.5 text-[10px] font-normal text-foreground/80">
            <span className="size-1.5 rounded-full bg-rose-400/70" />
            {nameOf(targetId)}
            <span className="nums font-mono text-muted-foreground">{count} 票</span>
          </Badge>
        ))}
      </div>
    </div>
  );
}

function AvalonQuestBoard({ details, room }: { details: Details; room: SocietyRoomSnapshot }): ReactNode {
  const { nameOf, indexOf, seedOf } = useNames(room);
  const successes = num(details, "successes") ?? 0;
  const failures = num(details, "failures") ?? 0;
  const team = stringList(details, "proposedTeam");
  const teamVotes = entries(details, "pendingTeamVotes");
  const ladyInspectId = str(details, "ladyInspectId") ?? null;
  const outcome = str(details, "outcome");
  const maxQuests = 5;
  const currentQuest = successes + failures;
  return (
    <div className="space-y-2.5">
      {outcome ? (
        <p className="text-[11px] leading-4 text-foreground/80">{outcome}</p>
      ) : null}
      <div className="flex items-center gap-1.5">
        {Array.from({ length: maxQuests }).map((_, i) => {
          const done = i < currentQuest;
          const failed = i < failures;
          return (
            <span key={i} className={cn("h-1.5 w-6 rounded-full", failed ? "bg-rose-400/80" : done ? "bg-emerald-400/80" : "bg-muted")} />
          );
        })}
        <span className="nums ml-1 font-mono text-[10px] text-muted-foreground">
          {room.world.status === "finished" ? `胜 ${successes} · 负 ${failures} · 已终局` : `胜 ${successes} · 负 ${failures} · 第 ${currentQuest + 1} 个任务`}
        </span>
      </div>
      {team.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">队伍</span>
          {team.map((id) => (
            <Badge key={id} variant="outline" className="gap-1 rounded-full px-2 py-0.5 text-[10px] font-normal">
              <AgentAvatar name={nameOf(id)} index={indexOf(id)} seed={seedOf(id)} size="sm" />
              {nameOf(id)}
            </Badge>
          ))}
        </div>
      ) : null}
      {Object.keys(teamVotes).length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">表决</span>
          {Object.entries(teamVotes).map(([id, v]) => (
            <Badge key={id} variant="outline" className={cn("rounded-full px-2 py-0.5 text-[10px] font-normal", v > 0 ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-rose-400/30 bg-rose-400/10 text-rose-300")}>
              {nameOf(id)} {v > 0 ? "赞成" : "反对"}
            </Badge>
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
  const { nameOf, indexOf, seedOf } = useNames(room);
  return (
    <Item variant="outline" className="min-w-0 flex-1 gap-2.5 rounded-xl px-3.5 py-3">
      <ItemMedia><AgentAvatar name={nameOf(id)} index={indexOf(id)} seed={seedOf(id)} /></ItemMedia>
      <ItemContent>
        <ItemTitle className="truncate text-[13px]">{nameOf(id)}</ItemTitle>
        <ItemDescription>{label}</ItemDescription>
        {detail ? <ItemDescription className="line-clamp-2 text-foreground/80">{detail}</ItemDescription> : null}
      </ItemContent>
    </Item>
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
          <span className="nums font-mono text-[11px] text-foreground/80">{leftScore !== undefined ? Math.round(leftScore) : "—"}</span>
          <span className="text-[9px] font-bold tracking-widest text-muted-foreground">VS</span>
          <span className="nums font-mono text-[11px] text-foreground/80">{rightScore !== undefined ? Math.round(rightScore) : "—"}</span>
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
  const { nameOf, indexOf, seedOf } = useNames(room);
  if (room.scenarioId === "liars-dice") {
    const lives = entries(details, "lives");
    return (
      <PanelShell title="赌注与生命" hint={room.world.phase}>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(lives).map(([id, livesLeft]) => (
            <Badge key={id} variant="outline" className={cn("gap-1.5 px-2.5 py-1 text-[11px] font-normal", livesLeft > 0 ? "text-foreground/85" : "border-rose-400/30 bg-rose-400/10 text-rose-300 line-through")}>
              <AgentAvatar name={nameOf(id)} index={indexOf(id)} seed={seedOf(id)} size="sm" />
              {nameOf(id)}
              <span className="nums font-mono text-[10px] text-muted-foreground">{livesLeft} ❤</span>
            </Badge>
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
        <Empty className="min-h-20">
          <EmptyHeader>
            <EmptyMedia variant="icon"><span className="nums font-mono text-sm">0</span></EmptyMedia>
            <EmptyTitle>尚未结算</EmptyTitle>
            <EmptyDescription>首轮结算后这里会显示各人分数。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-1.5">
          {Object.entries(scores).map(([id, score]) => (
            <div key={id} className="flex items-center gap-2.5">
              <AgentAvatar name={nameOf(id)} index={indexOf(id)} seed={seedOf(id)} size="sm" />
              <span className="w-12 shrink-0 truncate text-[11px] text-foreground/85">{nameOf(id)}</span>
              <Progress value={Math.round((score / maxScore) * 100)} className="h-1.5 min-w-0 flex-1 [&>[data-slot=progress-indicator]]:bg-emerald-400/70" aria-label={`${nameOf(id)} 分数 ${Math.round(score)}`} />
              <span className="nums w-8 shrink-0 text-right font-mono text-[11px] text-foreground/85">{Math.round(score)}</span>
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
  const { nameOf, indexOf, seedOf } = useNames(room);
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
          const status = room.world.status === "finished"
            ? (score !== undefined ? `分数 ${Math.round(score)}` : "已揭示")
            : submitted ? "已密封" : "待提交";
          return (
            <Item key={id} size="sm" variant={submitted ? "muted" : "outline"} className={cn("gap-2 rounded-lg px-2.5 py-1.5", submitted && "border-emerald-400/25 bg-emerald-400/[0.04]")}>
              <ItemMedia><AgentAvatar name={nameOf(id)} index={indexOf(id)} seed={seedOf(id)} size="sm" /></ItemMedia>
              <ItemContent>
                <ItemTitle className="truncate text-[11px]">{nameOf(id)}</ItemTitle>
                <ItemDescription className={cn(submitted && "text-emerald-300/80")}>{status}</ItemDescription>
              </ItemContent>
            </Item>
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
