import { SocialEpisodeExposureInput } from "./falseClaimBelief";
import { Role } from "../../core/types";
import { harnessFailureEvidenceFromEpisode } from "../executionEvidence";
import { SocialExposureRecord, SocialMessage } from "../social";
import { AgentReward, HarnessMetricEvidenceRef, HarnessMetricRecord } from "../types";
export function socialEpisodeExposureInput(socialEpisode?: unknown): SocialEpisodeExposureInput | undefined {
  if (!socialEpisode || typeof socialEpisode !== "object") return undefined;
  const candidate = socialEpisode as Partial<SocialEpisodeExposureInput>;
  if (!Array.isArray(candidate.steps) || !Array.isArray(candidate.messages)) return undefined;
  const messages = candidate.messages.filter(isSocialMessage);
  if (messages.length !== candidate.messages.length) return undefined;
  return {
    steps: candidate.steps,
    messages
  };
}

export function groupFalseClaimExposureRecordsByObserver(records: SocialExposureRecord[]): Map<string, SocialExposureRecord[]> {
  const grouped = new Map<string, SocialExposureRecord[]>();
  for (const record of records) {
    grouped.set(record.observerId, [...(grouped.get(record.observerId) ?? []), record]);
  }
  return grouped;
}

function isSocialMessage(value: unknown): value is SocialMessage {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.seq === "number" &&
      typeof record.channelId === "string" &&
      typeof record.senderId === "string" &&
      Array.isArray(record.recipientIds) &&
      typeof record.visibility === "string" &&
      typeof record.content === "string" &&
      typeof record.createdAt === "string"
  );
}

const WEREWOLF_ROLE_VALUES = new Set<Role>(["villager", "werewolf", "seer", "witch", "hunter"]);

export function roleMetadata(value: unknown): Role | undefined {
  return typeof value === "string" && WEREWOLF_ROLE_VALUES.has(value as Role) ? (value as Role) : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function payloadPlayerId(payload: unknown): string | undefined {
  return typeof payload === "object" && payload && "playerId" in payload ? String(payload.playerId) : undefined;
}

export function payloadPressureTargetId(payload: unknown): string | undefined {
  return typeof payload === "object" && payload && "pressureTargetId" in payload ? String(payload.pressureTargetId) : undefined;
}

export function payloadClaimedRole(payload: unknown): string | undefined {
  return typeof payload === "object" && payload && "claimedRole" in payload ? String(payload.claimedRole) : undefined;
}

export function stateEvidence(
  description: string,
  options?: {
    id?: string;
    description?: string;
  }
): HarnessMetricEvidenceRef {
  return {
    artifact: "state",
    id: options?.id,
    description: options?.description ?? description
  };
}

export function uniqueEvidenceRefs(refs: HarnessMetricEvidenceRef[]): HarnessMetricEvidenceRef[] {
  const seen = new Set<string>();
  const unique: HarnessMetricEvidenceRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function sampleIds(ids: string[]): string[] {
  return ids.slice(0, 20);
}

export function sumMetricMetadata(metrics: HarnessMetricRecord[], key: string): number {
  return metrics.reduce((sum, item) => {
    const value = item.metadata?.[key];
    return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

export function agentSubject(reward: AgentReward): Record<string, unknown> {
  return {
    playerId: reward.playerId,
    profileId: reward.profileId,
    model: reward.model,
    role: reward.role,
    team: reward.team
  };
}

export function countHarnessErrors(socialEpisode: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const failure of harnessFailureEvidenceFromEpisode(socialEpisode)) {
    const playerId = failure.actorId ?? "unknown";
    counts[playerId] = (counts[playerId] ?? 0) + 1;
  }
  return counts;
}

export function averageReward(rewards: AgentReward[]): number {
  if (!rewards.length) return 0;
  return round3(rewards.reduce((sum, reward) => sum + reward.reward, 0) / rewards.length);
}

export function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function ratio(numerator: number, denominator: number): number {
  return denominator ? round3(numerator / denominator) : 0;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function signedScoreToProbability(value: number): number {
  return round3((Math.min(1, Math.max(-1, value)) + 1) / 2);
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
