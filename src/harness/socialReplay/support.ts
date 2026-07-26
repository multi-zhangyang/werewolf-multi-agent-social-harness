import { isSocialParallelJointStep, isSocialStepCommitted, type SocialEnvironment, type SocialHarnessStep, type SocialParallelEnvironment } from "../social";
import { type HarnessEpisodeArtifactEnvelope, resolveHarnessAgentSnapshotFrame } from "../episodeArtifacts";
/**
 * Canonical state-bearing artifacts must provide one resolvable durable actor
 * snapshot for every completed receipt boundary. A joint parallel transition
 * is one boundary, while environment-owned system transitions are not actor
 * receipts and therefore do not manufacture actor-state evidence.
 */
export function committedActorSnapshotBoundaryErrors<
  TState,
  TObservation,
  TPending,
  TCommand,
  TAgentState,
  TForkProvenance extends import("../episodeArtifacts").GenericForkProvenance | undefined
>(
  artifact: HarnessEpisodeArtifactEnvelope<TState, TObservation, TPending, TCommand, TAgentState, TForkProvenance>
): string[] {
  const errors: string[] = [];
  const steps = artifact.socialEpisode.steps;
  for (let index = 0; index < steps.length; ) {
    const first = steps[index];
    if (!first) break;
    const batch = isSocialParallelJointStep(first) ? contiguousParallelBatch(steps, index) : [first];
    const boundary = batch.at(-1)!;
    const isCommittedActorReceipt =
      batch.every((step) => isSocialStepCommitted(step)) &&
      batch.some((step) => step.actorId !== "system" && step.resolutionPolicy !== "system-transition");
    if (isCommittedActorReceipt) {
      const hasInlineSnapshot =
        Array.isArray(boundary.actorSnapshotsAfterStep) &&
        typeof boundary.actorSnapshotsHashAfterStep === "string";
      const hasResolvedFrame = Boolean(
        artifact.agentSnapshotFrames &&
        resolveHarnessAgentSnapshotFrame({ frames: artifact.agentSnapshotFrames, step: boundary })
      );
      if (!hasInlineSnapshot && !hasResolvedFrame) {
        errors.push(
          `Native step ${index + batch.length - 1} ${boundary.traceId}: committed actor receipt boundary is missing a resolvable durable actor snapshot.`
        );
      }
    }
    index += batch.length;
  }
  return errors;
}

export function contiguousParallelBatch<TObservation, TPending, TCommand>(
  steps: Array<SocialHarnessStep<TObservation, TPending, TCommand>>,
  startIndex: number
): Array<SocialHarnessStep<TObservation, TPending, TCommand>> {
  const first = steps[startIndex];
  if (!first?.batchId) return first ? [first] : [];
  const batch: Array<SocialHarnessStep<TObservation, TPending, TCommand>> = [];
  for (let index = startIndex; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.batchId !== first.batchId) break;
    batch.push(step);
  }
  return batch;
}

export function isParallelEnvironment<TState, TObservation, TPending, TCommand>(
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>
): environment is SocialParallelEnvironment<TState, TObservation, TPending, TCommand> {
  return typeof (environment as Partial<SocialParallelEnvironment<TState, TObservation, TPending, TCommand>>).stepBatch === "function";
}

export function numericRange(before: number | undefined, after: number | undefined): [number, number] | undefined {
  if (before === undefined || after === undefined || after <= before) return undefined;
  return [before + 1, after];
}

export function sameOptionalRange(left: [number, number] | undefined, right: [number, number] | undefined): boolean {
  if (!left || !right) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}

export function formatRange(range: [number, number] | undefined): string {
  return range ? range.join("-") : "none";
}

