import { ModelCallError, isProviderFailureKind as schemaIsProviderFailureKind } from "../agents/schema";
import { redactSecretText } from "./redaction";
import type { ProviderFailureSummary } from "./types";

const PERSISTED_PROVIDER_DIAGNOSTIC_KEYS = new Set([
  "providerRequestId",
  "providerRequestIds",
  "retryCause",
  "abortReason",
  "causeName",
  "causeMessage",
  "providerBody",
  "providerHeaders"
]);

export function describeError(error: unknown): string {
  if (providerFailureFromError(error)) {
    return safeProviderFailureMessage(error, "Model provider failed before the harness operation completed.");
  }
  return redactSecretText(error instanceof Error ? error.message : String(error));
}

/**
 * Returns a diagnostics-safe failure label without relaying provider response
 * bodies, request identifiers, retry text, or arbitrary exception content.
 */
export function safeProviderFailureMessage(error: unknown, fallback: string): string {
  const failure = providerFailureFromError(error);
  if (!failure) return fallback;
  const details = [
    `kind=${failure.failureKind}`,
    failure.providerStage ? `stage=${failure.providerStage}` : null,
    failure.status !== undefined ? `status=${failure.status}` : null,
    failure.timeoutMs !== undefined ? `timeoutMs=${failure.timeoutMs}` : null,
    failure.attempts !== undefined
      ? `attempts=${failure.attempts}${failure.maxAttempts !== undefined ? `/${failure.maxAttempts}` : ""}`
      : null
  ].filter((detail): detail is string => detail !== null);
  return `Model provider failure (${details.join(", ")}).`;
}

export function providerFailureFromError(error: unknown): ProviderFailureSummary | undefined {
  for (const candidate of errorChain(error)) {
    if (candidate instanceof ModelCallError) {
      return providerFailureFromRaw(candidate.raw);
    }
  }
  return undefined;
}

/**
 * Removes provider-opaque identifiers and free-form diagnostics from values
 * that cross into durable artifacts, JSONL, checkpoints, server responses, or
 * research exports. This deliberately operates structurally rather than
 * relying on token-shaped secret redaction: provider request IDs and arbitrary
 * routing/error prose are not reliably secret-shaped.
 *
 * Closed execution telemetry (kind, stage, status, timeout, retryability,
 * attempts, and stream completion enum) remains intact for evaluation and
 * operational aggregation. The original runtime object is never mutated.
 */
export function sanitizePersistedProviderDiagnostics<T>(value: T): T {
  return sanitizeValue(value, false) as T;
}

function sanitizeValue(value: unknown, retryHistoryEntry: boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, retryHistoryEntry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (PERSISTED_PROVIDER_DIAGNOSTIC_KEYS.has(key)) return [];
      // `message` is otherwise valid social/domain evidence. It becomes
      // provider-owned free-form diagnostics only inside retry-history rows.
      if (retryHistoryEntry && key === "message") return [];
      return [[key, sanitizeValue(entry, key === "retryHistory")]];
    })
  );
}

function providerFailureFromRaw(raw: unknown): ProviderFailureSummary {
  const record = isRecord(raw) ? raw : {};
  const failureKind = providerFailureKindFromRaw(record);
  const summary: ProviderFailureSummary = { failureKind };
  const providerStage = stringValue(record.providerStage);
  if (isProviderFailureStage(providerStage)) summary.providerStage = providerStage;
  const status = numberValue(record.status);
  if (status !== undefined) summary.status = status;
  const timeoutMs = numberValue(record.timeoutMs);
  if (timeoutMs !== undefined) summary.timeoutMs = timeoutMs;
  const aborted = booleanValue(record.aborted);
  if (aborted !== undefined) summary.aborted = aborted;
  const retryable = booleanValue(record.retryable);
  if (retryable !== undefined) summary.retryable = retryable;
  const attempts = numberValue(record.attempts);
  if (attempts !== undefined) summary.attempts = attempts;
  const maxAttempts = numberValue(record.maxAttempts);
  if (maxAttempts !== undefined) summary.maxAttempts = maxAttempts;
  return summary;
}

function providerFailureKindFromRaw(record: Record<string, unknown>): ProviderFailureSummary["failureKind"] {
  const explicit = stringValue(record.failureKind);
  if (isProviderFailureKind(explicit)) return explicit;
  if (record.aborted === true) return "abort";
  if (typeof record.timeoutMs === "number") return "timeout";
  if (typeof record.status === "number") return "http";
  return "unknown";
}

function* errorChain(error: unknown): Generator<unknown> {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; current !== undefined && current !== null && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    yield current;
    current = errorCause(current);
  }
}

function errorCause(error: unknown): unknown {
  if (isRecord(error) && "cause" in error) return error.cause;
  return undefined;
}

function isProviderFailureKind(value: string | undefined): value is ProviderFailureSummary["failureKind"] {
  return schemaIsProviderFailureKind(value);
}

function isProviderFailureStage(value: string | undefined): value is NonNullable<ProviderFailureSummary["providerStage"]> {
  return (
    value === "before_start" ||
    value === "during_request" ||
    value === "during_stream" ||
    value === "during_retry_delay" ||
    value === "http_response" ||
    value === "stream_start" ||
    value === "stream_parse" ||
    value === "stream_finish" ||
    value === "non_stream_parse"
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
