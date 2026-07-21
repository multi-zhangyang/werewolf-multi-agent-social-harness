import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError
} from "openai";
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ModelClient, ModelCompletionResult } from "./modelClient";
import {
  ModelCallError,
  type ChatCompletionRequest,
  type ChatCompletionUsage,
  type ChatMessage,
  type ProviderFailureKind,
  type ProviderFailureStage,
  type ProviderRetryHistoryEntry,
  type ProviderStreamCompletionMode,
  isProviderFailureKind as schemaIsProviderFailureKind,
  looksLikeHtmlGatewayPayload
} from "./schema";
import {
  baseUrlFromEndpointUrl,
  endpointUrlFromBaseUrl,
  normalizeSdkBaseUrl,
  validateEndpointUrl
} from "./providerUrls";

const CHAT_COMPLETIONS_PATH = "/chat/completions";

export interface OpenAICompatibleClientOptions {
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  abortSignal?: AbortSignal;
  stream?: boolean;
  fetch?: typeof fetch;
}

export type CompletionResult = ModelCompletionResult;

export class OpenAICompatibleClient implements ModelClient {
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly abortSignal?: AbortSignal;
  private readonly stream: boolean;

  constructor(options: OpenAICompatibleClientOptions) {
    if (!options.baseURL) throw new Error("OpenAI-compatible SDK baseURL is required.");
    const baseURL = normalizeSdkBaseUrl(options.baseURL, "OpenAI-compatible SDK baseURL");
    if (!options.apiKey.trim()) throw new Error("LLM_API_KEY is required for real harness model calls.");
    this.timeoutMs = validatePositiveInteger(options.timeoutMs ?? 120_000, "LLM timeout");
    this.maxRetries = validateNonNegativeInteger(options.maxRetries ?? 2, "LLM retry count");
    this.abortSignal = options.abortSignal;
    this.stream = options.stream ?? true;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL,
      timeout: this.timeoutMs,
      maxRetries: 0,
      fetch: options.fetch
    });
  }

  async complete(request: ChatCompletionRequest): Promise<CompletionResult> {
    const totalStarted = performance.now();
    let lastError: unknown;
    const maxAttempts = this.maxRetries + 1;
    const retryHistory: ProviderRetryHistoryEntry[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.completeOnce(request);
        return {
          ...result,
          attempts: attempt,
          latencyMs: Math.round(performance.now() - totalStarted),
          retryHistory: retryHistory.length ? [...retryHistory] : undefined
        };
      } catch (error) {
        lastError = error;
        const retryable = isRetryableModelCall(error);
        if (!retryable || attempt >= maxAttempts) {
          throw withAttemptContext(error, attempt, maxAttempts, [...retryHistory, retryHistoryEntry(error, attempt, retryable)]);
        }
        const delayMs = retryDelayMs(error, attempt);
        retryHistory.push(retryHistoryEntry(error, attempt, retryable, delayMs));
        try {
          await delay(delayMs, this.abortSignal);
        } catch (delayError) {
          throw withAttemptContext(delayError, attempt, maxAttempts, [...retryHistory, retryHistoryEntry(delayError, attempt, false)]);
        }
      }
    }
    throw withAttemptContext(lastError, maxAttempts, maxAttempts, retryHistory);
  }

  private async completeOnce(request: ChatCompletionRequest): Promise<CompletionResult> {
    const started = performance.now();
    if (this.abortSignal?.aborted) {
      throw abortedModelCallError(this.abortSignal.reason, "before_start");
    }
    const controller = new AbortController();
    let requestTimedOut = false;
    let activeStage: ProviderFailureStage = "during_request";
    const timeout = setTimeout(() => {
      requestTimedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abortFromOuterSignal = () => controller.abort(this.abortSignal?.reason);
    this.abortSignal?.addEventListener("abort", abortFromOuterSignal, { once: true });
    try {
      const wantsStream = request.stream ?? this.stream;
      if (wantsStream) {
        const { data: stream, request_id: sdkRequestId } = await this.client.chat.completions
          .create(
            {
              model: request.model,
              messages: openAIChatMessages(request.messages),
              temperature: request.temperature,
              stream: true
            },
            { signal: controller.signal, timeout: this.timeoutMs, maxRetries: 0 }
          )
          .withResponse();
        activeStage = "during_stream";
        const result = await this.readStreamCompletion(stream, started, sdkRequestId ?? undefined);
        if (requestTimedOut) throw timeoutModelCallError(this.timeoutMs, activeStage);
        if (this.abortSignal?.aborted) throw abortedModelCallError(this.abortSignal.reason, activeStage);
        return result;
      }

      activeStage = "non_stream_parse";
      const { data: parsed, request_id: sdkRequestId } = await this.client.chat.completions
        .create(
          {
            model: request.model,
            messages: openAIChatMessages(request.messages),
            temperature: request.temperature,
            stream: false
          },
          { signal: controller.signal, timeout: this.timeoutMs, maxRetries: 0 }
        )
        .withResponse();
      return parseChatCompletion(parsed, started, sdkRequestId ?? undefined);
    } catch (error) {
      if (requestTimedOut) throw timeoutModelCallError(this.timeoutMs, activeStage);
      if (this.abortSignal?.aborted) throw abortedModelCallError(this.abortSignal.reason, activeStage);
      if (error instanceof ModelCallError) throw error;
      const sdkError = openAISdkModelCallError(error, activeStage, this.timeoutMs);
      if (sdkError) throw sdkError;
      throw networkModelCallError(error, activeStage);
    } finally {
      clearTimeout(timeout);
      this.abortSignal?.removeEventListener("abort", abortFromOuterSignal);
    }
  }

  private async readStreamCompletion(
    stream: AsyncIterable<ChatCompletionChunk>,
    started: number,
    sdkRequestId: string | undefined
  ): Promise<CompletionResult> {
    let content = "";
    let providerRequestId = sdkRequestId;
    let usage: ChatCompletionUsage | undefined;
    let sawProviderStop = false;

    try {
      for await (const chunk of stream) {
        if (this.abortSignal?.aborted) throw abortedModelCallError(this.abortSignal.reason, "during_stream");
        providerRequestId = chunk.id ?? providerRequestId;
        usage = sdkChatUsage(chunk.usage) ?? usage;
        for (const choice of chunk.choices ?? []) {
          content += choice.delta?.content ?? "";
          if (choice.finish_reason) sawProviderStop = true;
        }
      }
    } catch (error) {
      if (error instanceof ModelCallError) throw error;
      const sdkError = openAISdkModelCallError(error, "during_stream", this.timeoutMs);
      if (sdkError) throw sdkError;
      throw networkModelCallError(error, "during_stream");
    }

    return finishStream(content, started, usage, providerRequestId, sawProviderStop ? "provider_stop_event" : "reader_done");
  }
}

export function chatCompletionsUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = optionalChatCompletionsUrlFromEnv(env);
  if (!url) {
    throw new Error("LLM_CHAT_COMPLETIONS_URL or LLM_BASE_URL is required for OpenAI-compatible chat completions.");
  }
  return url;
}

