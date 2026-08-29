/**
 * Model registry: providers, model profiles and context policies, with
 * JSON-file persistence for the non-secret parts. API keys never enter this
 * store — profiles reference them via `apiKeyRef` into the secure env layer.
 *
 * Environment variables remain the first-boot and headless compatibility
 * entry (`OPENAI_BASE_URL`, `SOCIETY_MODELS`, `SOCIETY_MODEL_CONTEXTS`): when
 * no persisted profile file exists, the registry seeds itself from them.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ContextPolicy, ModelProfile, ModelTuning, ProviderProfile } from "./contracts";
import { defaultCapabilities, defaultContextPolicy, DEFAULT_CONTEXT_POLICY_ID } from "./defaults";

export interface RegistryGlobalDefaults {
  modelProfileId?: string;
  tuning?: Partial<ModelTuning>;
  contextPolicyId?: string;
  /**
   * Default random-assignment pool: model-profile ids that clients (room
   * creation's 随机混合, the demo script) deal seats from when the user has
   * not picked a pool of their own. Empty/absent = no configured preference.
   */
  randomPoolProfileIds?: string[];
}

export interface ModelRegistryState {
  providers: ProviderProfile[];
  modelProfiles: ModelProfile[];
  contextPolicies: ContextPolicy[];
  globalDefaults: RegistryGlobalDefaults;
}

export class ModelRegistry {
  private providers = new Map<string, ProviderProfile>();
  private modelProfiles = new Map<string, ModelProfile>();
  private contextPolicies = new Map<string, ContextPolicy>();
  private global: RegistryGlobalDefaults = {};

  constructor(seed?: ModelRegistryState) {
    this.contextPolicies.set(DEFAULT_CONTEXT_POLICY_ID, defaultContextPolicy());
    if (seed) this.loadState(seed);
  }

  loadState(state: ModelRegistryState): void {
    for (const profile of state.providers) this.providers.set(profile.id, profile);
    for (const profile of state.modelProfiles) this.modelProfiles.set(profile.id, profile);
    for (const policy of state.contextPolicies) this.contextPolicies.set(policy.id, policy);
    this.global = { ...state.globalDefaults };
  }

  snapshot(): ModelRegistryState {
    return {
      providers: [...this.providers.values()].map((entry) => structuredClone(entry)),
      modelProfiles: [...this.modelProfiles.values()].map((entry) => structuredClone(entry)),
      contextPolicies: [...this.contextPolicies.values()].map((entry) => structuredClone(entry)),
      globalDefaults: structuredClone(this.global)
    };
  }

  providerProfile(id: string): ProviderProfile | undefined {
    return this.providers.get(id);
  }

  modelProfile(id: string): ModelProfile | undefined {
    return this.modelProfiles.get(id);
  }

  contextPolicy(id: string): ContextPolicy | undefined {
    return this.contextPolicies.get(id);
  }

  globalDefaults(): RegistryGlobalDefaults {
    return { ...this.global };
  }

  listProviders(): ProviderProfile[] {
    return [...this.providers.values()];
  }

  listModelProfiles(): ModelProfile[] {
    return [...this.modelProfiles.values()];
  }

  listContextPolicies(): ContextPolicy[] {
    return [...this.contextPolicies.values()];
  }

  setGlobalDefaults(defaults: RegistryGlobalDefaults): void {
    this.global = { ...this.global, ...defaults };
  }

  upsertProvider(profile: ProviderProfile): void {
    this.providers.set(profile.id, {
      ...profile,
      createdAt: this.providers.get(profile.id)?.createdAt ?? profile.createdAt,
      updatedAt: new Date().toISOString()
    });
  }

  upsertModelProfile(profile: ModelProfile): void {
    this.modelProfiles.set(profile.id, structuredClone(profile));
  }

  upsertContextPolicy(policy: ContextPolicy): void {
    this.contextPolicies.set(policy.id, structuredClone(policy));
  }

