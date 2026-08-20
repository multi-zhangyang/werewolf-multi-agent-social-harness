import { createHash } from "node:crypto";
import type { Tool } from "@openai/agents";
import type { AgentProfile } from "../contracts";
import type { ResolvedModelConfig } from "../models/contracts";
import type { StrategyProfileSnapshot } from "./contracts";

export function createStrategyProfileSnapshot(input: {
  profile: AgentProfile;
  resolvedConfig: ResolvedModelConfig;
  tools: Tool<unknown>[];
  promptInstructions: string[];
}): StrategyProfileSnapshot {
  const promptInstructions = input.promptInstructions.map((entry) => entry.trim()).filter(Boolean);
  const requestedEffort = input.resolvedConfig.tuning.reasoningEffort?.value ?? "provider-default";
  const core = {
    actorId: input.profile.id,
    characterId: input.profile.characterId,
    modelConfig: {
      modelProfileId: input.resolvedConfig.modelProfileId,
      modelId: input.resolvedConfig.modelId,
      providerProfileId: input.resolvedConfig.providerProfileId,
      contextWindow: input.resolvedConfig.contextWindow,
      usableInputTokens: input.resolvedConfig.usableInputTokens,
      tuning: jsonRecord(input.resolvedConfig.tuning) as Record<string, { value: unknown; source: string }>,
      capabilities: structuredClone(input.resolvedConfig.capabilities),
      negotiationNotes: [...input.resolvedConfig.negotiationNotes]
    },
    persona: {
      text: input.profile.persona,
      decisionBiases: [...(input.profile.decisionBiases ?? [])],
      ...(input.profile.voice ? { voice: input.profile.voice } : {}),
      autobiographicalAnchors: [...(input.profile.autobiographicalAnchors ?? [])]
    },
    promptPolicy: {
      id: "society-participant-protocol",
      version: "social-causality-v1",
      instructions: promptInstructions,
      instructionsHash: sha256(stableJson(promptInstructions))
    },
    contextPolicy: structuredClone(input.resolvedConfig.contextPolicy),
    toolSchemas: input.tools
      .filter((entry): entry is Extract<typeof entry, { type: "function" }> => entry.type === "function")
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        parameters: jsonRecord(entry.parameters),
        strict: entry.strict
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    strategyVersion: "bounded-intent-v1",
    reasoningFallback: {
      requestedEffort,
      order: requestedEffort === "xhigh"
        ? ["xhigh", "high", "provider-default"] as const
        : requestedEffort === "high"
          ? ["high", "provider-default"] as const
          : ["provider-default"] as const,
      downgradeOnlyOnCapabilityError: true as const,
      notifyOnDowngradeOrFailure: true as const
    },
    schemaVersion: 1
  };
  const configurationHash = sha256(stableJson(core));
  return {
    strategyProfileSnapshotId: `strategy-profile-${configurationHash.slice(0, 24)}`,
    ...core,
    reasoningFallback: {
      ...core.reasoningFallback,
      order: [...core.reasoningFallback.order]
    },
    configurationHash,
    createdAtLogical: 0,
    createdAt: new Date().toISOString()
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (!serialized) return {};
  const parsed = JSON.parse(serialized) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
