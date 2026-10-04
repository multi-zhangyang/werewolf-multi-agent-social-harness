import OpenAI from "openai";
import type { Response as NativeResponse, ResponseCreateParams } from "openai/resources/responses/responses";
import { OpenAIProvider, withTrace, NoopTrace } from "@openai/agents";
import { randomUUID } from "node:crypto";
import { redact, replayRequest, sourceHash, type DecisionCase } from "./cases";
import type { ModelRegistry } from "../society/models/registry";
import { inspectModelResponse } from "./model";
import { z } from "zod";
import { nativeError } from "../agents/sdk";

export const replayOverridesSchema = z.object({
  effort: z.enum(["low", "medium"]).optional(),
  requestTimeoutMs: z.number().int().min(1000).max(360000).optional(),
  forceSingleTool: z.boolean().optional(),
}).strict();

function replayDeadline(timeout: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`模型复测请求超过 ${timeout} ms（含完整响应体与流式读取）`)), timeout);
  timer.unref();
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

/** Calls the model directly. There is deliberately no Runner or tool executor here. */
export async function replayDecisionCase(record: DecisionCase, registry: ModelRegistry, input: unknown = {}): Promise<DecisionCase> {
  const overrides = replayOverridesSchema.parse(input);
  const profile = registry.modelProfile(String(record.configuration.modelProfileId ?? record.configuration.profileId));
  const provider = profile && registry.providerProfile(profile.providerProfileId);
  if (!profile?.enabled || !provider?.enabled) throw new Error("该案例的模型配置已不可用");
  const key = process.env[provider.apiKeyRef?.replace(/^env:/, "") ?? ""];
  if (!key) throw new Error("提供商密钥未配置");
  const cognition = record.configuration.cognition as { requestTimeoutMs?: number } | undefined;
  const timeout = overrides.requestTimeoutMs ?? Number(record.configuration.requestTimeoutMs ?? cognition?.requestTimeoutMs ?? 120000);
  const client = new OpenAI({ apiKey: key, baseURL: provider.baseURL, maxRetries: 0, timeout });
  if (record.requestFormat === "native-responses" || record.providerRequest || String(record.configuration.executionVersion).startsWith("native-responses-")) {
    if (!record.providerRequest) throw new Error("案例缺少原生 providerRequest，不能用不完整的 SDK 输入代替回放");
    if (provider.apiMode !== "responses") throw new Error("原生 Responses 案例需要 Responses 提供商配置");
    const request = structuredClone(record.providerRequest) as ResponseCreateParams;
    if (request.model !== record.configuration.modelId || request.model !== profile.modelId) throw new Error("案例模型与当前配置不一致，不能静默替换模型");
    if (request.tools?.some(tool => tool.type !== "function")) throw new Error("只读回放仅接受本地函数工具定义");
    // Archived caps remain in the original case, never in the replay request.
    delete request.max_output_tokens;
    if (overrides.effort) request.reasoning = { ...request.reasoning, effort: overrides.effort };
    if (overrides.forceSingleTool) {
      if (request.tools?.length !== 1 || request.tools[0].type !== "function") throw new Error("固定工具复测要求原案例恰好只有一个函数工具");
      request.tool_choice = { type: "function", name: request.tools[0].name };
    }
    // Preserve native call IDs, tool results and stream mode; never execute returned actions.
    const started = Date.now(); let response: NativeResponse | undefined; let error: string | undefined;
    const deadline = replayDeadline(timeout);
    try {
      if (request.stream) {
        const stream = await client.responses.create({ ...request, stream: true }, { signal: deadline.signal });
        for await (const event of stream) {
          if (event.type === "error") throw new Error(event.message);
          if (["response.completed", "response.incomplete", "response.failed"].includes(event.type) && "response" in event) {
            if (response) throw new Error("Responses 返回重复终止事件");
            response = event.response;
          }
        }
      } else response = await client.responses.create({ ...request, stream: false }, { signal: deadline.signal });
      deadline.signal.throwIfAborted();
      if (!response) throw new Error("Responses 缺少完整的终止响应");
      if (response.status !== "completed") throw new Error(`Responses 返回 ${response.status}：${response.incomplete_details?.reason ?? response.error?.message ?? "未完成"}`);
      const calls = response.output.filter(item => item.type === "function_call");
      if (calls.length !== 1) throw new Error(`Responses 应返回一个工具调用，实际为 ${calls.length}`);
      const call = calls[0];
      if (!request.tools?.some(tool => tool.type === "function" && tool.name === call.name)) throw new Error(`Responses 返回不可用工具 ${call.name}`);
      JSON.parse(call.arguments);
    } catch (cause) { error = nativeError(deadline.signal.aborted ? deadline.signal.reason : cause); }
    finally { deadline.close(); }
    return redact({ ...record, id: randomUUID(), originCaseId: record.id, sourceHash: sourceHash(),
      configuration: { ...record.configuration, replay: { originSourceHash: record.sourceHash, overrides, requestTimeoutMs: timeout, requestTimeoutScope: "headers-and-body" } },
      requestFormat: "native-responses", providerRequest: request, response, error,
      stream: undefined, sdkOutput: undefined, inputTokens: response?.usage?.input_tokens ?? 0,
      outputTokens: response?.usage?.output_tokens ?? 0, finishReason: response?.status,
      createdAt: new Date().toISOString(), durationMs: Date.now() - started });
  }
  const sdk = new OpenAIProvider({ useResponses: provider.apiMode === "responses", openAIClient: client });
  const model = await sdk.getModel(String(record.configuration.modelId)); const started = Date.now();
  const request = replayRequest(record);
  request.modelSettings = { ...request.modelSettings, ...(overrides.effort ? { reasoning: { ...request.modelSettings.reasoning, effort: overrides.effort } } : {}) };
  delete request.modelSettings.maxTokens;
  if (request.modelSettings.providerData) {
    delete request.modelSettings.providerData.max_output_tokens;
    delete request.modelSettings.providerData.max_tokens;
    delete request.modelSettings.providerData.max_completion_tokens;
  }
  if (overrides.forceSingleTool) {
    if (request.tools.length !== 1 || request.tools[0].type !== "function") throw new Error("固定工具复测要求原案例恰好只有一个函数工具");
    request.modelSettings.toolChoice = request.tools[0].name;
  }
  let response, error;
  const deadline = replayDeadline(timeout);
  try {
    response = await withTrace(new NoopTrace(), () => model.getResponse({ ...request, signal: deadline.signal }));
    deadline.signal.throwIfAborted();
    error = inspectModelResponse(response, request).error;
  } catch (cause) { error = nativeError(deadline.signal.aborted ? deadline.signal.reason : cause); }
  finally { deadline.close(); }
  return redact({ ...record, id: randomUUID(), originCaseId: record.id, sourceHash: sourceHash(), configuration: { ...record.configuration,
    replay: { originSourceHash: record.sourceHash, overrides, requestTimeoutMs: timeout, requestTimeoutScope: "headers-and-body" } }, request, createdAt: new Date().toISOString(), response, error, durationMs: Date.now() - started });
}
