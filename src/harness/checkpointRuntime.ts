import {
  createGenericForkProvenance,
  validateHarnessCheckpointEnvelope,
  type CreateGenericForkProvenanceOptions,
  type GenericForkProvenance,
  type HarnessCheckpointEnvelope
} from "./episodeArtifacts";
import { runHarnessEpisode } from "./runner";
import type {
  SocialActor,
  SocialChannel,
  SocialEnvironment,
  SocialEpisodeArtifact,
  SocialEpisodeOptions,
  SocialMessage
} from "./social";

/**
 * Domain-neutral continuation input reconstructed from a checkpoint.  It is
 * intentionally data-only: a domain runtime supplies environment and actor
 * restoration, while policy closures, model clients, and other live runtime
 * dependencies remain outside persistent artifacts.
 */
export interface SocialCheckpointForkSeed<TState, TAgentState> {
  initialState: TState;
  initialAgentStates: TAgentState[];
  initialSocialChannels: SocialChannel[];
  initialSocialMessages: SocialMessage[];
  forkOf: GenericForkProvenance;
}

export interface SocialCheckpointRuntimeAdapter<TState, TAgentState, TObservation, TPending, TCommand> {
  createEnvironment(initialState: TState): SocialEnvironment<TState, TObservation, TPending, TCommand>;
  restoreActors(agentStates: TAgentState[]): SocialActor<TObservation, TPending, TCommand>[];
}

export interface RunForkedHarnessEpisodeOptions<TState, TAgentState, TObservation, TPending extends { actorId?: string }, TCommand>
  extends CreateGenericForkProvenanceOptions {
  checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand>;
  runtime: SocialCheckpointRuntimeAdapter<TState, TAgentState, TObservation, TPending, TCommand>;
  /**
   * Required model-free replay gate for a persisted checkpoint prefix. The
   * generic runtime cannot construct a domain environment itself, so the
   * domain supplies this deterministic verifier instead of an implicit trust
   * exception. It runs before environment or actor restoration.
   */
  verifyCheckpointReplay: (
    checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand>
  ) => readonly string[];
  /**
   * All normal scheduler, observation, validation, and trace hooks remain
   * domain-owned.  The fork seed owns only state, actors, and social history.
   */
  episode: Omit<SocialEpisodeOptions<TState, TObservation, TPending, TCommand>, "environment" | "actors" | "channels" | "initialMessages">;
  /** Add domain-specific checkpoint semantics (roles, evidence, etc.) without coupling generic runtime to a domain. */
  validateCheckpoint?: (
    checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand>
  ) => readonly string[];
}

export interface ForkedHarnessEpisodeResult<TState, TObservation, TPending, TCommand, TAgentState> {
  seed: SocialCheckpointForkSeed<TState, TAgentState>;
  socialEpisode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
}

export function buildSocialCheckpointForkSeed<TState, TAgentState, TObservation, TPending, TCommand>(
  checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand>,
  options: CreateGenericForkProvenanceOptions = {}
): SocialCheckpointForkSeed<TState, TAgentState> {
  assertStructurallyValidCheckpoint(checkpoint);
  assertForkableRecordedActorBoundary(checkpoint);
  return {
    initialState: structuredClone(checkpoint.state),
    initialAgentStates: structuredClone(checkpoint.agents),
    initialSocialChannels: structuredClone(checkpoint.executionPrefix.channels),
    initialSocialMessages: structuredClone(checkpoint.executionPrefix.messages),
    forkOf: createGenericForkProvenance(checkpoint, options)
  };
}

/**
 * Execute an actual domain continuation from recorded checkpoint authority.
 * This function neither calls a model nor decides how an actor restores its
 * policy/reasoner; those are explicit concerns of the supplied adapter.
 */
export async function runForkedHarnessEpisode<TState, TAgentState, TObservation, TPending extends { actorId?: string }, TCommand>(
  options: RunForkedHarnessEpisodeOptions<TState, TAgentState, TObservation, TPending, TCommand>
): Promise<ForkedHarnessEpisodeResult<TState, TObservation, TPending, TCommand, TAgentState>> {
  assertStructurallyValidCheckpoint(options.checkpoint);
  assertForkableRecordedActorBoundary(options.checkpoint);
  const domainErrors = options.validateCheckpoint?.(options.checkpoint) ?? [];
  if (domainErrors.length) {
    throw new Error(`Invalid domain checkpoint ${options.checkpoint.checkpointId}: ${domainErrors.join(" ")}`);
  }
  const replayErrors = options.verifyCheckpointReplay(options.checkpoint);
  if (replayErrors.length) {
    throw new Error(`Checkpoint replay verification failed for ${options.checkpoint.checkpointId}: ${replayErrors.join(" ")}`);
  }
  const seed = buildSocialCheckpointForkSeed(options.checkpoint, options);
  const socialEpisode = await runHarnessEpisode({
    ...options.episode,
    environment: options.runtime.createEnvironment(structuredClone(seed.initialState)),
    actors: options.runtime.restoreActors(structuredClone(seed.initialAgentStates)),
    channels: structuredClone(seed.initialSocialChannels),
    initialMessages: structuredClone(seed.initialSocialMessages)
  });
  return { seed, socialEpisode };
}

function assertStructurallyValidCheckpoint<TState, TAgentState, TObservation, TPending, TCommand>(
  checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand>
): void {
  const errors = validateHarnessCheckpointEnvelope(checkpoint);
  if (errors.length) throw new Error(`Invalid harness checkpoint ${checkpoint.checkpointId}: ${errors.join(" ")}`);
}

/**
 * Persistence of a failed/environment-only checkpoint is useful for audit and
 * replay, but restoration is a stronger authority. Never hand actor state to
 * a domain restore factory unless the selected final native boundary recorded
 * exactly that durable state.
 */
function assertForkableRecordedActorBoundary<TState, TAgentState, TObservation, TPending, TCommand>(
  checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand>
): void {
  const boundary = checkpoint.executionPrefix.steps.at(-1);
  if (!boundary?.actorSnapshotsHashAfterStep) {
    throw new Error(
      `Checkpoint ${checkpoint.checkpointId} is not forkable: final native boundary has no recorded durable actor snapshot.`
    );
  }
  if (boundary.actorSnapshotsHashAfterStep !== checkpoint.source.agentsHash) {
    throw new Error(
      `Checkpoint ${checkpoint.checkpointId} is not forkable: final boundary actor snapshot hash does not match source.agentsHash.`
    );
  }
  if (boundary.actorSnapshotFrameIdAfterStep !== checkpoint.source.agentSnapshotFrameId) {
    throw new Error(
      `Checkpoint ${checkpoint.checkpointId} is not forkable: final boundary actor snapshot frame id does not match source.agentSnapshotFrameId.`
    );
  }
}
