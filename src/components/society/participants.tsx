import { useEffect, useState, type ReactNode } from "react";
import { Brain, Crown, Gauge, Pause, Play, Skull, Zap } from "lucide-react";
import type { AgentMindState, DecisionBias } from "@/society/contracts";
import type { SocietyParticipantCard, SocietyParticipantProfile } from "@/society/room";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { AgentPresence, ModelLabel, StatusLabel, roleTintClass } from "./shared";
import type { RoomConnection } from "./use-room";

interface ParticipantsRailProps {
  participants: SocietyParticipantCard[];
  humanActorId?: string;
  /** Live per-agent activity (streams, thought-beats, context pressure). */
  activity?: RoomConnection["activity"];
  /** Pause/resume one participant (observer control; empty for human seats). */
  onToggleAgentPause?: (actorId: string, paused: boolean) => void;
  /** True while the whole room is paused (unlocks model switching §12.4). */
  roomPaused?: boolean;
  /** Room id for model-switch requests. */
  roomId?: string;
}

export function ParticipantsRail({ participants, humanActorId, activity, onToggleAgentPause, roomPaused = false, roomId }: ParticipantsRailProps): ReactNode {
  const [selected, setSelected] = useState<SocietyParticipantCard | null>(null);
  const leaderId = [...participants].sort((left, right) => (right.score ?? -1) - (left.score ?? -1))[0]?.profile.id;
  return (
    <div className="space-y-1.5">
      {participants.map((participant, index) => {
        const isHuman = humanActorId === participant.profile.id;
        const dead = !participant.alive;
        const paused = Boolean(participant.paused);
        const leader = leaderId !== undefined && participant.score !== undefined && participant.profile.id === leaderId;
        const live = participant.status === "thinking" || participant.status === "acting" || participant.status === "speaking";
        const pressure = activity?.[participant.profile.id]?.pressure;
        return (
          <button
            key={participant.profile.id}
            onClick={() => setSelected(participant)}
            className={cn(
              "group relative w-full rounded-lg border border-transparent bg-card/60 px-3 py-2.5 text-left transition-all hover:border-border hover:bg-card",
              dead && "opacity-45",
              isHuman && "border-border bg-card",
              live && "border-emerald-400/40",
              paused && "border-amber-400/40 bg-amber-400/5",
              leader && "leader-wash"
            )}
          >
            <span
              className={cn(
                "absolute inset-y-2 left-0 w-0.5 rounded-full transition-opacity",
                live ? "bg-emerald-400 opacity-100" : paused ? "bg-amber-400 opacity-100" : "opacity-0"
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
                  {paused ? (
                    <span className="rounded border border-amber-400/50 bg-amber-400/10 px-1.5 py-px text-[9px] font-medium text-amber-300">已暂停</span>
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
                {pressure && pressure.level !== "normal" ? (
                  <div className="mt-1 flex items-center gap-1.5" title={`上下文压力 ${Math.round(pressure.ratio * 100)}%（${pressure.current.toLocaleString()} / ${pressure.usable.toLocaleString()} tokens）`}>
                    <Gauge className={cn("size-3", pressure.level === "hard-guard" ? "text-red-400" : pressure.level === "emergency" || pressure.level === "deep-compact" ? "text-orange-400" : "text-amber-400")} />
                    <div className="h-1 w-20 overflow-hidden rounded-full bg-muted">
                      <div className={cn("h-full rounded-full", pressure.level === "hard-guard" ? "bg-red-400" : pressure.level === "emergency" || pressure.level === "deep-compact" ? "bg-orange-400" : "bg-amber-400")} style={{ width: `${Math.min(100, Math.round(pressure.ratio * 100))}%` }} />
                    </div>
                    <span className="nums font-mono text-[9px]">{Math.round(pressure.ratio * 100)}%</span>
                  </div>
                ) : null}
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
      <MindSheet
        participant={selected}
        activity={activity?.[selected?.profile.id ?? ""]}
        roomPaused={roomPaused}
        roomId={roomId}
        onToggleAgentPause={onToggleAgentPause}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
      />
    </div>
  );
}

function MindSheet({ participant, activity, roomPaused, roomId, onToggleAgentPause, onOpenChange }: {
  participant: SocietyParticipantCard | null;
  activity?: RoomConnection["activity"][string];
  roomPaused: boolean;
  roomId?: string;
  onToggleAgentPause?: (actorId: string, paused: boolean) => void;
  onOpenChange: (open: boolean) => void;
}): ReactNode {
  const mind = participant?.mind;
  const paused = Boolean(participant?.paused);
  const isHuman = participant?.profile.controller === "human";
  const canSwitchModel = Boolean(participant && roomId && !isHuman && (roomPaused || paused));
  const [modelProfiles, setModelProfiles] = useState<Array<{ id: string; name: string; modelId: string }>>([]);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string>();

  useEffect(() => {
    if (!participant || !canSwitchModel) return;
    let cancelled = false;
    fetch("/api/model-config")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("MODEL_CONFIG_UNREACHABLE"))))
      .then((data: { modelProfiles?: Array<{ id: string; name: string; modelId: string; enabled?: boolean }> }) => {
        if (!cancelled) setModelProfiles((data.modelProfiles ?? []).filter((profile) => profile.enabled !== false));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [participant, canSwitchModel]);

  const switchModel = async (modelProfileId: string): Promise<void> => {
    if (!participant || !roomId) return;
    setSwitching(true);
    setSwitchError(undefined);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(participant.profile.id)}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelProfileId })
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
    } catch (cause) {
      setSwitchError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSwitching(false);
    }
  };

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
                {!isHuman && onToggleAgentPause ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto shrink-0 rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => onToggleAgentPause(participant.profile.id, !paused)}
                  >
                    {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                    {paused ? "恢复参与" : "暂停参与"}
                  </Button>
                ) : null}
              </div>
            </SheetHeader>
            <ScrollArea className="flex-1">
              <div className="space-y-5 p-5">
                {paused ? (
                  <section className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
                    <p className="text-xs leading-5 text-amber-200/90">该参与者已被暂停：讨论阶段它会保持沉默，绑定行动阶段房间会停下来等待恢复——系统不会替它做任何决定。</p>
                  </section>
                ) : null}
                {canSwitchModel && participant ? (
                  <section>
                    <SectionTitle>切换模型</SectionTitle>
                    <Select value="__none" onValueChange={(value) => { if (value !== "__none") void switchModel(value); }} disabled={switching}>
                      <SelectTrigger className="w-full rounded-lg border-border bg-card text-foreground/90">
                        <SelectValue placeholder={`当前：${participant.profile.model}`} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none" disabled>当前：{participant.profile.model}</SelectItem>
                        {modelProfiles.map((profile) => (
                          <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
                      人物不变，只换引擎：会话、记忆、关系与本局角色都会保留；新模型窗口更小时会先自动压缩历史。
                    </p>
                    {switchError ? <p className="mt-1 text-[11px] text-red-400">{switchError}</p> : null}
                  </section>
                ) : null}
                <CharacterSection profile={participant.profile} />
                {mind ? (
                  <>
                    <MoodSection mind={mind} />
                    <TraitDriftSection mind={mind} />
                    <ContextSection activity={activity} model={participant.profile.model} />
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

/** Live context budget: window, usable input, current pressure and compaction. */
function ContextSection({ activity, model }: { activity?: RoomConnection["activity"][string]; model: string }): ReactNode {
  const pressure = activity?.pressure;
  if (!pressure && !activity?.compacted) {
    return (
      <section>
        <SectionTitle>上下文预算</SectionTitle>
        <p className="text-xs leading-5 text-muted-foreground/70">上下文压力仍处于 normal 级。窗口与预算按该参与者解析出的模型档案计算。</p>
      </section>
    );
  }
  const level = pressure?.level ?? "normal";
  const ratio = pressure?.ratio ?? 0;
  const tone = level === "hard-guard" ? "text-red-400" : level === "emergency" || level === "deep-compact" ? "text-orange-400" : level === "soft-compact" || level === "retrieval-tight" ? "text-amber-400" : level === "watch" ? "text-sky-400" : "text-emerald-400";
  return (
    <section>
      <SectionTitle>上下文预算</SectionTitle>
      <div className="rounded-lg border border-border bg-muted/40 p-4">
        <div className="flex items-center justify-between">
          <span className={cn("text-[13px] font-semibold", tone)}>{pressureLabel(level)}</span>
          <span className="nums font-mono text-xs text-muted-foreground">{Math.round(ratio * 100)}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full transition-all", level === "hard-guard" ? "bg-red-400" : level === "emergency" || level === "deep-compact" ? "bg-orange-400" : level === "soft-compact" || level === "retrieval-tight" ? "bg-amber-400" : level === "watch" ? "bg-sky-400" : "bg-emerald-400")} style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
        </div>
        {pressure ? (
          <p className="nums mt-2 font-mono text-[10px] leading-4 text-muted-foreground">
            当前 {pressure.current.toLocaleString()} / 可用 {pressure.usable.toLocaleString()} tokens（窗口 {pressure.window.toLocaleString()}）
          </p>
        ) : null}
        <p className="mt-1 text-[10px] text-muted-foreground/60">模型档案：{model}</p>
        {activity?.compacted ? (
          <p className="mt-2 rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-[11px] leading-4 text-amber-200/90">{activity.compacted}</p>
        ) : null}
      </div>
    </section>
  );
}

function pressureLabel(level: string): string {
  const labels: Record<string, string> = {
    normal: "正常",
    watch: "关注",
    "retrieval-tight": "检索收紧",
    "soft-compact": "轻量压缩",
    "deep-compact": "深度压缩",
    emergency: "紧急压缩",
    "hard-guard": "硬限保护"
  };
  return labels[level] ?? level;
}

/**
 * The character's stable definition (§4.2.1 / §4.2.7): persona, voice, a few
 * fixed judgment biases and formative memories. This is who the person is —
 * it never reveals their in-game role, private beliefs or hidden knowledge.
 */
function CharacterSection({ profile }: { profile: SocietyParticipantProfile }): ReactNode {
  const hasDefinition = Boolean(profile.persona || profile.voice || profile.decisionBiases?.length || profile.autobiographicalAnchors?.length);
  if (!hasDefinition) return null;
  return (
    <section>
      <SectionTitle>人物底色</SectionTitle>
      <div className="space-y-2">
        {profile.persona ? <p className="text-sm leading-6 text-foreground/85">{profile.persona}</p> : null}
        {profile.voice ? <p className="text-xs leading-5 text-muted-foreground">口吻：{profile.voice}</p> : null}
        {profile.decisionBiases?.length ? (
          <div>
            <div className="flex flex-wrap gap-1.5">
              {profile.decisionBiases.map((bias) => (
                <span key={bias} className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground" title={biasNote(bias)}>
                  {biasLabel(bias)}
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground/60">稳定的认知倾向，属于人物底色：它们让同一件事在不同人眼里不一样，但不决定任何一次行动。</p>
          </div>
        ) : null}
        {profile.autobiographicalAnchors?.length ? (
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
            <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">自传记忆——塑造本能的经历</p>
            <ul className="space-y-1">
              {profile.autobiographicalAnchors.map((anchor, index) => (
                <li key={index} className="text-xs leading-5 text-muted-foreground/90">{anchor}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function biasLabel(bias: DecisionBias): string {
  const labels: Record<DecisionBias, string> = {
    confirmation: "确认偏误",
    "loss-aversion": "损失厌恶",
    "sunk-cost": "沉没成本",
    "in-group": "圈内偏好",
    "authority-sensitivity": "权威敏感",
    "betrayal-hypervigilance": "背叛警觉",
    "overconfident-lie-detection": "自信识谎",
    "self-consistency": "立场一贯",
    "recency-weighting": "近期加权"
  };
  return labels[bias];
}

function biasNote(bias: DecisionBias): string {
  const notes: Record<DecisionBias, string> = {
    confirmation: "更倾向于寻找支持自己当前判断的证据",
    "loss-aversion": "失去已有之物的痛，大于得到同等的快乐",
    "sunk-cost": "已经投入过的路线，更难放手",
    "in-group": "更偏向自己人，对外来信号打折",
    "authority-sensitivity": "对资历与权威的声音更易服从",
    "betrayal-hypervigilance": "过度警觉背叛，信任掉得快、回得慢",
    "overconfident-lie-detection": "高估自己识破谎言的能力",
    "self-consistency": "公开立场一旦形成，倾向升级捍卫而非回头",
    "recency-weighting": "近期事件压过长期规律"
  };
  return notes[bias];
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

/**
 * Slow personality drift (AGENTS.md §4.2.8): the baseline stays the person,
 * but repeated high-intensity experiences move a bounded adaptation. Only
 * drifted traits are shown, with the direction and the recorded cause — the
 * observer sees a person changing, not a stats dump.
 */
function TraitDriftSection({ mind }: { mind: AgentMindState }): ReactNode {
  const states = mind.traitAdaptations;
  if (!states) return null;
  const drifted = (Object.entries(states) as Array<[string, { baseline: number; adaptation: number; effective: number; lastCauses: string[] }]>)
    .filter(([, state]) => Math.abs(state.adaptation) >= 0.02)
    .sort((left, right) => Math.abs(right[1].adaptation) - Math.abs(left[1].adaptation));
  if (!drifted.length) return null;
  return (
    <section>
      <SectionTitle>人格偏移</SectionTitle>
      <div className="space-y-2">
        <p className="text-[11px] leading-4 text-muted-foreground/80">性格底色不变，但反复的高强度经历会留下缓慢、有界的偏移——不强化就会随时间回弹。</p>
        {drifted.map(([trait, state]) => {
          const up = state.adaptation > 0;
          return (
            <div key={trait} className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground/90">{traitLabel(trait)}</p>
                <span className={cn("nums font-mono text-[10px]", up ? "text-emerald-300" : "text-rose-300")}>
                  {up ? "↑" : "↓"} {Math.round(state.baseline * 100)}% → {Math.round(state.effective * 100)}%
                </span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full", up ? "bg-emerald-400/70" : "bg-rose-400/70")} style={{ width: `${Math.min(100, Math.abs(state.adaptation) * 400)}%` }} />
              </div>
              {state.lastCauses.length ? (
                <p className="mt-1.5 text-xs leading-4 text-muted-foreground">因为:{state.lastCauses[0]}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function traitLabel(trait: string): string {
  const labels: Record<string, string> = {
    openness: "开放性",
    conscientiousness: "尽责性",
    extraversion: "外向性",
    agreeableness: "宜人性",
    neuroticism: "神经质"
  };
  return labels[trait] ?? trait;
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
  if (!mind.cognitivePasses.length) return null;
  return (
    <section>
      <SectionTitle>内部认知</SectionTitle>
      <div className="space-y-2">
        {mind.cognitivePasses.slice(-4).reverse().map((pass, index) => (
          <div key={index} className="rounded-lg border border-border bg-card p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{deliberationLabel(pass.kind)}</p>
            <p className="mt-1 text-sm leading-5 text-foreground/80">{pass.text}</p>
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