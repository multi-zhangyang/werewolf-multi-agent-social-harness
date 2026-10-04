import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelRegistry } from "../../src/society/models/registry";
import { defaultCapabilities, defaultContextPolicy } from "../../src/society/models/defaults";

export interface ResponsesRequest {
  model: string; input: Array<{ type?: string; role?: string; content?: Array<{ type: string; text: string }>; call_id?: string; output?: string; arguments?: string }>;
  instructions?: string; tools: Array<{ type: string; name: string; strict: boolean; parameters: Record<string, unknown> }>;
  stream: boolean; tool_choice: string; parallel_tool_calls: boolean; store: boolean; truncation: string;
  max_output_tokens?: number; [key: string]: unknown;
}
export function nativeResponse(output: unknown[], status = "completed", id = "fixture-response") {
  return { id, object: "response", created_at: 1, status, error: null, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    model: "gpt-6-luna", output, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
}
export const nativeCall = (name: string, args: unknown, callId = "fixture-call") => ({ id: `fc-${callId}`, type: "function_call", call_id: callId, name, arguments: typeof args === "string" ? args : JSON.stringify(args), status: "completed" });
export function sendEvent(response: ServerResponse, event: Record<string, unknown>) { response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
export function sendResponse(response: ServerResponse, output: ReturnType<typeof nativeCall>[], status = "completed") {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sendEvent(response, { type: "response.created", response: nativeResponse([], "in_progress") });
  for (const [index, item] of output.entries()) {
    sendEvent(response, { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "", status: "in_progress" } });
    sendEvent(response, { type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta: item.arguments });
    sendEvent(response, { type: "response.function_call_arguments.done", output_index: index, item_id: item.id, arguments: item.arguments });
    sendEvent(response, { type: "response.output_item.done", output_index: index, item });
  }
  sendEvent(response, { type: `response.${status}`, response: nativeResponse(output, status) });
}
export async function responsesFixture(handler: (body: ResponsesRequest, response: ServerResponse, index: number) => void | Promise<void>) {
  const requests: ResponsesRequest[] = []; const urls: string[] = []; const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as ResponsesRequest;
      requests.push(body); urls.push(request.url ?? ""); await handler(body, response, requests.length - 1); response.end();
    } catch (error) { errors.push(error); response.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const registry = new ModelRegistry(); const now = new Date().toISOString();
  registry.upsertContextPolicy(defaultContextPolicy());
  registry.upsertProvider({ id: "responses-test", name: "Responses fixture", enabled: true, kind: "custom",
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKeyRef: "env:RESPONSES_TEST_KEY", apiMode: "responses", createdAt: now, updatedAt: now });
  registry.upsertModelProfile({ id: "gpt-6-luna", name: "gpt-6-luna", modelId: "gpt-6-luna", providerProfileId: "responses-test", contextWindow: 256000,
    contextWindowSource: "manual", defaults: { maxOutputTokens: 4096, requestTimeoutMs: 2000 }, capabilities: defaultCapabilities(), enabled: true, contextPolicyId: defaultContextPolicy().id });
  return { registry, requests, urls, errors, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
