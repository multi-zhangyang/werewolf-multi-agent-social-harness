/**
 * Generic capability probing for OpenAI-compatible endpoints.
 *
 * No provider is special-cased: a few minimal, bounded requests decide each
 * capability as yes / no / unknown. Unknown is preserved when a probe cannot
 * conclude; nothing is deleted from the user's configuration, and failures
 * only mark capabilities — never block the provider from being used.
 *
 * Generation caps are never transmitted by this product (models must not
 * receive `max_tokens`), so the probes below never send it and the
 * `maxOutputTokens` capability stays "unknown" — nothing depends on it.
 */
import { Agent, type RunItem } from "@openai/agents";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CapabilityState, ModelCapabilities, ModelProtocolCheck } from "../society/models";
import { createSocietyProvider, createSocietyRunner } from "../society/agent-runner";
import { societyTool } from "../society/tools";
import {
  reasoningFallbackFetch,
  type EffectiveReasoningEffort,
  type ReasoningFallbackNotice
} from "../society/models/reasoning-fallback";

export type ProbeReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ProbeEffectiveReasoningEffort = ProbeReasoningEffort | "provider-default";

export interface CapabilityProbeInput {
  baseURL: string;
  apiKey: string;
  modelId: string;
  reasoningEffort?: ProbeReasoningEffort;
}

export interface CapabilityProbeResult {
  ok: boolean;
  message: string;
  capabilities: ModelCapabilities;
  detail: Array<{ probe: string; result: string }>;
  requestedReasoningEffort: ProbeEffectiveReasoningEffort;
  effectiveReasoningEffort: ProbeEffectiveReasoningEffort;
  reasoningFallbacks: Array<{
    from: "xhigh" | "high";
    to: "high" | "provider-default";
    status: number;
    reason: string;
  }>;
}

export interface ProtocolProbeInput extends CapabilityProbeInput {
  apiMode: "responses" | "chat-completions" | "auto";
  fingerprint: string;
  timeoutMs?: number;
}

export interface ProtocolProbeResult {
  ok: boolean;
  message: string;
  check: ModelProtocolCheck;
  detail: Array<{ step: string; result: string }>;
}

export type ProtocolTranscriptEvent =
  | { type: "tool-call"; toolName: string; callId?: string; arguments: string }
  | { type: "tool-result"; callId?: string }
  | { type: "final"; text: string };

export type ProtocolTranscriptAssessment =
  | { ok: true }
  | { ok: false; errorCode: string; message: string };

const TIMEOUT = 25_000;
const PROTOCOL_TOOL = "confirm_protocol_receipt";

export interface RemoteModelsResult {
  ok: boolean;
  message: string;
  modelIds: string[];
}

/** List the models a provider exposes on GET {baseURL}/models (OpenAI-compatible). */
export async function fetchRemoteModels(input: { baseURL: string; apiKey: string }): Promise<RemoteModelsResult> {
  try {
    const response = await fetch(`${input.baseURL}/models`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(15_000)
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        modelIds: [],
        message: `获取模型列表失败（HTTP ${response.status}）：${sanitizeProviderError(text)}。请确认 Base URL 以 /v1 结尾（如 https://api.example.com/v1）且密钥有效。`
      };
    }
    const body = parseJson(text);
    const rows: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    const modelIds = rows
      .map((row) => (row && typeof row === "object" ? (row as { id?: unknown }).id : row))
      .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 180)
      .sort((a, b) => a.localeCompare(b));
    if (!modelIds.length) {
      return { ok: false, modelIds: [], message: "提供商返回了空模型列表。请确认 Base URL 以 /v1 结尾。" };
    }
    return { ok: true, message: `已获取 ${modelIds.length} 个模型。`, modelIds };
  } catch (cause) {
    return {
      ok: false,
      modelIds: [],
      message: `无法连接提供商（${cause instanceof Error ? cause.message : String(cause)}）。请确认 Base URL 以 /v1 结尾且网络可达。`
    };
  }
}

