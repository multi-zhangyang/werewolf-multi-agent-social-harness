import express from "express";
import { z } from "zod";
import { defaultCapabilities, defaultContextPolicy, effectiveProtocolCheck, persistRegistry, type ContextPolicy, type ModelProfile } from "../../society/models";
import type { ServerContext } from "../context";
import { requireGlobalOperator } from "../auth";
import { writeEnvKey } from "../settings";
import { fetchRemoteModels } from "../probe";
import { resolveKeyRef, runModelProbe } from "../model-probe-service";
const contextLabel = (n: number) => Math.round(n / 1000) + "K";

export function registerConfigurationRoutes(app: express.Express, context: ServerContext) {
app.get("/api/model-config", (_request, response) => {
    response.json(publicModelConfig(context));
  });
app.get("/api/model-config/providers/:providerId/remote-models", (request, response) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    const provider = context.models.providerProfile(request.params.providerId);
    if (!provider) {
      response.status(404).json({ error: "PROVIDER_PROFILE_MISSING", message: "The requested provider does not exist." });
      return;
    }
    void fetchRemoteModels({ baseURL: provider.baseURL, apiKey: resolveKeyRef(provider.apiKeyRef) })
      .then((result) => response.status(result.ok ? 200 : 502).json(result))
      .catch(() => response.status(502).json({ ok: false, modelIds: [], message: "获取模型列表失败，请稍后重试。" }));
  });
app.post("/api/model-config/probe", (request, response, next) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    const probeInput = z.object({
      modelProfileId: z.string().min(1).max(120),
      reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional()
    }).strict().safeParse(request.body ?? {});
    if (!probeInput.success) {
      response.status(400).json({ error: "MODEL_TEST_INPUT_INVALID", message: "模型测试参数无效。" });
      return;
    }
    const profile = context.models.modelProfile(probeInput.data.modelProfileId);
    if (!profile) {
      response.status(404).json({ error: "MODEL_PROFILE_MISSING", message: "The requested model profile does not exist." });
      return;
    }
    const provider = context.models.providerProfile(profile.providerProfileId);
    if (!provider) {
      response.status(400).json({ error: "PROVIDER_PROFILE_MISSING", message: "The profile's provider does not exist." });
      return;
    }
    void runModelProbe(context, profile.id, probeInput.data.reasoningEffort)
      .then((result) => response.json(result))
      .catch(next);
  });
app.put("/api/model-config", (request, response, next) => {
    if (!requireGlobalOperator(request, response, context.auth)) return;
    try {
      const input = modelConfigSchema.parse(request.body ?? {});
      // The random pool may reference profiles registered now or created by
      // this same update; anything else is a typo and is rejected outright.
      const pool = input.globalDefaults?.randomPoolProfileIds;
      if (pool) {
        const known = new Set([
          ...context.models.listModelProfiles().map((profile) => profile.id),
          ...(input.modelProfiles ?? []).map((profile) => profile.id)
        ]);
        const unknown = pool.filter((id) => !known.has(id));
        if (unknown.length) {
          response.status(400).json({
            error: "MODEL_PROFILE_MISSING",
            message: `The random pool references unregistered model profiles: ${unknown.join(", ")}.`
          });
          return;
        }
      }
      const state = applyModelConfig(context, input);
      response.json(state);
    } catch (error) {
      next(error);
    }
  });
}
function sanitizeEnvName(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
}

