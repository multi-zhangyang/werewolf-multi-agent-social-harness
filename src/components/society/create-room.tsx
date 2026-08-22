import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { History, Loader2, Play, Shuffle, Trash2 } from "lucide-react";
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { ScenarioIcon } from "./shared";
import type { CharacterOption, CreateRoomInput, ModelOption } from "./types";

/** How models are assigned to seats (§ 建房模型分配). */
type ModelAssignMode = "unified" | "per-seat" | "random";

/** Lightweight create-form preferences remembered across visits. */
interface ModelAssignPrefs {
  mode?: ModelAssignMode;
  unifiedProfileId?: string;
  randomPoolIds?: string[];
}

const MODEL_PREFS_KEY = "society:model-assign-prefs";

interface CreateRoomProps {
  open: boolean;
  scenario: ScenarioSummary | undefined;
  models: ModelOption[];
  /** How many characters carry cross-game history into this room. */
  seasonCount?: number;
  onOpenChange: (open: boolean) => void;
  onCreated: (input: CreateRoomInput) => Promise<{ roomId: string }>;
}

/** A saved create-room configuration (§6.4 阵容模板). */
interface RosterTemplateOption {
  id: string;
  name: string;
  scenarioId: string;
  models: string[];
  modelProfileIds?: string[];
  agentModelOverrides?: Record<string, string>;
  agentTuning?: Record<string, { temperature?: number; reasoningEffort?: "low" | "medium" | "high" | "xhigh" }>;
  players?: number;
  characterIds?: string[];
  rounds?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  season?: "season" | "one-shot";
}

