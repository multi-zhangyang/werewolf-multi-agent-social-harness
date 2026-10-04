import { afterEach, expect, it, vi } from "vitest";
import { redact, type DecisionCase } from "../../src/runtime/cases";
import { replayDecisionCase } from "../../src/runtime/replay-case";
import { ModelRegistry } from "../../src/society/models/registry";
import { defaultCapabilities, defaultContextPolicy } from "../../src/society/models/defaults";
import { EconomicScenario } from "../../src/runtime/scenarios/economic";
import { nativeCall, nativeResponse, responsesFixture, sendEvent, sendResponse } from "../helpers/responses-fixture";
import { inspectModelResponse } from "../../src/runtime/model";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function registry() {
  vi.stubEnv("CASE_TEST_KEY", "case-test-secret"); const r = new ModelRegistry(); const now = new Date().toISOString();
  r.upsertProvider({ id: "offline", name: "offline", kind: "custom", baseURL: "https://offline.invalid/v1", apiKeyRef: "env:CASE_TEST_KEY", apiMode: "chat-completions", enabled: true, createdAt: now, updatedAt: now });
  r.upsertModelProfile({ id: "offline", name: "offline", providerProfileId: "offline", modelId: "offline", contextWindow: 32768, contextWindowSource: "manual", capabilities: defaultCapabilities(), defaults: {}, enabled: true, contextPolicyId: defaultContextPolicy().id }); return r;
}
function completion(name: string, args: unknown) { return new Response(JSON.stringify({ id: "test", object: "chat.completion", created: 1, model: "offline", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { headers: { "content-type": "application/json" } }); }
it("scrubs credentials and replays model calls without running returned actions", async () => {
  const r = registry(); const apply = vi.spyOn(EconomicScenario.prototype, "apply");
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(init.body as string)); return completion("invest", { amount: 10 }); });
  const record: DecisionCase = { id: "original", runId: "run", actorId: "self", opportunityId: "op", phase: "action", createdAt: "", sourceHash: "hash", context: {}, configuration: { profileId: "offline", modelId: "offline" }, durationMs: 0,
    request: { input: "请选择投资金额", systemInstructions: "这是固定输入", tools: [{ type: "function", name: "invest", description: "投资", parameters: { type: "object", properties: { amount: { type: "integer" } }, required: ["amount"], additionalProperties: false }, strict: true }], modelSettings: { toolChoice: "required", maxTokens: 16000, providerData: { max_completion_tokens: 2048 } }, outputType: "text", handoffs: [], tracing: "disabled", signal: {} } };
  const result = await replayDecisionCase(record, r, { effort: "low" });
  expect(result.error).toBeUndefined(); expect(result.originCaseId).toBe(record.id); expect(requests).toHaveLength(1); expect(apply).not.toHaveBeenCalled();
  expect(record.response).toBeUndefined(); expect(JSON.stringify(redact({ message: "case-test-secret", authorization: "another-secret" }))).not.toContain("secret");
  expect((result.request as any).modelSettings).toMatchObject({ reasoning: { effort: "low" } });
  expect((result.request as any).modelSettings).not.toHaveProperty("maxTokens");
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) expect(requests[0]).not.toHaveProperty(key);
  expect((record.request as any).modelSettings).toEqual({ toolChoice: "required", maxTokens: 16000, providerData: { max_completion_tokens: 2048 } });
  expect(result.configuration.replay).toEqual({ originSourceHash: "hash", overrides: { effort: "low" }, requestTimeoutMs: 120000, requestTimeoutScope: "headers-and-body" });
  const forced = await replayDecisionCase(record, r, { forceSingleTool: true });
  expect((requests[1] as any).tool_choice).toEqual({ type: "function", function: { name: "invest" } });
  expect((forced.request as any).modelSettings.toolChoice).toBe("invest");
  expect(apply).not.toHaveBeenCalled();
});

