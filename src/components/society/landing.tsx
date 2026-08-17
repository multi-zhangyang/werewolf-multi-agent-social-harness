import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, BrainCircuit, MessagesSquare, Play, Radio, RotateCcw, Settings2, Sparkles, Trash2, Users, Waypoints } from "lucide-react";
import type { ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import type { ArchivedRoomSummary } from "@/society/persistence";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentAvatar, ScenarioIcon, StatusDot, StatusLabel } from "./shared";
import type { ModelOption } from "./types";
import { cn } from "@/lib/utils";

interface SeasonSummary {
  characterKey: string;
  games: Array<{ scenarioId: string; role?: string; outcome: "win" | "lose" }>;
  memoryCount: number;
  updatedAt: string;
}

interface LandingProps {
  scenarios: ScenarioSummary[];
  models: ModelOption[];
  rooms: SocietyRoomSnapshot[];
  archived: ArchivedRoomSummary[];
  season: SeasonSummary[];
  onStart: (scenarioId: string) => void;
  onOpenRoom: (roomId: string) => void;
  onOpenSettings: () => void;
  onOpenCharacters: () => void;
  onOpenAbout: () => void;
  onResetSeason: () => void;
  /** Stop and release a room; its history stays in the archive. */
  onRemoveRoom: (roomId: string) => void;
}

const FEATURES = [
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
    title: "对话自然展开",
    body: "讨论不是轮流念稿：被点名的人要回应，质疑会被追问，谎言会被拆穿，无话可说的人可以选择沉默。讨论在没人再有话说时自然结束。"
  },
  {
    icon: Radio,
    title: "一切实时可见",
    body: "内心的推理、Agent 自己的结构化思考节拍、每一次工具调用、每一条公聊与密谋，都像直播一样流向观察席。身份揭晓与淘汰，是戏剧性时刻而不是日志。"
  }
];

