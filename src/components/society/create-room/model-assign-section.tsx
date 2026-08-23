import type { ReactNode } from "react";
import { Shuffle } from "lucide-react";
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
import type { ModelOption } from "../types";
import type { ModelAssignMode, RosterPreviewRow } from "./types";

/** Segmented pill used by the model-assignment and participant-mode switches. */
export function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-8 rounded-md text-[13px] font-medium transition-colors",
        active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground/80"
      )}
    >
      {children}
    </button>
  );
}

/** 模型分配: unified / per-seat / random pool, plus the final roster preview. */
export function ModelAssignSection({
  assignMode,
  onAssignModeChange,
  eligibleModels,
  unifiedId,
  onUnifiedIdChange,
  unifiedName,
  players,
  poolIds,
  onTogglePoolModel,
  onReshuffle,
  previewRows
}: {
  assignMode: ModelAssignMode;
  onAssignModeChange: (mode: ModelAssignMode) => void;
  eligibleModels: ModelOption[];
  unifiedId: string;
  onUnifiedIdChange: (profileId: string) => void;
  unifiedName: string;
  players: number;
  poolIds: string[];
  onTogglePoolModel: (profileId: string) => void;
  onReshuffle: () => void;
  previewRows: RosterPreviewRow[];
}): ReactNode {
  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <p className="text-[13px] font-medium text-foreground/80">模型分配</p>
        <span className="nums font-mono text-xs text-muted-foreground/80">{eligibleModels.length} 个可用档案</span>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted p-1">
        <ModeButton active={assignMode === "unified"} onClick={() => onAssignModeChange("unified")}>统一模型</ModeButton>
        <ModeButton active={assignMode === "per-seat"} onClick={() => onAssignModeChange("per-seat")}>逐席配置</ModeButton>
        <ModeButton active={assignMode === "random"} onClick={() => onAssignModeChange("random")}>随机混合</ModeButton>
      </div>

      {assignMode === "unified" ? (
        <div data-model>
          <Select value={unifiedId} onValueChange={onUnifiedIdChange}>
            <SelectTrigger className="h-9 w-full rounded-lg border-border bg-card text-foreground/90">
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {eligibleModels.map((model) => (
                  <SelectItem key={model.profileId} value={model.profileId!}>
                    {model.name}{model.contextLabel ? ` · ${model.contextLabel}` : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground/70">全部 {players} 个 AI 席位使用同一模型。</p>
        </div>
      ) : null}

      {assignMode === "per-seat" ? (
        <p className="text-xs leading-5 text-muted-foreground">在下方参与者列表中为每个席位单独挑选模型；未单独挑选的席位使用统一模型（当前 {unifiedName}）。可在下方预览改回。</p>
      ) : null}

      {assignMode === "random" ? (
        <div data-model>
          <p className="mb-1.5 text-xs text-muted-foreground">勾选参与随机的模型池（至少一个），按席位平衡洗牌；每个模型的出场次数最多相差一。</p>
          <div className="flex flex-wrap gap-1.5">
            {eligibleModels.map((model) => {
              const active = poolIds.includes(model.profileId!);
              return (
                <button
                  key={model.profileId}
                  onClick={() => onTogglePoolModel(model.profileId!)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                    active ? "border-foreground/60 bg-muted text-foreground" : "border-border bg-card text-muted-foreground hover:border-foreground/30"
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", active ? "bg-emerald-400" : "bg-border")} />
                  <span className="max-w-52 truncate font-mono">{model.name}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
              disabled={!poolIds.length}
              onClick={onReshuffle}
            >
              <Shuffle className="size-3.5" />
              重新随机
            </Button>
            <span className="text-[11px] text-muted-foreground/70">提交的就是下方预览的分配，不做服务端暗箱随机。</span>
          </div>
        </div>
      ) : null}

      <div className="mt-3 rounded-lg border border-border bg-muted/60 px-3 py-2.5" data-roster-preview>
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">最终阵容预览</p>
        <div className="space-y-1">
          {previewRows.map((row) => (
            <div key={row.index} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span className="flex size-4 shrink-0 items-center justify-center rounded bg-card font-mono text-[9px] ring-1 ring-border">
                  {row.index + 1}
                </span>
                <span className="truncate">{row.characterLabel}</span>
              </span>
              <span className="shrink-0 font-mono text-muted-foreground/90">{row.modelLabel}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