export async function probeCapabilities(input: CapabilityProbeInput): Promise<CapabilityProbeResult> {
  const capabilities: ModelCapabilities = {
    streaming: "unknown",
    tools: "unknown",
    parallelToolCalls: "unknown",
    reasoning: "unknown",
    reasoningSummary: "unknown",
    structuredOutput: "unknown",
    promptCaching: "unknown",
    nativeCompaction: "unknown",
    seed: "unknown",
    stopSequences: "unknown",
    imageInput: "unknown",
    maxOutputTokens: "unknown"
  };
  const detail: CapabilityProbeResult["detail"] = [];
  const failures: string[] = [];
  const requestedReasoningEffort = input.reasoningEffort ?? "provider-default";
  const fallbackNotices: ReasoningFallbackNotice[] = [];
  const negotiatedFetch = reasoningFallbackFetch({
    useCapabilityCache: false,
    onNotice: (notice) => fallbackNotices.push(notice)
  });
  const requestedTuning = reasoningTuning(requestedReasoningEffort);

  const minimal = await chat(input, {
    messages: [{ role: "user", content: "ping" }],
    ...requestedTuning
  }, negotiatedFetch);
  const effectiveReasoningEffort = resolveEffectiveReasoningEffort(
    requestedReasoningEffort,
    fallbackNotices
  );
  const effectiveTuning = reasoningTuning(effectiveReasoningEffort);
  const reasoningFallbacks = fallbackNotices.map((notice) => ({
    from: notice.requestedEffort,
    to: notice.effectiveEffort,
    status: notice.status,
    reason: notice.message
  }));
  detail.push({
    probe: "reasoning_effort",
    result: requestedReasoningEffort === effectiveReasoningEffort
      ? `accepted: ${effectiveReasoningEffort}`
      : `requested ${requestedReasoningEffort}, using ${effectiveReasoningEffort}`
  });
  if (minimal.status === 200) {
    capabilities.reasoning = requestedReasoningEffort === "provider-default"
      ? "unknown"
      : effectiveReasoningEffort === "provider-default"
        ? "no"
        : "yes";
    detail.push({ probe: "minimal", result: "ok" });
    if (minimal.body.usage) detail.push({ probe: "usage", result: "returned" });
    else detail.push({ probe: "usage", result: "absent" });
  } else if (minimal.status === 400 || minimal.status === 404 || minimal.status === 422) {
    detail.push({ probe: "minimal", result: `HTTP ${minimal.status}` });
    return {
      ok: false,
      message: `最小补全请求被拒绝（HTTP ${minimal.status}）：${sanitizeProviderError(minimal.text)}`,
      capabilities,
      detail,
      requestedReasoningEffort,
      effectiveReasoningEffort,
      reasoningFallbacks
    };
  } else {
    detail.push({ probe: "minimal", result: `HTTP ${minimal.status}` });
    return {
      ok: false,
      message: `最小补全请求失败（HTTP ${minimal.status}）：${sanitizeProviderError(minimal.text)}`,
      capabilities,
      detail,
      requestedReasoningEffort,
      effectiveReasoningEffort,
      reasoningFallbacks
    };
  }

  // Tools: the agent runtime's core capability.
  const tooled = await chat(input, {
    messages: [{ role: "user", content: "Call the probe_ping tool with ok=true. Reply with only the tool call." }],
    tools: [{
      type: "function",
      function: {
        name: "probe_ping",
        description: "A minimal probe tool.",
        parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
      }
    }],
    tool_choice: "required",
    ...effectiveTuning
  });
  if (tooled.status === 200) {
    const calls = tooled.body.choices?.[0]?.message?.tool_calls;
    capabilities.tools = calls?.length ? "yes" : "unknown";
    detail.push({ probe: "tools", result: calls?.length ? "tool_calls returned" : "no tool call" });
    if (!calls?.length) failures.push("工具请求成功，但响应中没有 tool_calls");
  } else {
    capabilities.tools = "no";
    detail.push({ probe: "tools", result: `HTTP ${tooled.status}` });
    failures.push(`工具调用 HTTP ${tooled.status}：${sanitizeProviderError(tooled.text)}`);
  }

  // Streaming: read at least one chunk from a streamed completion.
  const streamed = await chatStream(input, {
    messages: [{ role: "user", content: "Say hello." }],
    stream: true,
    stream_options: { include_usage: true },
    ...effectiveTuning
  });
  if (streamed.ok) {
    capabilities.streaming = streamed.sawDelta ? "yes" : "unknown";
    detail.push({ probe: "streaming", result: streamed.sawDelta ? "delta streamed" : "no delta" });
    if (!streamed.sawDelta) failures.push("流式请求成功，但没有收到文字 delta");
  } else {
    capabilities.streaming = streamed.rejectedByParam ? "no" : "unknown";
    detail.push({ probe: "streaming", result: streamed.text.slice(0, 80) });
    failures.push(`流式输出失败：${sanitizeProviderError(streamed.text)}`);
  }

  // Structured output (JSON mode).
  const json = await chat(input, {
    messages: [{ role: "user", content: "Return {\"ok\": true} as JSON." }],
    response_format: { type: "json_object" },
    ...effectiveTuning
  });
  if (json.status === 200) {
    capabilities.structuredOutput = "yes";
    detail.push({ probe: "json_mode", result: "accepted" });
  } else if (json.status === 400 || json.status === 422) {
    capabilities.structuredOutput = "no";
    detail.push({ probe: "json_mode", result: `HTTP ${json.status}` });
  } else {
    detail.push({ probe: "json_mode", result: `HTTP ${json.status}` });
  }

  const ok = capabilities.tools === "yes" && capabilities.streaming === "yes";
  return {
    ok,
    message: ok
      ? `测试通过：补全、工具与流式请求已完成。思考强度请求 ${requestedReasoningEffort}，实际使用 ${effectiveReasoningEffort}。`
      : `测试失败：${failures.join("；") || "模型没有完成必要的工具与流式响应"}。思考强度请求 ${requestedReasoningEffort}，实际使用 ${effectiveReasoningEffort}。`,
    capabilities,
    detail,
    requestedReasoningEffort,
    effectiveReasoningEffort,
    reasoningFallbacks
  };
}

