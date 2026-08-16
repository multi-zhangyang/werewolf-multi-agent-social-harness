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
import { AgentPresence, ModelLabel, StatusLabel } from "./shared";

export function ParticipantsRail({ participants, humanActorId }: { participants: SocietyParticipantCard[]; humanActorId?: string }): ReactNode {
  const [selected, setSelected] = useState<SocietyParticipantCard | null>(null);
  const leaderId = [...participants].sort((left, right) => (right.score ?? -1) - (left.score ?? -1))[0]?.profile.id;
  return (
    <div className="space-y-1.5">
      {participants.map((participant, index) => {
        const isHuman = humanActorId === participant.profile.id;
        const dead = !participant.alive;
        const leader = leaderId !== undefined && participant.score !== undefined && participant.profile.id === leaderId;
        return (
          <button
            key={participant.profile.id}
            onClick={() => setSelected(participant)}
            className={cn(
              "group w-full rounded-lg border border-transparent bg-white px-3 py-2.5 text-left transition-all hover:border-zinc-200 hover:shadow-sm",
              dead && "opacity-50",
              isHuman && "border-zinc-300 bg-zinc-50",
              leader && "leader-wash"
            )}
          >
            <div className="flex items-center gap-3">
              <div className="relative">
                <AgentPresence name={participant.profile.displayName} index={index} size="lg" status={dead ? "finished" : participant.status} />
                {dead ? (
                  <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-white text-zinc-400 ring-1 ring-zinc-200">
                    <Skull className="size-3" />
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold tracking-tight text-zinc-900">{participant.profile.displayName}</span>
                  {isHuman ? (
                    <span className="rounded bg-zinc-900 px-1.5 py-px text-[9px] font-bold text-white">你</span>
                  ) : null}
                  {participant.mind?.memories.some((memory) => memory.tags.includes("season")) ? (
                    <span className="rounded border border-zinc-300 bg-white px-1.5 py-px text-[9px] font-medium text-zinc-500">老面孔</span>
                  ) : null}
                  {participant.role ? (
                    <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-px text-[9px] text-zinc-500">{participant.role}</span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-400">
                  <StatusLabel status={dead ? "finished" : participant.status} />
                  {participant.mood ? <span className="truncate text-zinc-500">· {participant.mood}</span> : null}
                </div>
                <ModelLabel model={participant.profile.model} className="mt-0.5 block max-w-40" />
              </div>
              <div className="text-right">
                {participant.score !== undefined ? (
                  <div className="nums flex items-center justify-end gap-1 font-mono text-base text-zinc-900">
                    {leader ? <Crown className="size-3.5 text-amber-500" /> : null}
                    {participant.score}
                  </div>
                ) : null}
                {participant.energy !== undefined ? (
                  <p className="nums mt-0.5 flex items-center justify-end gap-1 font-mono text-[10px] text-zinc-400">
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
      <SheetContent className="w-full border-zinc-200 bg-white text-foreground sm:max-w-lg">
        {participant ? (
          <>
            <SheetHeader className="border-b border-zinc-100">
              <div className="flex items-center gap-3">
                <AgentPresence name={participant.profile.displayName} index={participant.profile.id.length} size="lg" status={participant.status} />
                <div>
                  <SheetTitle className="text-lg tracking-tight">{participant.profile.displayName}</SheetTitle>
                  <SheetDescription className="text-zinc-400">
                    {participant.role ?? "参与者"} · {participant.mood ?? participant.status}
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
                    <DeliberationsSection mind={mind} />
                    <MemoriesSection mind={mind} />
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Brain className="size-8 text-zinc-300" />
                    <p className="mt-3 text-sm text-zinc-500">等待智能体更新内心状态</p>
                    <p className="mt-1 text-xs text-zinc-400">第一次行动后这里会显示情绪、目标、信念与记忆。</p>
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
      <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-base font-semibold tracking-tight">{mind.mood.label}</p>
            <p className="mt-0.5 text-xs leading-5 text-zinc-500">{mind.mood.description}</p>
          </div>
          <Badge variant="outline" className="border-zinc-200 bg-white font-mono text-zinc-500">
            能量 {Math.round(mind.mood.energy * 100)}%
          </Badge>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
          {Object.entries(mind.mood.emotions).map(([key, value]) => (
            <Bar key={key} label={emotionLabel(key)} value={value} />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-zinc-200/80 pt-3">
          {Object.entries(mind.mood.socialEmotions).map(([key, value]) => (
            <Bar key={key} label={socialEmotionLabel(key)} value={value} />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-zinc-200/80 pt-3">
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
          <div key={goal.id} className="rounded-lg border border-zinc-200 bg-white p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-zinc-800">{goal.description}</p>
              <Badge variant="outline" className={cn("shrink-0 border-zinc-200 bg-zinc-50 text-[10px] text-zinc-500", goal.status === "satisfied" && "border-emerald-200 bg-emerald-50 text-emerald-600", goal.status === "abandoned" && "text-zinc-400")}>
                {goal.status === "satisfied" ? "已达成" : goal.status === "abandoned" ? "已放弃" : "进行中"}
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
      <SectionTitle>对他人的判断</SectionTitle>
      <div className="space-y-2">
        {mind.beliefs.slice(-6).map((belief, index) => (
          <div key={index} className="rounded-lg border border-zinc-200 bg-white p-3">
            <p className="text-sm text-zinc-800">{belief.proposition}</p>
            <p className="nums mt-1 font-mono text-[10px] text-zinc-400">
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
          <div key={relationship.agentId} className="rounded-lg border border-zinc-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-zinc-800">{relationship.agentId}</p>
              <p className="nums font-mono text-[10px] text-zinc-400">信任 {Math.round(relationship.trust * 100)}%</p>
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

function DeliberationsSection({ mind }: { mind: AgentMindState }): ReactNode {
  if (!mind.deliberations.length) return null;
  return (
    <section>
      <SectionTitle>最近盘算</SectionTitle>
      <div className="space-y-2">
        {mind.deliberations.slice(-4).reverse().map((deliberation, index) => (
          <div key={index} className="rounded-lg border border-zinc-200 bg-white p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-400">{deliberationLabel(deliberation.kind)}</p>
            <p className="mt-1 text-sm leading-5 text-zinc-600">{deliberation.text}</p>
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
          <div key={memory.id} className="rounded-lg border border-zinc-200 bg-white p-3">
            <p className="text-sm leading-5 text-zinc-600">{memory.text}</p>
            <p className="nums mt-1 font-mono text-[10px] text-zinc-400">
              T{memory.turn} · 显著性 {Math.round(memory.salience * 100)}%
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function deliberationLabel(kind: string): string {
  return kind === "reflection" ? "策略反思" : kind === "mind-read" ? "洞察他人" : "谋划行动";
}

function SectionTitle({ children }: { children: ReactNode }): ReactNode {
  return <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">{children}</h3>;
}

function Bar({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div>
      <div className="nums mb-1 flex items-center justify-between text-[11px]">
        <span className="text-zinc-500">{label}</span>
        <span className="font-mono text-zinc-400">{Math.round(value * 100)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100">
        <div className="h-full rounded-full bg-zinc-700 transition-all" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
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

function socialEmotionLabel(key: string): string {
  const labels: Record<string, string> = {
    gratitude: "感激", guilt: "内疚", shame: "羞耻", embarrassment: "尴尬", pride: "骄傲",
    envy: "羡慕", jealousy: "嫉妒", contempt: "蔑视", admiration: "敬佩", relief: "如释重负"
  };
  return labels[key] ?? key;
}

function needLabel(key: string): string {
  const labels: Record<string, string> = {
    security: "安全感", connection: "联结感", status: "地位感", autonomy: "自主感", achievement: "成就感"
  };
  return labels[key] ?? key;
}
