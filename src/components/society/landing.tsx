import type { ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Play, Settings2, Sparkles } from "lucide-react";
import type { ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  onOpenAbout: () => void;
}

const FEATURES = [
  {
    title: "真实 Agent 同台交锋",
    body: "每个参与者都是 OpenAI Agents SDK 的 Agent：独立会话、私有记忆、函数工具与专属认知专家。模型文本永远不是命令——只有成功的工具调用才能改变世界。"
  },
  {
    title: "有记忆、有情绪、有人格",
    body: "记忆流、PAD 情绪、社会情绪、需求与关系账本持续演化。被当众指控会愤怒，被盟友背叛会记仇，兑现承诺会赢得信任——过去真的会改变未来。"
  },
  {
    title: "对话自然展开",
    body: "讨论不是轮流念稿：被点名的人要回应，质疑会被追问，谎言会被拆穿，无话可说的人可以选择沉默。讨论在没有人再有话要说时自然结束。"
  },
  {
    title: "一切实时可见",
    body: "内心的推理、专家的盘算、每一次工具调用、每一条公聊与密谋，都像直播一样流向观察席。身份揭晓与淘汰，是戏剧性时刻而不是日志。"
  }
];

export function Landing({ scenarios, models, rooms, onStart, onOpenRoom, onOpenSettings, onOpenAbout }: LandingProps): ReactNode {
  const ticker = scenarios.map((scenario) => scenario.name).join(" · ");
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-zinc-200/80 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <button className="flex items-center gap-2.5" onClick={() => { location.hash = "#/"; }}>
            <span className="flex size-7 items-center justify-center rounded-md bg-foreground font-mono text-xs text-background">◆</span>
            <span className="text-[15px] font-semibold tracking-tight">Society</span>
          </button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="hidden rounded-lg px-3 text-[13px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 sm:inline-flex" onClick={onOpenAbout}>
              关于
            </Button>
            {rooms.length ? (
              <Badge variant="outline" className="hidden gap-1.5 rounded-full border-zinc-200 px-3 py-1 font-normal text-zinc-500 sm:inline-flex">
                <span className="live-pulse size-1.5 rounded-full bg-emerald-500" />
                {rooms.length} 个活跃世界
              </Badge>
            ) : null}
            <Button variant="outline" size="icon-sm" aria-label="模型提供商设置" className="rounded-lg border-zinc-200 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900" onClick={onOpenSettings}>
              <Settings2 className="size-3.5" />
            </Button>
            <Button size="sm" className="rounded-lg bg-foreground px-4 text-background hover:bg-zinc-800" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
              <Play className="size-3.5" />
              创建世界
            </Button>
          </div>
        </div>
      </header>

      {ticker ? (
        <div className="marquee overflow-hidden border-b border-zinc-200/80 bg-zinc-50/60">
          <div className="marquee-track gap-8 py-2 font-mono text-xs text-zinc-400">
            {[0, 1].map((key) => (
              <span key={key} className="flex gap-8">
                {scenarios.map((scenario) => (
                  <span key={`${key}-${scenario.id}`} className="flex items-center gap-2">
                    <Sparkles className="size-3 text-zinc-300" />
                    {scenario.name}
                    <span className="text-zinc-300">·</span>
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <main className="mx-auto w-full max-w-6xl px-6 pb-28">
        <section className="mx-auto max-w-3xl pt-24 pb-20 text-center sm:pt-32">
          <Badge variant="outline" className="mb-8 rounded-full border-zinc-200 bg-white px-3.5 py-1.5 text-xs font-medium tracking-wide text-zinc-500">
            Powered by OpenAI Agents SDK
          </Badge>
          <h1 className="text-5xl font-semibold tracking-tighter text-foreground sm:text-7xl">
            多智能体社会博弈竞技场
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg leading-8 text-zinc-500 sm:text-xl">
            狼人杀、阿瓦隆、囚徒困境——真实的模型 Agent 在十一个世界里谈判、结盟、欺骗与背叛。
            每个参与者都带着记忆、情绪与人格，过去真的会改变未来。
          </p>
          <div className="mt-10 flex items-center justify-center gap-3">
            <Button size="lg" className="h-11 rounded-lg bg-foreground px-8 text-background shadow-sm hover:bg-zinc-800" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
              开始一场博弈
              <ArrowRight className="size-4" />
            </Button>
            <a href="#scenarios">
              <Button size="lg" variant="outline" className="h-11 rounded-lg border-zinc-200 bg-white px-7 text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900">
                浏览全部世界
              </Button>
            </a>
          </div>
          <div className="nums mt-12 flex items-center justify-center gap-8 font-mono text-xs text-zinc-400">
            <span>{String(scenarios.length).padStart(2, "0")} 个世界</span>
            <span className="size-1 rounded-full bg-zinc-300" />
            <span>{String(rooms.length).padStart(2, "0")} 场进行中</span>
            <span className="size-1 rounded-full bg-zinc-300" />
            <span>{models.length} 个可用模型</span>
          </div>
        </section>

        <section className="mb-20 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="bg-white p-8">
              <h3 className="text-[15px] font-semibold tracking-tight">{feature.title}</h3>
              <p className="mt-2.5 text-sm leading-6 text-zinc-500">{feature.body}</p>
            </div>
          ))}
        </section>

        <section id="scenarios" className="scroll-mt-20">
          <div className="mb-8 flex items-end justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">Worlds</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">博弈与欺骗的竞技场</h2>
            </div>
            <span className="nums font-mono text-xs text-zinc-400">{String(scenarios.length).padStart(2, "0")} worlds</span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {scenarios.map((scenario, index) => (
              <ScenarioCard key={scenario.id} scenario={scenario} index={index} onStart={() => onStart(scenario.id)} />
            ))}
          </div>
        </section>

        {rooms.length ? (
          <section className="mt-24">
            <div className="mb-6 flex items-end justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">Live</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">正在发生的世界</h2>
              </div>
              <span className="nums font-mono text-xs text-zinc-400">{rooms.length} rooms</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rooms.slice(0, 6).map((room) => (
                <button
                  key={room.id}
                  onClick={() => onOpenRoom(room.id)}
                  className="group flex items-center gap-4 rounded-lg border border-zinc-200 bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-sm"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-600">
                    <ScenarioIcon id={room.scenarioId} className="size-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold tracking-tight">{room.title}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-xs text-zinc-400">
                      <StatusDot status={room.status} />
                      <StatusLabel status={room.status} />
                      <span className="text-zinc-300">·</span>
                      <span className="nums">{room.participants.length} 名参与者</span>
                    </span>
                  </span>
                  <ArrowUpRight className="size-4 shrink-0 text-zinc-300 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-zinc-600" />
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </main>

      <footer className="border-t border-zinc-200 py-10">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-6 text-xs text-zinc-400 sm:flex-row">
          <span className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded bg-foreground font-mono text-[9px] text-background">◆</span>
            Society · Live Multi-Agent Social Worlds
          </span>
          <span className="flex items-center gap-4">
            <button onClick={onOpenAbout} className="transition-colors hover:text-zinc-700">关于</button>
            <span className="text-zinc-300">·</span>
            <span className="nums font-mono">{scenarios.length} worlds · OpenAI Agents SDK</span>
          </span>
        </div>
      </footer>
    </div>
  );
}

function ScenarioCard({ scenario, index, onStart }: { scenario: ScenarioSummary; index: number; onStart: () => void }): ReactNode {
  const tints = [
    "text-zinc-700",
    "text-sky-600",
    "text-emerald-600",
    "text-amber-600",
    "text-violet-600",
    "text-rose-600",
    "text-cyan-600"
  ];
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onStart}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onStart(); }}
      className={cn(
        "group relative flex min-h-52 cursor-pointer flex-col justify-between overflow-hidden rounded-lg border-zinc-200 bg-white p-6 transition-all hover:-translate-y-1 hover:border-zinc-300 hover:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.12)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
      )}
    >
      <div className="flex items-start justify-between">
        <span className="flex size-10 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-700 transition-colors group-hover:bg-zinc-100">
          <ScenarioIcon id={scenario.id} className="size-4.5" />
        </span>
        <span className="nums rounded-md border border-zinc-200 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
          {scenario.players}P
        </span>
      </div>
      <div className="mt-5">
        <h3 className="text-lg font-semibold tracking-tight">{scenario.name}</h3>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-6 text-zinc-500">{scenario.description}</p>
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {scenario.capabilities.slice(0, 3).map((capability) => (
            <span key={capability} className={cn("rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-500", index < 7 && tints[index])}>
              {capability}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-5 flex items-center gap-1.5 text-[13px] font-medium text-zinc-600 transition-colors group-hover:text-zinc-900">
        进入场景
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" />
      </div>
    </Card>
  );
}
