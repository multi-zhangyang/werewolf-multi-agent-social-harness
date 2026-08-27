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

/** Provider list plus the dashed "add provider" form. */
export function ProviderSection({ providers, draft, onDraftChange, onAdd, saving }: {
  providers: ProviderView[];
  draft: ProviderDraft;
  onDraftChange: (draft: ProviderDraft) => void;
  onAdd: () => void;
  saving: boolean;
}): ReactNode {
  return (
    <section>
      <p className="mb-2.5 text-[13px] font-medium text-foreground/80">提供商</p>
      <div className="space-y-2">
        {providers.map((provider) => (
          <div key={provider.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-lg border border-border bg-muted/60 px-3 py-2">
            <div className="min-w-0 flex-1 basis-56">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] font-medium leading-5 text-foreground/90">
                <span className="break-all">{provider.name}</span>
                <MiniChip className="font-mono">{provider.kind}</MiniChip>
                {provider.hasKey ? <span className="text-[10px] font-normal text-live">密钥已配置</span> : <span className="text-[10px] font-normal text-warn">未配置密钥</span>}
              </p>
              <p className="truncate font-mono text-[10px] leading-4 text-muted-foreground/80">{provider.baseURL} · {provider.apiMode}</p>
            </div>
            <Badge variant="outline" className={cn("shrink-0 rounded-full border-border font-normal", provider.enabled ? "text-live" : "text-muted-foreground")}>
              {provider.enabled ? "启用" : "停用"}
            </Badge>
          </div>
        ))}
        {providers.length === 0 ? <p className="text-xs text-muted-foreground/80">还没有提供商档案。环境变量（OPENAI_BASE_URL）会作为首个提供商自动出现。</p> : null}
      </div>
      <div className="mt-3 rounded-lg border border-dashed border-border p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">添加提供商</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-foreground/70">名称</span>
            <Input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} placeholder="如 MyProvider" spellCheck={false} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-foreground/70">Base URL</span>
            <Input value={draft.baseURL} onChange={(event) => onDraftChange({ ...draft, baseURL: event.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-[11px] font-medium text-foreground/70">API 密钥（只写入本机 .env.local）</span>
            <Input type="password" value={draft.apiKey} onChange={(event) => onDraftChange({ ...draft, apiKey: event.target.value })} placeholder="sk-…" spellCheck={false} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-[11px] font-medium text-foreground/70">API 模式</span>
            <Select value={draft.apiMode} onValueChange={(value) => onDraftChange({ ...draft, apiMode: value })}>
              <SelectTrigger className="rounded-lg border-border bg-card text-foreground/90"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="chat-completions">chat-completions</SelectItem>
                  <SelectItem value="responses">responses</SelectItem>
                  <SelectItem value="auto">auto</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground/80">
          Base URL 必须以 <span className="font-mono">/v1</span> 结尾（如 https://api.example.com/v1）；API 密钥只写入本机 .env.local，不回显、不进入模型档案与房间快照。
        </p>
        <Button variant="tile" size="sm" className="mt-2" disabled={saving} onClick={onAdd}>
          <Plus className="size-3.5" /> 添加提供商
        </Button>
      </div>
    </section>
  );
}
