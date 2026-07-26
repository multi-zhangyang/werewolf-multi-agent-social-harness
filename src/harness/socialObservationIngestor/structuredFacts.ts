import { betrayalEvidenceKind, betrayalKind, betrayalStatus, betrayalTriggerKind, coalitionEvidenceKind, coalitionStatus, commitmentStatus, gossipValence, memoryVisibility, normKind, normSanctionKind, normSanctionStatus, normStatus, numberMetadata, relationshipFactDeltas, reputationFactDeltas, stringArrayMetadata, stringMetadata, trustRepairKind, trustRepairStatus, trustRepairTriggerKind } from "./factParsers";
import { type SocialMessage, type SocialSpeechAct } from "../social";
import { addSocialBetrayal, addSocialCoalition, addSocialCommitment, addSocialGossip, addSocialNorm, addSocialNormSanction, addSocialTrustRepair, type AgentSocialState, type EvidenceRef, recordSocialBetrayalEvidence, recordSocialCoalitionEvidence, type SocialStateMutationContext, updateSocialCommitmentStatus, updateSocialNormSanctionStatus, updateSocialNormStatus, updateSocialRelationship, updateSocialReputation, updateSocialTrustRepairStatus } from "../socialState";
export function recordStructuredSocialFacts(
  social: AgentSocialState,
  message: SocialMessage,
  evidenceRefs: EvidenceRef[],
  observerId: string,
  context?: SocialStateMutationContext
): void {
  for (const [factIndex, fact] of structuredSocialFacts(message.metadata).entries()) {
    const metadata = socialFactMetadata(message, observerId, fact, factIndex);
    if (fact.kind === "relationship") {
      const targetId = stringMetadata(fact.targetId);
      const deltas = relationshipFactDeltas(fact.deltas);
      if (!targetId || !deltas) continue;
      updateSocialRelationship(social, {
        targetId,
        deltas,
        evidenceRefs,
        metadata: {
          ...metadata,
          reason: stringMetadata(fact.reason),
          triggerKind: stringMetadata(fact.triggerKind),
          triggerId: stringMetadata(fact.triggerId),
          confidence: numberMetadata(fact.confidence)
        }
      }, context);
      continue;
    }
    if (fact.kind === "reputation") {
      const subjectId = stringMetadata(fact.subjectId) ?? stringMetadata(fact.targetId);
      const deltas = reputationFactDeltas(fact.deltas);
      if (!subjectId || !deltas) continue;
      updateSocialReputation(social, {
        subjectId,
        deltas,
        evidenceRefs,
        metadata: {
          ...metadata,
          subjectId,
          reason: stringMetadata(fact.reason),
          triggerKind: stringMetadata(fact.triggerKind),
          triggerId: stringMetadata(fact.triggerId),
          confidence: numberMetadata(fact.confidence)
        }
      }, context);
      continue;
    }
    if (fact.kind === "commitment") {
      const promisedAction = stringMetadata(fact.promisedAction);
      const stance = stringMetadata(fact.stance);
      if (!promisedAction && !stance) continue;
      const id = stringMetadata(fact.id) ?? `${message.id}:commitment:${factIndex}`;
      if (social.commitments?.records[id]) continue;
      addSocialCommitment(social, {
        id,
        actorId: stringMetadata(fact.actorId) ?? message.senderId,
        audienceIds: stringArrayMetadata(fact.audienceIds) ?? message.recipientIds,
        visibility: memoryVisibility(fact.visibility) ?? message.visibility,
        promisedAction,
        stance,
        targetId: stringMetadata(fact.targetId),
        deadlinePhase: stringMetadata(fact.deadlinePhase),
        deadlineDay: numberMetadata(fact.deadlineDay),
        status: commitmentStatus(fact.status),
        confidence: numberMetadata(fact.confidence) ?? 1,
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "commitment-status") {
      const id = stringMetadata(fact.id);
      const status = commitmentStatus(fact.status);
      if (!id || !status || !social.commitments?.records[id]) continue;
      updateSocialCommitmentStatus(social, {
        id,
        status,
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "coalition") {
      const memberIds = stringArrayMetadata(fact.memberIds);
      if (!memberIds?.length) continue;
      const id = stringMetadata(fact.id) ?? `${message.id}:coalition:${factIndex}`;
      if (social.coalitions?.records[id]) continue;
      addSocialCoalition(social, {
        id,
        memberIds,
        visibility: memoryVisibility(fact.visibility) ?? message.visibility,
        sharedGoal: stringMetadata(fact.sharedGoal),
        targetId: stringMetadata(fact.targetId),
        status: coalitionStatus(fact.status),
        confidence: numberMetadata(fact.confidence) ?? 1,
        formationEvidenceRefs: evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "coalition-evidence") {
      const id = stringMetadata(fact.id);
      const evidenceKind = coalitionEvidenceKind(fact.evidenceKind);
      if (!id || !evidenceKind || !social.coalitions?.records[id]) continue;
      recordSocialCoalitionEvidence(social, {
        id,
        kind: evidenceKind,
        status: coalitionStatus(fact.status),
        confidence: numberMetadata(fact.confidence),
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "gossip") {
      const subjectId = stringMetadata(fact.subjectId);
      const claim = stringMetadata(fact.claim);
      const topic = stringMetadata(fact.topic);
      if (!subjectId || (!claim && !topic)) continue;
      const id = stringMetadata(fact.id) ?? `${message.id}:gossip:${factIndex}`;
      if (social.gossip?.records[id]) continue;
      addSocialGossip(social, {
        id,
        speakerId: stringMetadata(fact.speakerId) ?? message.senderId,
        subjectId,
        audienceIds: stringArrayMetadata(fact.audienceIds) ?? message.recipientIds,
        visibility: memoryVisibility(fact.visibility) ?? message.visibility,
        topic,
        claim,
        sourceId: stringMetadata(fact.sourceId),
        valence: gossipValence(fact.valence),
        confidence: numberMetadata(fact.confidence) ?? 1,
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "norm") {
      const id = stringMetadata(fact.id) ?? `${message.id}:norm:${factIndex}`;
      const kind = normKind(fact.normKind);
      const expectedBehavior = stringMetadata(fact.expectedBehavior);
      if (!kind || !expectedBehavior || social.norms.norms[id]) continue;
      addSocialNorm(social, {
        id,
        kind,
        scope: stringMetadata(fact.scope) ?? message.channelId,
        condition: stringMetadata(fact.condition),
        expectedBehavior,
        sanction: stringMetadata(fact.sanction),
        source: stringMetadata(fact.source) ?? message.senderId,
        confidence: numberMetadata(fact.confidence) ?? 1,
        status: normStatus(fact.status) ?? "active",
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "norm-status") {
      const id = stringMetadata(fact.id);
      const status = normStatus(fact.status);
      if (!id || !status || !social.norms.norms[id]) continue;
      updateSocialNormStatus(social, {
        id,
        status,
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "norm-sanction") {
      const normId = stringMetadata(fact.normId);
      const targetId = stringMetadata(fact.targetId);
      const kind = normSanctionKind(fact.sanctionKind);
      if (!normId || !targetId || !kind) continue;
      const id = stringMetadata(fact.id) ?? `${message.id}:norm-sanction:${factIndex}`;
      if (social.normSanctions?.records[id]) continue;
      addSocialNormSanction(social, {
        id,
        normId,
        actorId: stringMetadata(fact.actorId) ?? message.senderId,
        targetId,
        audienceIds: stringArrayMetadata(fact.audienceIds) ?? message.recipientIds,
        visibility: memoryVisibility(fact.visibility) ?? message.visibility,
        kind,
        status: normSanctionStatus(fact.status),
        reason: stringMetadata(fact.reason),
        requestedRepair: stringMetadata(fact.requestedRepair),
        confidence: numberMetadata(fact.confidence) ?? 1,
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "norm-sanction-status") {
      const id = stringMetadata(fact.id);
      const status = normSanctionStatus(fact.status);
      if (!id || !status || !social.normSanctions?.records[id]) continue;
      updateSocialNormSanctionStatus(social, {
        id,
        status,
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "trust-repair") {
      const targetId = stringMetadata(fact.targetId);
      const kind = trustRepairKind(fact.repairKind);
      if (!targetId || !kind) continue;
      const id = stringMetadata(fact.id) ?? `${message.id}:trust-repair:${factIndex}`;
      if (social.trustRepairs?.records[id]) continue;
      addSocialTrustRepair(social, {
        id,
        actorId: stringMetadata(fact.actorId) ?? message.senderId,
        targetId,
        audienceIds: stringArrayMetadata(fact.audienceIds) ?? message.recipientIds,
        visibility: memoryVisibility(fact.visibility) ?? message.visibility,
        kind,
        status: trustRepairStatus(fact.status),
        triggerKind: trustRepairTriggerKind(fact.triggerKind),
        triggerId: stringMetadata(fact.triggerId),
        requestedById: stringMetadata(fact.requestedById),
        relatedCommitmentId: stringMetadata(fact.relatedCommitmentId),
        relatedCoalitionId: stringMetadata(fact.relatedCoalitionId),
        relatedNormSanctionId: stringMetadata(fact.relatedNormSanctionId),
        relatedGossipId: stringMetadata(fact.relatedGossipId),
        reason: stringMetadata(fact.reason),
        requestedRepair: stringMetadata(fact.requestedRepair),
        offeredRepair: stringMetadata(fact.offeredRepair),
        confidence: numberMetadata(fact.confidence) ?? 1,
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "trust-repair-status") {
      const id = stringMetadata(fact.id);
      const status = trustRepairStatus(fact.status);
      if (!id || !status || !social.trustRepairs?.records[id]) continue;
      updateSocialTrustRepairStatus(social, {
        id,
        status,
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "betrayal") {
      const targetId = stringMetadata(fact.targetId);
      const kind = betrayalKind(fact.betrayalKind);
      if (!targetId || !kind) continue;
      const id = stringMetadata(fact.id) ?? `${message.id}:betrayal:${factIndex}`;
      if (social.betrayals?.records[id]) continue;
      addSocialBetrayal(social, {
        id,
        actorId: stringMetadata(fact.actorId) ?? message.senderId,
        targetId,
        audienceIds: stringArrayMetadata(fact.audienceIds) ?? message.recipientIds,
        visibility: memoryVisibility(fact.visibility) ?? message.visibility,
        kind,
        status: betrayalStatus(fact.status),
        triggerKind: betrayalTriggerKind(fact.triggerKind),
        triggerId: stringMetadata(fact.triggerId),
        relatedCommitmentId: stringMetadata(fact.relatedCommitmentId),
        relatedCoalitionId: stringMetadata(fact.relatedCoalitionId),
        relatedGossipId: stringMetadata(fact.relatedGossipId),
        relatedNormSanctionId: stringMetadata(fact.relatedNormSanctionId),
        relatedTrustRepairId: stringMetadata(fact.relatedTrustRepairId),
        claim: stringMetadata(fact.claim),
        impact: stringMetadata(fact.impact),
        confidence: numberMetadata(fact.confidence) ?? 1,
        evidenceRefs,
        metadata
      }, context);
      continue;
    }
    if (fact.kind === "betrayal-evidence") {
      const id = stringMetadata(fact.id);
      const kind = betrayalEvidenceKind(fact.evidenceKind);
      if (!id || !kind || !social.betrayals?.records[id]) continue;
      recordSocialBetrayalEvidence(social, {
        id,
        kind,
        status: betrayalStatus(fact.status),
        confidence: numberMetadata(fact.confidence),
        evidenceRefs,
        metadata
      }, context);
    }
  }
}

export function structuredSocialFacts(metadata: Record<string, unknown> | undefined): Array<Record<string, unknown> & { kind: string }> {
  const facts = metadata?.socialFacts;
  if (!Array.isArray(facts)) return [];
  return facts.filter((fact): fact is Record<string, unknown> & { kind: string } => Boolean(fact) && typeof fact === "object" && typeof (fact as Record<string, unknown>).kind === "string");
}

function socialFactMetadata(
  message: SocialMessage,
  observerId: string,
  fact: Record<string, unknown> & { kind: string },
  factIndex: number
): Record<string, unknown> {
  return {
    observerId,
    speakerId: message.senderId,
    factSource: "social-message-metadata",
    factKind: fact.kind,
    factIndex,
    channelId: message.channelId,
    visibility: message.visibility,
    messageId: message.id,
    messageSeq: message.seq,
    targetId: stringMetadata(fact.targetId) ?? (fact.kind === "reputation" ? stringMetadata(fact.subjectId) : undefined)
  };
}

export function speechActFactMetadata(
  message: SocialMessage,
  act: SocialSpeechAct,
  actIndex: number,
  observerId: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    observerId,
    speakerId: message.senderId,
    factSource: "social-message-speech-act",
    factKind: act.kind,
    speechActId: speechActId(act, actIndex),
    speechActKind: act.kind,
    speechActIndex: actIndex,
    speechActSubjectId: stringMetadata(act.subjectId),
    speechActSource: stringMetadata(act.metadata?.source),
    channelId: message.channelId,
    visibility: message.visibility,
    messageId: message.id,
    messageSeq: message.seq,
    ...extra
  };
}

export function isMetadataDerivedSpeechAct(act: SocialSpeechAct): boolean {
  const source = stringMetadata(act.metadata?.source);
  return source?.startsWith("metadata.") === true;
}

export function speechActId(act: SocialSpeechAct, actIndex: number): string {
  return act.id.trim() || `index-${actIndex}`;
}