/**
 * Real Agents SDK handshake: the first actionable output must be one valid
 * tool call, its result contains an unpredictable receipt, and only a later
 * assistant message may repeat that receipt. No provider/model exceptions.
 */
export async function probeAgentProtocol(input: ProtocolProbeInput): Promise<ProtocolProbeResult> {
  const startedAt = Date.now();
  const challenge = `challenge_${randomUUID()}`;
  const receipt = `receipt_${randomUUID()}`;
  const detail: ProtocolProbeResult["detail"] = [];
  let executed = 0;
  let executedChallenge: string | undefined;
  const receiptTool = societyTool({
    name: PROTOCOL_TOOL,
    description: "Validate the supplied one-time challenge and return a one-time receipt that must be quoted in the final response.",
    parameters: z.object({ challenge: z.string().min(1) }),
    execute: async ({ challenge: supplied }) => {
      executed += 1;
      executedChallenge = supplied;
      if (supplied !== challenge) throw new Error("PROTOCOL_CHALLENGE_MISMATCH: The challenge was not copied exactly.");
      return JSON.stringify({ ok: true, receipt });
    }
  });
  const timeoutMs = positiveTimeout(input.timeoutMs ?? Number(process.env.SOCIETY_MODEL_PROTOCOL_TIMEOUT_MS), 120_000);
  const fallbackNotices: ReasoningFallbackNotice[] = [];
  const provider = createSocietyProvider({
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    useResponses: input.apiMode === "responses",
    timeoutMs,
    maxRetries: 0,
    fetch: reasoningFallbackFetch({ useCapabilityCache: false, onNotice: (notice) => fallbackNotices.push(notice) })
  });
  const runner = createSocietyRunner(provider);
  const modelSettings: Record<string, unknown> = {
    parallelToolCalls: false
  };
  if (input.reasoningEffort) modelSettings.reasoning = { effort: input.reasoningEffort };
  const agent = new Agent({
    name: "Society protocol verifier",
    model: input.modelId,
    instructions: [
      "This is a strict protocol verification, not a conversation.",
      `Your first actionable output must be exactly one ${PROTOCOL_TOOL} call with challenge copied exactly from the user message.`,
      "Do not emit any assistant text before the tool result. Do not call the tool more than once.",
      "After the tool result, emit exactly one final response containing PROTOCOL_OK:<receipt>, using the receipt returned by the tool."
    ].join(" "),
    tools: [receiptTool],
    toolUseBehavior: "run_llm_again",
    resetToolChoice: true,
    modelSettings
  });

  try {
    const result = await runner.run(agent, `challenge=${challenge}`, {
      // Some OpenAI-compatible providers expose the tool-call, tool-result
      // acknowledgement and final response as separate SDK model turns. Five
      // is still a strict finite budget; transcript validation below rejects
      // every repeated tool call instead of admitting it as a workaround.
      maxTurns: 5,
      stream: true,
      signal: AbortSignal.timeout(timeoutMs)
    });
    // Exercise the same streamed Agents SDK lifecycle as a live participant;
    // draining the stream before reading newItems/finalOutput is required for
    // providers that only finalize assistant content in later SSE chunks.
    for await (const _event of result) {
      // The transcript is validated from durable SDK run items below.
    }
    await result.completed;
    const calls = result.newItems.filter((item) => item.type === "tool_call_item");
    const outputs = result.newItems.filter((item) => item.type === "tool_call_output_item");
    detail.push({ step: "tool-call", result: `${calls.length} call(s)` });
    detail.push({ step: "tool-result", result: `${outputs.length} result(s)` });

    const assessment = validateProtocolTranscript(
      protocolTranscript(result.newItems),
      { toolName: PROTOCOL_TOOL, challenge, receipt }
    );
    if (!assessment.ok) {
      return protocolFailure(input, startedAt, assessment.errorCode, assessment.message, detail);
    }

    if (calls.length !== 1 || executed !== 1) {
      return protocolFailure(input, startedAt, "PROTOCOL_TOOL_REPEATED", `指定工具调用了 ${calls.length} 次、执行了 ${executed} 次。`, detail);
    }
    const call = calls[0]!;
    const rawCall = call.rawItem as { type?: string; name?: string; arguments?: string; callId?: string };
    if (rawCall.type !== "function_call" || rawCall.name !== PROTOCOL_TOOL) {
      return protocolFailure(input, startedAt, "PROTOCOL_UNKNOWN_TOOL", `模型调用了未知工具 ${rawCall.name ?? "unknown"}。`, detail);
    }
    const parsedArguments = parseJson(rawCall.arguments ?? "");
    if (parsedArguments.challenge !== challenge || executedChallenge !== challenge) {
      return protocolFailure(input, startedAt, "PROTOCOL_ARGUMENTS_INVALID", "模型没有准确传入一次性 challenge。", detail);
    }

    const callIndex = result.newItems.indexOf(call);
    const outputIndex = result.newItems.findIndex((item) => item.type === "tool_call_output_item");
    const firstPrematureMessage = result.newItems.findIndex((item, index) =>
      index < outputIndex && item.type === "message_output_item" && messageText(item).trim().length > 0
    );
    if (firstPrematureMessage >= 0 || callIndex < 0 || outputIndex <= callIndex) {
      return protocolFailure(input, startedAt, "PROTOCOL_PREMATURE_FINAL", "模型在工具结果前输出了发言，或事件顺序不完整。", detail);
    }
    const finalMessageIndex = findLastMessageIndex(result.newItems);
    if (finalMessageIndex <= outputIndex) {
      return protocolFailure(input, startedAt, "PROTOCOL_FINAL_MISSING", "工具结果之后没有最终发言。", detail);
    }
    const finalOutput = typeof result.finalOutput === "string" ? result.finalOutput : String(result.finalOutput ?? "");
    detail.push({ step: "final", result: finalOutput.includes(receipt) ? "receipt matched" : "receipt mismatch" });
    if (!finalOutput.includes(receipt)) {
      return protocolFailure(input, startedAt, "PROTOCOL_RECEIPT_MISMATCH", "最终发言没有准确复述工具返回的 receipt。", detail);
    }
    const latencyMs = Date.now() - startedAt;
    const check: ModelProtocolCheck = {
      status: "passed",
      fingerprint: input.fingerprint,
      checkedAt: new Date().toISOString(),
      latencyMs,
      message: "Agents SDK 工具调用、工具结果和最终发言顺序正确。"
    };
    if (fallbackNotices.length) detail.push({ step: "reasoning", result: `fallbacks: ${fallbackNotices.length}` });
    return { ok: true, message: check.message!, check, detail };
  } catch (cause) {
    const code = protocolErrorCode(cause);
    return protocolFailure(input, startedAt, code, sanitizeProviderError(cause instanceof Error ? cause.message : String(cause)), detail);
  }
}

