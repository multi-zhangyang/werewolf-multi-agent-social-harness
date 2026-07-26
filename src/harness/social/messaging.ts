import { asRecord, cloneJson, numberMetadata, stringMetadata } from "./valueUtils";
import { canObserveChannelAtRuntime, expectedMessageVisibilityForChannel, messageVisibleToObserver, recipientIsAllowedInChannel } from "./visibility";
import { type SocialChannel, type SocialDeliveryReceipt, type SocialEvidenceRef, type SocialMessage, type SocialSpeechAct, type SocialSpeechActKind } from "./contracts";
export class SocialCommunicationBus {
  private readonly channels = new Map<string, SocialChannel>();
  private readonly messages: SocialMessage[] = [];
  private readonly runtimeActorIds?: readonly string[];
  private readonly runtimeActorIdSet?: ReadonlySet<string>;

  constructor(
    channels: SocialChannel[] = [],
    initialMessages: SocialMessage[] = [],
    options: { runtimeActorIds?: readonly string[] } = {}
  ) {
    const roster = options.runtimeActorIds?.map((actorId) => actorId.trim());
    if (roster) {
      const seen = new Set<string>();
      for (const actorId of roster) {
        if (!actorId) throw new Error("Runtime actor roster contains an empty actor id.");
        if (seen.has(actorId)) throw new Error(`Runtime actor roster contains duplicate actor ${actorId}.`);
        seen.add(actorId);
      }
      this.runtimeActorIds = [...roster].sort();
      this.runtimeActorIdSet = new Set(this.runtimeActorIds);
    }
    for (const channel of channels) this.addChannel(channel);
    this.restoreMessages(initialMessages);
  }

  listChannels(): SocialChannel[] {
    return [...this.channels.values()].map(cloneJson);
  }

  listMessages(): SocialMessage[] {
    return this.messages.map(cloneJson);
  }

  addChannel(channel: SocialChannel): void {
    if (this.channels.has(channel.id)) throw new Error(`Duplicate social channel ${channel.id}.`);
    this.channels.set(channel.id, cloneJson(channel));
  }

  publish(message: Omit<SocialMessage, "id" | "seq" | "createdAt">): SocialMessage {
    return this.publishMany([message])[0];
  }

  publishMany(messages: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">>): SocialMessage[] {
    const records = this.prepareMessages(messages);
    this.messages.push(...records);
    return records.map(cloneJson);
  }

  validateMessages(messages: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">>): void {
    // Build the complete batch before the environment commits. This detects
    // serialization/speech-act failures while publication is still side-effect
    // free, and lets publishMany append the batch atomically.
    this.prepareMessages(messages);
  }

  private prepareMessages(messages: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">>): SocialMessage[] {
    for (const message of messages) this.validateMessage(message);
    const startingSeq = this.messages.at(-1)?.seq ?? 0;
    return messages.map((message, index) => {
      const seq = startingSeq + index + 1;
      const id = `msg-${seq}`;
      const draft = cloneJson(message);
      return {
        ...draft,
        id,
        seq,
        speechActs: normalizeSpeechActs(draft, id, seq),
        deliveryReceipts: deliveryReceiptsForMessage(draft, this.channels.get(draft.channelId), id, seq, this.runtimeActorIds),
        createdAt: deterministicMessageTimestamp(seq)
      };
    });
  }

  private restoreMessages(messages: SocialMessage[]): void {
    let expectedSeq = 1;
    const ids = new Set<string>();
    for (const message of messages) {
      if (!Number.isInteger(message.seq) || message.seq !== expectedSeq) {
        throw new Error(`Restored social message sequence must be contiguous from 1; expected ${expectedSeq}, received ${message.seq}.`);
      }
      if (!message.id) throw new Error(`Restored social message ${message.seq} is missing id.`);
      if (ids.has(message.id)) throw new Error(`Duplicate restored social message id ${message.id}.`);
      ids.add(message.id);
      this.validateMessage(message);
      this.messages.push(cloneJson(message));
      expectedSeq += 1;
    }
  }

