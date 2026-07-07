import { ModelCallError } from "../agents/schema";
import { redactSecretText } from "./redaction";
import type { ProviderFailureSummary } from "./types";

export function describeError(error: unknown): string {
  return redactSecretText(error instanceof Error ? error.message : String(error));
}

export function providerFailureFromError(error: unknown): ProviderFailureSummary | undefined {
  for (const candidate of errorChain(error)) {
    if (candidate instanceof ModelCallError) {
      return providerFailureFromRaw(candidate.raw);
    }
  }
  return undefined;
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
  const providerRequestId = redactedStringValue(record.providerRequestId);
  if (providerRequestId) summary.providerRequestId = providerRequestId;
  const retryCause = redactedStringValue(record.retryCause);
  if (retryCause) summary.retryCause = retryCause;
  const abortReason = redactedStringValue(record.abortReason);
  if (abortReason) summary.abortReason = abortReason;
  const causeName = redactedStringValue(record.causeName);
  if (causeName) summary.causeName = causeName;
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
  return (
    value === "http" ||
    value === "timeout" ||
    value === "abort" ||
    value === "stream_invalid_json" ||
    value === "stream_empty" ||
    value === "stream_missing_body" ||
    value === "non_json" ||
    value === "empty_content" ||
    value === "network" ||
    value === "unknown"
  );
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

function redactedStringValue(value: unknown): string | undefined {
  const raw = stringValue(value);
  return raw ? redactSecretText(raw) : undefined;
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
