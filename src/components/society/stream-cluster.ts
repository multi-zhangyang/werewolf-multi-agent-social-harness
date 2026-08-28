import type { SocialMessage } from "@/society/contracts";

/**
 * Chat-app grouping: an actor's consecutive messages (nothing in between,
 * same channel, within the window) stack into one card so a monologue reads
 * as one utterance instead of card spam.
 */

/** Max gap between two messages that still counts as one continuous burst. */
export const CLUSTER_WINDOW_MS = 15 * 60_000;

export function belongsToCluster(previous: SocialMessage, next: SocialMessage): boolean {
  return next.senderId === previous.senderId
    && next.channel === previous.channel
    && Date.parse(next.createdAt) - Date.parse(previous.createdAt) <= CLUSTER_WINDOW_MS;
}