export function CreateRoomDialog({ open, scenario, models, seasonCount = 0, onOpenChange, onCreated }: CreateRoomProps): ReactNode {
  /** Only registry-backed models can be assigned per seat. */
  const eligibleModels = useMemo(() => models.filter((model) => Boolean(model.profileId)), [models]);
  const profileById = useMemo(() => new Map(eligibleModels.map((model) => [model.profileId as string, model])), [eligibleModels]);

  const [assignMode, setAssignMode] = useState<ModelAssignMode>("unified");
  const [unifiedProfileId, setUnifiedProfileId] = useState<string>("");
  /** Per-seat picks for 逐席配置 (absent = inherit the unified pick). */
  const [seatPicks, setSeatPicks] = useState<Record<string, string>>({});
  const [randomPoolIds, setRandomPoolIds] = useState<string[]>([]);
  /** The dealt seat→profile table shown as the preview; what you see is what is submitted. */
  const [randomRoster, setRandomRoster] = useState<string[]>([]);
  const [rounds, setRounds] = useState<number>(5);
  const [players, setPlayers] = useState<number>(6);
  const [mode, setMode] = useState<"ai" | "human">("ai");
  const [playerName, setPlayerName] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high" | "xhigh">("high");
  const [seasonMode, setSeasonMode] = useState<"season" | "one-shot">("season");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  /** Character library: built-ins + user-defined characters. */
  const [characters, setCharacters] = useState<CharacterOption[]>([]);
  /** Per-seat character picks (absent = the seat's default built-in). */
  const [seatCharacters, setSeatCharacters] = useState<Record<string, string>>({});
  /** Saved roster templates for this world (§6.4). */
  const [templates, setTemplates] = useState<RosterTemplateOption[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [loadedTemplateId, setLoadedTemplateId] = useState<string>();

  const minRounds = scenario?.minRounds ?? 2;
  const maxRounds = scenario?.maxRounds ?? 10;

  // Restore lightweight preferences once (they survive across dialogs).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(MODEL_PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw) as ModelAssignPrefs;
      if (prefs.mode === "unified" || prefs.mode === "per-seat" || prefs.mode === "random") setAssignMode(prefs.mode);
      if (typeof prefs.unifiedProfileId === "string") setUnifiedProfileId(prefs.unifiedProfileId);
      if (Array.isArray(prefs.randomPoolIds)) setRandomPoolIds(prefs.randomPoolIds.filter((id) => typeof id === "string"));
    } catch {
      // Corrupt preferences are ignored, never blocking room creation.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(MODEL_PREFS_KEY, JSON.stringify({ mode: assignMode, unifiedProfileId, randomPoolIds } satisfies ModelAssignPrefs));
    } catch {
      // Storage may be unavailable (private mode); assignment still works this session.
    }
  }, [assignMode, unifiedProfileId, randomPoolIds]);

  useEffect(() => {
    if (!open) return;
    setSeatPicks({});
    setSeatCharacters({});
    setRounds(scenario?.defaultRounds ?? Math.min(5, maxRounds));
    setPlayers(scenario?.players ?? 2);
    setMode("ai");
    setPlayerName("");
    setReasoningEffort("high");
    setSeasonMode("season");
    setError(undefined);
  }, [open, scenario, maxRounds]);

  // The character library is small; refresh it whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/characters")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("CHARACTERS_UNREACHABLE"))))
      .then((data: { builtins?: CharacterOption[]; customs?: CharacterOption[] }) => {
        if (cancelled) return;
        setCharacters([...(data.builtins ?? []), ...(data.customs ?? [])]);
      })
      .catch(() => {
        if (!cancelled) setCharacters([]);
      });
    fetch("/api/room-templates")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("TEMPLATES_UNREACHABLE"))))
      .then((data: { templates?: RosterTemplateOption[] }) => {
        if (cancelled) return;
        setTemplates((data.templates ?? []).filter((template) => template.scenarioId === scenario?.id));
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, scenario]);

  /** Unified pick falls back to the first registered model until the user chooses. */
  const unifiedId = profileById.has(unifiedProfileId) ? unifiedProfileId : eligibleModels[0]?.profileId ?? "";
  const poolIds = useMemo(() => {
    const known = randomPoolIds.filter((id) => profileById.has(id));
    return known.length ? known : eligibleModels.map((model) => model.profileId as string);
  }, [randomPoolIds, profileById, eligibleModels]);

  /** Balanced shuffle: cycle the shuffled pool so every model gets an even share. */
  const dealBalancedRoster = useCallback((pool: string[], seats: number): string[] => {
    const deck: string[] = [];
    while (deck.length < seats) {
      const round = [...pool];
      for (let i = round.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [round[i], round[j]] = [round[j], round[i]];
      }
      deck.push(...round);
    }
    return deck.slice(0, seats);
  }, []);

  const reshuffleRandom = useCallback(() => {
    if (!poolIds.length) return;
    setRandomRoster(dealBalancedRoster(poolIds, players));
  }, [poolIds, players, dealBalancedRoster]);

  // Keep the dealt roster consistent with the pool and the seat count: a stale
  // deal (players changed, pool member removed) is silently re-dealt.
  useEffect(() => {
    if (assignMode !== "random") return;
    const poolSet = new Set(poolIds);
    const valid = randomRoster.length === players && randomRoster.every((id) => poolSet.has(id));
    if (!valid) reshuffleRandom();
  }, [assignMode, players, poolIds, randomRoster, reshuffleRandom]);

  /** The full seat→profile table submitted to the server (length = seat count). */
  const rosterProfileIds = useMemo((): string[] => {
    if (!players) return [];
    if (assignMode === "per-seat") {
      return Array.from({ length: players }, (_, index) => seatPicks[String(index)] ?? unifiedId);
    }
    if (assignMode === "random" && randomRoster.length === players) return randomRoster;
    return Array.from({ length: players }, () => unifiedId);
  }, [assignMode, players, seatPicks, unifiedId, randomRoster]);

  /** Resolved display name for a seat's character (mirrors submit's characterIds). */
  const seatCharacterFor = (index: number): CharacterOption | undefined => {
    const pickedId = seatCharacters[String(index)] ?? characters[index]?.id;
    return characters.find((character) => character.id === pickedId);
  };

  const applyTemplate = (template: RosterTemplateOption): void => {
    setLoadedTemplateId(template.id);
    // Rebuild the assignment state from whatever the template recorded.
    const overrideEntries = Object.entries(template.agentModelOverrides ?? {}).filter(([, profileId]) => profileById.has(profileId));
    const templateProfiles = Array.from(new Set([
      ...(template.modelProfileIds ?? []).filter((id) => profileById.has(id)),
      ...overrideEntries.map(([, profileId]) => profileId)
    ]));
    if (overrideEntries.length) {
      setAssignMode("per-seat");
      setSeatPicks(Object.fromEntries(overrideEntries));
      setUnifiedProfileId(templateProfiles[0] ?? unifiedId);
    } else if (templateProfiles.length > 1) {
      setAssignMode("random");
      setRandomPoolIds(templateProfiles);
      setRandomRoster(dealBalancedRoster(templateProfiles, template.players ?? players));
    } else if (templateProfiles.length === 1) {
      setAssignMode("unified");
      setUnifiedProfileId(templateProfiles[0]);
    }
    if (template.players !== undefined) setPlayers(template.players);
    if (template.rounds !== undefined) setRounds(template.rounds);
    setReasoningEffort(template.reasoningEffort ?? "high");
    setSeasonMode(template.season ?? "season");
    if (characters.length && template.characterIds?.length) {
      const picks: Record<string, string> = {};
      template.characterIds.forEach((id, index) => {
        if (id !== characters[index]?.id) picks[String(index)] = id;
      });
      setSeatCharacters(picks);
    } else {
      setSeatCharacters({});
    }
    setError(undefined);
  };

  const saveTemplate = async (): Promise<void> => {
    const name = templateName.trim();
    if (!name) {
      setError("给模板起个名字。");
      return;
    }
    if (!scenario) return;
    if (!rosterProfileIds.length) {
      setError("还没有可用模型，无法保存模板。");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      // Legacy `models` keeps working for old clients; profile ids carry the real roster.
      const legacyModels = Array.from(new Set(rosterProfileIds.map((profileId) => profileById.get(profileId)?.id).filter((id): id is string => Boolean(id))));
      const response = await apiFetch("/api/room-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          scenarioId: scenario.id,
          models: legacyModels,
          modelProfileIds: Array.from(new Set(rosterProfileIds)),
          ...(assignMode === "per-seat"
            ? {
                agentModelOverrides: Object.fromEntries(
                  Object.entries(seatPicks).filter(([, profileId]) => profileById.has(profileId))
                )
              }
            : {}),
          ...(scenario.playerRange ? { players } : {}),
          ...(characters.length ? { characterIds: Array.from({ length: players }, (_, index) => seatCharacters[String(index)] ?? characters[index]?.id).filter((id): id is string => Boolean(id)) } : {}),
          rounds,
          reasoningEffort,
          season: seasonMode
        })
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
      setTemplates((current) => [{ ...payload, id: payload.id }, ...current.filter((template) => template.name !== name)]);
      setTemplateName("");
      setLoadedTemplateId(payload.id as string);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const deleteTemplate = async (id: string): Promise<void> => {
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await apiFetch(`/api/room-templates/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setTemplates((current) => current.filter((template) => template.id !== id));
      if (loadedTemplateId === id) setLoadedTemplateId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!scenario) return;
    if (!rosterProfileIds.length) {
      setError("还没有可用的模型档案：请先在「设置」中注册模型。");
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
        modelProfileIds: rosterProfileIds,
        rounds,
        ...(scenario.playerRange ? { players } : {}),
        ...(characters.length
          ? {
              characterIds: Array.from({ length: players }, (_, index) => seatCharacters[String(index)] ?? characters[index]?.id).filter((id): id is string => Boolean(id))
            }
          : {}),
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
          <div className="flex min-w-0 max-h-[82vh] flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
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
                <div className="mb-2.5 flex items-center justify-between">
                  <p className="text-[13px] font-medium text-foreground/80">模型分配</p>
                  <span className="nums font-mono text-xs text-muted-foreground/80">{eligibleModels.length} 个可用档案</span>
                </div>
                {eligibleModels.length ? (
                  <>
                    <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted p-1">
                      <ModeButton active={assignMode === "unified"} onClick={() => setAssignMode("unified")}>统一模型</ModeButton>
                      <ModeButton active={assignMode === "per-seat"} onClick={() => setAssignMode("per-seat")}>逐席配置</ModeButton>
                      <ModeButton active={assignMode === "random"} onClick={() => setAssignMode("random")}>随机混合</ModeButton>
                    </div>

                    {assignMode === "unified" ? (
                      <div data-model>
                        <Select value={unifiedId} onValueChange={(value) => setUnifiedProfileId(value)}>
                          <SelectTrigger className="h-9 w-full rounded-lg border-border bg-card text-foreground/90">
                            <SelectValue placeholder="选择模型" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {eligibleModels.map((model) => (
                                <SelectItem key={model.profileId} value={model.profileId!}>
                                  {model.name}{model.contextLabel ? ` · ${model.contextLabel}` : ""}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground/70">全部 {players} 个 AI 席位使用同一模型。</p>
                      </div>
                    ) : null}

                    {assignMode === "per-seat" ? (
                      <p className="text-xs leading-5 text-muted-foreground">在下方参与者列表中为每个席位单独挑选模型；未单独挑选的席位使用统一模型（当前 {profileById.get(unifiedId)?.name ?? "—"}）。可在下方预览改回。</p>
                    ) : null}

                    {assignMode === "random" ? (
                      <div data-model>
                        <p className="mb-1.5 text-xs text-muted-foreground">勾选参与随机的模型池（至少一个），按席位平衡洗牌；每个模型的出场次数最多相差一。</p>
                        <div className="flex flex-wrap gap-1.5">
                          {eligibleModels.map((model) => {
                            const active = poolIds.includes(model.profileId!);
                            return (
                              <button
                                key={model.profileId}
                                onClick={() => setRandomPoolIds((current) => {
                                  const known = current.filter((id) => profileById.has(id));
                                  const base = known.length ? known : eligibleModels.map((entry) => entry.profileId as string);
                                  return base.includes(model.profileId!) ? base.filter((id) => id !== model.profileId!) : [...base, model.profileId!];
                                })}
                                className={cn(
                                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                                  active ? "border-foreground/60 bg-muted text-foreground" : "border-border bg-card text-muted-foreground hover:border-foreground/30"
                                )}
                              >
                                <span className={cn("size-1.5 rounded-full", active ? "bg-emerald-400" : "bg-border")} />
                                <span className="max-w-52 truncate font-mono">{model.name}</span>
                              </button>
                            );
                          })}
                        </div>
                        <div className="mt-2.5 flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                            disabled={!poolIds.length}
                            onClick={reshuffleRandom}
                          >
                            <Shuffle className="size-3.5" />
                            重新随机
                          </Button>
                          <span className="text-[11px] text-muted-foreground/70">提交的就是下方预览的分配，不做服务端暗箱随机。</span>
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-3 rounded-lg border border-border bg-muted/60 px-3 py-2.5" data-roster-preview>
                      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">最终阵容预览</p>
                      <div className="space-y-1">
                        {Array.from({ length: players }).map((_, index) => {
                          const option = profileById.get(rosterProfileIds[index] ?? "");
                          const character = seatCharacterFor(index);
                          return (
                            <div key={index} className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                                <span className="flex size-4 shrink-0 items-center justify-center rounded bg-card font-mono text-[9px] ring-1 ring-border">
                                  {index + 1}
                                </span>
                                <span className="truncate">
                                  {mode === "human" && index === 0 ? (playerName.trim() || "你（人类玩家）") : character?.displayName ?? `第 ${index + 1} 位`}
                                </span>
                              </span>
                              <span className="shrink-0 font-mono text-muted-foreground/90">
                                {mode === "human" && index === 0 ? "真人玩家" : option?.name ?? "—"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="rounded-lg border border-dashed border-border p-3.5">
                    <p className="text-xs leading-5 text-muted-foreground">
                      还没有已注册的模型档案。请先打开右上角「设置」，在模型配置中心添加模型（支持从提供商一键拉取列表），再回来创建房间。
                    </p>
                  </div>
                )}
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
                  <Select value={reasoningEffort} onValueChange={(value) => setReasoningEffort(value as "low" | "medium" | "high" | "xhigh")}>
                    <SelectTrigger className="rounded-lg border-border bg-card text-foreground/90">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="low">轻量</SelectItem>
                        <SelectItem value="medium">标准</SelectItem>
                        <SelectItem value="high">深度</SelectItem>
                        <SelectItem value="xhigh">极限 · xhigh</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </section>

              {eligibleModels.length ? (
                <section>
                  <div className="mb-2.5 flex items-center justify-between">
                    <p className="text-[13px] font-medium text-foreground/80">参与者阵容</p>
                    <span className="text-[11px] text-muted-foreground/70">{assignMode === "per-seat" ? "逐席模式：每行可单独选模型" : "人物可选；模型按上方分配"}</span>
                  </div>
                  {characters.length ? (
                    <p className="mb-2 text-xs leading-5 text-muted-foreground/80">
                      为每个席位挑选人物（内置或自建）；{assignMode === "per-seat" ? "同时在每行右侧指定该席位的模型。" : "模型分配见上方「模型分配」与最终阵容预览。"}
                    </p>
                  ) : null}
                  <div className="rounded-lg border border-border bg-muted/60 p-3" data-model>
                    <div className="space-y-1.5">
                      {Array.from({ length: players }).map((_, index) => {
                        const isHuman = mode === "human" && index === 0;
                        const option = profileById.get(rosterProfileIds[index] ?? "");
                        const picked = seatPicks[String(index)];
                        return (
                          <div key={index} className="rounded-md px-1 py-0.5">
                            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
                              <span className="flex items-center gap-2 text-muted-foreground">
                                <span className="flex size-5 items-center justify-center rounded bg-card font-mono text-[9px] text-muted-foreground/80 ring-1 ring-border">
                                  {String(index + 1).padStart(2, "0")}
                                </span>
                                {isHuman ? (
                                  <span className="flex items-center gap-1.5">
                                    {playerName.trim() || "你"}
                                    <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1 text-[9px] text-amber-300">人类玩家</span>
                                  </span>
                                ) : characters.length ? (
                                  <Select
                                    value={seatCharacters[String(index)] ?? "__default"}
                                    onValueChange={(value) => {
                                      setSeatCharacters((current) => {
                                        const next = { ...current };
                                        if (value === "__default") delete next[String(index)];
                                        else next[String(index)] = value;
                                        return next;
                                      });
                                    }}
                                  >
                                    <SelectTrigger aria-label={`第 ${index + 1} 位参与者的人物`} className="h-7 w-44 justify-start rounded-md border-border bg-card text-[11px] text-foreground/80">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectGroup>
                                        <SelectItem value="__default">按顺序内置人物</SelectItem>
                                        {characters.map((character) => (
                                          <SelectItem key={character.id} value={character.id}>
                                            {character.displayName}{character.builtIn ? "" : " · 自建"}
                                          </SelectItem>
                                        ))}
                                      </SelectGroup>
                                    </SelectContent>
                                  </Select>
                                ) : (
                                  <span>第 {index + 1} 位参与者</span>
                                )}
                              </span>
                              {isHuman ? (
                                <span className="font-mono text-[11px] text-muted-foreground/60">本人操控</span>
                              ) : assignMode === "per-seat" ? (
                                <Select
                                  value={picked ?? unifiedId}
                                  onValueChange={(value) => {
                                    setSeatPicks((current) => {
                                      const next = { ...current };
                                      if (value === unifiedId) delete next[String(index)];
                                      else next[String(index)] = value;
                                      return next;
                                    });
                                  }}
                                >
                                  <SelectTrigger aria-label={`第 ${index + 1} 席位的模型`} className="h-7 w-56 justify-end rounded-md border-border bg-card font-mono text-[11px] text-muted-foreground">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      {eligibleModels.map((model) => (
                                        <SelectItem key={model.profileId} value={model.profileId!}>
                                          {model.name}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              ) : (
                                <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                                  {picked ? <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1 text-[9px] text-amber-300">指定</span> : null}
                                  {option?.contextLabel ? (
                                    <span className="rounded border border-border bg-card px-1 text-[9px] text-muted-foreground/80">{option.contextLabel}</span>
                                  ) : null}
                                  {option?.name ?? "—"}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {assignMode === "per-seat" ? (
                      <p className="mt-2 border-t border-border/60 pt-2 text-[11px] leading-4 text-muted-foreground/80">
                        每个参与者仍是一个独立 Agent：这里只决定每个席位的模型档案；人格、记忆与关系不变。想恢复某席位的统一模型，把它重新选成与上方一致即可。
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
                    description="角色带着过往对局的记忆、关系与恩怨入场，一局结束后继续积累。像一群越玩越熟的老友。"
                    hint={seasonCount > 0 ? `${seasonCount} 位角色已有历史` : "从零开始积累"}
                  />
                  <SeasonModeCard
                    active={seasonMode === "one-shot"}
                    onClick={() => setSeasonMode("one-shot")}
                    title="单局模式"
                    description="本局完全隔离，不读取任何历史，结束后也不留下任何记忆。适合一局定胜负、零干扰对决。"
                    hint="无历史、无残留"
                  />
                </div>
                {seasonMode === "season" && seasonCount > 0 ? (
                  <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                    <History className="mt-0.5 size-3.5 shrink-0" />
                    社会季进行中：{seasonCount} 位角色会带着历史入场。想让他们互不相识，请先在首页「重置社会季」，或改用单局模式。
                  </p>
                ) : null}
                {seasonMode === "one-shot" ? (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    不读取、也不写入社会季：身份随机、记忆归零，连角色关系都从陌生人开始。
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

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[13px] font-medium text-foreground/80">阵容模板</p>
                  {loadedTemplateId ? (
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-red-400"
                      disabled={submitting}
                      onClick={() => void deleteTemplate(loadedTemplateId)}
                    >
                      <Trash2 className="size-3" />
                      删除当前模板
                    </button>
                  ) : null}
                </div>
                <p className="mb-2.5 text-xs leading-5 text-muted-foreground/80">
                  把当前配置（模型分配、人物、回合数、社会季模式）存为模板，一键复用。模板按世界保存，只存本机，不含任何密钥。
                </p>
                <div className="space-y-2">
                  {templates.length ? (
                    <Select
                      value={loadedTemplateId ?? "__none"}
                      onValueChange={(value) => {
                        if (value === "__none") return;
                        const template = templates.find((entry) => entry.id === value);
                        if (template) applyTemplate(template);
                      }}
                    >
                      <SelectTrigger className="h-9 w-full rounded-lg border-border bg-card text-foreground/90">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="__none" disabled>{loadedTemplateId ? `已载入：${templates.find((entry) => entry.id === loadedTemplateId)?.name ?? ""}` : "载入模板…"}</SelectItem>
                          {templates.map((template) => (
                            <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <input
                      value={templateName}
                      onChange={(event) => setTemplateName(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") void saveTemplate(); }}
                      placeholder="模板名称（如：狼人杀快局）"
                      maxLength={40}
                      className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none"
                    />
                    <Button variant="outline" size="sm" className="h-9 shrink-0 rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" disabled={submitting} onClick={() => void saveTemplate()}>
                      保存为模板
                    </Button>
                  </div>
                </div>
              </section>
            </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-border/60 bg-card px-6 py-4">
              <Button variant="outline" className="rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" disabled={submitting} onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                onClick={submit}
                disabled={submitting || !eligibleModels.length}
                className="rounded-lg bg-foreground px-6 text-background hover:bg-foreground/85"
              >
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                开始世界
              </Button>
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
      aria-pressed={active}
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
