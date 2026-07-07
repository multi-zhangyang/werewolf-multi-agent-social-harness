import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError
} from "@anthropic-ai/sdk";
import type { Message, MessageParam, MessageStreamEvent, Usage, MessageDeltaUsage } from "@anthropic-ai/sdk/resources/messages/messages";
import type { ModelClient, ModelCompletionRequest, ModelCompletionResult } from "./modelClient";
import { ModelCallError, type ChatCompletionUsage, type ChatMessage, type ProviderStreamCompletionMode } from "./schema";
import { normalizeSdkBaseUrl } from "./providerUrls";

export interface AnthropicMessagesClientOptions {
  baseURL: string;
  apiKey: string;
  maxTokens: number;
  anthropicVersion?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  stream?: boolean;
  fetch?: typeof fetch;
}

export class AnthropicMessagesClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly abortSignal?: AbortSignal;
  private readonly stream: boolean;

  constructor(options: AnthropicMessagesClientOptions) {
    if (!options.baseURL) throw new Error("Anthropic Messages SDK baseURL is required.");
    const baseURL = normalizeSdkBaseUrl(options.baseURL, "Anthropic Messages SDK baseURL", ["/v1/messages"]);
    if (!options.apiKey.trim()) throw new Error("ANTHROPIC_API_KEY is required for Anthropic Messages model calls.");
    this.maxTokens = validatePositiveInteger(options.maxTokens, "Anthropic max_tokens");
    this.timeoutMs = validatePositiveInteger(options.timeoutMs ?? 120_000, "Anthropic Messages timeout");
    this.abortSignal = options.abortSignal;
    this.stream = options.stream ?? true;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL,
      timeout: this.timeoutMs,
      maxRetries: 0,
      fetch: options.fetch,
      defaultHeaders: options.anthropicVersion ? { "anthropic-version": options.anthropicVersion } : undefined
    });
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    const started = performance.now();
    if (this.abortSignal?.aborted) throw abortedModelCallError(this.abortSignal.reason, "before_start");
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort(this.abortSignal?.reason);
    this.abortSignal?.addEventListener("abort", onAbort, { once: true });
    let stage = "during_request";

    try {
      const wantsStream = request.stream ?? this.stream;
      const { system, messages } = anthropicInputFromMessages(request.messages);
      if (wantsStream) {
        const { data: stream, request_id: sdkRequestId } = await this.client.messages
          .create(
            removeUndefined({
              model: request.model,
              system,
              messages,
              temperature: request.temperature,
              max_tokens: this.maxTokens,
              stream: true as const
            }),
            { signal: controller.signal, timeout: this.timeoutMs, maxRetries: 0 }
          )
          .withResponse();
        stage = "during_stream";
        const result = await this.readStream(stream, started, sdkRequestId ?? undefined);
        if (timedOut) throw timeoutModelCallError(this.timeoutMs, stage);
        if (this.abortSignal?.aborted) throw abortedModelCallError(this.abortSignal.reason, stage);
        return result;
      }

      stage = "non_stream_parse";
      const { data: message, request_id: sdkRequestId } = await this.client.messages
        .create(
          removeUndefined({
            model: request.model,
            system,
            messages,
            temperature: request.temperature,
            max_tokens: this.maxTokens,
            stream: false as const
          }),
          { signal: controller.signal, timeout: this.timeoutMs, maxRetries: 0 }
        )
        .withResponse();
      return parseAnthropicMessage(message, started, sdkRequestId ?? undefined);
    } catch (error) {
      if (timedOut) throw timeoutModelCallError(this.timeoutMs, stage);
      if (this.abortSignal?.aborted) throw abortedModelCallError(this.abortSignal.reason, stage);
      if (error instanceof ModelCallError) throw error;
      const sdkError = anthropicSdkModelCallError(error, stage, this.timeoutMs);
      if (sdkError) throw sdkError;
      throw new ModelCallError(`Anthropic Messages API network failure: ${error instanceof Error ? error.message : String(error)}`, {
        failureKind: "network",
        providerStage: stage,
        retryable: true,
        causeName: error instanceof Error ? error.name : undefined
      });
    } finally {
      clearTimeout(timeout);
      this.abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  private async readStream(
    stream: AsyncIterable<MessageStreamEvent>,
    started: number,
    sdkRequestId: string | undefined
  ): Promise<ModelCompletionResult> {
    let content = "";
    let providerRequestId = sdkRequestId;
    let usage: ChatCompletionUsage | undefined;

    try {
      for await (const event of stream) {
        if (this.abortSignal?.aborted) throw abortedModelCallError(this.abortSignal.reason, "during_stream");
        if (event.type === "message_start") {
          providerRequestId = event.message.id ?? providerRequestId;
          usage = mergeUsage(usage, anthropicUsage(event.message.usage));
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          content += event.delta.text ?? "";
        } else if (event.type === "message_delta") {
          usage = mergeUsage(usage, anthropicUsage(event.usage));
        } else if (event.type === "message_stop") {
          return finish(content, started, usage, providerRequestId, "provider_stop_event");
        }
      }
      return finish(content, started, usage, providerRequestId, "reader_done");
    } catch (error) {
      if (error instanceof ModelCallError) throw error;
      const sdkError = anthropicSdkModelCallError(error, "during_stream", this.timeoutMs);
      if (sdkError) throw sdkError;
      throw new ModelCallError(`Anthropic Messages API network failure: ${error instanceof Error ? error.message : String(error)}`, {
        failureKind: "network",
        providerStage: "during_stream",
        retryable: true,
        causeName: error instanceof Error ? error.name : undefined
      });
    }
  }
}

