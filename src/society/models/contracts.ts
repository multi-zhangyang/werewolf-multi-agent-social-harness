/**
 * Model, provider and context-policy configuration contracts.
 *
 * Model configuration is a first-class capability of every agent. A
 * character is not a role, a role is not a model, and a model is not a
 * personality: each participant resolves its own model binding through the
 * precedence chain in `resolver.ts`.
 */

export type CapabilityState = "yes" | "no" | "unknown";

/** The internal cognitive phases of one peer agent (not separate agents). */
export type CognitivePhase =
  | "perceive"
  | "recall"
  | "appraise"
  | "infer"
  | "plan"
  | "decide"
  | "act"
  | "reflect"
  | "consolidate";

export interface ProviderProfile {
  id: string;
  name: string;
  kind: "openai" | "openai-compatible" | "local" | "custom";
  baseURL: string;
  /** Reference to the secure store (env or keyring); never the secret itself. */
  apiKeyRef?: string;
  apiMode: "responses" | "chat-completions" | "auto";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Three-state capability matrix. `unknown` is not "no": parameters gated on
 * unknown capabilities are not sent unless the user explicitly forces them.
 */
export interface ModelCapabilities {
  streaming: CapabilityState;
  tools: CapabilityState;
  parallelToolCalls: CapabilityState;
  reasoning: CapabilityState;
  reasoningSummary: CapabilityState;
  structuredOutput: CapabilityState;
  promptCaching: CapabilityState;
  nativeCompaction: CapabilityState;
  seed: CapabilityState;
  stopSequences: CapabilityState;
  imageInput: CapabilityState;
  maxOutputTokens: CapabilityState;
}

export interface ModelTuning {
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off";
  verbosity?: "low" | "medium" | "high";
  toolChoice?: "auto" | "required" | "none" | string;
  parallelToolCalls?: boolean;
  truncation?: "auto" | "disabled";
  store?: boolean;
  seed?: number;
  stop?: string[];
  maxTurns?: number;
  requestTimeoutMs?: number;
  retryMaxAttempts?: number;
  retryInitialDelayMs?: number;
  promptCacheRetention?: "in-memory" | "24h" | "off";
  providerData?: Record<string, unknown>;
}

export interface ModelProfile {
  id: string;
  name: string;
  providerProfileId: string;
  modelId: string;
  contextWindow: number;
  contextWindowSource: "provider" | "known-profile" | "manual";
  maxUsableInputTokens?: number;
  capabilities: ModelCapabilities;
  defaults: ModelTuning;
  contextPolicyId: string;
  enabled: boolean;
}

/**
 * Multi-level context pressure policy. Every agent owns a copy; thresholds are
 * ratios of the *usable* input budget, never of the raw context window.
 */
export interface ContextPolicy {
  id: string;
  name: string;
  mode: "automatic" | "custom";
  watchRatio: number;                 // default 0.55
  retrievalTightRatio: number;        // default 0.65
  softCompactRatio: number;           // default 0.72
  deepCompactRatio: number;           // default 0.82
  emergencyRatio: number;             // default 0.90
  hardLimitRatio: number;             // default 0.95
  targetAfterCompactionMin: number;   // default 0.52
  targetAfterCompactionMax: number;   // default 0.58
  recentTurnsToKeep: number;
  recentRawMessagesToKeep: number;
  recentToolResultsToKeep: number;
  maxRetrievedMemoryTokens: number;
  reservedOutputTokens: number | "auto";
  reservedToolTokens: number | "auto";
  safetyMarginTokens: number | "auto";
  compactionCooldownActivations: number;
  tokenizer: "provider" | "local" | "heuristic";
  /** Heuristic estimates are deliberately conservative (≥ 1.15). */
  heuristicSafetyMultiplier: number;
  useNativeCompaction: "auto" | "always" | "never";
  verifyPinnedFacts: boolean;
  consolidateDuringIdle: boolean;
}

export interface AgentUtilityModelBindings {
  summarizerModelProfileId?: string;
  embeddingModelProfileId?: string;
  rerankerModelProfileId?: string;
  ttsModelProfileId?: string;
  speechToTextModelProfileId?: string;
}

export interface AgentModelBinding {
  defaultModelProfileId?: string;
  tuningOverrides?: Partial<ModelTuning>;
  contextPolicyId?: string;
  contextOverrides?: Partial<ContextPolicy>;
  utilityModels?: AgentUtilityModelBindings;
  /** Per-cognitive-phase model config — same agent identity throughout. */
  phaseOverrides?: Partial<Record<CognitivePhase, {
    modelProfileId?: string;
    tuning?: Partial<ModelTuning>;
  }>>;
}

export type ResolvedFieldSource =
  | "system"
  | "model-profile"
  | "global"
  | "room"
  | "agent"
  | "phase"
  | "runtime-safety";

export interface ResolvedField<T> {
  value: T;
  source: ResolvedFieldSource;
}

/** Every tuning field the runtime may send, with provenance. */
export interface ResolvedTuning {
  temperature?: ResolvedField<number>;
  topP?: ResolvedField<number>;
  presencePenalty?: ResolvedField<number>;
  frequencyPenalty?: ResolvedField<number>;
  maxOutputTokens?: ResolvedField<number>;
  reasoningEffort?: ResolvedField<Exclude<ModelTuning["reasoningEffort"], undefined>>;
  reasoningSummary?: ResolvedField<Exclude<ModelTuning["reasoningSummary"], undefined>>;
  toolChoice?: ResolvedField<Exclude<ModelTuning["toolChoice"], undefined>>;
  parallelToolCalls?: ResolvedField<boolean>;
  truncation?: ResolvedField<Exclude<ModelTuning["truncation"], undefined>>;
  store?: ResolvedField<boolean>;
  seed?: ResolvedField<number>;
  stop?: ResolvedField<string[]>;
  maxTurns?: ResolvedField<number>;
  requestTimeoutMs?: ResolvedField<number>;
  retryMaxAttempts?: ResolvedField<number>;
  retryInitialDelayMs?: ResolvedField<number>;
  promptCacheRetention?: ResolvedField<Exclude<ModelTuning["promptCacheRetention"], undefined>>;
}

/**
 * The final, effective configuration for one agent's decision model. Includes
 * only what can actually be sent to the target provider after capability
 * negotiation; every field carries its precedence source.
 */
export interface ResolvedModelConfig {
  agentId: string;
  modelProfileId: string;
  modelId: string;
  providerProfileId: string;
  contextWindow: number;
  contextWindowSource: ModelProfile["contextWindowSource"];
  /** contextWindow − output/tool/system reserves − safety margin. */
  usableInputTokens: number;
  reservedOutputTokens: number;
  reservedToolTokens: number;
  reservedSystemTokens: number;
  safetyMarginTokens: number;
  tuning: ResolvedTuning;
  /** Sanitized modelSettings that the SDK may receive. */
  sdkModelSettings: Record<string, unknown>;
  contextPolicy: ContextPolicy;
  capabilities: ModelCapabilities;
  /** Capability states that forced a parameter to be dropped or gated. */
  negotiationNotes: string[];
}

/** System-level safety floor applied last, above every user preference. */
export interface RuntimeSafetyLimits {
  minContextWindow: number;
  maxOutputTokensCap: number;
  maxTurnsCap: number;
  maxRetryAttemptsCap: number;
  minRequestTimeoutMs: number;
  maxRequestTimeoutMs: number;
}