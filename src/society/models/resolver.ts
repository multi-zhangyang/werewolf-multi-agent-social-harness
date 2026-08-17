/**
 * Final-configuration resolver. Precedence (low → high):
 *
 *   system safety defaults
 *   < ModelProfile defaults
 *   < global agent defaults
 *   < world/room overrides
 *   < per-agent overrides
 *   < cognitive-phase overrides
 *   < runtime safety limits
 *
 * Every resolved field records its source so the create-room UI can show the
 * effective configuration instead of making the user guess the inheritance.
 */
import type {
  AgentModelBinding,
  CognitivePhase,
  ContextPolicy,
  ModelProfile,
  ModelTuning,
  ProviderProfile,
  ResolvedField,
  ResolvedFieldSource,
  ResolvedModelConfig,
  ResolvedTuning,
  RuntimeSafetyLimits
} from "./contracts";
import { negotiateTuning } from "./capabilities";
import { autoReservedTokens, defaultSafetyLimits } from "./defaults";

export interface ModelResolutionInput {
  agentId: string;
  /** Per-agent binding; may be absent when the agent inherits everything. */
  binding?: AgentModelBinding;
  /** Room-wide defaults (the create-room "统一模型" setting). */
  roomDefaults?: { modelProfileId?: string; tuning?: Partial<ModelTuning>; contextPolicyId?: string };
  /** Global agent defaults (the settings-page default for new rooms). */
  globalDefaults?: { modelProfileId?: string; tuning?: Partial<ModelTuning>; contextPolicyId?: string };
  phase?: CognitivePhase;
  /** Registry lookups. */
  lookup: {
    modelProfile(id: string): ModelProfile | undefined;
    providerProfile(id: string): ProviderProfile | undefined;
    contextPolicy(id: string): ContextPolicy | undefined;
    /** First enabled profile, used only when nothing else resolves. */
    firstModelProfile(): ModelProfile | undefined;
  };
  safety?: RuntimeSafetyLimits;
  /** Capability fields the user explicitly forces despite "unknown". */
  forcedCapabilities?: ReadonlySet<string>;
}

export function resolveAgentModelConfig(input: ModelResolutionInput): ResolvedModelConfig {
  const safety = input.safety ?? defaultSafetyLimits();

  // 1. Model profile: agent phase override > agent binding > room > global > first enabled profile.
  const profileId =
    input.binding?.phaseOverrides?.[input.phase ?? "act"]?.modelProfileId ??
    input.binding?.defaultModelProfileId ??
    input.roomDefaults?.modelProfileId ??
    input.globalDefaults?.modelProfileId;
  const modelProfile = input.lookup.modelProfile(profileId ?? "") ?? input.lookup.firstModelProfile();
  if (!modelProfile) {
    throw new Error(`MODEL_PROFILE_MISSING: No model profile is resolvable for '${input.agentId}'. Configure at least one enabled model profile.`);
  }
  const provider = input.lookup.providerProfile(modelProfile.providerProfileId);
  if (!provider) {
    throw new Error(`PROVIDER_PROFILE_MISSING: Provider '${modelProfile.providerProfileId}' for model '${modelProfile.modelId}' does not exist.`);
  }

  // 2. Tuning merge.
  const merged: ModelTuning = {
    ...modelProfile.defaults,
    ...input.globalDefaults?.tuning,
    ...input.roomDefaults?.tuning,
    ...input.binding?.tuningOverrides,
    ...input.binding?.phaseOverrides?.[input.phase ?? "act"]?.tuning
  };
  const tuning = resolveTuning(
    merged,
    modelProfile.defaults,
    input.globalDefaults?.tuning,
    input.roomDefaults?.tuning,
    input.binding?.tuningOverrides,
    input.binding?.phaseOverrides?.[input.phase ?? "act"]?.tuning
  );

  // 3. Context policy: agent > room > global > model-profile default > system.
  const policy = resolveContextPolicy(input, modelProfile);

  // 4. Budget: window − reserves − safety margin. Runtime safety clamps the
  //    window floor and caps output budgets.
  const contextWindow = Math.max(modelProfile.contextWindow, safety.minContextWindow);
  const reserves = resolveReserves(policy, contextWindow);
  let usableInputTokens = Math.max(
    0,
    contextWindow - reserves.reservedOutputTokens - reserves.reservedToolTokens - reserves.reservedSystemTokens - reserves.safetyMarginTokens
  );
  if (modelProfile.maxUsableInputTokens !== undefined) {
    usableInputTokens = Math.min(usableInputTokens, modelProfile.maxUsableInputTokens);
  }
  usableInputTokens = Math.max(0, usableInputTokens);

  // 5. Capability negotiation for the SDK-facing model settings.
  const negotiation = negotiateTuning(merged, modelProfile.capabilities, input.forcedCapabilities);
  const sdkModelSettings: Record<string, unknown> = { ...negotiation.allowed };
  // Runtime plumbing fields never reach the provider as model settings.
  delete (sdkModelSettings as Record<string, unknown>).maxTurns;
  delete (sdkModelSettings as Record<string, unknown>).requestTimeoutMs;
  delete (sdkModelSettings as Record<string, unknown>).retryMaxAttempts;
  delete (sdkModelSettings as Record<string, unknown>).retryInitialDelayMs;
  delete (sdkModelSettings as Record<string, unknown>).promptCacheRetention;
  delete (sdkModelSettings as Record<string, unknown>).providerData;

  const negotiationNotes = negotiation.dropped.map((entry) =>
    `${entry.field}: ${entry.reason === "unsupported-by-provider" ? "提供商不支持" : entry.reason === "unknown-capability-forced" ? "能力未验证（用户强制发送）" : "能力未验证（未发送）"}`
  );

  return {
    agentId: input.agentId,
    modelProfileId: modelProfile.id,
    modelId: modelProfile.modelId,
    providerProfileId: provider.id,
    contextWindow,
    contextWindowSource: modelProfile.contextWindowSource,
    usableInputTokens,
    reservedOutputTokens: reserves.reservedOutputTokens,
    reservedToolTokens: reserves.reservedToolTokens,
    reservedSystemTokens: reserves.reservedSystemTokens,
    safetyMarginTokens: reserves.safetyMarginTokens,
    tuning,
    sdkModelSettings,
    contextPolicy: policy,
    capabilities: modelProfile.capabilities,
    negotiationNotes
  };
}

