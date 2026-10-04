export type CapabilityState = "yes" | "no" | "unknown";

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
 * Capability metadata retained with the local model configuration.
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
  /** Historical profile field; live execution does not use output caps. */
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

export type ProtocolCheckStatus = "unknown" | "passed" | "failed" | "stale";

/**
 * Result of the real Agents SDK tool -> result -> final response handshake.
 * The fingerprint deliberately excludes credentials, while covering every
 * provider/model setting whose change can alter the wire protocol.
 */
export interface ModelProtocolCheck {
  status: ProtocolCheckStatus;
  fingerprint: string;
  checkedAt?: string;
  latencyMs?: number;
  errorCode?: string;
  message?: string;
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
  /** Missing on legacy profiles; exposed as `unknown` until checked. */
  protocolCheck?: ModelProtocolCheck;
}

/**
 * Legacy context-policy document retained for local JSON compatibility.
 * The v2 participant manages its own bounded session window.
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
