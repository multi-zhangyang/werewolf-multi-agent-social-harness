import { useState, type ReactNode } from "react";
import { Brain, Crown, Skull, Zap } from "lucide-react";
import type { AgentMindState } from "@/society/contracts";
import type { SocietyParticipantCard } from "@/society/room";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { AgentAvatar, ModelLabel, StatusDot, StatusLabel } from "./shared";

export function ParticipantsRail({ participants, humanActorId }: { participants: SocietyParticipantCard[]; humanActorId?: string }): ReactNode {
  const [selected, setSelected] = useState<SocietyParticipantCard | null>(null);
  return (
    <div className="space-y-2.5">
      {participants.map((participant, index) => {
        const isHuman = humanActorId === participant.profile.id;
        const dead = !participant.alive;
        return (
          <button
            key={participant.profile.id}
            onClick={() => setSelected(participant)}
            className={cn(
              "group w-full rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-left transition-all hover:border-white/12 hover:bg-white/[0.04]",
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
          </button>
        );
      })}
      <MindSheet participant={selected} onOpenChange={(open) => { if (!open) setSelected(null); }} />
    </div>
  );
}

function MindSheet({ participant, onOpenChange }: { participant: SocietyParticipantCard | null; onOpenChange: (open: boolean) => void }): ReactNode {
  const mind = participant?.mind;
  return (
    <Sheet open={Boolean(participant)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full border-white/[0.08] bg-[#0c0c0c] text-zinc-100 sm:max-w-md">
        {participant ? (
          <>
            <SheetHeader className="border-b border-white/[0.06]">
              <div className="flex items-center gap-3">
                <AgentAvatar name={participant.profile.displayName} index={participant.profile.id.length} size="lg" />
                <div>
                  <SheetTitle className="text-lg text-zinc-50">{participant.profile.displayName}</SheetTitle>
                  <SheetDescription className="text-zinc-500">
                    {participant.role ?? "参与者"} · {participant.status}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>
            <ScrollArea className="flex-1">
              <div className="space-y-5 p-5">
                {mind ? (
                  <>
                    <MoodSection mind={mind} />
                    <GoalsSection mind={mind} />
                    <BeliefsSection mind={mind} />
                    <RelationshipsSection mind={mind} />
                    <MemoriesSection mind={mind} />
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Brain className="size-8 text-zinc-600" />
                    <p className="mt-3 text-sm text-zinc-400">等待智能体更新内心状态</p>
                    <p className="mt-1 text-xs text-zinc-600">第一次行动后这里会显示情绪、目标、信念与记忆。</p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function MoodSection({ mind }: { mind: AgentMindState }): ReactNode {
  return (
    <section>
      <SectionTitle>情绪状态</SectionTitle>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-base font-semibold text-zinc-100">{mind.mood.label}</p>
            <p className="mt-0.5 text-xs leading-5 text-zinc-500">{mind.mood.description}</p>
          </div>
          <Badge variant="outline" className="border-white/10 bg-white/[0.03] font-mono text-zinc-400">
            能量 {Math.round(mind.mood.energy * 100)}%
          </Badge>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
          {Object.entries(mind.mood.emotions).map(([key, value]) => (
            <Bar key={key} label={emotionLabel(key)} value={value} />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/[0.05] pt-3">
          {Object.entries(mind.mood.needs).map(([key, value]) => (
            <Bar key={key} label={needLabel(key)} value={value} />
          ))}
        </div>
      </div>
    </section>
  );
}

function GoalsSection({ mind }: { mind: AgentMindState }): ReactNode {
  if (!mind.goals.length) return null;
  return (
    <section>
      <SectionTitle>目标</SectionTitle>
      <div className="space-y-2">
        {mind.goals.map((goal) => (
          <div key={goal.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-zinc-200">{goal.description}</p>
              <Badge variant="outline" className={cn("shrink-0 border-white/10 bg-white/[0.03] text-[10px] text-zinc-500", goal.status === "satisfied" && "text-emerald-300", goal.status === "abandoned" && "text-zinc-600")}>
                {goal.status}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-zinc-500">{goal.progress}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function BeliefsSection({ mind }: { mind: AgentMindState }): ReactNode {
  if (!mind.beliefs.length) return null;
  return (
    <section>
      <SectionTitle>对他人的信念</SectionTitle>
      <div className="space-y-2">
        {mind.beliefs.slice(-6).map((belief, index) => (
          <div key={index} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
            <p className="text-sm text-zinc-200">{belief.proposition}</p>
            <p className="mt-1 font-mono text-[10px] text-zinc-600">
              {belief.subjectId} · 置信度 {Math.round(belief.confidence * 100)}% · {belief.source}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function RelationshipsSection({ mind }: { mind: AgentMindState }): ReactNode {
  if (!mind.relationships.length) return null;
  return (
    <section>
      <SectionTitle>关系</SectionTitle>
      <div className="space-y-2">
        {mind.relationships.map((relationship) => (
          <div key={relationship.agentId} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-zinc-200">{relationship.agentId}</p>
              <p className="font-mono text-[10px] text-zinc-500">信任 {Math.round(relationship.trust * 100)}%</p>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Bar label="亲和" value={relationship.affinity} />
              <Bar label="尊重" value={relationship.respect} />
              <Bar label="张力" value={relationship.tension} />
            </div>
            {relationship.note ? <p className="mt-2 text-xs text-zinc-500">{relationship.note}</p> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function MemoriesSection({ mind }: { mind: AgentMindState }): ReactNode {
  if (!mind.memories.length) return null;
  return (
    <section>
      <SectionTitle>记忆</SectionTitle>
      <div className="space-y-2">
        {mind.memories.slice(-6).reverse().map((memory) => (
          <div key={memory.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
            <p className="text-sm leading-5 text-zinc-300">{memory.text}</p>
            <p className="mt-1 font-mono text-[10px] text-zinc-600">
              T{memory.turn} · 显著性 {Math.round(memory.salience * 100)}%
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionTitle({ children }: { children: ReactNode }): ReactNode {
  return <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">{children}</h3>;
}

function Bar({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-zinc-500">{label}</span>
        <span className="font-mono text-zinc-400">{Math.round(value * 100)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-zinc-300/80 transition-all" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
      </div>
    </div>
  );
}

function emotionLabel(key: string): string {
  const labels: Record<string, string> = {
    joy: "愉悦", sadness: "悲伤", anger: "愤怒", fear: "恐惧", surprise: "惊讶", disgust: "厌恶"
  };
  return labels[key] ?? key;
}

function needLabel(key: string): string {
  const labels: Record<string, string> = {
    security: "安全感", connection: "联结感", status: "地位感", autonomy: "自主感", achievement: "成就感"
  };
  return labels[key] ?? key;
}
