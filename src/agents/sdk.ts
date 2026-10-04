import { Agent, MemorySession, OpenAIProvider, Runner, type Model, type ModelSettings, type Tool } from "@openai/agents";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "../society/models/registry";

export const nativeAgentVersion = "native-responses-v1";
export const defaultAgentModel = "gpt-6-luna";
export const defaultAgentContext = 256_000;
export interface NativeStream {
  reasoning: string; outputText: string; delivery: "streaming" | "buffered";
  toolCalls?: { callId?: string; name?: string; arguments: string }[];
}
export interface NativeActivity {
  id: string; actorId: string; at: string; attempt: number;
  kind: "agent_start" | "agent_end" | "model_start" | "model_delta" | "model_end" | "model_error" | "tool_start" | "tool_end" | "tool_error" | "tool_rejected";
  callId?: string; tool?: string; input?: unknown; output?: unknown; message?: string; durationMs?: number;
  channel?: "decision" | "shadow"; stream?: NativeStream;
}
export interface NativeExchange {
  attempt: number; request: unknown; providerRequest?: unknown; response?: unknown; sdkOutput?: unknown;
  error?: string; durationMs: number; inputTokens: number; outputTokens: number; finishReason?: string; stream?: NativeStream;
}
export interface NativeTranscript {
  exchanges: NativeExchange[]; activities: NativeActivity[];
  inputTokens: number; outputTokens: number; durationMs: number; toolFailures: number;
}
export interface NativeState { turn: number; currentToolCallId?: string; boundaryError?: Error }
export interface NativeOptions {
  modelProfileId?: string; model?: Model; maxTurns?: number;
  requestTimeoutMs?: number; reasoningEffort?: "low" | "medium"; streamOutput?: boolean;
}
export class NativeAgentError extends Error {
  constructor(message: string, readonly transcript: NativeTranscript) { super(message); this.name = "NativeAgentError"; }
}
export function redactNative<T>(value: T): T {
  const secrets = Object.entries(process.env).filter(([key, item]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && item && item.length > 6).map(([, item]) => item!);
  let json = JSON.stringify(value, (key, item) => /^(authorization|apiKey|api_key|cookie|headers|_internal|signal)$/i.test(key) ? "[redacted]" : item);
  if (json === undefined) return value;
  for (const secret of secrets) json = json.split(secret).join("[redacted]");
  return JSON.parse(json.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]"));
}
export function nativeError(error: unknown) { return redactNative(error instanceof Error ? error.message : String(error)); }
/** Keep a secret prefix out of presentation while its remaining bytes are still arriving. */
export function safeNativeText(text: string, final = false) {
  const secrets = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value && value.length > 6).map(([, value]) => value!);
  for (const secret of secrets) text = text.split(secret).join("[redacted]");
  text = text.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]");
  if (final) return text;
  let pending = text.match(/\bsk-[A-Za-z0-9_-]*$/)?.[0].length ?? 0;
  for (const secret of secrets) for (let length = Math.min(text.length, secret.length - 1); length > pending; length--)
    if (text.endsWith(secret.slice(0, length))) { pending = length; break; }
  return pending ? text.slice(0, -pending) : text;
}
export function nativeConfiguration(registry: ModelRegistry, options: NativeOptions = {}) {
  const id = options.modelProfileId ?? registry.globalDefaults().modelProfileId;
  const profile = id ? registry.modelProfile(id) : registry.listModelProfiles().find(item => item.enabled && item.modelId === defaultAgentModel);
  const provider = profile && registry.providerProfile(profile.providerProfileId);
  if (!options.model && (!profile?.enabled || !provider?.enabled || profile.modelId !== defaultAgentModel ||
    profile.contextWindow !== defaultAgentContext || provider.apiMode !== "responses"))
    throw new Error("请启用 gpt-6-luna、256000 上下文和 Responses 提供商配置");
  const settings: ModelSettings = { toolChoice: "required", parallelToolCalls: false, reasoning: { effort: options.reasoningEffort ?? "low" },
    providerData: { store: false, truncation: "disabled" }, retry: { maxRetries: 0 } };
  return { sdk: "@openai/agents", executionVersion: nativeAgentVersion, modelId: options.model ? "injected-test-model" : defaultAgentModel,
    modelInjected: Boolean(options.model), modelProfileId: profile?.id, providerId: provider?.id, apiMode: "responses", contextWindow: defaultAgentContext,
    modelSettings: settings, maxTurns: options.maxTurns ?? 8, requestTimeoutMs: options.requestTimeoutMs ?? profile?.defaults.requestTimeoutMs ?? 120_000,
    streamOutput: options.streamOutput ?? true, toolTransport: "native-tools", retryLimit: 0, requestTimeoutScope: "headers-and-body",
    sessionPolicy: "fresh actor-isolated SDK session; application owns persistent cognition" };
}

