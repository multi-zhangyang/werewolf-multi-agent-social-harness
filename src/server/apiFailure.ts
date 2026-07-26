import { providerFailureFromError } from "../harness/providerFailure";
import type { ProviderFailureSummary } from "../harness/types";
import { HttpError } from "./httpValidation";
import { isRecord } from "./jsonUtil";

export interface PublicProviderFailureSummary {
  failureKind: string;
  providerStage?: string;
  status?: number;
  timeoutMs?: number;
  aborted?: boolean;
  retryable?: boolean;
  attempts?: number;
  maxAttempts?: number;
}

export interface PublicApiFailure {
  message: string;
  code?: string;
  providerFailure?: PublicProviderFailureSummary;
}

export function publicApiFailureFromError(error: unknown): PublicApiFailure {
  const providerFailure = providerFailureFromError(error);
  if (providerFailure) {
    const safeProviderFailure = publicProviderFailureSummary(providerFailure);
    return {
      message: providerFailureApiMessage(safeProviderFailure),
      providerFailure: safeProviderFailure
    };
  }
  return {
    message: sanitizeApiErrorText(error instanceof Error ? error.message : String(error)),
    ...(error instanceof HttpError && error.code ? { code: sanitizeApiErrorText(error.code) } : {})
  };
}

export function publicProviderFailureSummary(failure: ProviderFailureSummary): PublicProviderFailureSummary {
  const summary: PublicProviderFailureSummary = {
    failureKind: sanitizeApiErrorText(failure.failureKind)
  };
  if (failure.providerStage) summary.providerStage = sanitizeApiErrorText(failure.providerStage);
  if (failure.status !== undefined) summary.status = failure.status;
  if (failure.timeoutMs !== undefined) summary.timeoutMs = failure.timeoutMs;
  if (failure.aborted !== undefined) summary.aborted = failure.aborted;
  if (failure.retryable !== undefined) summary.retryable = failure.retryable;
  if (failure.attempts !== undefined) summary.attempts = failure.attempts;
  if (failure.maxAttempts !== undefined) summary.maxAttempts = failure.maxAttempts;
  return summary;
}

export function publicProviderFailureFromUnknown(value: unknown): PublicProviderFailureSummary | undefined {
  if (!isRecord(value) || typeof value.failureKind !== "string") return undefined;
  return publicProviderFailureSummary(value as unknown as ProviderFailureSummary);
}

export function providerFailureApiMessage(failure: PublicProviderFailureSummary): string {
  const details = [
    `kind=${failure.failureKind}`,
    failure.providerStage ? `stage=${failure.providerStage}` : null,
    failure.status !== undefined ? `status=${failure.status}` : null,
    failure.timeoutMs !== undefined ? `timeoutMs=${failure.timeoutMs}` : null,
    failure.attempts !== undefined
      ? `attempts=${failure.attempts}${failure.maxAttempts !== undefined ? `/${failure.maxAttempts}` : ""}`
      : null
  ].filter(Boolean);
  return `Model provider failure (${details.join(", ")}).`;
}

export function sanitizeApiErrorText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z][A-Za-z0-9]*_(?:v\d+_)?(?=[A-Za-z0-9_:-]*\d)[A-Za-z0-9_:-]{24,}\b/g, "<provider-token:redacted>")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-<redacted>")
    .replace(/\b[A-Za-z0-9][A-Za-z0-9_-]{2,}:(?:harness|social|probe):[A-Za-z0-9:_-]+/g, "<trace:redacted>");
}

export function publicHarnessFailureReason(
  rawFailureReason: string | undefined,
  harnessFailures: Array<{ failureReason: string }>
): string | null {
  if (harnessFailures.length) {
    return harnessFailures.map((failure) => failure.failureReason).join(" | ");
  }
  return rawFailureReason ? sanitizeApiErrorText(rawFailureReason) : null;
}
