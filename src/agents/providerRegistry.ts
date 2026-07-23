import { AnthropicMessagesClient } from "./anthropicMessagesClient";
import type { ModelClient } from "./modelClient";
import {
  OpenAICompatibleClient,
  optionalChatCompletionsBaseUrlFromEnv,
  optionalChatCompletionsUrlFromEnv
} from "./openaiClient";
import { OpenAIResponsesClient } from "./openaiResponsesClient";
import { baseUrlFromEndpointUrl, endpointUrlFromBaseUrl, normalizeSdkBaseUrl, validateEndpointUrl } from "./providerUrls";
import { normalizeModelList, selectableRuntimeModels } from "./schema";

export type ModelProviderProtocol = "openai-chat-completions" | "openai-responses" | "anthropic-messages";

const RESPONSES_PATH = "/responses";
const ANTHROPIC_MESSAGES_PATH = "/v1/messages";

export interface ProviderClientOverrides {
  timeoutMs?: number;
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

export interface ProviderConfigSummary {
  protocol: ModelProviderProtocol;
  endpoint: string | null;
  configured: boolean;
  models: string[];
}

/** A CLI-safe provider status that deliberately omits endpoint and model details. */
export interface ProviderDiagnosticSummary {
  protocol: ModelProviderProtocol | null;
  configured: boolean;
}

export function modelClientFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: ProviderClientOverrides = {}): ModelClient {
  if (env.LLM_STREAM?.trim().toLowerCase() === "false") {
    throw new Error(
      "LLM_STREAM=false is not allowed by the live runtime provider factory; use an explicitly constructed client only in isolated non-live tests."
    );
  }
  const protocol = providerProtocolFromEnv(env);
  if (protocol === "openai-chat-completions") {
    return new OpenAICompatibleClient({
      baseURL: requiredValue(optionalChatCompletionsBaseUrlFromEnv(env), "LLM_CHAT_COMPLETIONS_URL or LLM_BASE_URL is required for OpenAI-compatible chat completions."),
      apiKey: env.LLM_API_KEY ?? "",
      timeoutMs: overrides.timeoutMs ?? parseOptionalIntegerEnv(env.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS"),
      maxRetries: overrides.maxRetries ?? parseOptionalNonNegativeIntegerEnv(env.LLM_RETRY_COUNT, "LLM_RETRY_COUNT"),
      abortSignal: overrides.abortSignal,
      stream: env.LLM_STREAM === undefined ? true : env.LLM_STREAM !== "false"
    });
  }
  if (protocol === "openai-responses") {
    return new OpenAIResponsesClient({
      baseURL: requiredValue(optionalResponsesBaseUrlFromEnv(env), "LLM_RESPONSES_URL or LLM_BASE_URL is required for OpenAI Responses."),
      apiKey: env.LLM_API_KEY ?? "",
      timeoutMs: overrides.timeoutMs ?? parseOptionalIntegerEnv(env.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS"),
      maxRetries: overrides.maxRetries ?? parseOptionalNonNegativeIntegerEnv(env.LLM_RETRY_COUNT, "LLM_RETRY_COUNT"),
      abortSignal: overrides.abortSignal,
      stream: env.LLM_STREAM === undefined ? true : env.LLM_STREAM !== "false"
    });
  }
  return new AnthropicMessagesClient({
    baseURL: requiredValue(optionalAnthropicMessagesBaseUrlFromEnv(env), "ANTHROPIC_MESSAGES_URL is required for Anthropic Messages."),
    apiKey: env.ANTHROPIC_API_KEY ?? env.LLM_API_KEY ?? "",
    maxTokens: parseRequiredIntegerEnv(env.ANTHROPIC_MAX_TOKENS, "ANTHROPIC_MAX_TOKENS"),
    anthropicVersion: env.ANTHROPIC_VERSION,
    timeoutMs: overrides.timeoutMs ?? parseOptionalIntegerEnv(env.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS"),
    maxRetries: overrides.maxRetries ?? parseOptionalNonNegativeIntegerEnv(env.LLM_RETRY_COUNT, "LLM_RETRY_COUNT"),
    abortSignal: overrides.abortSignal,
    stream: env.LLM_STREAM === undefined ? true : env.LLM_STREAM !== "false"
  });
}

export function providerConfigSummaryFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfigSummary {
  const protocol = providerProtocolFromEnv(env);
  const endpoint =
    protocol === "openai-chat-completions"
      ? optionalChatCompletionsUrlFromEnv(env) ?? null
      : protocol === "openai-responses"
        ? optionalResponsesUrlFromEnv(env) ?? null
        : optionalAnthropicMessagesUrlFromEnv(env) ?? null;
  const hasKey =
    protocol === "anthropic-messages" ? Boolean(env.ANTHROPIC_API_KEY || env.LLM_API_KEY) : Boolean(env.LLM_API_KEY);
  const hasProtocolRequiredConfig = protocol !== "anthropic-messages" || Boolean(env.ANTHROPIC_MAX_TOKENS);
  return {
    protocol,
    endpoint,
    configured: Boolean(endpoint && hasKey && hasProtocolRequiredConfig),
    models: selectableRuntimeModels(normalizeModelList(env.LLM_MODELS))
  };
}

export function providerDiagnosticSummaryFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderDiagnosticSummary {
  try {
    const config = providerConfigSummaryFromEnv(env);
    return {
      protocol: config.protocol,
      configured: config.configured
    };
  } catch {
    return {
      protocol: null,
      configured: false
    };
  }
}

export function providerProtocolFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProviderProtocol {
  const value = (env.LLM_PROVIDER_PROTOCOL ?? "openai-chat-completions").trim();
  if (value === "openai-chat-completions" || value === "openai-responses" || value === "anthropic-messages") return value;
  throw new Error("LLM_PROVIDER_PROTOCOL must be openai-chat-completions, openai-responses, or anthropic-messages.");
}

export function optionalResponsesUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.LLM_RESPONSES_URL) return validateEndpointUrl(env.LLM_RESPONSES_URL, RESPONSES_PATH, "LLM_RESPONSES_URL");
  if (!env.LLM_BASE_URL) return undefined;
  return endpointUrlFromBaseUrl(env.LLM_BASE_URL, RESPONSES_PATH, "LLM_BASE_URL");
}

export function optionalResponsesBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.LLM_RESPONSES_URL) return baseUrlFromEndpointUrl(env.LLM_RESPONSES_URL, RESPONSES_PATH, "LLM_RESPONSES_URL");
  if (!env.LLM_BASE_URL) return undefined;
  return normalizeSdkBaseUrl(env.LLM_BASE_URL, "LLM_BASE_URL");
}

export function optionalAnthropicMessagesUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.ANTHROPIC_MESSAGES_URL) return undefined;
  return validateEndpointUrl(env.ANTHROPIC_MESSAGES_URL, ANTHROPIC_MESSAGES_PATH, "ANTHROPIC_MESSAGES_URL");
}

export function optionalAnthropicMessagesBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.ANTHROPIC_MESSAGES_URL) return undefined;
  return baseUrlFromEndpointUrl(env.ANTHROPIC_MESSAGES_URL, ANTHROPIC_MESSAGES_PATH, "ANTHROPIC_MESSAGES_URL");
}

function requiredValue(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function parseOptionalIntegerEnv(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return parseRequiredIntegerEnv(value, name);
}

function parseOptionalNonNegativeIntegerEnv(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function parseRequiredIntegerEnv(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
