/**
 * Model-config resolution checks. Verifies the precedence chain:
 * system < model-profile < global < room < agent < phase, capability
 * negotiation, and context-budget arithmetic.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import {
  ModelRegistry,
  defaultCapabilities,
  defaultContextPolicy,
  negotiateTuning,
  resolveAgentModelConfig,
  type ModelProfile
} from "../../src/society/models";

function check(name: string, fn: () => void): void {
  it(name, fn);
}

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
registry.upsertModelProfile(mkProfile("mp-a", "model-a", 256_000, { temperature: 0.7, reasoningEffort: "medium" }));
registry.upsertModelProfile(mkProfile("mp-b", "model-b", 1_000_000, { temperature: 0.2, reasoningEffort: "low" }));
registry.upsertContextPolicy(defaultContextPolicy());

const lookup = {
  modelProfile: (id: string) => registry.modelProfile(id),
  providerProfile: (id: string) => registry.providerProfile(id),
  contextPolicy: (id: string) => registry.contextPolicy(id),
  firstModelProfile: () => registry.listModelProfiles().find((p) => p.enabled)
};

check("no binding resolves to first enabled profile (system fallback)", () => {
  const resolved = resolveAgentModelConfig({ agentId: "a1", lookup });
  assert.equal(resolved.modelId, "model-a");
  assert.equal(resolved.tuning.temperature?.source, "model-profile");
  assert.equal(resolved.tuning.reasoningEffort?.value, "medium");
});

check("a binding to a disabled profile is refused loudly, never resolved", () => {
  registry.upsertModelProfile({ ...mkProfile("mp-disabled", "model-x", 256_000), enabled: false });
  assert.throws(
    () => resolveAgentModelConfig({
      agentId: "a3", lookup,
      binding: { defaultModelProfileId: "mp-disabled" }
    }),
    /MODEL_PROFILE_DISABLED/
  );
  assert.throws(
    () => resolveAgentModelConfig({
      agentId: "a4", lookup,
      globalDefaults: { modelProfileId: "mp-disabled" }
    }),
    /MODEL_PROFILE_DISABLED/,
    "a disabled global default is refused too"
  );
});

check("a binding to an enabled profile resolves it", () => {
  const resolved = resolveAgentModelConfig({
    agentId: "a5", lookup,
    binding: { defaultModelProfileId: "mp-b" }
  });
  assert.equal(resolved.modelId, "model-b");
});

check("global defaults override model profile defaults", () => {
  const resolved = resolveAgentModelConfig({
    agentId: "a2", lookup,
    globalDefaults: { modelProfileId: "mp-b", tuning: { temperature: 0.9 } }
  });
  assert.equal(resolved.modelId, "model-b");
  assert.equal(resolved.tuning.temperature?.value, 0.9);
  assert.equal(resolved.tuning.temperature?.source, "global");
  assert.equal(resolved.tuning.reasoningEffort?.value, "low");
});

check("room overrides beat global", () => {
  const resolved = resolveAgentModelConfig({
    agentId: "a3", lookup,
    globalDefaults: { modelProfileId: "mp-b", tuning: { temperature: 0.9 } },
    roomDefaults: { modelProfileId: "mp-a", tuning: { temperature: 0.5 } }
  });
  assert.equal(resolved.modelId, "model-a");
  assert.equal(resolved.tuning.temperature?.value, 0.5);
  assert.equal(resolved.tuning.temperature?.source, "room");
});

check("agent binding beats room, phase override beats agent", () => {
  const resolved = resolveAgentModelConfig({
    agentId: "a4", lookup,
    roomDefaults: { modelProfileId: "mp-a" },
    binding: {
      defaultModelProfileId: "mp-b",
      tuningOverrides: { temperature: 0.3 },
      phaseOverrides: { plan: { modelProfileId: "mp-a", tuning: { temperature: 0.1 } } }
    },
    phase: "plan"
  });
  assert.equal(resolved.modelId, "model-a");
  assert.equal(resolved.tuning.temperature?.value, 0.1);
  assert.equal(resolved.tuning.temperature?.source, "phase");
});

check("budget subtracts output/tool/system reserves and safety margin", () => {
  const resolved = resolveAgentModelConfig({ agentId: "a5", lookup });
  assert.equal(resolved.contextWindow, 256_000);
  assert.ok(resolved.usableInputTokens < resolved.contextWindow);
  assert.ok(resolved.usableInputTokens > 0);
  assert.equal(
    resolved.usableInputTokens,
    resolved.contextWindow
      - resolved.reservedOutputTokens
      - resolved.reservedToolTokens
      - resolved.reservedSystemTokens
      - resolved.safetyMarginTokens
  );
});

check("capability negotiation drops unknown-gated fields and keeps passthrough", () => {
  const result = negotiateTuning(
    { temperature: 0.5, seed: 42, stop: ["x"], maxOutputTokens: 1000, reasoningEffort: "high", verbosity: "low" },
    defaultCapabilities()
  );
  assert.equal(result.allowed.temperature, 0.5);
  assert.equal(result.allowed.verbosity, "low");
  assert.equal(result.allowed.seed, undefined);
  assert.equal(result.allowed.maxOutputTokens, undefined);
  assert.ok(result.dropped.some((entry) => entry.field === "seed"));
  assert.ok(result.dropped.some((entry) => entry.field === "maxOutputTokens" && entry.reason === "local-only-not-transmitted"));
});

check("max output is local-only: never sent, even when capable and forced", () => {
  const capable = defaultCapabilities();
  capable.maxOutputTokens = "yes";
  const result = negotiateTuning({ maxOutputTokens: 800 }, capable, new Set(["maxOutputTokens"]));
  assert.equal(result.allowed.maxOutputTokens, undefined);
  assert.ok(result.dropped.some((entry) => entry.field === "maxOutputTokens" && entry.reason === "local-only-not-transmitted"));
});

check("capability negotiation sends unknown fields only when forced", () => {
  const result = negotiateTuning({ seed: 7, maxOutputTokens: 400 }, defaultCapabilities(), new Set(["seed"]));
  assert.equal(result.allowed.seed, 7);
  assert.equal(result.allowed.maxOutputTokens, undefined);
  assert.ok(result.dropped.some((entry) => entry.field === "seed" && entry.reason === "unknown-capability-forced"));
});

check("missing model profile raises a clear error instead of guessing", () => {
  assert.throws(
    () => resolveAgentModelConfig({
      agentId: "a6",
      lookup: {
        modelProfile: () => undefined,
        providerProfile: () => undefined,
        contextPolicy: () => undefined,
        firstModelProfile: () => undefined
      }
    }),
    /MODEL_PROFILE_MISSING/
  );
});