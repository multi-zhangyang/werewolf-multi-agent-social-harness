import { useEffect, useMemo, useState, type ReactNode } from "react";
import { History, Loader2, Play } from "lucide-react";
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
  /** How many characters carry cross-game history into this room. */
  seasonCount?: number;
  onOpenChange: (open: boolean) => void;
  onCreated: (input: CreateRoomInput) => Promise<{ roomId: string }>;
}

export function CreateRoomDialog({ open, scenario, models, seasonCount = 0, onOpenChange, onCreated }: CreateRoomProps): ReactNode {
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [seatOverrides, setSeatOverrides] = useState<Record<string, string>>({});
  const [seatTuning, setSeatTuning] = useState<Record<string, { temperature?: number; maxOutputTokens?: number; reasoningEffort?: "low" | "medium" | "high" }>>({});
  const [advanced, setAdvanced] = useState(false);
  const [rounds, setRounds] = useState<number>(5);
  const [players, setPlayers] = useState<number>(6);
  const [mode, setMode] = useState<"ai" | "human">("ai");
  const [playerName, setPlayerName] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">("low");
  const [seasonMode, setSeasonMode] = useState<"season" | "one-shot">("season");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const minRounds = scenario?.minRounds ?? 2;
  const maxRounds = scenario?.maxRounds ?? 10;
  const visibleModels = useMemo(() => models.slice(0, 16), [models]);
  /** Every selected model has a registry profile id → the server can resolve per-seat bindings. */
  const profilesResolvable = useMemo(
    () => selectedModels.length > 0 && selectedModels.every((id) => visibleModels.some((model) => model.id === id && model.profileId)),
    [selectedModels, visibleModels]
  );

  useEffect(() => {
    if (!open) return;
    setSelectedModels(visibleModels.slice(0, Math.min(4, visibleModels.length)).map((model) => model.id));
    setSeatOverrides({});
    setSeatTuning({});
    setAdvanced(false);
    setRounds(scenario?.defaultRounds ?? Math.min(5, maxRounds));
    setPlayers(scenario?.players ?? 2);
    setMode("ai");
    setPlayerName("");
    setReasoningEffort("low");
    setSeasonMode("season");
    setError(undefined);
  }, [open, scenario, maxRounds, visibleModels]);

  const toggleModel = (id: string): void => {
    setSelectedModels((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  };

  const seatModelFor = (index: number): ModelOption | undefined => {
    const override = seatOverrides[String(index)];
    if (override) return visibleModels.find((model) => model.profileId === override);
    const modelId = selectedModels[index % selectedModels.length];
    return visibleModels.find((model) => model.id === modelId);
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
        ...(profilesResolvable
          ? { modelProfileIds: selectedModels.map((id) => visibleModels.find((model) => model.id === id)?.profileId).filter((id): id is string => Boolean(id)) }
          : {}),
        ...(Object.keys(seatOverrides).length ? { agentModelOverrides: seatOverrides } : {}),
        ...(Object.keys(seatTuning).length ? { agentTuning: seatTuning } : {}),
        rounds,
        ...(scenario.playerRange ? { players } : {}),
        mode,
        ...(mode === "human" ? { playerName: playerName.trim() } : {}),
        reasoningEffort,
        season: seasonMode
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
                  <Badge variant="outline" className="rounded-full border-border bg-muted font-normal text-muted-foreground">
                    {scenario.playerRange ? `${scenario.playerRange.min}-${scenario.playerRange.max} 名参与者` : `${scenario.players} 名参与者`}
                  </Badge>
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
                  每个参与者都是一个独立 Agent。选择一个模型给所有人，或选择多个模型让不同角色使用不同模型同台对决（按顺序轮转分配）。需要的话，可在「参与者阵容」里为单个席位指定不同模型。
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

              {scenario.playerRange ? (
                <section>
                  <div className="mb-2.5 flex items-center justify-between">
                    <p className="text-[13px] font-medium text-foreground/80">人数</p>
                    <span className="nums font-mono text-xs text-muted-foreground">{players} 人</span>
                  </div>
                  <Slider
                    min={scenario.playerRange.min}
                    max={scenario.playerRange.max}
                    step={1}
                    value={[players]}
                    onValueChange={(value) => setPlayers(value[0] ?? scenario.playerRange!.min)}
                    className="py-1"
                  />
                  <div className="nums mt-1 flex justify-between font-mono text-[10px] text-muted-foreground/80">
                    <span>{scenario.playerRange.min} 人</span>
                    <span>{scenario.playerRange.max} 人</span>
                  </div>
                  {scenario.id === "werewolf" ? (
                    <p className="mt-2 text-[11px] leading-4 text-muted-foreground/70">按官方板子组牌：6–12 人各有对应牌组（狼人·狼王·预言家·女巫·猎人·守卫·小丑·村民），人数越多角色越复杂。</p>
                  ) : null}
                  {scenario.id === "avalon" ? (
                    <p className="mt-2 text-[11px] leading-4 text-muted-foreground/70">按官方规则配置：5-10 人的忠臣/内奸比例与任务人数遵循阿瓦隆说明书（7 人及以上第四任务需要两张失败票）。</p>
                  ) : null}
                </section>
              ) : null}

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
                  <div className="mb-2.5 flex items-center justify-between">
                    <p className="text-[13px] font-medium text-foreground/80">参与者阵容</p>
                    {profilesResolvable ? (
                      <button
                        type="button"
                        onClick={() => setAdvanced((current) => !current)}
                        className="text-xs text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
                      >
                        {advanced ? "收起单 Agent 配置" : "单 Agent 覆盖（高级）"}
                      </button>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/70">在设置中注册模型档案后可单独指定</span>
                    )}
                  </div>
                  <div className="rounded-lg border border-border bg-muted/60 p-3" data-model>
                    <div className="space-y-1.5">
                      {Array.from({ length: players }).map((_, index) => {
                        const option = seatModelFor(index);
                        const overridden = Boolean(seatOverrides[String(index)]);
                        const tuning = seatTuning[String(index)];
                        return (
                          <div key={index} className="rounded-md px-1 py-0.5">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="flex items-center gap-2 text-muted-foreground">
                                <span className="flex size-5 items-center justify-center rounded bg-card font-mono text-[9px] text-muted-foreground/80 ring-1 ring-border">
                                  {String(index + 1).padStart(2, "0")}
                                </span>
                                第 {index + 1} 位参与者
                              </span>
                              {advanced && profilesResolvable ? (
                                <Select
                                  value={seatOverrides[String(index)] ?? ""}
                                  onValueChange={(value) => {
                                    setSeatOverrides((current) => {
                                      const next = { ...current };
                                      if (value === "" || value === "__inherit") delete next[String(index)];
                                      else next[String(index)] = value;
                                      return next;
                                    });
                                  }}
                                >
                                  <SelectTrigger className="h-7 w-56 justify-end rounded-md border-border bg-card font-mono text-[11px] text-muted-foreground">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__inherit">轮转继承（{selectedModels[index % selectedModels.length]}）</SelectItem>
                                    {visibleModels.filter((model) => model.profileId).map((model) => (
                                      <SelectItem key={model.profileId} value={model.profileId!}>
                                        {model.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ) : (
                                <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                                  {overridden ? (
                                    <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1 text-[9px] text-amber-300">指定</span>
                                  ) : null}
                                  {option?.contextLabel ? (
                                    <span className="rounded border border-border bg-card px-1 text-[9px] text-muted-foreground/80">{option.contextLabel}</span>
                                  ) : null}
                                  {option?.name ?? "—"}
                                </span>
                              )}
                            </div>
                            {advanced ? (
                              <div className="mt-1.5 flex items-center gap-2 pl-7 text-[11px] text-muted-foreground">
                                <span>温度</span>
                                <input
                                  type="range"
                                  min={0}
                                  max={2}
                                  step={0.1}
                                  value={tuning?.temperature ?? 1}
                                  onChange={(event) => setSeatTuning((current) => {
                                    const next = { ...current };
                                    const value = Number(event.target.value);
                                    next[String(index)] = { ...(next[String(index)] ?? {}), ...(value === 1 ? {} : { temperature: value }) };
                                    if (Object.keys(next[String(index)] ?? {}).length === 0) delete next[String(index)];
                                    return next;
                                  })}
                                  className="h-1 w-20 accent-foreground"
                                  aria-label={`第 ${index + 1} 位温度`}
                                />
                                <span className="nums w-7 font-mono">{tuning?.temperature ?? 1}</span>
                                <span className="ml-2">最大输出</span>
                                <input
                                  type="number"
                                  min={256}
                                  max={64_000}
                                  step={256}
                                  placeholder="继承"
                                  value={tuning?.maxOutputTokens ?? ""}
                                  onChange={(event) => setSeatTuning((current) => {
                                    const next = { ...current };
                                    const value = Number(event.target.value);
                                    if (Number.isFinite(value) && value > 0) next[String(index)] = { ...(next[String(index)] ?? {}), maxOutputTokens: value };
                                    else {
                                      const entry = { ...(next[String(index)] ?? {}) };
                                      delete entry.maxOutputTokens;
                                      if (Object.keys(entry).length) next[String(index)] = entry;
                                      else delete next[String(index)];
                                    }
                                    return next;
                                  })}
                                  className="h-7 w-20 rounded-md border border-border bg-card px-2 font-mono text-[11px]"
                                />
                                <span className="ml-2">推理</span>
                                <Select
                                  value={tuning?.reasoningEffort ?? "__inherit"}
                                  onValueChange={(value) => setSeatTuning((current) => {
                                    const next = { ...current };
                                    if (value === "__inherit") {
                                      const entry = { ...(next[String(index)] ?? {}) };
                                      delete entry.reasoningEffort;
                                      if (Object.keys(entry).length) next[String(index)] = entry;
                                      else delete next[String(index)];
                                    } else {
                                      next[String(index)] = { ...(next[String(index)] ?? {}), reasoningEffort: value as "low" | "medium" | "high" };
                                    }
                                    return next;
                                  })}
                                >
                                  <SelectTrigger className="h-7 w-24 rounded-md border-border bg-card text-[11px]"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__inherit">继承</SelectItem>
                                    <SelectItem value="low">轻量</SelectItem>
                                    <SelectItem value="medium">标准</SelectItem>
                                    <SelectItem value="high">深度</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    {advanced ? (
                      <p className="mt-2 border-t border-border/60 pt-2 text-[11px] leading-4 text-muted-foreground/80">
                        每个参与者仍是一个独立 Agent：指定的模型档案只替换该席位的模型；温度、最大输出与推理强度只覆盖该席位的参数；人格、记忆与关系不变。继承的字段按「系统 → 模型档案 → 全局 → 房间 → 席位」解析。
                      </p>
                    ) : null}
                  </div>
                </section>
              ) : null}

              <section>
                <p className="mb-2.5 text-[13px] font-medium text-foreground/80">记忆模式</p>
                <div className="grid grid-cols-2 gap-2">
                  <SeasonModeCard
                    active={seasonMode === "season"}
                    onClick={() => setSeasonMode("season")}
                    title="社会季模式"
                    description="角色带着过往对局的记忆、关系与恩怨入场,一局结束后继续积累。像一群越玩越熟的老友。"
                    hint={seasonCount > 0 ? `${seasonCount} 位角色已有历史` : "从零开始积累"}
                  />
                  <SeasonModeCard
                    active={seasonMode === "one-shot"}
                    onClick={() => setSeasonMode("one-shot")}
                    title="单局模式"
                    description="本局完全隔离,不读取任何历史,结束后也不留下任何记忆。适合一局定胜负、零干扰对决。"
                    hint="无历史、无残留"
                  />
                </div>
                {seasonMode === "season" && seasonCount > 0 ? (
                  <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                    <History className="mt-0.5 size-3.5 shrink-0" />
                    社会季进行中:{seasonCount} 位角色会带着历史入场。想让他们互不相识,请先在首页「重置社会季」,或改用单局模式。
                  </p>
                ) : null}
                {seasonMode === "one-shot" ? (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    不读取、也不写入社会季:身份随机、记忆归零,连角色关系都从陌生人开始。
                  </p>
                ) : null}
              </section>

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

function SeasonModeCard({ active, onClick, title, description, hint }: {
  active: boolean;
  onClick: () => void;
  title: string;
  description: string;
  hint?: string;
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col rounded-lg border p-3.5 text-left transition-colors",
        active ? "border-emerald-400/50 bg-emerald-400/10" : "border-border bg-card hover:border-border"
      )}
    >
      <span className={cn("flex items-center gap-2 text-[13px] font-semibold", active ? "text-emerald-300" : "text-foreground/90")}>
        <span className={cn("flex size-3.5 items-center justify-center rounded-full border", active ? "border-emerald-400 bg-emerald-400" : "border-border")}>
          {active ? <span className="size-1.5 rounded-full bg-background" /> : null}
        </span>
        {title}
        {hint ? <span className={cn("ml-auto rounded-full border px-2 py-px text-[10px] font-normal", active ? "border-emerald-400/40 text-emerald-300/90" : "border-border text-muted-foreground")}>{hint}</span> : null}
      </span>
      <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">{description}</span>
    </button>
  );
}
