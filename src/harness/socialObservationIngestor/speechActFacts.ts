import { cloneJson, coalitionStatus, commitmentStatus, gossipValence, memoryVisibility, numberMetadata, stringArrayMetadata, stringMetadata } from "./factParsers";
import { isMetadataDerivedSpeechAct, speechActFactMetadata, speechActId } from "./structuredFacts";
import { type SocialDeliveryReceipt, type SocialMessage, type SocialSpeechAct } from "../social";
import { addSocialCoalition, addSocialCommitment, addSocialGossip, addSocialTheoryOfMindAttribution, type AgentSocialState, type EvidenceRef, type SocialStateMutationContext } from "../socialState";
export function recordSpeechActSocialFacts(
  social: AgentSocialState,
  message: SocialMessage,
  evidenceRefs: EvidenceRef[],
  deliveryReceipt: SocialDeliveryReceipt | undefined,
  observerId: string,
  context?: SocialStateMutationContext
): void {
  for (const [actIndex, act] of (message.speechActs ?? []).entries()) {
    if (isMetadataDerivedSpeechAct(act)) continue;
    recordSpeechActTheoryOfMindAttribution(social, message, act, actIndex, evidenceRefs, deliveryReceipt, observerId, context);
    if (act.kind === "claim") {
      recordSpeechActClaim(social, message, act, actIndex, evidenceRefs, observerId, context);
      continue;
    }
    if (act.kind === "commitment") {
      recordSpeechActCommitment(social, message, act, actIndex, evidenceRefs, observerId, context);
      continue;
    }
    if (act.kind === "coalition_signal") {
      recordSpeechActCoalitionRecord(social, message, act, actIndex, evidenceRefs, observerId, context);
    }
  }
}

/**
 * Record only the narrow statement-level form of theory of mind: the observer
 * saw this speaker make this typed act.  The record does not assert that the
 * speaker is truthful, privately knows the proposition, will honour it, or
 * that the observer accepts it as a first-order belief.
 */
function recordSpeechActTheoryOfMindAttribution(
  social: AgentSocialState,
  message: SocialMessage,
  act: SocialSpeechAct,
  actIndex: number,
  evidenceRefs: EvidenceRef[],
  deliveryReceipt: SocialDeliveryReceipt | undefined,
  observerId: string,
  context?: SocialStateMutationContext
): void {
  if (message.senderId === observerId || message.visibility === "postgame") return;
  const kind = theoryOfMindKindForSpeechAct(act.kind);
  if (!kind) return;
  const actId = speechActId(act, actIndex);
  const id = `${message.id}:speech-act:${actId}:theory-of-mind`;
  if (social.theoryOfMind?.records[id]) return;
  const confidence = numberMetadata(act.confidence);
  addSocialTheoryOfMindAttribution(social, {
    id,
    observerId,
    subjectId: message.senderId,
    kind,
    proposition: {
      predicate: String(act.kind),
      subjectId: stringMetadata(act.subjectId),
      targetId: stringMetadata(act.targetId),
      value: cloneJson(act.value)
    },
    source: "speech_act",
    sourceMessageId: message.id,
    sourceMessageSeq: message.seq,
    sourceSpeechActId: actId,
    sourceSpeechActKind: String(act.kind),
    sourceDeliveryReceiptId: deliveryReceipt?.id,
    visibility: message.visibility,
    confidence: confidence !== undefined && confidence >= 0 && confidence <= 1 ? confidence : undefined,
    evidenceRefs,
    observedAtTraceId: context?.traceId,
    observedAtTurnIndex: context?.turnIndex
  }, context);
}

function theoryOfMindKindForSpeechAct(kind: SocialSpeechAct["kind"]):
  | "stated_assertion"
  | "stated_intent"
  | "stated_commitment"
  | "stated_request"
  | "stated_agreement"
  | "stated_disagreement"
  | undefined {
  switch (kind) {
    case "claim":
    case "role_claim":
    case "accusation":
    case "defense":
    case "role_action":
      return "stated_assertion";
    case "vote_intent":
      return "stated_intent";
    case "commitment":
      return "stated_commitment";
    case "request":
      return "stated_request";
    case "agreement":
      return "stated_agreement";
    case "disagreement":
      return "stated_disagreement";
    default:
      return undefined;
  }
}

function recordSpeechActClaim(
  social: AgentSocialState,
  message: SocialMessage,
  act: SocialSpeechAct,
  actIndex: number,
  evidenceRefs: EvidenceRef[],
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
    evidenceRefs,
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
  evidenceRefs: EvidenceRef[],
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
    evidenceRefs,
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
  evidenceRefs: EvidenceRef[],
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
    formationEvidenceRefs: evidenceRefs,
    metadata: speechActFactMetadata(message, act, actIndex, observerId, {
      factSemantic: "coalition",
      targetId
    })
  }, context);
}

