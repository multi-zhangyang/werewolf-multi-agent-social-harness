import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { biasDescriptions, regulationDescriptions, temperamentDimensions } from "@/runtime/personality";
import type { Character } from "@/runtime/types";
import type { DecisionBias } from "@/society/contracts";

export function PersonalityProfile({ character }: { character: Character }) {
  return <div className="flex flex-col gap-6">
    <p className="text-xs text-muted-foreground">以下是人物设定，用于影响判断倾向；实际行为需要结合对局证据观察。</p>
    {character.temperament && <div className="flex flex-col gap-5">{temperamentDimensions.map(d => <div key={d.key} className="flex flex-col gap-2">
      <div className="flex justify-between text-sm"><span>{d.label}</span><span className="tabular-nums text-muted-foreground">{Math.round(character.temperament![d.key] * 100)} / 100</span></div>
      <Progress value={character.temperament![d.key] * 100} aria-label={`${d.label}设定`} className="h-1.5" />
      <div className="flex justify-between gap-4 text-[11px] text-muted-foreground"><span>{d.low}</span><span className="text-right">{d.high}</span></div>
    </div>)}</div>}
    {!!character.decisionBiases?.length && <div className="flex flex-col gap-3"><h3>判断容易受什么影响</h3>{character.decisionBiases.map(b => biasDescriptions[b] && <div key={b}><Badge variant="outline">{biasDescriptions[b].label}</Badge><p className="mt-2 text-sm text-muted-foreground">{biasDescriptions[b].tendency}。</p></div>)}</div>}
    {character.regulation && regulationDescriptions[character.regulation] && <div><h3>压力下的应对 · {regulationDescriptions[character.regulation].label}</h3><p>{regulationDescriptions[character.regulation].tendency}。</p></div>}
    {!character.temperament && !character.decisionBiases?.length && !character.regulation && <p className="text-sm text-muted-foreground">尚未设置具体倾向，可在编辑人物时补充。</p>}
  </div>;
}

type Personality = Pick<Character, "temperament" | "decisionBiases" | "regulation">;
export function PersonalityFields({ value, onChange }: { value: Personality; onChange(patch: Partial<Personality>): void }) {
  return <FieldGroup>
    <Field orientation="horizontal"><div className="flex-1"><FieldLabel htmlFor="temperament-enabled">五维性格</FieldLabel><FieldDescription>控制人物倾向，不指定具体行动。</FieldDescription></div><Switch id="temperament-enabled" checked={Boolean(value.temperament)} onCheckedChange={enabled => onChange({ temperament: enabled ? { openness: .5, conscientiousness: .5, extraversion: .5, agreeableness: .5, neuroticism: .5 } : undefined })} /></Field>
    {value.temperament && temperamentDimensions.map(d => <Field key={d.key}>
      <FieldLabel id={`trait-${d.key}`}>{d.label}<span className="ml-auto tabular-nums">{Math.round(value.temperament![d.key] * 100)}</span></FieldLabel>
      <Slider aria-labelledby={`trait-${d.key}`} value={[value.temperament![d.key] * 100]} min={0} max={100} step={5} onValueChange={([n]) => onChange({ temperament: { ...value.temperament!, [d.key]: n / 100 } })} />
      <FieldDescription>{d.low} ↔ {d.high}</FieldDescription>
    </Field>)}
    <Field><FieldLabel>决策偏差</FieldLabel><FieldDescription>最多选择三项。偏差可以被证据纠正。</FieldDescription>
      <div className="grid grid-cols-2 gap-3">{(Object.keys(biasDescriptions) as DecisionBias[]).map(b => <Field key={b} orientation="horizontal" data-disabled={!value.decisionBiases?.includes(b) && (value.decisionBiases?.length ?? 0) >= 3}>
        <Checkbox id={`bias-${b}`} checked={value.decisionBiases?.includes(b) ?? false} disabled={!value.decisionBiases?.includes(b) && (value.decisionBiases?.length ?? 0) >= 3} onCheckedChange={checked => onChange({ decisionBiases: checked ? [...(value.decisionBiases ?? []), b] : value.decisionBiases?.filter(x => x !== b) })} />
        <FieldLabel htmlFor={`bias-${b}`}>{biasDescriptions[b].label}</FieldLabel>
      </Field>)}</div>
    </Field>
    <Field><FieldLabel htmlFor="character-regulation">压力下的应对</FieldLabel><Select value={value.regulation ?? "unspecified"} onValueChange={v => onChange({ regulation: v === "unspecified" ? undefined : v as Character["regulation"] })}><SelectTrigger id="character-regulation"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="unspecified">由人物自行发挥</SelectItem>{Object.entries(regulationDescriptions).map(([key, d]) => <SelectItem key={key} value={key}>{d.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
  </FieldGroup>;
}
