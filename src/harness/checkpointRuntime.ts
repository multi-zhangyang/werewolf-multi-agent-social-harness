import {
  createGenericForkProvenance,
  validateHarnessCheckpointEnvelope,
  type CreateGenericForkProvenanceOptions,
  type GenericForkProvenance,
  type HarnessCheckpointEnvelope
} from "./episodeArtifacts";
import { runHarnessEpisode } from "./runner";
import {
  isSocialStepCommitted,
  type SocialActor,
  type SocialChannel,
  type SocialEnvironment,
  type SocialEpisodeArtifact,
  type SocialEpisodeOptions,
  type SocialMessage
} from "./social";
import { compareSocialDomainAdapterManifests, type SocialDomainAdapterManifest } from "./domainAdapter";

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
  /** Runtime identity checked before replay verification or restoration. */
  domainAdapter?: SocialDomainAdapterManifest;
  createEnvironment(initialState: TState): SocialEnvironment<TState, TObservation, TPending, TCommand>;
  restoreActors(agentStates: TAgentState[]): SocialActor<TObservation, TPending, TCommand>[];
  /**
   * Optional durable-state capture for a fork child. The generic fork runtime
   * owns when this runs: only after a child environment transition commits and
   * all actor receipts for that native boundary have been delivered. The
   * adapter supplies the domain-specific serialization because generic code
   * must not assume that a restored actor exposes a particular snapshot API.
   *
   * Supplying this keeps a child episode checkpointable and therefore allows
   * a verified recursive fork. Omitting it preserves the legacy behavior:
   * the child can still execute, but it records no actor-state restoration
   * authority for a subsequent fork.
   */
  captureAgentSnapshots?: (
    actors: readonly SocialActor<TObservation, TPending, TCommand>[]
  ) => TAgentState[] | undefined;
  /**
   * Explicit semantic validation of the recorded actor state before any
   * environment or actor restore factory is invoked. A state-bearing
   * checkpoint cannot silently opt out.
   */
  recordedAgentState:
    | {
        mode: "validate";
        validator: (
          checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand>
        ) => readonly string[];
      }
    | {
        mode: "none";
        reason: string;
      };
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
  const adapterErrors = compareSocialDomainAdapterManifests(
    options.checkpoint.executionPrefix.domainAdapter,
    options.runtime.domainAdapter,
    { recordedPath: "checkpoint execution adapter", runtimePath: "checkpoint runtime adapter" }
  );
  if (adapterErrors.length) {
    throw new Error(`Checkpoint adapter compatibility failed for ${options.checkpoint.checkpointId}: ${adapterErrors.join(" ")}`);
  }
  // A manifest-bearing checkpoint cannot silently fork into a new legacy
  // episode merely because a caller omitted the child field. The runtime
  // manifest is already proven compatible with the parent above, so it is the
  // truthful provenance to inherit for this continuation.
  const effectiveChildAdapter =
    options.episode.domainAdapter ??
    (options.checkpoint.executionPrefix.domainAdapter ? options.runtime.domainAdapter : undefined);
  if (effectiveChildAdapter) {
    const childAdapterErrors = compareSocialDomainAdapterManifests(
      options.runtime.domainAdapter,
      effectiveChildAdapter,
      { recordedPath: "checkpoint runtime adapter", runtimePath: "fork episode adapter" }
    );
    if (childAdapterErrors.length) {
      throw new Error(`Fork episode adapter compatibility failed for ${options.checkpoint.checkpointId}: ${childAdapterErrors.join(" ")}`);
    }
  }
  const recordedAgentStateErrors: string[] = [];
  if (options.runtime.recordedAgentState.mode === "none") {
    if (!options.runtime.recordedAgentState.reason.trim()) {
      recordedAgentStateErrors.push("recordedAgentState.mode=none requires a nonempty reason.");
    }
    if (options.checkpoint.agents.length > 0) {
      recordedAgentStateErrors.push(
        "recordedAgentState.mode=none is not allowed because the checkpoint records durable actor state."
      );
    }
  } else {
    recordedAgentStateErrors.push(...options.runtime.recordedAgentState.validator(structuredClone(options.checkpoint)));
  }
  if (recordedAgentStateErrors.length) {
    throw new Error(
      `Checkpoint recorded agent-state verification failed for ${options.checkpoint.checkpointId}: ${recordedAgentStateErrors.join(" ")}`
    );
  }
  const domainErrors = options.validateCheckpoint?.(options.checkpoint) ?? [];
  if (domainErrors.length) {
    throw new Error(`Invalid domain checkpoint ${options.checkpoint.checkpointId}: ${domainErrors.join(" ")}`);
  }
  const replayErrors = options.verifyCheckpointReplay(options.checkpoint);
  if (replayErrors.length) {
    throw new Error(`Checkpoint replay verification failed for ${options.checkpoint.checkpointId}: ${replayErrors.join(" ")}`);
  }
  const seed = buildSocialCheckpointForkSeed(options.checkpoint, options);
  // Restore exactly one actor registry for the child run. The optional
  // snapshot adapter receives this read-only roster only through the generic
  // runner's post-receipt capture hook; neither checkpoint restoration nor
  // replay verification is allowed to mutate child actor state.
  const restoredActors = options.runtime.restoreActors(structuredClone(seed.initialAgentStates));
  const childActors = Object.freeze([...restoredActors]);
  const socialEpisode = await runHarnessEpisode({
    ...options.episode,
    domainAdapter: effectiveChildAdapter,
    environment: options.runtime.createEnvironment(structuredClone(seed.initialState)),
    actors: restoredActors,
    channels: structuredClone(seed.initialSocialChannels),
    initialMessages: structuredClone(seed.initialSocialMessages),
    captureAgentSnapshots: options.runtime.captureAgentSnapshots
      ? () => options.runtime.captureAgentSnapshots?.(childActors)
      : undefined
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
  if (!boundary) {
    throw new Error(`Checkpoint ${checkpoint.checkpointId} is not forkable: final native boundary is missing.`);
  }
  if (!isSocialStepCommitted(boundary)) {
    throw new Error(
      `Checkpoint ${checkpoint.checkpointId} is not forkable: final native boundary was rejected and cannot restore durable actor state.`
    );
  }
  if (!boundary.actorSnapshotsHashAfterStep) {
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