  private validateMessage(message: Omit<SocialMessage, "id" | "seq" | "createdAt">): void {
    const channel = this.channels.get(message.channelId);
    if (!channel) throw new Error(`Unknown social channel ${message.channelId}.`);
    if (!channel.participantIds.includes(message.senderId) && channel.kind !== "system") {
      throw new Error(`Sender ${message.senderId} is not in channel ${message.channelId}.`);
    }
    for (const recipientId of message.recipientIds) {
      if (!recipientIsAllowedInChannel(channel, recipientId, this.runtimeActorIdSet)) {
        throw new Error(`Recipient ${recipientId} is not allowed in channel ${message.channelId}.`);
      }
    }
    assertRuntimeAudienceSnapshot({
      message,
      channel,
      defaultObserverIds: unscopedVisibleObserverIdsForMessage(message, channel, this.runtimeActorIds)
    });
    const expectedVisibility = expectedMessageVisibilityForChannel(channel);
    if (message.visibility !== expectedVisibility) {
      throw new Error(
        `Message visibility ${message.visibility} is not compatible with ${channel.kind} channel ${message.channelId}; expected ${expectedVisibility}.`
      );
    }
    const speechActs = message.speechActs;
    if (speechActs !== undefined && !Array.isArray(speechActs)) throw new Error(`Social message speechActs must be an array.`);
    const deliveryReceipts = message.deliveryReceipts;
    if (deliveryReceipts !== undefined && !Array.isArray(deliveryReceipts)) throw new Error(`Social message deliveryReceipts must be an array.`);
  }

  observe(agentId: string): { channels: SocialChannel[]; messages: SocialMessage[] } {
    const channels = [...this.channels.values()].filter((channel) =>
      canObserveChannelAtRuntime(channel, agentId, this.runtimeActorIdSet)
    );
    const channelIds = new Set(channels.map((channel) => channel.id));
    const messages = this.messages.filter((message) => {
      if (!channelIds.has(message.channelId)) return false;
      return messageVisibleToObserver(message, agentId, this.channels, this.runtimeActorIdSet);
    });
    return {
      channels: channels.map(cloneJson),
      messages: messages.map(cloneJson)
    };
  }
}


function deterministicMessageTimestamp(seq: number): string {
  return new Date(seq * 1000).toISOString();
}

function normalizeSpeechActs(
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">,
  messageId: string,
  messageSeq: number
): SocialSpeechAct[] | undefined {
  const explicitActs = Array.isArray(message.speechActs) ? message.speechActs : [];
  const derivedActs = speechActsFromStructuredSocialFacts(message);
  const acts = [...explicitActs, ...derivedActs];
  if (!acts.length) return undefined;
  return acts.map((act, index) => {
    const evidenceRef: SocialEvidenceRef = {
      artifact: "message",
      id: messageId,
      seq: messageSeq,
      description: message.channelId
    };
    const evidenceRefs = Array.isArray(act.evidenceRefs) && act.evidenceRefs.length ? cloneJson(act.evidenceRefs) : [evidenceRef];
    if (!evidenceRefs.some((ref) => ref.artifact === "message" && ref.id === messageId)) evidenceRefs.unshift(evidenceRef);
    return {
      ...cloneJson(act),
      id: act.id?.trim() ? act.id : `${messageId}:speech-act:${index + 1}`,
      evidenceRefs
    };
  });
}

function speechActsFromStructuredSocialFacts(message: Omit<SocialMessage, "id" | "seq" | "createdAt">): SocialSpeechAct[] {
  const metadata = asRecord(message.metadata);
  if (!metadata) return [];
  const acts: SocialSpeechAct[] = [];
  const evidenceRefs: SocialEvidenceRef[] = [];
  for (const fact of socialFactsFromMetadata(metadata)) {
    const factKind = stringMetadata(fact.kind);
    const actKind = speechActKindFromSocialFact(factKind);
    if (!actKind) continue;
    acts.push({
      id: "",
      kind: actKind,
      subjectId: stringMetadata(fact.actorId) ?? stringMetadata(fact.speakerId) ?? stringMetadata(fact.subjectId) ?? message.senderId,
      targetId: stringMetadata(fact.targetId),
      value: fact.claim ?? fact.stance ?? fact.sharedGoal ?? fact.expectedBehavior ?? fact.status ?? factKind,
      confidence: numberMetadata(fact.confidence),
      evidenceRefs,
      metadata: { source: "metadata.socialFacts", factKind, factId: stringMetadata(fact.id) }
    });
  }
  return acts;
}

function deliveryReceiptsForMessage(
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">,
  channel: SocialChannel | undefined,
  messageId: string,
  messageSeq: number,
  runtimeActorIds?: readonly string[]
): SocialDeliveryReceipt[] | undefined {
  if (!channel || message.visibility === "postgame") return undefined;
  const observerIds = visibleObserverIdsForMessage(message, channel, runtimeActorIds);
  if (!observerIds.length) return undefined;
  const turnIndex = numberMetadata(asRecord(message.metadata)?.turnIndex);
  return observerIds.map((observerId, index) => ({
    id: `${messageId}:delivery:${index + 1}:${observerId}`,
    messageId,
    messageSeq,
    channelId: message.channelId,
    senderId: message.senderId,
    observerId,
    visibility: message.visibility,
    deliveredAtTurn: turnIndex,
    redactionPolicy: `runtime-visible:${message.visibility}`
  }));
}

