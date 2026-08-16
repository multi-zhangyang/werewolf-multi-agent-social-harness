import type { ReactNode } from "react";
import { ArrowRight, Code2, Plus, Radio } from "lucide-react";
import type { ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { AgentAvatar, ScenarioIcon, StatusDot, StatusLabel } from "./shared";
import type { ModelOption } from "./types";

interface LandingProps {
  scenarios: ScenarioSummary[];
  models: ModelOption[];
  rooms: SocietyRoomSnapshot[];
  onStart: (scenarioId: string) => void;
  onOpenRoom: (roomId: string) => void;
}

export function Landing({ scenarios, models, rooms, onStart, onOpenRoom }: LandingProps): ReactNode {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-64 left-1/2 h-[560px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.16),transparent)] blur-2xl" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,rgba(10,10,10,0.9)_100%)]" />
      </div>

      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] font-mono text-xs text-zinc-200">◆</span>
          <span className="text-sm font-semibold tracking-tight text-zinc-100">Society</span>
        </div>
        <div className="flex items-center gap-3">
          {rooms.length ? (
            <Badge variant="outline" className="gap-1.5 rounded-full border-white/10 bg-white/[0.03] px-2.5 py-1 font-normal text-zinc-400">
              <StatusDot status="running" />
              {rooms.length} 个房间
            </Badge>
          ) : null}
          <a
            href="https://github.com/multi-zhangyang/werewolf-multi-agent-social-harness"
            target="_blank"
            rel="noreferrer"
            className="inline-flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-zinc-400 transition-colors hover:text-zinc-100"
          >
            <Code2 className="size-4" />
          </a>
          <Button size="sm" className="rounded-lg bg-zinc-50 text-zinc-950 hover:bg-white" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
            <Plus className="size-3.5" />
            创建房间
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-6 pb-24">
        <section className="mx-auto max-w-3xl pt-20 pb-16 text-center sm:pt-28">
          <Badge variant="outline" className="mb-6 rounded-full border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] font-medium tracking-wide text-zinc-400">
            <Radio className="mr-1.5 size-3 text-emerald-400" />
            Live multi-agent social worlds
          </Badge>
          <h1 className="bg-gradient-to-b from-white via-white to-zinc-500 bg-clip-text text-5xl font-semibold tracking-tighter text-transparent sm:text-7xl">
            Society
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-balance text-base leading-7 text-zinc-400 sm:text-lg">
            每个参与者都是一个由 OpenAI Agents SDK 驱动的真实智能体：
            有自己的记忆、情绪、信念与策略，在谈判、联盟、背叛与欺骗中实时交锋。
          </p>
          <div className="mt-9 flex items-center justify-center gap-3">
            <Button size="lg" className="rounded-lg bg-zinc-50 px-7 text-zinc-950 hover:bg-white" onClick={() => onStart(scenarios[0]?.id ?? "werewolf")}>
              开始一场博弈
              <ArrowRight className="size-4" />
            </Button>
            <a href="#scenarios">
              <Button size="lg" variant="outline" className="rounded-lg border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100">
                浏览场景
              </Button>
            </a>
          </div>
        </section>

        <section id="scenarios" className="scroll-mt-8">
          <div className="mb-6 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-zinc-100">场景</h2>
              <p className="mt-1 text-sm text-zinc-500">同一套智能体运行时，不同的规则与激励。</p>
            </div>
            <span className="font-mono text-[11px] text-zinc-600">{scenarios.length.toString().padStart(2, "0")} scenarios</span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {scenarios.map((scenario) => (
              <ScenarioCard key={scenario.id} scenario={scenario} onStart={() => onStart(scenario.id)} />
            ))}
            <div className="flex min-h-44 flex-col items-start justify-between rounded-2xl border border-dashed border-white/10 bg-white/[0.01] p-5 text-left">
              <span className="font-mono text-xs text-zinc-600">next</span>
              <p className="text-sm leading-6 text-zinc-500">密封拍卖、谣言与信息级联、联盟谈判……新的博弈场景持续加入。</p>
            </div>
          </div>
        </section>

        {rooms.length ? (
          <section className="mt-16">
            <div className="mb-4">
              <h2 className="text-lg font-semibold tracking-tight text-zinc-100">进行中的世界</h2>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rooms.slice(0, 6).map((room) => (
                <button
                  key={room.id}
                  onClick={() => onOpenRoom(room.id)}
                  className="group flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-left transition-colors hover:border-white/15 hover:bg-white/[0.04]"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-zinc-300">
                    <ScenarioIcon id={room.scenarioId} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-200">{room.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
                      <StatusDot status={room.status} />
                      <StatusLabel status={room.status} />
                      <span className="mx-1 text-zinc-700">·</span>
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

      <footer className="border-t border-white/[0.06] py-8">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 text-xs text-zinc-600">
          <span>Powered by the OpenAI Agents SDK</span>
          <span className="font-mono">{models.length} models · {scenarios.length} scenarios</span>
        </div>
      </footer>
    </div>
  );
}

function ScenarioCard({ scenario, onStart }: { scenario: ScenarioSummary; onStart: () => void }): ReactNode {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onStart}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onStart(); }}
      className="group relative flex min-h-44 cursor-pointer flex-col justify-between overflow-hidden rounded-2xl border-white/[0.07] bg-white/[0.02] p-5 transition-all hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
    >
      <div aria-hidden className="absolute -right-16 -top-16 size-40 rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,0.12),transparent)] opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="flex items-start justify-between">
        <span className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-200">
          <ScenarioIcon id={scenario.id} className="size-5" />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">{scenario.id}</span>
      </div>
      <div className="mt-4">
        <div className="flex items-center gap-2.5">
          <h3 className="text-base font-semibold tracking-tight text-zinc-100">{scenario.name}</h3>
          <span className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
            {scenario.players}P
          </span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-zinc-500">{scenario.description}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {scenario.capabilities.map((capability) => (
            <span key={capability} className="rounded-full border border-white/[0.07] bg-white/[0.02] px-2 py-0.5 text-[10px] text-zinc-500">
              {capability}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 text-[13px] font-medium text-zinc-300 transition-colors group-hover:text-zinc-100">
        进入场景
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Card>
  );
}
