import { Usage, type Model, type ModelRequest, type ModelResponse, type StreamEvent } from "@openai/agents";
export function sdkCall(name: string, value: unknown, callId = crypto.randomUUID()): ModelResponse {
  return { output: [{ type: "function_call", callId, name, arguments: JSON.stringify(value), status: "completed" }],
    usage: new Usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }), providerData: { status: "completed" } };
}
export function sdkInput(request: ModelRequest) {
  const item = Array.isArray(request.input) && request.input.find(item => item.type === "message" && item.role === "user");
  if (!item || item.type !== "message" || typeof item.content !== "string") throw new Error("Missing structured actor input");
  return JSON.parse(item.content);
}
export function sdkToolResult(request: ModelRequest) {
  const item = Array.isArray(request.input) && request.input.findLast(item => item.type === "function_call_result");
  if (!item || item.type !== "function_call_result") throw new Error("SDK tool output missing");
  return JSON.parse(typeof item.output === "string" ? item.output : "text" in item.output ? item.output.text : "{}");
}
/** Official Model dependency injection, used only to test the real SDK loop deterministically. */
export function sdkFixture(callback: (request: ModelRequest, index: number) => ModelResponse | Promise<ModelResponse>) {
  const requests: ModelRequest[] = [];
  const response = async (request: ModelRequest) => { requests.push(request); return callback(request, requests.length - 1); };
  const model: Model = { getResponse: response, async *getStreamedResponse(request) {
    const result = await response(request);
    yield { type: "response_started" };
    for (const [index, item] of result.output.entries()) if (item.type === "function_call") {
      yield { type: "model", event: { type: "response.output_item.added", output_index: index,
        item: { type: "function_call", id: `fc-${item.callId}`, call_id: item.callId, name: item.name, arguments: "" } } };
      yield { type: "model", event: { type: "response.function_call_arguments.delta", item_id: `fc-${item.callId}`, delta: item.arguments } };
    }
    yield { type: "response_done", response: { id: crypto.randomUUID(), output: result.output, usage: result.usage, providerData: result.providerData } } as StreamEvent;
  } };
  return { model, requests };
}
export function appraisal(eventId: string, changes: Record<string, unknown> = {}) {
  return { eventId, reason: "根据可见事件修订自己的判断", emotions: null, needs: null, relationship: null,
    conflict: null, regulation: null, expression: null, memory: null, ...changes };
}
export function plan(eventId: string, throughRound = 3) {
  return { eventId, reason: "为后续合作设定范围", aim: "观察合作是否值得继续", nextStep: "按当前条件选择",
    continueWhen: "仍有合作机会", reviseWhen: "新证据改变判断", abandonWhen: "代价超过目标收益",
    role: "any", fromRound: 1, throughRound, phases: ["offer", "invest", "settle", "repair", "respond"], minimumWallet: null, targetWallet: null };
}
