import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError
} from "openai";
import type {
  Response as OpenAIResponseObject,
  ResponseInput,
  ResponseStreamEvent,
  ResponseUsage
} from "openai/resources/responses/responses";
import type { ModelClient, ModelCompletionRequest, ModelCompletionResult } from "./modelClient";
import { ModelCallError, type ChatMessage, type ChatCompletionUsage, type ProviderStreamCompletionMode, looksLikeHtmlGatewayPayload } from "./schema";
import { normalizeSdkBaseUrl } from "./providerUrls";

export interface OpenAIResponsesClientOptions {
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  stream?: boolean;
  fetch?: typeof fetch;
}

export class OpenAIResponsesClient implements ModelClient {
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly abortSignal?: AbortSignal;
  private readonly stream: boolean;

  constructor(options: OpenAIResponsesClientOptions) {
    if (!options.baseURL) throw new Error("OpenAI Responses SDK baseURL is required.");
    const baseURL = normalizeSdkBaseUrl(options.baseURL, "OpenAI Responses SDK baseURL");
    if (!options.apiKey.trim()) throw new Error("LLM_API_KEY is required for OpenAI Responses model calls.");
    this.timeoutMs = validatePositiveInteger(options.timeoutMs ?? 120_000, "OpenAI Responses timeout");
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
      const { instructions, input } = responsesInputFromMessages(request.messages);
      if (wantsStream) {
        const { data: stream, request_id: sdkRequestId } = await this.client.responses
          .create(
            removeUndefined({
              model: request.model,
              instructions,
              input,
              temperature: request.temperature,
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
      const { data: response, request_id: sdkRequestId } = await this.client.responses
        .create(
          removeUndefined({
            model: request.model,
            instructions,
            input,
            temperature: request.temperature,
            stream: false as const
          }),
          { signal: controller.signal, timeout: this.timeoutMs, maxRetries: 0 }
        )
        .withResponse();
      return parseResponsesObject(response, started, sdkRequestId ?? undefined);
    } catch (error) {
      if (timedOut) throw timeoutModelCallError(this.timeoutMs, stage);
      if (this.abortSignal?.aborted) throw abortedModelCallError(this.abortSignal.reason, stage);
      if (error instanceof ModelCallError) throw error;
      const sdkError = openAISdkModelCallError(error, stage, this.timeoutMs);
      if (sdkError) throw sdkError;
      throw new ModelCallError(`OpenAI Responses API network failure: ${error instanceof Error ? error.message : String(error)}`, {
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
    stream: AsyncIterable<ResponseStreamEvent>,
    started: number,
    sdkRequestId: string | undefined
  ): Promise<ModelCompletionResult> {
    let content = "";
    let providerRequestId = sdkRequestId;
    let usage: ChatCompletionUsage | undefined;

    try {
      for await (const event of stream) {
        if (this.abortSignal?.aborted) throw abortedModelCallError(this.abortSignal.reason, "during_stream");
        if (event.type === "response.created") {
          providerRequestId = event.response.id ?? providerRequestId;
        } else if (event.type === "response.output_text.delta") {
          content += event.delta ?? "";
        } else if (event.type === "response.completed") {
          providerRequestId = event.response.id ?? providerRequestId;
          usage = responsesUsage(event.response.usage) ?? usage;
          return finish(content, started, usage, providerRequestId, "provider_stop_event");
        } else if (event.type === "error") {
          throw new ModelCallError(`OpenAI Responses stream error: ${event.message}`, {
            failureKind: "unknown",
            providerStage: "during_stream",
            retryable: true,
            providerRequestId,
            code: event.code,
            param: event.param
          });
        } else if (event.type === "response.failed" || event.type === "response.incomplete") {
          providerRequestId = event.response.id ?? providerRequestId;
          throw new ModelCallError(`OpenAI Responses stream ended with ${event.type}.`, {
            failureKind: "unknown",
            providerStage: "during_stream",
            retryable: event.type === "response.incomplete",
            providerRequestId,
            status: event.response.status
          });
        }
      }
      // A partial text delta followed only by transport EOF is not a completed
      // Responses generation. `response.completed` is the provider terminal
      // event that authorizes this optional reasoner output to proceed to
      // parsing and arbitration; accepting EOF would risk committing a
      // truncated memo or speech draft.
      if (content) throw incompleteStreamModelCallError();
      return finish(content, started, usage, providerRequestId, "provider_stop_event");
    } catch (error) {
      if (error instanceof ModelCallError) throw error;
      const sdkError = openAISdkModelCallError(error, "during_stream", this.timeoutMs);
      if (sdkError) throw sdkError;
      throw new ModelCallError(`OpenAI Responses API network failure: ${error instanceof Error ? error.message : String(error)}`, {
        failureKind: "network",
        providerStage: "during_stream",
        retryable: true,
        causeName: error instanceof Error ? error.name : undefined
      });
    }
  }
}

function responsesInputFromMessages(messages: ChatMessage[]): { instructions?: string; input: ResponseInput } {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const input = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content })) as ResponseInput;
  return { instructions: instructions || undefined, input };
}

function parseResponsesObject(response: OpenAIResponseObject, started: number, sdkRequestId: string | undefined): ModelCompletionResult {
  const content = responseOutputText(response);
  if (!content.trim()) {
    throw new ModelCallError("OpenAI Responses API response did not contain text output.", {
      failureKind: "empty_content",
      providerStage: "non_stream_parse",
      retryable: false,
      providerRequestId: response.id ?? sdkRequestId
    });
  }
  return {
    content,
    latencyMs: Math.round(performance.now() - started),
    usage: completionUsage(responsesUsage(response.usage)),
    providerRequestId: response.id ?? sdkRequestId,
    attempts: 1
  };
}

function responseOutputText(response: OpenAIResponseObject): string {
  if (response.output_text) return response.output_text;
  const parts: string[] = [];
  for (const output of response.output ?? []) {
    if (!isRecord(output) || !Array.isArray(output.content)) continue;
    for (const content of output.content) {
      if (isRecord(content) && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("");
}

function responsesUsage(usage: ResponseUsage | null | undefined): ChatCompletionUsage | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
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

function finish(
  content: string,
  started: number,
  usage: ChatCompletionUsage | undefined,
  providerRequestId: string | undefined,
  completedBy: ProviderStreamCompletionMode
): ModelCompletionResult {
  if (!content.trim()) {
    throw new ModelCallError("OpenAI Responses stream completed without content.", {
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

function incompleteStreamModelCallError(): ModelCallError {
  return new ModelCallError("OpenAI Responses stream ended before a provider completion event.", {
    failureKind: "stream_incomplete",
    providerStage: "stream_finish",
    retryable: true
  });
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function openAISdkModelCallError(error: unknown, stage: string, timeoutMs: number): ModelCallError | undefined {
  if (error instanceof APIUserAbortError) return abortedModelCallError(error, stage);
  if (error instanceof APIConnectionTimeoutError) return timeoutModelCallError(timeoutMs, stage);
  if (error instanceof APIConnectionError) {
    return new ModelCallError(`OpenAI Responses API network failure: ${error.message}`, {
      failureKind: "network",
      providerStage: stage,
      retryable: true,
      causeName: error.name
    });
  }
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const htmlGateway = looksLikeHtmlGatewayPayload(error.message) || looksLikeHtmlGatewayPayload(error.error);
    const failureKind = status === undefined ? "unknown" : htmlGateway ? "gateway_html" : "http";
    const message = htmlGateway
      ? `OpenAI Responses API HTTP ${status ?? "error"}: gateway returned HTML (likely wrong endpoint path or gateway auth failure).`
      : `OpenAI Responses API HTTP ${status ?? "error"}: ${error.message.slice(0, 600)}`;
    return new ModelCallError(message, {
      failureKind,
      providerStage: status === undefined ? stage : "http_response",
      status,
      retryable: status === undefined ? true : isRetryableHttpStatus(status),
      body: error.error,
      headers: error.headers ? Object.fromEntries(error.headers.entries()) : undefined,
      providerRequestId: error.requestID ?? undefined
    });
  }
  if (error instanceof SyntaxError) {
    return new ModelCallError(stage === "non_stream_parse" ? "OpenAI Responses API returned non-JSON response." : "OpenAI Responses stream emitted invalid JSON event.", {
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
  return new ModelCallError(`OpenAI Responses API request aborted${reason instanceof Error ? `: ${reason.message}` : "."}`, {
    failureKind: "abort",
    providerStage: stage,
    aborted: true,
    retryable: false,
    abortReason: reason instanceof Error ? reason.message : reason ? String(reason) : undefined
  });
}

function timeoutModelCallError(timeoutMs: number, stage: string): ModelCallError {
  return new ModelCallError(`OpenAI Responses API request timed out after ${timeoutMs}ms.`, {
    failureKind: "timeout",
    providerStage: stage,
    timeoutMs,
    retryable: true
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
