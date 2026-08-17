/**
 * Capability negotiation. A three-state capability is never treated as a
 * boolean: unknown parameters are not sent unless the user forces them, and
 * every drop is recorded so the UI can show what actually reached the model.
 */
import type { CapabilityState, ModelCapabilities, ModelTuning } from "./contracts";

export interface NegotiatedTuning {
  /** Fields safe to send given the provider's capability states. */
  allowed: ModelTuning;
  /** Dropped field names + reason, for UI display and audits. */
  dropped: Array<{ field: string; reason: string }>;
}

const CAPABILITY_GATE: Record<string, keyof ModelCapabilities> = {
  streaming: "streaming",
  tools: "tools",
  parallelToolCalls: "parallelToolCalls",
  reasoning: "reasoning",
  reasoningSummary: "reasoningSummary",
  structuredOutput: "structuredOutput",
  promptCaching: "promptCaching",
  nativeCompaction: "nativeCompaction",
  seed: "seed",
  stopSequences: "stopSequences",
  imageInput: "imageInput",
  maxOutputTokens: "maxOutputTokens"
};

/**
 * Filter a tuning object against the model's capabilities. `forced` fields
 * are sent even when the capability is unknown — the caller (settings UI)
 * marks them "未验证" rather than silently dropping them.
 */
export function negotiateTuning(
  tuning: ModelTuning,
  capabilities: ModelCapabilities,
  forced: ReadonlySet<string> = new Set()
): NegotiatedTuning {
  const allowed: ModelTuning = {};
  const dropped: NegotiatedTuning["dropped"] = [];
  const passthrough = new Set([
    "temperature", "topP", "presencePenalty", "frequencyPenalty",
    "verbosity", "toolChoice", "truncation", "store", "maxTurns",
    "requestTimeoutMs", "retryMaxAttempts", "retryInitialDelayMs",
    "promptCacheRetention", "providerData"
  ]);

  for (const [rawField, rawValue] of Object.entries(tuning)) {
    if (rawValue === undefined) continue;
    const field = rawField as keyof ModelTuning;
    if (passthrough.has(rawField)) {
      allowed[field] = rawValue as never;
      continue;
    }
    const capability = CAPABILITY_GATE[rawField];
    if (!capability) {
      allowed[field] = rawValue as never;
      continue;
    }
    const state = capabilities[capability] ?? "unknown";
    if (state === "yes") {
      allowed[field] = rawValue as never;
      continue;
    }
    if (state === "unknown" && forced.has(rawField)) {
      allowed[field] = rawValue as never;
      dropped.push({ field: rawField, reason: "unknown-capability-forced" });
      continue;
    }
    dropped.push({
      field: rawField,
      reason: state === "no" ? "unsupported-by-provider" : "unknown-capability-dropped"
    });
  }
  return { allowed, dropped };
}

export function capabilityLabel(state: CapabilityState): string {
  return state === "yes" ? "支持" : state === "no" ? "不支持" : "未验证";
}