type StreamResponse = { output: { type: string; callId?: string; name?: string; arguments?: string; status?: string }[];
  usage: { inputTokens?: number; outputTokens?: number }; providerData?: { status?: string; incomplete_details?: { reason?: string }; error?: { message?: string } | null }; [key: string]: unknown };
interface ExchangeState { record: NativeExchange; id: string; started: number; ended: boolean; content: NativeStream;
  calls: Map<string, { callId?: string; name?: string; arguments: string }>; lastPublished: number; publishTimer?: ReturnType<typeof setTimeout> }
/**
 * The only live model execution path. SDK owns schemas, requests, tool results and its loop.
 * All supplied tools must stage mutations; callers commit only after this function returns.
 */
export async function runNativeAgent<T extends NativeState>(registry: ModelRegistry, options: NativeOptions, input: {
  name: string; actorId: string; sessionId: string; instructions: Agent<T>["instructions"]; input: string;
  context: T; tools: (reportError: (name: string, error: unknown, args?: unknown) => string) => Tool<T>[];
  done: () => boolean; signal?: AbortSignal; channel?: "decision" | "shadow"; onActivity?: (event: NativeActivity) => void;
}) {
  const configuration = nativeConfiguration(registry, options);
  const started = Date.now(); const states: ExchangeState[] = []; let streamedIndex = -1;
  const transcript: NativeTranscript = { exchanges: [], activities: [], inputTokens: 0, outputTokens: 0, durationMs: 0, toolFailures: 0 };
  const emit = (value: Omit<NativeActivity, "id" | "actorId" | "at" | "attempt">) => {
    const activity = redactNative({ ...value, id: randomUUID(), actorId: input.actorId, at: new Date().toISOString(), attempt: 1, channel: input.channel ?? "decision" });
    if (value.kind !== "model_delta") transcript.activities.push(activity);
    try { input.onActivity?.(activity); } catch { /* presentation cannot mutate or fail an activation */ }
  };
  const stream = (state: ExchangeState, final = false): NativeStream => ({ ...state.content,
    reasoning: safeNativeText(state.content.reasoning, final), outputText: safeNativeText(state.content.outputText, final),
    ...(state.calls.size ? { toolCalls: [...state.calls.values()].map(call => ({ ...call, arguments: safeNativeText(call.arguments, final) })) } : {}) });
  const end = (state: ExchangeState, error?: unknown) => {
    if (state.ended && !error) return;
    clearTimeout(state.publishTimer); state.publishTimer = undefined;
    state.ended = true; state.record.durationMs = Date.now() - state.started; state.record.stream = stream(state, true);
    if (error) state.record.error = nativeError(error);
    emit({ kind: error ? "model_error" : "model_end", callId: state.id, durationMs: state.record.durationMs,
      stream: state.record.stream, ...(error ? { message: nativeError(error) } : {}) });
  };
  const retain = (state: ExchangeState, response: StreamResponse) => {
    if (state.record.response) input.context.boundaryError ??= new Error("同一次 Responses 返回重复终止事件；本次激活未提交");
    state.record.response = redactNative(response); state.record.sdkOutput = redactNative(response.output);
    state.record.inputTokens = response.usage.inputTokens ?? 0; state.record.outputTokens = response.usage.outputTokens ?? 0;
    state.record.finishReason = response.providerData?.status ?? "completed";
    if (["incomplete", "failed", "cancelled"].includes(state.record.finishReason) || response.output.some(item => item.status === "incomplete"))
      input.context.boundaryError ??= new Error(`Responses 返回 ${state.record.finishReason}（${response.providerData?.incomplete_details?.reason ?? response.providerData?.error?.message ?? "输出未完成"}）；本次激活未提交`);
    if (response.output.filter(item => item.type === "function_call").length > 1)
      input.context.boundaryError ??= new Error("同一次 Responses 响应返回多个工具调用；本次激活未提交");
    for (const call of response.output.filter(item => item.type === "function_call")) {
      if (![...state.calls.values()].some(item => item.callId === call.callId)) state.calls.set(call.callId ?? randomUUID(), {
        callId: call.callId, name: call.name, arguments: call.arguments ?? "" });
    }
    end(state, input.context.boundaryError);
  };
  const publish = (state: ExchangeState) => {
    clearTimeout(state.publishTimer); state.publishTimer = undefined;
    if (state.ended) return;
    state.lastPublished = Date.now();
    emit({ kind: "model_delta", callId: state.id, stream: stream(state) });
  };
  const receive = (value: unknown) => {
    const wrapper = value as { type?: string; data?: { type?: string; delta?: string; response?: StreamResponse;
      event?: { type?: string; item_id?: string; output_index?: number; delta?: string; item?: { id?: string; type?: string; call_id?: string; name?: string; arguments?: string } } } };
    if (wrapper.type !== "raw_model_stream_event" || !wrapper.data) return;
    const event = wrapper.data;
    if (event.type === "response_started") { streamedIndex++; return; }
    const state = states[Math.max(0, streamedIndex)]; if (!state) return;
    if (event.type === "response_done" && event.response) { retain(state, event.response); return; }
    let changed = false;
    if (event.type === "output_text_delta" && event.delta) { state.content.outputText += event.delta; changed = true; }
    const raw = event.event;
    if (event.type === "model" && raw) {
      if (raw.type === "response.output_item.added" && raw.item?.type === "function_call") {
        state.calls.set(raw.item.id ?? String(raw.output_index), { callId: raw.item.call_id, name: raw.item.name, arguments: raw.item.arguments ?? "" }); changed = true;
      }
      if (raw.type === "response.function_call_arguments.delta") {
        const key = raw.item_id ?? String(raw.output_index); const call = state.calls.get(key) ?? { arguments: "" };
        call.arguments += raw.delta ?? ""; state.calls.set(key, call); changed = true;
      }
      if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(raw.type ?? "") && raw.delta) {
        state.content.reasoning += raw.delta; changed = true;
      }
      if (["response.failed", "response.incomplete"].includes(raw.type ?? "")) input.context.boundaryError ??= new Error(`Responses 返回 ${raw.type}`);
    }
    if (!changed || state.ended) return;
    const remaining = 80 - (Date.now() - state.lastPublished);
    if (remaining <= 0) publish(state);
    else state.publishTimer ??= setTimeout(() => publish(state), remaining);
  };
  const tools = input.tools((name, error, args) => {
    // The errorFunction callback can receive validation details before tool-start hooks.
    // Read optional metadata without importing non-exported SDK classes or changing execution.
    const validation = error instanceof Error && error.name === "InvalidToolInputError" ? error as Error & {
      originalError?: unknown; toolInvocation?: { input?: string; details?: { toolCall?: { callId?: string } } };
    } : undefined;
    const detail = validation?.originalError;
    const message = [nativeError(error), ...(detail ? [nativeError(detail instanceof Error ? detail : JSON.stringify(detail))] : [])].join(": ").slice(0, 2400);
    emit({ kind: input.context.boundaryError ? "tool_rejected" : "tool_error", tool: name, callId: input.context.currentToolCallId ?? validation?.toolInvocation?.details?.toolCall?.callId,
      input: args ?? validation?.toolInvocation?.input, message });
    return JSON.stringify({ error: message, instruction: input.context.boundaryError ? "模型响应未通过完整性检查，当前激活已终止；不会执行或提交工具" : "根据错误修正参数；当前工具未成功，世界尚未提交" });
  });
  const profile = registry.modelProfile(configuration.modelProfileId ?? "");
  const provider = profile && registry.providerProfile(profile.providerProfileId);
  const apiKey = provider?.apiKeyRef ? process.env[provider.apiKeyRef.replace(/^env:/, "")] : undefined;
  if (!options.model && !apiKey) throw new Error("提供商密钥尚未配置；密钥仅从服务端环境读取");
  const nativeFetch: typeof fetch = async (request, init) => {
    // Passive HTTP audit through the official client's supported fetch option; bytes are unchanged.
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (body) states.at(-1)!.record.providerRequest = redactNative(body);
    // The official client's timeout ends once fetch returns headers. Keep an
    // independent deadline until the complete response body has been consumed.
    const upstreamSignal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      if (upstreamSignal?.aborted) return;
      const error = new Error(`Responses 请求超过 ${configuration.requestTimeoutMs} ms（含完整响应体与流式读取）；本次激活未提交`);
      input.context.boundaryError ??= error;
      deadline.abort(error);
    }, configuration.requestTimeoutMs);
    timer.unref();
    try {
      const response = await fetch(request, { ...init, signal: upstreamSignal ? AbortSignal.any([upstreamSignal, deadline.signal]) : deadline.signal });
      if (!response.body) { clearTimeout(timer); return response; }
      // Identity byte stream only: the SDK still parses Responses and executes tools.
      // pipeTo propagates errors/cancellation and closes the timer at body EOF.
      const transport = new TransformStream();
      void response.body.pipeTo(transport.writable).then(() => clearTimeout(timer), () => clearTimeout(timer));
      return new Response(transport.readable, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { clearTimeout(timer); throw error; }
  };
  const runner = new Runner({ model: options.model ?? defaultAgentModel, tracingDisabled: true, traceIncludeSensitiveData: false,
    ...(options.model ? {} : { modelProvider: new OpenAIProvider({ useResponses: true, openAIClient: new OpenAI({ apiKey, baseURL: provider!.baseURL,
      timeout: configuration.requestTimeoutMs, maxRetries: 0, fetch: nativeFetch }) }) }),
    toolExecution: { maxFunctionToolConcurrency: 1 }, toolNotFoundBehavior: "return_error_to_model", toolNameCollisionPolicy: "error",
    toolErrorFormatter: ({ toolName, callId, defaultMessage }) => {
      emit({ kind: input.context.boundaryError ? "tool_rejected" : "tool_error", tool: toolName, callId, message: defaultMessage });
      return JSON.stringify({ error: defaultMessage, instruction: "请选择当前可用工具" });
    },
    callModelInputFilter: ({ modelData }) => {
      if (input.context.boundaryError) throw input.context.boundaryError;
      input.context.turn++;
      const state: ExchangeState = { id: randomUUID(), started: Date.now(), ended: false, calls: new Map(), lastPublished: 0,
        record: { attempt: 1, request: redactNative(modelData), durationMs: 0, inputTokens: 0, outputTokens: 0 },
        content: { reasoning: "", outputText: "", delivery: configuration.streamOutput ? "streaming" : "buffered" } };
      states.push(state); transcript.exchanges.push(state.record); emit({ kind: "model_start", callId: state.id, stream: state.content });
      return modelData;
    } });
  runner.on("agent_start", () => emit({ kind: "agent_start" }));
  runner.on("agent_end", (_ctx, _agent, output) => emit({ kind: "agent_end", output }));
  runner.on("agent_tool_start", (ctx, _agent, tool, { toolCall }) => {
    if (!("callId" in toolCall)) return;
    input.context.currentToolCallId = toolCall.callId;
    emit({ kind: "tool_start", tool: tool.name, callId: toolCall.callId, input: ctx.toolInput ?? toolCall });
  });
  runner.on("agent_tool_end", (_ctx, _agent, tool, output, { toolCall }) => {
    if (!("callId" in toolCall)) return;
    if (!transcript.activities.some(activity => ["tool_error", "tool_rejected"].includes(activity.kind) && activity.callId === toolCall.callId))
      emit({ kind: "tool_end", tool: tool.name, callId: toolCall.callId, output });
    input.context.currentToolCallId = undefined;
  });
  const agent = new Agent<T>({ name: input.name, instructions: input.instructions, tools, modelSettings: configuration.modelSettings,
    resetToolChoice: false, toolUseBehavior: () => input.done() ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: "结果已暂存" }
      : { isFinalOutput: false, isInterrupted: undefined } });
  const session = new MemorySession({ sessionId: input.sessionId });
  const deadline = AbortSignal.timeout(configuration.requestTimeoutMs * configuration.maxTurns);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const finalize = () => {
    for (const state of states) { clearTimeout(state.publishTimer); state.publishTimer = undefined; }
    transcript.durationMs = Date.now() - started;
    transcript.inputTokens = transcript.exchanges.reduce((sum, item) => sum + item.inputTokens, 0);
    transcript.outputTokens = transcript.exchanges.reduce((sum, item) => sum + item.outputTokens, 0);
    transcript.toolFailures = transcript.activities.filter(item => item.kind === "tool_error").length;
  };
  try {
    if (configuration.streamOutput) {
      const streamed = await runner.run(agent, input.input, { context: input.context, session, maxTurns: configuration.maxTurns, signal, stream: true });
      const completion = streamed.completed.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      let streamError: unknown;
      try { for await (const event of streamed) receive(event); } catch (error) { streamError = error; }
      const result = await completion;
      if (!result.ok) throw result.error;
      if (streamError) throw streamError;
    } else {
      const result = await runner.run(agent, input.input, { context: input.context, session, maxTurns: configuration.maxTurns, signal });
      result.rawResponses.forEach((response, index) => retain(states[index], response as unknown as StreamResponse));
    }
    signal.throwIfAborted();
    if (input.context.boundaryError) throw input.context.boundaryError;
    if (!input.done()) throw new Error("Agent 没有提交完整的本次结果");
    if (states.some(state => !state.record.response)) throw new Error("模型缺少完整的终止响应");
    finalize();
    return { transcript: redactNative(transcript), sessionItems: redactNative(await session.getItems()), configuration };
  } catch (error) {
    const failure = input.context.boundaryError ?? error;
    if (states.length) end(states.at(-1)!, failure);
    finalize(); throw new NativeAgentError(nativeError(failure), redactNative(transcript));
  }
}
