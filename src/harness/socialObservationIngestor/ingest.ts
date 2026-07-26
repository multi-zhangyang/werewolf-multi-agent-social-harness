import { recordSpeechActSocialFacts } from "./speechActFacts";
import { recordStructuredSocialFacts, speechActId, structuredSocialFacts } from "./structuredFacts";
import { asRecord, cloneJson, cloneRecord, isMemoryVisibility, uniqueStrings } from "./factParsers";
import { type SocialDeliveryReceipt, type SocialMessage, type SocialSpeechAct } from "../social";
import { type AgentSocialState, appendSocialMemory, ensureSocialMessageIngestionState, type EvidenceRef, type SocialStateMutationContext } from "../socialState";
export interface VisibleSocialMessageIngestedEvent<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  social: AgentSocialState<TObservation, TPending, TCommand>;
  observerId: string;
  message: SocialMessage;
  /** Primary message evidence retained for compatibility with existing domain reducers. */
  evidence: EvidenceRef;
  /** Observer-bound evidence used by all message-derived social mutations. */
  evidenceRefs: EvidenceRef[];
  deliveryReceipt?: SocialDeliveryReceipt;
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
    const deliveryBinding = observerDeliveryBinding(message, options.observerId);
    const evidenceRefs = deliveryBinding ? [evidence, deliveryBinding.evidence] : [evidence];
    const context = messageMutationContext(options.context, message);
    appendSocialMemory(stagedSocial, {
      kind: "message",
      source: message.senderId,
      visibility: message.visibility,
      content: message.content,
      salience: message.visibility === "public" ? 0.7 : 0.5,
      importance: message.visibility === "public" ? 0.6 : 0.5,
      evidenceRefs,
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
      evidenceRefs: cloneJson(evidenceRefs),
      deliveryReceipt: cloneJson(deliveryBinding?.receipt),
      context
    });
    recordStructuredSocialFacts(stagedSocial, message, evidenceRefs, options.observerId, context);
    recordSpeechActSocialFacts(
      stagedSocial,
      message,
      evidenceRefs,
      deliveryBinding?.receipt,
      options.observerId,
      context
    );
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

function observerDeliveryBinding(
  message: SocialMessage,
  observerId: string
): { receipt: SocialDeliveryReceipt; evidence: EvidenceRef } | undefined {
  if (message.deliveryReceipts === undefined) return undefined;
  const matches = message.deliveryReceipts.filter((receipt) =>
    receipt.observerId === observerId &&
    receipt.messageId === message.id &&
    receipt.messageSeq === message.seq &&
    receipt.channelId === message.channelId &&
    receipt.senderId === message.senderId &&
    receipt.visibility === message.visibility
  );
  if (matches.length !== 1) {
    throw new Error(
      `Visible social message ${message.id} requires exactly one matching delivery receipt for observer ${observerId}; received ${matches.length}.`
    );
  }
  const receipt = matches[0];
  return {
    receipt,
    evidence: {
      artifact: "delivery_receipt",
      id: receipt.id,
      seq: receipt.messageSeq,
      description: receipt.channelId
    }
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