  removeProvider(id: string): void {
    for (const profile of this.modelProfiles.values()) {
      if (profile.providerProfileId === id) this.modelProfiles.delete(profile.id);
    }
    this.providers.delete(id);
  }

  removeModelProfile(id: string): void {
    this.modelProfiles.delete(id);
    // A removed profile cannot stay in the random pool: references are
    // pruned so the pool never points at a missing id.
    if (this.global.randomPoolProfileIds?.includes(id)) {
      this.global.randomPoolProfileIds = this.global.randomPoolProfileIds.filter((entry) => entry !== id);
    }
  }
}

export function defaultRegistryFile(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "data", "model-settings.json");
}

/** Load the persisted registry; returns a fresh default registry when absent. */
export function loadRegistry(file = defaultRegistryFile()): ModelRegistry {
  if (!existsSync(file)) return new ModelRegistry();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ModelRegistryState>;
    const state: ModelRegistryState = {
      providers: Array.isArray(raw.providers) ? raw.providers as ProviderProfile[] : [],
      modelProfiles: Array.isArray(raw.modelProfiles) ? raw.modelProfiles as ModelProfile[] : [],
      contextPolicies: Array.isArray(raw.contextPolicies) ? raw.contextPolicies as ContextPolicy[] : [],
      globalDefaults: raw.globalDefaults ?? {}
    };
    return new ModelRegistry(state);
  } catch {
    return new ModelRegistry();
  }
}

export function persistRegistry(registry: ModelRegistry, file = defaultRegistryFile()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const state = registry.snapshot();
  // Secrets must never reach this file even by accident.
  state.providers = state.providers.map((profile) => ({
    ...profile,
    ...(profile.apiKeyRef === undefined ? {} : { apiKeyRef: profile.apiKeyRef })
  }));
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    unlinkSync(temporary);
  } catch {
    // best-effort cleanup
  }
}

/**
 * First-boot compatibility seed from environment variables. The seeded
 * provider references `env:OPENAI_API_KEY`; the actual secret stays in the
 * process environment and is never copied into the registry file.
 */
export function seedRegistryFromEnv(registry: ModelRegistry, env: NodeJS.ProcessEnv = process.env): void {
  if (registry.listProviders().length > 0 || registry.listModelProfiles().length > 0) return;
  const baseURL = (env.OPENAI_BASE_URL ?? "").trim()
    .replace(/\/(chat\/completions|responses|models)\/?$/i, "")
    .replace(/\/$/, "");
  const modelIds = [...new Set((env.SOCIETY_MODELS ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
  if (!baseURL || !modelIds.length) return;

  const now = new Date().toISOString();
  const provider: ProviderProfile = {
    id: "provider-env",
    name: "环境变量提供商",
    kind: "openai-compatible",
    baseURL,
    apiKeyRef: "env:OPENAI_API_KEY",
    apiMode: "chat-completions",
    enabled: true,
    createdAt: now,
    updatedAt: now
  };
  registry.upsertProvider(provider);

  const contextMap = parseContextMap(env.SOCIETY_MODEL_CONTEXTS);
  modelIds.slice(0, 16).forEach((modelId, index) => {
    const contextWindow = contextMap.get(modelId) ?? 256_000;
    registry.upsertModelProfile({
      id: `model-env-${index + 1}`,
      name: modelId,
      providerProfileId: provider.id,
      modelId,
      contextWindow,
      contextWindowSource: contextMap.has(modelId) ? "manual" : "known-profile",
      capabilities: defaultCapabilities(),
      defaults: { reasoningEffort: "high" },
      contextPolicyId: DEFAULT_CONTEXT_POLICY_ID,
      enabled: true
    });
  });
}

function parseContextMap(value: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of (value ?? "").split(",")) {
    const [id, tokens] = entry.split(":");
    const parsed = Number(tokens);
    if (id && Number.isInteger(parsed) && parsed > 0) map.set(id.trim(), parsed);
  }
  return map;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