/** Category color coding: cooperation / confrontation / deception. */
const CATEGORY: Record<string, { accent: string; bar: string; tag: string }> = {
  cooperation: { accent: "text-emerald-400", bar: "bg-emerald-400", tag: "border-emerald-400/40 bg-emerald-400/15 text-emerald-200" },
  confrontation: { accent: "text-orange-400", bar: "bg-orange-400", tag: "border-orange-400/40 bg-orange-400/15 text-orange-200" },
  deception: { accent: "text-violet-400", bar: "bg-violet-400", tag: "border-violet-400/40 bg-violet-400/15 text-violet-200" }
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

export function Landing({ scenarios, models, rooms, archived, season, onStart, onOpenRoom, onOpenSettings, onOpenCharacters, onOpenAbout, onResetSeason, onRemoveRoom }: LandingProps): ReactNode {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border/80 bg-background/70 backdrop-blur-xl">
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
                <span className="live-pulse size-1.5 rounded-full bg-emerald-400" />
                {rooms.length} 个活跃世界
              </Badge>
            ) : null}
            <Button variant="outline" size="icon-sm" aria-label="模型提供商设置" className="rounded-lg border-border text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onOpenSettings}>
              <Settings2 className="size-3.5" />
            </Button>
            <Button size="sm" className="rounded-lg bg-foreground px-4 text-background hover:bg-foreground/85" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
              <Play className="size-3.5" />
              创建世界
            </Button>
          </div>
        </div>
      </header>

      {scenarios.length ? (
        <div className="scroll-fade-x overflow-x-auto border-b border-border/80 bg-muted/40">
          <div className="mx-auto flex w-full max-w-6xl gap-1.5 px-6 py-2.5">
            {scenarios.map((scenario) => {
              const tone = CATEGORY[CATEGORY_OF[scenario.id] ?? "confrontation"];
              return (
                <button
                  key={scenario.id}
                  onClick={() => onStart(scenario.id)}
                  className={cn(
                    "shrink-0 rounded-full border border-border px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted",
                    CATEGORY_OF[scenario.id] === "deception" && "hover:border-violet-400/40 hover:text-violet-300",
                    CATEGORY_OF[scenario.id] === "confrontation" && "hover:border-orange-400/40 hover:text-orange-300",
                    CATEGORY_OF[scenario.id] === "cooperation" && "hover:border-emerald-400/40 hover:text-emerald-300"
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
        <section className="mx-auto max-w-3xl pt-24 pb-16 text-center sm:pt-28">
          <Badge variant="outline" className="mb-8 rounded-full border-border bg-card px-3.5 py-1.5 text-xs font-medium tracking-wide text-foreground/70">
            Powered by OpenAI Agents SDK
          </Badge>
          <h1 className="hero-ink text-5xl font-semibold tracking-tighter sm:text-7xl">
            多智能体社会博弈竞技场
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg leading-8 text-muted-foreground sm:text-xl">
            狼人杀、阿瓦隆、囚徒困境——真实的模型 Agent 在 {scenarios.length} 个世界里谈判、结盟、欺骗与背叛。每个参与者都带着记忆、情绪与人格，过去真的会改变未来。
          </p>
          <div className="mt-10 flex items-center justify-center gap-3">
            <Button size="lg" className="h-11 rounded-lg bg-foreground px-8 text-background shadow-sm hover:bg-foreground/85" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
              开始一场博弈
              <ArrowRight className="size-4" />
            </Button>
            <a href="#scenarios">
              <Button size="lg" variant="ghost" className="h-11 rounded-lg border border-transparent px-7 text-foreground/80 hover:bg-muted/60 hover:text-foreground">
                浏览全部世界
                <ArrowDown className="size-4" />
              </Button>
            </a>
          </div>

          <HeroStage />

          <div className="mt-12 flex flex-wrap items-center justify-center gap-3">
            <StatCard value={String(scenarios.length).padStart(2, "0")} label="博弈世界" />
            {rooms.length > 0 ? <StatCard value={String(rooms.length).padStart(2, "0")} label="进行中" live /> : null}
            {models.length > 0 ? <StatCard value={String(models.length).padStart(2, "0")} label="可用模型" /> : null}
          </div>
        </section>

        {season.length ? (
          <section className="mb-20">
            <div className="mb-4 flex items-end justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/80">Season</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">延续的社群</h2>
              </div>
              <SeasonResetButton onReset={onResetSeason} />
            </div>
            <p className="mb-4 max-w-3xl text-[13px] leading-6 text-muted-foreground">
              社会季：同一批角色会跨局延续——上一局的背叛、恩怨与信任会进入下一局，像一群真正熟悉的旧友。每局的身份与阵营重新分配，过去的角色不决定今天的忠诚，但过去的经历会改变今天的判断。随时可以清空，开启一个所有人都互不相识的全新社会季。
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              {season.slice(0, 8).map((entry) => {
                const wins = entry.games.filter((game) => game.outcome === "win").length;
                return (
                  <div key={entry.characterKey} className="w-[calc(50%-6px)] rounded-lg border border-border bg-card p-4 transition-colors hover:border-border sm:w-[calc(33.33%-8px)] lg:w-[calc(25%-9px)]">
                    <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                      <AgentAvatar name={entry.characterKey} index={hashIndex(entry.characterKey)} size="sm" />
                      {entry.characterKey}
                    </p>
                    <p className="nums mt-2 font-mono text-[11px] text-muted-foreground/80">
                      {entry.games.length} 局 · 胜 {wins} · 记忆 {entry.memoryCount}
                    </p>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      最近：{entry.games.at(-1)?.scenarioId ?? "—"}
                      {entry.games.at(-1)?.role ? ` · ${entry.games.at(-1)?.role}` : ""}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

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

        <section className="mb-20 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-emerald-400/30 bg-gradient-to-b from-emerald-400/10 to-card p-7">
            <div className="flex items-center gap-2">
              <span className="live-pulse size-1.5 rounded-full bg-emerald-400" />
              <h3 className="text-lg font-semibold tracking-tight">社会季模式</h3>
            </div>
            <p className="mt-2.5 text-sm leading-6 text-muted-foreground">
              同一批角色跨局延续：上一局的背叛、恩怨与信任进入下一局，像一群越玩越熟的老友。每局身份重新分配，过去的角色不决定今天的忠诚，但过去的经历会改变今天的判断。可以在首页一键「重置社会季」，让所有人重新互不相识。
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-7">
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-amber-400" />
              <h3 className="text-lg font-semibold tracking-tight">单局模式</h3>
            </div>
            <p className="mt-2.5 text-sm leading-6 text-muted-foreground">
              一局定胜负、零历史干扰：角色互不相识，不读取任何过往记忆，结束后也不留下任何记忆。适合想观察纯粹博弈、或者不被上一局恩怨影响的公平对决——创建房间时选择「单局模式」即可。
            </p>
          </div>
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
                <span className="live-pulse size-1.5 rounded-full bg-emerald-400" />
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
                      title="停止并移除：对局历史会保留在归档中"
                      onClick={() => onRemoveRoom(room.id)}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-border hover:text-red-400"
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

        {archived.length ? (
          <section className="mt-12">
            <div className="mb-6 flex items-end justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/80">Archive</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-muted-foreground">已归档的对局</h2>
              </div>
              <span className="nums font-mono text-xs text-muted-foreground/80">{archived.length} archives</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {archived.slice(0, 6).map((room) => (
                <div
                  key={room.roomId}
                  className="flex items-center gap-4 rounded-lg border border-border/60 bg-card/50 p-4 text-left opacity-80"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50 text-muted-foreground/70">
                    <ScenarioIcon id={room.scenarioId} className="size-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold tracking-tight text-foreground/70">{room.title}</span>
                    <span className="nums mt-0.5 flex items-center gap-2 text-xs text-muted-foreground/70">
                      <span>已归档</span>
                      <span className="text-muted-foreground/40">·</span>
                      <span>{room.messages} 条消息 · {room.participants.length} 名参与者</span>
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground/60">
              归档是服务器在运行中持续写入的滚动检查点（data/rooms/）；重启后房间历史与每个 Agent 的会话文件仍然保留，可从检查点恢复查看。
            </p>
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
  const cast = ["林默", "苏遥", "陈策", "唐妍"];
  return (
    <div className="relative mx-auto mt-12 flex h-28 w-fit items-start justify-center px-10 pt-2" aria-hidden>
      <svg className="absolute inset-x-0 top-2 h-full w-full" viewBox="0 0 300 96" preserveAspectRatio="none">
        <path className="dash-flow" d="M74 34 C 100 12, 200 12, 226 34" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.1" strokeDasharray="3 5" />
        <path className="dash-flow" style={{ animationDelay: "0.6s" }} d="M74 34 C 100 56, 200 56, 226 34" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.1" strokeDasharray="3 5" />
        <path d="M36 34 C 80 2, 220 2, 264 34" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
      </svg>
      <div className="relative flex items-start gap-9">
        {cast.map((name, index) => (
          <span key={name} className={cn("relative flex flex-col items-center gap-2 rounded-lg", index % 2 === 1 && "translate-y-3")}>
            <span className="relative">
              <AgentAvatar name={name} index={index} size="lg" />
              <span
                className="live-pulse absolute -right-1 -top-1 size-2 rounded-full bg-emerald-400"
                style={{ animationDelay: `${index * 420}ms` }}
              />
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/70">{name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Two-step season reset: forget every cross-game memory and start fresh. */
function SeasonResetButton({ onReset }: { onReset: () => void }): ReactNode {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <span className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">清空全部角色记忆,开启全新社会季?</span>
      <Button
        size="sm"
        className="rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 text-rose-300 hover:bg-rose-400/20"
        onClick={() => { onReset(); setArmed(false); }}
      >
        确认清空
      </Button>
      <Button size="sm" variant="ghost" className="px-3 text-muted-foreground" onClick={() => setArmed(false)}>
        取消
      </Button>
    </span>
  ) : (
    <Button size="sm" variant="outline" className="gap-1.5 rounded-lg border-border bg-card px-3 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setArmed(true)}>
      <RotateCcw className="size-3.5" />
      重置社会季
    </Button>
  );
}

function StatCard({ value, label, live }: { value: string; label: string; live?: boolean }): ReactNode {
  return (
    <div className="flex min-w-24 items-baseline gap-2 rounded-lg border border-border bg-card px-4 py-2.5">
      <span className="nums font-mono text-lg font-medium text-foreground">{value}</span>
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {live ? <span className="live-pulse size-1.5 rounded-full bg-emerald-400" /> : null}
        {label}
      </span>
    </div>
  );
}

function hashIndex(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

function ScenarioCard({ scenario, onStart, wide }: { scenario: ScenarioSummary; onStart: () => void; wide?: boolean }): ReactNode {
  const tone = CATEGORY[CATEGORY_OF[scenario.id] ?? "confrontation"];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onStart}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onStart(); }}
      className={cn(
        "group relative flex cursor-pointer flex-col justify-between overflow-hidden rounded-lg border border-border bg-card p-6 transition-all hover:-translate-y-1 hover:border-foreground/25 hover:shadow-[0_12px_40px_-16px_rgba(0,0,0,0.8)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
        wide ? "min-h-48 sm:col-span-2 lg:col-span-3 sm:min-h-44" : "min-h-48"
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-0.5 opacity-70 transition-opacity group-hover:opacity-100", tone.bar)} aria-hidden />
      <div className="flex items-start justify-between">
        <span className={cn("flex size-10 items-center justify-center rounded-lg border border-border bg-muted transition-colors group-hover:border-foreground/30 group-hover:bg-muted", tone.accent)}>
          <ScenarioIcon id={scenario.id} className="size-4.5" />
        </span>
        <span className="nums rounded-md border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
          {scenario.playerRange ? `${scenario.playerRange.min}-${scenario.playerRange.max}P` : `${scenario.players}P`}
        </span>
      </div>
      <div className="mt-4">
        <h3 className="text-lg font-semibold tracking-tight">{scenario.name}</h3>
        <p className={cn("mt-1 text-[13px] leading-5 text-muted-foreground", wide ? "line-clamp-1 sm:max-w-xl" : "line-clamp-2")}>{scenario.description}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {scenario.capabilities.slice(0, 3).map((capability) => (
            <span key={capability} className={cn("rounded-full border px-2 py-0.5 text-[11px]", tone.tag)}>
              {capability}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        进入场景
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" />
      </div>
    </div>
  );
}