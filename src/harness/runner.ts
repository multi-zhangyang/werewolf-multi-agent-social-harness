import { hashStableState } from "./hash";
import { runSocialEpisode, type SocialEpisodeArtifact, type SocialEpisodeOptions } from "./social";

/**
 * Optional durable-state capture for generic harness artifacts.  It is called
 * only after the social runner has committed the environment transition and
 * delivered actor receipts (for a parallel batch, after the complete receipt
 * set). The
 * callback must be pure, serializable, and must not call a reasoner/provider.
 */
export type HarnessAgentSnapshotProvider<TAgentState> = () => TAgentState[] | undefined;

export interface HarnessEpisodeOptions<TState, TObservation, TPending extends { actorId?: string }, TCommand, TAgentState = unknown>
  extends SocialEpisodeOptions<TState, TObservation, TPending, TCommand> {
  captureAgentSnapshots?: HarnessAgentSnapshotProvider<TAgentState>;
}

/**
 * Domain-neutral harness entry point. Domain adapters provide the environment,
 * actors, observations, commands, and optional scheduler hooks; this function
 * only delegates to the generic social execution contract.
 */
export async function runHarnessEpisode<
  TState,
  TObservation,
  TPending extends { actorId?: string },
  TCommand,
  TAgentState = unknown
>(
  options: HarnessEpisodeOptions<TState, TObservation, TPending, TCommand, TAgentState>
): Promise<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>> {
  const { captureAgentSnapshots, afterEnvironmentStep, ...socialOptions } = options;
  // Preserve the direct social runner path byte-for-byte when generic snapshot
  // capture is not requested.  Several domain adapters already use the
  // post-commit hook for their richer frame registries.
  if (!captureAgentSnapshots) return runSocialEpisode(options);

  const snapshotsByTraceId = new Map<string, { agents: TAgentState[]; agentsHash: string }>();
  const episode = await runSocialEpisode({
    ...socialOptions,
    afterEnvironmentStep(context) {
      // Preserve existing domain hooks.  If they fail, the social runner
      // records the post-commit failure and no snapshot is falsely advertised
      // as fork authority for that boundary.
      afterEnvironmentStep?.(context);
      const traceId = context.action.traceId;
      if (!traceId) throw new Error("Committed harness action is missing its runner-owned trace id.");
      const agents = captureAgentSnapshots();
      if (agents === undefined) return;
      const snapshot = structuredClone(agents);
      snapshotsByTraceId.set(traceId, {
        agents: snapshot,
        agentsHash: hashStableState(snapshot)
      });
    }
  });
  for (const step of episode.steps) {
    const snapshot = snapshotsByTraceId.get(step.traceId);
    if (!snapshot) continue;
    step.actorSnapshotsAfterStep = structuredClone(snapshot.agents);
    step.actorSnapshotsHashAfterStep = snapshot.agentsHash;
  }
  return episode;
}
