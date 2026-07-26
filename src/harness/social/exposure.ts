import { cloneJson, stringMetadata } from "./valueUtils";
import { extractObservedSocialMessages, findCommittedMessage } from "./messageValidation";
import { SOCIAL_EXPOSURE_SUMMARY_VERSION, type SocialEpisodeArtifact, type SocialExposureRecord, type SocialExposureSummary, type SocialHarnessStep, type SocialMessage, type SocialStepCommitCounts } from "./contracts";
/**
 * Whether a native social step is committed for progress/replay filtering.
 * Legacy steps without commitStatus treat absence of error as committed.
 */
export function isSocialStepCommitted(
  step: Pick<SocialHarnessStep, "commitStatus" | "error">
): boolean {
  if (step.commitStatus === "committed") return true;
  if (step.commitStatus === "rejected") return false;
  // Missing/unknown commitStatus: absence of error is treated as committed.
  return !step.error;
}

/**
 * A non-atomic environment failure means a domain adapter mutated state and
 * then threw before it could return a committed result. The record is useful
 * failure evidence, but it cannot be deterministic replay authority.
 */
export function isSocialStepNonReplayableFailure(
  step: Pick<SocialHarnessStep, "failure">
): boolean {
  return step.failure?.stage === "environment_non_atomic_failure";
}

/**
 * Count native social-episode steps by commit status.
 * Legacy steps without commitStatus treat absence of error as committed.
 */
export function countSocialStepCommits(
  steps: ReadonlyArray<Pick<SocialHarnessStep, "commitStatus" | "error">>
): SocialStepCommitCounts {
  let committedSteps = 0;
  let rejectedSteps = 0;
  for (const step of steps) {
    if (isSocialStepCommitted(step)) committedSteps += 1;
    else rejectedSteps += 1;
  }
  return {
    nativeSteps: steps.length,
    committedSteps,
    rejectedSteps
  };
}

/**
 * Count native social-episode steps by actor, excluding system transitions.
 * Shared by agents.csv, match CLI agent summaries, and other actor-level density surfaces.
 */
export function countSocialStepCommitsByActor(
  steps: ReadonlyArray<Pick<SocialHarnessStep, "actorId" | "commitStatus" | "error">>
): Map<string, SocialStepCommitCounts> {
  const byActor = new Map<string, SocialStepCommitCounts>();
  for (const step of steps) {
    if (step.actorId === "system") continue;
    const current = byActor.get(step.actorId) ?? {
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0
    };
    current.nativeSteps += 1;
    if (isSocialStepCommitted(step)) current.committedSteps += 1;
    else current.rejectedSteps += 1;
    byActor.set(step.actorId, current);
  }
  return byActor;
}

export function deriveSocialExposureRecords<TState, TObservation, TPending, TCommand>(
  episode: Pick<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>, "steps" | "messages">,
  options: { includeSelf?: boolean } = {}
): SocialExposureRecord[] {
  const committedMessages = new Map<string, SocialMessage>();
  for (const message of episode.messages) {
    committedMessages.set(`id:${message.id}`, message);
    committedMessages.set(`seq:${message.seq}`, message);
  }

  const records: SocialExposureRecord[] = [];
  const seen = new Set<string>();
  for (const step of episode.steps) {
    const observed = extractObservedSocialMessages(step);
    if (!observed) continue;
    for (const observedMessage of observed.messages) {
      const message = findCommittedMessage(committedMessages, observedMessage);
      if (!message) continue;
      // Exposure is derived from recorded observation, but a newer immutable
      // message audience is still a hard visibility boundary.  This keeps
      // defensive consumers from materializing an exposure from a forged
      // observation while preserving legacy artifacts that have no snapshot.
      if (message.runtimeAudienceIds !== undefined && !message.runtimeAudienceIds.includes(observed.observerId)) continue;
      if (!options.includeSelf && message.senderId === observed.observerId) continue;
      const key = `${message.id}:${observed.observerId}:${step.traceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const deliveryReceipt = message.deliveryReceipts?.find((receipt) => receipt.observerId === observed.observerId);
      records.push({
        messageId: message.id,
        messageSeq: message.seq,
        sourceId: message.senderId,
        observerId: observed.observerId,
        observedAtTraceId: step.traceId,
        observedAtTurnIndex: step.turnIndex,
        observedAtActionKind: step.action.kind,
        channelId: message.channelId,
        visibility: message.visibility,
        kind: stringMetadata(message.metadata?.kind),
        deliveryReceipt: deliveryReceipt ? cloneJson(deliveryReceipt) : undefined,
        evidenceRefs: [
          {
            artifact: "message",
            id: message.id,
            seq: message.seq,
            description: message.channelId
          },
          ...(deliveryReceipt
            ? [
                {
                  artifact: "delivery_receipt" as const,
                  id: deliveryReceipt.id,
                  seq: message.seq,
                  description: `${deliveryReceipt.redactionPolicy}:${deliveryReceipt.observerId}`
                }
              ]
            : []),
          {
            artifact: "trace",
            traceId: step.traceId,
            seq: step.turnIndex,
            description: step.action.kind
          },
          {
            artifact: "observation",
            traceId: step.traceId,
            seq: step.turnIndex,
            description: `scoped social observation for ${observed.observerId}`
          }
        ]
      });
    }
  }
  return records;
}

/**
 * Build the canonical, unredacted summary for a cached exposure sidecar. This
 * function is deliberately separate from server projection summaries: public
 * projections redact private evidence and therefore use their own schema.
 */
export function summarizeSocialExposureRecords(records: readonly SocialExposureRecord[]): SocialExposureSummary {
  const byVisibility: Record<SocialMessage["visibility"], number> = {
    private: 0,
    team: 0,
    public: 0,
    postgame: 0
  };
  for (const record of records) byVisibility[record.visibility] += 1;
  return {
    schemaVersion: SOCIAL_EXPOSURE_SUMMARY_VERSION,
    source: "scoped_observation",
    privateEvidenceRedacted: false,
    recordCount: records.length,
    messageCount: new Set(records.map((record) => record.messageId)).size,
    sourceCount: new Set(records.map((record) => record.sourceId)).size,
    observerCount: new Set(records.map((record) => record.observerId)).size,
    byVisibility
  };
}
