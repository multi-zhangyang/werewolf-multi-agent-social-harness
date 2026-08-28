import type { ReactNode } from "react";
import { Activity, Check, CircleAlert, Loader2, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { MiniChip } from "../shared";
import { capabilityName, type ModelProfileView, type ProviderView, type ReasoningEffort, type ReasoningEffortSelection, type TestResult } from "./types";

/** The registered model profiles: per-row reasoning effort, probe, edit, enable, remove. */
export function ModelProfilesSection({ profiles, providers, probeResults, probing, savingEffort, saving, onProbe, onEdit, onToggle, onRemove, onSaveReasoningEffort }: {
  profiles: ModelProfileView[];
  providers: ProviderView[];
  probeResults: Record<string, TestResult>;
  probing?: string;
  savingEffort?: string;
  saving: boolean;
  onProbe: (profileId: string, reasoningEffort?: ReasoningEffort) => void;
  onEdit: (profile: ModelProfileView) => void;
  onToggle: (profile: ModelProfileView) => void;
  onRemove: (id: string) => void;
  onSaveReasoningEffort: (profile: ModelProfileView, reasoningEffort: ReasoningEffortSelection) => void;
}): ReactNode {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">模型档案</h3>
        <span className="text-xs text-muted-foreground">{profiles.length} 个 · 停用的档案不会出现在创建房间时</span>
      </div>

      <div className="scroll-fade-y-lg max-h-[420px] space-y-2 overflow-y-auto px-0.5 py-0.5">
        {profiles.map((profile) => (
          <div key={profile.id} className={cn("min-w-0 rounded-lg border bg-card px-4 py-3", profile.enabled ? "border-border" : "border-border/60 opacity-75")}>
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={profile.enabled}
                aria-label={profile.enabled ? `停用 ${profile.name}` : `启用 ${profile.name}`}
                title={profile.enabled ? "点击停用" : "点击启用"}
                className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", profile.enabled ? "bg-live/80" : "bg-border")}
                disabled={saving}
                onClick={() => onToggle(profile)}
              >
                <span className={cn("absolute top-0.5 size-3 rounded-full bg-background shadow transition-all", profile.enabled ? "left-3.5" : "left-0.5")} />
              </button>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{profile.name}</span>
                  <MiniChip className="shrink-0 font-mono" title="上下文窗口">{profile.contextLabel}</MiniChip>
                  <span className={cn("shrink-0 text-[10px]", profile.contextWindowSource === "manual" ? "text-muted-foreground" : "text-warn/90")}>
                    {profile.contextWindowSource === "manual" ? "手动登记" : "已知档案"}
                  </span>
                </p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {profile.modelId} · {providers.find((provider) => provider.id === profile.providerProfileId)?.name ?? profile.providerProfileId}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Select
                  value={profile.defaults?.reasoningEffort ?? "provider-default"}
                  disabled={savingEffort === profile.id || probing === profile.id}
                  onValueChange={(value) => onSaveReasoningEffort(profile, value as ReasoningEffortSelection)}
                >
                  <SelectTrigger className="h-7 w-32 rounded-lg border-border bg-muted/40 text-[11px]" aria-label={`${profile.name} 的思考强度`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="provider-default">提供商默认</SelectItem>
                      <SelectItem value="low">低 · low</SelectItem>
                      <SelectItem value="medium">中 · medium</SelectItem>
                      <SelectItem value="high">高 · high</SelectItem>
                      <SelectItem value="xhigh">极高 · xhigh</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  variant="tile"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  disabled={Boolean(probing) || savingEffort === profile.id}
                  onClick={() => onProbe(profile.id, profile.defaults?.reasoningEffort)}
                >
                  {probing === profile.id ? <Loader2 className="animate-spin" /> : <Activity />}
                  测试
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-lg px-2.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onEdit(profile)}
                >
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`移除 ${profile.name}`}
                  disabled={saving || Boolean(probing)}
                  onClick={() => onRemove(profile.id)}
                  className="size-7 rounded-md text-muted-foreground/60 hover:bg-border hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>

            {Object.entries(profile.capabilities).some(([key, state]) => state !== "unknown" && key !== "maxOutputTokens") ? (
              <div className="mt-2 flex flex-wrap gap-1 pl-10">
                {Object.entries(profile.capabilities).filter(([key, state]) => state !== "unknown" && key !== "maxOutputTokens").map(([key, state]) => (
                  <MiniChip key={key} tone={state === "yes" ? "live" : "neutral"}>{capabilityName(key)} {state === "yes" ? "✓" : "✗"}</MiniChip>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 pl-10 text-[11px] text-muted-foreground/60">能力未验证；点击「测试」后发起真实请求。</p>
            )}

            {probeResults[profile.id] ? (
              <Alert variant={probeResults[profile.id].ok ? "default" : "destructive"} className="mt-2.5">
                {probeResults[profile.id].ok ? <Check /> : <CircleAlert />}
                <AlertTitle>{probeResults[profile.id].ok ? "测试通过" : "测试失败"}</AlertTitle>
                <AlertDescription>
                  <p>{probeResults[profile.id].message}</p>
                  {probeResults[profile.id].reasoningFallbacks?.map((fallback, index) => (
                    <p key={`${fallback.from}-${fallback.to}-${index}`}>
                      {fallback.from} → {fallback.to}（HTTP {fallback.status}）：{fallback.reason}
                    </p>
                  ))}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        ))}
        {profiles.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            还没有模型档案。在下方添加，或先从提供商拉取模型列表。
          </p>
        ) : null}
      </div>
    </section>
  );
}
