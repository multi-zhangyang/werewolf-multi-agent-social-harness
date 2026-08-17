import { useState, type ReactNode } from "react";
import { Brain, Crown, Skull, Zap } from "lucide-react";
import type { AgentMindState } from "@/society/contracts";
import type { SocietyParticipantCard } from "@/society/room";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { AgentPresence, ModelLabel, StatusLabel, roleTintClass } from "./shared";

export function ParticipantsRail({ participants, humanActorId }: { participants: SocietyParticipantCard[]; humanActorId?: string }): ReactNode {
  const [selected, setSelected] = useState<SocietyParticipantCard | null>(null);
  const leaderId = [...participants].sort((left, right) => (right.score ?? -1) - (left.score ?? -1))[0]?.profile.id;
  return (
    <div className="space-y-1.5">
      {participants.map((participant, index) => {
        const isHuman = humanActorId === participant.profile.id;
        const dead = !participant.alive;
        const leader = leaderId !== undefined && participant.score !== undefined && participant.profile.id === leaderId;
        const live = participant.status === "thinking" || participant.status === "acting" || participant.status === "speaking";
        return (
          <button
            key={participant.profile.id}
            onClick={() => setSelected(participant)}
            className={cn(
              "group relative w-full rounded-lg border border-transparent bg-card/60 px-3 py-2.5 text-left transition-all hover:border-border hover:bg-card",
              dead && "opacity-45",
              isHuman && "border-border bg-card",
              live && "border-emerald-400/40",
              leader && "leader-wash"
            )}
          >
            <span
              className={cn(
                "absolute inset-y-2 left-0 w-0.5 rounded-full transition-opacity",
                live ? "bg-emerald-400 opacity-100" : "opacity-0"
              )}
              aria-hidden
            />
            <div className="flex items-center gap-2.5">
              <div className="relative">
                <AgentPresence name={participant.profile.displayName} index={index} size="lg" status={dead ? "finished" : participant.status} />
                {dead ? (
                  <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
                    <Skull className="size-3" />
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold tracking-tight">{participant.profile.displayName}</span>
                  {isHuman ? (
                    <span className="rounded bg-foreground px-1.5 py-px text-[9px] font-bold text-background">你</span>
                  ) : null}
                  {participant.mind?.memories.some((memory) => memory.tags.includes("season")) ? (
                    <span className="rounded border border-border bg-card px-1.5 py-px text-[9px] font-medium text-muted-foreground">老面孔</span>
                  ) : null}
                  {participant.role ? (
                    <span className={cn("rounded border px-1.5 py-px text-[9px]", roleTintClass(participant.role))}>{participant.role}</span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <StatusLabel status={dead ? "finished" : participant.status} />
                  {participant.mood ? <span className="truncate">· {participant.mood}</span> : null}
                </div>
              </div>
              <div className="text-right">
                {participant.score !== undefined ? (
                  <div className="nums flex items-center justify-end gap-1 font-mono text-base text-foreground">
                    {leader ? <Crown className="size-3.5 text-amber-400" /> : null}
                    {participant.score}
                  </div>
                ) : null}
                {participant.energy !== undefined ? (
                  <p className="nums mt-0.5 flex items-center justify-end gap-1 font-mono text-[10px] text-muted-foreground/70">
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
      <SheetContent className="w-full border-border bg-card text-foreground sm:max-w-lg">
        {participant ? (
          <>
            <SheetHeader className="border-b border-border/60">
              <div className="flex items-center gap-3">
                <AgentPresence name={participant.profile.displayName} index={participant.profile.id.length} size="lg" status={participant.status} />
                <div className="min-w-0">
                  <SheetTitle className="text-lg tracking-tight">{participant.profile.displayName}</SheetTitle>
                  <SheetDescription className="flex flex-wrap items-center gap-2">
                    <span>{participant.role ?? "参与者"} · {participant.mood ?? participant.status}</span>
                    <ModelLabel model={participant.profile.model} />
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>
            <ScrollArea className="flex-1">
              <div className="space-y-5 p-5">
                {mind ? (
                  <>
                    <MoodSection mind={mind} />
                    <AppraisalsSection mind={mind} />
                    <GoalsSection mind={mind} />
                    <BeliefsSection mind={mind} />
                    <RoleHypothesesSection mind={mind} />
                    <RelationshipsSection mind={mind} />
                    <DeceptionsSection mind={mind} />
                    <DeliberationsSection mind={mind} />
                    <MemoriesSection mind={mind} />
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Brain className="size-8 text-muted-foreground/50" />
                    <p className="mt-3 text-sm text-muted-foreground">等待智能体更新内心状态</p>
                    <p className="mt-1 text-xs text-muted-foreground/70">第一次行动后这里会显示情绪、目标、信念与记忆。</p>
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
      <div className="rounded-lg border border-border bg-muted/40 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-base font-semibold tracking-tight">{mind.mood.label}</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{mind.mood.description}</p>
          </div>
          <Badge variant="outline" className="border-border bg-card font-mono text-muted-foreground">
            能量 {Math.round(mind.mood.energy * 100)}%
          </Badge>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
          {Object.entries(mind.mood.emotions).map(([key, value]) => (
            <Bar key={key} label={emotionLabel(key)} value={value} />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/80 pt-3">
          {Object.entries(mind.mood.socialEmotions).map(([key, value]) => (
            <Bar key={key} label={socialEmotionLabel(key)} value={value} />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/80 pt-3">
          {Object.entries(mind.mood.needs).map(([key, value]) => (
            <Bar key={key} label={needLabel(key)} value={value} />
          ))}
        </div>
      </div>
    </section>
  );
}

function RoleHypothesesSection({ mind }: { mind: AgentMindState }): ReactNode {
  if (!mind.roleHypotheses.length) return null;
  const subjects = new Map<string, Array<{ role: string; probability: number }>>();
  for (const entry of mind.roleHypotheses) {
    const list = subjects.get(entry.subjectId) ?? [];
    list.push({ role: entry.role, probability: entry.probability });
    subjects.set(entry.subjectId, list);
  }
  return (
    <section>
      <SectionTitle>身份推断</SectionTitle>
      <div className="space-y-2">
        {[...subjects.entries()].map(([subjectId, entries]) => (
          <div key={subjectId} className="rounded-lg border border-border bg-card p-3">
            <p className="text-sm font-medium text-foreground/90">{subjectId}</p>
            <div className="mt-2 space-y-1.5">
              {[...entries].sort((left, right) => right.probability - left.probability).map((entry) => (
                <div key={entry.role} className="flex items-center gap-2">
                  <span className="w-16 truncate text-[11px] text-muted-foreground">{entry.role}</span>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-violet-400/80 transition-all" style={{ width: `${Math.round(entry.probability * 100)}%` }} />
                  </div>
                  <span className="nums w-9 text-right font-mono text-[10px] text-muted-foreground">{Math.round(entry.probability * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DeceptionsSection({ mind }: { mind: AgentMindState }): ReactNode {
  if (!mind.deceptions.length) return null;
  return (
    <section>
      <SectionTitle>欺骗意图</SectionTitle>
      <div className="space-y-2">
        {mind.deceptions.slice(-4).reverse().map((plan, index) => (
          <div key={index} className="rounded-lg border border-rose-400/20 bg-card p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-rose-300/80">{deceptionLabel(plan.type)} · 目标 {plan.targetIds.join("、")}</p>
            <p className="mt-1 text-sm leading-5 text-foreground/85">想让他们相信:{plan.intendedBelief}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">掩护说法:{plan.coverStory}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground/80">被拆穿后的退路:{plan.fallback}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function AppraisalsSection({ mind }: { mind: AgentMindState }): ReactNode {
  if (!mind.lastAppraisals.length) return null;
  return (
    <section>
      <SectionTitle>情绪来源</SectionTitle>
      <div className="space-y-1.5">
        {mind.lastAppraisals.slice(-4).reverse().map((note, index) => (
          <p key={index} className="rounded-lg border border-border/60 bg-card px-3 py-2 text-xs leading-5 text-muted-foreground">
            {note.text}
          </p>
        ))}
      </div>
    </section>
  );
}

function deceptionLabel(type: string): string {
  const labels: Record<string, string> = {
    lying: "说谎",
    bluff: "虚张声势",
    paltering: "真话误导",
    omission: "隐瞒",
    "false-promise": "虚假承诺"
  };
  return labels[type] ?? type;
}

function GoalsSection({ mind }: { mind: AgentMindState }): ReactNode {
  if (!mind.goals.length) return null;
  return (
    <section>
      <SectionTitle>目标</SectionTitle>
      <div className="space-y-2">
        {mind.goals.map((goal) => (
          <div key={goal.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground/90">{goal.description}</p>
              <Badge variant="outline" className={cn("shrink-0 border-border bg-muted/50 text-[10px] text-muted-foreground", goal.status === "satisfied" && "border-emerald-400/30 bg-emerald-400/10 text-emerald-300", goal.status === "abandoned" && "text-muted-foreground/70")}>
                {goal.status === "satisfied" ? "已达成" : goal.status === "abandoned" ? "已放弃" : "进行中"}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{goal.progress}</p>
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
          <div key={index} className="rounded-lg border border-border bg-card p-3">
            <p className="text-sm text-foreground/90">{belief.proposition}</p>
            <p className="nums mt-1 font-mono text-[10px] text-muted-foreground">
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
          <div key={relationship.agentId} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-foreground/90">{relationship.agentId}</p>
              <p className="nums font-mono text-[10px] text-muted-foreground">信任 {Math.round(relationship.trust * 100)}%</p>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Bar label="亲和" value={relationship.affinity} />
              <Bar label="尊重" value={relationship.respect} />
              <Bar label="张力" value={relationship.tension} />
            </div>
            {relationship.note ? <p className="mt-2 text-xs text-muted-foreground">{relationship.note}</p> : null}
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
          <div key={index} className="rounded-lg border border-border bg-card p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{deliberationLabel(deliberation.kind)}</p>
            <p className="mt-1 text-sm leading-5 text-foreground/80">{deliberation.text}</p>
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
          <div key={memory.id} className="rounded-lg border border-border bg-card p-3">
            <p className="text-sm leading-5 text-foreground/80">{memory.text}</p>
            <p className="nums mt-1 font-mono text-[10px] text-muted-foreground">
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
  return <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{children}</h3>;
}

function Bar({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div>
      <div className="nums mb-1 flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-muted-foreground/80">{Math.round(value * 100)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground/80 transition-all" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
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