import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import type { ProviderDraft, ProviderView } from "./types";

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }): ReactNode {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** Provider list plus the "add provider" form. */
export function ProviderSection({ providers, draft, onDraftChange, onAdd, saving }: {
  providers: ProviderView[];
  draft: ProviderDraft;
  onDraftChange: (draft: ProviderDraft) => void;
  onAdd: () => void;
  saving: boolean;
}): ReactNode {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">提供商</h3>
        <span className="text-xs text-muted-foreground">模型请求经提供商的 Base URL 发出</span>
      </div>

      <div className="flex flex-col gap-2">
        {providers.map((provider) => (
          <div key={provider.id} className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span className="truncate">{provider.name}</span>
                <MiniChip className="shrink-0 font-mono">{provider.kind}</MiniChip>
              </p>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{provider.baseURL} · {provider.apiMode}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className={cn("text-xs", provider.hasKey ? "text-live" : "text-warn")}>
                {provider.hasKey ? "密钥已配置" : "未配置密钥"}
              </span>
              <Badge variant="outline" className={cn("rounded-full border-border font-normal", provider.enabled ? "text-live" : "text-muted-foreground")}>
                {provider.enabled ? "启用" : "停用"}
              </Badge>
            </div>
          </div>
        ))}
        {providers.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            还没有提供商档案。环境变量（OPENAI_BASE_URL）会作为首个提供商自动出现。
          </p>
        ) : null}
      </div>

      <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
        <p className="text-sm font-medium text-foreground/90">添加提供商</p>
        <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <Field label="名称">
            <Input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} placeholder="如 MyProvider" spellCheck={false} />
          </Field>
          <Field label="Base URL">
            <Input value={draft.baseURL} onChange={(event) => onDraftChange({ ...draft, baseURL: event.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} />
          </Field>
          <Field label="API 密钥（只写入本机 .env.local）" className="sm:col-span-2">
            <Input type="password" value={draft.apiKey} onChange={(event) => onDraftChange({ ...draft, apiKey: event.target.value })} placeholder="sk-…" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="API 模式" className="sm:col-span-2">
            <Select value={draft.apiMode} onValueChange={(value) => onDraftChange({ ...draft, apiMode: value })}>
              <SelectTrigger className="bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="chat-completions">chat-completions</SelectItem>
                  <SelectItem value="responses">responses</SelectItem>
                  <SelectItem value="auto">auto</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="mt-3 flex flex-col-reverse items-start justify-between gap-3 sm:flex-row sm:items-center">
          <p className="text-xs leading-4 text-muted-foreground">
            Base URL 需以 <span className="font-mono">/v1</span> 结尾；密钥不回显、不进入模型档案与房间快照。
          </p>
          <Button variant="tile" size="sm" className="shrink-0" disabled={saving} onClick={onAdd}>
            <Plus className="size-3.5" /> 添加提供商
          </Button>
        </div>
      </div>
    </section>
  );
}
