/** Shared view types and small helpers for the model configuration dialog. */

export interface ProviderView {
  id: string;
  name: string;
  kind: string;
  baseURL: string;
  apiMode: string;
  enabled: boolean;
  hasKey: boolean;
}

export interface ModelProfileView {
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

export interface ModelConfigView {
  providers: ProviderView[];
  modelProfiles: ModelProfileView[];
  globalDefaults: { modelProfileId?: string; contextPolicyId?: string };
}

export interface TestResult {
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
export interface RemoteModelsResult {
  ok: boolean;
  message: string;
  modelIds: string[];
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ReasoningEffortSelection = ReasoningEffort | "provider-default";

/** The add/edit model form state, shared by the form section and handlers. */
export interface ModelDraft {
  name: string;
  modelId: string;
  contextWindow: string;
  providerProfileId: string;
  reasoningEffort: ReasoningEffort;
  reasoning: boolean;
  streaming: boolean;
  tools: boolean;
}

export const EMPTY_MODEL_DRAFT: ModelDraft = {
  name: "",
  modelId: "",
  contextWindow: "",
  providerProfileId: "",
  reasoningEffort: "high",
  reasoning: true,
  streaming: true,
  tools: true
};

export interface ProviderDraft {
  name: string;
  baseURL: string;
  apiKey: string;
  apiMode: string;
}

export const CAPABILITY_CHOICES = [
  { key: "streaming", label: "流式输出" },
  { key: "tools", label: "工具调用" },
  { key: "reasoning", label: "思考/推理参数" },
  { key: "reasoningSummary", label: "推理摘要" },
  { key: "structuredOutput", label: "结构化输出" },
  { key: "parallelToolCalls", label: "并行工具" }
] as const;

/** Capabilities offered as quick checkboxes in the add-model form. */
export const QUICK_CAPABILITIES = [
  { key: "streaming", label: "流式输出" },
  { key: "tools", label: "工具调用" },
  { key: "reasoning", label: "思考/推理参数" }
] as const;

export function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "profile";
}

export function capabilityName(key: string): string {
  return CAPABILITY_CHOICES.find((entry) => entry.key === key)?.label ?? key;
}
