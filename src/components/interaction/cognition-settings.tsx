import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { RunSpec } from "@/runtime/types";

export type PhaseSettings = NonNullable<RunSpec["cognition"]>["phases"];
export const initialHybridCognition: NonNullable<RunSpec["cognition"]> = {
  inertia: .6, decay: .1, context: "compact", requestTimeoutMs: 120000,
  phases: { psychology: { effort: "low" }, discussion: { effort: "low" }, action: { effort: "low" } },
};
const labels = { psychology: "独立心理记录", discussion: "交流机会（含心理评价）", action: "行动机会（含心理评价）" } as const;
export function CognitionSettings({ value, onChange }: { value: PhaseSettings; onChange(value: PhaseSettings): void }) {
  return <FieldGroup>{(Object.keys(labels) as Array<keyof typeof labels>).map(key => {
    const phase = value[key] ?? { effort: "low" };
    return <FieldSet key={key}><FieldLegend>{labels[key]}</FieldLegend><FieldGroup>
      <Field><FieldLabel>思考强度</FieldLabel><ToggleGroup type="single" variant="outline" aria-label={`${labels[key]}思考强度`} value={phase.effort} onValueChange={effort => { if (effort) onChange({ ...value, [key]: { ...phase, effort: effort as "low" | "medium" } }); }}><ToggleGroupItem value="low">Low</ToggleGroupItem><ToggleGroupItem value="medium">Medium</ToggleGroupItem></ToggleGroup></Field>
    </FieldGroup></FieldSet>;
  })}</FieldGroup>;
}
