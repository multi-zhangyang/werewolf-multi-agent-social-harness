import type { ContextPolicy, ModelCapabilities } from "./contracts";

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
