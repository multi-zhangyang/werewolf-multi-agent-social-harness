import { type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, BrainCircuit, MessagesSquare, Play, Radio, Settings2, Trash2, Users, Waypoints } from "lucide-react";
import type { ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentAvatar, ScenarioIcon, StatusDot, StatusLabel } from "./shared";
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

const FEATURES = [
  {
    icon: Radio,
    title: "全程直播，逐字可见",
    body: "每个 agent 的思考、推理、工具调用与发言逐字流出——像看比赛直播一样看它们决策。密封阶段（夜间行动、同时投票）自动封印画面，结算前不泄露任何选择。"
  },
  {
    icon: Waypoints,
    title: "真实 Agent 同台交锋",
    body: "每个参与者都是 OpenAI Agents SDK 的 Agent：独立会话、私有记忆、函数工具与自己的内部认知循环。只有成功的工具调用才能改变世界。"
  },
  {
    icon: BrainCircuit,
    title: "有记忆、有情绪、有人格",
    body: "记忆流、PAD 情绪、社会情绪、需求与关系账本持续演化。被当众指控会愤怒，被盟友背叛会记仇——过去真的会改变未来。"
  },
  {
    icon: MessagesSquare,
    title: "因果可追溯",
    body: "信念时间线、承诺账本、欺骗生命周期、有向关系——右侧因果栏把「为什么」按来源分层摊开，而不是只给你一句有戏剧性的台词。"
  }
];

/** Category color coding: cooperation / confrontation / deception. */
const CATEGORY: Record<string, { accent: string; bar: string; tag: string; tone: string }> = {
  cooperation: { accent: "text-live", bar: "bg-live", tag: "border-live/40 bg-live/15 text-live", tone: "var(--live)" },
  confrontation: { accent: "text-clash", bar: "bg-clash", tag: "border-clash/40 bg-clash/15 text-clash", tone: "var(--clash)" },
  deception: { accent: "text-secret", bar: "bg-secret", tag: "border-secret/40 bg-secret/15 text-secret", tone: "var(--secret)" }
};

const CATEGORY_OF: Record<string, keyof typeof CATEGORY> = {
  "public-goods": "cooperation",
  "stag-hunt": "cooperation",
  "trust-game": "cooperation",
  "centipede-game": "cooperation",
  "prisoners-dilemma": "confrontation",
  "chicken-game": "confrontation",
  "ultimatum-game": "confrontation",
  "beauty-contest": "confrontation",
  "sealed-bid-auction": "confrontation",
  "negotiation-game": "confrontation",
  werewolf: "deception",
  avalon: "deception",
  "liars-dice": "deception"
};

