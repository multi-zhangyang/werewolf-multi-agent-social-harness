import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, Download, Pencil, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PersonalityFields } from "./personality";
import { characterDraft, characterPayload } from "./character-draft";
import { CharacterDetails } from "./character-details";
import { json, snapshots, type Catalog } from "./api";
import type { Character, CharacterSnapshot, Memory } from "@/runtime/types";

export function Characters({ catalog, refresh }: { catalog: Catalog; refresh(): void }) {
  const [selected, setSelected] = useState(catalog.characters[0]?.id);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [history, setHistory] = useState<CharacterSnapshot[]>([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [research, setResearch] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [draft, setDraft] = useState(characterDraft());
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const character = catalog.characters.find(c => c.id === selected);
  useEffect(() => {
    setMemories([]);
    if (!snapshotId || !selected) return;
    let cancelled = false;
    void json<{ memories: Memory[] }>(`/api/v2/characters/${selected}/snapshots/${snapshotId}${research ? "?view=research" : ""}`)
      .then(r => { if (!cancelled) setMemories(r.memories); }).catch(e => { if (!cancelled) toast.error(e.message); });
    return () => { cancelled = true; };
  }, [selected, snapshotId, research]);
  function edit(c?: Character) {
    setEditing(c?.id);
    setDraft(characterDraft(c));
    setOpen(true);
  }
  async function save() {
    setBusy(true);
    try {
      const saved = await json<{ id: string }>(editing ? `/api/characters/${editing}` : "/api/characters", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(characterPayload(draft)),
      });
      setSelected(saved.id); refresh(); setOpen(false); toast.success("人物已保存");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function copy() {
    if (!character) return;
    try { const saved = await json<{ id: string }>(`/api/characters/${character.id}/copy`, { method: "POST" }); setSelected(saved.id); setHistory([]); refresh(); toast.success("人物已复制"); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function importFile(file: File) {
    try {
      const result = await json<{ added: number }>("/api/characters/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      refresh(); toast.success(`已导入 ${result.added} 个人物`);
    } catch (e) { toast.error((e as Error).message); }
  }
  async function exportFile() {
    try {
      const data = await json("/api/characters/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "society-characters.json"; link.click(); URL.revokeObjectURL(url);
    } catch (e) { toast.error((e as Error).message); }
  }
  return <div className="page-content">
    <header className="page-heading"><div><span className="eyebrow">CHARACTER STUDIO</span><h1>每个人，都有自己的理由。</h1><p className="page-description">从性格和经历出发，观察他们怎样理解同一件事。</p></div><div className="flex items-center gap-2">
      <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = ""; }} />
      <Button variant="ghost" size="icon" aria-label="导入人物" onClick={() => fileInput.current?.click()}><Upload /></Button>
      <Button variant="ghost" size="icon" aria-label="导出人物" onClick={() => void exportFile()}><Download /></Button>
      <Button onClick={() => edit()}><Plus data-icon="inline-start" />新人物</Button>
    </div></header>
    <div className="characters-layout"><div className="flex flex-col gap-1">{catalog.characters.map((c, i) =>
      <button className="person-row" data-selected={selected === c.id} key={c.id} onClick={() => { setSelected(c.id); setHistory([]); setSnapshotId(""); setResearch(false); }}>
        <Avatar className="size-10" data-tone={i % 5}><AvatarFallback>{c.name.slice(-2)}</AvatarFallback></Avatar><span><strong>{c.name}</strong><small>{c.values.join(" · ")}</small></span>
      </button>)}</div><div className="flex min-w-0 flex-col gap-5">{character && <>
        <CharacterDetails character={character} memories={memories} />
        <div className="flex flex-wrap gap-2">
          {catalog.customCharacterIds?.includes(character.id) && <Button variant="outline" onClick={() => edit(character)}><Pencil data-icon="inline-start" />编辑</Button>}
          <Button variant="outline" onClick={() => void copy()}><Copy data-icon="inline-start" />复制</Button>
          <Button variant="ghost" onClick={() => void snapshots(character.id).then(r => setHistory(r.snapshots)).catch(e => toast.error(e.message))}>经历版本</Button>
        </div>
        {history.length > 0 && <FieldGroup className="pt-5"><Field><FieldLabel>经历版本</FieldLabel><Select value={snapshotId} onValueChange={setSnapshotId}><SelectTrigger><SelectValue placeholder="选择版本" /></SelectTrigger><SelectContent><SelectGroup>{history.map(s => <SelectItem key={s.id} value={s.id}>{s.worldId} · {new Date(s.at).toLocaleString("zh-CN")}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field orientation="horizontal"><Switch id="character-research" checked={research} onCheckedChange={setResearch} /><FieldLabel htmlFor="character-research">研究视角</FieldLabel></Field></FieldGroup>}
      </>}</div></div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{editing ? "编辑人物" : "新人物"}</DialogTitle></DialogHeader>
      <form onSubmit={e => { e.preventDefault(); void save(); }}><FieldGroup>
        {([{ key: "name", label: "名字", max: 24 }, { key: "persona", label: "性格与矛盾", max: 400 }, { key: "values", label: "在意的事", max: 100 }, { key: "goals", label: "想要的事", max: 400 }, { key: "voice", label: "表达习惯", max: 240 }] as const).map(f =>
          <Field key={f.key}><FieldLabel htmlFor={`character-${f.key}`}>{f.label}</FieldLabel>{f.key === "persona" ?
            <Textarea id={`character-${f.key}`} required minLength={4} maxLength={f.max} value={draft[f.key]} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))} /> :
            <Input id={`character-${f.key}`} required={f.key !== "voice"} maxLength={f.max} value={draft[f.key]} onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))} />}
          </Field>)}
        <Field><FieldLabel htmlFor="character-traits">性格关键词 · 用顿号分隔</FieldLabel><Input id="character-traits" maxLength={110} value={draft.traits} placeholder="例如：谨慎、好胜、重视承诺" onChange={e => setDraft(d => ({ ...d, traits: e.target.value }))} /></Field>
        <Collapsible><CollapsibleTrigger asChild><Button type="button" variant="outline"><ChevronDown data-icon="inline-start" />性格倾向与成长经历</Button></CollapsibleTrigger><CollapsibleContent className="pt-6"><FieldGroup>
          <PersonalityFields value={draft} onChange={patch => setDraft(d => ({ ...d, ...patch }))} />
          <Field><FieldLabel htmlFor="character-anchors">成长经历 · 每行一条</FieldLabel><Textarea id="character-anchors" rows={5} maxLength={1451} value={draft.anchors} onChange={e => setDraft(d => ({ ...d, anchors: e.target.value }))} placeholder="什么经历让这个人变成了现在的样子？" /></Field>
        </FieldGroup></CollapsibleContent></Collapsible>
        <Button type="submit" disabled={busy}>保存人物</Button>
      </FieldGroup></form>
    </DialogContent></Dialog>
  </div>;
}
