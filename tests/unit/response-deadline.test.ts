import { afterEach, expect, it, vi } from "vitest";
import { NativeAgentError } from "../../src/agents/sdk";
import type { HarnessEvent } from "../../src/runtime/harness";
import { modelParticipantFactory } from "../../src/runtime/participant";
import { decisionMeta, generalContext } from "../helpers/general-agent-fixture";
import { nativeCall, nativeResponse, responsesFixture, sendEvent, sendResponse } from "../helpers/responses-fixture";

afterEach(() => vi.unstubAllEnvs());

it.each(["headers", "partial", "terminal", "buffered"])("enforces the configured response deadline after HTTP headers: %s", async phase => {
  const call = nativeCall("invest", { amount: 4, ...decisionMeta, strategyBasis: null });
  const fixture = await responsesFixture(async (_body, response) => {
    if (phase === "buffered") {
      const body = JSON.stringify(nativeResponse([call]));
      response.writeHead(200, { "content-type": "application/json" }); response.write(body.slice(0, 10));
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!response.destroyed) response.write(body.slice(10));
      return;
    }
    if (phase === "terminal") sendResponse(response, [call]);
    else {
      response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
      if (phase === "partial") {
        sendEvent(response, { type: "response.created", response: nativeResponse([], "in_progress") });
        sendEvent(response, { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "", status: "in_progress" } });
        sendEvent(response, { type: "response.function_call_arguments.delta", item_id: call.id, output_index: 0, delta: '{"amount":' });
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!response.destroyed && phase !== "terminal") sendEvent(response, { type: "response.completed", response: nativeResponse([call]) });
  });
  try {
    vi.stubEnv("RESPONSES_TEST_KEY", "local-test-credential-canary");
    const { context, spec, activations } = generalContext("off");
    const before = structuredClone(context.cognition); const activities: HarnessEvent[] = [];
    context.recordHarnessEvent = event => activities.push(event);
    const error = await modelParticipantFactory(fixture.registry, { streamOutput: phase !== "buffered", requestTimeoutMs: 400 })(context.character, spec, "r").turn(context).catch(error => error);
    expect(error).toBeInstanceOf(NativeAgentError); expect(error.message).toContain("400 ms");
    expect(activations).toEqual([]); expect(context.cognition).toEqual(before); expect(fixture.requests).toHaveLength(1);
    expect(error.transcript.exchanges).toHaveLength(1); expect(error.transcript.exchanges[0].providerRequest.model).toBe("gpt-6-luna");
    expect(activities.some(event => event.kind === "model_error")).toBe(true);
    if (phase === "partial") expect(error.transcript.exchanges[0].stream.toolCalls[0].arguments).toBe('{"amount":');
    if (phase === "terminal") expect(error.transcript.exchanges[0].response.providerData.status).toBe("completed");
  } finally { await fixture.close(); }
});

it("releases each HTTP deadline when its body ends so later SDK turns retain their own full budget", async () => {
  const fixture = await responsesFixture(async (_body, response, index) => {
    await new Promise(resolve => setTimeout(resolve, 250));
    sendResponse(response, [index < 2 ? nativeCall("recall", { query: "当前可见处境" }, `recall-${index}`) : nativeCall("invest", { amount: 2, ...decisionMeta, strategyBasis: null }, "action")]);
  });
  try {
    vi.stubEnv("RESPONSES_TEST_KEY", "local-test-credential-canary");
    const { context, spec, activations } = generalContext("off");
    await modelParticipantFactory(fixture.registry, { requestTimeoutMs: 600 })(context.character, spec, "r").turn(context);
    expect(fixture.requests).toHaveLength(3); expect(activations).toHaveLength(1); expect(activations[0].calls).toEqual([{ name: "invest", args: { amount: 2 } }]);
  } finally { await fixture.close(); }
});
