import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { ArrowDown, ArrowRight, BrainCircuit, MessagesSquare, Play, Radio, Settings2, Trash2, Users, Waypoints } from "lucide-react";
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

export function Landing({ scenarios, models, rooms, onStart, onOpenRoom, onOpenSettings, onOpenCharacters, onOpenAbout, onRemoveRoom }: LandingProps): ReactNode {
  return (
    <div className="min-h-screen bg-background">
      <header className="rule-b sticky top-0 z-20 bg-background/65 backdrop-blur-2xl backdrop-saturate-150">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <button className="flex items-center gap-2.5" onClick={() => { location.hash = "#/"; }}>
            <span className="flex size-7 items-center justify-center rounded-md bg-foreground font-mono text-xs text-background shadow-[inset_0_1px_0_oklch(1_0_0/0.5),0_0_16px_oklch(1_0_0/0.22)]">◆</span>
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

      {scenarios.length ? (
        <div className="rule-b sticky top-16 z-10 overflow-x-auto bg-background/70 backdrop-blur-xl sm:overflow-x-visible">
          <div className="mx-auto flex w-full max-w-6xl flex-nowrap gap-1.5 px-6 py-2.5 sm:flex-wrap sm:justify-center">
            {scenarios.map((scenario) => (
              <button
                key={scenario.id}
                onClick={() => onStart(scenario.id)}
                className="shrink-0 rounded-full px-3.5 py-1.5 text-xs text-foreground/70 transition-all hover:-translate-y-px hover:bg-muted/60 hover:text-foreground"
              >
                {scenario.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <main className="relative">
        {/* Hero: a quiet, centered statement — the console below does the talking. */}
        <section className="relative overflow-hidden">
          <DotField className="pointer-events-none absolute inset-0 opacity-70" />
          <div className="relative mx-auto w-full max-w-3xl px-6 pb-10 pt-20 text-center sm:pt-24">
            <p className="reveal-up nums font-mono text-[11px] uppercase tracking-[0.32em] text-muted-foreground/60">
              Live multi-agent social worlds
            </p>
            <h1 className="reveal-up hero-ink mt-5 text-balance text-3xl font-semibold leading-[1.18] tracking-tight sm:text-[2.5rem]" style={{ animationDelay: "80ms" }}>
              多智能体社会博弈竞技场
            </h1>
            <p className="reveal-up mx-auto mt-5 max-w-xl text-balance text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8" style={{ animationDelay: "150ms" }}>
              真实的模型 Agent 在 {scenarios.length} 个社会压力场景里谈判、结盟、欺骗与背叛。每个参与者都有独立的会话、情绪与立场——过去发生的事，真的会改变接下来的行为。
            </p>
            <div className="reveal-up mt-8 flex flex-wrap items-center justify-center gap-3" style={{ animationDelay: "220ms" }}>
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
            <div className="reveal-up mt-10 flex items-stretch justify-center gap-6" style={{ animationDelay: "280ms" }}>
              <Stat value={String(scenarios.length).padStart(2, "0")} label="博弈世界" />
              <span className="w-px bg-border" aria-hidden />
              {rooms.length > 0 ? <Stat value={String(rooms.length).padStart(2, "0")} label="进行中" live /> : null}
              {rooms.length > 0 ? <span className="w-px bg-border" aria-hidden /> : null}
              {models.length > 0 ? <Stat value={String(models.length).padStart(2, "0")} label="可用模型" /> : null}
            </div>
          </div>

          {/* The showpiece: the social graph itself, alive — vector, crisp. */}
          <div className="relative mx-auto w-full max-w-5xl px-6 pb-28">
            <div className="flex items-center justify-between px-1 pb-3">
              <span className="nums font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground/45">社会关系 · 实时</span>
              <span className="nums font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground/45">视角 · 全知</span>
            </div>
            <SocialGraphStage />
            <span aria-hidden className="pointer-events-none absolute inset-x-16 bottom-14 h-px bg-gradient-to-r from-transparent via-foreground/12 to-transparent" />
            <span aria-hidden className="pointer-events-none absolute inset-x-24 bottom-8 h-10 bg-[radial-gradient(50%_100%_at_50%_0%,oklch(1_0_0/0.05),transparent_75%)]" />
          </div>
        </section>

        {/* Features: a quiet monochrome bento grid. */}
        <section className="mb-28">
          <SectionHeading index="01" label="Why Society" title="不是聊天记录，是一场可审计的社会实验" />
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border shadow-[0_1px_2px_oklch(0_0_0/0.25)] sm:grid-cols-2 lg:grid-cols-6">
            <FeatureCell className="lg:col-span-3" icon={Radio} title="全程直播，逐字可见">
              每个 agent 的思考、推理、工具调用与发言逐字流出——像看比赛直播一样看它们决策。你看到的每一次转折，背后都是一次真实的工具调用。
              <div className="mt-4 rounded-lg border border-border/70 bg-muted/30 p-3" aria-hidden>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="eq text-foreground" ><span /><span /><span /></span>
                  <span className="font-mono text-[10px] tracking-wider">陈策 · 正在发言</span>
                  <span className="ml-auto stream-caret text-[10px] text-muted-foreground/60">“我怀疑场上有狼……”</span>
                </div>
              </div>
            </FeatureCell>
            <FeatureCell className="lg:col-span-3" icon={Waypoints} title="说出口的承诺，都会被对账">
              承诺、指控、怀疑与欺骗都进了因果账本：承诺有履约与违约的结算，信念有时间线与置信度，欺骗有从计划到识破的生命周期——「为什么」按来源分层摊开。
              <div className="mt-4 flex flex-wrap items-center gap-1.5" aria-hidden>
                <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-foreground/85">承诺</span>
                <span className="self-center text-[10px] text-muted-foreground/50">→</span>
                <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-foreground/85">世界对账</span>
                <span className="self-center text-[10px] text-muted-foreground/50">→</span>
                <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-foreground/85">已履约 / 已违约</span>
              </div>
            </FeatureCell>
            <FeatureCell className="lg:col-span-3" icon={BrainCircuit} title="情绪与立场，评估驱动">
              情绪不是模型自己说的：世界事件经评估引擎转成情绪、需求与关系的变化，写进各自的内心状态；信念与角色判断是带证据的概率账本——只有全知视角看得见。
              <div className="mt-4 flex flex-wrap items-center gap-1.5" aria-hidden>
                <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-foreground/85">被当众指控</span>
                <span className="self-center text-[10px] text-muted-foreground/50">→</span>
                <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-foreground/85">愤怒 ↑</span>
                <span className="self-center text-[10px] text-muted-foreground/50">→</span>
                <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-foreground/85">信任 ↓</span>
              </div>
            </FeatureCell>
            <FeatureCell className="lg:col-span-3" icon={MessagesSquare} title="多模型混编，权限化观战">
              每个席位可以运行不同的模型同台竞技。public / agent-pov / omniscient 三档观战是服务端硬边界：夜间行动与同时投票在结算前，不会进入公开画面。
              <div className="mt-4 flex flex-wrap items-center gap-1.5" aria-hidden>
                <span className="rounded-full border border-dashed border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">公开视角</span>
                <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-foreground/85">Agent 视角</span>
                <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-foreground/85">全知视角</span>
              </div>
            </FeatureCell>
          </div>
        </section>

        <section id="scenarios" className="scroll-mt-20">
          <SectionHeading index="02" label="Worlds" title="博弈与欺骗的竞技场" count={scenarios.length} />
          {(() => {
            const mid = Math.ceil(scenarios.length / 2);
            const columns = [scenarios.slice(0, mid), scenarios.slice(mid)];
            return (
              <div className="grid grid-cols-1 gap-x-12 lg:grid-cols-2">
                {columns.map((column, columnIndex) => (
                  <div key={columnIndex} className="border-t border-border/60">
                    {column.map((scenario, rowIndex) => (
                      <ScenarioRow
                        key={scenario.id}
                        scenario={scenario}
                        index={columnIndex * mid + rowIndex}
                        onStart={() => onStart(scenario.id)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            );
          })()}
        </section>

        {rooms.length ? (
          <section className="mt-28">
            <SectionHeading index="03" label="Live" title="正在发生的世界" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rooms.slice(0, 6).map((room) => (
                <div
                  key={room.id}
                  className="sheen group flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.6)]"
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
            <span className="flex size-5 items-center justify-center rounded bg-foreground font-mono text-[9px] text-background shadow-[inset_0_1px_0_oklch(1_0_0/0.5)]">◆</span>
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

/**
 * Interactive dot field: a canvas of monochrome dots that wake up around the
 * cursor. A pure function of pointer position — redrawn only when it changes.
 */
function DotField({ className }: { className?: string }): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef({ x: -9999, y: -9999 });

  const draw = useCallback((canvas: HTMLCanvasElement): void => {
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const gap = 26;
    const pointer = pointerRef.current;
    for (let y = gap / 2; y < height; y += gap) {
      for (let x = gap / 2; x < width; x += gap) {
        const dx = x - pointer.x;
        const dy = y - pointer.y;
        const distance = Math.hypot(dx, dy);
        const energy = Math.max(0, 1 - distance / 170);
        const radius = 0.8 + energy * 1.6;
        const alpha = 0.045 + energy * energy * 0.4;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = `oklch(1 0 0 / ${alpha.toFixed(3)})`;
        context.fill();
      }
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let listening = false;

    const schedule = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => { draw(canvas); });
    };
    const onMove = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      pointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      schedule();
    };
    const onLeave = (): void => {
      pointerRef.current = { x: -9999, y: -9999 };
      schedule();
    };

    schedule();
    const onMedia = (): void => {
      if (reduced.matches && listening) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerleave", onLeave);
        listening = false;
        schedule();
      } else if (!reduced.matches && !listening) {
        window.addEventListener("pointermove", onMove, { passive: true });
        window.addEventListener("pointerleave", onLeave);
        listening = true;
      }
    };
    onMedia();
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    reduced.addEventListener("change", onMedia);
    return () => {
      window.cancelAnimationFrame(frame);
      if (listening) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerleave", onLeave);
      }
      reduced.removeEventListener("change", onMedia);
      observer.disconnect();
    };
  }, [draw]);

  return <canvas ref={canvasRef} className={cn("h-full w-full", className)} aria-hidden />;
}

/** A node on the stage: an agent with its position in the 960×540 viewBox. */
interface GraphNode {
  name: string;
  seed: string;
  x: number;
  y: number;
  speaking?: boolean;
}

const GRAPH_NODES: GraphNode[] = [
  { name: "林默", seed: "builtin-01", x: 185, y: 165 },
  { name: "苏遥", seed: "builtin-02", x: 480, y: 78 },
  { name: "陈策", seed: "builtin-03", x: 785, y: 175, speaking: true },
  { name: "周妍", seed: "builtin-04", x: 262, y: 400 },
  { name: "唐妍", seed: "builtin-06", x: 695, y: 415 },
  { name: "许衡", seed: "builtin-05", x: 478, y: 278 }
];

const GRAPH_EDGES: Array<{ from: number; to: number; opacity: number; dashed?: boolean; label?: string; labelShift?: number }> = [
  { from: 0, to: 1, opacity: 0.26, label: "信任 0.82", labelShift: -0.06 },
  { from: 1, to: 2, opacity: 0.15 },
  { from: 0, to: 3, opacity: 0.12 },
  { from: 3, to: 4, opacity: 0.22, label: "结盟", labelShift: 0.05 },
  { from: 2, to: 4, opacity: 0.12 },
  { from: 5, to: 1, opacity: 0.13 },
  { from: 5, to: 3, opacity: 0.13 },
  { from: 5, to: 2, opacity: 0.34, dashed: true, label: "怀疑 ↑", labelShift: 0.06 }
];

const VIEW_W = 960;
const VIEW_H = 540;

/**
 * The showpiece: the social graph itself, alive. Agents are the nodes, the
 * ledger is the edges — trust solid, suspicion dashed — and the speaking
 * agent pulses. Pure vector plus the deterministic avatars: crisp at any
 * size, nothing that can read as a fake screenshot. Tilts gently toward the
 * cursor; reduced-motion viewers get the flat stage.
 */
function SocialGraphStage(): ReactNode {
  const stageRef = useRef<HTMLDivElement>(null);
  const reducedRef = useRef(false);

  useEffect(() => {
    reducedRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const stage = stageRef.current;
    if (!stage || reducedRef.current) return;
    const rect = stage.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    stage.style.transform = `perspective(1400px) rotateX(${(-py * 2.6).toFixed(2)}deg) rotateY(${(px * 3.4).toFixed(2)}deg)`;
  };
  const onPointerLeave = (): void => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.style.transform = "perspective(1400px) rotateX(0deg) rotateY(0deg)";
  };

  return (
    <div
      ref={stageRef}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className="relative origin-center transition-transform duration-300 ease-out will-change-transform"
    >
      <span aria-hidden className="pointer-events-none absolute -inset-x-10 -top-10 bottom-10 rounded-[2.5rem] bg-[radial-gradient(closest-side,oklch(1_0_0/0.045),transparent)] blur-2xl" />
      <div className="relative aspect-[16/9] w-full">
        {/* edges */}
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="absolute inset-0 h-full w-full" aria-hidden>
          {GRAPH_EDGES.map((edge, index) => {
            const from = GRAPH_NODES[edge.from]!;
            const to = GRAPH_NODES[edge.to]!;
            return (
              <line
                key={index}
                x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke="white"
                strokeOpacity={edge.opacity}
                strokeWidth={1}
                strokeDasharray={edge.dashed ? "1 6" : undefined}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        {/* edge labels */}
        {GRAPH_EDGES.map((edge, index) => {
          if (!edge.label) return null;
          const from = GRAPH_NODES[edge.from]!;
          const to = GRAPH_NODES[edge.to]!;
          const mx = (from.x + to.x) / 2;
          const my = (from.y + to.y) / 2 + (edge.labelShift ?? 0) * VIEW_H;
          return (
            <span
              key={`label-${index}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border bg-background/85 px-2 py-0.5 font-mono text-[10px] text-foreground/80 backdrop-blur-sm"
              style={{ left: `${(mx / VIEW_W) * 100}%`, top: `${(my / VIEW_H) * 100}%` }}
            >
              {edge.label}
            </span>
          );
        })}

        {/* nodes */}
        {GRAPH_NODES.map((node) => (
          <div
            key={node.seed}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"
            style={{ left: `${(node.x / VIEW_W) * 100}%`, top: `${(node.y / VIEW_H) * 100}%` }}
          >
            {node.speaking ? (
              <span className="absolute -top-9 flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background/80 px-2.5 py-1 backdrop-blur-sm" aria-hidden>
                <span className="eq text-foreground"><span /><span /><span /></span>
                <span className="font-mono text-[10px] tracking-wider text-foreground/90">正在发言</span>
              </span>
            ) : null}
            <span className="relative grayscale max-sm:[&>span]:size-11 [&>span]:shadow-[0_0_0_1px_oklch(1_0_0/0.22)]">
              {node.speaking ? (
                <>
                  <span aria-hidden className="absolute inset-0 animate-ping rounded-lg border border-foreground/40" style={{ animationDuration: "2.4s" }} />
                  <span aria-hidden className="absolute inset-0 animate-ping rounded-lg border border-foreground/20" style={{ animationDuration: "2.4s", animationDelay: "1.2s" }} />
                </>
              ) : null}
              <AgentAvatar name={node.name} seed={node.seed} size="xl" />
            </span>
            <span className="font-mono text-xs text-foreground/75">{node.name}</span>
          </div>
        ))}

        {/* blueprint crosshairs */}
        <span aria-hidden className="pointer-events-none absolute -left-2 -top-2 select-none font-mono text-sm leading-none text-muted-foreground/55">+</span>
        <span aria-hidden className="pointer-events-none absolute -right-2 -top-2 select-none font-mono text-sm leading-none text-muted-foreground/55">+</span>
        <span aria-hidden className="pointer-events-none absolute -bottom-2 -left-2 select-none font-mono text-sm leading-none text-muted-foreground/55">+</span>
        <span aria-hidden className="pointer-events-none absolute -bottom-2 -right-2 select-none font-mono text-sm leading-none text-muted-foreground/55">+</span>
      </div>
    </div>
  );
}

/** Editorial section opener: index + mono label + hairline, then the title. */
function SectionHeading({ index, label, title, count }: { index: string; label: string; title: string; count?: number }): ReactNode {
  return (
    <div className="mb-10">
      <div className="flex items-center gap-3">
        <span className="nums font-mono text-[11px] text-muted-foreground/60">{index}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground/60">{label}</span>
        <span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" aria-hidden />
        {count !== undefined ? (
          <span className="nums rounded-full border border-border px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {String(count).padStart(2, "0")}
          </span>
        ) : null}
      </div>
      <h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
    </div>
  );
}

/** Inline stat for the hero: big mono number, hairline, label. */
function Stat({ value, label, live }: { value: string; label: string; live?: boolean }): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <span className="nums font-mono text-2xl font-medium tracking-tight text-foreground">{value}</span>
        {live ? <span className="live-pulse size-1.5 rounded-full bg-foreground" /> : null}
      </span>
      <span className="text-[11px] text-muted-foreground/90">{label}</span>
    </div>
  );
}

function FeatureCell({ icon: Icon, title, children, className }: { icon: typeof Radio; title: string; children: ReactNode; className?: string }): ReactNode {
  return (
    <div className={cn("sheen group bg-card p-7 transition-colors hover:bg-card/80", className)}>
      <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-gradient-to-b from-muted to-card text-muted-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.06)] transition-all duration-300 group-hover:border-foreground/30 group-hover:text-foreground">
        <Icon className="size-4.5" />
      </span>
      <h3 className="mt-4 text-[15px] font-semibold tracking-tight">{title}</h3>
      <p className="mt-2.5 text-sm leading-6 text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * Editorial index row: serial + name + players on a hairline rule.
 * Hover inverts the row — white ground, black text — the monochrome signature.
 */
function ScenarioRow({ scenario, index, onStart }: { scenario: ScenarioSummary; index: number; onStart: () => void }): ReactNode {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onStart}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onStart(); }}
      className="group relative flex cursor-pointer items-center gap-5 border-b border-border/60 py-5 pr-3 pl-4 transition-colors duration-200 hover:bg-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
    >
      <span className="nums w-8 shrink-0 font-mono text-[13px] text-muted-foreground/35 transition-colors duration-200 group-hover:text-background/60">
        {String(index + 1).padStart(2, "0")}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-3">
          <span className="shrink-0 text-[17px] font-semibold tracking-tight transition-colors duration-200 group-hover:text-background">{scenario.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55 transition-colors duration-200 group-hover:text-background/70">
            <span className="size-1 shrink-0 rounded-full bg-foreground/35 transition-colors duration-200 group-hover:bg-background/70" />
            {scenario.playerRange ? `${scenario.playerRange.min}-${scenario.playerRange.max}P` : `${scenario.players}P`}
          </span>
        </span>
        <span className="mt-1 block line-clamp-2 text-[13px] leading-5 text-muted-foreground transition-colors duration-200 group-hover:text-background/80" title={scenario.description}>
          {scenario.description}
        </span>
      </span>
      <ArrowRight className="size-4 shrink-0 -translate-x-1 text-muted-foreground/40 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:text-background group-hover:opacity-100" aria-hidden />
    </div>
  );
}
