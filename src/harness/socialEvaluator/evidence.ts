import { type SocialExposureRecord } from "../social";
import { type GossipExposureRecordEvaluation } from "./lifecycleEvaluation";
import { type BetrayalRecord, type CoalitionRecord, type CommitmentRecord, type EvidenceRef, type GossipRecord, type NormRecord, type NormSanctionRecord, type RelationshipEdge, type ReputationRecord, type SocialMemoryEntry, socialStateRetentionWindow, type TrustRepairRecord } from "../socialState";
import { type HarnessMetricEvidenceRef } from "../types";
import { type LegacySocialAgentProjection, type SocialAgentSnapshot } from "./manifests";
export function socialSubject(agent: SocialAgentSnapshot): Record<string, unknown> {
  const actorId = socialAgentId(agent);
  const profileId = agent.profileId ?? agent.social?.profile.id;
  const model = agent.model ?? agent.social?.profile.model;
  const policyId = agent.policyId ?? agent.social?.profile.policyId ?? legacySocialProjection(agent).policyName;
  return {
    actorId,
    profileId,
    model,
    policyId,
    // Kept for existing Werewolf artifact readers while new domains consume
    // the domain-neutral actorId/policyId fields above.
    playerId: actorId,
    policyName: policyId
  };
}

export function socialAgentId(agent: SocialAgentSnapshot): string {
  const actorId = agent.id ?? agent.social?.agentId ?? legacySocialProjection(agent).playerId;
  if (!actorId) {
    throw new Error("Social evaluator requires snapshot.id, snapshot.social.agentId, or a legacy playerId.");
  }
  return actorId;
}

function legacySocialProjection(agent: SocialAgentSnapshot): LegacySocialAgentProjection {
  return agent as SocialAgentSnapshot & LegacySocialAgentProjection;
}

export function agentStateEvidence(agent: SocialAgentSnapshot): HarnessMetricEvidenceRef[] {
  return [
    {
      artifact: "agent_state",
      id: socialAgentId(agent),
      description: `socialStateHash:${agent.socialStateHash ?? "unknown"}`
    }
  ];
}

export function isCoordinationMessage(agent: SocialAgentSnapshot, entry: SocialMemoryEntry): boolean {
  if (entry.visibility === "team") return true;
  if (entry.visibility === "private" && entry.source !== socialAgentId(agent) && entry.source !== "environment" && entry.source !== "reasoner") return true;
  return false;
}

export function isNormPressureRecord(norm: NormRecord): boolean {
  return Boolean(norm.sanction) || norm.kind === "obligation" || norm.kind === "prohibition" || norm.status === "violated" || norm.status === "fulfilled";
}

export function coalitionSignalRecords(
  relationships: RelationshipEdge[],
  reputations: ReputationRecord[]
): Array<{ kind: "relationship" | "reputation"; subjectId: string; evidenceRefs: EvidenceRef[] }> {
  return [
    ...relationships
      .filter((edge) => edge.trust > 0.1 || edge.affinity > 0.1)
      .map((edge) => ({ kind: "relationship" as const, subjectId: edge.targetId, evidenceRefs: edge.evidenceRefs })),
    ...reputations
      .filter((record) => record.cooperation > 0)
      .map((record) => ({ kind: "reputation" as const, subjectId: record.subjectId, evidenceRefs: record.evidenceRefs }))
  ];
}

