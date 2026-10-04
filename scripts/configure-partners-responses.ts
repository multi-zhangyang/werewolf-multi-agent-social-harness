import { loadRegistry, persistRegistry } from "../src/society/models/registry";
import { protocolCheckFingerprint } from "../src/society/models/protocol-check";
import { defaultCapabilities } from "../src/society/models/defaults";
import { partnerContextWindow, partnerModelId } from "../src/partners/agent";
import { readFileSync } from "node:fs";

const registry = loadRegistry();
const previous = registry.providerProfile("cardinalize");
if (!previous?.apiKeyRef) throw new Error("Existing Cardinalize credential reference missing");
const now = new Date().toISOString();
const provider = { ...previous, id: "cardinalize-responses", name: "Cardinalize Responses", apiMode: "responses" as const,
  createdAt: now, updatedAt: now, enabled: true };
registry.upsertProvider(provider);
const handshake = JSON.parse(readFileSync("data/partners-responses-rebuild-1791051337508/responses-handshake.json", "utf8"));
if (!handshake.verified || handshake.model !== partnerModelId || handshake.apiMode !== "responses") throw new Error("Responses handshake not verified");
const profile = { id: "gpt-6-luna", name: partnerModelId, providerProfileId: provider.id, modelId: partnerModelId,
  contextWindow: partnerContextWindow, contextWindowSource: "manual" as const, capabilities: { ...defaultCapabilities(), streaming: "yes" as const,
    tools: "yes" as const, reasoning: "yes" as const, maxOutputTokens: "yes" as const },
  defaults: { reasoningEffort: "low" as const, requestTimeoutMs: 120000, store: false,
    truncation: "disabled" as const, parallelToolCalls: false }, contextPolicyId: "policy-balanced-auto", enabled: true };
registry.upsertModelProfile({ ...profile, protocolCheck: { status: "passed", fingerprint: protocolCheckFingerprint(profile, provider),
  checkedAt: now, latencyMs: handshake.durationMs, message: "官方 Agents SDK Responses 两次工具调用与 call_id 回执核验通过" } });
for (const other of registry.listModelProfiles()) if (other.id !== profile.id && other.enabled) registry.upsertModelProfile({ ...other, enabled: false });
registry.setGlobalDefaults({ modelProfileId: profile.id, randomPoolProfileIds: [profile.id],
  tuning: { reasoningEffort: "low", store: false, parallelToolCalls: false, truncation: "disabled" } });
persistRegistry(registry);
console.log(JSON.stringify({ model: partnerModelId, contextWindow: partnerContextWindow, apiMode: provider.apiMode, profileId: profile.id }));
