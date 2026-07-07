import type { ChatMessage, ProviderRetryHistoryEntry, ProviderStreamTelemetry } from "./schema";

export interface ModelCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  stream?: boolean;
}

export interface ModelCompletionResult {
  content: string;
  latencyMs: number;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  providerRequestId?: string;
  attempts?: number;
  retryHistory?: ProviderRetryHistoryEntry[];
  stream?: ProviderStreamTelemetry;
}

export interface ModelClient {
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResult>;
}

