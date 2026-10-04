import { probeAgentProtocol, probeCapabilityResult, type CapabilityProbeResult, type ProbeReasoningEffort, type ProtocolProbeResult } from './probe';
import { persistRegistry, protocolCheckFingerprint } from '../society/models';
import type { ServerContext } from './context';
export interface ModelProbeReport { ok: boolean; message: string; capability: CapabilityProbeResult; protocol: ProtocolProbeResult; }
export async function runModelProbe(context: ServerContext, id: string, requested?: ProbeReasoningEffort): Promise<ModelProbeReport> {
  const profile = context.models.modelProfile(id);
  if (!profile?.enabled) throw new Error('模型未启用');
  const provider = context.models.providerProfile(profile.providerProfileId);
  if (!provider?.enabled) throw new Error('提供商未启用');
  const effort = requested ?? profile.defaults.reasoningEffort as ProbeReasoningEffort | undefined;
  const protocol = await probeAgentProtocol({ baseURL: provider.baseURL, apiKey: resolveKeyRef(provider.apiKeyRef), apiMode: provider.apiMode, modelId: profile.modelId, fingerprint: protocolCheckFingerprint(profile, provider), reasoningEffort: effort });
  const capability = probeCapabilityResult(protocol, effort);
  const capabilities = { ...profile.capabilities };
  if (protocol.ok) { capabilities.tools = 'yes'; if (effort) capabilities.reasoning = 'yes'; }
  context.models.upsertModelProfile({ ...profile, capabilities, protocolCheck: protocol.check });
  persistRegistry(context.models, context.modelRegistryFile, context.storage);
  return { ok: protocol.ok, message: protocol.message, capability, protocol };
}
export function resolveKeyRef(ref: string | undefined) { return ref?.startsWith('env:') ? process.env[ref.slice(4)] ?? '' : process.env.OPENAI_API_KEY ?? ''; }