/** Deterministic validation used by the live SDK probe and its contract tests. */
export function validateProtocolTranscript(
  events: ProtocolTranscriptEvent[],
  expected: { toolName: string; challenge: string; receipt: string }
): ProtocolTranscriptAssessment {
  const calls = events.filter((event): event is Extract<ProtocolTranscriptEvent, { type: "tool-call" }> => event.type === "tool-call");
  if (!calls.length) return { ok: false, errorCode: "PROTOCOL_TOOL_MISSING", message: "模型没有先调用指定工具。" };
  if (calls.length !== 1) return { ok: false, errorCode: "PROTOCOL_TOOL_REPEATED", message: `指定工具调用了 ${calls.length} 次。` };
  const call = calls[0]!;
  if (call.toolName !== expected.toolName) {
    return { ok: false, errorCode: "PROTOCOL_UNKNOWN_TOOL", message: `模型调用了未知工具 ${call.toolName || "unknown"}。` };
  }
  if (parseJson(call.arguments).challenge !== expected.challenge) {
    return { ok: false, errorCode: "PROTOCOL_ARGUMENTS_INVALID", message: "模型没有准确传入一次性 challenge。" };
  }
  const callIndex = events.indexOf(call);
  const resultIndex = events.findIndex((event) => event.type === "tool-result" && (!event.callId || !call.callId || event.callId === call.callId));
  const premature = events.findIndex((event, index) => event.type === "final" && event.text.trim().length > 0 && index < resultIndex);
  if (premature >= 0 || resultIndex <= callIndex) {
    return { ok: false, errorCode: "PROTOCOL_PREMATURE_FINAL", message: "模型在工具结果前输出了发言，或事件顺序不完整。" };
  }
  const finals = events.filter((event): event is Extract<ProtocolTranscriptEvent, { type: "final" }> => event.type === "final");
  const final = finals.at(-1);
  const finalIndex = final ? events.lastIndexOf(final) : -1;
  if (!final || finalIndex <= resultIndex) {
    return { ok: false, errorCode: "PROTOCOL_FINAL_MISSING", message: "工具结果之后没有最终发言。" };
  }
  if (!final.text.includes(expected.receipt)) {
    return { ok: false, errorCode: "PROTOCOL_RECEIPT_MISMATCH", message: "最终发言没有准确复述工具返回的 receipt。" };
  }
  return { ok: true };
}

