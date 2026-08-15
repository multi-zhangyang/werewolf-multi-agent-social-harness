import { useMemo, type ReactNode } from "react";
import { BrainCircuit, Database, Goal, Network, TerminalSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { SocietyRoomEventEnvelope, SocietyRoomSnapshot } from "@/society/room";
import { AgentAvatar, EmptyPanel, eventLabel, formatClock, ModelLabel, RoleBadge, StatusBadge } from "./shared";

export function AgentInspector({
  room,
  events,
  selectedAgentId,
  onSelectAgent
}: {
  room: SocietyRoomSnapshot;
  events: SocietyRoomEventEnvelope[];
  selectedAgentId?: string;
  onSelectAgent(agentId: string): void;
}): ReactNode {
  const selected = room.agents.find((agent) => agent.profile.id === selectedAgentId) ?? room.agents[0];
  const selectedIndex = room.agents.findIndex((agent) => agent.profile.id === selected?.profile.id);
  const notes = useMemo(() => events.filter((entry) => entry.event.type === "agent.note" && entry.event.actorId === selected?.profile.id), [events, selected?.profile.id]);
  const tools = useMemo(() => events.filter((entry) => entry.event.type === "agent.tool" && entry.event.actorId === selected?.profile.id), [events, selected?.profile.id]);
  if (!selected) return null;

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-white/10 bg-zinc-950/85 backdrop-blur-xl">
      <div className="border-b border-white/10 px-4 py-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium">参与者</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{room.agents.length} 个独立运行实例</p>
          </div>
          <Network className="size-4 text-zinc-600" />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {room.agents.map((agent, index) => (
            <button
              key={agent.profile.id}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:bg-white/[0.04]",
                agent.profile.id === selected.profile.id && "border-white/10 bg-white/[0.06]"
              )}
              onClick={() => onSelectAgent(agent.profile.id)}
            >
              <span className="relative">
                <AgentAvatar name={agent.profile.displayName} index={index} className="size-7" />
                <span className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-zinc-950 bg-zinc-600", ["thinking", "acting", "speaking"].includes(agent.status) && "live-pulse bg-emerald-400", agent.status === "error" && "bg-red-400")} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[11px] font-medium">{agent.profile.displayName}</span>
                <span className="block truncate text-[9px] text-zinc-600">{agent.observerRole ?? "参与者"}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="border-b border-white/10 px-4 py-4">
        <div className="flex items-start gap-3">
          <AgentAvatar name={selected.profile.displayName} index={selectedIndex} className="size-10" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold">{selected.profile.displayName}</h2>
              <RoleBadge role={selected.observerRole} />
            </div>
            <div className="mt-1 flex items-center gap-2">
              <ModelLabel model={selected.profile.model} compact />
              <span className="text-zinc-700">·</span>
                <span className="font-mono text-[10px] text-zinc-600">{selected.turnCount} 回合</span>
            </div>
          </div>
          <StatusBadge status={selected.status} compact />
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{selected.profile.persona}</p>
      </div>

      <Tabs defaultValue="state" className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="h-10 w-full justify-start gap-4 border-b border-white/10 px-4">
          <TabsTrigger value="state" className="px-0 text-xs">状态</TabsTrigger>
          <TabsTrigger value="relations" className="px-0 text-xs">关系</TabsTrigger>
          <TabsTrigger value="memory" className="px-0 text-xs">记忆</TabsTrigger>
          <TabsTrigger value="tools" className="px-0 text-xs">工具</TabsTrigger>
        </TabsList>

        <TabsContent value="state" className="min-h-0">
          <ScrollArea className="h-[calc(100vh-22rem)] min-h-80">
            <div className="space-y-5 p-4">
              <section>
                <SectionTitle icon={<BrainCircuit />} title="当前状态" />
                {selected.mind ? (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-white/10 bg-white/[0.025] p-3">
                      <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">情绪</span><span>{selected.mind.mood}</span></div>
                      <div className="mt-3 flex items-center justify-between text-xs"><span className="text-muted-foreground">精力</span><span className="font-mono text-[10px]">{Math.round(selected.mind.energy * 100)}%</span></div>
                      <Progress value={selected.mind.energy * 100} className="mt-2 h-1 bg-white/10" />
                    </div>
                    <div>
                      <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-zinc-600">注意力</p>
                      <div className="flex flex-wrap gap-1.5">{selected.mind.attention.map((item) => <Badge key={item} variant="outline" className="border-white/10 bg-white/[0.02] text-[10px] font-normal text-zinc-400">{item}</Badge>)}</div>
                    </div>
                  </div>
                ) : <EmptyPanel title="等待 Agent 启动" />}
              </section>
              <Separator />
              <section>
                <SectionTitle icon={<Goal />} title="目标" />
                <div className="space-y-2">
                  {selected.mind?.goals.map((goal) => (
                    <div key={goal.id} className="rounded-lg border border-white/10 p-3">
                      <div className="flex items-start justify-between gap-2"><p className="text-xs leading-5">{goal.description}</p><Badge variant="outline" className="h-5 border-white/10 text-[9px] text-muted-foreground">{goal.status}</Badge></div>
                      <p className="mt-1.5 text-[10px] leading-4 text-zinc-600">{goal.progress}</p>
                    </div>
                  )) ?? null}
                </div>
              </section>
              <Separator />
              <section>
                <SectionTitle icon={<BrainCircuit />} title="决策摘要" />
                <div className="space-y-2">
                  {notes.slice(-6).reverse().map((entry) => entry.event.type === "agent.note" ? (
                    <div key={entry.seq} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                      <div className="flex items-center justify-between"><span className="text-[10px] text-muted-foreground">{noteLabel(entry.event.kind)}</span><time className="font-mono text-[9px] text-zinc-600">{formatClock(entry.event.at)}</time></div>
                      <p className="mt-1.5 text-xs leading-5 text-zinc-300">{entry.event.text}</p>
                    </div>
                  ) : null)}
                  {!notes.length ? <EmptyPanel title="暂无摘要" /> : null}
                </div>
              </section>
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="relations" className="min-h-0">
          <ScrollArea className="h-[calc(100vh-22rem)] min-h-80">
            <div className="space-y-3 p-4">
              {selected.mind?.relationships.map((relationship) => {
                const other = room.agents.find((agent) => agent.profile.id === relationship.agentId);
                const otherIndex = room.agents.findIndex((agent) => agent.profile.id === relationship.agentId);
                return (
                  <div key={relationship.agentId} className="rounded-lg border border-white/10 p-3">
                    <div className="mb-3 flex items-center gap-2">
                      <AgentAvatar name={other?.profile.displayName ?? relationship.agentId} index={otherIndex} className="size-7" />
                      <div className="min-w-0 flex-1"><p className="text-xs font-medium">{other?.profile.displayName ?? relationship.agentId}</p><p className="mt-0.5 truncate text-[10px] text-zinc-600">{relationship.note}</p></div>
                    </div>
                    <Metric label="信任" value={relationship.trust} />
                    <Metric label="亲近" value={relationship.affinity} />
                    <Metric label="尊重" value={relationship.respect} />
                    <Metric label="紧张" value={relationship.tension} danger />
                  </div>
                );
              }) ?? null}
              {selected.mind && !selected.mind.relationships.length ? <EmptyPanel title="暂无关系变化" /> : null}
              {selected.mind?.beliefs.length ? (
                <>
                  <Separator className="my-4" />
                  <SectionTitle icon={<BrainCircuit />} title="信念" />
                  {selected.mind.beliefs.slice().reverse().map((belief, index) => (
                    <div key={`${belief.subjectId}-${belief.proposition}-${index}`} className="rounded-lg border border-white/10 p-3">
                      <div className="flex items-center justify-between"><span className="font-mono text-[10px] text-muted-foreground">{belief.subjectId}</span><span className="font-mono text-[10px]">{Math.round(belief.confidence * 100)}%</span></div>
                      <p className="mt-1.5 text-xs leading-5">{belief.proposition}</p>
                      <p className="mt-1 text-[10px] leading-4 text-zinc-600">{belief.source}</p>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="memory" className="min-h-0">
          <ScrollArea className="h-[calc(100vh-22rem)] min-h-80">
            <div className="space-y-2 p-4">
              <SectionTitle icon={<Database />} title={`${selected.mind?.memories.length ?? 0} 条记忆`} />
              {selected.mind?.memories.map((memory) => (
                <div key={memory.id} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between"><span className="font-mono text-[9px] text-zinc-600">TURN {memory.turn}</span><span className="font-mono text-[9px] text-zinc-600">S {memory.salience.toFixed(2)}</span></div>
                  <p className="mt-1.5 text-xs leading-5 text-zinc-300">{memory.text}</p>
                  {memory.tags.length ? <div className="mt-2 flex flex-wrap gap-1">{memory.tags.map((tag) => <span key={tag} className="font-mono text-[9px] text-zinc-600">#{tag}</span>)}</div> : null}
                </div>
              )) ?? null}
              {selected.mind && !selected.mind.memories.length ? <EmptyPanel title="暂无记忆" /> : null}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="tools" className="min-h-0">
          <ScrollArea className="h-[calc(100vh-22rem)] min-h-80">
            <div className="space-y-1 p-4">
              <SectionTitle icon={<TerminalSquare />} title={`${tools.length} 次工具调用`} />
              {tools.slice().reverse().map((entry) => entry.event.type === "agent.tool" ? (
                <div key={entry.seq} className="flex items-start gap-2.5 rounded-lg px-2 py-2.5 hover:bg-white/[0.025]">
                  <span className={cn("mt-1 size-1.5 rounded-full bg-amber-400", entry.event.phase === "completed" && "bg-emerald-400")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-medium">{eventLabel(entry.event.toolName)}</span><time className="font-mono text-[9px] text-zinc-600">{formatClock(entry.event.at)}</time></div>
                    {entry.event.summary ? <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{entry.event.summary}</p> : null}
                  </div>
                </div>
              ) : null)}
              {!tools.length ? <EmptyPanel title="暂无工具调用" /> : null}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }): ReactNode {
  return <div className="mb-3 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-zinc-600"><span className="[&_svg]:size-3.5">{icon}</span>{title}</div>;
}

function Metric({ label, value, danger = false }: { label: string; value: number; danger?: boolean }): ReactNode {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 flex items-center justify-between"><span className="text-[10px] text-muted-foreground">{label}</span><span className="font-mono text-[9px] text-zinc-600">{Math.round(value * 100)}</span></div>
      <Progress value={value * 100} className={cn("h-1 bg-white/10", danger && "[&_[data-slot=progress-indicator]]:bg-red-400")} />
    </div>
  );
}

function noteLabel(kind: string): string {
  const labels: Record<string, string> = { observation: "观察", reflection: "反思", decision: "决策", outcome: "结果" };
  return labels[kind] ?? kind;
}
