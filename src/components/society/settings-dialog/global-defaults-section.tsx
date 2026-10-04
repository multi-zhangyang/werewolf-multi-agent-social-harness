import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ModelProfileView } from "./types";

export function GlobalDefaultsSection({ profiles, value, onChange, onSave, saving }: {
  profiles: ModelProfileView[];
  value: string;
  onChange(value: string): void;
  onSave(): void;
  saving: boolean;
}) {
  return <FieldGroup><Field><FieldLabel>新互动的默认模型</FieldLabel>
    <Select value={value} onValueChange={onChange}><SelectTrigger><SelectValue placeholder="选择模型" /></SelectTrigger>
      <SelectContent><SelectGroup>{profiles.filter(p => p.enabled).map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  </Field><Button className="w-fit" disabled={saving || !value} onClick={onSave}><Check data-icon="inline-start" />保存</Button></FieldGroup>;
}
