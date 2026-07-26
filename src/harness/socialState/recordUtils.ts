import { type EvidenceRef, type RelationshipEdge, type ReputationRecord, type SocialMemoryEntry, type TheoryOfMindAttribution } from "./contracts";
export function createRelationshipEdge(targetId: string): RelationshipEdge {
  return {
    targetId,
    trust: 0,
    suspicion: 0,
    affinity: 0,
    influence: 0,
    debt: 0,
    respect: 0,
    threat: 0,
    evidenceRefs: [],
    updatedAt: deterministicTimestamp(0)
  };
}

export function createReputationRecord(subjectId: string): ReputationRecord {
  return {
    subjectId,
    honesty: 0,
    competence: 0,
    cooperation: 0,
    threat: 0,
    normCompliance: 0,
    evidenceRefs: [],
    updatedAt: deterministicTimestamp(0)
  };
}

export function beliefId(subject: string, predicate: string): string {
  return `${subject}:${predicate}`;
}

export function memoryScore(entry: SocialMemoryEntry): number {
  return entry.importance * 2 + entry.salience + entry.seq / 1_000_000;
}

export function roundMemoryScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function mergeEvidenceRefs(existing: EvidenceRef[], incoming: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const merged: EvidenceRef[] = [];
  for (const ref of [...existing, ...incoming]) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cloneJson(ref));
  }
  return merged;
}

export function requireStableTheoryOfMindAttribution(
  input: Omit<TheoryOfMindAttribution, "createdAt" | "confidence"> & { confidence?: number }
): void {
  if (!input.id.trim()) throw new Error("theory-of-mind attribution requires an id.");
  if (!input.observerId.trim()) throw new Error("theory-of-mind attribution requires an observerId.");
  if (!input.subjectId.trim()) throw new Error("theory-of-mind attribution requires a subjectId.");
  if (!input.proposition?.predicate?.trim()) throw new Error("theory-of-mind attribution requires a proposition predicate.");
  if (input.source !== "speech_act") throw new Error("theory-of-mind attribution source must be speech_act.");
  if (!input.sourceMessageId.trim()) throw new Error("theory-of-mind attribution requires a sourceMessageId.");
  if (!Number.isInteger(input.sourceMessageSeq) || input.sourceMessageSeq < 1) {
    throw new Error("theory-of-mind attribution requires a positive sourceMessageSeq.");
  }
  if (!input.sourceSpeechActId.trim()) throw new Error("theory-of-mind attribution requires a sourceSpeechActId.");
  if (!input.sourceSpeechActKind.trim()) throw new Error("theory-of-mind attribution requires a sourceSpeechActKind.");
  if (input.visibility === "postgame") throw new Error("theory-of-mind attribution cannot use postgame-only evidence.");
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error("theory-of-mind attribution confidence must be between 0 and 1.");
  }
  requireEvidence(input.evidenceRefs, "theory-of-mind attribution");
  if (!input.evidenceRefs.some((ref) => ref.artifact === "message" && ref.id === input.sourceMessageId && ref.seq === input.sourceMessageSeq)) {
    throw new Error("theory-of-mind attribution requires matching message evidence.");
  }
  const receiptRefs = input.evidenceRefs.filter((ref) => ref.artifact === "delivery_receipt");
  if (input.sourceDeliveryReceiptId) {
    if (!receiptRefs.some((ref) => ref.id === input.sourceDeliveryReceiptId && ref.seq === input.sourceMessageSeq)) {
      throw new Error("theory-of-mind attribution requires matching delivery receipt evidence.");
    }
  } else if (receiptRefs.length) {
    throw new Error("theory-of-mind attribution delivery receipt evidence requires sourceDeliveryReceiptId.");
  }
}

export function requireEvidence(evidenceRefs: EvidenceRef[], operation: string): void {
  if (!evidenceRefs.length) throw new Error(`${operation} requires at least one evidence ref.`);
}

export function deterministicTimestamp(seq: number): string {
  return new Date(seq * 1000).toISOString();
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, round3(value)));
}

export function clampSigned(value: number): number {
  return Math.min(1, Math.max(-1, round3(value)));
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