function protocolTranscript(items: RunItem[]): ProtocolTranscriptEvent[] {
  const events: ProtocolTranscriptEvent[] = [];
  for (const item of items) {
    if (item.type === "tool_call_item" && item.rawItem.type === "function_call") {
      events.push({
        type: "tool-call",
        toolName: item.rawItem.name,
        callId: item.rawItem.callId,
        arguments: item.rawItem.arguments
      });
    } else if (item.type === "tool_call_output_item" && item.rawItem.type === "function_call_result") {
      events.push({ type: "tool-result", callId: item.rawItem.callId });
    } else if (item.type === "message_output_item") {
      const text = messageText(item);
      if (text.trim()) events.push({ type: "final", text });
    }
  }
  return events;
}

function protocolFailure(
  input: ProtocolProbeInput,
  startedAt: number,
  errorCode: string,
  message: string,
  detail: ProtocolProbeResult["detail"]
): ProtocolProbeResult {
  const check: ModelProtocolCheck = {
    status: "failed",
    fingerprint: input.fingerprint,
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    errorCode,
    message
  };
  return { ok: false, message, check, detail };
}

function protocolErrorCode(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/abort|timeout/i.test(message)) return "PROTOCOL_TIMEOUT";
  if (/tool.*not found|unknown tool|tool_not_found/i.test(message)) return "PROTOCOL_UNKNOWN_TOOL";
  if (/challenge_mismatch|invalid.*tool|schema|arguments/i.test(message)) return "PROTOCOL_ARGUMENTS_INVALID";
  return "PROTOCOL_PROVIDER_ERROR";
}

function findLastMessageIndex(items: RunItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === "message_output_item" && messageText(items[index]!).trim()) return index;
  }
  return -1;
}

function messageText(item: RunItem): string {
  if (item.type !== "message_output_item") return "";
  return item.rawItem.content.map((part) => part.type === "output_text" ? part.text : "").join("");
}

