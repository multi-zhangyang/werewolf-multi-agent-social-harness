import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { ArrowLeft, Play, Settings2, Trash2 } from "lucide-react";
import type { ScenarioSummary } from "@/society/contracts";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator
} from "@/components/ui/breadcrumb";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ErrorNote, ScenarioIcon } from "../shared";
import type { CharacterOption, CreateRoomInput, ModelOption } from "../types";
import { ModelAssignSection } from "./model-assign-section";
import { RosterSection } from "./roster-section";
import { MODEL_PREFS_KEY, type ModelAssignMode, type ModelAssignPrefs, type RosterPreviewRow, type RosterTemplateOption } from "./types";

interface CreateRoomProps {
  scenario: ScenarioSummary | undefined;
  scenarios: ScenarioSummary[];
  models: ModelOption[];
  /** Registry-configured default pool for 随机混合, used before the user picks one. */
  defaultPoolProfileIds?: string[];
  onScenarioChange: (scenarioId: string) => void;
  onBack: () => void;
  onOpenSettings: () => void;
  onCreated: (input: CreateRoomInput) => Promise<{ roomId: string }>;
}

export function CreateRoomPage({ scenario, scenarios, models, defaultPoolProfileIds, onScenarioChange, onBack, onOpenSettings, onCreated }: CreateRoomProps): ReactNode {
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
  /** Explicit opt-in: write the finished game to a local archive file. */
  const [archive, setArchive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  /** Character library: built-ins + user-defined characters. */
  const [characters, setCharacters] = useState<CharacterOption[]>([]);
  /** Per-seat character picks (absent = the seat's default built-in). */
  const [seatCharacters, setSeatCharacters] = useState<Record<string, string>>({});
  /** Saved roster templates for this world. */
  const [templates, setTemplates] = useState<RosterTemplateOption[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [loadedTemplateId, setLoadedTemplateId] = useState<string>();
  const [pendingTemplateRemoval, setPendingTemplateRemoval] = useState<string>();
  /** Visible instead of silent: the library fetch failing must not masquerade as an empty library. */
  const [libraryError, setLibraryError] = useState<string>();

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
    setSeatPicks({});
    setSeatCharacters({});
    setRounds(scenario?.defaultRounds ?? Math.min(5, maxRounds));
    setPlayers(scenario?.players ?? 2);
    setMode("ai");
    setPlayerName("");
    setReasoningEffort("high");
    setError(undefined);
  }, [scenario, maxRounds]);

  // The character library is small; refresh it when the selected world changes.
  useEffect(() => {
    let cancelled = false;
    setLibraryError(undefined);
    fetch("/api/characters")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("CHARACTERS_UNREACHABLE"))))
      .then((data: { builtins?: CharacterOption[]; customs?: CharacterOption[] }) => {
        if (cancelled) return;
        setCharacters([...(data.builtins ?? []), ...(data.customs ?? [])]);
      })
      .catch(() => {
        if (!cancelled) {
          setCharacters([]);
          setLibraryError("人物库暂不可达——已回退到内置人物顺序，刷新本页后可重试。");
        }
      });
    fetch("/api/room-templates")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("TEMPLATES_UNREACHABLE"))))
      .then((data: { templates?: RosterTemplateOption[] }) => {
        if (cancelled) return;
        setTemplates((data.templates ?? []).filter((template) => template.scenarioId === scenario?.id));
      })
      .catch(() => {
        if (!cancelled) {
          setTemplates([]);
          setLibraryError((current) => current ? `${current} 阵容模板也暂不可达。` : "阵容模板暂不可达——模板列表已置空。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scenario]);

  /** Unified pick falls back to the first registered model until the user chooses. */
  const unifiedId = profileById.has(unifiedProfileId) ? unifiedProfileId : eligibleModels[0]?.profileId ?? "";
  const poolIds = useMemo(() => {
    const known = randomPoolIds.filter((id) => profileById.has(id));
    if (known.length) return known;
    // No saved preference: the registry-configured default pool (model
    // center 全局默认) comes next, then every eligible model.
    const configured = (defaultPoolProfileIds ?? []).filter((id) => profileById.has(id));
    return configured.length ? configured : eligibleModels.map((model) => model.profileId as string);
  }, [randomPoolIds, profileById, eligibleModels, defaultPoolProfileIds]);

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
      setError("还没有可用的模型档案：请先在「设置」中启用模型并通过 Agents SDK 协议检查。");
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
        ...(archive ? { archive: true } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  /** The seat table shown under 模型分配 — what you see is what is submitted. */
  const previewRows: RosterPreviewRow[] = Array.from({ length: players }, (_, index) => {
    const option = profileById.get(rosterProfileIds[index] ?? "");
    const character = seatCharacterFor(index);
    return {
      index,
      characterLabel: mode === "human" && index === 0
        ? (playerName.trim() || "你（人类玩家）")
        : character?.displayName ?? `第 ${index + 1} 位`,
      modelLabel: mode === "human" && index === 0 ? "真人玩家" : option?.name ?? "—"
    };
  });

  const rosterModelFor = (index: number): { name?: string; contextLabel?: string; picked: boolean } => {
    const option = profileById.get(rosterProfileIds[index] ?? "");
    return { name: option?.name, contextLabel: option?.contextLabel, picked: Boolean(seatPicks[String(index)]) };
  };

  return (
    <>
      <div className="min-h-screen bg-background text-foreground">
        <header className="rule-b sticky top-0 z-20 bg-background/90 backdrop-blur">
          <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
            <Button variant="ghost" size="icon-sm" aria-label="返回大厅" onClick={onBack}><ArrowLeft /></Button>
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem><BreadcrumbLink asChild><Button variant="link" className="h-auto p-0" onClick={onBack}>大厅</Button></BreadcrumbLink></BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem><BreadcrumbPage>创建世界</BreadcrumbPage></BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <Button variant="outline" size="sm" className="ml-auto" onClick={onOpenSettings}><Settings2 />模型设置</Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
        {scenario ? (
          <div className="flex min-w-0 flex-col gap-6">
            <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-foreground/80">
                    <ScenarioIcon id={scenario.id} className="size-5" />
                  </span>
                  <div>
                    <h1 className="text-2xl font-semibold tracking-tight">创建「{scenario.name}」</h1>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{scenario.description}</p>
                  </div>
                </div>
                <Select value={scenario.id} onValueChange={onScenarioChange}>
                  <SelectTrigger className="w-full" aria-label="切换场景"><SelectValue /></SelectTrigger>
                  <SelectContent>{scenarios.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="rounded-full border-border bg-muted font-normal text-muted-foreground">
                    {scenario.playerRange ? `${scenario.playerRange.min}-${scenario.playerRange.max} 名参与者` : `${scenario.players} 名参与者`}
                  </Badge>
                  <Badge variant="outline" className="rounded-full border-border bg-muted font-normal text-muted-foreground">{scenario.minRounds}–{scenario.maxRounds} 轮</Badge>
                  {scenario.capabilities.slice(0, 3).map((capability) => (
                    <Badge key={capability} variant="outline" className="rounded-full border-border bg-card font-normal text-muted-foreground">{capability}</Badge>
                  ))}
              </div>
            </div>

            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex flex-col gap-6 rounded-xl border border-border bg-card p-5 sm:p-6">
              {eligibleModels.length ? (
                <ModelAssignSection
                  assignMode={assignMode}
                  onAssignModeChange={setAssignMode}
                  eligibleModels={eligibleModels}
                  unifiedId={unifiedId}
                  onUnifiedIdChange={setUnifiedProfileId}
                  unifiedName={profileById.get(unifiedId)?.name ?? "—"}
                  players={players}
                  poolIds={poolIds}
                  onTogglePoolModel={(profileId) => setRandomPoolIds((current) => {
                    const known = current.filter((id) => profileById.has(id));
                    const base = known.length ? known : eligibleModels.map((entry) => entry.profileId as string);
                    return base.includes(profileId) ? base.filter((id) => id !== profileId) : [...base, profileId];
                  })}
                  onReshuffle={reshuffleRandom}
                  previewRows={previewRows}
                />
              ) : (
                <section>
                  <div className="mb-2.5 flex items-center justify-between">
                    <p className="text-sm font-medium text-foreground/80">模型分配</p>
                    <span className="nums font-mono text-xs text-muted-foreground">0 个可用档案</span>
                  </div>
                  <div className="rounded-lg border border-dashed border-border p-3.5">
                    <p className="text-xs leading-5 text-muted-foreground">
                      没有“已启用且协议检查通过”的模型。请先打开右上角「设置」，对模型执行真实 Agents SDK 协议检查，再回来创建房间。
                    </p>
                  </div>
                </section>
              )}

              {scenario.playerRange ? (
                <section>
                  <div className="mb-2.5 flex items-center justify-between">
                    <p className="text-sm font-medium text-foreground/80">人数</p>
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
                  <div className="nums mt-1 flex justify-between font-mono text-xs text-muted-foreground">
                    <span>{scenario.playerRange.min} 人</span>
                    <span>{scenario.playerRange.max} 人</span>
                  </div>
                  {scenario.id === "werewolf" ? (
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">按官方板子组牌：6–12 人各有对应牌组（狼人·狼王·预言家·女巫·猎人·守卫·小丑·村民），人数越多角色越复杂。</p>
                  ) : null}
                  {scenario.id === "avalon" ? (
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">按官方规则配置：5-10 人的忠臣/内奸比例与任务人数遵循阿瓦隆说明书（7 人及以上第四任务需要两张失败票）。</p>
                  ) : null}
                </section>
              ) : null}

              <section>
                <div className="mb-2.5 flex items-center justify-between">
                  <p className="text-sm font-medium text-foreground/80">回合数</p>
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
                <div className="nums mt-1 flex justify-between font-mono text-xs text-muted-foreground">
                  <span>{minRounds}</span>
                  <span>{maxRounds}</span>
                </div>
              </section>

              <section className="grid grid-cols-2 gap-4">
                <div>
                  <p className="mb-2.5 text-sm font-medium text-foreground/80">参与者</p>
                  <ToggleGroup
                    type="single"
                    value={mode}
                    onValueChange={(value) => { if (value) setMode(value as "ai" | "human"); }}
                    spacing={1}
                    className="grid w-full grid-cols-2 rounded-lg border border-border bg-muted p-1"
                    aria-label="参与方式"
                  >
                    <ToggleGroupItem value="ai" className="h-8 rounded-md text-sm">全 AI</ToggleGroupItem>
                    <ToggleGroupItem value="human" className="h-8 rounded-md text-sm">真人加入</ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <div>
                  <p className="mb-2.5 text-sm font-medium text-foreground/80">推理强度</p>
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

              <section className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3.5 py-3">
                <Checkbox id="archive-room" aria-label="保存对局" checked={archive} onCheckedChange={(checked) => setArchive(checked === true)} />
                <label htmlFor="archive-room" className="min-w-0 flex-1 cursor-pointer">
                  <span className="block text-sm font-medium text-foreground/80">保存对局（赛后存档）</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    对局结束后写入本地 data/archives，重启后仍可复盘。默认关闭——保持零落盘。
                  </span>
                </label>
              </section>

              {eligibleModels.length ? (
                <RosterSection
                  players={players}
                  mode={mode}
                  playerName={playerName}
                  characters={characters}
                  seatCharacters={seatCharacters}
                  onSeatCharacterChange={(seat, characterId) => setSeatCharacters((current) => {
                    const next = { ...current };
                    if (characterId) next[String(seat)] = characterId;
                    else delete next[String(seat)];
                    return next;
                  })}
                  assignMode={assignMode}
                  seatPicks={seatPicks}
                  onSeatPicksChange={(seat, profileId) => setSeatPicks((current) => {
                    const next = { ...current };
                    if (profileId) next[String(seat)] = profileId;
                    else delete next[String(seat)];
                    return next;
                  })}
                  unifiedId={unifiedId}
                  eligibleModels={eligibleModels}
                  rosterModelFor={rosterModelFor}
                />
              ) : null}


              {mode === "human" ? (
                <section>
                  <p className="mb-2.5 text-sm font-medium text-foreground/80">你的名字</p>
                  <Input
                    value={playerName}
                    onChange={(event) => setPlayerName(event.target.value)}
                    placeholder="作为第 1 位参与者加入"
                    maxLength={40}
                    className="h-10 bg-card"
                  />
                </section>
              ) : null}

              {error ? <ErrorNote>{error}</ErrorNote> : null}
              {libraryError ? <p className="flex items-start gap-1.5 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm leading-5 text-warn">{libraryError}</p> : null}

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium text-foreground/80">阵容模板</p>
                  {loadedTemplateId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      className="h-auto gap-1 p-0 text-xs text-muted-foreground hover:bg-transparent hover:text-destructive"
                      disabled={submitting}
                      onClick={() => setPendingTemplateRemoval(loadedTemplateId)}
                    >
                      <Trash2 className="size-3" />
                      删除当前模板
                    </Button>
                  ) : null}
                </div>
                <p className="mb-2.5 text-xs leading-5 text-muted-foreground">
                  把当前配置（模型分配、人物、回合数、社会季模式）存为模板，一键复用。模板按世界保存，只存本机，不含任何密钥。
                </p>
                <div className="flex flex-col gap-2">
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
                    <Input
                      value={templateName}
                      onChange={(event) => setTemplateName(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") void saveTemplate(); }}
                      placeholder="模板名称（如：狼人杀快局）"
                      maxLength={40}
                      className="h-9 min-w-0 flex-1 bg-card"
                    />
                    <Button variant="tile" size="sm" className="h-9 shrink-0" disabled={submitting} onClick={() => void saveTemplate()}>
                      保存为模板
                    </Button>
                  </div>
                </div>
              </section>
            </div>
            <aside className="sticky top-24 hidden rounded-xl border border-border bg-card p-5 lg:block" aria-label="最终阵容摘要">
              <h2 className="text-lg font-semibold">最终阵容</h2>
              <p className="mt-1 text-sm text-muted-foreground">提交前确认席位、回合与本机落盘选项。</p>
              <div className="mt-5 flex flex-col gap-3">
                {previewRows.map((row) => (
                  <div key={row.index} className="flex items-start justify-between gap-3 border-b border-border/60 pb-3 text-sm last:border-0 last:pb-0">
                    <span className="min-w-0"><span className="block truncate font-medium">{row.characterLabel}</span><span className="block truncate text-xs text-muted-foreground">{row.modelLabel}</span></span>
                    <Badge variant="outline">{row.index + 1}</Badge>
                  </div>
                ))}
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg border border-border bg-muted/30 p-3"><p className="text-xs text-muted-foreground">回合</p><p className="mt-1 text-base font-semibold">{rounds}</p></div>
                <div className="rounded-lg border border-border bg-muted/30 p-3"><p className="text-xs text-muted-foreground">归档</p><p className="mt-1 text-base font-semibold">{archive ? "保存" : "不保存"}</p></div>
              </div>
            </aside>
            </div>

            <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-xl border border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
              <p className="hidden text-xs text-muted-foreground sm:block">{players} 名参与者 · {rounds} 回合 · {archive ? "赛后保存" : "不落盘"}</p>
              <Button variant="tile" className="ml-auto" disabled={submitting} onClick={onBack}>
                返回大厅
              </Button>
              <Button onClick={submit} disabled={submitting || !eligibleModels.length} className="rounded-lg px-6">
                {submitting ? <Spinner className="size-4" /> : <Play className="size-4" />}
                开始世界
              </Button>
            </div>
          </div>
        ) : null}
        </main>
      </div>
      <AlertDialog open={pendingTemplateRemoval !== undefined} onOpenChange={(next) => { if (!next) setPendingTemplateRemoval(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除当前阵容模板？</AlertDialogTitle>
            <AlertDialogDescription>只删除本机保存的创建配置，不影响已创建或已归档的房间。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!pendingTemplateRemoval) return;
                void deleteTemplate(pendingTemplateRemoval).finally(() => setPendingTemplateRemoval(undefined));
              }}
            >
              删除模板
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