function anthropicInputFromMessages(messages: ChatMessage[]): { system?: string; messages: MessageParam[] } {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const nonSystem = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  return { system: system || undefined, messages: nonSystem };
}

function parseAnthropicMessage(message: Message, started: number, sdkRequestId: string | undefined): ModelCompletionResult {
  const content = message.content
    ?.filter((item) => item.type === "text")
    .map((item) => ("text" in item ? item.text : ""))
    .join("") ?? "";
  if (!content.trim()) {
    throw new ModelCallError("Anthropic Messages API response did not contain text content.", {
      failureKind: "empty_content",
      providerStage: "non_stream_parse",
      retryable: false,
      providerRequestId: message.id ?? sdkRequestId
    });
  }
  return {
    content,
    latencyMs: Math.round(performance.now() - started),
    usage: completionUsage(anthropicUsage(message.usage)),
    providerRequestId: message.id ?? sdkRequestId,
    attempts: 1
  };
}

function anthropicUsage(usage: Usage | MessageDeltaUsage | null | undefined): ChatCompletionUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens ?? undefined;
  const completionTokens = usage.output_tokens ?? undefined;
  const total =
    promptTokens === undefined && completionTokens === undefined
      ? undefined
      : (promptTokens ?? 0) + (completionTokens ?? 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: total
  };
}

function mergeUsage(current: ChatCompletionUsage | undefined, next: ChatCompletionUsage | undefined): ChatCompletionUsage | undefined {
  if (!next) return current;
  const promptTokens = next.prompt_tokens ?? current?.prompt_tokens;
  const completionTokens = next.completion_tokens ?? current?.completion_tokens;
  const totalTokens =
    promptTokens === undefined && completionTokens === undefined
      ? next.total_tokens ?? current?.total_tokens
      : (promptTokens ?? 0) + (completionTokens ?? 0);
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
}

function completionUsage(usage: ChatCompletionUsage | undefined): ModelCompletionResult["usage"] {
  return {
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens
  };
}

function finish(
  content: string,
  started: number,
  usage: ChatCompletionUsage | undefined,
  providerRequestId: string | undefined,
  completedBy: ProviderStreamCompletionMode
): ModelCompletionResult {
  if (!content.trim()) {
    throw new ModelCallError("Anthropic Messages stream completed without content.", {
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
    stream: { enabled: true, completed: true, completedBy }
  };
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function anthropicSdkModelCallError(error: unknown, stage: string, timeoutMs: number): ModelCallError | undefined {
  if (error instanceof APIUserAbortError) return abortedModelCallError(error, stage);
  if (error instanceof APIConnectionTimeoutError) return timeoutModelCallError(timeoutMs, stage);
  if (error instanceof APIConnectionError) {
    return new ModelCallError(`Anthropic Messages API network failure: ${error.message}`, {
      failureKind: "network",
      providerStage: stage,
      retryable: true,
      causeName: error.name
    });
  }
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    return new ModelCallError(`Anthropic Messages API HTTP ${status ?? "error"}: ${error.message.slice(0, 600)}`, {
      failureKind: status === undefined ? "unknown" : "http",
      providerStage: status === undefined ? stage : "http_response",
      status,
      retryable: status === undefined ? true : isRetryableHttpStatus(status),
      body: error.error,
      headers: error.headers ? Object.fromEntries(error.headers.entries()) : undefined,
      providerRequestId: error.requestID ?? undefined
    });
  }
  if (error instanceof SyntaxError) {
    return new ModelCallError(stage === "non_stream_parse" ? "Anthropic Messages API returned non-JSON response." : "Anthropic Messages stream emitted invalid JSON event.", {
      failureKind: stage === "non_stream_parse" ? "non_json" : "stream_invalid_json",
      providerStage: stage === "non_stream_parse" ? "non_stream_parse" : "stream_parse",
      retryable: false,
      error
    });
  }
  return undefined;
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function abortedModelCallError(reason: unknown, stage: string): ModelCallError {
  return new ModelCallError(`Anthropic Messages API request aborted${reason instanceof Error ? `: ${reason.message}` : "."}`, {
    failureKind: "abort",
    providerStage: stage,
    aborted: true,
    retryable: false,
    abortReason: reason instanceof Error ? reason.message : reason ? String(reason) : undefined
  });
}

function timeoutModelCallError(timeoutMs: number, stage: string): ModelCallError {
  return new ModelCallError(`Anthropic Messages API request timed out after ${timeoutMs}ms.`, {
    failureKind: "timeout",
    providerStage: stage,
    timeoutMs,
    retryable: true
  });
}
