import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BrainCircuit,
  MessagesSquare,
  Play,
  Radio,
  Settings2,
  Trash2,
  Users,
  Waypoints
} from "lucide-react";
import type { ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScenarioIcon, StatusDot, StatusLabel } from "./shared";
import type { ModelOption } from "./types";
import { cn } from "@/lib/utils";

interface LandingProps {
  scenarios: ScenarioSummary[];
  models: ModelOption[];
  rooms: SocietyRoomSnapshot[];
  onStart: (scenarioId: string) => void;
  onOpenRoom: (roomId: string) => void;
  onOpenSettings: () => void;
  onOpenCharacters: () => void;
  onOpenAbout: () => void;
  /** Stop and release a room; nothing is persisted. */
  onRemoveRoom: (roomId: string) => void;
}

export function Landing({ scenarios, models, rooms, onStart, onOpenRoom, onOpenSettings, onOpenCharacters, onOpenAbout, onRemoveRoom }: LandingProps): ReactNode {
  return (
    <div className="min-h-screen bg-background">
      <header className="rule-b sticky top-0 z-20 bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <button className="flex items-center gap-2.5" onClick={() => { location.hash = "#/"; }}>
            <span className="flex size-7 items-center justify-center rounded-md bg-foreground font-mono text-xs text-background">◆</span>
            <span className="text-[15px] font-semibold tracking-tight">Society</span>
          </button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="rounded-lg px-3 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onOpenCharacters}>
              <Users className="size-3.5" />
              人物库
            </Button>
            <Button variant="ghost" size="sm" className="hidden rounded-lg px-3 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex" onClick={onOpenAbout}>
              关于
            </Button>
            {rooms.length ? (
              <Badge variant="outline" className="hidden gap-1.5 rounded-full border-border px-3 py-1 font-normal text-muted-foreground sm:inline-flex">
                <span className="live-pulse size-1.5 rounded-full bg-foreground" />
                {rooms.length} 个活跃世界
              </Badge>
            ) : null}
            <Button variant="tile" size="icon-sm" aria-label="模型提供商设置" onClick={onOpenSettings}>
              <Settings2 className="size-3.5" />
            </Button>
            <Button size="sm" className="rounded-lg px-4" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
              <Play className="size-3.5" />
              创建世界
            </Button>
          </div>
        </div>
      </header>

      <main>
        <section className="mx-auto w-full max-w-3xl px-6 pb-20 pt-20 text-center sm:pt-28">
          {rooms.length ? (
            <p className="mx-auto flex w-fit items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-muted-foreground">
              <span className="live-pulse size-1.5 rounded-full bg-live" />
              {rooms.length} 个世界正在直播
              <span className="text-muted-foreground/50">·</span>
              <button className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => onOpenRoom(rooms[0]!.id)}>进去看看</button>
            </p>
          ) : null}
          <h1 className="text-balance text-4xl font-semibold leading-[1.15] tracking-tight sm:text-5xl">
            多智能体社会博弈竞技场
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-balance text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
            真实的模型 Agent 在 {scenarios.length} 个社会压力场景里谈判、结盟、欺骗与背叛。每个参与者都有独立的会话、情绪与立场，记得发生过的事。
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" className="h-11 rounded-lg px-8" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
              开始一场博弈
              <ArrowRight className="size-4" />
            </Button>
            <Button size="lg" variant="ghost" asChild className="h-11 rounded-lg border border-border/70 bg-transparent px-7 text-foreground/80 hover:bg-muted/60 hover:text-foreground">
              <a href="#scenarios">
                浏览全部世界
                <ArrowDown className="size-4" />
              </a>
            </Button>
          </div>
          <p className="mt-10 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span className="text-foreground">{scenarios.length}</span> 个世界
            <span className="text-border">·</span>
            {models.length > 0 ? (
              <>
                <span className="text-foreground">{models.length}</span> 个可用模型
                <span className="text-border">·</span>
              </>
            ) : null}
            {rooms.length > 0 ? (
              <>
                <span className="text-foreground">{rooms.length}</span> 场进行中
              </>
            ) : null}
          </p>
        </section>

        <section className="mx-auto w-full max-w-6xl px-6 pb-24">
          <SectionHeading title="核心能力" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCell icon={Radio} title="全程直播">
              思考、推理、工具调用与发言逐字流出，每一次转折背后都是真实的工具调用。
            </FeatureCell>
            <FeatureCell icon={Waypoints} title="因果账本">
              承诺、指控、怀疑与欺骗按来源分层记录，承诺有履约与违约的结算。
            </FeatureCell>
            <FeatureCell icon={BrainCircuit} title="情绪与信念">
              世界事件经评估引擎写成情绪、需求与关系，只有全知视角看得见。
            </FeatureCell>
            <FeatureCell icon={MessagesSquare} title="多模型混编">
              每个席位可以运行不同的模型；夜间行动与同时投票在结算前不进入公开画面。
            </FeatureCell>
          </div>
        </section>

        <section id="scenarios" className="mx-auto w-full max-w-6xl scroll-mt-20 px-6 pb-24">
          <SectionHeading title="全部世界" count={scenarios.length} />
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {scenarios.map((scenario, index) => (
              <WorldCard
                key={scenario.id}
                scenario={scenario}
                index={index}
                wide={scenarios.length % 3 === 1 && index === scenarios.length - 1}
                onStart={() => onStart(scenario.id)}
              />
            ))}
          </div>
        </section>

        {rooms.length ? (
          <section className="mx-auto w-full max-w-6xl px-6 pb-28">
            <SectionHeading title="进行中的房间" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rooms.slice(0, 6).map((room) => (
                <div
                  key={room.id}
                  className="group flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/30"
                >
                  <button onClick={() => onOpenRoom(room.id)} className="flex min-w-0 flex-1 items-center gap-4 text-left">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
                      <ScenarioIcon id={room.scenarioId} className="size-4.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold tracking-tight">{room.title}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground/80">
                        <StatusDot status={room.status} className="[&>span]:bg-foreground" />
                        <StatusLabel status={room.status} />
                        <span className="text-muted-foreground/50">·</span>
                        <span className="nums">{room.participants.length} 名参与者</span>
                      </span>
                    </span>
                  </button>
                  {room.mode === "ai" ? (
                    <button
                      type="button"
                      aria-label={`移除 ${room.title}`}
                      title="停止并移除：对局立即结束且不可恢复"
                      onClick={() => onRemoveRoom(room.id)}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-border hover:text-background"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                  <ArrowRight className="size-4 shrink-0 -translate-x-1 text-muted-foreground/40 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:text-foreground group-hover:opacity-100" />
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </main>

      <footer className="rule-t py-10">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-6 text-xs text-muted-foreground/80 sm:flex-row">
          <span className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded bg-foreground font-mono text-[9px] text-background">◆</span>
            Society · Live Multi-Agent Social Worlds
          </span>
          <span className="flex items-center gap-4">
            <button onClick={onOpenAbout} className="transition-colors hover:text-foreground/80">关于</button>
            <span className="text-muted-foreground/50">·</span>
            <span className="nums font-mono">{scenarios.length} worlds · OpenAI Agents SDK</span>
          </span>
        </div>
      </footer>
    </div>
  );
}

/** Plain section opener: title, optional count, hairline. */
function SectionHeading({ title, count }: { title: string; count?: number }): ReactNode {
  return (
    <div className="mb-8 flex items-center gap-4">
      <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
      {count !== undefined ? <span className="nums text-sm text-muted-foreground">{count}</span> : null}
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

function FeatureCell({ icon: Icon, title, children }: { icon: typeof Radio; title: string; children: ReactNode }): ReactNode {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <Icon className="size-4.5 text-muted-foreground" />
      <h3 className="mt-3 text-[15px] font-semibold tracking-tight">{title}</h3>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * World card: icon, name, players, a three-line brief. The whole card starts
 * a world; the arrow highlights on hover as the only motion.
 */
function WorldCard({ scenario, index, wide, onStart }: { scenario: ScenarioSummary; index: number; wide?: boolean; onStart: () => void }): ReactNode {
  return (
    <button
      onClick={onStart}
      className={cn(
        "group relative flex items-start gap-3.5 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-foreground/30 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground",
        wide && "sm:col-span-2 lg:col-span-3"
      )}
    >
      <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground transition-colors group-hover:text-foreground">
        <ScenarioIcon id={scenario.id} className="size-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2.5">
          <span className="truncate text-[15px] font-semibold tracking-tight">{scenario.name}</span>
          <span className="nums shrink-0 font-mono text-[10px] text-muted-foreground/75">
            {scenario.playerRange ? `${scenario.playerRange.min}-${scenario.playerRange.max}P` : `${scenario.players}P`}
          </span>
        </span>
        <span className="mt-1.5 line-clamp-3 block text-[13px] leading-5 text-muted-foreground" title={scenario.description}>
          {scenario.description}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="nums font-mono text-[11px] text-muted-foreground/40">{String(index + 1).padStart(2, "0")}</span>
        <ArrowUpRight className="size-4 text-muted-foreground/30 transition-colors group-hover:text-foreground" aria-hidden />
      </span>
    </button>
  );
}