export function Landing({ scenarios, models, rooms, onStart, onOpenRoom, onOpenSettings, onOpenCharacters, onOpenAbout, onRemoveRoom }: LandingProps): ReactNode {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border/80 bg-background/65 backdrop-blur-2xl backdrop-saturate-150">
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
                <span className="live-pulse size-1.5 rounded-full bg-live" />
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

      {scenarios.length ? (
        <div className="sticky top-16 z-10 overflow-x-auto border-b border-border/80 bg-background/70 backdrop-blur-xl sm:overflow-x-visible">
          <div className="mx-auto flex w-full max-w-6xl flex-nowrap gap-1.5 px-6 py-2.5 sm:flex-wrap sm:justify-center">
            {scenarios.map((scenario) => {
              const tone = CATEGORY[CATEGORY_OF[scenario.id] ?? "confrontation"];
              return (
                <button
                  key={scenario.id}
                  onClick={() => onStart(scenario.id)}
                  className={cn(
                    "shrink-0 rounded-full border border-border px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted",
                    CATEGORY_OF[scenario.id] === "deception" && "hover:border-secret/40 hover:text-secret",
                    CATEGORY_OF[scenario.id] === "confrontation" && "hover:border-clash/40 hover:text-clash",
                    CATEGORY_OF[scenario.id] === "cooperation" && "hover:border-live/40 hover:text-live"
                  )}
                >
                  <span className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", tone.bar)} />
                  {scenario.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <main className="mx-auto w-full max-w-6xl px-6 pb-28">
        <section className="mx-auto max-w-3xl pt-14 pb-12 text-center sm:pt-20">
          <Badge variant="outline" className="reveal-up mb-8 rounded-full border-border bg-card px-3.5 py-1.5 text-xs font-medium tracking-wide text-foreground/85">
            Powered by OpenAI Agents SDK
          </Badge>
          <h1 className="hero-ink reveal-up text-balance text-5xl font-semibold leading-[1.06] tracking-tight sm:text-7xl" style={{ animationDelay: "70ms" }}>
            <span className="sm:block">多智能体社会</span>
            <span className="sm:block">博弈竞技场</span>
          </h1>
          <p className="reveal-up mx-auto mt-6 max-w-2xl text-balance text-lg leading-8 text-muted-foreground sm:text-xl" style={{ animationDelay: "140ms" }}>
            狼人杀、阿瓦隆、囚徒困境——真实的模型 Agent 在 {scenarios.length} 个世界里谈判、结盟、欺骗与背叛。每个参与者都带着记忆、情绪与人格，过去真的会改变未来。
          </p>
          <div className="reveal-up mt-10 flex items-center justify-center gap-3" style={{ animationDelay: "210ms" }}>
            <Button size="lg" className="h-11 rounded-lg px-8 shadow-sm" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
              开始一场博弈
              <ArrowRight className="size-4" />
            </Button>
            <Button size="lg" variant="ghost" asChild className="h-11 rounded-lg border border-transparent px-7 text-foreground/80 hover:bg-muted/60 hover:text-foreground">
              <a href="#scenarios">
                浏览全部世界
                <ArrowDown className="size-4" />
              </a>
            </Button>
          </div>

          <div className="reveal-up" style={{ animationDelay: "280ms" }}>
            <HeroStage />
          </div>

          <div className="reveal-up mt-12 flex flex-wrap items-center justify-center gap-3" style={{ animationDelay: "350ms" }}>
            <StatCard value={String(scenarios.length).padStart(2, "0")} label="博弈世界" />
            {rooms.length > 0 ? <StatCard value={String(rooms.length).padStart(2, "0")} label="进行中" live /> : null}
            {models.length > 0 ? <StatCard value={String(models.length).padStart(2, "0")} label="可用模型" /> : null}
          </div>
        </section>

        <section className="mb-20 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="group bg-card p-8 transition-colors hover:bg-card/80">
                <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground transition-colors group-hover:border-foreground/30 group-hover:text-foreground">
                  <Icon className="size-4.5" />
                </span>
                <h3 className="mt-4 text-[15px] font-semibold tracking-tight">{feature.title}</h3>
                <p className="mt-2.5 text-sm leading-6 text-muted-foreground">{feature.body}</p>
              </div>
            );
          })}
        </section>

        <section id="scenarios" className="scroll-mt-20">
          <div className="mb-8 flex items-end justify-between">
            <div className="flex items-center gap-3">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/80">Worlds</p>
              <h2 className="text-2xl font-semibold tracking-tight">博弈与欺骗的竞技场</h2>
              <span className="nums rounded-full border border-border px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {String(scenarios.length).padStart(2, "0")}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {scenarios.map((scenario, index) => (
              <ScenarioCard
                key={scenario.id}
                scenario={scenario}
                onStart={() => onStart(scenario.id)}
                wide={scenarios.length % 2 === 1 && index === scenarios.length - 1}
              />
            ))}
          </div>
        </section>

        {rooms.length ? (
          <section className="mt-24">
            <div className="mb-6 flex items-end justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/80">Live</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">正在发生的世界</h2>
              </div>
              <span className="nums flex items-center gap-2 font-mono text-xs text-muted-foreground/80">
                <span className="live-pulse size-1.5 rounded-full bg-live" />
                {rooms.length} rooms
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rooms.slice(0, 6).map((room) => (
                <div
                  key={room.id}
                  className="group flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.6)]"
                >
                  <button onClick={() => onOpenRoom(room.id)} className="flex min-w-0 flex-1 items-center gap-4 text-left">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
                      <ScenarioIcon id={room.scenarioId} className="size-4.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold tracking-tight">{room.title}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground/80">
                        <StatusDot status={room.status} />
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
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-border hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/50 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </main>

      <footer className="border-t border-border py-10">
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

/** A quiet stage: the same characters reappear across games, connected by history. */
function HeroStage(): ReactNode {
  const cast = [
    { name: "林默", characterId: "builtin-01" },
    { name: "苏遥", characterId: "builtin-02" },
    { name: "陈策", characterId: "builtin-03" },
    { name: "唐妍", characterId: "builtin-06" }
  ];
  return (
    <div className="relative mx-auto mt-12 flex h-28 w-fit items-start justify-center px-10 pt-2" aria-hidden>
      {/* floor: a hairline the cast stands on, lit softly from beneath */}
      <span className="absolute inset-x-2 bottom-3 h-px bg-gradient-to-r from-transparent via-foreground/20 to-transparent" aria-hidden />
      <span className="absolute inset-x-10 bottom-0 h-10 bg-[radial-gradient(55%_100%_at_50%_0%,oklch(1_0_0/0.05),transparent_75%)]" aria-hidden />
      <svg className="absolute inset-x-0 top-2 h-full w-full" viewBox="0 0 300 96" preserveAspectRatio="none">
        <path className="dash-flow" d="M74 34 C 100 12, 200 12, 226 34" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.1" strokeDasharray="3 5" />
        <path className="dash-flow" style={{ animationDelay: "0.6s" }} d="M74 34 C 100 56, 200 56, 226 34" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.1" strokeDasharray="3 5" />
        <path d="M36 34 C 80 2, 220 2, 264 34" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
      </svg>
      <div className="relative flex items-start gap-9">
        {cast.map((character, index) => (
          <span key={character.characterId} className={cn("relative flex flex-col items-center gap-2 rounded-lg", index % 2 === 1 && "translate-y-3")}>
            <span className="relative">
              <AgentAvatar name={character.name} seed={character.characterId} size="lg" />
              <span
                className="live-pulse absolute -right-1 -top-1 size-2 rounded-full bg-live"
                style={{ animationDelay: `${index * 420}ms` }}
              />
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/70">{character.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function StatCard({ value, label, live }: { value: string; label: string; live?: boolean }): ReactNode {
  return (
    <div className="flex min-w-24 items-baseline gap-2 rounded-lg border border-border bg-card px-4 py-2.5 shadow-[inset_0_1px_0_0_oklch(1_0_0/0.05)] transition-colors hover:border-foreground/20">
      <span className="nums font-mono text-xl font-medium text-foreground">{value}</span>
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/90">
        {live ? <span className="live-pulse size-1.5 rounded-full bg-live" /> : null}
        {label}
      </span>
    </div>
  );
}

function ScenarioCard({ scenario, onStart, wide }: { scenario: ScenarioSummary; onStart: () => void; wide?: boolean }): ReactNode {
  const tone = CATEGORY[CATEGORY_OF[scenario.id] ?? "confrontation"];
  const players = scenario.playerRange ? `${scenario.playerRange.min}-${scenario.playerRange.max}P` : `${scenario.players}P`;
  const enter = (
    <span className="flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
      进入场景
      <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" />
    </span>
  );
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onStart}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onStart(); }}
      className={cn(
        "group relative flex cursor-pointer overflow-hidden rounded-lg border border-border bg-card p-6 transition-all hover:-translate-y-1 hover:border-foreground/25 hover:shadow-[0_20px_56px_-24px_color-mix(in_oklab,var(--tone)_30%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
        wide ? "flex-row items-center gap-6 sm:col-span-2 lg:col-span-3" : "min-h-48 flex-col justify-between"
      )}
      style={{ "--tone": tone.tone } as CSSProperties}
    >
      <span className={cn("absolute inset-y-0 left-0 w-0.5 opacity-70 transition-opacity group-hover:opacity-100", tone.bar)} aria-hidden />
      {wide ? (
        <>
          <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-lg border border-border bg-muted transition-colors group-hover:border-foreground/30", tone.accent)}>
            <ScenarioIcon id={scenario.id} className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold tracking-tight">{scenario.name}</h3>
              <span className="nums rounded-md border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">{players}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground sm:max-w-3xl">{scenario.description}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {scenario.capabilities.slice(0, 3).map((capability) => (
                <span key={capability} className={cn("rounded-full border px-2 py-0.5 text-[11px]", tone.tag)}>
                  {capability}
                </span>
              ))}
            </div>
          </div>
          {enter}
        </>
      ) : (
        <>
          <div className="flex items-start justify-between">
            <span className={cn("flex size-10 items-center justify-center rounded-lg border border-border bg-muted transition-colors group-hover:border-foreground/30 group-hover:bg-muted", tone.accent)}>
              <ScenarioIcon id={scenario.id} className="size-4.5" />
            </span>
            <span className="nums rounded-md border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
              {players}
            </span>
          </div>
          <div className="mt-4">
            <h3 className="text-lg font-semibold tracking-tight">{scenario.name}</h3>
            <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground">{scenario.description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {scenario.capabilities.slice(0, 3).map((capability) => (
                <span key={capability} className={cn("rounded-full border px-2 py-0.5 text-[11px]", tone.tag)}>
                  {capability}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-4">{enter}</div>
        </>
      )}
    </div>
  );
}
