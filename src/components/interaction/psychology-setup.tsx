import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { emotionLabels } from "@/runtime/psychology";
import { motivationLabels, type PsychologySetup } from "@/runtime/psychology-setup";
import type { Character } from "@/runtime/types";

export function PsychologySetupEditor({ character, others, value, onChange }: { character: Character; others: Character[]; value?: PsychologySetup; onChange(value?: PsychologySetup): void }) {
  return <Card><CardHeader><CardTitle>{character.name}<Badge variant="outline">私有初态</Badge></CardTitle><CardDescription>这是研究者设定的起点。后续情绪和行动由 Agent 根据处境更新。</CardDescription></CardHeader><CardContent><FieldGroup>
    <Field><FieldLabel>本局动机</FieldLabel><Select value={value?.motivation ?? "none"} onValueChange={motivation => onChange(motivation === "none" ? undefined : { emotion: "calm", intensity: .5, objective: "", relationship: others[0] ? { targetId: others[0].id, willingness: .5, competence: .5 } : undefined, ...value, motivation: motivation as PsychologySetup["motivation"] })}><SelectTrigger aria-label={`${character.name}的本局动机`}><SelectValue /></SelectTrigger><SelectContent position="popper" align="start"><SelectGroup><SelectItem value="none">不注入 · 由人物自行形成</SelectItem>{Object.entries(motivationLabels).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>收益优先可以产生隐瞒、诱导或合作；程序不会替人物选行为。</FieldDescription></Field>
    {value && <><Field><FieldLabel>初始情绪</FieldLabel><Select value={value.emotion} onValueChange={emotion => onChange({ ...value, emotion: emotion as PsychologySetup["emotion"] })}><SelectTrigger aria-label={`${character.name}的初始情绪`}><SelectValue /></SelectTrigger><SelectContent position="popper" align="start"><SelectGroup>{Object.entries(emotionLabels).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
      <Field><FieldLabel>情绪强度 · {value.intensity.toFixed(2)}</FieldLabel><Slider aria-label={`${character.name}的情绪强度`} value={[value.intensity]} min={0} max={1} step={.05} onValueChange={([intensity]) => onChange({ ...value, intensity })} /></Field>
      {value.relationship && <><Field><FieldLabel>对谁形成初始判断</FieldLabel><Select value={value.relationship.targetId} onValueChange={targetId => onChange({ ...value, relationship: { ...value.relationship!, targetId } })}><SelectTrigger aria-label={`${character.name}判断的对象`}><SelectValue /></SelectTrigger><SelectContent position="popper" align="start"><SelectGroup>{others.map(c => <SelectItem value={c.id} key={c.id}>{c.name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
        {(["willingness", "competence"] as const).map(key => <Field key={key}><FieldLabel>{key === "willingness" ? "对方合作意愿" : "对方履约能力"} · {value.relationship![key].toFixed(2)}</FieldLabel><Slider aria-label={`${character.name}的${key === "willingness" ? "合作意愿判断" : "履约能力判断"}`} min={0} max={1} step={.05} value={[value.relationship![key]]} onValueChange={([n]) => onChange({ ...value, relationship: { ...value.relationship!, [key]: n } })} /></Field>)}</>}
      <Field><FieldLabel htmlFor={`objective-${character.id}`}>私下目标</FieldLabel><Textarea id={`objective-${character.id}`} value={value.objective} maxLength={360} placeholder="例如：让对方愿意继续投入，同时尽量保留自己的收益。" onChange={e => onChange({ ...value, objective: e.target.value })} /><FieldDescription>进入这个人物的心理评价与决策；不会作为事实、公开发言或对方可见的指令。</FieldDescription></Field></>}
  </FieldGroup></CardContent></Card>;
}