export function visibleObserverIdsForMessage(
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">,
  channel: SocialChannel,
  runtimeActorIds?: readonly string[]
): string[] {
  const defaultObserverIds = unscopedVisibleObserverIdsForMessage(message, channel, runtimeActorIds);
  const runtimeAudienceIds = message.runtimeAudienceIds;
  // No snapshot is the backwards-compatible artifact semantics: visibility is
  // determined only by the durable channel topology.  A supplied snapshot is
  // fixed at publication and can only narrow that topology.
  if (runtimeAudienceIds === undefined) return defaultObserverIds;
  const audience = new Set(runtimeAudienceIds);
  return defaultObserverIds.filter((observerId) => audience.has(observerId));
}

export function unscopedVisibleObserverIdsForMessage(
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">,
  channel: SocialChannel,
  runtimeActorIds?: readonly string[]
): string[] {
  if (message.visibility === "postgame" || channel.readableBy === "postgame") return [];
  if (message.visibility === "private") {
    return [...new Set([message.senderId, ...message.recipientIds])].filter((observerId) => observerId.trim()).sort();
  }
  if ((channel.kind === "public" || channel.kind === "system") && channel.readableBy === "all" && runtimeActorIds) {
    return [...runtimeActorIds].filter((observerId) => observerId.trim()).sort();
  }
  return [...new Set(channel.participantIds)].filter((observerId) => observerId.trim()).sort();
}

function assertRuntimeAudienceSnapshot(input: {
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">;
  channel: SocialChannel;
  defaultObserverIds: readonly string[];
}): void {
  const errors: string[] = [];
  collectRuntimeAudienceSnapshotErrors({ ...input, label: "Social message", errors });
  if (errors.length) throw new Error(errors.join(" "));
}

export function collectRuntimeAudienceSnapshotErrors(input: {
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">;
  channel: SocialChannel;
  defaultObserverIds: readonly string[];
  label: string;
  errors: string[];
}): void {
  const runtimeAudienceIds = input.message.runtimeAudienceIds;
  if (runtimeAudienceIds === undefined) return;
  if (!Array.isArray(runtimeAudienceIds)) {
    input.errors.push(`${input.label}.runtimeAudienceIds must be an array when recorded.`);
    return;
  }

  const audienceIds = runtimeAudienceIds;
  const seen = new Set<string>();
  const allowed = new Set(input.defaultObserverIds);
  for (const [index, observerId] of audienceIds.entries()) {
    if (typeof observerId !== "string" || !observerId.trim()) {
      input.errors.push(`${input.label}.runtimeAudienceIds[${index}] must be a non-empty actor id.`);
      continue;
    }
    if (seen.has(observerId)) {
      input.errors.push(`${input.label}.runtimeAudienceIds duplicates ${observerId}.`);
    }
    seen.add(observerId);
    if (!allowed.has(observerId)) {
      input.errors.push(`${input.label}.runtimeAudienceIds includes ${observerId}, which is not runtime-visible in channel ${input.channel.id}.`);
    }
  }

  const canonical = [...audienceIds].sort();
  if (canonical.some((observerId, index) => observerId !== audienceIds[index])) {
    input.errors.push(`${input.label}.runtimeAudienceIds must be sorted for canonical artifact identity.`);
  }
  if (allowed.has(input.message.senderId) && !seen.has(input.message.senderId)) {
    input.errors.push(`${input.label}.runtimeAudienceIds must include sender ${input.message.senderId}.`);
  }
  for (const recipientId of input.message.recipientIds) {
    if (!seen.has(recipientId)) {
      input.errors.push(`${input.label}.runtimeAudienceIds must include recipient ${recipientId}.`);
    }
  }
}

function speechActKindFromSocialFact(kind: string | undefined): SocialSpeechActKind | undefined {
  if (kind === "commitment" || kind === "commitment-status") return "commitment";
  if (kind === "coalition" || kind === "coalition-evidence") return "coalition_signal";
  if (kind === "gossip") return "claim";
  if (kind === "norm-sanction" || kind === "norm-sanction-status") return "threat";
  if (kind === "trust-repair" || kind === "trust-repair-status") return "trust_repair";
  if (kind === "betrayal" || kind === "betrayal-evidence") return "claim";
  return undefined;
}

function socialFactsFromMetadata(metadata: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(metadata.socialFacts) ? metadata.socialFacts.flatMap((item) => (asRecord(item) ? [asRecord(item)!] : [])) : [];
}
