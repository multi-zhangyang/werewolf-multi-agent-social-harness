import { asRecord } from "./valueUtils";
import { type SocialChannel, type SocialMessage } from "./contracts";
export function canObserveChannelAtRuntime(
  channel: SocialChannel,
  observerId: string,
  runtimeActorIds?: ReadonlySet<string>
): boolean {
  if (channel.readableBy === "postgame") return false;
  // `all` is meaningful only for table/system broadcasts. A malformed team
  // or private channel must not widen hidden topology by changing this field.
  if (channel.kind === "team" || channel.kind === "private") return channel.participantIds.includes(observerId);
  if (channel.readableBy === "all") {
    return runtimeActorIds ? runtimeActorIds.has(observerId) : channel.participantIds.includes(observerId);
  }
  return channel.participantIds.includes(observerId);
}

export function recipientIsAllowedInChannel(
  channel: SocialChannel,
  recipientId: string,
  runtimeActorIds?: ReadonlySet<string>
): boolean {
  if (channel.participantIds.includes(recipientId)) return true;
  // A public/system `all` channel's effective topology is the immutable run
  // roster. Recipient ids remain audit metadata only; they cannot turn a
  // broadcast into a direct message or authorize an actor outside that roster.
  return (
    (channel.kind === "public" || channel.kind === "system") &&
    channel.readableBy === "all" &&
    Boolean(runtimeActorIds?.has(recipientId))
  );
}

export function expectedMessageVisibilityForChannel(channel: SocialChannel): SocialMessage["visibility"] {
  if (channel.readableBy === "postgame") return "postgame";
  if (channel.kind === "public" || channel.kind === "system") return "public";
  if (channel.kind === "team") return "team";
  return "private";
}


export function messageVisibleToObserver(
  message: SocialMessage,
  observerId: string,
  channelsById: Map<string, SocialChannel>,
  runtimeActorIds?: ReadonlySet<string>
): boolean {
  const channel = channelsById.get(message.channelId);
  if (!channel) return false;
  if (!canObserveChannelAtRuntime(channel, observerId, runtimeActorIds)) return false;
  if (message.visibility === "postgame") return false;
  const visibleByChannel =
    message.visibility === "public" || message.visibility === "team"
      ? true
      : message.senderId === observerId || message.recipientIds.includes(observerId);
  if (!visibleByChannel) return false;
  return message.runtimeAudienceIds === undefined || message.runtimeAudienceIds.includes(observerId);
}

export function isSocialMessage(value: unknown): value is SocialMessage {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.seq === "number" &&
      typeof record.channelId === "string" &&
      typeof record.senderId === "string" &&
      Array.isArray(record.recipientIds) &&
      typeof record.visibility === "string" &&
      typeof record.createdAt === "string"
  );
}
