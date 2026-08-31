import type { ReactNode } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
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
    <section className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {editingProfile ? `编辑模型档案：${editingProfile.name}` : "添加模型档案"}
        </h3>
        {editingProfile ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onCancelEditing}
          >
            取消编辑
          </Button>
        ) : null}
      </div>

      <FieldGroup className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field>
          <FieldLabel className="text-xs text-muted-foreground">所属提供商</FieldLabel>
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
        <Field>
          <FieldLabel className="text-xs text-muted-foreground">模型 ID</FieldLabel>
          <Input value={draft.modelId} onChange={(event) => onDraftChange({ ...draft, modelId: event.target.value })} placeholder="org/model-name" spellCheck={false} />
        </Field>
        <Field>
          <FieldLabel className="text-xs text-muted-foreground">上下文窗口（tokens）</FieldLabel>
          <Input value={draft.contextWindow} onChange={(event) => onDraftChange({ ...draft, contextWindow: event.target.value })} placeholder="262144" spellCheck={false} />
        </Field>
        <Field>
          <FieldLabel className="text-xs text-muted-foreground">显示名称（可选）</FieldLabel>
          <Input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} placeholder="默认与模型 ID 相同" spellCheck={false} />
        </Field>
        <Field>
          <FieldLabel className="text-xs text-muted-foreground">默认思考强度</FieldLabel>
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
      </FieldGroup>

      <div className="mt-3 rounded-md border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground/90">
            从提供商拉取模型列表
            <span className="ml-2 font-normal text-muted-foreground">推荐，免手抄 ID</span>
          </p>
          <Button
            variant="tile"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={saving || Boolean(providerId && catalog?.loading)}
            onClick={onLoadRemoteModels}
          >
            {providerId && catalog?.loading
              ? <Spinner className="size-3" />
              : <RefreshCw className="size-3" />}
            {providerId && catalog?.result?.ok ? "重新拉取" : "获取模型列表"}
          </Button>
        </div>
        <p className="mt-1 text-xs leading-4 text-muted-foreground">
          按所选提供商请求其模型目录；勾选多个可批量注册，上下文窗口对所有所选模型生效，之后可逐个编辑。
        </p>
        {providerId && catalog?.result && !catalog.result.ok ? (
          <p className="mt-1.5 text-xs leading-4 text-destructive">{catalog.result.message}</p>
        ) : null}
        {providerId && catalog?.result?.ok ? (
          <>
            <FieldGroup className="mt-2 max-h-44 gap-0.5 overflow-y-auto rounded-md border border-border bg-muted/30 p-1">
              {catalog.result.modelIds.map((modelId) => {
                const registered = registeredModelIds.has(modelId);
                const picked = pickedRemoteIds.includes(modelId);
                return (
                  <Field
                    orientation="horizontal"
                    key={modelId}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 font-mono text-xs",
                      registered ? "cursor-not-allowed text-muted-foreground/40" : picked ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"
                    )}
                  >
                    <Checkbox
                      id={`remote-model-${modelId}`}
                      disabled={registered}
                      checked={picked}
                      onCheckedChange={(checked) => onPickedRemoteChange(checked ? [...pickedRemoteIds, modelId] : pickedRemoteIds.filter((id) => id !== modelId))}
                    />
                    <FieldLabel htmlFor={`remote-model-${modelId}`} className="min-w-0 flex-1 truncate font-mono text-xs">{modelId}</FieldLabel>
                    {registered ? <MiniChip>已添加</MiniChip> : null}
                  </Field>
                );
              })}
            </FieldGroup>
            {pickedRemoteIds.length ? (
              <div className="mt-2 flex items-center gap-2">
                <span className="nums text-xs text-muted-foreground">已选 {pickedRemoteIds.length} 个</span>
                <Button
                  variant="tile"
                  size="sm"
                  className="h-7 px-2.5 text-xs text-foreground"
                  disabled={saving}
                  onClick={onAddSelectedRemoteModels}
                >
                  <Plus className="size-3" />
                  添加所选模型
                </Button>
                <Button variant="link" size="sm" className="h-auto p-0 text-xs text-muted-foreground" onClick={() => onPickedRemoteChange([])}>
                  清空选择
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="mt-3">
        <p className="text-xs font-medium text-muted-foreground">能力快捷登记</p>
        <FieldGroup className="mt-1.5 flex-row flex-wrap items-center gap-1.5">
          {QUICK_CAPABILITIES.map(({ key, label }) => (
            <Field orientation="horizontal" key={key} className="w-auto cursor-pointer gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground has-data-[state=checked]:border-foreground/60 has-data-[state=checked]:text-foreground">
              <Checkbox
                id={`capability-${key}`}
                checked={draft[key] === true}
                onCheckedChange={(checked) => onDraftChange({ ...draft, [key]: checked === true })}
              />
              <FieldLabel htmlFor={`capability-${key}`} className="text-xs">{label}</FieldLabel>
            </Field>
          ))}
        </FieldGroup>
        <p className="mt-1 text-xs text-muted-foreground/60">未勾选 = 能力未验证，参数不会盲目发送。</p>
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="tile" size="sm" disabled={saving} onClick={onAddModel}>
          {editingProfile ? "保存修改" : <><Plus className="size-3.5" /> 添加模型档案</>}
        </Button>
      </div>
    </section>
  );
}
