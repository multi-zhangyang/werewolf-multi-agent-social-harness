import type { ModelResponse, ModelRequest } from "@openai/agents";
import type OpenAI from "openai";

export interface ModelReceipt {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  responseId?: string;
  finishReason?: string;
  outputError?: "truncated" | "invalid_tool_arguments" | "provider_terminated";
}

/** Read-only diagnostics for both archived SDK responses and native replay responses. */
export function inspectModelResponse(response: ModelResponse | OpenAI.Responses.Response, request?: ModelRequest) {
  const raw = ("providerData" in response ? response.providerData : response) as {
    choices?: OpenAI.ChatCompletion["choices"]; status?: OpenAI.Responses.Response["status"];
    incomplete_details?: { reason?: string }; error?: { message?: string } | null;
  } | undefined;
  const finishReason = raw?.choices?.[0]?.finish_reason ?? raw?.status;
  let outputError: ModelReceipt["outputError"];
  let error: string | undefined;
  if (finishReason === "length" || raw?.status === "incomplete" && raw.incomplete_details?.reason === "max_output_tokens") {
    outputError = "truncated"; error = "模型输出未完成：达到输出预算";
  } else if (finishReason === "content_filter" || raw?.status === "incomplete" || raw?.status === "failed" || raw?.status === "cancelled") {
    outputError = "provider_terminated"; error = `模型输出未完成：${raw?.incomplete_details?.reason ?? raw?.error?.message ?? "提供商终止响应"}`;
  } else {
    for (const item of response.output) if (item.type === "function_call") {
      try { JSON.parse(item.arguments); }
      catch {
        // Some compatible providers return tool_calls even when arguments were
        // cut off. Never send this broken record back through SDK correction.
        const outputTokens = response.usage && ("outputTokens" in response.usage ? response.usage.outputTokens : response.usage.output_tokens) || 0;
        const exhausted = request?.modelSettings?.maxTokens !== undefined && outputTokens >= request.modelSettings.maxTokens;
        outputError = exhausted ? "truncated" : "invalid_tool_arguments";
        error = `模型工具参数不是完整 JSON${exhausted ? "：达到输出预算" : ""}`;
        break;
      }
    }
  }
  return { finishReason, outputError, error };
}

// Historical request type retained only for archived cases and fixture compatibility.
export interface ModelExchange { request: ModelRequest; response?: ModelResponse; error?: string; durationMs: number; }