export function optionalChatCompletionsUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.LLM_CHAT_COMPLETIONS_URL) {
    return validateEndpointUrl(env.LLM_CHAT_COMPLETIONS_URL, CHAT_COMPLETIONS_PATH, "LLM_CHAT_COMPLETIONS_URL");
  }
  if (!env.LLM_BASE_URL) return undefined;
  return endpointUrlFromBaseUrl(env.LLM_BASE_URL, CHAT_COMPLETIONS_PATH, "LLM_BASE_URL");
}

export function chatCompletionsBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = optionalChatCompletionsBaseUrlFromEnv(env);
  if (!url) {
    throw new Error("LLM_CHAT_COMPLETIONS_URL or LLM_BASE_URL is required for OpenAI-compatible chat completions.");
  }
  return url;
}

export function optionalChatCompletionsBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.LLM_CHAT_COMPLETIONS_URL) {
    return baseUrlFromEndpointUrl(env.LLM_CHAT_COMPLETIONS_URL, CHAT_COMPLETIONS_PATH, "LLM_CHAT_COMPLETIONS_URL");
  }
  if (!env.LLM_BASE_URL) return undefined;
  return normalizeSdkBaseUrl(env.LLM_BASE_URL, "LLM_BASE_URL");
}

export function clientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Pick<OpenAICompatibleClientOptions, "timeoutMs" | "maxRetries" | "abortSignal"> = {}
): OpenAICompatibleClient {
  return new OpenAICompatibleClient({
    baseURL: chatCompletionsBaseUrlFromEnv(env),
    apiKey: env.LLM_API_KEY ?? "",
    timeoutMs: overrides.timeoutMs ?? parseOptionalIntegerEnv(env.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS"),
    maxRetries: overrides.maxRetries ?? parseOptionalIntegerEnv(env.LLM_RETRY_COUNT, "LLM_RETRY_COUNT"),
    abortSignal: overrides.abortSignal,
    stream: env.LLM_STREAM === undefined ? true : env.LLM_STREAM !== "false"
  });
}

function openAIChatMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function parseChatCompletion(parsed: ChatCompletion, started: number, sdkRequestId: string | undefined): CompletionResult {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw new ModelCallError("LLM API returned non-JSON response.", {
      failureKind: "non_json",
      providerStage: "non_stream_parse",
      retryable: false,
      providerRequestId: sdkRequestId
    });
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) {
    throw new ModelCallError("LLM API response did not contain choices[0].message.content.", {
      failureKind: "empty_content",
      providerStage: "non_stream_parse",
      retryable: false,
      providerRequestId: parsed.id ?? sdkRequestId
    });
  }
  return {
    content,
    latencyMs: Math.round(performance.now() - started),
    usage: completionUsage(sdkChatUsage(parsed.usage)),
    providerRequestId: parsed.id ?? sdkRequestId,
    attempts: 1
  };
}

