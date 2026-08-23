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
      <div className="mb-2.5 flex items-center justify-between">
        <p className="text-[13px] font-medium text-foreground/80">模型档案</p>
        <span className="nums font-mono text-xs text-muted-foreground/80">{profiles.length} 个</span>
      </div>
      <div className="space-y-2">
        {profiles.map((profile) => (
          <div key={profile.id} className="min-w-0 rounded-lg border border-border bg-muted/60 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 basis-56">
                <p className="break-all text-[13px] font-medium leading-5 text-foreground/90">
                  {profile.name}
                  <span className="ml-2 rounded border border-border bg-card px-1 font-mono text-[9px] font-normal text-muted-foreground">{profile.contextLabel}</span>
                  <span className={cn("ml-1.5 font-mono text-[9px] font-normal", profile.contextWindowSource === "manual" ? "text-muted-foreground" : "text-amber-400/90")}>
                    {profile.contextWindowSource === "manual" ? "手动登记" : "已知档案"}
                  </span>
                </p>
                <p className="break-all font-mono text-[10px] leading-4 text-muted-foreground/80">{profile.modelId} · {providers.find((provider) => provider.id === profile.providerProfileId)?.name ?? profile.providerProfileId}</p>
                {Object.entries(profile.capabilities).some(([key, state]) => state !== "unknown" && key !== "maxOutputTokens") ? (
                  <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/70">
                    {Object.entries(profile.capabilities).filter(([key, state]) => state !== "unknown" && key !== "maxOutputTokens").map(([key, state]) => (
                      <span key={key} className="whitespace-nowrap">{capabilityName(key)}:{state === "yes" ? "✓" : "✗"}</span>
                    ))}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[10px] text-muted-foreground/50">能力未验证；点击「测试模型」后发起真实请求。</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Select
                  value={profile.defaults?.reasoningEffort ?? "provider-default"}
                  disabled={savingEffort === profile.id || probing === profile.id}
                  onValueChange={(value) => onSaveReasoningEffort(profile, value as ReasoningEffortSelection)}
                >
                  <SelectTrigger className="h-7 w-32 rounded-lg border-border bg-card text-[11px]" aria-label={`${profile.name} 的思考强度`}>
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
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-lg border-border bg-card px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  disabled={Boolean(probing) || savingEffort === profile.id}
                  onClick={() => onProbe(profile.id, profile.defaults?.reasoningEffort)}
                >
                  {probing === profile.id ? <Loader2 className="animate-spin" /> : <Activity />}
                  测试模型
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-lg px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onEdit(profile)}
                >
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn("h-7 rounded-lg px-2 text-[11px]", profile.enabled ? "text-emerald-400 hover:text-emerald-300" : "text-muted-foreground hover:text-foreground")}
                  disabled={saving}
                  onClick={() => onToggle(profile)}
                >
                  {profile.enabled ? "已启用" : "已停用"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`移除 ${profile.name}`}
                  disabled={saving || Boolean(probing)}
                  onClick={() => onRemove(profile.id)}
                  className="size-7 rounded-md text-muted-foreground/60 hover:bg-border hover:text-red-400"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
            {probeResults[profile.id] ? (
              <Alert variant={probeResults[profile.id].ok ? "default" : "destructive"} className="mt-2">
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
      </div>
    </section>
  );
}