const modelConfigSchema = z.object({
  globalDefaults: z.object({
    modelProfileId: z.string().min(1).max(120).optional(),
    contextPolicyId: z.string().min(1).max(120).optional(),
    /** Default random-assignment pool: model-profile ids, validated on apply. */
    randomPoolProfileIds: z.array(z.string().min(1).max(120)).max(16).optional()
  }).strict().optional(),
  providers: z.array(z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    kind: z.enum(["openai", "openai-compatible", "local", "custom"]),
    baseURL: z.string().min(1).max(500),
    /** Env-var reference; raw keys are never accepted here. */
    apiKeyRef: z.string().min(1).max(120).optional(),
    /** Optional one-time secret: written to .env.local under a managed env var. */
    apiKey: z.string().min(1).max(400).optional(),
    apiMode: z.enum(["responses", "chat-completions", "auto"]),
    enabled: z.boolean()
  }).strict()).optional(),
  removeProviderIds: z.array(z.string().min(1).max(120)).max(32).optional(),
  removeModelProfileIds: z.array(z.string().min(1).max(120)).max(64).optional(),
  modelProfiles: z.array(z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    providerProfileId: z.string().min(1).max(120),
    modelId: z.string().min(1).max(180),
    contextWindow: z.number().int().positive().max(100_000_000),
    enabled: z.boolean(),
    defaults: z.object({
      reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional()
    }).strict().optional(),
    capabilities: z.object({
      streaming: z.enum(["yes", "no", "unknown"]),
      tools: z.enum(["yes", "no", "unknown"]),
      parallelToolCalls: z.enum(["yes", "no", "unknown"]),
      reasoning: z.enum(["yes", "no", "unknown"]),
      reasoningSummary: z.enum(["yes", "no", "unknown"]),
      structuredOutput: z.enum(["yes", "no", "unknown"]),
      promptCaching: z.enum(["yes", "no", "unknown"]),
      nativeCompaction: z.enum(["yes", "no", "unknown"]),
      seed: z.enum(["yes", "no", "unknown"]),
      stopSequences: z.enum(["yes", "no", "unknown"]),
      imageInput: z.enum(["yes", "no", "unknown"]),
      maxOutputTokens: z.enum(["yes", "no", "unknown"])
    }).strict().optional()
  }).strict()).optional(),
  contextPolicies: z.array(z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    mode: z.enum(["automatic", "custom"]),
    watchRatio: z.number().min(0.1).max(0.98),
    retrievalTightRatio: z.number().min(0.1).max(0.98),
    softCompactRatio: z.number().min(0.1).max(0.98),
    deepCompactRatio: z.number().min(0.1).max(0.98),
    emergencyRatio: z.number().min(0.1).max(0.98),
    hardLimitRatio: z.number().min(0.1).max(0.98),
    targetAfterCompactionMin: z.number().min(0.1).max(0.98),
    targetAfterCompactionMax: z.number().min(0.1).max(0.98),
    recentTurnsToKeep: z.number().int().min(1).max(20),
    recentRawMessagesToKeep: z.number().int().min(1).max(100),
    recentToolResultsToKeep: z.number().int().min(1).max(100),
    maxRetrievedMemoryTokens: z.number().int().positive().max(1_000_000)
  }).strict()).optional()
}).strict();

function publicModelConfig(context: ServerContext): Record<string, unknown> {
  const providers = context.models.listProviders().map((profile) => ({
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    baseURL: profile.baseURL,
    apiMode: profile.apiMode,
    enabled: profile.enabled,
    hasKey: Boolean(resolveKeyRef(profile.apiKeyRef)),
    updatedAt: profile.updatedAt
  }));
  const modelProfiles = context.models.listModelProfiles().map((profile) => ({
    id: profile.id,
    name: profile.name,
    providerProfileId: profile.providerProfileId,
    modelId: profile.modelId,
    contextWindow: profile.contextWindow,
    contextWindowSource: profile.contextWindowSource,
    contextLabel: contextLabel(profile.contextWindow),
    capabilities: profile.capabilities,
    protocolCheck: effectiveProtocolCheck(profile, context.models.providerProfile(profile.providerProfileId)),
    defaults: profile.defaults,
    contextPolicyId: profile.contextPolicyId,
    enabled: profile.enabled
  }));
  return {
    providers,
    modelProfiles,
    contextPolicies: context.models.listContextPolicies(),
    globalDefaults: context.models.globalDefaults()
  };
}