function sdkChatUsage(usage: ChatCompletion["usage"] | ChatCompletionChunk["usage"] | null | undefined): ChatCompletionUsage | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens
  };
}

function completionUsage(usage: ChatCompletionUsage | undefined): ModelCompletionResult["usage"] {
  return {
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens
  };
}

function finishStream(
  content: string,
  started: number,
  usage: ChatCompletionUsage | undefined,
  providerRequestId: string | undefined,
  completedBy: ProviderStreamCompletionMode
): CompletionResult {
  if (!content) {
    throw new ModelCallError("LLM API stream completed without content.", {
      failureKind: "stream_empty",
      providerStage: "stream_finish",
      retryable: true,
      providerRequestId
    });
  }
  return {
    content,
    latencyMs: Math.round(performance.now() - started),
    usage: completionUsage(usage),
    providerRequestId,
    attempts: 1,
    stream: {
      enabled: true,
      completed: true,
      completedBy
    }
  };
}

function openAISdkModelCallError(error: unknown, stage: ProviderFailureStage, timeoutMs: number): ModelCallError | undefined {
  if (error instanceof APIUserAbortError) return abortedModelCallError(error, stage);
  if (error instanceof APIConnectionTimeoutError) return timeoutModelCallError(timeoutMs, stage);
  if (error instanceof APIConnectionError) {
    return new ModelCallError(`LLM API request failed ${providerStageLabel(stage)}: ${error.message}`, {
      failureKind: "network",
      providerStage: stage,
      retryable: true,
      causeName: error.name,
      causeMessage: error.message
    });
  }
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const providerStage: ProviderFailureStage = status === undefined ? stage : "http_response";
    const htmlGateway = looksLikeHtmlGatewayPayload(error.message) || looksLikeHtmlGatewayPayload(error.error);
    const failureKind: ProviderFailureKind = status === undefined ? "unknown" : htmlGateway ? "gateway_html" : "http";
    const message = htmlGateway
      ? `LLM API HTTP ${status ?? "error"}: gateway returned HTML (likely wrong endpoint path or gateway auth failure).`
      : `LLM API HTTP ${status ?? "error"}: ${error.message.slice(0, 600)}`;
    return new ModelCallError(message, {
      failureKind,
      providerStage,
      status,
      retryable: status === undefined ? true : isRetryableHttpStatus(status),
      body: error.error,
      headers: headersToRecord(error.headers),
      providerRequestId: error.requestID ?? undefined
    });
  }
  if (error instanceof SyntaxError) {
    return new ModelCallError(stage === "non_stream_parse" ? "LLM API returned non-JSON response." : "LLM API stream emitted invalid JSON chunk.", {
      failureKind: stage === "non_stream_parse" ? "non_json" : "stream_invalid_json",
      providerStage: stage === "non_stream_parse" ? "non_stream_parse" : "stream_parse",
      retryable: false,
      error
    });
  }
  return undefined;
}

