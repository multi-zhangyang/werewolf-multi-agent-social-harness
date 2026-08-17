/**
 * System defaults for context policies and runtime safety limits. These are
 * the lowest precedence in the resolution chain: every user setting overrides
 * them, and runtime safety overrides every user setting.
 */
import type { ContextPolicy, ModelCapabilities, RuntimeSafetyLimits } from "./contracts";

export const DEFAULT_CONTEXT_POLICY_ID = "policy-balanced-auto";

export function defaultContextPolicy(): ContextPolicy {
  return {
    id: DEFAULT_CONTEXT_POLICY_ID,
    name: "平衡自动",
    mode: "automatic",
    watchRatio: 0.55,
    retrievalTightRatio: 0.65,
    softCompactRatio: 0.72,
    deepCompactRatio: 0.82,
    emergencyRatio: 0.9,
    hardLimitRatio: 0.95,
    targetAfterCompactionMin: 0.52,
    targetAfterCompactionMax: 0.58,
    recentTurnsToKeep: 3,
    recentRawMessagesToKeep: 10,
    recentToolResultsToKeep: 6,
    maxRetrievedMemoryTokens: 6_000,
    reservedOutputTokens: "auto",
    reservedToolTokens: "auto",
    safetyMarginTokens: "auto",
    compactionCooldownActivations: 4,
    tokenizer: "heuristic",
    heuristicSafetyMultiplier: 1.15,
    useNativeCompaction: "auto",
    verifyPinnedFacts: true,
    consolidateDuringIdle: true
  };
}

export function defaultCapabilities(): ModelCapabilities {
  return {
    streaming: "unknown",
    tools: "yes",
    parallelToolCalls: "unknown",
    reasoning: "unknown",
    reasoningSummary: "unknown",
    structuredOutput: "unknown",
    promptCaching: "unknown",
    nativeCompaction: "unknown",
    seed: "unknown",
    stopSequences: "unknown",
    imageInput: "unknown",
    maxOutputTokens: "unknown"
  };
}

export function defaultSafetyLimits(): RuntimeSafetyLimits {
  return {
    minContextWindow: 8_192,
    maxOutputTokensCap: 64_000,
    maxTurnsCap: 24,
    maxRetryAttemptsCap: 8,
    minRequestTimeoutMs: 30_000,
    maxRequestTimeoutMs: 1_200_000
  };
}

/**
 * Reserved budgets (tokens) when the policy says "auto". Deliberately
 * conservative: a long game must never blow the window because the reserve
 * was optimistic.
 */
export function autoReservedTokens(contextWindow: number): {
  reservedOutputTokens: number;
  reservedToolTokens: number;
  reservedSystemTokens: number;
  safetyMarginTokens: number;
} {
  const reservedOutputTokens = Math.min(16_384, Math.floor(contextWindow * 0.08));
  const reservedToolTokens = Math.min(32_768, Math.floor(contextWindow * 0.12));
  const reservedSystemTokens = Math.min(24_576, Math.floor(contextWindow * 0.1));
  const safetyMarginTokens = Math.floor(contextWindow * 0.04);
  return { reservedOutputTokens, reservedToolTokens, reservedSystemTokens, safetyMarginTokens };
}