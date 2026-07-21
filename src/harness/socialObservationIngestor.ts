import type { SocialMessage, SocialSpeechAct } from "./social";
import {
  addSocialBetrayal,
  addSocialCoalition,
  addSocialCommitment,
  addSocialGossip,
  addSocialNorm,
  addSocialNormSanction,
  addSocialTrustRepair,
  appendSocialMemory,
  ensureSocialMessageIngestionState,
  recordSocialBetrayalEvidence,
  recordSocialCoalitionEvidence,
  updateSocialCommitmentStatus,
  updateSocialNormSanctionStatus,
  updateSocialNormStatus,
  updateSocialRelationship,
  updateSocialReputation,
  updateSocialTrustRepairStatus,
  type AgentSocialState,
  type BetrayalEvidenceKind,
  type BetrayalKind,
  type BetrayalStatus,
  type BetrayalTriggerKind,
  type CoalitionEvidenceKind,
  type CoalitionStatus,
  type CommitmentStatus,
  type EvidenceRef,
  type GossipValence,
  type MemoryVisibility,
  type NormKind,
  type NormSanctionKind,
  type NormSanctionStatus,
  type NormStatus,
  type SocialStateMutationContext,
  type TrustRepairKind,
  type TrustRepairStatus,
  type TrustRepairTriggerKind
} from "./socialState";

export interface VisibleSocialMessageIngestedEvent<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  social: AgentSocialState<TObservation, TPending, TCommand>;
  observerId: string;
  message: SocialMessage;
  evidence: EvidenceRef;
  context: SocialStateMutationContext;
}

export interface VisibleSocialMessageIngestionOptions<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  social: AgentSocialState<TObservation, TPending, TCommand>;
  observerId: string;
  messages: readonly SocialMessage[];
  seenMessageIds?: Set<string>;
  context?: SocialStateMutationContext;
  additionalMessageTags?: (message: SocialMessage) => string[];
  onMessageIngested?: (event: VisibleSocialMessageIngestedEvent<TObservation, TPending, TCommand>) => void;
}

export interface VisibleSocialMessageIngestionResult {
  observedMessageCount: number;
  ingestedMessageCount: number;
  skippedDuplicateMessageCount: number;
  messageIds: string[];
}

export function ingestVisibleSocialMessages<TObservation = unknown, TPending = unknown, TCommand = unknown>(
  options: VisibleSocialMessageIngestionOptions<TObservation, TPending, TCommand>
): VisibleSocialMessageIngestionResult {
  const seenMessageIds = hydrateSeenSocialMessageIds(options.social, options.seenMessageIds);
  let ingestedMessageCount = 0;
  let skippedDuplicateMessageCount = 0;
  const messageIds: string[] = [];

  for (const message of options.messages) {
    if (seenMessageIds.has(message.id)) {
      skippedDuplicateMessageCount += 1;
      continue;
    }
    const stagedSocial = cloneJson(options.social);
    const stagedSeenMessageIds = new Set(seenMessageIds);
    const evidence = messageEvidenceRef(message);
    const context = messageMutationContext(options.context, message);
    appendSocialMemory(stagedSocial, {
      kind: "message",
      source: message.senderId,
      visibility: message.visibility,
      content: message.content,
      salience: message.visibility === "public" ? 0.7 : 0.5,
      importance: message.visibility === "public" ? 0.6 : 0.5,
      evidenceRefs: [evidence],
      tags: uniqueStrings([...genericMessageTags(message), ...(options.additionalMessageTags?.(message) ?? [])]),
      metadata: {
        messageId: message.id,
        messageSeq: message.seq,
        channelId: message.channelId,
        senderId: message.senderId,
        recipientIds: message.recipientIds,
        ...speechActMemoryMetadata(message.speechActs),
        ...cloneRecord(message.metadata)
      }
    }, context);
    options.onMessageIngested?.({
      social: stagedSocial,
      observerId: options.observerId,
      message,
      evidence,
      context
    });
    recordStructuredSocialFacts(stagedSocial, message, evidence, options.observerId, context);
    recordSpeechActSocialFacts(stagedSocial, message, evidence, options.observerId, context);
    rememberSeenSocialMessageId(stagedSocial, stagedSeenMessageIds, message.id);
    commitStagedSocialState(options.social, stagedSocial);
    seenMessageIds.add(message.id);
    ingestedMessageCount += 1;
    messageIds.push(message.id);
  }

  return {
    observedMessageCount: options.messages.length,
    ingestedMessageCount,
    skippedDuplicateMessageCount,
    messageIds
  };
}

