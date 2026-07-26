import { asRecord, stringValue } from "./valueUtils";
import { collectRuntimeAudienceSnapshotErrors, unscopedVisibleObserverIdsForMessage, visibleObserverIdsForMessage } from "./messaging";
import { expectedMessageVisibilityForChannel, isSocialMessage, messageVisibleToObserver, recipientIsAllowedInChannel } from "./visibility";
import { type SocialChannel, type SocialHarnessStep, type SocialMessage } from "./contracts";
export function extractObservedSocialMessages<TObservation, TPending, TCommand>(
  step: SocialHarnessStep<TObservation, TPending, TCommand>
): { observerId: string; messages: SocialMessage[] } | undefined {
  const observation = asRecord(step.observation);
  const direct = observation ? socialViewFromRecord(observation, step.actorId) : undefined;
  if (direct) return direct;
  const wrappedView = asRecord(observation?.view);
  return wrappedView ? socialViewFromRecord(wrappedView, stringValue(observation?.agentId, step.actorId)) : undefined;
}

function socialViewFromRecord(record: Record<string, unknown>, fallbackObserverId: string): { observerId: string; messages: SocialMessage[] } | undefined {
  const social = asRecord(record.social);
  const rawMessages = Array.isArray(social?.messages) ? social.messages : record.visibleMessages;
  if (!Array.isArray(rawMessages)) return undefined;
  const you = asRecord(record.you);
  const observerId = stringValue(you?.id, stringValue(record.agentId, fallbackObserverId));
  return {
    observerId,
    messages: rawMessages.filter(isSocialMessage)
  };
}

export function findCommittedMessage(committedMessages: Map<string, SocialMessage>, observedMessage: SocialMessage): SocialMessage | undefined {
  return committedMessages.get(`id:${observedMessage.id}`) ?? committedMessages.get(`seq:${observedMessage.seq}`);
}

export function findCommittedMessageByIndexes(
  messagesById: Map<string, SocialMessage>,
  messagesBySeq: Map<number, SocialMessage>,
  observedMessage: SocialMessage
): SocialMessage | undefined {
  const byId = messagesById.get(observedMessage.id);
  const bySeq = messagesBySeq.get(observedMessage.seq);
  if (byId && bySeq && byId.id !== bySeq.id) return undefined;
  return byId ?? bySeq;
}

export function validateMessageEnvelope(
  message: SocialMessage,
  channelsById: Map<string, SocialChannel>,
  label: string,
  errors: string[],
  runtimeActorIds?: ReadonlySet<string>
): void {
  const channel = channelsById.get(message.channelId);
  if (!channel) {
    errors.push(`${label}.channelId references unknown channel ${message.channelId}.`);
    return;
  }
  if (!channel.participantIds.includes(message.senderId) && channel.kind !== "system") {
    errors.push(`${label}.senderId ${message.senderId} is not in channel ${message.channelId}.`);
  }
  for (const recipientId of message.recipientIds) {
    if (!recipientIsAllowedInChannel(channel, recipientId, runtimeActorIds)) {
      errors.push(`${label}.recipientIds includes ${recipientId}, which is not allowed in channel ${message.channelId}.`);
    }
  }
  collectRuntimeAudienceSnapshotErrors({
    message,
    channel,
    defaultObserverIds: unscopedVisibleObserverIdsForMessage(
      message,
      channel,
      runtimeActorIds ? [...runtimeActorIds] : undefined
    ),
    label,
    errors
  });
  const expectedVisibility = expectedMessageVisibilityForChannel(channel);
  if (message.visibility !== expectedVisibility) {
    errors.push(
      `${label}.visibility ${message.visibility} is not compatible with ${channel.kind} channel ${message.channelId}; expected ${expectedVisibility}.`
    );
  }
}

export function validateSeqRange(
  range: [number, number] | undefined,
  messagesBySeq: Map<number, SocialMessage>,
  label: string,
  errors: string[]
): void {
  if (!range) return;
  if (!isSeqRange(range)) {
    errors.push(`${label} must be a positive integer [start, end] range with start <= end.`);
    return;
  }
  const [start, end] = range;
  for (let seq = start; seq <= end; seq += 1) {
    if (!messagesBySeq.has(seq)) errors.push(`${label} references missing social message seq ${seq}.`);
  }
}

