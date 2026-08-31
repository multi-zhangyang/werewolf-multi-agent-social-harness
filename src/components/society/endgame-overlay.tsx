import type { ReactNode } from "react";
import { Trophy } from "lucide-react";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildEndgameSummary } from "./cinematics";
import { AgentAvatar, formatTime, roleLabelZh } from "./shared";

/** Heavy endgame reveal, loaded only after a room reaches its terminal state. */
export function EndgameOverlay({ room, avatarSeedFor, onDismiss }: {
  room: SocietyRoomSnapshot;
  avatarSeedFor: (actorId: string) => string | undefined;
  onDismiss: () => void;
}): ReactNode {
  const world = room.world;
  const summary = buildEndgameSummary(world);
  const highlights = room.highlights ?? [];
  const agents = [...world.agents].sort((left, right) => Number(left.alive) - Number(right.alive));
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
          <p className="text-xs font-medium tracking-[0.22em] text-muted-foreground">终局揭晓</p>
          <h2 className="max-w-md text-balance text-xl font-semibold leading-snug tracking-tight">{summary.headline}</h2>
        </div>

        <section aria-label="身份揭晓" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {agents.map((agent) => {
            const roleLine = agent.observerRole
              ? roleLabelZh(agent.observerRole)
              : agent.alive ? "存活 · 身份随视角公开" : "出局";
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
                  <p className="truncate text-sm font-medium leading-tight">{agent.displayName}</p>
                  <p className="mt-1 truncate text-xs leading-none text-muted-foreground">{roleLine}</p>
                </div>
                {agent.score !== undefined ? <span className="nums shrink-0 font-mono text-xs">{agent.score}</span> : null}
              </div>
            );
          })}
        </section>

        {modelRows.length ? (
          <section aria-label="模型战绩" className="flex flex-col gap-2">
            <p className="text-xs font-medium tracking-[0.22em] text-muted-foreground">模型战绩</p>
            <ul className="flex flex-col gap-1.5">
              {modelRows.map((row) => (
                <li key={row.model} className="flex items-baseline gap-2.5 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{row.model}</span>
                  <span className="nums shrink-0 font-mono text-xs text-muted-foreground">
                    {row.seats} 席{winners.size ? ` · 胜 ${row.wins}` : ""}{row.avgScore !== undefined ? ` · 均分 ${Math.round(row.avgScore * 100) / 100}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {humanSeats ? <p className="text-xs leading-4 text-muted-foreground/70">{humanSeats} 个真人席位不计入模型战绩。</p> : null}
          </section>
        ) : null}

        {highlights.length ? (
          <section aria-label="本场高光" className="flex flex-col gap-2">
            <p className="text-xs font-medium tracking-[0.22em] text-muted-foreground">本场高光</p>
            <ol className="flex flex-col gap-1.5">
              {highlights.map((highlight) => (
                <li key={highlight.id} className="flex items-baseline gap-2.5 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
                  <time className="shrink-0 font-mono text-xs text-muted-foreground/70">{formatTime(highlight.at, { seconds: false })}</time>
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium leading-tight">{highlight.title}</span>
                    {highlight.subtitle ? <span className="mt-0.5 block truncate text-xs leading-tight text-muted-foreground">{highlight.subtitle}</span> : null}
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