function resolveTuning(
  merged: ModelTuning,
  modelDefaults: ModelTuning,
  global?: Partial<ModelTuning>,
  room?: Partial<ModelTuning>,
  agent?: Partial<ModelTuning>,
  phase?: Partial<ModelTuning>
): ResolvedTuning {
  const result: ResolvedTuning = {};
  const fields = new Set<keyof ModelTuning>([
    ...Object.keys(merged) as Array<keyof ModelTuning>
  ]);
  for (const field of fields) {
    const value = merged[field];
    if (value === undefined) continue;
    const source: ResolvedFieldSource =
      phase && field in phase ? "phase"
        : agent && field in agent ? "agent"
          : room && field in room ? "room"
            : global && field in global ? "global"
              : field in modelDefaults ? "model-profile"
                : "system";
    (result as Record<string, unknown>)[field as string] = { value, source } as ResolvedField<never>;
  }
  return result;
}

function resolveContextPolicy(input: ModelResolutionInput, modelProfile: ModelProfile): ContextPolicy {
  const binding = input.binding;
  const candidate = {
    base: binding?.contextPolicyId ?? input.roomDefaults?.contextPolicyId ?? input.globalDefaults?.contextPolicyId ?? modelProfile.contextPolicyId,
    source: "model-profile" as ResolvedFieldSource
  };
  if (binding?.contextPolicyId) candidate.source = "agent";
  else if (input.roomDefaults?.contextPolicyId) candidate.source = "room";
  else if (input.globalDefaults?.contextPolicyId) candidate.source = "global";

  const base = input.lookup.contextPolicy(candidate.base);
  if (!base) {
    throw new Error(`CONTEXT_POLICY_MISSING: Context policy '${candidate.base}' does not exist.`);
  }
  const overrides = binding?.contextOverrides ?? {};
  const resolved: ContextPolicy = { ...base, ...overrides, id: base.id };
  // Clamp ratios into a sane ordering; runtime safety wins over misconfig.
  resolved.watchRatio = clampOrdered(resolved, "watchRatio");
  resolved.retrievalTightRatio = clampOrdered(resolved, "retrievalTightRatio");
  resolved.softCompactRatio = clampOrdered(resolved, "softCompactRatio");
  resolved.deepCompactRatio = clampOrdered(resolved, "deepCompactRatio");
  resolved.emergencyRatio = clampOrdered(resolved, "emergencyRatio");
  resolved.hardLimitRatio = clampOrdered(resolved, "hardLimitRatio");
  return resolved;
}

function clampOrdered(policy: ContextPolicy, field: keyof ContextPolicy): number {
  const value = Number(policy[field]);
  return Number.isFinite(value) ? Math.max(0.1, Math.min(0.98, value)) : 0.75;
}

function resolveReserves(policy: ContextPolicy, contextWindow: number): {
  reservedOutputTokens: number;
  reservedToolTokens: number;
  reservedSystemTokens: number;
  safetyMarginTokens: number;
} {
  const auto = autoReservedTokens(contextWindow);
  const asNumber = (value: number | "auto", fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    reservedOutputTokens: asNumber(policy.reservedOutputTokens, auto.reservedOutputTokens),
    reservedToolTokens: asNumber(policy.reservedToolTokens, auto.reservedToolTokens),
    reservedSystemTokens: auto.reservedSystemTokens,
    safetyMarginTokens: asNumber(policy.safetyMarginTokens, auto.safetyMarginTokens)
  };
}