export function validateSpeechActs(message: SocialMessage, label: string, errors: string[]): void {
  if (message.speechActs === undefined) return;
  if (!Array.isArray(message.speechActs)) {
    errors.push(`${label}.speechActs must be an array.`);
    return;
  }
  const ids = new Set<string>();
  for (const [index, act] of message.speechActs.entries()) {
    const actLabel = `${label}.speechActs[${index}]`;
    if (!act.id?.trim()) errors.push(`${actLabel}.id is missing.`);
    else if (ids.has(act.id)) errors.push(`${actLabel}.id duplicates ${act.id}.`);
    ids.add(act.id);
    if (!String(act.kind ?? "").trim()) errors.push(`${actLabel}.kind is missing.`);
    if (!Array.isArray(act.evidenceRefs)) errors.push(`${actLabel}.evidenceRefs must be an array.`);
  }
}

export function validateDeliveryReceipts(
  message: SocialMessage,
  channelsById: Map<string, SocialChannel>,
  label: string,
  errors: string[],
  runtimeActorIds?: readonly string[]
): void {
  const channel = channelsById.get(message.channelId);
  const expectedObservers = channel ? visibleObserverIdsForMessage(message, channel, runtimeActorIds) : [];
  if (message.deliveryReceipts === undefined) {
    if (runtimeActorIds && expectedObservers.length) {
      errors.push(`${label}.deliveryReceipts must record every runtime-visible observer.`);
    }
    return;
  }
  if (!Array.isArray(message.deliveryReceipts)) {
    errors.push(`${label}.deliveryReceipts must be an array.`);
    return;
  }
  const ids = new Set<string>();
  const observers = new Set<string>();
  for (const [index, receipt] of message.deliveryReceipts.entries()) {
    const receiptLabel = `${label}.deliveryReceipts[${index}]`;
    if (!receipt.id?.trim()) errors.push(`${receiptLabel}.id is missing.`);
    else if (ids.has(receipt.id)) errors.push(`${receiptLabel}.id duplicates ${receipt.id}.`);
    ids.add(receipt.id);
    if (receipt.messageId !== message.id) errors.push(`${receiptLabel}.messageId ${receipt.messageId} does not match ${message.id}.`);
    if (receipt.messageSeq !== message.seq) errors.push(`${receiptLabel}.messageSeq ${receipt.messageSeq} does not match ${message.seq}.`);
    if (receipt.channelId !== message.channelId) errors.push(`${receiptLabel}.channelId ${receipt.channelId} does not match ${message.channelId}.`);
    if (receipt.senderId !== message.senderId) errors.push(`${receiptLabel}.senderId ${receipt.senderId} does not match ${message.senderId}.`);
    if (!receipt.observerId?.trim()) errors.push(`${receiptLabel}.observerId is missing.`);
    else if (observers.has(receipt.observerId)) errors.push(`${receiptLabel}.observerId duplicates ${receipt.observerId}.`);
    observers.add(receipt.observerId);
    if (receipt.visibility !== message.visibility) errors.push(`${receiptLabel}.visibility ${receipt.visibility} does not match ${message.visibility}.`);
    if (!receipt.redactionPolicy?.trim()) errors.push(`${receiptLabel}.redactionPolicy is missing.`);
    if (!messageVisibleToObserver(message, receipt.observerId, channelsById, runtimeActorIds ? new Set(runtimeActorIds) : undefined)) {
      errors.push(`${receiptLabel}.observerId ${receipt.observerId} cannot see message ${message.id}/${message.seq}.`);
    }
  }
  const recordedObservers = [...observers].sort();
  if (
    recordedObservers.length !== expectedObservers.length ||
    recordedObservers.some((observerId, index) => observerId !== expectedObservers[index])
  ) {
    errors.push(`${label}.deliveryReceipts observer set does not match runtime visibility.`);
  }
}

export function isSeqRange(range: [number, number]): boolean {
  const [start, end] = range;
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start;
}