function nativeCase(stream: boolean): DecisionCase {
  return { id: "native-original", runId: "run", actorId: "self", opportunityId: "op", phase: "action", createdAt: "", sourceHash: "hash", context: {}, durationMs: 0,
    configuration: { modelProfileId: "gpt-6-luna", modelId: "gpt-6-luna", executionVersion: "native-responses-v1" },
    requestFormat: "native-responses", request: { input: "SDK filter input is not a full request" },
    providerRequest: { model: "gpt-6-luna", stream, store: false, parallel_tool_calls: false, tool_choice: "required", max_output_tokens: 4096,
      instructions: "当前合法工具", input: [nativeCall("appraise_event", { sourceIds: ["e1"] }, "original-call-id"),
        { type: "function_call_output", call_id: "original-call-id", output: "{\"revision\":1}" }],
      tools: [{ type: "function", name: "invest", strict: true, parameters: { type: "object", properties: { amount: { type: "integer" } }, required: ["amount"], additionalProperties: false } }] } };
}
it.each([true, false])("replays native Responses through HTTP with stream=%s and preserves original call/result IDs", async stream => {
  vi.stubEnv("RESPONSES_TEST_KEY", "responses-test-secret"); const apply = vi.spyOn(EconomicScenario.prototype, "apply");
  const fixture = await responsesFixture((body, response) => {
    expect(body.stream).toBe(stream);
    if (stream) sendResponse(response, [nativeCall("invest", { amount: 7 }, "replay-call")]);
    else { response.writeHead(200, { "content-type": "application/json" }); response.write(JSON.stringify(nativeResponse([nativeCall("invest", { amount: 7 }, "replay-call")]))); }
  });
  try {
    const record = nativeCase(stream); const before = structuredClone(record);
    const result = await replayDecisionCase(record, fixture.registry, { forceSingleTool: true });
    expect(result.error).toBeUndefined(); expect(result.originCaseId).toBe(record.id); expect(record).toEqual(before);
    expect(fixture.urls).toEqual(["/v1/responses"]);
    expect(fixture.requests[0]).toMatchObject({ input: (record.providerRequest as any).input, tool_choice: { type: "function", name: "invest" }, store: false });
    expect(fixture.requests[0]).not.toHaveProperty("max_output_tokens");
    expect(result.providerRequest).toEqual(fixture.requests[0]); expect(result.inputTokens).toBe(20); expect(result.outputTokens).toBe(10);
    expect(apply).not.toHaveBeenCalled(); expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});
it.each(["incomplete", "missing-terminal", "duplicate-terminal"])("retains failed native replay evidence for %s without executing actions", async mode => {
  vi.stubEnv("RESPONSES_TEST_KEY", "responses-test-secret"); const apply = vi.spyOn(EconomicScenario.prototype, "apply");
  const fixture = await responsesFixture((_body, response) => {
    if (mode === "missing-terminal") { response.writeHead(200, { "content-type": "text/event-stream" }); sendEvent(response, { type: "response.created", response: nativeResponse([], "in_progress") }); }
    else sendResponse(response, [nativeCall("invest", { amount: 7 })], mode === "incomplete" ? "incomplete" : "completed");
    if (mode === "duplicate-terminal") sendEvent(response, { type: "response.completed", response: nativeResponse([nativeCall("invest", { amount: 7 })]) });
  });
  try {
    const record = nativeCase(true); const result = await replayDecisionCase(record, fixture.registry);
    expect(result.error).toBeTruthy();
    const expectedRequest = structuredClone(record.providerRequest) as any; delete expectedRequest.max_output_tokens;
    expect(result.providerRequest).toEqual(expectedRequest);
    expect(fixture.requests).toHaveLength(1); expect(apply).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});
it("distinguishes provider termination from output exhaustion in saved native and SDK responses", () => {
  const response = nativeResponse([], "incomplete");
  expect(inspectModelResponse(response as any).outputError).toBe("truncated");
  response.incomplete_details = { reason: "content_filter" };
  expect(inspectModelResponse(response as any)).toMatchObject({ outputError: "provider_terminated", error: expect.stringContaining("content_filter") });
  expect(inspectModelResponse({ output: [], usage: { outputTokens: 0 }, providerData: response } as any).outputError).toBe("provider_terminated");
});

it.each(["headers", "terminal", "buffered"] as const)("enforces the complete response deadline in a read-only replay: %s", async mode => {
  vi.stubEnv("RESPONSES_TEST_KEY", "responses-test-secret"); const apply = vi.spyOn(EconomicScenario.prototype, "apply");
  const call = nativeCall("invest", { amount: 7 });
  const fixture = await responsesFixture(async (_body, response) => {
    if (mode === "terminal") sendResponse(response, [call]);
    else if (mode === "buffered") { response.writeHead(200, { "content-type": "application/json" }); response.write(JSON.stringify(nativeResponse([call]))); }
    else { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); }
    await new Promise(resolve => setTimeout(resolve, 1600));
    if (mode === "headers" && !response.destroyed) sendEvent(response, { type: "response.completed", response: nativeResponse([call]) });
  });
  try {
    const record = nativeCase(mode !== "buffered"), before = structuredClone(record);
    const result = await replayDecisionCase(record, fixture.registry, { requestTimeoutMs: 1000 });
    expect(result.error).toContain("1000 ms"); expect(record).toEqual(before);
    expect(result.configuration.replay).toMatchObject({ requestTimeoutMs: 1000, requestTimeoutScope: "headers-and-body" });
    expect(fixture.requests).toHaveLength(1); expect(apply).not.toHaveBeenCalled();
    if (mode === "terminal") expect(result.response).toMatchObject({ status: "completed" });
  } finally { await fixture.close(); }
});
