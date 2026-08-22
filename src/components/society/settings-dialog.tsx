import { useState, type ReactNode } from "react";
import { Activity, Check, CircleAlert, Loader2, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  SelectGroup,
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
  defaults?: { reasoningEffort?: ReasoningEffort };
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
  capabilities?: Record<string, string>;
  requestedReasoningEffort?: ReasoningEffortSelection;
  effectiveReasoningEffort?: ReasoningEffortSelection;
  reasoningFallbacks?: Array<{
    from: "xhigh" | "high";
    to: "high" | "provider-default";
    status: number;
    reason: string;
  }>;
}

/** Live catalog fetched from the provider's own GET /models endpoint. */
interface RemoteModelsResult {
  ok: boolean;
  message: string;
  modelIds: string[];
}

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
type ReasoningEffortSelection = ReasoningEffort | "provider-default";

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
  const [modelDraft, setModelDraft] = useState({
    name: "",
    modelId: "",
    contextWindow: "",
    providerProfileId: "",
    reasoningEffort: "high" as ReasoningEffort,
    reasoning: true,
    streaming: true,
    tools: true
  });
  const [probing, setProbing] = useState<string>();
  const [probeResults, setProbeResults] = useState<Record<string, TestResult>>({});
  const [savingEffort, setSavingEffort] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  /** When set, the bottom form edits this profile in place (PUT upserts). */
  const [editingProfile, setEditingProfile] = useState<ModelProfileView | null>(null);
  /** Per-provider remote catalog state for the "fetch model list" flow. */
  const [remote, setRemote] = useState<Record<string, { loading: boolean; result?: RemoteModelsResult }>>({});
  /** Model ids picked from the remote catalog for batch registration. */
  const [pickedRemoteIds, setPickedRemoteIds] = useState<string[]>([]);

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
      const response = await apiFetch("/api/model-config", {
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
      const response = await apiFetch("/api/model-config", {
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
    // Editing in place keeps the profile id (and every room binding to it);
    // a fresh draft mints a new id from the model id.
    const id = editingProfile ? editingProfile.id : `model-${slug(modelDraft.modelId)}`;
    const enabled = editingProfile ? editingProfile.enabled : true;
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
            enabled,
            defaults: { reasoningEffort: modelDraft.reasoningEffort },
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
      setModelDraft({
        name: "",
        modelId: "",
        contextWindow: "",
        providerProfileId: "",
        reasoningEffort: "high",
        reasoning: true,
        streaming: true,
        tools: true
      });
      setEditingProfile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  /** Fetch the provider's live model catalog (GET {baseURL}/models server-side). */
  const loadRemoteModels = async (): Promise<void> => {
    const providerId = modelDraft.providerProfileId;
    if (!providerId) {
      setError("先选择所属提供商，再获取模型列表。");
      return;
    }
    setRemote((current) => ({ ...current, [providerId]: { loading: true } }));
    setError(undefined);
    try {
      const response = await apiFetch(`/api/model-config/providers/${encodeURIComponent(providerId)}/remote-models`);
      const payload = await response.json().catch(() => undefined) as RemoteModelsResult | { message?: string };
      if (!response.ok) throw new Error((payload as { message?: string })?.message ?? `HTTP ${response.status}`);
      setRemote((current) => ({ ...current, [providerId]: { loading: false, result: payload as RemoteModelsResult } }));
    } catch (cause) {
      setRemote((current) => ({
        ...current,
        [providerId]: { loading: false, result: { ok: false, modelIds: [], message: cause instanceof Error ? cause.message : String(cause) } }
      }));
    }
  };

  /** Register every picked remote model in one PUT; context window applies to all. */
  const addSelectedRemoteModels = async (): Promise<void> => {
    const providerId = modelDraft.providerProfileId;
    if (!providerId || pickedRemoteIds.length === 0) return;
    const contextWindow = Number(modelDraft.contextWindow);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      setError("上下文窗口必须是正整数（token），批量添加时对所有所选模型生效，之后可逐个修改。");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/model-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelProfiles: pickedRemoteIds.map((modelId) => ({
            id: `model-${slug(modelId)}`,
            name: modelId,
            providerProfileId: providerId,
            modelId,
            contextWindow,
            enabled: true,
            defaults: { reasoningEffort: modelDraft.reasoningEffort },
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
          }))
        })
      });
      const payload = await response.json().catch(() => undefined) as ModelConfigView | { message?: string };
      if (!response.ok) throw new Error((payload as { message?: string })?.message ?? `HTTP ${response.status}`);
      setConfig(payload as ModelConfigView);
      onSaved();
      setPickedRemoteIds([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  /** Flip a profile's enabled flag without touching anything else. */
  const toggleModel = async (profile: ModelProfileView): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      const response = await apiFetch("/api/model-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelProfiles: [{
            id: profile.id,
            name: profile.name,
            providerProfileId: profile.providerProfileId,
            modelId: profile.modelId,
            contextWindow: profile.contextWindow,
            enabled: !profile.enabled,
            capabilities: profile.capabilities
          }]
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

  const saveReasoningEffort = async (
    profile: ModelProfileView,
    reasoningEffort: ReasoningEffortSelection
  ): Promise<void> => {
    setSavingEffort(profile.id);
    setError(undefined);
    try {
      const response = await apiFetch("/api/model-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelProfiles: [{
            id: profile.id,
            name: profile.name,
            providerProfileId: profile.providerProfileId,
            modelId: profile.modelId,
            contextWindow: profile.contextWindow,
            enabled: profile.enabled,
            capabilities: profile.capabilities,
            defaults: reasoningEffort === "provider-default" ? {} : { reasoningEffort }
          }]
        })
      });
      const payload = await response.json().catch(() => undefined) as ModelConfigView | { message?: string };
      if (!response.ok) throw new Error((payload as { message?: string })?.message ?? `HTTP ${response.status}`);
      setConfig(payload as ModelConfigView);
      setProbeResults((current) => {
        const next = { ...current };
        delete next[profile.id];
        return next;
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingEffort(undefined);
    }
  };

  const probe = async (profileId: string, reasoningEffort?: ReasoningEffort): Promise<void> => {
    setProbing(profileId);
    setError(undefined);
    try {
      const response = await apiFetch("/api/model-config/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelProfileId: profileId, ...(reasoningEffort ? { reasoningEffort } : {}) })
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
        <div className="flex min-w-0 max-h-[84vh] flex-col">
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

          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="space-y-7 p-6">
            <section>
              <p className="mb-2.5 text-[13px] font-medium text-foreground/80">提供商</p>
              <div className="space-y-2">
                {config.providers.map((provider) => (
                  <div key={provider.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-lg border border-border bg-muted/60 px-3 py-2">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] font-medium leading-5 text-foreground/90">
                        <span className="break-all">{provider.name}</span>
                        <span className="rounded border border-border bg-card px-1 font-mono text-[9px] font-normal text-muted-foreground">{provider.kind}</span>
                        {provider.hasKey ? <span className="text-[10px] font-normal text-emerald-400">密钥已配置</span> : <span className="text-[10px] font-normal text-amber-400">未配置密钥</span>}
                      </p>
                      <p className="truncate font-mono text-[10px] leading-4 text-muted-foreground/80">{provider.baseURL} · {provider.apiMode}</p>
                    </div>
                    <Badge variant="outline" className={cn("shrink-0 rounded-full border-border font-normal", provider.enabled ? "text-emerald-400" : "text-muted-foreground")}>
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
                        <p className="break-all font-mono text-[10px] leading-4 text-muted-foreground/80">{profile.modelId} · {config.providers.find((provider) => provider.id === profile.providerProfileId)?.name ?? profile.providerProfileId}</p>
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
                          onValueChange={(value) => void saveReasoningEffort(profile, value as ReasoningEffortSelection)}
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
                          onClick={() => void probe(profile.id, profile.defaults?.reasoningEffort)}
                        >
                          {probing === profile.id ? <Loader2 className="animate-spin" /> : <Activity />}
                          测试模型
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 rounded-lg px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() => {
                            setEditingProfile(profile);
                            setModelDraft({
                              name: profile.name,
                              modelId: profile.modelId,
                              contextWindow: String(profile.contextWindow),
                              providerProfileId: profile.providerProfileId,
                              reasoningEffort: profile.defaults?.reasoningEffort ?? "high",
                              reasoning: profile.capabilities.reasoning !== "no",
                              streaming: profile.capabilities.streaming !== "no",
                              tools: profile.capabilities.tools !== "no"
                            });
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn("h-7 rounded-lg px-2 text-[11px]", profile.enabled ? "text-emerald-400 hover:text-emerald-300" : "text-muted-foreground hover:text-foreground")}
                          disabled={saving}
                          onClick={() => void toggleModel(profile)}
                        >
                          {profile.enabled ? "已启用" : "已停用"}
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
                      onClick={() => {
                        setEditingProfile(null);
                        setModelDraft({ name: "", modelId: "", contextWindow: "", providerProfileId: "", reasoningEffort: "high", reasoning: true, streaming: true, tools: true });
                      }}
                    >
                      取消编辑
                    </Button>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Select value={modelDraft.providerProfileId} onValueChange={(value) => { setPickedRemoteIds([]); setModelDraft({ ...modelDraft, providerProfileId: value }); }}>
                    <SelectTrigger className="rounded-lg border-border bg-card text-foreground/90"><SelectValue placeholder="所属提供商" /></SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {config.providers.filter((provider) => provider.enabled).map((provider) => (
                          <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Input value={modelDraft.modelId} onChange={(event) => setModelDraft({ ...modelDraft, modelId: event.target.value })} placeholder="模型 ID（如 org/model-name）" spellCheck={false} />
                  <Input value={modelDraft.contextWindow} onChange={(event) => setModelDraft({ ...modelDraft, contextWindow: event.target.value })} placeholder="上下文窗口（tokens，如 262144）" spellCheck={false} />
                  <Input value={modelDraft.name} onChange={(event) => setModelDraft({ ...modelDraft, name: event.target.value })} placeholder="显示名称（可选）" spellCheck={false} />
                  <Select value={modelDraft.reasoningEffort} onValueChange={(value) => setModelDraft({ ...modelDraft, reasoningEffort: value as ReasoningEffort })}>
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
                      variant="outline"
                      size="sm"
                      className="h-7 rounded-lg border-border bg-card px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      disabled={saving || Boolean(modelDraft.providerProfileId && remote[modelDraft.providerProfileId]?.loading)}
                      onClick={() => void loadRemoteModels()}
                    >
                      {modelDraft.providerProfileId && remote[modelDraft.providerProfileId]?.loading
                        ? <Loader2 className="size-3 animate-spin" />
                        : <RefreshCw className="size-3" />}
                      {modelDraft.providerProfileId && remote[modelDraft.providerProfileId]?.result?.ok ? "重新拉取" : "获取模型列表"}
                    </Button>
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-muted-foreground/70">
                    Base URL 需以 /v1 结尾（如 https://api.example.com/v1）。勾选后批量注册，上下文窗口用上方输入值，添加后可随时逐个编辑。
                  </p>
                  {modelDraft.providerProfileId && remote[modelDraft.providerProfileId]?.result && !remote[modelDraft.providerProfileId]!.result!.ok ? (
                    <p className="mt-1.5 text-[11px] leading-4 text-red-400">{remote[modelDraft.providerProfileId]!.result!.message}</p>
                  ) : null}
                  {modelDraft.providerProfileId && remote[modelDraft.providerProfileId]?.result?.ok ? (
                    <>
                      <div className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border bg-card p-1">
                        {remote[modelDraft.providerProfileId]!.result!.modelIds.map((modelId) => {
                          const registered = config.modelProfiles.some((profile) => profile.providerProfileId === modelDraft.providerProfileId && profile.modelId === modelId);
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
                                onChange={(event) => setPickedRemoteIds((current) => event.target.checked ? [...current, modelId] : current.filter((id) => id !== modelId))}
                              />
                              <span className="min-w-0 flex-1 truncate">{modelId}</span>
                              {registered ? <span className="rounded border border-border bg-muted px-1 text-[9px]">已添加</span> : null}
                            </label>
                          );
                        })}
                      </div>
                      {pickedRemoteIds.length ? (
                        <div className="mt-2 flex items-center gap-2">
                          <span className="nums text-[11px] text-muted-foreground">已选 {pickedRemoteIds.length} 个</span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 rounded-lg border-border bg-card px-2 text-[11px] text-foreground hover:bg-muted"
                            disabled={saving}
                            onClick={() => void addSelectedRemoteModels()}
                          >
                            <Plus className="size-3" />
                            添加所选模型
                          </Button>
                          <button type="button" className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground" onClick={() => setPickedRemoteIds([])}>
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
                        checked={modelDraft[key] === true}
                        onChange={(event) => setModelDraft({ ...modelDraft, [key]: event.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                  <span className="self-center text-[10px] text-muted-foreground/60">未勾选 = 能力未验证，参数不会盲目发送</span>
                </div>
                <Button variant="outline" size="sm" className="mt-2 rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" disabled={saving} onClick={() => void addModel()}>
                  {editingProfile ? "保存修改" : <><Plus className="size-3.5" /> 添加模型档案</>}
                </Button>
              </div>
            </section>

            <section>
              <p className="mb-2.5 text-[13px] font-medium text-foreground/80">全局默认</p>
              <div className="flex items-center gap-3">
                <Select value={globalModel || "__automatic__"} onValueChange={(value) => setGlobalModel(value === "__automatic__" ? "" : value)}>
                  <SelectTrigger className="min-w-0 flex-1 rounded-lg border-border bg-card text-foreground/90"><SelectValue placeholder="新房间默认模型" /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="__automatic__">（不指定：使用第一个启用的模型）</SelectItem>
                      {config.modelProfiles.filter((profile) => profile.enabled).map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                      ))}
                    </SelectGroup>
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

            {error ? <p className="text-[13px] text-red-400">{error}</p> : null}
          </div>
          </div>

          <div className="flex items-center justify-between border-t border-border/60 bg-card px-6 py-4">
            <p className="text-xs text-muted-foreground">模型测试仅在你点击“测试模型”时发起。</p>
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
