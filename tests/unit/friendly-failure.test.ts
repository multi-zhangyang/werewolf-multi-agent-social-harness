/**
 * friendlyFailure must never echo raw provider error text into the UI —
 * classified shapes get stable phrases and unrecognized shapes get the
 * generic fallback (AGENTS.md §32: error responses must not leak provider
 * internals; the operator console keeps the full diagnostic).
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { friendlyFailure } from "../../src/society/room";

it("maps a 400 APIError to a stable phrase without the body", () => {
  const error = new Error('400 status_code=400, body={"error":{"message":"bad request","type":"invalid_request_error"}}');
  assert.equal(friendlyFailure(error), "提供商拒绝了本次请求（400），稍后重试");
});

it("maps a 422 rejection to a stable phrase", () => {
  const error = new Error('422 status_code=422, body={"error":{"message":"invalid tool schema"}}');
  assert.equal(friendlyFailure(error), "提供商拒绝了本次请求（422），稍后重试");
});

it("falls back to a generic phrase for unrecognized shapes instead of echoing raw text", () => {
  const error = new Error('403 status_code=403, body={"error":{"message":"internal account detail"}}');
  const text = friendlyFailure(error);
  assert.equal(text, "提供商请求失败，请稍后重试");
  assert.ok(!text.includes("status_code"), "no raw provider text in the UI message");
  assert.ok(!text.includes("body"), "no raw provider text in the UI message");
});

it("keeps the classified phrases for timeouts, rate limits and hard guards", () => {
  assert.equal(friendlyFailure(new Error("TURN_TIMEOUT after 300000ms")), "思考时间超时");
  assert.equal(friendlyFailure(new Error("429 rate limit exceeded")), "提供商限流，稍后重试");
  assert.equal(friendlyFailure(new Error("CONTEXT_HARD_GUARD: input exceeds usable budget")), "上下文压力达到硬上限，正在压缩");
});