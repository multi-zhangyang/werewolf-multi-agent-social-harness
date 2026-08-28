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

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }): ReactNode {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
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
    <section className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {editingProfile ? `编辑模型档案：${editingProfile.name}` : "添加模型档案"}
        </h3>
        {editingProfile ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onCancelEditing}
          >
            取消编辑
          </Button>
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field label="所属提供商">
          <Select value={providerId} onValueChange={(value) => { onPickedRemoteChange([]); onDraftChange({ ...draft, providerProfileId: value }); }}>
            <SelectTrigger className="bg-card"><SelectValue placeholder="选择提供商" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {providers.filter((provider) => provider.enabled).map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field label="模型 ID">
          <Input value={draft.modelId} onChange={(event) => onDraftChange({ ...draft, modelId: event.target.value })} placeholder="org/model-name" spellCheck={false} />
        </Field>
        <Field label="上下文窗口（tokens）">
          <Input value={draft.contextWindow} onChange={(event) => onDraftChange({ ...draft, contextWindow: event.target.value })} placeholder="262144" spellCheck={false} />
        </Field>
        <Field label="显示名称（可选）">
          <Input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} placeholder="默认与模型 ID 相同" spellCheck={false} />
        </Field>
        <Field label="默认思考强度">
          <Select value={draft.reasoningEffort} onValueChange={(value) => onDraftChange({ ...draft, reasoningEffort: value as ReasoningEffort })}>
            <SelectTrigger className="bg-card" aria-label="新模型默认思考强度">
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
        </Field>
      </div>

      <div className="mt-3 rounded-md border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground/90">
            从提供商拉取模型列表
            <span className="ml-2 font-normal text-muted-foreground">推荐，免手抄 ID</span>
          </p>
          <Button
            variant="tile"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            disabled={saving || Boolean(providerId && catalog?.loading)}
            onClick={onLoadRemoteModels}
          >
            {providerId && catalog?.loading
              ? <Loader2 className="size-3 animate-spin" />
              : <RefreshCw className="size-3" />}
            {providerId && catalog?.result?.ok ? "重新拉取" : "获取模型列表"}
          </Button>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          按所选提供商请求其模型目录；勾选多个可批量注册，上下文窗口对所有所选模型生效，之后可逐个编辑。
        </p>
        {providerId && catalog?.result && !catalog.result.ok ? (
          <p className="mt-1.5 text-[11px] leading-4 text-destructive">{catalog.result.message}</p>
        ) : null}
        {providerId && catalog?.result?.ok ? (
          <>
            <div className="mt-2 max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-border bg-muted/30 p-1">
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
                  className="h-7 px-2.5 text-[11px] text-foreground"
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

      <div className="mt-3">
        <p className="text-[11px] font-medium text-muted-foreground">能力快捷登记</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground/60">未勾选 = 能力未验证，参数不会盲目发送。</p>
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="tile" size="sm" disabled={saving} onClick={onAddModel}>
          {editingProfile ? "保存修改" : <><Plus className="size-3.5" /> 添加模型档案</>}
        </Button>
      </div>
    </section>
  );
}
