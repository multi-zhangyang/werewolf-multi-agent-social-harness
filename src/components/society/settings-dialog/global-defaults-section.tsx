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
import { cn } from "@/lib/utils";
import type { ModelProfileView } from "./types";

/**
 * Room-creation defaults, stored as registry global defaults: the unified
 * model preselected for new rooms, and the pool that 随机混合 deals seats
 * from when the user has not picked a pool of their own.
 */
export function GlobalDefaultsSection({ profiles, value, onChange, pool, onPoolChange, onSave, saving }: {
  profiles: ModelProfileView[];
  value: string;
  onChange: (value: string) => void;
  pool: string[];
  onPoolChange: (pool: string[]) => void;
  onSave: () => void;
  saving: boolean;
}): ReactNode {
  const enabled = profiles.filter((profile) => profile.enabled);
  const togglePoolModel = (profileId: string): void => {
    onPoolChange(pool.includes(profileId) ? pool.filter((id) => id !== profileId) : [...pool, profileId]);
  };
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
              {enabled.map((profile) => (
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

      <h3 className="mt-6 text-sm font-semibold text-foreground">默认随机池</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        创建房间的「随机混合」未自选模型池时，以及 demo 脚本默认开桌时，席位从这里随机分配。不选则回退为全部启用模型。
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {enabled.length ? enabled.map((profile) => {
          const active = pool.includes(profile.id);
          return (
            <button
              key={profile.id}
              onClick={() => togglePoolModel(profile.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                active ? "border-foreground/60 bg-muted text-foreground" : "border-border bg-card text-muted-foreground hover:border-foreground/30"
              )}
            >
              <span className={cn("size-1.5 rounded-full", active ? "bg-live" : "bg-border")} />
              <span className="max-w-52 truncate font-mono">{profile.name}</span>
            </button>
          );
        }) : (
          <p className="text-[11px] text-muted-foreground">没有已启用的模型档案。</p>
        )}
      </div>
      <Button variant="tile" size="sm" className="mt-3" disabled={saving} onClick={onSave}>
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        保存
      </Button>
    </section>
  );
}
