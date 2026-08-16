import type { ReactNode } from "react";
import { Activity } from "lucide-react";
import type { ScenarioId, WorldSnapshot } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { cn } from "@/lib/utils";
import { StatusDot, StatusLabel } from "./shared";

export function WorldPanel({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const world = room.world;
  const names = new Map(world.agents.map((agent) => [agent.id, agent.displayName]));

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">实时局势</p>
          <span className="flex items-center gap-1.5 text-xs text-zinc-400">
            <StatusDot status={world.status} />
            <StatusLabel status={world.status} />
          </span>
        </div>
        <div className="mt-3 flex items-end justify-between">
          <div>
            <p className="text-xl font-semibold tracking-tight text-zinc-100">{world.phase}</p>
            <p className="mt-1 font-mono text-[11px] text-zinc-500">第 {world.turn} / {world.totalTurns} 轮</p>
          </div>
          <div className="w-24">
            <Progress value={world.status === "finished" ? 100 : Math.min(100, (world.turn / Math.max(1, world.totalTurns)) * 100)} />
          </div>
        </div>
      </section>

      <ScoreCard world={world} />
      <HistoryCard world={world} names={names} scenarioId={room.scenarioId} />
    </div>
  );
}

function ScoreCard({ world }: { world: WorldSnapshot }): ReactNode {
  const scored = world.agents.filter((agent) => agent.score !== undefined);
  if (!scored.length) return null;
  const sorted = [...scored].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const max = sorted[0]?.score ?? 0;
  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">当前战况</p>
      <div className="mt-3 space-y-2.5">
        {sorted.map((agent, index) => (
          <div key={agent.id} className="flex items-center gap-2.5">
            <span className={cn("w-4 font-mono text-[10px]", index === 0 ? "text-amber-300/80" : "text-zinc-600")}>
              {index + 1}
            </span>
            <span className="w-16 truncate text-xs text-zinc-300">{agent.displayName}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-zinc-400 to-zinc-200 transition-all"
                style={{ width: `${max > 0 ? ((agent.score ?? 0) / max) * 100 : 0}%` }}
              />
            </div>
            <span className="w-8 text-right font-mono text-xs text-zinc-100">{agent.score}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function HistoryCard({ world, names, scenarioId }: { world: WorldSnapshot; names: Map<string, string>; scenarioId: ScenarioId }): ReactNode {
  const history = (world.details.history ?? []) as Array<Record<string, unknown>>;
  if (!history.length) {
    return (
      <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">进程</p>
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-600">
          <Activity className="size-3.5" />
          还没有历史回合
        </div>
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">历史回合</p>
      <div className="mt-3 space-y-1">
        {history.map((entry, index) => (
          <HistoryRow key={index} entry={entry} names={names} scenarioId={scenarioId} />
        ))}
      </div>
    </section>
  );
}

function HistoryRow({ entry, names, scenarioId }: { entry: Record<string, unknown>; names: Map<string, string>; scenarioId: ScenarioId }): ReactNode {
  if (scenarioId === "werewolf") {
    const eliminated = entry.eliminatedId as string | undefined;
    const night = entry.nightTargetId as string | undefined;
    return (
      <div className="flex items-start gap-2 py-1.5 text-xs leading-5">
        <span className="mt-1 font-mono text-[10px] text-zinc-600">D{String(entry.day)}</span>
        <div className="flex-1 text-zinc-400">
          {eliminated ? (
            <p><span className="text-zinc-200">{names.get(eliminated) ?? eliminated}</span> 被投票淘汰（{String(entry.eliminatedRole)}）</p>
          ) : (
            <p className="text-zinc-600">投票平局，无人淘汰</p>
          )}
          {night ? (
            <p className="mt-0.5 text-zinc-500">夜晚：<span className="text-rose-300/80">{names.get(night) ?? night}</span> 被淘汰（{String(entry.nightTargetRole)}）</p>
          ) : null}
        </div>
      </div>
    );
  }

  if (scenarioId === "prisoners-dilemma" || scenarioId === "trust-game" || scenarioId === "ultimatum-game") {
    const payoffs = entry.payoffs as Record<string, number> | undefined;
    const moves = entry.moves as Record<string, string> | undefined;
    const accepted = entry.accepted as boolean | undefined;
    const offer = entry.offer as number | undefined;
    const investment = entry.investment as number | undefined;
    const returned = entry.returnedAmount as number | undefined;
    const detail = scenarioId === "prisoners-dilemma" && moves
      ? Object.entries(moves).map(([id, move]) => `${names.get(id) ?? id} ${move === "cooperate" ? "合作" : "背叛"}`).join(" · ")
      : scenarioId === "ultimatum-game" && offer !== undefined
        ? `提议 ${offer}/10 · ${accepted ? "接受" : "拒绝"}`
        : investment !== undefined
          ? `投资 ${investment} · 返还 ${returned}`
          : "";
    return (
      <div className="flex items-start gap-2 py-1.5 text-xs leading-5">
        <span className="mt-1 font-mono text-[10px] text-zinc-600">R{String(entry.round)}</span>
        <div className="flex-1">
          <p className="text-zinc-400">{detail}</p>
          {payoffs ? (
            <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
              {Object.entries(payoffs).map(([id, value]) => `${names.get(id) ?? id} ${value}`).join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  if (scenarioId === "beauty-contest") {
    const choices = entry.choices as Record<string, number> | undefined;
    const average = entry.average as number | undefined;
    const target = entry.target as number | undefined;
    const winners = entry.winnerIds as string[] | undefined;
    return (
      <div className="flex items-start gap-2 py-1.5 text-xs leading-5">
        <span className="mt-1 font-mono text-[10px] text-zinc-600">R{String(entry.round)}</span>
        <div className="flex-1">
          <p className="text-zinc-400">
            平均 {average?.toFixed(2)} · 目标 {target?.toFixed(2)} · 获胜：{winners?.map((id) => names.get(id) ?? id).join("、")}
          </p>
          {choices ? (
            <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
              {Object.entries(choices).map(([id, value]) => `${names.get(id) ?? id} ${value}`).join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  if (scenarioId === "public-goods") {
    return (
      <div className="flex items-start gap-2 py-1.5 text-xs leading-5">
        <span className="mt-1 font-mono text-[10px] text-zinc-600">R{String(entry.round)}</span>
        <div className="flex-1 text-zinc-400">
          <p>公共池 {String(entry.pool)} · 每人 {String(entry.share)}</p>
          <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
            {(entry.contributions as Record<string, number> | undefined) ? Object.entries(entry.contributions as Record<string, number>).map(([id, value]) => `${names.get(id) ?? id} ${value}`).join(" · ") : ""}
          </p>
        </div>
      </div>
    );
  }

  return null;
}

function Progress({ value }: { value: number }): ReactNode {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
      <div className="h-full rounded-full bg-zinc-100 transition-all" style={{ width: `${value}%` }} />
    </div>
  );
}
