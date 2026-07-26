import { type BetrayalEvidenceKind, type BetrayalKind, type BetrayalStatus, type BetrayalTriggerKind, type CoalitionEvidenceKind, type CoalitionStatus, type CommitmentStatus, type GossipValence, type MemoryVisibility, type NormKind, type NormSanctionKind, type NormSanctionStatus, type NormStatus, type TrustRepairKind, type TrustRepairStatus, type TrustRepairTriggerKind } from "../socialState";
export function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringArrayMetadata(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

export function relationshipFactDeltas(value: unknown): {
  trust?: number;
  suspicion?: number;
  affinity?: number;
  influence?: number;
  debt?: number;
  respect?: number;
  threat?: number;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const deltas = {
    trust: numberMetadata(record.trust),
    suspicion: numberMetadata(record.suspicion),
    affinity: numberMetadata(record.affinity),
    influence: numberMetadata(record.influence),
    debt: numberMetadata(record.debt),
    respect: numberMetadata(record.respect),
    threat: numberMetadata(record.threat)
  };
  return Object.values(deltas).some((delta) => delta !== undefined) ? deltas : undefined;
}

export function reputationFactDeltas(value: unknown): {
  honesty?: number;
  competence?: number;
  cooperation?: number;
  threat?: number;
  normCompliance?: number;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const deltas = {
    honesty: numberMetadata(record.honesty),
    competence: numberMetadata(record.competence),
    cooperation: numberMetadata(record.cooperation),
    threat: numberMetadata(record.threat),
    normCompliance: numberMetadata(record.normCompliance)
  };
  return Object.values(deltas).some((delta) => delta !== undefined) ? deltas : undefined;
}

export function memoryVisibility(value: unknown): MemoryVisibility | undefined {
  if (isMemoryVisibility(value)) return value;
  return undefined;
}

export function isMemoryVisibility(value: unknown): value is MemoryVisibility {
  return value === "private" || value === "team" || value === "public" || value === "postgame";
}

export function commitmentStatus(value: unknown): CommitmentStatus | undefined {
  if (
    value === "active" ||
    value === "fulfilled" ||
    value === "broken" ||
    value === "unknown" ||
    value === "expired" ||
    value === "withdrawn"
  ) {
    return value;
  }
  return undefined;
}

export function coalitionStatus(value: unknown): CoalitionStatus | undefined {
  if (
    value === "forming" ||
    value === "active" ||
    value === "fulfilled" ||
    value === "dissolved" ||
    value === "betrayed" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

export function coalitionEvidenceKind(value: unknown): CoalitionEvidenceKind | undefined {
  if (value === "formation" || value === "coordination" || value === "betrayal" || value === "dissolution") return value;
  return undefined;
}

export function gossipValence(value: unknown): GossipValence | undefined {
  if (value === "positive" || value === "negative" || value === "neutral" || value === "mixed" || value === "unknown") return value;
  return undefined;
}

export function normKind(value: unknown): NormKind | undefined {
  if (value === "obligation" || value === "prohibition" || value === "permission" || value === "convention") return value;
  return undefined;
}

export function normStatus(value: unknown): NormStatus | undefined {
  if (value === "active" || value === "fulfilled" || value === "violated" || value === "expired" || value === "withdrawn") return value;
  return undefined;
}

export function normSanctionKind(value: unknown): NormSanctionKind | undefined {
  if (
    value === "warning" ||
    value === "pressure" ||
    value === "reputation" ||
    value === "exclusion" ||
    value === "punishment" ||
    value === "repair_request" ||
    value === "reward"
  ) {
    return value;
  }
  return undefined;
}

export function normSanctionStatus(value: unknown): NormSanctionStatus | undefined {
  if (value === "proposed" || value === "applied" || value === "repaired" || value === "withdrawn" || value === "expired" || value === "unknown") {
    return value;
  }
  return undefined;
}

export function trustRepairKind(value: unknown): TrustRepairKind | undefined {
  if (
    value === "apology" ||
    value === "explanation" ||
    value === "evidence_provided" ||
    value === "correction" ||
    value === "commitment_made" ||
    value === "compensation" ||
    value === "public_clarification" ||
    value === "coalition_repair" ||
    value === "norm_repair" ||
    value === "reputation_repair" ||
    value === "other"
  ) {
    return value;
  }
  return undefined;
}

export function trustRepairStatus(value: unknown): TrustRepairStatus | undefined {
  if (
    value === "proposed" ||
    value === "attempted" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed" ||
    value === "withdrawn" ||
    value === "expired" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

export function trustRepairTriggerKind(value: unknown): TrustRepairTriggerKind | undefined {
  if (
    value === "commitment" ||
    value === "coalition" ||
    value === "gossip" ||
    value === "norm_sanction" ||
    value === "relationship" ||
    value === "reputation" ||
    value === "other"
  ) {
    return value;
  }
  return undefined;
}

export function betrayalKind(value: unknown): BetrayalKind | undefined {
  if (
    value === "commitment_broken" ||
    value === "coalition_betrayal" ||
    value === "information_leak" ||
    value === "vote_flip" ||
    value === "attack" ||
    value === "abandonment" ||
    value === "deception" ||
    value === "other"
  ) {
    return value;
  }
  return undefined;
}

export function betrayalStatus(value: unknown): BetrayalStatus | undefined {
  if (
    value === "alleged" ||
    value === "acknowledged" ||
    value === "contested" ||
    value === "confirmed" ||
    value === "repaired" ||
    value === "withdrawn" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

export function betrayalEvidenceKind(value: unknown): BetrayalEvidenceKind | undefined {
  if (value === "allegation" || value === "corroboration" || value === "contest" || value === "repair" || value === "outcome") return value;
  return undefined;
}

export function betrayalTriggerKind(value: unknown): BetrayalTriggerKind | undefined {
  if (
    value === "commitment" ||
    value === "coalition" ||
    value === "gossip" ||
    value === "norm_sanction" ||
    value === "trust_repair" ||
    value === "relationship" ||
    value === "reputation" ||
    value === "other"
  ) {
    return value;
  }
  return undefined;
}

export function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ? cloneJson(value) : {};
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

