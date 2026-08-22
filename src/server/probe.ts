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
import type { CapabilityState, ModelCapabilities } from "../society/models";
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

const TIMEOUT = 25_000;

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
    let sawDelta = false;
    for (let guard = 0; guard < 20; guard += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = parseJson(line.slice(5).trim());
        const delta = payload?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) sawDelta = true;
      }
      buffer = buffer.split("\n").at(-1) ?? "";
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
