import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, Play } from "lucide-react";
import type { ScenarioSummary } from "@/society/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { ScenarioIcon } from "./shared";
import type { CreateRoomInput, ModelOption } from "./types";

interface CreateRoomProps {
  open: boolean;
  scenario: ScenarioSummary | undefined;
  models: ModelOption[];
  onOpenChange: (open: boolean) => void;
  onCreated: (input: CreateRoomInput) => Promise<{ roomId: string }>;
}

export function CreateRoomDialog({ open, scenario, models, onOpenChange, onCreated }: CreateRoomProps): ReactNode {
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [rounds, setRounds] = useState<number>(5);
  const [mode, setMode] = useState<"ai" | "human">("ai");
  const [playerName, setPlayerName] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">("low");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const minRounds = scenario?.minRounds ?? 2;
  const maxRounds = scenario?.maxRounds ?? 10;
  const visibleModels = useMemo(() => models.slice(0, 16), [models]);

  useEffect(() => {
    if (!open) return;
    setSelectedModels(visibleModels.slice(0, Math.min(4, visibleModels.length)).map((model) => model.id));
    setRounds(scenario?.defaultRounds ?? Math.min(5, maxRounds));
    setMode("ai");
    setPlayerName("");
    setReasoningEffort("low");
    setError(undefined);
  }, [open, scenario, maxRounds, visibleModels]);

  const toggleModel = (id: string): void => {
    setSelectedModels((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  };

  const submit = async (): Promise<void> => {
    if (!scenario) return;
    if (selectedModels.length === 0) {
      setError("至少选择一个模型。");
      return;
    }
    if (mode === "human" && !playerName.trim()) {
      setError("真人模式需要填写你的名字。");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await onCreated({
        scenarioId: scenario.id,
        models: selectedModels,
        rounds,
        mode,
        ...(mode === "human" ? { playerName: playerName.trim() } : {}),
        reasoningEffort
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onOpenChange(false); }}>
      <DialogContent className="max-w-xl rounded-xl border-border bg-card p-0 text-foreground shadow-2xl" showCloseButton={!submitting}>
        {scenario ? (
          <div className="max-h-[82vh] overflow-y-auto">
            <div className="border-b border-border/60 p-6">
              <DialogHeader className="gap-2 text-left">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-foreground/80">
                    <ScenarioIcon id={scenario.id} className="size-5" />
                  </span>
                  <div>
                    <DialogTitle className="text-lg tracking-tight">{scenario.name}</DialogTitle>
                    <DialogDescription className="mt-0.5 max-w-md leading-5 text-muted-foreground">{scenario.description}</DialogDescription>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="rounded-full border-border bg-muted font-normal text-muted-foreground">{scenario.players} 名参与者</Badge>
                  <Badge variant="outline" className="rounded-full border-border bg-muted font-normal text-muted-foreground">{scenario.minRounds}–{scenario.maxRounds} 轮</Badge>
                  {scenario.capabilities.slice(0, 3).map((capability) => (
                    <Badge key={capability} variant="outline" className="rounded-full border-border bg-card font-normal text-muted-foreground/80">{capability}</Badge>
                  ))}
                </div>
              </DialogHeader>
            </div>

            <div className="space-y-6 p-6">
              <section>
                <p className="mb-2.5 text-[13px] font-medium text-foreground/80">模型</p>
                <p className="mb-3 text-xs leading-5 text-muted-foreground/80">
                  每个参与者都是一个独立 Agent。选择一个模型 ID 给所有人，或选择多个模型让不同角色使用不同模型同台对决（按顺序轮转分配）。
                </p>
                <div className="flex flex-wrap gap-2" data-model>
                  {visibleModels.map((model) => {
                    const active = selectedModels.includes(model.id);
                    return (
                      <button
                        key={model.id}
                        data-model
                        onClick={() => toggleModel(model.id)}
                        className={cn(
                          "flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                          active
                            ? "border-foreground/70 bg-muted"
                            : "border-border bg-card hover:border-border"
                        )}
                      >
                        <span className={cn("flex size-3.5 items-center justify-center rounded-full border", active ? "border-foreground bg-foreground" : "border-border")}>
                          {active ? <span className="size-1.5 rounded-full bg-card" /> : null}
                        </span>
                        <span className="text-[13px] font-medium text-foreground/90">{model.name}</span>
                        {model.contextLabel ? (
                          <span className="rounded border border-border bg-muted px-1 font-mono text-[9px] text-muted-foreground/80">{model.contextLabel}</span>
                        ) : null}
                        <span className="font-mono text-[10px] text-muted-foreground/80">{model.provider}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="mb-2.5 flex items-center justify-between">
                  <p className="text-[13px] font-medium text-foreground/80">回合数</p>
                  <span className="nums font-mono text-xs text-muted-foreground">{rounds}</span>
                </div>
                <Slider
                  min={minRounds}
                  max={maxRounds}
                  step={1}
                  value={[rounds]}
                  onValueChange={(value) => setRounds(value[0] ?? minRounds)}
                  className="py-1"
                />
                <div className="nums mt-1 flex justify-between font-mono text-[10px] text-muted-foreground/80">
                  <span>{minRounds}</span>
                  <span>{maxRounds}</span>
                </div>
              </section>

              <section className="grid grid-cols-2 gap-4">
                <div>
                  <p className="mb-2.5 text-[13px] font-medium text-foreground/80">参与者</p>
                  <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted p-1">
                    <ModeButton active={mode === "ai"} onClick={() => setMode("ai")}>全 AI</ModeButton>
                    <ModeButton active={mode === "human"} onClick={() => setMode("human")}>真人加入</ModeButton>
                  </div>
                </div>
                <div>
                  <p className="mb-2.5 text-[13px] font-medium text-foreground/80">推理强度</p>
                  <Select value={reasoningEffort} onValueChange={(value) => setReasoningEffort(value as "low" | "medium" | "high")}>
                    <SelectTrigger className="rounded-lg border-border bg-card text-foreground/90">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">轻量</SelectItem>
                      <SelectItem value="medium">标准</SelectItem>
                      <SelectItem value="high">深度</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </section>

              {scenario && selectedModels.length > 0 ? (
                <section>
                  <p className="mb-2.5 text-[13px] font-medium text-foreground/80">参与者阵容</p>
                  <div className="rounded-lg border border-border bg-muted/60 p-3" data-model>
                    <div className="space-y-1.5">
                      {Array.from({ length: scenario.players }).map((_, index) => {
                        const model = selectedModels[index % selectedModels.length];
                        const option = models.find((candidate) => candidate.id === model);
                        return (
                          <div key={index} className="flex items-center justify-between text-xs">
                            <span className="flex items-center gap-2 text-muted-foreground">
                              <span className="flex size-5 items-center justify-center rounded bg-card font-mono text-[9px] text-muted-foreground/80 ring-1 ring-border">
                                {String(index + 1).padStart(2, "0")}
                              </span>
                              第 {index + 1} 位参与者
                            </span>
                            <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                              {option?.contextLabel ? (
                                <span className="rounded border border-border bg-card px-1 text-[9px] text-muted-foreground/80">{option.contextLabel}</span>
                              ) : null}
                              {option?.name ?? model}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              ) : null}

              {mode === "human" ? (
                <section>
                  <p className="mb-2.5 text-[13px] font-medium text-foreground/80">你的名字</p>
                  <input
                    value={playerName}
                    onChange={(event) => setPlayerName(event.target.value)}
                    placeholder="作为第 1 位参与者加入"
                    maxLength={40}
                    className="h-10 w-full rounded-lg border border-border bg-card px-3.5 text-sm text-foreground placeholder:text-muted-foreground/80 focus:border-ring focus:outline-none"
                  />
                </section>
              ) : null}

              {error ? <p className="text-[13px] text-red-400">{error}</p> : null}

              <div className="flex items-center justify-end gap-3 border-t border-border/60 pt-5">
                <Button variant="ghost" className="text-muted-foreground hover:bg-muted hover:text-foreground" disabled={submitting} onClick={() => onOpenChange(false)}>
                  取消
                </Button>
                <Button
                  onClick={submit}
                  disabled={submitting}
                  className="rounded-lg bg-foreground px-6 text-background hover:bg-foreground/85"
                >
                  {submitting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  开始世界
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-8 rounded-md text-[13px] font-medium transition-colors",
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground/80"
      )}
    >
      {children}
    </button>
  );
}
