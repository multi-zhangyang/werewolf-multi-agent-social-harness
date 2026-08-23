/**
 * Provider-safe history sanitizer tests (AGENTS.md §16.2 / §23): models
 * occasionally emit malformed tool-call arguments (unescaped inner quotes,
 * truncation mid-value). Strict endpoints validate replayed
 * `function_call.arguments` and reject the whole request over one bad entry,
 * so the store must enforce the wire contract at its boundary.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { sanitizeFunctionCallArgs } from "../../src/society/persistence/session-store";
import type { AgentInputItem } from "@openai/agents";

function functionCallItem(argumentsText: string): AgentInputItem {
  return { type: "function_call", callId: "call-1", name: "update_inner_state", arguments: argumentsText } as unknown as AgentInputItem;
}

function parsedArgumentsOf(item: AgentInputItem): unknown {
  assert.equal((item as unknown as Record<string, unknown>).type, "function_call");
  return JSON.parse((item as unknown as Record<string, unknown>).arguments as string);
}

describe("sanitizeFunctionCallArgs", () => {
  it("repairs unescaped ASCII quotes inside string values (real glm-5.2 capture)", () => {
    const malformed = '{"attention": ["观察其他人对"谁在定标准"这条提问的反应", "注意陈策的发言"], "belief": null}';
    const [out] = sanitizeFunctionCallArgs([functionCallItem(malformed)]);
    const parsed = parsedArgumentsOf(out) as { attention: string[]; belief: string | null };
    assert.equal(parsed.attention[0], "观察其他人对\"谁在定标准\"这条提问的反应");
    assert.equal(parsed.attention[1], "注意陈策的发言");
    assert.equal(parsed.belief, null);
  });

  it("repairs truncation by closing the open string and brackets", () => {
    const truncated = '{"emotionDelta": {"anger": 0, "fear": 0.1}, "attention": ["盯着他的发言';
    const [out] = sanitizeFunctionCallArgs([functionCallItem(truncated)]);
    const parsed = parsedArgumentsOf(out) as { emotionDelta: { anger: number; fear: number }; attention: string[] };
    assert.equal(parsed.emotionDelta.anger, 0);
    assert.equal(parsed.attention[0], "盯着他的发言");
  });

  it("leaves valid arguments untouched and falls back to {} when unrepairable", () => {
    const valid = '{"text": "正常参数"}';
    const [untouched] = sanitizeFunctionCallArgs([functionCallItem(valid)]);
    assert.equal(JSON.stringify(parsedArgumentsOf(untouched)), JSON.stringify({ text: "正常参数" }));

    const hopeless = '{"a": "b",,,}';
    const [fallback] = sanitizeFunctionCallArgs([functionCallItem(hopeless)]);
    assert.deepEqual(parsedArgumentsOf(fallback), {});
  });

  it("passes through non-function_call items unchanged", () => {
    const message = { type: "message", role: "user", content: "说\"引号\"也没事" } as unknown as AgentInputItem;
    const [out] = sanitizeFunctionCallArgs([message]);
    assert.deepEqual(out, message);
  });
});

describe("text-only content arrays", () => {
  it("flattens input_text part arrays to plain strings on persisted items", () => {
    const digest = {
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "【系统管理上下文】\n摘要" }]
    } as unknown as AgentInputItem;
    const [out] = sanitizeFunctionCallArgs([digest]);
    const record = out as unknown as { content: string };
    assert.equal(record.content, "【系统管理上下文】\n摘要");
  });

  it("leaves mixed or non-text parts untouched", () => {
    const mixed = {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "看图" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" }
      ]
    } as unknown as AgentInputItem;
    const [out] = sanitizeFunctionCallArgs([mixed]);
    const record = out as unknown as { content: unknown[] };
    assert.equal(Array.isArray(record.content), true);
    assert.equal(record.content.length, 2);
  });
});
