/**
 * Context-manager pressure checks (run with `npx tsx scripts/verify-context-manager.ts`).
 * Uses a deterministic fake provider: compaction digests are returned by the
 * fake, so these checks verify the manager's mechanics (thresholds, pinned
 * facts, hard guard, cooldown) — not any model's prose.
 */
import { strict as assert } from "node:assert";
import type { AgentInputItem, Model, ModelProvider } from "@openai/agents";
import { SessionContextManager, parseContextMap, sanitizeFunctionCalls } from "../src/society/context-manager";
import { resolveAgentModelConfig, ModelRegistry, defaultContextPolicy, defaultCapabilities, type ModelProfile } from "../src/society/models";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ok  ${name}`);
  }).catch((cause) => {
    console.error(`  FAIL ${name}:`, cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  });
}

const registry = new ModelRegistry();
registry.upsertProvider({
  id: "p1", name: "Fake", kind: "local", baseURL: "https://fake.invalid",
  apiKeyRef: "env:TEST_KEY", apiMode: "chat-completions", enabled: true,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
});
const profile: ModelProfile = {
  id: "mp-small", name: "fake-model", providerProfileId: "p1", modelId: "fake-model",
  contextWindow: 20_000, contextWindowSource: "manual", capabilities: defaultCapabilities(),
  defaults: {}, contextPolicyId: "policy-balanced-auto", enabled: true
};
registry.upsertModelProfile(profile);
registry.upsertContextPolicy(defaultContextPolicy());

const resolved = resolveAgentModelConfig({
  agentId: "a1",
  lookup: {
    modelProfile: (id) => registry.modelProfile(id),
    providerProfile: (id) => registry.providerProfile(id),
    contextPolicy: (id) => registry.contextPolicy(id),
    firstModelProfile: () => registry.listModelProfiles().find((p) => p.enabled)
  }
});

/** A provider whose model returns a fixed digest and counts calls. */
function fakeProvider(calls: { digest: number }): ModelProvider {
  const fakeModel = {
    getResponse: async ({ systemInstructions, input }: { systemInstructions?: string[]; input: string }) => {
      calls.digest += 1;
      const seenPinned = (systemInstructions ?? []).join("\n").includes("pinned facts");
      return {
        output: [{
          type: "message",
          content: [{ type: "output_text", text: seenPinned ? "DIGEST_WITH_PINNED_FACTS" : "DIGEST" }]
        }]
      };
    }
  } as unknown as Model;
  return {
    getModel: async () => fakeModel
  } as unknown as ModelProvider;
}

function messageItem(text: string, length: number): AgentInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: text.repeat(length) }]
  } as unknown as AgentInputItem;
}

function bigHistory(charCount: number): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  let remaining = charCount;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 2_000);
    items.push(messageItem("很久以前的一段对话。", Math.ceil(chunk / 11)));
    remaining -= chunk;
  }
  return items;
}

async function run(): Promise<void> {
  check("parseContextMap parses model:tokens entries", () => {
    const map = parseContextMap("a:1000, b:2000");
    assert.equal(map.get("a"), 1000);
    assert.equal(map.get("b"), 2000);
    assert.equal(map.size, 2);
  });

  await check("below watch threshold returns history untouched", async () => {
    const calls = { digest: 0 };
    const manager = new SessionContextManager({
      provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
      resolvedConfig: resolved, getPinnedFacts: () => ["我是 T，角色：狼人"]
    });
    const history = bigHistory(2_000);
    const result = await manager.sessionInputCallback(history, [messageItem("new", 1)]);
    assert.equal(result.length, history.length + 1);
    assert.equal(calls.digest, 0);
    assert.equal(manager.pressure(), "normal");
  });

  await check("crossing soft-compact threshold compacts and keeps pinned facts", async () => {
    const calls = { digest: 0 };
    const manager = new SessionContextManager({
      provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
      resolvedConfig: resolved,
      getPinnedFacts: () => ["我是 T，角色：狼人，胜利条件：狼人阵营获胜"]
    });
    // softCompactRatio 0.72 of usable input ≈ usable*0.72; usable ≈ 20000 - reserves.
    const history = bigHistory(Math.floor(resolved.usableInputTokens * 0.8));
    const result = await manager.sessionInputCallback(history, []);
    assert.ok(calls.digest >= 1, "expected at least one digest call");
    const first = result[0] as unknown as Record<string, unknown>;
    const content = (first.content as Array<Record<string, unknown>>)[0]?.text as string;
    assert.ok(content.includes("固定事实"), "digest must carry the pinned-facts block");
    assert.ok(content.includes("我是 T，角色：狼人"), "identity fact survives");
    assert.ok(content.includes("胜利条件"), "win-condition fact survives");
    assert.ok(result.length < history.length, "history shrinks after compaction");
    assert.equal(manager.pressure(), "normal");
  });

  await check("hard guard throws instead of overrunning the window", async () => {
    const calls = { digest: 0 };
    const manager = new SessionContextManager({
      provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
      resolvedConfig: resolved
    });
    // history alone exceeds hardLimitRatio (0.95) of usable input.
    const history = bigHistory(Math.floor(resolved.usableInputTokens * 0.97));
    await assert.rejects(
      () => manager.sessionInputCallback(history, []),
      /CONTEXT_HARD_GUARD/
    );
  });

  await check("sanitizeFunctionCalls repairs truncated tool-call JSON in the request view", async () => {
    const items = [
      { type: "message", role: "assistant", content: "ok" },
      { type: "function_call", name: "update_inner_state", arguments: "{\"summary\":\"truncated" }
    ] as unknown as Parameters<typeof sanitizeFunctionCalls>[0];
    const repaired = sanitizeFunctionCalls(items);
    const call = repaired[1] as unknown as { arguments: string };
    assert.doesNotThrow(() => JSON.parse(call.arguments), "repaired arguments must be valid JSON");
    const parsed = JSON.parse(call.arguments) as Record<string, unknown>;
    assert.equal(parsed._recovered, true, "the placeholder marks the recovery");
    assert.equal((items[1] as unknown as { arguments: string }).arguments, "{\"summary\":\"truncated", "the original item is untouched");
    assert.equal(repaired[0], items[0], "valid items pass through");
  });

  await check("sanitizeFunctionCalls leaves valid tool calls untouched", async () => {
    const items = [
      { type: "function_call", name: "communicate", arguments: "{\"text\":\"hello\"}" }
    ] as unknown as Parameters<typeof sanitizeFunctionCalls>[0];
    assert.equal(sanitizeFunctionCalls(items), items, "no copy when nothing is broken");
  });

  await check("cooldown suppresses repeated soft compactions", async () => {
    const calls = { digest: 0 };
    const manager = new SessionContextManager({
      provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
      resolvedConfig: resolved
    });
    const history = bigHistory(Math.floor(resolved.usableInputTokens * 0.8));
    await manager.sessionInputCallback(history, []);
    const firstCount = calls.digest;
    // Immediately after compaction, pressure dropped — this call must not
    // re-compact while the cooldown is active.
    const again = bigHistory(Math.floor(resolved.usableInputTokens * 0.7));
    const result = await manager.sessionInputCallback(again, []);
    assert.equal(calls.digest, firstCount, "cooldown must suppress another compaction");
    assert.ok(result.length >= again.length);
  });
}

void run().then(() => {
  console.log(`\nContext-manager checks: ${passed} passed.`);
});