import { useState, type ReactNode } from "react";
import { Activity, Check, Loader2, Plus, Settings2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface ProviderView {
  id: string;
  name: string;
  kind: string;
  baseURL: string;
  apiMode: string;
  enabled: boolean;
  hasKey: boolean;
}

interface ModelProfileView {
  id: string;
  name: string;
  providerProfileId: string;
  modelId: string;
  contextWindow: number;
  contextLabel: string;
  contextWindowSource: string;
  enabled: boolean;
  capabilities: Record<string, string>;
}

interface ModelConfigView {
  providers: ProviderView[];
  modelProfiles: ModelProfileView[];
  globalDefaults: { modelProfileId?: string; contextPolicyId?: string };
}

interface TestResult {
  ok: boolean;
  message: string;
  modelIds?: string[];
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

const CAPABILITY_CHOICES = [
  { key: "streaming", label: "流式输出" },
  { key: "tools", label: "工具调用" },
  { key: "reasoning", label: "思考/推理参数" },
  { key: "reasoningSummary", label: "推理摘要" },
  { key: "structuredOutput", label: "结构化输出" },
  { key: "parallelToolCalls", label: "并行工具" }
] as const;

/** Capabilities offered as quick checkboxes in the add-model form. */
const QUICK_CAPABILITIES = [
  { key: "streaming", label: "流式输出" },
  { key: "tools", label: "工具调用" },
  { key: "reasoning", label: "思考/推理参数" }
] as const;

export function SettingsDialog({ open, onOpenChange, onSaved }: SettingsDialogProps): ReactNode {
  const [config, setConfig] = useState<ModelConfigView>({ providers: [], modelProfiles: [], globalDefaults: {} });
  const [loaded, setLoaded] = useState(false);
  const [globalModel, setGlobalModel] = useState<string>("");
  const [providerDraft, setProviderDraft] = useState({ name: "", baseURL: "", apiKey: "", apiMode: "chat-completions" });
  const [modelDraft, setModelDraft] = useState({ name: "", modelId: "", contextWindow: "", providerProfileId: "", reasoning: true, streaming: true, tools: true });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>();
  const [probing, setProbing] = useState<string>();
  const [probeResults, setProbeResults] = useState<Record<string, TestResult>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = async (): Promise<void> => {
    try {
      const response = await fetch("/api/model-config");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json() as ModelConfigView;
      setConfig(next);
      setGlobalModel(next.globalDefaults.modelProfileId ?? "");
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (open && !loaded) void load();

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/model-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(globalModel ? { globalDefaults: { modelProfileId: globalModel } } : { globalDefaults: {} }),
          providers: [],
          modelProfiles: []
        })
      });
      const payload = await response.json().catch(() => undefined) as ModelConfigView | { message?: string };
      if (!response.ok) throw new Error((payload as { message?: string })?.message ?? `HTTP ${response.status}`);
      setConfig(payload as ModelConfigView);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const addProvider = async (): Promise<void> => {
    if (!providerDraft.name.trim() || !providerDraft.baseURL.trim()) {
      setError("提供商名称与 Base URL 不能为空。");
      return;
    }
    const id = `provider-${slug(providerDraft.name)}`;
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/model-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providers: [{
            id,
            name: providerDraft.name.trim(),
            kind: "openai-compatible",
            baseURL: providerDraft.baseURL.trim(),
            ...(providerDraft.apiKey.trim() ? { apiKey: providerDraft.apiKey.trim() } : {}),
            apiMode: providerDraft.apiMode,
            enabled: true
          }]
        })
      });
      const payload = await response.json().catch(() => undefined) as ModelConfigView | { message?: string };
      if (!response.ok) throw new Error((payload as { message?: string })?.message ?? `HTTP ${response.status}`);
      setConfig(payload as ModelConfigView);
      setProviderDraft({ name: "", baseURL: "", apiKey: "", apiMode: "chat-completions" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const addModel = async (): Promise<void> => {
    if (!modelDraft.modelId.trim() || !modelDraft.providerProfileId) {
      setError("模型 ID 与所属提供商不能为空。");
      return;
    }
    const contextWindow = Number(modelDraft.contextWindow);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      setError("上下文窗口必须是正整数（token）。");
      return;
    }
    const id = `model-${slug(modelDraft.modelId)}`;
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/model-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelProfiles: [{
            id,
            name: modelDraft.name.trim() || modelDraft.modelId.trim(),
            providerProfileId: modelDraft.providerProfileId,
            modelId: modelDraft.modelId.trim(),
            contextWindow,
            enabled: true,
            capabilities: {
              streaming: modelDraft.streaming ? "yes" : "unknown",
              tools: modelDraft.tools ? "yes" : "unknown",
              parallelToolCalls: "unknown",
              reasoning: modelDraft.reasoning ? "yes" : "unknown",
              reasoningSummary: "unknown",
              structuredOutput: "unknown",
              promptCaching: "unknown",
              nativeCompaction: "unknown",
              seed: "unknown",
              stopSequences: "unknown",
              imageInput: "unknown",
              maxOutputTokens: "unknown"
            }
          }]
        })
      });
      const payload = await response.json().catch(() => undefined) as ModelConfigView | { message?: string };
      if (!response.ok) throw new Error((payload as { message?: string })?.message ?? `HTTP ${response.status}`);
      setConfig(payload as ModelConfigView);
      setModelDraft({ name: "", modelId: "", contextWindow: "", providerProfileId: "", reasoning: true, streaming: true, tools: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const removeModel = async (id: string): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/model-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeModelProfileIds: [id] })
      });
      const payload = await response.json().catch(() => undefined) as ModelConfigView | { message?: string };
      if (!response.ok) throw new Error((payload as { message?: string })?.message ?? `HTTP ${response.status}`);
      setConfig(payload as ModelConfigView);
      if (globalModel === id) setGlobalModel("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestResult(undefined);
    try {
      const response = await fetch("/api/settings/test", { method: "POST" });
      const payload = await response.json().catch(() => undefined) as TestResult;
      setTestResult(payload ?? { ok: false, message: `HTTP ${response.status}` });
    } catch (cause) {
      setTestResult({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  const probe = async (profileId: string): Promise<void> => {
    setProbing(profileId);
    setError(undefined);
    try {
      const response = await fetch("/api/model-config/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelProfileId: profileId })
      });
      const payload = await response.json().catch(() => undefined) as TestResult & { capabilities?: Record<string, string> };
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
      setProbeResults((current) => ({ ...current, [profileId]: payload }));
      const refreshed = await fetch("/api/model-config");
      if (refreshed.ok) {
        const next = await refreshed.json() as ModelConfigView;
        setConfig(next);
        setGlobalModel(next.globalDefaults.modelProfileId ?? "");
      }
    } catch (cause) {
      setProbeResults((current) => ({ ...current, [profileId]: { ok: false, message: cause instanceof Error ? cause.message : String(cause) } }));
    } finally {
      setProbing(undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setLoaded(false); setError(undefined); } onOpenChange(next); }}>
      <DialogContent className="max-w-2xl rounded-xl border-border bg-card p-0 text-foreground shadow-2xl">
        <div className="flex max-h-[84vh] flex-col">
          <div className="shrink-0 border-b border-border/60 p-6">
            <DialogHeader className="gap-2 text-left">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-muted text-foreground/80">
                  <Settings2 className="size-5" />
                </span>
                <div>
                  <DialogTitle className="text-lg tracking-tight">模型配置中心</DialogTitle>
                  <DialogDescription className="mt-0.5 leading-5 text-muted-foreground">
                    管理提供商、模型档案与全局默认值。密钥只保存在本机 <span className="font-mono text-muted-foreground">.env.local</span>，模型档案保存在本机 <span className="font-mono text-muted-foreground">data/model-settings.json</span>，都不进入代码仓库。
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-7 p-6">
            <section>
              <p className="mb-2.5 text-[13px] font-medium text-foreground/80">提供商</p>
              <div className="space-y-2">
                {config.providers.map((provider) => (
                  <div key={provider.id} className="flex items-center justify-between rounded-lg border border-border bg-muted/60 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-foreground/90">
                        {provider.name}
                        <span className="ml-2 rounded border border-border bg-card px-1 font-mono text-[9px] text-muted-foreground">{provider.kind}</span>
                        {provider.hasKey ? <span className="ml-1.5 text-[10px] text-emerald-400">密钥已配置</span> : <span className="ml-1.5 text-[10px] text-amber-400">未配置密钥</span>}
                      </p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground/80">{provider.baseURL} · {provider.apiMode}</p>
                    </div>
                    <Badge variant="outline" className={cn("rounded-full border-border font-normal", provider.enabled ? "text-emerald-400" : "text-muted-foreground")}>
                      {provider.enabled ? "启用" : "停用"}
                    </Badge>
                  </div>
                ))}
                {config.providers.length === 0 ? <p className="text-xs text-muted-foreground/80">还没有提供商档案。环境变量（OPENAI_BASE_URL）会作为首个提供商自动出现。</p> : null}
              </div>
              <div className="mt-3 rounded-lg border border-dashed border-border p-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">添加提供商</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-foreground/70">名称</span>
                    <Input value={providerDraft.name} onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })} placeholder="如 MyProvider" spellCheck={false} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-foreground/70">Base URL</span>
                    <Input value={providerDraft.baseURL} onChange={(event) => setProviderDraft({ ...providerDraft, baseURL: event.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} />
                  </label>
                  <label className="flex flex-col gap-1 sm:col-span-2">
                    <span className="text-[11px] font-medium text-foreground/70">API 密钥（只写入本机 .env.local）</span>
                    <Input type="password" value={providerDraft.apiKey} onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })} placeholder="sk-…" spellCheck={false} autoComplete="off" />
                  </label>
                  <label className="flex flex-col gap-1 sm:col-span-2">
                    <span className="text-[11px] font-medium text-foreground/70">API 模式</span>
                    <Select value={providerDraft.apiMode} onValueChange={(value) => setProviderDraft({ ...providerDraft, apiMode: value })}>
                      <SelectTrigger className="rounded-lg border-border bg-card text-foreground/90"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="chat-completions">chat-completions</SelectItem>
                        <SelectItem value="responses">responses</SelectItem>
                        <SelectItem value="auto">auto</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-muted-foreground/80">
                  Base URL 示例：https://api.example.com/v1；API 密钥只写入本机 .env.local，不回显、不进入模型档案与房间快照。
                </p>
                <Button variant="outline" size="sm" className="mt-2 rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" disabled={saving} onClick={() => void addProvider()}>
                  <Plus className="size-3.5" /> 添加提供商
                </Button>
              </div>
            </section>

            <section>
              <div className="mb-2.5 flex items-center justify-between">
                <p className="text-[13px] font-medium text-foreground/80">模型档案</p>
                <span className="nums font-mono text-xs text-muted-foreground/80">{config.modelProfiles.length} 个</span>
              </div>
              <div className="space-y-2">
                {config.modelProfiles.map((profile) => (
                  <div key={profile.id} className="rounded-lg border border-border bg-muted/60 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-foreground/90">
                          {profile.name}
                          <span className="ml-2 rounded border border-border bg-card px-1 font-mono text-[9px] text-muted-foreground">{profile.contextLabel}</span>
                          <span className={cn("ml-1.5 font-mono text-[9px]", profile.contextWindowSource === "manual" ? "text-muted-foreground" : "text-amber-400/90")}>
                            {profile.contextWindowSource === "manual" ? "手动登记" : "已知档案"}
                          </span>
                        </p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground/80">{profile.modelId} · {config.providers.find((provider) => provider.id === profile.providerProfileId)?.name ?? profile.providerProfileId}</p>
                        {Object.entries(profile.capabilities).some(([key, state]) => state !== "unknown" && key !== "maxOutputTokens") ? (
                          <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/70">
                            {Object.entries(profile.capabilities).filter(([key, state]) => state !== "unknown" && key !== "maxOutputTokens").map(([key, state]) => (
                              <span key={key} className="whitespace-nowrap">{capabilityName(key)}:{state === "yes" ? "✓" : "✗"}</span>
                            ))}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-[10px] text-muted-foreground/50">能力未验证——参数不会盲目发送；点击「探测」实测。</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 rounded-lg border-border bg-card px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                          disabled={Boolean(probing)}
                          onClick={() => void probe(profile.id)}
                        >
                          {probing === profile.id ? <Loader2 className="size-3 animate-spin" /> : null}
                          探测
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`移除 ${profile.name}`}
                          disabled={saving || Boolean(probing)}
                          onClick={() => void removeModel(profile.id)}
                          className="size-7 rounded-md text-muted-foreground/60 hover:bg-border hover:text-red-400"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                    {probeResults[profile.id] ? (
                      <p className={cn("mt-1.5 text-[11px]", probeResults[profile.id].ok ? "text-emerald-400" : "text-red-400")}>
                        {probeResults[profile.id].message}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="mt-3 rounded-lg border border-dashed border-border p-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">添加模型档案</p>
                <div className="grid grid-cols-2 gap-2">
                  <Select value={modelDraft.providerProfileId} onValueChange={(value) => setModelDraft({ ...modelDraft, providerProfileId: value })}>
                    <SelectTrigger className="rounded-lg border-border bg-card text-foreground/90"><SelectValue placeholder="所属提供商" /></SelectTrigger>
                    <SelectContent>
                      {config.providers.filter((provider) => provider.enabled).map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input value={modelDraft.modelId} onChange={(event) => setModelDraft({ ...modelDraft, modelId: event.target.value })} placeholder="模型 ID（如 org/model-name）" spellCheck={false} />
                  <Input value={modelDraft.contextWindow} onChange={(event) => setModelDraft({ ...modelDraft, contextWindow: event.target.value })} placeholder="上下文窗口（tokens，如 262144）" spellCheck={false} />
                  <Input value={modelDraft.name} onChange={(event) => setModelDraft({ ...modelDraft, name: event.target.value })} placeholder="显示名称（可选）" spellCheck={false} />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {QUICK_CAPABILITIES.map(({ key, label }) => (
                    <label key={key} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground has-checked:border-foreground/60 has-checked:text-foreground">
                      <input
                        type="checkbox"
                        className="size-3 accent-foreground"
                        checked={modelDraft[key] === true}
                        onChange={(event) => setModelDraft({ ...modelDraft, [key]: event.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                  <span className="self-center text-[10px] text-muted-foreground/60">未勾选 = 能力未验证，参数不会盲目发送</span>
                </div>
                <Button variant="outline" size="sm" className="mt-2 rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" disabled={saving} onClick={() => void addModel()}>
                  <Plus className="size-3.5" /> 添加模型档案
                </Button>
              </div>
            </section>

            <section>
              <p className="mb-2.5 text-[13px] font-medium text-foreground/80">全局默认</p>
              <div className="flex items-center gap-3">
                <Select value={globalModel} onValueChange={setGlobalModel}>
                  <SelectTrigger className="rounded-lg border-border bg-card text-foreground/90"><SelectValue placeholder="新房间默认模型" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">（不指定：使用第一个启用的模型）</SelectItem>
                    {config.modelProfiles.filter((profile) => profile.enabled).map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" className="shrink-0 rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" disabled={saving} onClick={() => void save()}>
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  保存全局默认
                </Button>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground/80">
                每个 Agent 最终生效配置按「系统默认 → 模型档案 → 全局默认 → 房间 → 单 Agent 覆盖」逐级解析；创建房间时可以看到每个席位的最终模型。
              </p>
            </section>

            {testResult ? (
              <section className={cn("rounded-2xl border p-4", testResult.ok ? "border-emerald-400/30 bg-emerald-400/10" : "border-red-400/30 bg-red-400/10")}>
                <p className={cn("text-[13px]", testResult.ok ? "text-emerald-700" : "text-red-400")}>
                  {testResult.ok ? <Check className="mr-1 inline size-3.5" /> : null}
                  {testResult.message}
                </p>
              </section>
            ) : null}

            {error ? <p className="text-[13px] text-red-400">{error}</p> : null}
          </div>
          </div>

          <div className="flex items-center justify-between border-t border-border/60 bg-card px-6 py-4">
            <Button variant="outline" size="sm" className="rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" disabled={testing || saving} onClick={() => void test()}>
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
              测试默认提供商连接
            </Button>
            <Button variant="ghost" className="text-muted-foreground hover:bg-muted hover:text-foreground" disabled={saving} onClick={() => { setLoaded(false); onOpenChange(false); }}>
              关闭
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "profile";
}

function capabilityName(key: string): string {
  return CAPABILITY_CHOICES.find((entry) => entry.key === key)?.label ?? key;
}