import type { ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { ModelProfileView } from "./types";

/** Room-creation default model profile, stored as a registry global default. */
export function GlobalDefaultsSection({ profiles, value, onChange, onSave, saving }: {
  profiles: ModelProfileView[];
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
}): ReactNode {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">全局默认模型</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        新房间创建时预选的模型。每个 Agent 最终生效配置按「系统默认 → 模型档案 → 全局默认 → 房间 → 单 Agent 覆盖」逐级解析。
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Select value={value || "__automatic__"} onValueChange={(selected) => onChange(selected === "__automatic__" ? "" : selected)}>
          <SelectTrigger className="min-w-0 flex-1 bg-muted/40"><SelectValue placeholder="新房间默认模型" /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="__automatic__">（不指定：使用第一个启用的模型）</SelectItem>
              {profiles.filter((profile) => profile.enabled).map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button variant="tile" size="sm" className="shrink-0" disabled={saving} onClick={onSave}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          保存
        </Button>
      </div>
    </section>
  );
}
