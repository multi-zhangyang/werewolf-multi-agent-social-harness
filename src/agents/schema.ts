export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

import type { ModelCompletionRequest } from "./modelClient";

export interface ChatCompletionRequest extends ModelCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  stream?: boolean;
}

export interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
    finish_reason?: string;
  }>;
  usage?: ChatCompletionUsage;
}

export interface ChatCompletionStreamChunk {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
    };
    message?: {
      content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: ChatCompletionUsage | null;
}

export type ProviderFailureKind =
  | "http"
  | "timeout"
  | "abort"
  | "stream_invalid_json"
  | "stream_empty"
  | "stream_incomplete"
  | "stream_missing_body"
  | "non_json"
  | "empty_content"
  | "network"
  | "gateway_html"
  | "unknown";

export const PROVIDER_FAILURE_KINDS: readonly ProviderFailureKind[] = [
  "http",
  "timeout",
  "abort",
  "stream_invalid_json",
  "stream_empty",
  "stream_incomplete",
  "stream_missing_body",
  "non_json",
  "empty_content",
  "network",
  "gateway_html",
  "unknown"
] as const;

export function isProviderFailureKind(value: string | undefined): value is ProviderFailureKind {
  return typeof value === "string" && (PROVIDER_FAILURE_KINDS as readonly string[]).includes(value);
}

export function looksLikeHtmlGatewayPayload(value: unknown): boolean {
  const text = collectProviderErrorText(value);
  if (!text) return false;
  return (
    /<\s*html[\s>]/i.test(text) ||
    /<\s*head[\s>]/i.test(text) ||
    /Authorization Required/i.test(text) ||
    /<\s*center>\s*<\s*h1>/i.test(text) ||
    (/nginx/i.test(text) && /<\s*body[\s>]/i.test(text))
  );
}

function collectProviderErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) return value.map((item) => collectProviderErrorText(item)).join("\n");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((item) => collectProviderErrorText(item))
      .join("\n");
  }
  return "";
}

export type ProviderFailureStage =
  | "before_start"
  | "during_request"
  | "during_stream"
  | "during_retry_delay"
  | "http_response"
  | "stream_start"
  | "stream_parse"
  | "stream_finish"
  | "non_stream_parse";

export type ProviderStreamCompletionMode = "done_sentinel" | "provider_stop_event" | "reader_done";

export interface ProviderStreamTelemetry {
  enabled: boolean;
  completed: boolean;
  completedBy?: ProviderStreamCompletionMode;
}

export interface ProviderRetryHistoryEntry {
  attempt: number;
  failureKind?: ProviderFailureKind;
  providerStage?: ProviderFailureStage;
  status?: number;
  timeoutMs?: number;
  aborted?: boolean;
  retryable: boolean;
  delayMs?: number;
  message: string;
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    public readonly raw?: unknown
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

export function normalizeModelList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((model) => model.trim())
    .filter(Boolean);
}