function isRetryableModelCall(error: unknown): boolean {
  if (error instanceof ModelCallError) {
    const raw = error.raw as { aborted?: boolean; retryable?: boolean; status?: number } | undefined;
    if (raw?.aborted) return false;
    if (raw?.retryable !== undefined) return raw.retryable;
    if (raw?.status === undefined) return true;
    return isRetryableHttpStatus(raw.status);
  }
  return error instanceof Error && /fetch failed|ECONNRESET|ETIMEDOUT|Server disconnected/i.test(error.message);
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(error: unknown, attempt: number): number {
  const retryAfterMs = retryAfterHeaderMs(error);
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 30_000);
  return Math.min(500 * 2 ** (attempt - 1), 8_000);
}

function retryAfterHeaderMs(error: unknown): number | undefined {
  if (!(error instanceof ModelCallError)) return undefined;
  const raw = error.raw as { headers?: Record<string, string> } | undefined;
  const retryAfter = raw?.headers?.["retry-after"];
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function delay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortedModelCallError(abortSignal.reason, "during_retry_delay"));
      return;
    }
    const timeout = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortedModelCallError(abortSignal?.reason, "during_retry_delay"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryHistoryEntry(error: unknown, attempt: number, retryable: boolean, delayMs?: number): ProviderRetryHistoryEntry {
  const raw = error instanceof ModelCallError && isRecord(error.raw) ? error.raw : {};
  const entry: ProviderRetryHistoryEntry = {
    attempt,
    retryable,
    message: error instanceof Error ? error.message : String(error)
  };
  const failureKind = stringValue(raw.failureKind);
  if (isProviderFailureKind(failureKind)) entry.failureKind = failureKind;
  const providerStage = stringValue(raw.providerStage);
  if (isProviderFailureStage(providerStage)) entry.providerStage = providerStage;
  const status = numberValue(raw.status);
  if (status !== undefined) entry.status = status;
  const timeoutMs = numberValue(raw.timeoutMs);
  if (timeoutMs !== undefined) entry.timeoutMs = timeoutMs;
  const aborted = booleanValue(raw.aborted);
  if (aborted !== undefined) entry.aborted = aborted;
  if (delayMs !== undefined) entry.delayMs = delayMs;
  return entry;
}

function withAttemptContext(error: unknown, attempts: number, maxAttempts: number, retryHistory?: ProviderRetryHistoryEntry[]): ModelCallError {
  const reason = error instanceof Error ? error.message : String(error);
  const raw = error instanceof ModelCallError && isRecord(error.raw) ? error.raw : { cause: error };
  return new ModelCallError(`LLM API request failed after ${attempts}/${maxAttempts} attempt(s): ${reason}`, {
    ...raw,
    attempts,
    maxAttempts,
    retryHistory: retryHistory?.length ? retryHistory : undefined,
    retryCause: typeof raw.retryCause === "string" ? raw.retryCause : reason
  });
}

function abortedModelCallError(reason: unknown, stage: ProviderFailureStage): ModelCallError {
  const detail = abortReasonMessage(reason);
  return new ModelCallError(`LLM API request aborted ${providerStageLabel(stage)}${detail ? `: ${detail}` : "."}`, {
    failureKind: "abort",
    providerStage: stage,
    aborted: true,
    retryable: false,
    abortReason: detail || undefined
  });
}

function timeoutModelCallError(timeoutMs: number, stage: ProviderFailureStage): ModelCallError {
  return new ModelCallError(`LLM API request exceeded ${timeoutMs}ms.`, {
    failureKind: "timeout",
    providerStage: stage,
    timeoutMs,
    retryable: true
  });
}

function networkModelCallError(error: unknown, stage: ProviderFailureStage): ModelCallError {
  const message = error instanceof Error ? error.message : String(error);
  return new ModelCallError(`LLM API request failed ${providerStageLabel(stage)}: ${message}`, {
    failureKind: "network",
    providerStage: stage,
    retryable: /fetch failed|ECONNRESET|ETIMEDOUT|Server disconnected/i.test(message),
    causeName: error instanceof Error ? error.name : undefined,
    causeMessage: message
  });
}

function providerStageLabel(stage: ProviderFailureStage): string {
  return stage.replace(/_/g, " ");
}

function isProviderFailureKind(value: string | undefined): value is ProviderFailureKind {
  return schemaIsProviderFailureKind(value);
}

function isProviderFailureStage(value: string | undefined): value is ProviderFailureStage {
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

function abortReasonMessage(reason: unknown): string {
  if (!reason) return "";
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function parseOptionalIntegerEnv(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return validateNonNegativeInteger(Number(value), name);
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function validateNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function headersToRecord(headers: Headers | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(headers.entries());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
