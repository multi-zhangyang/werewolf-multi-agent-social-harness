import { memo, useState, type ReactNode } from "react";
import { BrainCircuit, ChevronDown, Cpu, Pause, Play } from "lucide-react";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { RoomConnection } from "./use-room";
import { AgentAvatar, StatusDot, StatusLabel, readableModel } from "./shared";

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

  return (
    <>
      <ScrollArea className="h-full">
        <ul className="flex flex-col gap-1 p-2">
          {room.world.agents.map((agent) => {
            const participant = room.participants.find((entry) => entry.profile.id === agent.id);
            const speaking = agent.status === "speaking" || agent.status === "acting" || agent.status === "thinking";
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(agent.id)}
                  className={cn(
                    "group flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/40",
                    speaking && "border-emerald-500/25 bg-emerald-500/5"
                  )}
                >
                  <span className={cn("relative inline-flex", speaking && "on-air")}>
                    <AgentAvatar name={agent.displayName} seed={seeds.get(agent.id)} size="md" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{agent.displayName}</span>
                      <StatusDot status={agent.status} />
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      {participant?.mood ? <span className="truncate">{participant.mood}</span> : <StatusLabel status={agent.status} />}
                      {(agent.score ?? 0) !== 0 ? <span className="ml-auto font-mono">{agent.score}</span> : null}
                    </span>
                  </span>
                  {!agent.alive ? <Badge variant="outline" className="text-[9px]">离场</Badge> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
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
                私有心智仅对房主/operator 开放（§15.10）。当前公开视角只展示情绪外观与分数。
              </p>
            ) : null}

            {mind?.goals.length ? (
              <Section title="目标">
                {mind.goals.filter((goal) => goal.status === "active").slice(0, 5).map((goal) => (
                  <p key={goal.id} className="text-xs leading-5">· {goal.description}{goal.progress ? <span className="text-muted-foreground">（{goal.progress}）</span> : null}</p>
                ))}
              </Section>
            ) : null}

            {beliefs.length ? (
              <Section title="信念">
                {beliefs.map((belief) => (
                  <p key={`${belief.subjectId}:${belief.proposition}`} className="text-xs leading-5 text-muted-foreground">
                    · {belief.proposition} <span className="font-mono">{Math.round((belief.probability ?? belief.confidence) * 100)}%</span>
                  </p>
                ))}
              </Section>
            ) : null}

            {relationships.length ? (
              <Section title="关系（有向）">
                {relationships.map((relationship) => (
                  <p key={relationship.targetCharacterId} className="flex justify-between text-xs">
                    <span>{mind?.relationships.find((entry) => entry.targetCharacterId === relationship.targetCharacterId)?.note ?? relationship.targetCharacterId}</span>
                    <span className="font-mono text-muted-foreground">信任 {relationship.trust.toFixed(2)}</span>
                  </p>
                ))}
              </Section>
            ) : null}

            {memories.length ? (
              <Section title="最近记忆">
                {memories.map((memory) => (
                  <p key={memory.id} className="line-clamp-3 text-xs leading-5 text-muted-foreground">· {memory.text}</p>
                ))}
              </Section>
            ) : null}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="rounded-lg border border-border/60 bg-card/50 px-2 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="truncate text-xs font-medium">{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <Collapsible defaultOpen className="rounded-lg border border-border/60">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium">
        <BrainCircuit className="size-3.5 text-muted-foreground" aria-hidden />
        {title}
        <ChevronDown className="ml-auto size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-1 border-t border-border/50 px-3 py-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
