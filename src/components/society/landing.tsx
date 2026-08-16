import type { ReactNode } from "react";
import { ArrowRight, Play, Sparkles } from "lucide-react";
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
}

export function Landing({ scenarios, models, rooms, onStart, onOpenRoom }: LandingProps): ReactNode {
  const ticker = scenarios.map((scenario) => scenario.name).join(" · ");
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#050505]">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-56 left-1/2 h-[620px] w-[1100px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.13),transparent)] blur-2xl" />
        <div className="absolute -left-40 top-1/3 size-[460px] rounded-full bg-[radial-gradient(closest-side,rgba(56,189,248,0.07),transparent)] blur-2xl" />
        <div className="absolute -right-40 top-1/2 size-[460px] rounded-full bg-[radial-gradient(closest-side,rgba(52,211,153,0.06),transparent)] blur-2xl" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,rgba(5,5,5,0.92)_100%)]" />
      </div>

      <header className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] font-mono text-sm text-zinc-100">◆</span>
          <span className="text-sm font-semibold tracking-tight text-zinc-100">Society</span>
        </div>
        <div className="flex items-center gap-3">
          {rooms.length ? (
            <Badge variant="outline" className="gap-1.5 rounded-full border-white/10 bg-white/[0.03] px-3 py-1 font-normal text-zinc-400">
              <span className="live-pulse size-1.5 rounded-full bg-emerald-400" />
              {rooms.length} 个活跃世界
            </Badge>
          ) : null}
          <Button size="sm" className="rounded-full bg-zinc-50 text-zinc-950 transition-transform hover:bg-white active:scale-[0.98]" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
            <Play className="size-3.5" />
            创建世界
          </Button>
        </div>
      </header>

      {ticker ? (
        <div className="marquee overflow-hidden border-y border-white/[0.05] bg-white/[0.015]">
          <div className="marquee-track gap-8 py-2 font-mono text-xs text-zinc-500">
            {[0, 1].map((key) => (
              <span key={key} className="flex gap-8">
                {scenarios.map((scenario) => (
                  <span key={`${key}-${scenario.id}`} className="flex items-center gap-2">
                    <Sparkles className="size-3 text-zinc-700" />
                    {scenario.name}
                    <span className="text-zinc-700">·</span>
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <main className="mx-auto w-full max-w-7xl px-6 pb-24">
        <section className="mx-auto max-w-4xl pt-20 pb-20 text-center sm:pt-28">
          <Badge variant="outline" className="mb-7 rounded-full border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-medium tracking-wide text-zinc-300">
            <Sparkles className="mr-2 size-3.5 text-emerald-400" />
            Powered by OpenAI Agents SDK
          </Badge>
          <h1 className="bg-gradient-to-b from-white via-white to-zinc-500 bg-clip-text text-6xl font-semibold tracking-tighter text-transparent sm:text-8xl">
            Society
          </h1>
          <p className="mx-auto mt-7 max-w-2xl text-balance text-lg leading-8 text-zinc-400 sm:text-xl">
            真正的多智能体同台交锋 —— 谈判、结盟、欺骗与背叛。
            <br className="hidden sm:block" />
            每个参与者都是带着记忆、情绪与信念的真实模型。
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Button size="lg" className="h-11 rounded-full bg-zinc-50 px-8 text-zinc-950 transition-transform hover:bg-white active:scale-[0.98]" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
              开始一场博弈
              <ArrowRight className="size-4" />
            </Button>
            <a href="#scenarios">
              <Button size="lg" variant="outline" className="h-11 rounded-full border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100">
                浏览场景
              </Button>
            </a>
          </div>
        </section>

        <section id="scenarios" className="scroll-mt-8">
          <div className="mb-8 flex items-end justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">Scenarios</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">博弈与欺骗的竞技场</h2>
            </div>
            <span className="nums font-mono text-xs text-zinc-600">{String(scenarios.length).padStart(2, "0")} scenarios</span>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {scenarios.map((scenario, index) => (
              <ScenarioCard key={scenario.id} scenario={scenario} index={index} onStart={() => onStart(scenario.id)} />
            ))}
          </div>
        </section>

        {rooms.length ? (
          <section className="mt-20">
            <div className="mb-6 flex items-end justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">Live</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">正在发生的世界</h2>
              </div>
              <span className="nums font-mono text-xs text-zinc-600">{rooms.length} rooms</span>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rooms.slice(0, 6).map((room) => (
                <button
                  key={room.id}
                  onClick={() => onOpenRoom(room.id)}
                  className="group flex items-center gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 text-left transition-all hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.04]"
                >
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-200">
                    <ScenarioIcon id={room.scenarioId} className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold tracking-tight text-zinc-100">{room.title}</span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                      <StatusDot status={room.status} />
                      <StatusLabel status={room.status} />
                      <span className="text-zinc-700">·</span>
                      {room.participants.length} 名参与者
                    </span>
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-300" />
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </main>

      <footer className="border-t border-white/[0.06] py-10">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-3 px-6 text-xs text-zinc-600 sm:flex-row">
          <span>Society · Live Multi-Agent Social Worlds</span>
          <span className="nums font-mono">{models.length} models · {scenarios.length} scenarios · OpenAI Agents SDK</span>
        </div>
      </footer>
    </div>
  );
}

function ScenarioCard({ scenario, index, onStart }: { scenario: ScenarioSummary; index: number; onStart: () => void }): ReactNode {
  const gradients = [
    "from-zinc-200/10 via-transparent",
    "from-blue-400/10 via-transparent",
    "from-emerald-400/10 via-transparent",
    "from-amber-400/10 via-transparent",
    "from-violet-400/10 via-transparent",
    "from-rose-400/10 via-transparent",
    "from-cyan-400/10 via-transparent"
  ];
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onStart}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onStart(); }}
      className={cn(
        "group relative flex min-h-56 cursor-pointer flex-col justify-between overflow-hidden rounded-2xl border-white/[0.07] bg-white/[0.02] p-6 transition-all hover:-translate-y-1 hover:border-white/15 hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500",
        "bg-[linear-gradient(135deg,var(--tw-gradient-stops))]"
      )}
      style={{ backgroundImage: `radial-gradient(420px circle at 100% 0%, rgba(255,255,255,0.05), transparent), linear-gradient(135deg, rgba(255,255,255,0.03), transparent)` }}
    >
      <div aria-hidden className={cn("absolute -right-20 -top-20 size-56 rounded-full bg-[radial-gradient(closest-side,currentColor,transparent)] opacity-10 transition-opacity group-hover:opacity-20", gradients[index % gradients.length])} />
      <div className="flex items-start justify-between">
        <span className="flex size-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-100">
          <ScenarioIcon id={scenario.id} className="size-5" />
        </span>
        <span className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          {scenario.id}
        </span>
      </div>
      <div className="mt-6">
        <div className="flex items-center gap-3">
          <h3 className="text-xl font-semibold tracking-tight text-zinc-50">{scenario.name}</h3>
          <span className="nums rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[11px] text-zinc-500">
            {scenario.players}P
          </span>
        </div>
        <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-400">{scenario.description}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {scenario.capabilities.slice(0, 3).map((capability) => (
            <span key={capability} className="rounded-full border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[11px] text-zinc-500">
              {capability}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-6 flex items-center gap-2 text-sm font-medium text-zinc-300 transition-colors group-hover:text-zinc-50">
        进入场景
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
      </div>
    </Card>
  );
}