export function evidenceFromRelationships(agent: SocialAgentSnapshot, records: RelationshipEdge[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

export function evidenceFromReputation(agent: SocialAgentSnapshot, records: ReputationRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

export function evidenceFromNorms(agent: SocialAgentSnapshot, records: NormRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

export function evidenceFromMemories(agent: SocialAgentSnapshot, records: SocialMemoryEntry[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

export function evidenceFromCommitments(agent: SocialAgentSnapshot, records: CommitmentRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

export function evidenceFromCoalitions(agent: SocialAgentSnapshot, records: CoalitionRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

export function evidenceFromGossip(agent: SocialAgentSnapshot, records: GossipRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

export function evidenceFromNormSanctions(agent: SocialAgentSnapshot, records: NormSanctionRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

export function evidenceFromTrustRepairs(agent: SocialAgentSnapshot, records: TrustRepairRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

export function evidenceFromBetrayals(agent: SocialAgentSnapshot, records: BetrayalRecord[]): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}

export function evidenceFromGossipExposureRecords(agent: SocialAgentSnapshot, records: GossipExposureRecordEvaluation[]): HarnessMetricEvidenceRef[] {
  const socialEvidenceRefs = records.flatMap((record) => [...record.messageEvidenceRefs, ...(record.creationEntry?.evidenceRefs ?? [])]);
  const exposureEvidenceRefs = records.flatMap((record) => evidenceFromExposureRecords(agent, record.associatedExposureRecords));
  const mapped = evidenceFromSocialRefs(agent, socialEvidenceRefs);
  return uniqueEvidenceRefs([...mapped, ...exposureEvidenceRefs, ...agentStateEvidence(agent)]);
}

export function evidenceFromCoalitionSignals(
  agent: SocialAgentSnapshot,
  records: Array<{ evidenceRefs: EvidenceRef[] }>
): HarnessMetricEvidenceRef[] {
  return evidenceFromSocialRefs(agent, records.flatMap((record) => record.evidenceRefs));
}


export function evidenceFromExposureRecords(agent: SocialAgentSnapshot, records: SocialExposureRecord[]): HarnessMetricEvidenceRef[] {
  const refs: HarnessMetricEvidenceRef[] = [];
  for (const record of records) {
    for (const ref of record.evidenceRefs) {
      if (ref.artifact === "message") {
        refs.push({ artifact: "message", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "delivery_receipt") {
        refs.push({ artifact: "delivery_receipt", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "trace") {
        refs.push({ artifact: "trace", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
        continue;
      }
      if (ref.artifact === "observation") {
        refs.push({
          artifact: "observation",
          id: ref.id,
          seq: ref.seq,
          traceId: ref.traceId,
          description: ref.description ?? `scoped exposure of ${record.messageId}`
        });
        continue;
      }
      refs.push({
        artifact: "observation",
        id: ref.id,
        seq: ref.seq,
        traceId: ref.traceId,
        description: ref.description ?? `scoped exposure of ${record.messageId}`
      });
    }
  }
  const unique = uniqueEvidenceRefs(refs);
  return unique.length ? unique : agentStateEvidence(agent);
}

export function evidenceFromSocialRefs(agent: SocialAgentSnapshot, refs: EvidenceRef[]): HarnessMetricEvidenceRef[] {
  const mapped: HarnessMetricEvidenceRef[] = [];
  for (const ref of refs) {
    if (ref.artifact === "message") {
      mapped.push({ artifact: "message", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "delivery_receipt") {
      mapped.push({ artifact: "delivery_receipt", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "event") {
      mapped.push({ artifact: "event", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "trace") {
      mapped.push({ artifact: "trace", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "observation") {
      mapped.push({ artifact: "observation", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.artifact === "state" || ref.artifact === "outcome") {
      mapped.push({ artifact: "state", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: ref.description });
      continue;
    }
    if (ref.traceId) {
      mapped.push({ artifact: "trace", id: ref.id, seq: ref.seq, traceId: ref.traceId, description: `${ref.artifact}:${ref.description ?? ""}` });
      continue;
    }
    mapped.push({ artifact: "agent_state", id: socialAgentId(agent), seq: ref.seq, description: `${ref.artifact}:${ref.description ?? "social evidence"}` });
  }
  const unique = uniqueEvidenceRefs(mapped);
  return unique.length ? unique : agentStateEvidence(agent);
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

export function withSocialHash(agent: SocialAgentSnapshot, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...metadata,
    journalRetentionWindow: agent.social?.journal ? socialStateRetentionWindow(agent.social.journal) : null,
    socialStateHash: agent.socialStateHash ?? null
  };
}