export function extractVisibleSocialMessagesFromObservation(observation: unknown): SocialMessage[] {
  const direct = asRecord(observation);
  if (!direct) return [];
  return messagesFromObservationRecord(direct) ?? messagesFromObservationRecord(asRecord(direct.view)) ?? [];
}

export function hydrateSeenSocialMessageIds(state: AgentSocialState, target = new Set<string>()): Set<string> {
  const ingestion = ensureSocialMessageIngestionState(state);
  for (const messageId of ingestion.seenMessageIds) {
    if (isStableMessageId(messageId)) target.add(messageId);
  }
  for (const entry of state.memory.entries) {
    if (entry.kind !== "message") continue;
    for (const evidence of entry.evidenceRefs) {
      if (evidence.artifact === "message" && isStableMessageId(evidence.id)) target.add(evidence.id);
    }
  }
  ingestion.seenMessageIds = [...target];
  return target;
}

function rememberSeenSocialMessageId(state: AgentSocialState, seenMessageIds: Set<string>, messageId: string): void {
  if (!isStableMessageId(messageId)) return;
  seenMessageIds.add(messageId);
  const ingestion = ensureSocialMessageIngestionState(state);
  ingestion.seenMessageIds.push(messageId);
}

function commitStagedSocialState(target: AgentSocialState, staged: AgentSocialState): void {
  for (const key of Object.keys(target) as Array<keyof AgentSocialState>) {
    delete target[key];
  }
  Object.assign(target, staged);
}

function isStableMessageId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function messageEvidenceRef(message: SocialMessage): EvidenceRef {
  return {
    artifact: "message",
    id: message.id,
    seq: message.seq,
    description: message.channelId
  };
}

function messagesFromObservationRecord(record: Record<string, unknown> | undefined): SocialMessage[] | undefined {
  if (!record) return undefined;
  const social = asRecord(record.social);
  const rawMessages = Array.isArray(social?.messages) ? social.messages : record.visibleMessages;
  if (!Array.isArray(rawMessages)) return undefined;
  return rawMessages.filter(isSocialMessage);
}

function isSocialMessage(value: unknown): value is SocialMessage {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      Number.isFinite(record.seq) &&
      typeof record.channelId === "string" &&
      typeof record.senderId === "string" &&
      Array.isArray(record.recipientIds) &&
      record.recipientIds.every((item) => typeof item === "string") &&
      isMemoryVisibility(record.visibility) &&
      typeof record.content === "string" &&
      typeof record.createdAt === "string"
  );
}

function messageMutationContext(context: SocialStateMutationContext | undefined, message: SocialMessage): SocialStateMutationContext {
  return {
    ...cloneJson(context),
    messageSeqRange: {
      start: message.seq,
      end: message.seq
    }
  };
}

function genericMessageTags(message: SocialMessage): string[] {
  const metadata = message.metadata;
  const socialFacts = structuredSocialFacts(metadata);
  return uniqueStrings([
    typeof metadata?.kind === "string" ? `message:${metadata.kind}` : "message",
    typeof metadata?.actionKind === "string" ? `action:${metadata.actionKind}` : undefined,
    typeof metadata?.commandType === "string" ? `command:${metadata.commandType}` : undefined,
    ...speechActTags(message.speechActs),
    socialFacts.some((fact) => fact.kind === "commitment" || fact.kind === "commitment-status") ? "social:commitment" : undefined,
    socialFacts.some((fact) => fact.kind === "coalition" || fact.kind === "coalition-evidence") ? "social:coalition" : undefined,
    socialFacts.some((fact) => fact.kind === "gossip") ? "social:gossip" : undefined,
    socialFacts.some((fact) => fact.kind === "norm" || fact.kind === "norm-status") ? "social:norm" : undefined,
    socialFacts.some((fact) => fact.kind === "norm-sanction" || fact.kind === "norm-sanction-status") ? "social:norm-sanction" : undefined,
    socialFacts.some((fact) => fact.kind === "trust-repair" || fact.kind === "trust-repair-status") ? "social:trust-repair" : undefined,
    socialFacts.some((fact) => fact.kind === "betrayal" || fact.kind === "betrayal-evidence") ? "social:betrayal" : undefined
  ]);
}

