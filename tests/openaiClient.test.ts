import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatCompletionsBaseUrlFromEnv,
  chatCompletionsUrlFromEnv,
  OpenAICompatibleClient,
  optionalChatCompletionsUrlFromEnv
} from "../src/agents/openaiClient";
import { ModelCallError } from "../src/agents/schema";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible client provider telemetry", () => {
  it("requires explicit standard OpenAI-compatible endpoint configuration instead of using a provider default", () => {
    expect(optionalChatCompletionsUrlFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(() => chatCompletionsUrlFromEnv({} as NodeJS.ProcessEnv)).toThrow(/LLM_CHAT_COMPLETIONS_URL or LLM_BASE_URL/);
    expect(
      chatCompletionsUrlFromEnv({
        LLM_BASE_URL: "https://openai-compatible.example/v1"
      } as NodeJS.ProcessEnv)
    ).toBe("https://openai-compatible.example/v1/chat/completions");
    expect(
      chatCompletionsUrlFromEnv({
        LLM_CHAT_COMPLETIONS_URL: "https://openai-compatible.example/v1/chat/completions"
      } as NodeJS.ProcessEnv)
    ).toBe("https://openai-compatible.example/v1/chat/completions");
    expect(
      chatCompletionsBaseUrlFromEnv({
        LLM_CHAT_COMPLETIONS_URL: "https://openai-compatible.example/proxy/openai/v1/chat/completions"
      } as NodeJS.ProcessEnv)
    ).toBe("https://openai-compatible.example/proxy/openai/v1");
    expect(
      chatCompletionsBaseUrlFromEnv({
        LLM_BASE_URL: "https://openai-compatible.example/proxy/openai/v1"
      } as NodeJS.ProcessEnv)
    ).toBe("https://openai-compatible.example/proxy/openai/v1");
    expect(() =>
      chatCompletionsBaseUrlFromEnv({
        LLM_CHAT_COMPLETIONS_URL: "https://openai-compatible.example/v1/responses"
      } as NodeJS.ProcessEnv)
    ).toThrow(/chat\/completions/);
  });

  it("records retry history when a retryable HTTP failure is followed by streaming success", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(streamResponse([chunk({ id: "stream-ok", choices: [{ delta: { content: "hello" } }] }), doneChunk()]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client({ maxRetries: 1 }).complete(request());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      content: "hello",
      providerRequestId: "stream-ok",
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
      stream: {
        enabled: true,
        completed: true,
        completedBy: "reader_done"
      }
    });
    expect(fetchMock.mock.calls[1][0]).toBe("https://provider.test/openai/v1/chat/completions");
    expect(requestBody(fetchMock, 0)).toMatchObject({ stream: true, model: "unit-model" });
  });

  it("sends streaming requests without max-token limits", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(streamResponse([chunk({ id: "no-max-token", choices: [{ delta: { content: "hello" } }] }), doneChunk()]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().complete(request());
    const body = requestBody(fetchMock, 0);

    expect(result.stream).toMatchObject({ enabled: true, completed: true });
    expect(fetchMock.mock.calls[0][0]).toBe("https://provider.test/openai/v1/chat/completions");
    expect(body).toMatchObject({
      model: "unit-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
      stream: true
    });
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream", "temperature"]);
    for (const key of [
      "max_token",
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
      "maxToken",
      "maxTokens",
      "maxCompletionTokens",
      "maxOutputTokens"
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("does not retry non-retryable HTTP failures and preserves final retry history", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureModelCallError(() => client({ maxRetries: 2 }).complete(request()));
    const raw = error.raw as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(raw).toMatchObject({
      failureKind: "http",
      providerStage: "http_response",
      status: 400,
      retryable: false,
      attempts: 1,
      maxAttempts: 3,
      retryHistory: [
        expect.objectContaining({
          attempt: 1,
          failureKind: "http",
          providerStage: "http_response",
          status: 400,
          retryable: false
        })
      ]
    });
  });

  it("classifies nginx HTML gateway auth failures as gateway_html", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      new Response(
        "<html>\r\n<head><title>401 Authorization Required</title></head>\r\n<body>\r\n<center><h1>401 Authorization Required</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n",
        {
          status: 401,
          headers: { "content-type": "text/html" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureModelCallError(() => client({ maxRetries: 1 }).complete(request()));
    const raw = error.raw as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.message).toContain("gateway returned HTML");
    expect(error.message).not.toMatch(/sk-|Bearer\s+/i);
    expect(raw).toMatchObject({
      failureKind: "gateway_html",
      providerStage: "http_response",
      status: 401,
      retryable: false,
      attempts: 1,
      maxAttempts: 2
    });
  });

  it("records reader_done when a stream succeeds without a DONE sentinel", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(streamResponse([chunk({ id: "reader-done", choices: [{ delta: { content: "partial but valid" } }] })]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().complete(request());

    expect(result).toMatchObject({
      content: "partial but valid",
      providerRequestId: "reader-done",
      stream: {
        enabled: true,
        completed: true,
        completedBy: "reader_done"
      }
    });
  });

  it("classifies invalid streaming JSON without retrying unsafe parse failures", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(streamResponse(["data: {not-json}\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureModelCallError(() => client({ maxRetries: 2 }).complete(request()));
    const raw = error.raw as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(raw).toMatchObject({
      failureKind: "stream_invalid_json",
      providerStage: "stream_parse",
      retryable: false,
      attempts: 1,
      maxAttempts: 3,
      retryHistory: [
        expect.objectContaining({
          attempt: 1,
          failureKind: "stream_invalid_json",
          providerStage: "stream_parse",
          retryable: false
        })
      ]
    });
  });

  it("classifies empty streaming responses and keeps retry history on final failure", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(streamResponse([doneChunk()]));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureModelCallError(() => client({ maxRetries: 0 }).complete(request()));
    const raw = error.raw as Record<string, unknown>;

    expect(raw).toMatchObject({
      failureKind: "stream_empty",
      providerStage: "stream_finish",
      retryable: true,
      attempts: 1,
      maxAttempts: 1,
      retryHistory: [
        expect.objectContaining({
          attempt: 1,
          failureKind: "stream_empty",
          providerStage: "stream_finish",
          retryable: true
        })
      ]
    });
  });

  it("classifies aborts before fetch starts and does not call the provider", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const abortController = new AbortController();
    abortController.abort(new Error("manual abort"));

    const error = await captureModelCallError(() => client({ abortSignal: abortController.signal }).complete(request()));
    const raw = error.raw as Record<string, unknown>;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(raw).toMatchObject({
      failureKind: "abort",
      providerStage: "before_start",
      aborted: true,
      retryable: false,
      abortReason: "manual abort",
      attempts: 1,
      maxAttempts: 1
    });
  });

  it("classifies network failures from fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockRejectedValueOnce(new Error("fetch failed: socket closed"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureModelCallError(() => client({ maxRetries: 0 }).complete(request()));
    const raw = error.raw as Record<string, unknown>;

    expect(raw).toMatchObject({
      failureKind: "network",
      providerStage: "during_request",
      retryable: true,
      causeName: "Error",
      attempts: 1,
      maxAttempts: 1
    });
  });

  it("classifies non-stream parse and empty-content failures", async () => {
    const parseFailureFetch = vi.fn<typeof fetch>();
    parseFailureFetch.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    vi.stubGlobal("fetch", parseFailureFetch);

    const parseError = await captureModelCallError(() => client({ stream: false }).complete(request({ stream: false })));
    expect(parseError.raw).toMatchObject({
      failureKind: "non_json",
      providerStage: "non_stream_parse",
      retryable: false
    });

    vi.unstubAllGlobals();
    const emptyContentFetch = vi.fn<typeof fetch>();
    emptyContentFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "empty", choices: [{ message: { content: "" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", emptyContentFetch);

    const emptyError = await captureModelCallError(() => client({ stream: false }).complete(request({ stream: false })));
    expect(emptyError.raw).toMatchObject({
      failureKind: "empty_content",
      providerStage: "non_stream_parse",
      retryable: false,
      providerRequestId: "empty"
    });
  });
});

function client(overrides: Partial<ConstructorParameters<typeof OpenAICompatibleClient>[0]> = {}): OpenAICompatibleClient {
  return new OpenAICompatibleClient({
    baseURL: "https://provider.test/openai/v1",
    apiKey: "unit-test-key",
    timeoutMs: 1_000,
    maxRetries: 0,
    stream: true,
    ...overrides
  });
}

function request(overrides: Partial<Parameters<OpenAICompatibleClient["complete"]>[0]> = {}): Parameters<OpenAICompatibleClient["complete"]>[0] {
  return {
    model: "unit-model",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0,
    ...overrides
  };
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

function streamResponse(lines: string[]): Response {
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function chunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function doneChunk(): string {
  return "data: [DONE]\n\n";
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[callIndex][1]?.body)) as Record<string, unknown>;
}