function positiveTimeout(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1_000 ? Math.min(Math.floor(value), 900_000) : fallback;
}

async function chat(
  input: CapabilityProbeInput,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<{
  status: number;
  text: string;
  body: Record<string, any>;
}> {
  try {
    const response = await fetchImpl(`${input.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify({ model: input.modelId, ...body }),
      signal: AbortSignal.timeout(TIMEOUT)
    });
    const text = await response.text();
    return {
      status: response.status,
      text: text.slice(0, 400),
      body: parseJson(text)
    };
  } catch (cause) {
    return { status: 0, text: cause instanceof Error ? cause.message : String(cause), body: {} };
  }
}

async function chatStream(
  input: CapabilityProbeInput,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<{
  ok: boolean;
  sawDelta: boolean;
  rejectedByParam: boolean;
  text: string;
}> {
  try {
    const response = await fetchImpl(`${input.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify({ model: input.modelId, ...body }),
      signal: AbortSignal.timeout(TIMEOUT)
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        sawDelta: false,
        rejectedByParam: [400, 404, 422].includes(response.status),
        text: `HTTP ${response.status}: ${text.slice(0, 120)}`
      };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let receivedBytes = 0;
    let sawDelta = false;
    // Reasoning models may emit many reasoning-only SSE chunks before their
    // first visible text delta. Bound the probe by time and bytes, not by an
    // arbitrary chunk count, otherwise normal fragmented streams become a
    // false capability failure.
    while (receivedBytes < 1_000_000) {
      const { value, done } = await reader.read();
      if (done) break;
      receivedBytes += value?.byteLength ?? 0;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = parseJson(line.slice(5).trim());
        const delta = payload?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) sawDelta = true;
      }
      if (sawDelta) break;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    return { ok: true, sawDelta, rejectedByParam: false, text: "" };
  } catch (cause) {
    return { ok: false, sawDelta: false, rejectedByParam: false, text: cause instanceof Error ? cause.message : String(cause) };
  }
}

function parseJson(text: string): any {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function mergeProbeResult(current: ModelCapabilities, probed: ModelCapabilities): ModelCapabilities {
  const merged = { ...current };
  for (const key of Object.keys(probed) as Array<keyof ModelCapabilities>) {
    const state = probed[key];
    // A probe that concluded (yes/no) updates the stored state; a probe that
    // stayed unknown leaves the user's earlier assertion untouched.
    if (state !== "unknown") merged[key] = state;
  }
  return merged;
}

export function capabilitySummary(capabilities: ModelCapabilities): string {
  const labels: Record<keyof ModelCapabilities, string> = {
    streaming: "流式",
    tools: "工具",
    parallelToolCalls: "并行工具",
    reasoning: "推理参数",
    reasoningSummary: "推理摘要",
    structuredOutput: "JSON模式",
    promptCaching: "缓存",
    nativeCompaction: "原生压缩",
    seed: "seed",
    stopSequences: "stop",
    imageInput: "图像",
    maxOutputTokens: "最大输出"
  };
  const parts: string[] = [];
  for (const [name, state] of Object.entries(capabilities)) {
    if (state === "unknown" || name === "maxOutputTokens") continue; // generation caps are never transmitted
    const label = labels[name as keyof ModelCapabilities] ?? name;
    parts.push(`${label}:${state === "yes" ? "✓" : "✗"}`);
  }
  return parts.join(" ");
}

export function capabilityStateLabel(state: CapabilityState): string {
  return state === "yes" ? "支持" : state === "no" ? "不支持" : "未验证";
}

function reasoningTuning(effort: ProbeEffectiveReasoningEffort): Record<string, unknown> {
  return effort === "provider-default" ? {} : { reasoning_effort: effort };
}

function resolveEffectiveReasoningEffort(
  requested: ProbeEffectiveReasoningEffort,
  notices: ReasoningFallbackNotice[]
): ProbeEffectiveReasoningEffort {
  const fallback = notices.at(-1)?.effectiveEffort as EffectiveReasoningEffort | undefined;
  return fallback ?? requested;
}

function sanitizeProviderError(message: string): string {
  const cleaned = message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"']+/g, "[endpoint]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return cleaned || "提供商没有返回可读的错误信息。";
}
