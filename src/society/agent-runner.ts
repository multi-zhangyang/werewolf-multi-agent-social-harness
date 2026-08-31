import { OpenAIProvider, Runner, type AgentInputItem } from "@openai/agents";
import OpenAI from "openai";
import { sanitizeFunctionCallArgs } from "./wire-json";

export interface SocietyProviderOptions {
  apiKey: string;
  baseURL?: string;
  useResponses: boolean;
  timeoutMs: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

/** One provider construction path shared by live agents and protocol checks. */
export function createSocietyProvider(options: SocietyProviderOptions): OpenAIProvider {
  return new OpenAIProvider({
    useResponses: options.useResponses,
    openAIClient: new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries ?? 1,
      ...(options.fetch ? { fetch: options.fetch } : {})
    })
  });
}

/**
 * One Runner construction path. Every history path receives the same generic
 * function-call argument sanitizer; it never inspects provider or model ids.
 */
export function createSocietyRunner(
  provider: OpenAIProvider,
  combineInput?: (historyItems: AgentInputItem[], newItems: AgentInputItem[]) => AgentInputItem[] | Promise<AgentInputItem[]>
): Runner {
  return new Runner({
    modelProvider: provider,
    tracingDisabled: true,
    sessionInputCallback: async (historyItems, newItems) => sanitizeFunctionCallArgs(
      combineInput ? await combineInput(historyItems, newItems) : [...historyItems, ...newItems]
    )
  });
}
