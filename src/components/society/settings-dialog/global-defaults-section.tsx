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
    <section>
      <p className="mb-2.5 text-[13px] font-medium text-foreground/80">全局默认</p>
      <div className="flex items-center gap-3">
        <Select value={value || "__automatic__"} onValueChange={(selected) => onChange(selected === "__automatic__" ? "" : selected)}>
          <SelectTrigger className="min-w-0 flex-1 rounded-lg border-border bg-card text-foreground/90"><SelectValue placeholder="新房间默认模型" /></SelectTrigger>
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
          保存全局默认
        </Button>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground/80">
        每个 Agent 最终生效配置按「系统默认 → 模型档案 → 全局默认 → 房间 → 单 Agent 覆盖」逐级解析；创建房间时可以看到每个席位的最终模型。
      </p>
    </section>
  );
}
