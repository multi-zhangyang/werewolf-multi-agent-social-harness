import { useState, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "../shared";
import { GlobalDefaultsSection } from "./global-defaults-section";
import { ModelFormSection } from "./model-form-section";
import { ModelProfilesSection } from "./model-profiles-section";
import { ProviderSection } from "./provider-section";
import {
  EMPTY_MODEL_DRAFT,
  slug,
  type ModelConfigView,
  type ModelDraft,
  type ModelProfileView,
  type ProviderDraft,
  type ReasoningEffort,
  type ReasoningEffortSelection,
  type RemoteModelsResult,
  type TestResult
} from "./types";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/** Model configuration center: providers, model profiles, global defaults. */
export function SettingsDialog({ open, onOpenChange, onSaved }: SettingsDialogProps): ReactNode {
  const [config, setConfig] = useState<ModelConfigView>({ providers: [], modelProfiles: [], globalDefaults: {} });
  const [loaded, setLoaded] = useState(false);
  const [globalModel, setGlobalModel] = useState<string>("");
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({ name: "", baseURL: "", apiKey: "", apiMode: "chat-completions" });
  const [modelDraft, setModelDraft] = useState<ModelDraft>(EMPTY_MODEL_DRAFT);
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

  const putConfig = async (body: unknown, options?: { saved?: boolean }): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    try {
      const response = await apiFetch("/api/model-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => undefined) as ModelConfigView | { message?: string };
      if (!response.ok) throw new Error((payload as { message?: string })?.message ?? `HTTP ${response.status}`);
      setConfig(payload as ModelConfigView);
      if (options?.saved) onSaved();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = (): Promise<void> => putConfig(
    globalModel ? { globalDefaults: { modelProfileId: globalModel } } : { globalDefaults: {} },
    { saved: true }
  ).then(() => undefined);

  const addProvider = async (): Promise<void> => {
    if (!providerDraft.name.trim() || !providerDraft.baseURL.trim()) {
      setError("提供商名称与 Base URL 不能为空。");
      return;
    }
    const ok = await putConfig({
      providers: [{
        id: `provider-${slug(providerDraft.name)}`,
        name: providerDraft.name.trim(),
        kind: "openai-compatible",
        baseURL: providerDraft.baseURL.trim(),
        ...(providerDraft.apiKey.trim() ? { apiKey: providerDraft.apiKey.trim() } : {}),
        apiMode: providerDraft.apiMode,
        enabled: true
      }]
    });
    if (ok) setProviderDraft({ name: "", baseURL: "", apiKey: "", apiMode: "chat-completions" });
  };

  const draftCapabilities = (): Record<string, string> => ({
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
  });

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
    const ok = await putConfig({
      modelProfiles: [{
        id,
        name: modelDraft.name.trim() || modelDraft.modelId.trim(),
        providerProfileId: modelDraft.providerProfileId,
        modelId: modelDraft.modelId.trim(),
        contextWindow,
        enabled,
        defaults: { reasoningEffort: modelDraft.reasoningEffort },
        capabilities: draftCapabilities()
      }]
    });
    if (ok) {
      setModelDraft(EMPTY_MODEL_DRAFT);
      setEditingProfile(null);
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
    const ok = await putConfig({
      modelProfiles: pickedRemoteIds.map((modelId) => ({
        id: `model-${slug(modelId)}`,
        name: modelId,
        providerProfileId: providerId,
        modelId,
        contextWindow,
        enabled: true,
        defaults: { reasoningEffort: modelDraft.reasoningEffort },
        capabilities: draftCapabilities()
      }))
    }, { saved: true });
    if (ok) setPickedRemoteIds([]);
  };

  /** Flip a profile's enabled flag without touching anything else. */
  const toggleModel = (profile: ModelProfileView): Promise<void> => putConfig({
    modelProfiles: [{
      id: profile.id,
      name: profile.name,
      providerProfileId: profile.providerProfileId,
      modelId: profile.modelId,
      contextWindow: profile.contextWindow,
      enabled: !profile.enabled,
      capabilities: profile.capabilities
    }]
  }, { saved: true }).then(() => undefined);

  const removeModel = async (id: string): Promise<void> => {
    const ok = await putConfig({ removeModelProfileIds: [id] });
    if (ok && globalModel === id) setGlobalModel("");
  };

  const saveReasoningEffort = async (profile: ModelProfileView, reasoningEffort: ReasoningEffortSelection): Promise<void> => {
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

  const registeredModelIds = new Set(
    config.modelProfiles
      .filter((profile) => profile.providerProfileId === modelDraft.providerProfileId)
      .map((profile) => profile.modelId)
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setLoaded(false); setError(undefined); } onOpenChange(next); }}>
      <DialogContent className="max-w-2xl rounded-xl border-border bg-card p-0 text-foreground shadow-2xl">
        <div className="flex min-w-0 max-h-[84vh] flex-col">
          <div className="shrink-0 border-b border-border/60 p-6">
            <DialogHeader className="gap-2 text-left">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted text-foreground/80">
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
          <div className="space-y-6 p-6">
            <ProviderSection
              providers={config.providers}
              draft={providerDraft}
              onDraftChange={setProviderDraft}
              onAdd={() => void addProvider()}
              saving={saving}
            />

            <ModelProfilesSection
              profiles={config.modelProfiles}
              providers={config.providers}
              probeResults={probeResults}
              probing={probing}
              savingEffort={savingEffort}
              saving={saving}
              onProbe={(profileId, reasoningEffort) => void probe(profileId, reasoningEffort)}
              onEdit={(profile) => {
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
              onToggle={(profile) => void toggleModel(profile)}
              onRemove={(id) => void removeModel(id)}
              onSaveReasoningEffort={(profile, reasoningEffort) => void saveReasoningEffort(profile, reasoningEffort)}
            />

            <ModelFormSection
              editingProfile={editingProfile}
              draft={modelDraft}
              onDraftChange={setModelDraft}
              providers={config.providers}
              registeredModelIds={registeredModelIds}
              remote={remote}
              pickedRemoteIds={pickedRemoteIds}
              onPickedRemoteChange={setPickedRemoteIds}
              onLoadRemoteModels={() => void loadRemoteModels()}
              onAddSelectedRemoteModels={() => void addSelectedRemoteModels()}
              onAddModel={() => void addModel()}
              onCancelEditing={() => {
                setEditingProfile(null);
                setModelDraft(EMPTY_MODEL_DRAFT);
              }}
              saving={saving}
            />

            <GlobalDefaultsSection
              profiles={config.modelProfiles}
              value={globalModel}
              onChange={setGlobalModel}
              onSave={() => void save()}
              saving={saving}
            />

            {error ? <ErrorNote>{error}</ErrorNote> : null}
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
