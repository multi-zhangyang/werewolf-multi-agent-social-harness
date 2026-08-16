import type { ReactNode } from "react";
import { Crown, Skull } from "lucide-react";
import type { SocietyParticipantCard } from "@/society/room";
import { cn } from "@/lib/utils";
import { AgentAvatar, ModelLabel, StatusDot, StatusLabel } from "./shared";

export function ParticipantsRail({ participants, humanActorId }: { participants: SocietyParticipantCard[]; humanActorId?: string }): ReactNode {
  return (
    <div className="space-y-2">
      {participants.map((participant, index) => {
        const isHuman = humanActorId === participant.profile.id;
        const dead = !participant.alive;
        return (
          <div
            key={participant.profile.id}
            className={cn(
              "group rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition-colors",
              dead && "opacity-55",
              isHuman && "border-zinc-400/30 bg-zinc-100/[0.05]"
            )}
          >
            <div className="flex items-center gap-3">
              <div className="relative">
                <AgentAvatar name={participant.profile.displayName} index={index} size="lg" />
                {dead ? (
                  <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-zinc-900 text-zinc-400 ring-1 ring-white/10">
                    <Skull className="size-2.5" />
                  </span>
                ) : (
                  <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-zinc-900 ring-1 ring-white/10">
                    <StatusDot status={participant.status} />
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-zinc-200">{participant.profile.displayName}</span>
                  {isHuman ? (
                    <span className="rounded-md bg-zinc-100 px-1 py-px text-[9px] font-semibold text-zinc-950">你</span>
                  ) : null}
                  {participant.role ? (
                    <span className="rounded-md border border-white/10 bg-white/[0.04] px-1 py-px text-[9px] text-zinc-400">{participant.role}</span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <StatusDot status={dead ? "finished" : participant.status} />
                  <StatusLabel status={dead ? "finished" : participant.status} />
                </div>
                <ModelLabel model={participant.profile.model} className="mt-0.5 block max-w-36" />
              </div>
              {participant.score !== undefined ? (
                <div className="text-right">
                  <div className="flex items-center gap-1 font-mono text-sm text-zinc-100">
                    <Crown className="size-3 text-amber-300/70" />
                    {participant.score}
                  </div>
                  <span className="text-[9px] uppercase tracking-wider text-zinc-600">score</span>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
