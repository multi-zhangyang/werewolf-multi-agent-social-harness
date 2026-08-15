import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, LoaderCircle, Users } from "lucide-react";
import { AgentAvatar, ScenarioIcon } from "./shared";
import type { ModelOption } from "./types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import type { ScenarioId, ScenarioSummary } from "@/society/contracts";

const agentNames = ["林默", "苏遥", "陈策", "周岚", "许衡", "唐妍", "顾行", "叶澄"];

export function CreateRoomDialog({
  open,
  scenarios,
  models,
  initialScenarioId,
  loading,
  onOpenChange,
  onSubmit
}: {
  open: boolean;
  scenarios: ScenarioSummary[];
  models: ModelOption[];
  initialScenarioId?: ScenarioId;
  loading: boolean;
  onOpenChange(open: boolean): void;
  onSubmit(input: { scenarioId: ScenarioId; models: string[]; rounds: number }): Promise<void>;
}): ReactNode {
  const fallbackScenario = initialScenarioId ?? scenarios[0]?.id ?? "prisoners-dilemma";
  const [scenarioId, setScenarioId] = useState<ScenarioId>(fallbackScenario);
  const [rounds, setRounds] = useState(6);
  const [roster, setRoster] = useState<string[]>([]);
  const scenario = useMemo(() => scenarios.find((item) => item.id === scenarioId) ?? scenarios[0], [scenarioId, scenarios]);

  useEffect(() => {
    if (!open) return;
    const nextId = initialScenarioId ?? scenarios[0]?.id;
    if (nextId) setScenarioId(nextId);
  }, [initialScenarioId, open, scenarios]);

  useEffect(() => {
    if (!scenario) return;
    setRounds(scenario.defaultRounds);
    setRoster((current) => Array.from({ length: scenario.players }, (_, index) => current[index] ?? models[index % Math.max(1, models.length)]?.id ?? ""));
  }, [models, scenario]);

  const chooseScenario = (id: ScenarioId): void => {
    setScenarioId(id);
  };

  const setModel = (index: number, model: string): void => {
    setRoster((current) => current.map((value, candidateIndex) => candidateIndex === index ? model : value));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-hidden border-white/10 bg-zinc-950 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-white/10 px-6 py-5">
          <DialogTitle>新建房间</DialogTitle>
          <DialogDescription>选择场景、回合与每个 Agent 使用的模型。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[calc(92vh-9rem)] overflow-y-auto px-6 py-5">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium">场景</h3>
              <span className="font-mono text-[10px] text-muted-foreground">{scenarios.length} 个场景</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {scenarios.map((item) => (
                <button key={item.id} className="text-left" onClick={() => chooseScenario(item.id)}>
                  <Card className={cn(
                    "h-full gap-0 rounded-lg border-white/10 bg-white/[0.025] p-4 shadow-none transition-colors hover:bg-white/[0.05]",
                    item.id === scenario?.id && "border-white/35 bg-white/[0.07]"
                  )}>
                    <div className="flex items-start gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/30">
                        <ScenarioIcon id={item.id} className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{item.name}</span>
                          {item.id === scenario?.id ? <Badge className="h-5 rounded-md px-1.5 text-[10px]">已选择</Badge> : null}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.shortDescription}</p>
                        <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-zinc-600">
                          <Users className="size-3" /> {item.players} 名 Agent
                        </div>
                      </div>
                    </div>
                  </Card>
                </button>
              ))}
            </div>
          </section>

          <Separator className="my-5" />

          {scenario ? (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium">模型阵容</h3>
                  <p className="mt-1 text-xs text-muted-foreground">每名参与者拥有独立 Agent、session、记忆和工具。</p>
                </div>
                <Badge variant="outline" className="border-white/10 text-muted-foreground">{scenario.players} 名 Agent</Badge>
              </div>
              <div className="overflow-hidden rounded-lg border border-white/10">
                {roster.slice(0, scenario.players).map((modelId, index) => (
                  <div key={index} className="flex items-center gap-3 border-b border-white/10 px-3 py-2.5 last:border-b-0">
                    <AgentAvatar name={agentNames[index]} index={index} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium">{agentNames[index]}</p>
                      <p className="mt-0.5 font-mono text-[10px] text-zinc-600">agent-{String(index + 1).padStart(2, "0")}</p>
                    </div>
                    <Select value={modelId} onValueChange={(value) => setModel(index, value)}>
                      <SelectTrigger className="w-[220px] border-white/10 bg-white/[0.025]">
                        <SelectValue placeholder="选择模型" />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {scenario ? (
            <section className="mt-5 rounded-lg border border-white/10 bg-white/[0.02] p-4">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium">回合上限</h3>
                  <p className="mt-1 text-xs text-muted-foreground">场景会在胜负确定时提前结束。</p>
                </div>
                <span className="min-w-12 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-center font-mono text-sm">{rounds}</span>
              </div>
              <Slider min={scenario.minRounds} max={scenario.maxRounds} step={1} value={[rounds]} onValueChange={(value) => setRounds(value[0])} />
              <div className="mt-2 flex justify-between font-mono text-[10px] text-zinc-600"><span>{scenario.minRounds}</span><span>{scenario.maxRounds}</span></div>
            </section>
          ) : null}
        </div>
        <DialogFooter className="border-t border-white/10 bg-black/20 px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            disabled={!scenario || roster.slice(0, scenario?.players ?? 0).some((model) => !model) || loading}
            onClick={() => scenario && void onSubmit({ scenarioId: scenario.id, models: roster.slice(0, scenario.players), rounds })}
          >
            {loading ? <LoaderCircle className="animate-spin" /> : null}
            开始
            {!loading ? <ArrowRight /> : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
