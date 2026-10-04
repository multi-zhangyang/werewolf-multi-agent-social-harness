import { useEffect, useState } from "react";
import { ChevronDown, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { createRun, snapshots, type Catalog } from "./api";
import type { CharacterSnapshot, RunSpec } from "@/runtime/types";
import { PsychologySetupEditor } from "./psychology-setup";
import type { PsychologySetup } from "@/runtime/psychology-setup";
import { signalingPayoffText } from "@/runtime/scenarios/payoffs";
import { CognitionSettings, initialHybridCognition, type PhaseSettings } from "./cognition-settings";

export function CreateInteraction({ catalog }: { catalog: Catalog }) {
  const query = new URLSearchParams(location.hash.split("?")[1]);
  const initialScenario = catalog.scenarios.find(s => s.id === query.get("scenario")) ?? catalog.scenarios[0];
  const [scenario, setScenario] = useState<RunSpec["scenario"]>(initialScenario.id);
  const [chosen, setChosen] = useState(catalog.characters.slice(0, initialScenario.players).map(c => c.id));
  const [mode, setMode] = useState<RunSpec["mode"]>(query.get("mode") === "experiment" ? "experiment" : "continuity");
  const [personality, setPersonality] = useState<RunSpec["experiment"]["personality"]>("full");
  const [psychology, setPsychology] = useState<RunSpec["experiment"]["psychology"]>("hybrid");
  const [trustProtocol, setTrustProtocol] = useState<RunSpec["trustProtocol"]>("pledge-repair");
  const [signalingIncentives, setSignalingIncentives] = useState<RunSpec["signalingIncentives"]>("conflicting");
  const [signalingPayoffProfile, setSignalingPayoffProfile] = useState<RunSpec["signalingPayoffProfile"]>("legacy");
  const [objective, setObjective] = useState<RunSpec["experiment"]["objective"]>("character");
  const [worldId, setWorldId] = useState("society");
  const [human, setHuman] = useState(query.get("play") === "true" ? catalog.characters[0]?.id ?? "none" : "none");
  const [psychologySetup, setPsychologySetup] = useState<Record<string, PsychologySetup>>({});
  const [rounds, setRounds] = useState(initialScenario.id === "signaling-game" ? 4 : 3);
  const [seed, setSeed] = useState(1);
  const [budget, setBudget] = useState(initialScenario.players === 2 ? 2 : 16);
  const [maxTurns, setMaxTurns] = useState(8);
  const [phases, setPhases] = useState<PhaseSettings>(initialHybridCognition.phases);
  const [model, setModel] = useState(catalog.defaultModel);
  const [models, setModels] = useState<Record<string, string>>({});
  const [available, setAvailable] = useState<Record<string, CharacterSnapshot[]>>({});
  const [initialSnapshots, setInitialSnapshots] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const definition = catalog.scenarios.find(s => s.id === scenario)!;
  const range = definition.playerRange ?? { min: definition.players, max: definition.players };
  function changeScenario(id: RunSpec["scenario"]) {
    setScenario(id); const s = catalog.scenarios.find(s => s.id === id)!; setChosen(catalog.characters.slice(0, s.players).map(c => c.id)); setHuman("none"); setRounds(Math.min(rounds, s.maxRounds));
  }
  useEffect(() => {
    if (mode !== "experiment") return;
    let cancelled = false;
    void Promise.all(chosen.map(async id => [id, (await snapshots(id)).snapshots] as const))
      .then(entries => { if (!cancelled) setAvailable(Object.fromEntries(entries)); })
      .catch(e => { if (!cancelled) toast.error(e.message); });
    return () => { cancelled = true; };
  }, [chosen, mode]);
  async function start() {
    setBusy(true);
    try { await createRun({ scenario, trustProtocol, signalingIncentives, signalingPayoffProfile, psychologySetup: mode === "experiment" && psychology === "hybrid" ? Object.fromEntries(Object.entries(psychologySetup).filter(([id]) => chosen.includes(id) && id !== human).map(([id, setup]) => [id, { ...setup, relationship: setup.relationship && chosen.includes(setup.relationship.targetId) ? setup.relationship : undefined }])) : undefined, roster: chosen.map(characterId => ({ characterId, human: human === characterId, modelProfileId: models[characterId] ?? model })), mode, worldId, rounds, seed, initialSnapshots: mode === "experiment" ? Object.fromEntries(Object.entries(initialSnapshots).filter(([id]) => chosen.includes(id))) : {}, experiment: { personality: mode === "experiment" ? personality : "full", objective: mode === "experiment" && scenario === "signaling-game" ? objective : "character", relationshipMemory: true, speaking: "ready-queue", psychology }, ...(psychology === "hybrid" ? { cognition: { ...initialHybridCognition, phases } } : {}), budgets: { discussionTurns: budget, maxTurns, humanTimeoutMs: 300000 } }); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="page-content max-w-3xl">
    <header className="page-heading"><div><span className="eyebrow">NEW INTERACTION</span><h1>让不同的人，走进同一个处境。</h1><p className="page-description">选择场景与人物，留下一场可以回看的社会实验。</p></div></header>
    <FieldGroup>
      <Field><FieldLabel>场景</FieldLabel><ToggleGroup type="single" variant="outline" className="max-w-full flex-wrap" spacing={1} value={scenario} onValueChange={v => { if (v) changeScenario(v as RunSpec["scenario"]); }}>{catalog.scenarios.map(s => <ToggleGroupItem key={s.id} value={s.id}>{s.name}</ToggleGroupItem>)}</ToggleGroup></Field>
      {scenario === "trust-game" && <Field><FieldLabel>博弈规则</FieldLabel><ToggleGroup type="single" variant="outline" value={trustProtocol} onValueChange={v => { if (v) setTrustProtocol(v as typeof trustProtocol); }}><ToggleGroupItem value="pledge-repair">承诺 · 背叛 · 修复</ToggleGroupItem><ToggleGroupItem value="classic">经典信任博弈</ToggleGroupItem></ToggleGroup><FieldDescription>受托者先公开承诺返还比例，仍可选择违约；之后可以用自己的收益付出补偿。角色轮换让双方承担下一次选择的后果。</FieldDescription></Field>}
      {scenario === "signaling-game" && <>
        <Field><FieldLabel>收益条件</FieldLabel><ToggleGroup type="single" variant="outline" aria-label="信息交易收益条件" value={signalingIncentives} onValueChange={v => { if (v) setSignalingIncentives(v as typeof signalingIncentives); }}><ToggleGroupItem value="conflicting">利益冲突</ToggleGroupItem><ToggleGroupItem value="aligned">利益一致</ToggleGroupItem></ToggleGroup></Field>
        <Field><FieldLabel>收益配置</FieldLabel><ToggleGroup type="single" variant="outline" aria-label="信息交易收益配置" value={signalingPayoffProfile} onValueChange={v => { if (v) setSignalingPayoffProfile(v as typeof signalingPayoffProfile); }}><ToggleGroupItem value="legacy">经典</ToggleGroupItem><ToggleGroupItem value="diagnostic">诊断 · 高拒绝收益</ToggleGroupItem></ToggleGroup><FieldDescription>{signalingPayoffText(signalingIncentives, signalingPayoffProfile)}</FieldDescription></Field>
      </>}
      <Field><FieldLabel>心理机制</FieldLabel><ToggleGroup type="single" variant="outline" className="max-w-full flex-wrap" spacing={1} value={psychology} onValueChange={v => { if (v) { setPsychology(v as typeof psychology); if (v === "off") setObjective("character"); } }}><ToggleGroupItem value="hybrid">持续心理 · 有惯性</ToggleGroupItem><ToggleGroupItem value="appraisal">即时评价 · 无惯性</ToggleGroupItem><ToggleGroupItem value="off">关闭 · 行为对照</ToggleGroupItem></ToggleGroup><FieldDescription>每次决定前更新情绪、需要、对他人的猜测和策略，保存后进入实际决策。研究视角可回看状态与行为是否一致。</FieldDescription></Field>
      <Field><FieldLabel>人物 <span className="text-muted-foreground">{chosen.length} / {range.min === range.max ? range.max : `${range.min}–${range.max}`}</span></FieldLabel>
        <div className="character-picker">{catalog.characters.map((c, i) => <label key={c.id} className="character-option" data-selected={chosen.includes(c.id)}><Checkbox checked={chosen.includes(c.id)} onCheckedChange={v => setChosen(ids => v ? [...ids, c.id] : ids.filter(id => id !== c.id))} aria-label={c.name} /><Avatar className="size-9" data-tone={i % 5}><AvatarFallback>{c.name.slice(-2)}</AvatarFallback></Avatar><span>{c.name}</span></label>)}</div>
      </Field>
      {scenario === "signaling-game" && <Field><FieldDescription>下方第一位是发送者，第二位是接收者；本局角色保持不变。</FieldDescription><Button type="button" variant="outline" size="sm" className="w-fit" disabled={chosen.length !== 2} onClick={() => setChosen(ids => [...ids].reverse())}>交换发送者与接收者</Button></Field>}
      <div className="selected-personalities">{chosen.map((id, index) => { const c = catalog.characters.find(c => c.id === id)!; return <div key={id} className="flex flex-col gap-2"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{c.name}</strong>{scenario === "signaling-game" && <Badge variant="secondary">{index === 0 ? "发送者" : "接收者"}</Badge>}{c.traits?.slice(0, 2).map(t => <Badge key={t} variant="outline">{t}</Badge>)}</div><p className="text-xs text-muted-foreground">{c.persona}</p></div>; })}</div>
      <Field><FieldLabel>经历</FieldLabel><ToggleGroup type="single" variant="outline" value={mode} onValueChange={v => { if (v) setMode(v as RunSpec["mode"]); }}><ToggleGroupItem value="continuity">连续互动</ToggleGroupItem><ToggleGroupItem value="experiment">独立实验</ToggleGroupItem></ToggleGroup></Field>
      {mode === "experiment" && scenario === "signaling-game" && <Field><FieldLabel>决策目标</FieldLabel><ToggleGroup type="single" variant="outline" aria-label="信息交易决策目标" value={objective} onValueChange={v => { if (v) setObjective(v as typeof objective); }}><ToggleGroupItem value="character">人物目标</ToggleGroupItem><ToggleGroupItem value="score" disabled={psychology === "off"}>累计收益优先</ToggleGroupItem></ToggleGroup></Field>}
      {mode === "experiment" && <Field><FieldLabel>人格条件</FieldLabel><ToggleGroup type="single" variant="outline" value={personality} onValueChange={v => { if (v) setPersonality(v as typeof personality); }}><ToggleGroupItem value="full">完整人格</ToggleGroupItem><ToggleGroupItem value="persona-only">仅文字人设</ToggleGroupItem></ToggleGroup><FieldDescription>完整人格加入五维倾向、决策偏差、情绪应对和成长背景。对照时保持模型、人物、起点和世界种子一致；世界种子不保证模型回复完全复现。</FieldDescription></Field>}
      {mode === "experiment" && chosen.map(id => <Field key={id}><FieldLabel>{catalog.characters.find(c => c.id === id)?.name}的起点</FieldLabel><Select value={initialSnapshots[id] ?? "fresh"} onValueChange={v => setInitialSnapshots(s => { const next = { ...s }; if (v === "fresh") delete next[id]; else next[id] = v; return next; })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="fresh">全新经历</SelectItem>{available[id]?.map(s => <SelectItem key={s.id} value={s.id}>{s.worldId} · {new Date(s.at).toLocaleString("zh-CN")}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>)}
      <Field><FieldLabel>我的参与</FieldLabel><Select value={human} onValueChange={setHuman}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="none">旁观</SelectItem>{chosen.map(id => <SelectItem key={id} value={id}>{catalog.characters.find(c => c.id === id)?.name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
      {mode === "experiment" && psychology === "hybrid" && <Field><FieldLabel>心理初态与私下目标</FieldLabel><FieldDescription>一次只改一个变量便于对照。所有注入会记录来源；它不会改账本，也不会直接指定投资或返还金额。</FieldDescription><div className="flex flex-col gap-4">{chosen.filter(id => id !== human).map(id => <PsychologySetupEditor key={id} character={catalog.characters.find(c => c.id === id)!} others={catalog.characters.filter(c => chosen.includes(c.id) && c.id !== id)} value={psychologySetup[id]} onChange={value => setPsychologySetup(previous => { const next = { ...previous }; if (value) next[id] = value; else delete next[id]; return next; })} />)}</div></Field>}
      <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />高级设置</Button></CollapsibleTrigger><CollapsibleContent className="pt-5"><FieldGroup>
        <Field><FieldLabel htmlFor="world-id">连续世界</FieldLabel><Input id="world-id" value={worldId} onChange={e => setWorldId(e.target.value)} /></Field>
        <Field><FieldLabel>默认模型</FieldLabel><Select value={model} onValueChange={setModel}><SelectTrigger><SelectValue placeholder="选择模型" /></SelectTrigger><SelectContent><SelectGroup>{catalog.models.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
        {chosen.map(id => <Field key={id} orientation="horizontal"><FieldLabel>{catalog.characters.find(c => c.id === id)?.name}</FieldLabel><Select value={models[id] ?? "default"} onValueChange={v => setModels(s => { const next = { ...s }; if (v === "default") delete next[id]; else next[id] = v; return next; })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="default">使用默认模型</SelectItem>{catalog.models.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>)}
        <Field><FieldLabel htmlFor="rounds">回合</FieldLabel><Input id="rounds" type="number" min={2} max={definition.maxRounds} value={rounds} onChange={e => setRounds(Number(e.target.value))} /></Field>
        <Field><FieldLabel htmlFor="seed">世界种子</FieldLabel><Input id="seed" type="number" value={seed} onChange={e => setSeed(Number(e.target.value))} /></Field>
        <Field><FieldLabel htmlFor="budget">每阶段交流机会</FieldLabel><Input id="budget" type="number" min={2} max={100} value={budget} onChange={e => setBudget(Number(e.target.value))} /></Field>
        <Field><FieldLabel htmlFor="max-turns">每次行动步数</FieldLabel><Input id="max-turns" type="number" min={2} max={24} value={maxTurns} onChange={e => setMaxTurns(Number(e.target.value))} /></Field>
        {psychology === "hybrid" && <CognitionSettings value={phases} onChange={setPhases} />}
      </FieldGroup></CollapsibleContent></Collapsible>
      <Button size="lg" disabled={busy || chosen.length < range.min || chosen.length > range.max || !model || !worldId.trim()} onClick={() => void start()}><Play data-icon="inline-start" />{busy ? "入场中" : "开始互动"}</Button>
    </FieldGroup>
  </div>;
}
