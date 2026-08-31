import { createHash } from "node:crypto";
import type { ModelProfile, ModelProtocolCheck, ProviderProfile } from "./contracts";

const PROTOCOL_FINGERPRINT_VERSION = 1;

/** Stable and secret-free fingerprint of the settings that affect the protocol. */
export function protocolCheckFingerprint(profile: ModelProfile, provider: ProviderProfile): string {
  const payload = {
    version: PROTOCOL_FINGERPRINT_VERSION,
    providerProfileId: provider.id,
    providerKind: provider.kind,
    baseURL: provider.baseURL.trim().replace(/\/$/, ""),
    apiMode: provider.apiMode,
    modelId: profile.modelId,
    reasoningEffort: profile.defaults.reasoningEffort ?? null,
    reasoningSummary: profile.defaults.reasoningSummary ?? null
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Effective status: a previously passed/failed check becomes stale on config change. */
export function effectiveProtocolCheck(profile: ModelProfile, provider: ProviderProfile | undefined): ModelProtocolCheck {
  if (!provider) {
    return {
      status: "failed",
      fingerprint: "",
      errorCode: "PROVIDER_PROFILE_MISSING",
      message: "The model provider profile no longer exists."
    };
  }
  const fingerprint = protocolCheckFingerprint(profile, provider);
  const stored = profile.protocolCheck;
  if (!stored) return { status: "unknown", fingerprint };
  if (stored.fingerprint !== fingerprint) return { ...stored, status: "stale", fingerprint };
  return { ...stored, fingerprint };
}

export function isModelProtocolReady(profile: ModelProfile, provider: ProviderProfile | undefined): boolean {
  return profile.enabled && provider?.enabled === true && effectiveProtocolCheck(profile, provider).status === "passed";
}
