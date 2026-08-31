import type { ReactNode } from "react";
import { Archive, ArrowRight, CircleCheck, HardDrive, Play, Radio, Settings2, Trash2, Users } from "lucide-react";
import type { HealthResponse } from "@/App";
import type { ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ScenarioIcon, StatusDot, StatusLabel, formatTime } from "./shared";
import type { ArchiveOption, ModelOption } from "./types";

interface LandingProps {
  scenarios: ScenarioSummary[];
  models: ModelOption[];
  rooms: SocietyRoomSnapshot[];
  archives: ArchiveOption[];
  health?: HealthResponse;
  onStart: (scenarioId: string) => void;
  onOpenRoom: (roomId: string) => void;
  onOpenArchive: (archiveId: string) => void;
  onOpenSettings: () => void;
  onOpenCharacters: () => void;
  onOpenAbout: () => void;
  onRemoveRoom: (roomId: string) => void;
}

export function Landing(props: LandingProps): ReactNode {
  const { scenarios, models, rooms, archives, health, onStart, onOpenRoom, onOpenArchive, onOpenSettings, onOpenCharacters, onOpenAbout, onRemoveRoom } = props;
  const ready = health?.models.ready ?? models.length;
  const firstScenario = scenarios[0]?.id ?? "werewolf";
  return (
    <div className="min-h-screen bg-background">
      <header className="rule-b sticky top-0 z-20 bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <Button variant="ghost" className="h-auto gap-2.5 p-0 hover:bg-transparent" onClick={() => { location.hash = "#/"; }}>
            <span className="flex size-7 items-center justify-center rounded-md bg-foreground font-mono text-xs text-background">◆</span>
            <span className="text-base font-semibold tracking-tight">Society</span>
          </Button>
          <nav className="flex items-center gap-1" aria-label="主要导航">
            <Button variant="ghost" size="sm" className="hidden text-muted-foreground sm:inline-flex" onClick={onOpenCharacters}><Users />人物库</Button>
            <Button variant="ghost" size="sm" className="hidden text-muted-foreground md:inline-flex" onClick={onOpenAbout}>关于</Button>
            <Button variant="tile" size="icon-sm" aria-label="模型设置" onClick={onOpenSettings}><Settings2 /></Button>
            <Button size="sm" onClick={() => onStart(firstScenario)} disabled={ready === 0}><Play />创建世界</Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-4 py-8 sm:px-6 sm:py-12">
        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
          <div>
            <Badge variant="outline" className="mb-4 gap-2 rounded-full py-1">
              <span className={cn("size-1.5 rounded-full", ready > 0 ? "bg-live" : "bg-warn")} />
              {ready > 0 ? `${ready} 个模型已就绪` : "需要完成模型协议检查"}
            </Badge>
            <h1 className="max-w-3xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">观察 Agent 如何谈判、结盟与背叛</h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
              本机运行的多智能体社会博弈舞台。工具调用、工具结果与最终发言按真实顺序直播，并在终局保留可复盘的因果证据。
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
            <Button size="lg" className="h-11 flex-1" onClick={() => onStart(firstScenario)} disabled={ready === 0}>
              <Play />创建世界<ArrowRight />
            </Button>
            <Button variant="outline" size="lg" className="h-11 flex-1" onClick={onOpenSettings}><Settings2 />模型设置</Button>
          </div>
        </section>

        {ready === 0 ? (
          <Alert variant="destructive">
            <Settings2 aria-hidden />
            <AlertTitle>没有可参赛的模型</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>只有已启用且通过真实 Agents SDK 协议检查的模型才会进入创建页。</span>
              <Button variant="outline" size="sm" onClick={onOpenSettings}>前往模型设置</Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {health?.storage.status === "degraded" ? (
          <Alert variant="destructive">
            <HardDrive aria-hidden />
            <AlertTitle>本机存储处于降级状态</AlertTitle>
            <AlertDescription>检测到 {health.storage.issues.length} 个存储问题。损坏文件已隔离，服务仍可运行；请先备份 data 目录并检查终端告警。</AlertDescription>
          </Alert>
        ) : null}

        <section aria-labelledby="active-heading">
          <SectionHeading id="active-heading" title="正在发生" meta={rooms.length ? `${rooms.length} 个活跃世界` : "当前没有运行中的房间"} />
          {rooms.length ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {rooms.slice(0, 6).map((room) => (
                <Card key={room.id} className="group transition-colors hover:border-foreground/30">
                  <CardContent className="flex items-center gap-3 p-4">
                    <Button variant="ghost" onClick={() => onOpenRoom(room.id)} className="h-auto min-w-0 flex-1 justify-start gap-4 p-0 text-left hover:bg-transparent">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground"><ScenarioIcon id={room.scenarioId} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-semibold">{room.title}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <StatusDot status={room.status} /><StatusLabel status={room.status} />
                          <Separator orientation="vertical" className="h-3" />
                          {room.participants.length} 名参与者
                        </span>
                      </span>
                      <span className="hidden items-center gap-1 text-sm text-muted-foreground group-hover:text-foreground sm:flex">继续观看<ArrowRight className="size-4" /></span>
                    </Button>
                    {room.mode === "ai" ? <Button variant="ghost" size="icon-xs" aria-label={`移除 ${room.title}`} onClick={() => onRemoveRoom(room.id)}><Trash2 /></Button> : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Empty className="rounded-xl border border-dashed py-10">
              <EmptyHeader><EmptyMedia variant="icon"><Radio /></EmptyMedia><EmptyTitle>舞台正在等待第一场对局</EmptyTitle><EmptyDescription>选择一个世界，配置阵容后即可开始直播。</EmptyDescription></EmptyHeader>
              <Button onClick={() => onStart(firstScenario)} disabled={ready === 0}><Play />创建世界</Button>
            </Empty>
          )}
        </section>

        <section aria-labelledby="archive-heading">
          <SectionHeading id="archive-heading" title="最近归档" meta={archives.length ? `${archives.length} 份本机复盘` : "归档由创建者明确选择保存"} />
          {archives.length ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {archives.slice(0, 6).map((archive) => (
                <Button key={archive.id} variant="ghost" onClick={() => onOpenArchive(archive.id)} className="group h-auto justify-start gap-4 whitespace-normal rounded-xl border border-border bg-card p-4 text-left hover:border-foreground/30 hover:bg-card">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground"><ScenarioIcon id={archive.scenarioId as ScenarioSummary["id"]} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{archive.title}</span><span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><Archive className="size-3" />{formatTime(archive.finishedAt, { seconds: false })}</span></span>
                  <ArrowRight className="size-4 text-muted-foreground group-hover:text-foreground" />
                </Button>
              ))}
            </div>
          ) : (
            <Empty className="rounded-xl border border-dashed py-8"><EmptyHeader><EmptyMedia variant="icon"><Archive /></EmptyMedia><EmptyTitle>还没有赛后归档</EmptyTitle><EmptyDescription>创建房间时开启“保存对局”，终局后会写入本机 JSON。</EmptyDescription></EmptyHeader></Empty>
          )}
        </section>

        <section id="scenarios" aria-labelledby="scenario-heading">
          <SectionHeading id="scenario-heading" title="场景目录" meta={`${scenarios.length} 个公开世界`} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {scenarios.map((scenario) => <WorldCard key={scenario.id} scenario={scenario} disabled={ready === 0} onStart={() => onStart(scenario.id)} />)}
          </div>
        </section>
      </main>

      <footer className="rule-t py-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col justify-between gap-3 px-4 text-xs text-muted-foreground sm:flex-row sm:px-6">
          <span className="flex items-center gap-2"><CircleCheck className="size-3.5" />Local-first · JSON persistence · OpenAI Agents SDK</span>
          <Button variant="link" className="h-auto justify-start p-0 text-xs text-muted-foreground" onClick={onOpenAbout}>项目说明</Button>
        </div>
      </footer>
    </div>
  );
}

function SectionHeading({ id, title, meta }: { id: string; title: string; meta: string }): ReactNode {
  return <div className="mb-5 flex flex-wrap items-end justify-between gap-2"><h2 id={id} className="text-lg font-semibold tracking-tight">{title}</h2><p className="text-xs text-muted-foreground">{meta}</p></div>;
}

function WorldCard({ scenario, disabled, onStart }: { scenario: ScenarioSummary; disabled: boolean; onStart: () => void }): ReactNode {
  return (
    <Button variant="ghost" disabled={disabled} onClick={onStart} className="group h-auto min-h-32 w-full items-start justify-start gap-4 whitespace-normal rounded-xl border border-border bg-card p-5 text-left hover:border-foreground/30 hover:bg-card">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground"><ScenarioIcon id={scenario.id} /></span>
      <span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-3"><span className="text-base font-semibold">{scenario.name}</span><Badge variant="outline">{scenario.playerRange ? `${scenario.playerRange.min}–${scenario.playerRange.max} 人` : `${scenario.players} 人`}</Badge></span><span className="mt-2 line-clamp-3 block text-sm leading-6 text-muted-foreground">{scenario.description}</span></span>
    </Button>
  );
}
