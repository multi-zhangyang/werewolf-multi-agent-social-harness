import type { ReactNode } from "react";
import { Crown, Skull, Zap } from "lucide-react";
import type { SocietyParticipantCard } from "@/society/room";
import { cn } from "@/lib/utils";
import { AgentAvatar, ModelLabel, StatusDot, StatusLabel } from "./shared";

export function ParticipantsRail({ participants, humanActorId }: { participants: SocietyParticipantCard[]; humanActorId?: string }): ReactNode {
  return (
    <div className="space-y-2.5">
      {participants.map((participant, index) => {
        const isHuman = humanActorId === participant.profile.id;
        const dead = !participant.alive;
        return (
          <div
            key={participant.profile.id}
            className={cn(
              "group rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 transition-all hover:border-white/12 hover:bg-white/[0.04]",
              dead && "opacity-50",
              isHuman && "border-zinc-400/30 bg-zinc-100/[0.05]"
            )}
          >
            <div className="flex items-center gap-3">
              <div className="relative">
                <AgentAvatar name={participant.profile.displayName} index={index} size="lg" />
                {dead ? (
                  <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-zinc-900 text-zinc-400 ring-1 ring-white/10">
                    <Skull className="size-3" />
                  </span>
                ) : (
                  <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-zinc-900 ring-1 ring-white/10">
                    <StatusDot status={participant.status} />
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-zinc-100">{participant.profile.displayName}</span>
                  {isHuman ? (
                    <span className="rounded-md bg-zinc-100 px-1.5 py-px text-[9px] font-bold text-zinc-950">你</span>
                  ) : null}
                  {participant.role ? (
                    <span className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-px text-[9px] text-zinc-400">{participant.role}</span>
                  ) : null}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <StatusDot status={dead ? "finished" : participant.status} />
                  <StatusLabel status={dead ? "finished" : participant.status} />
                </div>
                <ModelLabel model={participant.profile.model} className="mt-1 block max-w-40" />
              </div>
              <div className="text-right">
                {participant.score !== undefined ? (
                  <div className="flex items-center justify-end gap-1 font-mono text-base text-zinc-50">
                    <Crown className="size-3.5 text-amber-300/70" />
                    {participant.score}
                  </div>
                ) : null}
                {participant.mood ? (
                  <p className="mt-0.5 max-w-20 truncate text-[10px] text-zinc-500">{participant.mood}</p>
                ) : null}
                {participant.energy !== undefined ? (
                  <p className="mt-0.5 flex items-center justify-end gap-1 font-mono text-[10px] text-zinc-600">
                    <Zap className="size-2.5" />
                    {participant.energy}%
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
