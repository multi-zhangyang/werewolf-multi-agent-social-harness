/**
 * Context-manager pressure checks. Uses a deterministic fake provider:
 * compaction digests are returned by the fake, so these checks verify the
 * manager's mechanics (thresholds, pinned facts, hard guard, cooldown) — not
 * any model's prose.
 */
import { strict as assert } from "node:assert";
import type { AgentInputItem, Model, ModelProvider } from "@openai/agents";
import { it } from "vitest";
import { SessionContextManager, parseContextMap, sanitizeFunctionCalls, type ContextSummaryArtifact } from "../../src/society/context-manager";
import { resolveAgentModelConfig, ModelRegistry, defaultContextPolicy, defaultCapabilities, type ModelProfile } from "../../src/society/models";

function check(name: string, fn: () => void | Promise<void>): void {
  it(name, fn);
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
    getResponse: async ({ systemInstructions }: { systemInstructions?: string[]; input: string }) => {
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

check("parseContextMap parses model:tokens entries", () => {
  const map = parseContextMap("a:1000, b:2000");
  assert.equal(map.get("a"), 1000);
  assert.equal(map.get("b"), 2000);
  assert.equal(map.size, 2);
});

check("below watch threshold returns history untouched", async () => {
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

check("crossing soft-compact threshold compacts and keeps pinned facts", async () => {
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

check("hard guard runs an emergency compaction and proceeds when relief works", async () => {
  const calls = { digest: 0 };
  let persisted: AgentInputItem[] | undefined;
  const manager = new SessionContextManager({
    provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
    resolvedConfig: resolved,
    onSessionCompacted: (items) => { persisted = items; }
  });
  // history alone exceeds hardLimitRatio (0.95) of usable input.
  const history = bigHistory(Math.floor(resolved.usableInputTokens * 0.97));
  const result = await manager.sessionInputCallback(history, []);
  assert.ok(calls.digest >= 1, "emergency compaction must run instead of a blind throw");
  assert.ok(result.length < history.length, "the request view is the compacted one");
  assert.ok(persisted && persisted.length === result.length, "the durable session follows the compacted view");
  const pressure = manager.pressure();
  assert.ok(["normal", "watch", "retrieval-tight", "soft-compact"].includes(pressure), `pressure relieved (${pressure})`);
});

check("hard guard still throws when even emergency compaction cannot relieve", async () => {
  const calls = { digest: 0 };
  const manager = new SessionContextManager({
    provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
    resolvedConfig: resolved
  });
  // Two enormous recent items: the keep floor (2) still exceeds the window.
  const giant = messageItem("巨", Math.floor(resolved.usableInputTokens * 0.6));
  const history = [giant, giant, giant, giant];
  await assert.rejects(
    async () => manager.sessionInputCallback(history, []),
    /CONTEXT_HARD_GUARD/
  );
});

check("sanitizeFunctionCalls repairs truncated tool-call JSON in the request view", async () => {
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

check("sanitizeFunctionCalls leaves valid tool calls untouched", async () => {
  const items = [
    { type: "function_call", name: "communicate", arguments: "{\"text\":\"hello\"}" }
  ] as unknown as Parameters<typeof sanitizeFunctionCalls>[0];
  assert.equal(sanitizeFunctionCalls(items), items, "no copy when nothing is broken");
});

check("cooldown suppresses repeated soft compactions", async () => {
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

check("compactHistory (model-switch path) leaves small histories untouched", async () => {
  const calls = { digest: 0 };
  const manager = new SessionContextManager({
    provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
    resolvedConfig: resolved
  });
  const history = bigHistory(2_000);
  const replacement = await manager.compactHistory(history);
  assert.equal(replacement, history, "no compaction when pressure is low");
  assert.equal(calls.digest, 0);
});

check("compactHistory compacts an over-budget history down to digest + recent", async () => {
  const calls = { digest: 0 };
  const manager = new SessionContextManager({
    provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
    resolvedConfig: resolved,
    getPinnedFacts: () => ["我是 T，角色：预言家"]
  });
  const history = bigHistory(Math.floor(resolved.usableInputTokens * 0.85));
  const replacement = await manager.compactHistory(history);
  assert.ok(calls.digest >= 1, "a digest call is expected");
  assert.ok(replacement.length < history.length, "replacement is much shorter");
  const first = replacement[0] as unknown as Record<string, unknown>;
  const content = (first.content as Array<Record<string, unknown>>)[0]?.text as string;
  assert.ok(content.includes("固定事实"), "digest carries the pinned-facts block");
  assert.ok(content.includes("预言家"), "the role fact survives the pre-switch compaction");
  assert.equal(replacement.at(-1), history.at(-1), "the most recent item stays verbatim at the tail");
});

// ── P0-06 additions: full-candidate budget, preflight, trusted digest ─────

check("the new turn's input is measured in the same budget as the history", async () => {
  const calls = { digest: 0 };
  const manager = new SessionContextManager({
    provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
    resolvedConfig: resolved
  });
  // History alone sits in the soft band; only counting the new input together
  // with the history pushes the activation into deep-compact territory.
  const history = bigHistory(9_000);
  const newItems = bigHistory(2_000);
  const result = await manager.sessionInputCallback(history, newItems);
  assert.ok(calls.digest >= 1, "the full candidate (history + new input) must trigger compaction");
  assert.equal((result[0] as unknown as Record<string, unknown>).role, "system", "the view opens with the trusted digest");
  const firstText = ((result[0] as unknown as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]?.text as string;
  assert.ok(firstText.includes("【历史摘要】"), "the compacted view replaced the raw head of history");
});

check("a giant new input alone trips the hard guard instead of silently overrunning", async () => {
  const calls = { digest: 0 };
  const manager = new SessionContextManager({
    provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
    resolvedConfig: resolved
  });
  const history = bigHistory(2_000);
  const giant = bigHistory(Math.floor(resolved.usableInputTokens * 0.9));
  await assert.rejects(
    async () => manager.sessionInputCallback(history, giant),
    /CONTEXT_HARD_GUARD/,
    "the request must be refused, not appended past the window"
  );
});

check("preflight reports THIS round's pressure before retrieval", () => {
  const manager = new SessionContextManager({
    provider: fakeProvider({ digest: 0 }), model: "fake-model", actorLabel: "T",
    resolvedConfig: resolved
  });
  assert.equal(manager.pressure(), "normal");
  const level = manager.preflight(bigHistory(10_000), 120);
  assert.equal(level, "soft-compact");
  assert.equal(manager.pressure(), "soft-compact", "pressure() reflects the preflight, not last round");
});

check("the digest is a trusted system block with a full provenance artifact", async () => {
  const calls = { digest: 0 };
  const artifacts: ContextSummaryArtifact[] = [];
  const manager = new SessionContextManager({
    provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
    resolvedConfig: resolved,
    ownerCharacterId: "builtin-01",
    getPinnedFacts: () => ["我是 T，角色：狼人"],
    getLogicalTime: () => 7,
    onArtifact: (artifact) => artifacts.push(artifact)
  });
  const result = await manager.sessionInputCallback(bigHistory(9_000), bigHistory(2_000));
  assert.equal(artifacts.length, 1, "one compaction → one artifact");
  const artifact = artifacts[0];
  assert.equal(artifact.ownerCharacterId, "builtin-01");
  assert.equal(artifact.summaryModel, "fake-model");
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.createdAtLogicalTime, 7);
  assert.equal(artifact.sourceItemRange.from, 0);
  assert.ok(artifact.sourceItemRange.to >= 0);
  assert.match(artifact.sourceHash, /^[0-9a-f]{64}$/);
  assert.ok(artifact.facts.includes("我是 T，角色：狼人"));
  assert.ok(artifact.compressedNarrative.length > 0);
  const first = result[0] as unknown as Record<string, unknown>;
  assert.equal(first.role, "system", "the digest is never disguised as a user message");
  const text = (first.content as Array<Record<string, unknown>>)[0]?.text as string;
  assert.ok(text.includes("【系统管理上下文"), "the trusted framing is explicit");
  assert.ok((first as { societySummaryArtifact?: unknown }).societySummaryArtifact, "the artifact rides on the item");
});

check("the digest artifact survives the durable session (compaction → reopen)", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const { JsonSessionStore } = await import("../../src/society/persistence");
  const dir = mkdtempSync(pathModule.join(tmpdir(), "society-ctx-"));
  try {
    const store = JsonSessionStore.open("ctx-test", dir);
    await store.addItems(bigHistory(9_000));
    store.close();
    const calls = { digest: 0 };
    const manager = new SessionContextManager({
      provider: fakeProvider(calls), model: "fake-model", actorLabel: "T",
      resolvedConfig: resolved,
      onSessionCompacted: (items) => store.replaceHistoryWithCompaction(items)
    });
    await manager.sessionInputCallback(await store.getItems(), bigHistory(2_000));
    store.close();
    const reopened = JsonSessionStore.open("ctx-test", dir);
    const items = await reopened.getItems();
    const first = items[0] as unknown as { role: string; societySummaryArtifact?: { summaryId: string } };
    assert.equal(first.role, "system");
    assert.ok(first.societySummaryArtifact?.summaryId, "the artifact survives the reopen");
    rmSync(dir, { recursive: true, force: true });
  } catch (cause) {
    rmSync(dir, { recursive: true, force: true });
    throw cause;
  }
});