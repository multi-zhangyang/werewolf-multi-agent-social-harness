import { Agent, OpenAIProvider, Runner, tool } from '@openai/agents';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaultCapabilities } from '../society/models/defaults';
import type { ModelCapabilities, ModelProtocolCheck } from '../society/models/contracts';

export type ProbeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export interface CapabilityProbeResult {
  ok: boolean; message: string; capabilities: ModelCapabilities; detail: Array<{ probe: string; result: string }>;
  requestedReasoningEffort: string; effectiveReasoningEffort: string; reasoningFallbacks: never[];
}
export interface ProtocolProbeResult { ok: boolean; message: string; check: ModelProtocolCheck; detail: Array<{ step: string; result: string }>; }
export interface RemoteModelsResult { ok: boolean; message: string; modelIds: string[]; }
export async function fetchRemoteModels(input: { baseURL: string; apiKey: string }): Promise<RemoteModelsResult> {
  const client = new OpenAI({ apiKey: input.apiKey, baseURL: input.baseURL, timeout: 20000, maxRetries: 1 });
  const result = await client.models.list();
  return { ok: true, message: '已获取模型列表', modelIds: result.data.map(m => m.id).sort() };
}
export async function probeAgentProtocol(input: { apiKey: string; baseURL: string; apiMode: string; modelId: string; fingerprint: string; reasoningEffort?: ProbeReasoningEffort; timeoutMs?: number }): Promise<ProtocolProbeResult> {
  const started = Date.now(); const receipt = randomUUID(); let called = false;
  const provider = new OpenAIProvider({ useResponses: input.apiMode === 'responses', openAIClient: new OpenAI({ apiKey: input.apiKey, baseURL: input.baseURL, timeout: input.timeoutMs || 120000, maxRetries: 1 }) });
  const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
  const agent = new Agent({ name: 'Connection check', model: input.modelId, instructions: 'Call ping, then repeat its result exactly.', tools: [tool({ name: 'ping', description: 'Get the connection receipt.', parameters: z.object({}).strict(), execute: async () => { called = true; return receipt; } })], modelSettings: { ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}) } });
  try {
    const result = await runner.run(agent, 'Check the connection.', { maxTurns: 3 });
    const ok = called && Boolean(result.finalOutput?.includes(receipt));
    const message = ok ? '连接与工具调用正常' : '模型未完成工具调用检查';
    return { ok, message, check: { status: ok ? 'passed' : 'failed', fingerprint: input.fingerprint, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, message }, detail: [{ step: 'tools', result: called ? 'called' : 'missing' }] };
  } catch (error) {
    const message = safeError(error);
    return { ok: false, message, check: { status: 'failed', fingerprint: input.fingerprint, checkedAt: new Date().toISOString(), message, errorCode: 'CONNECTION_FAILED' }, detail: [] };
  }
}
export function probeCapabilityResult(protocol: ProtocolProbeResult, effort?: ProbeReasoningEffort): CapabilityProbeResult {
  return { ok: protocol.ok, message: protocol.message, capabilities: { ...defaultCapabilities(), tools: protocol.ok ? 'yes' : 'unknown', reasoning: protocol.ok && effort ? 'yes' : 'unknown' }, requestedReasoningEffort: effort ?? 'provider-default', effectiveReasoningEffort: effort ?? 'provider-default', reasoningFallbacks: [], detail: [] };
}
function safeError(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 400); }