function speechActTags(speechActs: SocialSpeechAct[] | undefined): string[] {
  return (speechActs ?? []).flatMap((act) => {
    if (act.kind === "role_claim") return ["claim:role", "social:speech-act"];
    if (act.kind === "accusation") return ["claim:pressure", "social:speech-act"];
    if (act.kind === "vote_intent") return ["claim:vote-intent", "social:speech-act"];
    if (act.kind === "claim") return ["social:gossip", "social:speech-act"];
    if (act.kind === "commitment") return ["social:commitment", "social:speech-act"];
    if (act.kind === "coalition_signal") return ["social:coalition", "social:speech-act"];
    return ["social:speech-act"];
  });
}

function speechActMemoryMetadata(speechActs: SocialSpeechAct[] | undefined): Record<string, unknown> {
  if (!speechActs?.length) return {};
  return {
    speechActCount: speechActs.length,
    speechActIds: speechActs.map((act, index) => speechActId(act, index)),
    speechActKinds: uniqueStrings(speechActs.map((act) => act.kind))
  };
}

function recordSpeechActSocialFacts(
  social: AgentSocialState,
  message: SocialMessage,
  evidence: EvidenceRef,
  observerId: string,
  context?: SocialStateMutationContext
): void {
  for (const [actIndex, act] of (message.speechActs ?? []).entries()) {
    if (isMetadataDerivedSpeechAct(act)) continue;
    if (act.kind === "claim") {
      recordSpeechActClaim(social, message, act, actIndex, evidence, observerId, context);
      continue;
    }
    if (act.kind === "commitment") {
      recordSpeechActCommitment(social, message, act, actIndex, evidence, observerId, context);
      continue;
    }
    if (act.kind === "coalition_signal") {
      recordSpeechActCoalitionRecord(social, message, act, actIndex, evidence, observerId, context);
    }
  }
}

function recordSpeechActClaim(
  social: AgentSocialState,
  message: SocialMessage,
  act: SocialSpeechAct,
  actIndex: number,
  evidence: EvidenceRef,
  observerId: string,
  context?: SocialStateMutationContext
): void {
  if (message.senderId === observerId) return;
  const subjectId = stringMetadata(act.subjectId) ?? stringMetadata(act.targetId);
  const claim = stringMetadata(act.value);
  const topic = stringMetadata(act.metadata?.topic);
  if (!subjectId || (!claim && !topic)) return;
  const id = `${message.id}:speech-act:${speechActId(act, actIndex)}:claim`;
  if (social.gossip?.records[id]) return;
  addSocialGossip(social, {
    id,
    speakerId: message.senderId,
    subjectId,
    audienceIds: message.recipientIds,
    visibility: message.visibility,
    topic: topic ?? "claim",
    claim,
    valence: gossipValence(act.metadata?.valence),
    confidence: numberMetadata(act.confidence) ?? 1,
    evidenceRefs: [evidence],
    metadata: speechActFactMetadata(message, act, actIndex, observerId, {
      targetId: stringMetadata(act.targetId)
    })
  }, context);
}

function recordSpeechActCommitment(
  social: AgentSocialState,
  message: SocialMessage,
  act: SocialSpeechAct,
  actIndex: number,
  evidence: EvidenceRef,
  observerId: string,
  context?: SocialStateMutationContext
): void {
  const promisedAction = stringMetadata(act.metadata?.promisedAction) ?? stringMetadata(act.value);
  const stance = stringMetadata(act.metadata?.stance);
  if (!promisedAction && !stance) return;
  const targetId = stringMetadata(act.targetId) ?? stringMetadata(act.metadata?.targetId);
  const id = stringMetadata(act.metadata?.commitmentId) ?? `${message.id}:speech-act:${speechActId(act, actIndex)}:commitment`;
  if (social.commitments?.records[id]) return;
  addSocialCommitment(social, {
    id,
    actorId: stringMetadata(act.subjectId) ?? message.senderId,
    audienceIds: stringArrayMetadata(act.metadata?.audienceIds) ?? message.recipientIds,
    visibility: memoryVisibility(act.metadata?.visibility) ?? message.visibility,
    promisedAction,
    stance,
    targetId,
    deadlinePhase: stringMetadata(act.metadata?.deadlinePhase),
    deadlineDay: numberMetadata(act.metadata?.deadlineDay),
    status: commitmentStatus(act.metadata?.status),
    confidence: numberMetadata(act.confidence) ?? 1,
    evidenceRefs: [evidence],
    metadata: speechActFactMetadata(message, act, actIndex, observerId, {
      factSemantic: "commitment",
      targetId
    })
  }, context);
}

