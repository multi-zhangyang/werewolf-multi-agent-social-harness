import {
  mergeProbeResult,
  probeAgentProtocol,
  probeCapabilities,
  type CapabilityProbeResult,
  type ProbeReasoningEffort,
  type ProtocolProbeResult
} from "./probe";
import { persistRegistry, protocolCheckFingerprint } from "../society/models";
import type { ServerContext } from "./context";

export interface ModelProbeReport {
  ok: boolean;
  message: string;
  capability: CapabilityProbeResult;
  protocol: ProtocolProbeResult;
}

/** Shared real probe used by both the HTTP endpoint and `npm run doctor`. */
export async function runModelProbe(
  context: ServerContext,
  modelProfileId: string,
  reasoningEffort?: ProbeReasoningEffort
): Promise<ModelProbeReport> {
  const profile = context.models.modelProfile(modelProfileId);
  if (!profile) throw codedError("MODEL_PROFILE_MISSING", "The requested model profile does not exist.");
  const provider = context.models.providerProfile(profile.providerProfileId);
  if (!provider) throw codedError("PROVIDER_PROFILE_MISSING", "The profile's provider does not exist.");
  if (!profile.enabled || !provider.enabled) {
    throw codedError("MODEL_PROFILE_DISABLED", "Only enabled models on enabled providers can be checked.");
  }

  const capability = await probeCapabilities({
    baseURL: provider.baseURL,
    apiKey: resolveKeyRef(provider.apiKeyRef),
    modelId: profile.modelId,
    reasoningEffort
  });
  const effectiveEffort = capability.effectiveReasoningEffort === "provider-default"
    ? undefined
    : capability.effectiveReasoningEffort;
  const protocol = await probeAgentProtocol({
    baseURL: provider.baseURL,
    apiKey: resolveKeyRef(provider.apiKeyRef),
    apiMode: provider.apiMode,
    modelId: profile.modelId,
    fingerprint: protocolCheckFingerprint(profile, provider),
    ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}),
    timeoutMs: Number(process.env.SOCIETY_MODEL_PROTOCOL_TIMEOUT_MS)
  });
  const admissionProtocol: ProtocolProbeResult = capability.ok
    ? protocol
    : {
        ...protocol,
        ok: false,
        message: `基础 capability 检查未通过：${capability.message}`,
        check: {
          ...protocol.check,
          status: "failed",
          errorCode: "CAPABILITY_CHECK_FAILED",
          message: capability.message
        }
      };
  const merged = {
    ...profile,
    capabilities: mergeProbeResult(profile.capabilities, capability.capabilities),
    protocolCheck: admissionProtocol.check
  };
  context.models.upsertModelProfile(merged);
  persistRegistry(context.models, context.modelRegistryFile, context.storage);
  return {
    ok: capability.ok && admissionProtocol.ok,
    message: admissionProtocol.ok ? capability.message : admissionProtocol.message,
    capability: { ...capability, capabilities: merged.capabilities },
    protocol: admissionProtocol
  };
}

export function resolveKeyRef(ref: string | undefined): string {
  if (!ref) return process.env.OPENAI_API_KEY ?? "";
  if (ref.startsWith("env:")) return process.env[ref.slice(4)] ?? "";
  return "";
}

function codedError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  (error as Error & { code?: string }).code = code;
  return error;
}
