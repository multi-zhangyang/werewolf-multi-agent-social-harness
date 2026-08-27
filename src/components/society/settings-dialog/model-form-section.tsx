import type { ReactNode } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  QUICK_CAPABILITIES,
  type ModelDraft,
  type ModelProfileView,
  type ProviderView,
  type ReasoningEffort,
  type RemoteModelsResult
} from "./types";

export interface RemoteCatalogState {
  loading: boolean;
  result?: RemoteModelsResult;
}

/** Add/edit one model profile, with the provider's live model catalog for batch registration. */
export function ModelFormSection({
  editingProfile,
  draft,
  onDraftChange,
  providers,
  registeredModelIds,
  remote,
  pickedRemoteIds,
  onPickedRemoteChange,
  onLoadRemoteModels,
  onAddSelectedRemoteModels,
  onAddModel,
  onCancelEditing,
  saving
}: {
  editingProfile: ModelProfileView | null;
  draft: ModelDraft;
  onDraftChange: (draft: ModelDraft) => void;
  providers: ProviderView[];
  /** Already-registered model ids for the currently selected provider. */
  registeredModelIds: Set<string>;
  remote: Record<string, RemoteCatalogState>;
  pickedRemoteIds: string[];
  onPickedRemoteChange: (ids: string[]) => void;
  onLoadRemoteModels: () => void;
  onAddSelectedRemoteModels: () => void;
  onAddModel: () => void;
  onCancelEditing: () => void;
  saving: boolean;
}): ReactNode {
  const providerId = draft.providerProfileId;
  const catalog = providerId ? remote[providerId] : undefined;
  return (
    <div className="mt-3 rounded-lg border border-dashed border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          {editingProfile ? `编辑模型档案：${editingProfile.name}` : "添加模型档案"}
        </p>
        {editingProfile ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            onClick={onCancelEditing}
          >
            取消编辑
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Select value={providerId} onValueChange={(value) => { onPickedRemoteChange([]); onDraftChange({ ...draft, providerProfileId: value }); }}>
          <SelectTrigger className="rounded-lg border-border bg-card text-foreground/90"><SelectValue placeholder="所属提供商" /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {providers.filter((provider) => provider.enabled).map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Input value={draft.modelId} onChange={(event) => onDraftChange({ ...draft, modelId: event.target.value })} placeholder="模型 ID（如 org/model-name）" spellCheck={false} />
        <Input value={draft.contextWindow} onChange={(event) => onDraftChange({ ...draft, contextWindow: event.target.value })} placeholder="上下文窗口（tokens，如 262144）" spellCheck={false} />
        <Input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} placeholder="显示名称（可选）" spellCheck={false} />
        <Select value={draft.reasoningEffort} onValueChange={(value) => onDraftChange({ ...draft, reasoningEffort: value as ReasoningEffort })}>
          <SelectTrigger className="rounded-lg border-border bg-card text-foreground/90" aria-label="新模型默认思考强度">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="low">低 · low</SelectItem>
              <SelectItem value="medium">中 · medium</SelectItem>
              <SelectItem value="high">高 · high（默认）</SelectItem>
              <SelectItem value="xhigh">极高 · xhigh</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="mt-2 rounded-lg border border-border bg-muted/40 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-medium text-muted-foreground">从提供商拉取模型列表（推荐）</p>
          <Button
            variant="tile"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={saving || Boolean(providerId && catalog?.loading)}
            onClick={onLoadRemoteModels}
          >
            {providerId && catalog?.loading
              ? <Loader2 className="size-3 animate-spin" />
              : <RefreshCw className="size-3" />}
            {providerId && catalog?.result?.ok ? "重新拉取" : "获取模型列表"}
          </Button>
        </div>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground/70">
          Base URL 需以 /v1 结尾（如 https://api.example.com/v1）。勾选后批量注册，上下文窗口用上方输入值，添加后可随时逐个编辑。
        </p>
        {providerId && catalog?.result && !catalog.result.ok ? (
          <p className="mt-1.5 text-[11px] leading-4 text-destructive">{catalog.result.message}</p>
        ) : null}
        {providerId && catalog?.result?.ok ? (
          <>
            <div className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border bg-card p-1">
              {catalog.result.modelIds.map((modelId) => {
                const registered = registeredModelIds.has(modelId);
                const picked = pickedRemoteIds.includes(modelId);
                return (
                  <label
                    key={modelId}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 font-mono text-[11px]",
                      registered ? "cursor-not-allowed text-muted-foreground/40" : picked ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-3 accent-foreground"
                      disabled={registered}
                      checked={picked}
                      onChange={(event) => onPickedRemoteChange(event.target.checked ? [...pickedRemoteIds, modelId] : pickedRemoteIds.filter((id) => id !== modelId))}
                    />
                    <span className="min-w-0 flex-1 truncate">{modelId}</span>
                    {registered ? <MiniChip>已添加</MiniChip> : null}
                  </label>
                );
              })}
            </div>
            {pickedRemoteIds.length ? (
              <div className="mt-2 flex items-center gap-2">
                <span className="nums text-[11px] text-muted-foreground">已选 {pickedRemoteIds.length} 个</span>
                <Button
                  variant="tile"
                  size="sm"
                  className="h-7 px-2 text-[11px] text-foreground"
                  disabled={saving}
                  onClick={onAddSelectedRemoteModels}
                >
                  <Plus className="size-3" />
                  添加所选模型
                </Button>
                <button type="button" className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground" onClick={() => onPickedRemoteChange([])}>
                  清空选择
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {QUICK_CAPABILITIES.map(({ key, label }) => (
          <label key={key} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground has-checked:border-foreground/60 has-checked:text-foreground">
            <input
              type="checkbox"
              className="size-3 accent-foreground"
              checked={draft[key] === true}
              onChange={(event) => onDraftChange({ ...draft, [key]: event.target.checked })}
            />
            {label}
          </label>
        ))}
        <span className="self-center text-[10px] text-muted-foreground/60">未勾选 = 能力未验证，参数不会盲目发送</span>
      </div>
      <Button variant="tile" size="sm" className="mt-2" disabled={saving} onClick={onAddModel}>
        {editingProfile ? "保存修改" : <><Plus className="size-3.5" /> 添加模型档案</>}
      </Button>
    </div>
  );
}