function applyModelConfig(context: ServerContext, input: z.infer<typeof modelConfigSchema>): Record<string, unknown> {
  if (input.providers) {
    for (const update of input.providers) {
      const existing = context.models.providerProfile(update.id);
      let apiKeyRef = update.apiKeyRef ?? existing?.apiKeyRef;
      // A pasted secret is persisted into .env.local under a managed env var
      // and only the reference is kept — the registry file never sees keys.
      if (update.apiKey) {
        const envName = `SOCIETY_PROVIDER_${sanitizeEnvName(update.id)}_KEY`;
        writeEnvKey(envName, update.apiKey);
        apiKeyRef = `env:${envName}`;
      }
      context.models.upsertProvider({
        ...(existing ?? {
          kind: update.kind,
          createdAt: new Date().toISOString()
        }),
        id: update.id,
        name: update.name,
        baseURL: update.baseURL,
        apiMode: update.apiMode,
        enabled: update.enabled,
        ...(apiKeyRef ? { apiKeyRef } : {}),
        updatedAt: new Date().toISOString()
      });
    }
  }
  for (const id of input.removeProviderIds ?? []) context.models.removeProvider(id);
  for (const id of input.removeModelProfileIds ?? []) context.models.removeModelProfile(id);
  if (input.modelProfiles) {
    for (const update of input.modelProfiles) {
      const existing = context.models.modelProfile(update.id);
      const merged: ModelProfile = existing
        ? {
            ...existing,
            ...update,
            defaults: update.defaults
              ? mergeReasoningDefaults(existing.defaults, update.defaults)
              : existing.defaults
          }
        : {
            id: update.id,
            name: update.name,
            providerProfileId: update.providerProfileId,
            modelId: update.modelId,
            contextWindow: update.contextWindow,
            contextWindowSource: "manual",
            capabilities: defaultCapabilities(),
            defaults: update.defaults
              ? mergeReasoningDefaults({ reasoningEffort: "high" }, update.defaults)
              : { reasoningEffort: "high" },
            contextPolicyId: "policy-balanced-auto",
            enabled: update.enabled
          };
      context.models.upsertModelProfile(merged);
    }
  }
  if (input.contextPolicies) {
    for (const update of input.contextPolicies) {
      const existing = context.models.contextPolicy(update.id);
      const merged: ContextPolicy = {
        ...(existing ?? defaultContextPolicy()),
        ...update,
        reservedOutputTokens: existing?.reservedOutputTokens ?? "auto",
        reservedToolTokens: existing?.reservedToolTokens ?? "auto",
        safetyMarginTokens: existing?.safetyMarginTokens ?? "auto",
        compactionCooldownActivations: existing?.compactionCooldownActivations ?? 4,
        tokenizer: existing?.tokenizer ?? "heuristic",
        heuristicSafetyMultiplier: existing?.heuristicSafetyMultiplier ?? 1.15,
        useNativeCompaction: existing?.useNativeCompaction ?? "auto",
        verifyPinnedFacts: existing?.verifyPinnedFacts ?? true,
        consolidateDuringIdle: existing?.consolidateDuringIdle ?? true
      };
      context.models.upsertContextPolicy(merged);
    }
  }
  if (input.globalDefaults) {
    const requestedDefault = input.globalDefaults.modelProfileId;
    if (requestedDefault && !context.models.modelProfile(requestedDefault)?.enabled) throw new Error("默认模型不存在或未启用");
    const readyPool = input.globalDefaults.randomPoolProfileIds?.filter((id) => {
      const profile = context.models.modelProfile(id);
      return Boolean(profile?.enabled && context.models.providerProfile(profile.providerProfileId)?.enabled);
    });
    context.models.setGlobalDefaults({
      ...input.globalDefaults,
      ...(readyPool ? { randomPoolProfileIds: readyPool } : {})
    });
  }
  persistRegistry(context.models, context.modelRegistryFile, context.storage);
  return publicModelConfig(context);
}

function mergeReasoningDefaults(
  current: ModelProfile["defaults"],
  update: { reasoningEffort?: "low" | "medium" | "high" | "xhigh" }
): ModelProfile["defaults"] {
  const next = { ...current };
  if (update.reasoningEffort) next.reasoningEffort = update.reasoningEffort;
  else delete next.reasoningEffort;
  return next;
}
