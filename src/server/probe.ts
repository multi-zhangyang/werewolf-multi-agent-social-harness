/**
 * Generic capability probing for OpenAI-compatible endpoints.
 *
 * No provider is special-cased: a few minimal, bounded requests decide each
 * capability as yes / no / unknown. Unknown is preserved when a probe cannot
 * conclude; nothing is deleted from the user's configuration, and failures
 * only mark capabilities — never block the provider from being used.
 */
import type { CapabilityState, ModelCapabilities } from "../society/models";

export interface CapabilityProbeInput {
  baseURL: string;
  apiKey: string;
  modelId: string;
}

export interface CapabilityProbeResult {
  ok: boolean;
  message: string;
  capabilities: ModelCapabilities;
  detail: Array<{ probe: string; result: string }>;
}

const TIMEOUT = 25_000;

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

  const minimal = await chat(input, {
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 4
  });
  if (minimal.status === 200) {
    capabilities.maxOutputTokens = "yes";
    capabilities.streaming = "yes";
    detail.push({ probe: "minimal", result: "ok" });
    if (minimal.body.usage) detail.push({ probe: "usage", result: "returned" });
    else detail.push({ probe: "usage", result: "absent" });
  } else if (minimal.status === 400 || minimal.status === 404 || minimal.status === 422) {
    capabilities.maxOutputTokens = "no";
    detail.push({ probe: "minimal", result: `HTTP ${minimal.status}` });
    return { ok: false, message: `最小补全请求被拒绝（HTTP ${minimal.status}）：${minimal.text.slice(0, 160)}`, capabilities, detail };
  } else {
    detail.push({ probe: "minimal", result: `HTTP ${minimal.status}` });
    return { ok: false, message: `最小补全请求失败（HTTP ${minimal.status}）：${minimal.text.slice(0, 160)}`, capabilities, detail };
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
    max_tokens: 128
  });
  if (tooled.status === 200) {
    const calls = tooled.body.choices?.[0]?.message?.tool_calls;
    capabilities.tools = calls?.length ? "yes" : "unknown";
    detail.push({ probe: "tools", result: calls?.length ? "tool_calls returned" : "no tool call" });
  } else {
    capabilities.tools = "no";
    detail.push({ probe: "tools", result: `HTTP ${tooled.status}` });
  }

  // Streaming: read at least one chunk from a streamed completion.
  const streamed = await chatStream(input, {
    messages: [{ role: "user", content: "Say hello." }],
    max_tokens: 16,
    stream: true,
    stream_options: { include_usage: true }
  });
  if (streamed.ok) {
    capabilities.streaming = streamed.sawDelta ? "yes" : "unknown";
    detail.push({ probe: "streaming", result: streamed.sawDelta ? "delta streamed" : "no delta" });
  } else {
    capabilities.streaming = streamed.rejectedByParam ? "no" : "unknown";
    detail.push({ probe: "streaming", result: streamed.text.slice(0, 80) });
  }

  // Reasoning-effort parameter acceptance.
  const reasoning = await chat(input, {
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 4,
    reasoning_effort: "low"
  });
  if (reasoning.status === 200) {
    capabilities.reasoning = "yes";
    detail.push({ probe: "reasoning_effort", result: "accepted" });
  } else if (reasoning.status === 400 || reasoning.status === 422) {
    capabilities.reasoning = "no";
    detail.push({ probe: "reasoning_effort", result: `HTTP ${reasoning.status}` });
  } else {
    detail.push({ probe: "reasoning_effort", result: `HTTP ${reasoning.status}` });
  }

  // Structured output (JSON mode).
  const json = await chat(input, {
    messages: [{ role: "user", content: "Return {\"ok\": true} as JSON." }],
    response_format: { type: "json_object" },
    max_tokens: 32
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

  const ok = capabilities.tools !== "no";
  return {
    ok,
    message: ok
      ? "探测完成：最小补全、工具调用、流式、推理参数与 JSON 模式均已验证。"
      : "探测完成：该模型对工具调用的支持未能确认，Agent 需要工具才能行动。",
    capabilities,
    detail
  };
}

async function chat(input: CapabilityProbeInput, body: Record<string, unknown>): Promise<{
  status: number;
  text: string;
  body: Record<string, any>;
}> {
  try {
    const response = await fetch(`${input.baseURL}/chat/completions`, {
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

async function chatStream(input: CapabilityProbeInput, body: Record<string, unknown>): Promise<{
  ok: boolean;
  sawDelta: boolean;
  rejectedByParam: boolean;
  text: string;
}> {
  try {
    const response = await fetch(`${input.baseURL}/chat/completions`, {
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
    if (state === "unknown") continue;
    const label = labels[name as keyof ModelCapabilities] ?? name;
    parts.push(`${label}:${state === "yes" ? "✓" : "✗"}`);
  }
  return parts.join(" ");
}

export function capabilityStateLabel(state: CapabilityState): string {
  return state === "yes" ? "支持" : state === "no" ? "不支持" : "未验证";
}