import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesClient } from "../src/agents/anthropicMessagesClient";
import { OpenAIResponsesClient } from "../src/agents/openaiResponsesClient";
import {
  modelClientFromEnv,
  optionalAnthropicMessagesBaseUrlFromEnv,
  optionalResponsesBaseUrlFromEnv,
  providerConfigSummaryFromEnv,
  providerDiagnosticSummaryFromEnv
} from "../src/agents/providerRegistry";
import { ModelCallError } from "../src/agents/schema";
import { assertRuntimeModelsAvailable, normalizeModelList, selectableRuntimeModels } from "../src/agents/schema";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("standard provider protocol adapters", () => {
  it("keeps slash-delimited provider model ids intact while splitting comma and whitespace lists", () => {
    expect(normalizeModelList("openrouter/model-a,anthropic/model-b local-model")).toEqual([
      "openrouter/model-a",
      "anthropic/model-b",
      "local-model"
    ]);
  });

  it("does not offer or execute an explicitly withdrawn runtime model", () => {
    expect(selectableRuntimeModels(["gpt-5.4/Kimi-K2.6", "grok-4.5"])).toEqual(["gpt-5.4/Kimi-K2.6"]);
    expect(() => assertRuntimeModelsAvailable(["grok-4.5"], "unit selection")).toThrow(/unavailable for runtime use/i);
    expect(() => assertRuntimeModelsAvailable(["gpt-5.4/Kimi-K2.6"])).not.toThrow();
  });

  it("selects provider adapters only from explicit protocol configuration", async () => {
    const chat = modelClientFromEnv({
      LLM_CHAT_COMPLETIONS_URL: "https://provider.test/v1/chat/completions",
      LLM_API_KEY: "unit-test-key",
      LLM_MODELS: "model-a,model-b"
    } as NodeJS.ProcessEnv);
    expect(chat.constructor.name).toBe("OpenAICompatibleClient");
    expect(providerConfigSummaryFromEnv({
      LLM_PROVIDER_PROTOCOL: "openai-responses",
      LLM_RESPONSES_URL: "https://provider.test/v1/responses",
      LLM_API_KEY: "unit-test-key",
      LLM_MODELS: "model-a"
    } as NodeJS.ProcessEnv)).toEqual({
      protocol: "openai-responses",
      endpoint: "https://provider.test/v1/responses",
      configured: true,
      models: ["model-a"]
    });
    expect(providerDiagnosticSummaryFromEnv({
      LLM_PROVIDER_PROTOCOL: "openai-responses",
      LLM_RESPONSES_URL: "https://provider.test/v1/responses",
      LLM_API_KEY: "unit-test-key",
      LLM_MODELS: "model-a"
    } as NodeJS.ProcessEnv)).toEqual({
      protocol: "openai-responses",
      configured: true
    });
    expect(providerDiagnosticSummaryFromEnv({
      LLM_PROVIDER_PROTOCOL: "unsupported-provider"
    } as NodeJS.ProcessEnv)).toEqual({
      protocol: null,
      configured: false
    });
    expect(() =>
      modelClientFromEnv({
        LLM_PROVIDER_PROTOCOL: "anthropic-messages",
        ANTHROPIC_MESSAGES_URL: "https://api.anthropic.test/v1/messages",
        ANTHROPIC_API_KEY: "unit-test-key",
        LLM_MODELS: "model-with-no-protocol-meaning"
      } as NodeJS.ProcessEnv)
    ).toThrow(/ANTHROPIC_MAX_TOKENS/);
  });

  it("threads configured and explicit bounded retry policy through non-Chat provider registry clients", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(
        streamResponse([
          sse("response.output_text.delta", { type: "response.output_text.delta", delta: "recovered" }),
          sse("response.completed", { type: "response.completed", response: { id: "resp-retry" } })
        ])
      )
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }));
    vi.stubGlobal("fetch", fetchMock);

    const configuredRetries = await modelClientFromEnv({
      LLM_PROVIDER_PROTOCOL: "openai-responses",
      LLM_RESPONSES_URL: "https://provider.test/v1/responses",
      LLM_API_KEY: "unit-test-key",
      LLM_RETRY_COUNT: "1"
    } as NodeJS.ProcessEnv).complete({
      model: "responses-model",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(configuredRetries).toMatchObject({
      content: "recovered",
      attempts: 2,
      retryHistory: [
        {
          attempt: 1,
          failureKind: "http",
          providerStage: "http_response",
          status: 429,
          retryable: true,
          delayMs: 0
        }
      ]
    });

    const explicitOverrideError = await captureModelCallError(() =>
      modelClientFromEnv(
        {
          LLM_PROVIDER_PROTOCOL: "anthropic-messages",
          ANTHROPIC_MESSAGES_URL: "https://api.anthropic.test/v1/messages",
          ANTHROPIC_API_KEY: "unit-test-key",
          ANTHROPIC_MAX_TOKENS: "64",
          LLM_RETRY_COUNT: "1"
        } as NodeJS.ProcessEnv,
        { maxRetries: 0 }
      ).complete({
        model: "anthropic-messages-model",
        messages: [{ role: "user", content: "hello" }]
      })
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(explicitOverrideError.raw).toMatchObject({
      failureKind: "http",
      providerStage: "http_response",
      status: 429,
      retryable: true,
      attempts: 1,
      maxAttempts: 1,
      retryHistory: [
        expect.objectContaining({ attempt: 1, retryable: true, status: 429 })
      ]
    });
  });

  it("derives SDK base URLs only by stripping standard protocol resource suffixes", () => {
    expect(
      optionalResponsesBaseUrlFromEnv({
        LLM_RESPONSES_URL: "https://provider.test/proxy/openai/v1/responses"
      } as NodeJS.ProcessEnv)
    ).toBe("https://provider.test/proxy/openai/v1");
    expect(
      optionalResponsesBaseUrlFromEnv({
        LLM_BASE_URL: "https://provider.test/proxy/openai/v1"
      } as NodeJS.ProcessEnv)
    ).toBe("https://provider.test/proxy/openai/v1");
    expect(
      optionalAnthropicMessagesBaseUrlFromEnv({
        ANTHROPIC_MESSAGES_URL: "https://provider.test/proxy/anthropic/v1/messages"
      } as NodeJS.ProcessEnv)
    ).toBe("https://provider.test/proxy/anthropic");
    expect(() =>
      optionalResponsesBaseUrlFromEnv({
        LLM_RESPONSES_URL: "https://provider.test/proxy/openai/v1/chat/completions"
      } as NodeJS.ProcessEnv)
    ).toThrow(/responses/);
    expect(() =>
      optionalAnthropicMessagesBaseUrlFromEnv({
        ANTHROPIC_MESSAGES_URL: "https://provider.test/proxy/anthropic/messages"
      } as NodeJS.ProcessEnv)
    ).toThrow(/v1\/messages/);
  });

  it("maps OpenAI Responses requests and parses output_text delta stream without max-token fields", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      streamResponse([
        sse("response.output_text.delta", { type: "response.output_text.delta", delta: "hello " }),
        sse("response.output_text.delta", { type: "response.output_text.delta", delta: "world" }),
        sse("response.completed", {
          type: "response.completed",
          response: { id: "resp-1", usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 } }
        })
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OpenAIResponsesClient({
      baseURL: "https://api.openai.test/v1",
      apiKey: "unit-test-key",
      timeoutMs: 1_000
    }).complete({
      model: "responses-model",
      temperature: 0.2,
      messages: [
        { role: "system", content: "system rules" },
        { role: "user", content: "hello" }
      ]
    });

    expect(result).toMatchObject({
      content: "hello world",
      providerRequestId: "resp-1",
      usage: { promptTokens: 11, completionTokens: 2, totalTokens: 13 },
      stream: { enabled: true, completed: true, completedBy: "provider_stop_event" }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = requestBody(fetchMock, 0);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.test/v1/responses");
    expect(body).toEqual({
      model: "responses-model",
      instructions: "system rules",
      input: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      stream: true
    });
    expect(Object.keys(body).some((key) => /max.*tokens?/i.test(key))).toBe(false);
  });

  it("rejects a non-empty OpenAI Responses stream that reaches EOF without response.completed", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      streamResponse([sse("response.output_text.delta", { type: "response.output_text.delta", delta: "partial response" })])
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureModelCallError(() =>
      new OpenAIResponsesClient({
        baseURL: "https://api.openai.test/v1",
        apiKey: "unit-test-key",
        timeoutMs: 1_000,
        maxRetries: 0
      }).complete({
        model: "responses-model",
        messages: [{ role: "user", content: "hello" }]
      })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.raw).toMatchObject({
      failureKind: "stream_incomplete",
      providerStage: "stream_finish",
      retryable: true
    });
  });

  it("retries a retryable OpenAI Responses stream failure before returning a provider-completed stream", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(
        streamResponse([
          sse("response.output_text.delta", { type: "response.output_text.delta", delta: "hello again" }),
          sse("response.completed", { type: "response.completed", response: { id: "resp-recovered" } })
        ])
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OpenAIResponsesClient({
      baseURL: "https://api.openai.test/v1",
      apiKey: "unit-test-key",
      timeoutMs: 1_000,
      maxRetries: 1
    }).complete({
      model: "responses-model",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      content: "hello again",
      attempts: 2,
      retryHistory: [
        {
          attempt: 1,
          failureKind: "http",
          providerStage: "http_response",
          status: 429,
          retryable: true,
          delayMs: 0
        }
      ],
      stream: { enabled: true, completed: true, completedBy: "provider_stop_event" }
    });
  });

  it("maps Anthropic Messages requests and parses content_block_delta stream as a separate protocol", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      streamResponse([
        sse("message_start", { type: "message_start", message: { id: "msg-1", usage: { input_tokens: 7, output_tokens: 0 } } }),
        sse("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } }),
        sse("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "world" } }),
        sse("message_delta", { type: "message_delta", usage: { output_tokens: 2 } }),
        sse("message_stop", { type: "message_stop" })
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AnthropicMessagesClient({
      baseURL: "https://api.anthropic.test",
      apiKey: "unit-test-key",
      maxTokens: 512,
      timeoutMs: 1_000
    }).complete({
      model: "anthropic-messages-model",
      temperature: 0.3,
      messages: [
        { role: "system", content: "system rules" },
        { role: "user", content: "hello" }
      ]
    });

    expect(result).toMatchObject({
      content: "hello world",
      providerRequestId: "msg-1",
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
      stream: { enabled: true, completed: true, completedBy: "provider_stop_event" }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    const headers = init?.headers;
    const body = requestBody(fetchMock, 0);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.test/v1/messages");
    expect(headerValue(headers, "x-api-key")).toBe("unit-test-key");
    expect(headerValue(headers, "anthropic-version")).toBe("2023-06-01");
    expect(body).toEqual({
      model: "anthropic-messages-model",
      system: "system rules",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.3,
      max_tokens: 512,
      stream: true
    });
  });

  it("rejects a non-empty Anthropic Messages stream that reaches EOF without message_stop", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      streamResponse([
        sse("message_start", { type: "message_start", message: { id: "msg-partial", usage: { input_tokens: 1, output_tokens: 0 } } }),
        sse("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "partial message" } })
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureModelCallError(() =>
      new AnthropicMessagesClient({
        baseURL: "https://api.anthropic.test",
        apiKey: "unit-test-key",
        maxTokens: 512,
        timeoutMs: 1_000,
        maxRetries: 0
      }).complete({
        model: "anthropic-messages-model",
        messages: [{ role: "user", content: "hello" }]
      })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.raw).toMatchObject({
      failureKind: "stream_incomplete",
      providerStage: "stream_finish",
      retryable: true
    });
  });

  it("retries a retryable Anthropic Messages stream failure before returning a provider-completed stream", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(
        streamResponse([
          sse("message_start", { type: "message_start", message: { id: "msg-recovered", usage: { input_tokens: 1, output_tokens: 0 } } }),
          sse("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "hello again" } }),
          sse("message_stop", { type: "message_stop" })
        ])
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AnthropicMessagesClient({
      baseURL: "https://api.anthropic.test",
      apiKey: "unit-test-key",
      maxTokens: 512,
      timeoutMs: 1_000,
      maxRetries: 1
    }).complete({
      model: "anthropic-messages-model",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      content: "hello again",
      attempts: 2,
      retryHistory: [
        {
          attempt: 1,
          failureKind: "http",
          providerStage: "http_response",
          status: 429,
          retryable: true,
          delayMs: 0
        }
      ],
      stream: { enabled: true, completed: true, completedBy: "provider_stop_event" }
    });
  });

  it("requires explicit Anthropic max_tokens because Messages API is not the Chat Completions protocol", () => {
    expect(
      () =>
        new AnthropicMessagesClient({
          baseURL: "https://api.anthropic.test",
          apiKey: "unit-test-key",
          maxTokens: 0
        })
    ).toThrow(/max_tokens/);
  });
});

function streamResponse(lines: string[]): Response {
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[callIndex][1]?.body)) as Record<string, unknown>;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (headers && typeof headers === "object") {
    const record = headers as Record<string, string | undefined>;
    return record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  }
  return undefined;
}

async function captureModelCallError(run: () => Promise<unknown>): Promise<ModelCallError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelCallError);
    return error as ModelCallError;
  }
  throw new Error("Expected ModelCallError.");
}
