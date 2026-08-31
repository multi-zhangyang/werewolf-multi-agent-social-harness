/**
 * Character library: built-in characters and user-defined
 * ones — create, edit, copy, delete, import/export. A character here is a
 * person (persona, values, biases, voice, formative memories); roles, models
 * and controllers stay separate. Secrets never enter this store.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { ArrowLeft, Copy, Download, Pencil, Plus, Search, Trash2, Upload, Users } from "lucide-react";
import type { CharacterDefinition, DecisionBias } from "@/society/contracts";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field as FormField, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { AgentAvatar, ErrorNote } from "./shared";

interface CharactersDialogProps {
  onBack: () => void;
  onChanged: () => void;
}

const BIASES: Array<{ id: DecisionBias; label: string }> = [
  { id: "confirmation", label: "确认偏误" },
  { id: "loss-aversion", label: "损失厌恶" },
  { id: "sunk-cost", label: "沉没成本" },
  { id: "in-group", label: "圈内偏好" },
  { id: "authority-sensitivity", label: "权威敏感" },
  { id: "betrayal-hypervigilance", label: "背叛警觉" },
  { id: "overconfident-lie-detection", label: "自信识谎" },
  { id: "self-consistency", label: "立场一贯" },
  { id: "recency-weighting", label: "近期加权" }
];

const TRAITS = [
  { key: "openness", label: "开放性" },
  { key: "conscientiousness", label: "尽责性" },
  { key: "extraversion", label: "外向性" },
  { key: "agreeableness", label: "宜人性" },
  { key: "neuroticism", label: "神经质" }
] as const;

const REGULATIONS = [
  { value: "reappraise", label: "重新评价（把坏事想开）" },
  { value: "suppress", label: "压抑（不动声色，耗能）" },
  { value: "ruminate", label: "反刍（反复咀嚼，记仇）" },
  { value: "act-out", label: "外化（先发作再想后果）" },
  { value: "repair", label: "修复（先低头修补关系）" }
] as const;

interface Draft {
  displayName: string;
  persona: string;
  traits: string;
  values: string;
  goals: string;
  voice: string;
  regulation: "" | (typeof REGULATIONS)[number]["value"];
  biases: DecisionBias[];
  temperament: { openness: number; conscientiousness: number; extraversion: number; agreeableness: number; neuroticism: number };
  anchors: string;
}

const EMPTY_DRAFT: Draft = {
  displayName: "",
  persona: "",
  traits: "",
  values: "",
  goals: "",
  voice: "",
  regulation: "",
  biases: [],
  temperament: { openness: 0.6, conscientiousness: 0.6, extraversion: 0.5, agreeableness: 0.6, neuroticism: 0.4 },
  anchors: ""
};

function draftFrom(character: CharacterDefinition): Draft {
  return {
    displayName: character.displayName,
    persona: character.persona,
    traits: character.traits.join("、"),
    values: character.values.join("、"),
    goals: character.goals.join("、"),
    voice: character.voice ?? "",
    regulation: character.regulation ?? "",
    biases: [...(character.decisionBiases ?? [])],
    temperament: { ...(character.temperament ?? EMPTY_DRAFT.temperament) },
    anchors: (character.autobiographicalAnchors ?? []).join("\n")
  };
}

export function CharactersPage({ onBack, onChanged }: CharactersDialogProps): ReactNode {
  const [builtins, setBuiltins] = useState<CharacterDefinition[]>([]);
  const [customs, setCustoms] = useState<CharacterDefinition[]>([]);
  const [editing, setEditing] = useState<CharacterDefinition | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<CharacterDefinition>();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = async (): Promise<void> => {
    const response = await fetch("/api/characters");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { builtins: CharacterDefinition[]; customs: CharacterDefinition[] };
    setBuiltins(data.builtins ?? []);
    setCustoms(data.customs ?? []);
  };

  useEffect(() => {
    setEditing(null);
    setError(undefined);
    setQuery("");
    void reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const matches = (character: CharacterDefinition): boolean => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return character.displayName.toLowerCase().includes(needle) || character.persona.toLowerCase().includes(needle);
  };
  const shownBuiltins = builtins.filter(matches);
  const shownCustoms = customs.filter(matches);

  const mutate = async (path: string, method: string, body?: unknown): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await apiFetch(path, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
      await reload();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const removeCharacter = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await mutate(`/api/characters/${id}`, "DELETE");
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { characters?: Draft[] };
      const characters = Array.isArray(parsed?.characters) ? parsed.characters : [];
      if (!characters.length) throw new Error("文件中没有 characters 数组。");
      const response = await apiFetch("/api/characters/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characters })
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
      await reload();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="min-h-screen bg-background text-foreground">
        <header className="rule-b sticky top-0 z-20 bg-background/90 backdrop-blur">
          <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
            <Button variant="ghost" size="icon-sm" aria-label="返回大厅" onClick={onBack}><ArrowLeft /></Button>
            <Breadcrumb><BreadcrumbList><BreadcrumbItem><BreadcrumbLink asChild><Button variant="link" className="h-auto p-0" onClick={onBack}>大厅</Button></BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><BreadcrumbPage>人物库</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
          <div className="overflow-hidden rounded-xl border border-border bg-card">
        {editing === null ? (
          <>
            <div className="flex flex-col gap-3 border-b border-border/60 p-6 pb-4 text-left">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">人物库</h1>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    人物是持续的人格——与游戏角色、模型和控制方式分开。自建人物保存在本机，可导入导出；内置人物可以复制后修改。
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Input
                    ref={fileRef}
                    type="file"
                    accept="application/json"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importFile(file);
                      event.target.value = "";
                    }}
                  />
                  <Button variant="tile" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                    <Upload className="size-3.5" />
                    导入
                  </Button>
                  <Button variant="tile" size="sm" asChild>
                    <a href="/api/characters/export" download>
                      <Download className="size-3.5" />
                      导出
                    </a>
                  </Button>
                  <Button size="sm" className="rounded-lg px-3" onClick={() => setEditing("new")}>
                    <Plus className="size-3.5" />
                    新建人物
                  </Button>
                </div>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground/60" aria-hidden />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="按名字或人物底色搜索…"
                  className="h-9 bg-card pl-8"
                  aria-label="搜索人物"
                />
              </div>
            </div>
            <ScrollArea className="scroll-fade-y-lg max-h-[62vh]">
              <div className="flex flex-col gap-5 p-6 pb-12">
                {error ? <ErrorNote>{error}</ErrorNote> : null}
                <section>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">内置人物 · {shownBuiltins.length}</p>
                  {shownBuiltins.length ? (
                    <CharacterCollection
                      characters={shownBuiltins}
                      busy={busy}
                      onCopy={(character) => void mutate(`/api/characters/${character.id}/copy`, "POST")}
                    />
                  ) : (
                    <p className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">没有匹配「{query.trim()}」的内置人物。</p>
                  )}
                </section>
                <section>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">自建人物 · {shownCustoms.length}</p>
                  {shownCustoms.length === 0 ? (
                    <Empty className="rounded-lg border border-dashed py-8">
                      <EmptyHeader>
                        <EmptyTitle>{query.trim() ? "没有匹配的自建人物" : "还没有自建人物"}</EmptyTitle>
                        <EmptyDescription>「新建人物」从头写一个，或复制内置人物再修改。</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <CharacterCollection
                      characters={shownCustoms}
                      busy={busy}
                      onCopy={(character) => void mutate(`/api/characters/${character.id}/copy`, "POST")}
                      onEdit={setEditing}
                      onDelete={setPendingRemoval}
                    />
                  )}
                </section>
              </div>
            </ScrollArea>
          </>
        ) : (
          <EditorForm
            editing={editing}
            builtins={builtins}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              onChanged();
            }}
          />
        )}
          </div>
        </main>
      </div>
      <AlertDialog open={pendingRemoval !== undefined} onOpenChange={(next) => { if (!next) setPendingRemoval(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{pendingRemoval?.displayName}」？</AlertDialogTitle>
            <AlertDialogDescription>人物会从本机人物库移除，历史对局不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!pendingRemoval) return;
                void removeCharacter(pendingRemoval.id).finally(() => setPendingRemoval(undefined));
              }}
            >
              删除人物
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CharacterCollection({ characters, busy, onCopy, onEdit, onDelete }: {
  characters: CharacterDefinition[];
  busy: boolean;
  onCopy: (character: CharacterDefinition) => void;
  onEdit?: (character: CharacterDefinition) => void;
  onDelete?: (character: CharacterDefinition) => void;
}): ReactNode {
  return (
    <>
      <div className="grid grid-cols-1 gap-2 md:hidden">
        {characters.map((character) => (
          <CharacterRow
            key={character.id}
            character={character}
            onCopy={() => onCopy(character)}
            onEdit={onEdit ? () => onEdit(character) : undefined}
            onDelete={onDelete ? () => onDelete(character) : undefined}
            busy={busy}
          />
        ))}
      </div>
      <div className="hidden overflow-hidden rounded-lg border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-52">人物</TableHead>
              <TableHead>人物底色</TableHead>
              <TableHead className="w-24">类型</TableHead>
              <TableHead className="w-32 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {characters.map((character) => (
              <TableRow key={character.id}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <AgentAvatar name={character.displayName} seed={character.id} size="sm" />
                    <span className="truncate font-medium">{character.displayName}</span>
                  </div>
                </TableCell>
                <TableCell className="max-w-0 whitespace-normal text-muted-foreground">
                  <p className="line-clamp-2 leading-5" title={character.persona}>{character.persona}</p>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="rounded-full font-normal">
                    {character.builtIn ? "内置" : "自建"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-xs" type="button" aria-label={`复制 ${character.displayName}`} title="复制后修改" disabled={busy} onClick={() => onCopy(character)}>
                      <Copy className="size-3.5" />
                    </Button>
                    {onEdit ? (
                      <Button variant="ghost" size="icon-xs" type="button" aria-label={`编辑 ${character.displayName}`} onClick={() => onEdit(character)}>
                        <Pencil className="size-3.5" />
                      </Button>
                    ) : null}
                    {onDelete ? (
                      <Button variant="ghost" size="icon-xs" type="button" aria-label={`删除 ${character.displayName}`} className="hover:text-destructive" disabled={busy} onClick={() => onDelete(character)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function CharacterRow({ character, onCopy, onEdit, onDelete, busy }: {
  character: CharacterDefinition;
  onCopy: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 transition-colors hover:border-border/80">
      <AgentAvatar name={character.displayName} seed={character.id} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-semibold tracking-tight">{character.displayName}</p>
          {!character.builtIn ? <Badge variant="outline" className="shrink-0 rounded-full border-secret/40 font-normal text-secret">自建</Badge> : null}
        </div>
        <p className="mt-1 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground" title={character.persona}>{character.persona}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon-xs" type="button" aria-label={`复制 ${character.displayName}`} title="复制后修改" className="text-muted-foreground hover:bg-border hover:text-foreground" disabled={busy} onClick={onCopy}>
          <Copy className="size-3.5" />
        </Button>
        {onEdit ? (
          <Button variant="ghost" size="icon-xs" type="button" aria-label={`编辑 ${character.displayName}`} className="text-muted-foreground hover:bg-border hover:text-foreground" onClick={onEdit}>
            <Pencil className="size-3.5" />
          </Button>
        ) : null}
        {onDelete ? (
          <Button variant="ghost" size="icon-xs" type="button" aria-label={`删除 ${character.displayName}`} className="text-muted-foreground hover:bg-border hover:text-destructive" disabled={busy} onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function EditorForm({ editing, builtins, onClose, onSaved }: {
  editing: CharacterDefinition | "new";
  builtins: CharacterDefinition[];
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const isNew = editing === "new";
  const base = isNew ? EMPTY_DRAFT : draftFrom(editing);
  const [draft, setDraft] = useState<Draft>(base);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const nameTaken = useMemo(() => builtins.some((entry) => entry.displayName === draft.displayName.trim()), [builtins, draft.displayName]);

  const set = (patch: Partial<Draft>): void => setDraft((current) => ({ ...current, ...patch }));
  const split = (value: string): string[] => value.split(/[、,，\n]/).map((entry) => entry.trim()).filter(Boolean).slice(0, 10);

  const save = async (): Promise<void> => {
    if (!draft.displayName.trim()) { setError("需要一个名字。"); return; }
    if (draft.persona.trim().length < 4) { setError("人物底色至少写 4 个字。"); return; }
    if (nameTaken) { setError("名字与内置人物重复，换一个。"); return; }
    setBusy(true);
    setError(undefined);
    try {
      const body = {
        displayName: draft.displayName.trim(),
        persona: draft.persona.trim(),
        traits: split(draft.traits),
        values: split(draft.values),
        goals: split(draft.goals),
        ...(draft.voice.trim() ? { voice: draft.voice.trim() } : {}),
        ...(draft.regulation ? { regulation: draft.regulation } : {}),
        ...(draft.biases.length ? { decisionBiases: draft.biases } : {}),
        temperament: draft.temperament,
        ...(split(draft.anchors).length ? { autobiographicalAnchors: split(draft.anchors) } : {})
      };
      const response = await apiFetch(isNew ? "/api/characters" : `/api/characters/${editing.id}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="border-b border-border/60 p-6 text-left">
        <h2 className="text-lg font-semibold tracking-tight">{isNew ? "新建人物" : `编辑 ${editing.displayName}`}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          人物是谁、为什么这样反应、怎么说话——与角色、模型无关。留空的自传记忆不会生成。
        </p>
      </div>
      <ScrollArea className="scroll-fade-y max-h-[68vh]">
        <div className="flex flex-col gap-5 p-6 pb-10">
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <FieldGroup className="gap-3">
            <FormField>
              <FieldLabel>名字</FieldLabel>
              <Input value={draft.displayName} onChange={(event) => set({ displayName: event.target.value })} placeholder="如 林默" maxLength={24} />
              {nameTaken ? <p className="text-xs text-warn">与内置人物重名，历史与关系会按名字混在一起——换一个。</p> : null}
            </FormField>
            <FormField>
              <FieldLabel>人物底色（一段话）</FieldLabel>
              <Textarea
                value={draft.persona}
                onChange={(event) => set({ persona: event.target.value })}
                placeholder="谨慎、克制，先建立可靠预测再下注……"
                rows={2}
                maxLength={400}
                className="bg-card"
              />
            </FormField>
            <FormField>
              <FieldLabel>性格标签（顿号分隔）</FieldLabel>
              <Input value={draft.traits} onChange={(event) => set({ traits: event.target.value })} placeholder="谨慎、耐心、重视一致性" />
            </FormField>
            <FormField>
              <FieldLabel>价值观（顿号分隔）</FieldLabel>
              <Input value={draft.values} onChange={(event) => set({ values: event.target.value })} placeholder="互惠、自主、长期安全" />
            </FormField>
            <FormField>
              <FieldLabel>目标（顿号分隔）</FieldLabel>
              <Input value={draft.goals} onChange={(event) => set({ goals: event.target.value })} placeholder="识别他人的真实动机、保持主动" />
            </FormField>
            <FormField>
              <FieldLabel>说话口吻</FieldLabel>
              <Input value={draft.voice} onChange={(event) => set({ voice: event.target.value })} placeholder="短句为主，常用「让我把账算清楚」" />
            </FormField>
          </FieldGroup>

          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">稳定认知倾向（0–3 个）</p>
            <div className="flex flex-wrap gap-1.5">
              {BIASES.map((bias) => {
                const active = draft.biases.includes(bias.id);
                return (
                  <Toggle
                    key={bias.id}
                    type="button"
                    pressed={active}
                    onPressedChange={() => set({ biases: active ? draft.biases.filter((entry) => entry !== bias.id) : [...draft.biases, bias.id].slice(0, 3) })}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      active ? "border-foreground/60 bg-muted text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {bias.label}
                  </Toggle>
                );
              })}
            </div>
          </section>

          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">大五人格（0–1）</p>
            <div className="flex flex-col gap-2.5">
              {TRAITS.map((trait) => (
                <div key={trait.key} className="flex items-center gap-3">
                  <span className="w-14 shrink-0 text-xs text-muted-foreground">{trait.label}</span>
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={[draft.temperament[trait.key]]}
                    onValueChange={([value]) => set({ temperament: { ...draft.temperament, [trait.key]: value ?? draft.temperament[trait.key] } })}
                    className="flex-1"
                    aria-label={trait.label}
                  />
                  <span className="nums w-8 shrink-0 text-right font-mono text-xs text-muted-foreground">{draft.temperament[trait.key].toFixed(2)}</span>
                </div>
              ))}
            </div>
          </section>

          <FieldGroup className="gap-3">
            <FormField>
              <FieldLabel>情绪调节方式</FieldLabel>
              <Select value={draft.regulation || "__none"} onValueChange={(value) => set({ regulation: value === "__none" ? "" : value as Draft["regulation"] })}>
                <SelectTrigger className="rounded-lg border-border bg-card text-foreground/90">
                  <SelectValue placeholder="不指定" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">不指定</SelectItem>
                  {REGULATIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField>
              <FieldLabel>自传记忆（每行一条，塑造本能的经历）</FieldLabel>
              <Textarea
                value={draft.anchors}
                onChange={(event) => set({ anchors: event.target.value })}
                placeholder={"小时候替朋友担保被连累，从此先看清再信任。\n第一次创业被合伙人卷走积蓄……"}
                rows={5}
                className="bg-card font-mono text-xs leading-5"
              />
              <FieldDescription className="text-xs">最多 12 条。它们是人物为什么这样反应的来源，会在对局中作为身份记忆被检索。</FieldDescription>
            </FormField>
          </FieldGroup>

          <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-4">
            <Button variant="tile" size="sm" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button size="sm" className="rounded-lg px-4" disabled={busy} onClick={() => void save()}>
              {busy ? <Spinner className="size-3.5" /> : <Users className="size-3.5" />}
              {isNew ? "创建人物" : "保存修改"}
            </Button>
          </div>
        </div>
      </ScrollArea>
    </>
  );
}
