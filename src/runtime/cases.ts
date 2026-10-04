import { randomUUID } from "node:crypto";
import { agentSourceHash } from "../agents/provenance";
import type { ModelRequest } from "@openai/agents";
import type { ModelExchange } from "./model";
import type { NativeExchange, NativeStream } from "../agents/sdk";
import type { TurnContext } from "./types";

export interface DecisionCase {
  id: string; runId: string; actorId: string; opportunityId: string; phase: string; createdAt: string;
  sourceHash: string; context: Record<string, unknown>; configuration: Record<string, unknown>;
  request: unknown; providerRequest?: unknown; requestFormat?: "native-responses" | "sdk-model-request";
  response?: unknown; error?: string; durationMs: number;
  inputTokens?: number; outputTokens?: number; finishReason?: string; stream?: NativeStream; sdkOutput?: unknown;
  originCaseId?: string;
}
export function redact<T>(value: T): T {
  const secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value && value.length > 6).map(([, value]) => value!);
  let json = JSON.stringify(value, (key, v) => /^(authorization|apiKey|api_key|cookie|headers)$/i.test(key) ? "[redacted]" : v);
  for (const secret of secrets) json = json.split(secret).join("[redacted]");
  return JSON.parse(json.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]"));
}
let hash: string | undefined;
export function sourceHash() {
  if (!hash) {
    hash = agentSourceHash();
  }
  return hash;
}
export function decisionCase(c: TurnContext, runId: string, phase: string, configuration: Record<string, unknown>, exchange: ModelExchange | NativeExchange): DecisionCase {
  return redact({ id: randomUUID(), runId, actorId: c.character.id, opportunityId: c.opportunity.id, phase, createdAt: new Date().toISOString(), sourceHash: sourceHash(),
    context: { character: c.character, observation: c.observation, worldObservation: c.worldObservation, previousState: c.psychology, cognition: c.cognition, recent: c.recent, inbox: c.inbox, memories: c.memories, stage: c.opportunity.stage, actions: c.opportunity.actions.map(a => ({ name: a.name, description: a.description })) },
    configuration, requestFormat: String(configuration.executionVersion).startsWith("native-responses-") ? "native-responses" : "sdk-model-request", ...exchange });
}
/** Saved model requests contain schemas, never executable tool handlers. */
export function replayRequest(record: DecisionCase): ModelRequest { const { signal: _signal, _internal, ...request } = structuredClone(record.request) as ModelRequest & { _internal?: unknown }; return { ...request, tracing: false }; }
