import { strict as assert } from "node:assert";
import { it } from "vitest";
import { ModelRegistry, defaultCapabilities, effectiveProtocolCheck, isModelProtocolReady, protocolCheckFingerprint, type ModelProfile } from "../../src/society/models";
const registry = new ModelRegistry();
registry.upsertProvider({
  id: "p1", name: "P1", kind: "openai-compatible", baseURL: "https://example.invalid/v1",
  apiKeyRef: "env:TEST_KEY", apiMode: "chat-completions", enabled: true,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
});
const mkProfile = (id: string, modelId: string, contextWindow: number, defaults = {}): ModelProfile => ({
  id, name: modelId, providerProfileId: "p1", modelId, contextWindow,
  contextWindowSource: "manual", capabilities: defaultCapabilities(),
  defaults, contextPolicyId: "policy-balanced-auto", enabled: true
});
it("model diagnostics becomes stale when provider, model or reasoning settings change", () => {
  const provider = registry.providerProfile("p1")!;
  const profile = mkProfile("mp-protocol", "model-protocol", 256_000, { reasoningEffort: "high" });
  profile.protocolCheck = {
    status: "passed",
    fingerprint: protocolCheckFingerprint(profile, provider),
    checkedAt: new Date().toISOString(),
    latencyMs: 12
  };
  assert.equal(effectiveProtocolCheck(profile, provider).status, "passed");
  assert.equal(isModelProtocolReady(profile, provider), true);
  assert.equal(effectiveProtocolCheck({ ...profile, modelId: "model-changed" }, provider).status, "stale");
  assert.equal(effectiveProtocolCheck({ ...profile, defaults: { reasoningEffort: "low" } }, provider).status, "stale");
  assert.equal(effectiveProtocolCheck(profile, { ...provider, apiMode: "responses" }).status, "stale");
  assert.equal(effectiveProtocolCheck({ ...profile, protocolCheck: undefined }, provider).status, "unknown");
});