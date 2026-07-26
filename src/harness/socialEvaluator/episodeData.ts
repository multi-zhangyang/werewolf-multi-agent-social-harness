import { type SocialMessageIndex } from "./factIngest";
import { deriveSocialExposureRecords, type SocialEpisodeArtifact, type SocialExposureRecord, type SocialMessage, type SocialSpeechAct } from "../social";
type SocialEpisodeExposureInput = Pick<SocialEpisodeArtifact<unknown, unknown, unknown, unknown>, "steps" | "messages">;

export function exposureRecordsFromSocialEpisode(socialEpisode?: unknown): SocialExposureRecord[] {
  const materialized = materializedExposureRecordsFromSocialEpisode(socialEpisode);
  if (materialized) return materialized;
  const exposureInput = socialEpisodeExposureInput(socialEpisode);
  return exposureInput ? deriveSocialExposureRecords(exposureInput) : [];
}

function materializedExposureRecordsFromSocialEpisode(socialEpisode?: unknown): SocialExposureRecord[] | undefined {
  if (!socialEpisode || typeof socialEpisode !== "object") return undefined;
  const candidate = socialEpisode as { exposureRecords?: unknown };
  if (!Array.isArray(candidate.exposureRecords)) return undefined;
  return candidate.exposureRecords.filter(isSocialExposureRecord);
}

function socialEpisodeExposureInput(socialEpisode?: unknown): SocialEpisodeExposureInput | undefined {
  if (!socialEpisode || typeof socialEpisode !== "object") return undefined;
  const candidate = socialEpisode as Partial<SocialEpisodeExposureInput>;
  if (!Array.isArray(candidate.steps) || !Array.isArray(candidate.messages)) return undefined;
  return {
    steps: candidate.steps,
    messages: candidate.messages
  };
}

export function messagesFromSocialEpisode(socialEpisode?: unknown): SocialMessage[] {
  if (!socialEpisode || typeof socialEpisode !== "object") return [];
  const candidate = socialEpisode as { messages?: unknown };
  return Array.isArray(candidate.messages) ? candidate.messages.filter(isSocialMessageForEvaluation) : [];
}

export function socialMessageIndex(messages: SocialMessage[]): SocialMessageIndex {
  return {
    byId: new Map(messages.map((message) => [message.id, message])),
    bySeq: new Map(messages.map((message) => [message.seq, message]))
  };
}

export function groupExposureRecordsByObserver(records: SocialExposureRecord[]): Map<string, SocialExposureRecord[]> {
  const grouped = new Map<string, SocialExposureRecord[]>();
  for (const record of records) {
    grouped.set(record.observerId, [...(grouped.get(record.observerId) ?? []), record]);
  }
  return grouped;
}

export function visibilityCounts(records: SocialExposureRecord[]): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    counts[record.visibility] = (counts[record.visibility] ?? 0) + 1;
    return counts;
  }, {});
}

export function sampleIds(ids: string[]): string[] {
  return ids.slice(0, 20);
}

export function countStrings(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function socialFactsFromMessage(message: SocialMessage): Array<Record<string, unknown>> {
  const facts = message.metadata?.socialFacts;
  if (!Array.isArray(facts)) return [];
  return facts.filter((fact): fact is Record<string, unknown> => Boolean(fact) && typeof fact === "object" && !Array.isArray(fact));
}

export function isMetadataDerivedSocialSpeechAct(act: SocialSpeechAct): boolean {
  return stringMetadataValue(act.metadata?.source)?.startsWith("metadata.") === true;
}

export function speechActIdForEvaluation(act: SocialSpeechAct, speechActIndex: number): string {
  return act.id.trim() || `index-${speechActIndex}`;
}

export function stringMetadataValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function stringArrayMetadataValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

export function hasNumericDelta(value: unknown, dimensions: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return dimensions.some((dimension) => typeof record[dimension] === "number" && Number.isFinite(record[dimension]));
}

function isSocialMessageForEvaluation(value: unknown): value is SocialMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.seq === "number" &&
    Number.isFinite(record.seq) &&
    typeof record.channelId === "string" &&
    typeof record.senderId === "string" &&
    Array.isArray(record.recipientIds) &&
    typeof record.visibility === "string" &&
    typeof record.content === "string"
  );
}

export function isSocialSpeechActForEvaluation(value: unknown): value is SocialSpeechAct {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.kind === "string";
}

function isSocialExposureRecord(value: unknown): value is SocialExposureRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.messageId === "string" &&
    typeof record.messageSeq === "number" &&
    typeof record.sourceId === "string" &&
    typeof record.observerId === "string" &&
    typeof record.observedAtTraceId === "string" &&
    typeof record.observedAtTurnIndex === "number" &&
    typeof record.channelId === "string" &&
    typeof record.visibility === "string" &&
    Array.isArray(record.evidenceRefs)
  );
}

export function ratio(numerator: number, denominator: number): number {
  return denominator ? round3(numerator / denominator) : 0;
}

export function average(values: number[]): number {
  return values.length ? round3(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

export function confidence(denominator: number): number {
  return denominator > 0 ? 1 : 0;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

