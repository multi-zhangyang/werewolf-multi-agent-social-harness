import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { BrainCircuit, Cpu, Crown, Pause, Play, Users } from "lucide-react";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { RoomConnection } from "./use-room";
import { AgentAvatar, CollapsibleSection, StatusDot, StatusLabel, readableModel } from "./shared";

/** One registered model profile as offered by /api/scenarios. */
export interface ModelOption {
  id: string;
  profileId: string;
  name: string;
  contextLabel?: string;
}

/**
 * Left rail: one compact card per participant — avatar, live status, score.
 * Click opens the mind sheet (privileged viewers see the full inner state).
 */

export const ParticipantsRail = memo(function ParticipantsRail({
  room,
  viewerPrivileged,
  onToggleAgentPause,
  models = [],
  onSwitchModel
}: {
  room: SocietyRoomSnapshot;
  viewerPrivileged: boolean;
  onToggleAgentPause?: RoomConnection["toggleAgentPause"];
  models?: ModelOption[];
  onSwitchModel?: RoomConnection["switchAgentModel"];
}): ReactNode {
  const [openId, setOpenId] = useState<string>();
  const selected = room.participants.find((participant) => participant.profile.id === openId);
  const seeds = new Map(room.participants.map((participant) => [participant.profile.id, participant.profile.characterId]));
  // Ties lead together: everyone at the top score wears the crown.
  const topScore = Math.max(0, ...room.world.agents.map((agent) => agent.score ?? 0));
  const isLeader = (agent: SocietyRoomSnapshot["world"]["agents"][number]): boolean =>
    (agent.score ?? 0) > 0 && (agent.score ?? 0) === topScore;

  return (
    <>
      <div className="panel flex h-full min-h-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <Users className="size-3 text-muted-foreground" aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">参与者</span>
          <span className="nums ml-auto font-mono text-[10px] text-muted-foreground/50">{room.world.agents.length}</span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-0.5 p-2">
            {room.world.agents.map((agent) => {
              const participant = room.participants.find((entry) => entry.profile.id === agent.id);
              const speaking = agent.status === "speaking" || agent.status === "acting" || agent.status === "thinking";
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(agent.id)}
                    className={cn(
                      "group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-muted/40",
                      speaking && "bg-live/[0.08] shadow-[inset_2px_0_0_oklch(0.77_0.15_160/0.7)]",
                      !speaking && isLeader(agent) && "leader-wash"
                    )}
                  >
                    <span className={cn("relative inline-flex", speaking && "on-air")}>
                      <AgentAvatar name={agent.displayName} seed={seeds.get(agent.id)} size="md" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="min-w-0 truncate text-xs font-medium">{agent.displayName}</span>
                        {!speaking && isLeader(agent) ? <Crown className="size-3 shrink-0 text-warn" aria-label="暂时领先" /> : null}
                        <StatusDot status={agent.status} className="size-2" />
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/85">
                        {participant?.mood ? <span className="min-w-0 truncate">{participant.mood}</span> : <StatusLabel status={agent.status} />}
                        {(agent.score ?? 0) !== 0 ? <ScoreValue value={agent.score ?? 0} /> : null}
                      </span>
                    </span>
                    {!agent.alive ? <Badge variant="outline" className="text-[9px]">离场</Badge> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </div>
      <MindSheet
        participant={selected}
        room={room}
        privileged={viewerPrivileged}
        onToggleAgentPause={onToggleAgentPause}
        models={models}
        onSwitchModel={onSwitchModel}
        onClose={() => setOpenId(undefined)}
      />
    </>
  );
});

function MindSheet({ participant, room, privileged, onToggleAgentPause, models, onSwitchModel, onClose }: {
  participant: SocietyRoomSnapshot["participants"][number] | undefined;
  room: SocietyRoomSnapshot;
  privileged: boolean;
  onToggleAgentPause?: RoomConnection["toggleAgentPause"];
  models: ModelOption[];
  onSwitchModel?: RoomConnection["switchAgentModel"];
  onClose: () => void;
}): ReactNode {
  if (!participant) return null;
  const mind = privileged ? participant.mind : undefined;
  const worldAgent = room.world.agents.find((agent) => agent.id === participant.profile.id);
  const beliefs = [...(mind?.beliefs ?? [])].slice(-6).reverse();
  const relationships = [...(mind?.relationships ?? [])].sort((left, right) => right.trust - left.trust);
  const memories = [...(mind?.memories ?? [])].slice(-6).reverse();
  const canSwitchModel = privileged && Boolean(onSwitchModel) && models.length > 0;
  // The snapshot carries the live model id; map it back to the registered
  // profile so the Select shows the current engine. An unregistered id still
  // displays but cannot be re-selected.
  const currentOption = models.find((option) => option.id === participant.profile.model);
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="left" className="flex w-[380px] flex-col gap-0 border-border bg-background p-0 sm:max-w-[380px]">
        <SheetHeader className="shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <AgentAvatar name={participant.profile.displayName} seed={participant.profile.characterId} size="lg" />
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-base">{participant.profile.displayName}</SheetTitle>
              <p className="truncate text-xs text-muted-foreground">{participant.profile.persona}</p>
            </div>
          </div>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-4">
            <section className="grid grid-cols-3 gap-2 text-center">
              <Stat label="状态" value={<StatusLabel status={worldAgent?.status ?? participant.status} />} />
              <Stat label="心情" value={participant.mood ?? "—"} />
              <Stat label="能量" value={participant.energy !== undefined ? `${participant.energy}%` : "—"} />
            </section>

            {privileged && onToggleAgentPause ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void onToggleAgentPause(participant.profile.id, !participant.paused)}
              >
                {participant.paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
                {participant.paused ? "恢复该参与者" : "暂停该参与者"}
              </Button>
            ) : null}

            {canSwitchModel ? (
              <div className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Cpu className="size-3.5" aria-hidden />
                  运行模型
                </p>
                <Select
                  value={currentOption?.profileId ?? ""}
                  onValueChange={(profileId) => {
                    const option = models.find((entry) => entry.profileId === profileId);
                    if (!option || !onSwitchModel) return;
                    void onSwitchModel(participant.profile.id, profileId)
                      .then(() => toast.success(`已切换到 ${readableModel(option.id)}——身份、记忆与关系保留`))
                      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : "模型切换失败"));
                  }}
                >
                  <SelectTrigger size="sm" className="w-full text-xs" aria-label="切换该参与者的模型">
                    <SelectValue placeholder={participant.profile.model ? readableModel(participant.profile.model) : "选择模型"} />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((option) => (
                      <SelectItem key={option.profileId} value={option.profileId} className="text-xs">
                        {option.name}
                        {option.contextLabel ? <span className="ml-1.5 text-[10px] text-muted-foreground">{option.contextLabel}</span> : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!currentOption && participant.profile.model ? (
                  <p className="text-[10px] leading-4 text-muted-foreground">当前引擎 {readableModel(participant.profile.model)} 未在模型中心登记，切换后将无法切回。</p>
                ) : null}
              </div>
            ) : null}

            {!privileged ? (
              <p className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                私有心智仅对房主/operator 开放。当前公开视角只展示情绪外观与分数。
              </p>
            ) : null}

            {mind?.goals.length ? (
              <CollapsibleSection title="目标" icon={<BrainCircuit aria-hidden />} defaultOpen>
                {mind.goals.filter((goal) => goal.status === "active").slice(0, 5).map((goal) => (
                  <p key={goal.id} className="text-xs leading-5">· {goal.description}{goal.progress ? <span className="text-muted-foreground">（{goal.progress}）</span> : null}</p>
                ))}
              </CollapsibleSection>
            ) : null}

            {beliefs.length ? (
              <CollapsibleSection title="信念" icon={<BrainCircuit aria-hidden />} defaultOpen>
                {beliefs.map((belief) => (
                  <p key={`${belief.subjectId}:${belief.proposition}`} className="text-xs leading-5 text-muted-foreground">
                    · {belief.proposition} <span className="font-mono">{Math.round((belief.probability ?? belief.confidence) * 100)}%</span>
                  </p>
                ))}
              </CollapsibleSection>
            ) : null}

            {relationships.length ? (
              <CollapsibleSection title="关系（有向）" icon={<BrainCircuit aria-hidden />} defaultOpen>
                {relationships.map((relationship) => (
                  <p key={relationship.targetCharacterId} className="flex justify-between text-xs">
                    <span>{mind?.relationships.find((entry) => entry.targetCharacterId === relationship.targetCharacterId)?.note ?? relationship.targetCharacterId}</span>
                    <span className="font-mono text-muted-foreground">信任 {relationship.trust.toFixed(2)}</span>
                  </p>
                ))}
              </CollapsibleSection>
            ) : null}

            {memories.length ? (
              <CollapsibleSection title="最近记忆" icon={<BrainCircuit aria-hidden />} defaultOpen>
                {memories.map((memory) => (
                  <p key={memory.id} className="line-clamp-3 text-xs leading-5 text-muted-foreground">· {memory.text}</p>
                ))}
              </CollapsibleSection>
            ) : null}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="sheen rounded-lg border border-border/60 bg-card/50 px-2 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="truncate text-xs font-medium">{value}</p>
    </div>
  );
}

/** Score with a floating delta that pops when the world settles a change. */
function ScoreValue({ value }: { value: number }): ReactNode {
  const last = useRef(value);
  const [delta, setDelta] = useState<number | null>(null);
  useEffect(() => {
    if (last.current === value) return;
    setDelta(value - last.current);
    last.current = value;
  }, [value]);
  useEffect(() => {
    if (delta === null) return;
    const timer = window.setTimeout(() => setDelta(null), 1_200);
    return () => window.clearTimeout(timer);
  }, [delta]);
  return (
    <span className="relative ml-auto font-mono">
      {value}
      {delta !== null ? (
        <span key={`${delta}:${value}`} className="score-pop absolute -top-3 right-0 text-[9px] font-normal text-warn">
          {delta > 0 ? `+${delta}` : delta}
        </span>
      ) : null}
    </span>
  );
}
