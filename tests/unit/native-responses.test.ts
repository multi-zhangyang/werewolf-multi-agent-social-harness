import { afterEach, expect, it, vi } from "vitest";
import { tool } from "@openai/agents";
import { z } from "zod";
import { runNativeAgent, NativeAgentError, safeNativeText, type NativeActivity, type NativeState } from "../../src/agents/sdk";
import { nativeCall, nativeResponse, responsesFixture, sendEvent, sendResponse } from "../helpers/responses-fixture";
import type { ModelRegistry } from "../../src/society/models/registry";
import { generalContext } from "../helpers/general-agent-fixture";
import { modelParticipantFactory } from "../../src/runtime/participant";
afterEach(() => vi.unstubAllEnvs());
interface State extends NativeState { prepared?: string; staged?: number }
function activate(registry: ModelRegistry, state: State, signal?: AbortSignal, onActivity?: (event: NativeActivity) => void) {
  vi.stubEnv("RESPONSES_TEST_KEY", "local-test-credential-canary");
  return runNativeAgent(registry, { maxTurns: 3 }, { name: "test", actorId: "actor", sessionId: crypto.randomUUID(), instructions: "Use native tools.", input: "test", context: state,
    signal, onActivity, done: () => state.staged !== undefined, tools: report => [
      tool({ name: "prepare", description: "Returns an unpredictable receipt.", parameters: z.object({}).strict(), execute: async () => { state.prepared = crypto.randomUUID(); return { receipt: state.prepared }; } }),
      tool({ name: "commit", description: "Stage a number.", parameters: z.object({ amount: z.number().int(), receipt: z.string().nullable() }).strict(),
        execute: async ({ amount, receipt }) => { if (state.prepared && receipt !== state.prepared) throw new Error("receipt mismatch"); state.staged = amount; return { staged: amount }; },
        errorFunction: (ctx, error) => report("commit", error, ctx.toolInput) }),
    ] });
}
it("uses actual Responses HTTP, native strict schemas and call_id-linked SDK function_call_output", async () => {
  const fixture = await responsesFixture((body, response, index) => {
    expect(body).toMatchObject({ model: "gpt-6-luna", stream: true, tool_choice: "required", parallel_tool_calls: false, store: false, truncation: "disabled" });
    expect(body.messages).toBeUndefined(); expect(body.response_format).toBeUndefined();
    for (const key of ["max_output_tokens", "max_tokens", "max_completion_tokens"]) expect(body).not.toHaveProperty(key);
    expect(body.tools.find(t => t.name === "commit")).toMatchObject({ type: "function", strict: true, parameters: { additionalProperties: false, required: ["amount", "receipt"] } });
    if (!index) sendResponse(response, [nativeCall("prepare", {}, "receipt-call")]);
    else {
      const receipt = body.input.find(item => item.type === "function_call_output")!;
      expect(receipt.call_id).toBe("receipt-call");
      sendResponse(response, [nativeCall("commit", { amount: 7, receipt: JSON.parse(receipt.output!).receipt }, "commit-call")]);
    }
  });
  try {
    const state: State = { turn: 0 }; const result = await activate(fixture.registry, state);
    expect(state.staged).toBe(7); expect(fixture.urls).toEqual(["/v1/responses", "/v1/responses"]); expect(fixture.errors).toEqual([]);
    expect(result.transcript).toMatchObject({ inputTokens: 40, outputTokens: 20, toolFailures: 0 });
    expect(result.configuration.modelSettings).not.toHaveProperty("maxTokens");
    expect(result.transcript.exchanges.map(e => e.stream?.toolCalls?.[0]?.name)).toEqual(["prepare", "commit"]);
    expect(JSON.stringify(result)).not.toContain("local-test-credential-canary");
  } finally { await fixture.close(); }
});
it("keeps SDK validation errors in the native loop without coercion or a whole-run retry", async () => {
  const fixture = await responsesFixture((body, response, index) => {
    if (index) expect(JSON.parse(body.input.findLast(item => item.type === "function_call_output")!.output!).error).toBeTruthy();
    sendResponse(response, [nativeCall("commit", { amount: index ? 3 : "3", receipt: null }, `call-${index}`)]);
  });
  try {
    const state: State = { turn: 0 }; const result = await activate(fixture.registry, state);
    expect(state.staged).toBe(3); expect(fixture.requests).toHaveLength(2); expect(result.transcript.toolFailures).toBe(1);
  } finally { await fixture.close(); }
});
it.each(["incomplete", "failed", "duplicate-terminal", "parallel-calls", "missing-terminal", "trailing-error"])("discards the entire activation on %s", async variant => {
  const fixture = await responsesFixture((_body, response) => {
    const output = [nativeCall("commit", { amount: 5, receipt: null })];
    if (variant === "parallel-calls") output.push(nativeCall("commit", { amount: 6, receipt: null }, "second"));
    if (variant === "missing-terminal") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      sendEvent(response, { type: "response.created", response: nativeResponse([], "in_progress") });
      sendEvent(response, { type: "response.output_item.added", output_index: 0, item: output[0] });
      return;
    }
    sendResponse(response, output, ["incomplete", "failed"].includes(variant) ? variant : "completed");
    if (variant === "duplicate-terminal") sendEvent(response, { type: "response.completed", response: nativeResponse(output) });
    if (variant === "trailing-error") response.write('event: response.output_text.delta\ndata: {broken-json\n\n');
  });
  try {
    let commits = 0;
    const error = await activate(fixture.registry, { turn: 0 }).then(() => { commits++; return undefined; }, error => error);
    expect(error).toBeInstanceOf(NativeAgentError); expect(commits).toBe(0); expect(fixture.requests).toHaveLength(1);
    expect(error.transcript.exchanges).toHaveLength(1);
  } finally { await fixture.close(); }
});
it("aborts a partial HTTP stream and retains incomplete argument evidence without committing", async () => {
  let opened!: () => void; const received = new Promise<void>(resolve => { opened = resolve; });
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const fixture = await responsesFixture(async (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sendEvent(response, { type: "response.created", response: nativeResponse([], "in_progress") });
    sendEvent(response, { type: "response.output_item.added", output_index: 0, item: { ...nativeCall("commit", {}), arguments: "" } });
    sendEvent(response, { type: "response.function_call_arguments.delta", item_id: "fc-fixture-call", output_index: 0, delta: '{"amount":' });
    opened(); await hold;
  });
  try {
    const abort = new AbortController(); const pending = activate(fixture.registry, { turn: 0 }, abort.signal).catch(error => error);
    await received; await new Promise(resolve => setTimeout(resolve, 30)); abort.abort(); release();
    const error = await pending;
    expect(error).toBeInstanceOf(NativeAgentError); expect(error.transcript.exchanges[0].stream.toolCalls[0].arguments).toBe('{"amount":');
    expect(fixture.requests).toHaveLength(1);
  } finally { release(); await fixture.close(); }
});
it("reports a filtered response as a model failure and a blocked tool, preserving the failure without a retry", async () => {
  const fixture = await responsesFixture((_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sendEvent(response, { type: "response.created", response: nativeResponse([], "in_progress") });
    const output = [nativeCall("invest", { amount: 4, strategy: "cooperate", intent: "truthful", privateAim: "fixture" }, "blocked-call")];
    sendEvent(response, { type: "response.incomplete", response: { ...nativeResponse(output, "incomplete"), incomplete_details: { reason: "content_filter" } } });
  });
  try {
    vi.stubEnv("RESPONSES_TEST_KEY", "local-test-credential-canary");
    const { context, spec, activations } = generalContext("off");
    const error = await modelParticipantFactory(fixture.registry)(context.character, spec, "r").turn(context).catch(error => error);
    expect(error).toBeInstanceOf(NativeAgentError); expect(error.message).toContain("content_filter");
    expect(activations).toEqual([]); expect(fixture.requests).toHaveLength(1);
    expect(error.transcript.toolFailures).toBe(0);
    expect(error.transcript.activities.some((event: NativeActivity) => event.kind === "model_error" && event.message?.includes("content_filter"))).toBe(true);
    expect(error.transcript.activities.some((event: NativeActivity) => event.kind === "tool_rejected" && event.callId === "blocked-call")).toBe(true);
    expect(error.transcript.activities.some((event: NativeActivity) => event.kind === "tool_end" && event.callId === "blocked-call")).toBe(false);
    expect(error.transcript.exchanges[0].response.providerData).toMatchObject({ status: "incomplete", incomplete_details: { reason: "content_filter" } });
  } finally { await fixture.close(); }
});
it("publishes initial and trailing stream content while the HTTP response is still open", async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const fixture = await responsesFixture(async (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sendEvent(response, { type: "response.created", response: nativeResponse([], "in_progress") });
    sendEvent(response, { type: "response.reasoning_summary_text.delta", item_id: "reasoning", output_index: 0, summary_index: 0, delta: "First segment." });
    sendEvent(response, { type: "response.reasoning_summary_text.delta", item_id: "reasoning", output_index: 0, summary_index: 0, delta: " Last segment before pause." });
    await hold;
    const output = [nativeCall("commit", { amount: 5, receipt: null })];
    sendEvent(response, { type: "response.completed", response: nativeResponse(output) });
  });
  const activities: NativeActivity[] = [];
  const state: State = { turn: 0 };
  const pending = activate(fixture.registry, state, undefined, event => activities.push(event));
  // Attach a rejection handler immediately so assertion failures still clean up the open stream.
  const settled = pending.then(result => ({ result }), error => ({ error }));
  try {
    await vi.waitFor(() => expect(activities.some(event => event.kind === "model_delta" && event.stream?.reasoning === "First segment. Last segment before pause.")).toBe(true), { timeout: 1000 });
    expect(state.staged).toBeUndefined();
    expect(activities.some(event => event.kind === "model_end")).toBe(false);
    release();
    const outcome = await settled;
    expect("error" in outcome).toBe(false);
    expect(state.staged).toBe(5);
    const count = activities.length;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(activities).toHaveLength(count);
    expect(fixture.requests).toHaveLength(1);
  } finally { release(); await settled; await fixture.close(); }
});
it("withholds a credential prefix until all its bytes can be redacted", () => {
  vi.stubEnv("STREAM_TEST_TOKEN", "secret-canary-long-token");
  expect(safeNativeText("text secret-canary-")).toBe("text ");
  expect(safeNativeText("text secret-canary-long-token after")).toBe("text [redacted] after");
});