function recordSpeechActCoalitionRecord(
  social: AgentSocialState,
  message: SocialMessage,
  act: SocialSpeechAct,
  actIndex: number,
  evidence: EvidenceRef,
  observerId: string,
  context?: SocialStateMutationContext
): void {
  const memberIds = stringArrayMetadata(act.metadata?.memberIds);
  if (!memberIds?.length) return;
  const targetId = stringMetadata(act.targetId) ?? stringMetadata(act.metadata?.targetId);
  const id = stringMetadata(act.metadata?.coalitionId) ?? `${message.id}:speech-act:${speechActId(act, actIndex)}:coalition`;
  if (social.coalitions?.records[id]) return;
  addSocialCoalition(social, {
    id,
    memberIds,
    visibility: memoryVisibility(act.metadata?.visibility) ?? message.visibility,
    sharedGoal: stringMetadata(act.metadata?.sharedGoal) ?? stringMetadata(act.value),
    targetId,
    status: coalitionStatus(act.metadata?.status),
    confidence: numberMetadata(act.confidence) ?? 1,
    formationEvidenceRefs: [evidence],
    metadata: speechActFactMetadata(message, act, actIndex, observerId, {
      factSemantic: "coalition",
      targetId
    })
  }, context);
}

function recordStructuredSocialFacts(
  social: AgentSocialState,
  message: SocialMessage,
  evidence: EvidenceRef,
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        formationEvidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
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
        evidenceRefs: [evidence],
        metadata
      }, context);
    }
  }
}

function structuredSocialFacts(metadata: Record<string, unknown> | undefined): Array<Record<string, unknown> & { kind: string }> {
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

function speechActFactMetadata(
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

function isMetadataDerivedSpeechAct(act: SocialSpeechAct): boolean {
  const source = stringMetadata(act.metadata?.source);
  return source?.startsWith("metadata.") === true;
}

function speechActId(act: SocialSpeechAct, actIndex: number): string {
  return act.id.trim() || `index-${actIndex}`;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayMetadata(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function relationshipFactDeltas(value: unknown): {
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

function reputationFactDeltas(value: unknown): {
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

function memoryVisibility(value: unknown): MemoryVisibility | undefined {
  if (isMemoryVisibility(value)) return value;
  return undefined;
}

function isMemoryVisibility(value: unknown): value is MemoryVisibility {
  return value === "private" || value === "team" || value === "public" || value === "postgame";
}

function commitmentStatus(value: unknown): CommitmentStatus | undefined {
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

function coalitionStatus(value: unknown): CoalitionStatus | undefined {
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

function coalitionEvidenceKind(value: unknown): CoalitionEvidenceKind | undefined {
  if (value === "formation" || value === "coordination" || value === "betrayal" || value === "dissolution") return value;
  return undefined;
}

function gossipValence(value: unknown): GossipValence | undefined {
  if (value === "positive" || value === "negative" || value === "neutral" || value === "mixed" || value === "unknown") return value;
  return undefined;
}

function normKind(value: unknown): NormKind | undefined {
  if (value === "obligation" || value === "prohibition" || value === "permission" || value === "convention") return value;
  return undefined;
}

function normStatus(value: unknown): NormStatus | undefined {
  if (value === "active" || value === "fulfilled" || value === "violated" || value === "expired" || value === "withdrawn") return value;
  return undefined;
}

function normSanctionKind(value: unknown): NormSanctionKind | undefined {
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

function normSanctionStatus(value: unknown): NormSanctionStatus | undefined {
  if (value === "proposed" || value === "applied" || value === "repaired" || value === "withdrawn" || value === "expired" || value === "unknown") {
    return value;
  }
  return undefined;
}

function trustRepairKind(value: unknown): TrustRepairKind | undefined {
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

function trustRepairStatus(value: unknown): TrustRepairStatus | undefined {
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

function trustRepairTriggerKind(value: unknown): TrustRepairTriggerKind | undefined {
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

function betrayalKind(value: unknown): BetrayalKind | undefined {
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

function betrayalStatus(value: unknown): BetrayalStatus | undefined {
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

function betrayalEvidenceKind(value: unknown): BetrayalEvidenceKind | undefined {
  if (value === "allegation" || value === "corroboration" || value === "contest" || value === "repair" || value === "outcome") return value;
  return undefined;
}

function betrayalTriggerKind(value: unknown): BetrayalTriggerKind | undefined {
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

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ? cloneJson(value) : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
