import {
  isSafeHarnessCheckpointBoundary,
  latestMessageSeqForHarnessPrefix,
  validateHarnessCheckpointEnvelope
} from "../episodeArtifacts";
import type {
  GenericExperimentProvenanceV1,
  NormalizedGenericExperimentSpecV1
} from "../experimentSpec";
import { hashStableJsonValue, hashStableState } from "../hash";
import { isSocialStepCommitted } from "../social";
import type {
  ExecutedGenericExperimentEpisode,
  GenericCheckpointEnvelope,
  GenericEpisodeEnvelope,
  GenericExperimentArtifactStore,
  GenericExperimentEpisodeContext,
  GenericExperimentNativeCheckpointBoundary
} from "./types";
import { createEpisodeContext } from "./bindings";
import { awaitWithAbort, throwIfAborted } from "./control";

export function assertCheckpointPolicyRuntime<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(
  options: {
    adapter: { checkpointing?: GenericCheckpointingAdapter<TArtifact, TCheckpoint> };
    artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  },
  spec: NormalizedGenericExperimentSpecV1
): void {
  if (spec.checkpointPolicy.mode === "none") return;
  if (
    spec.checkpointPolicy.mode === "final" &&
    !options.adapter.checkpointing?.finalCheckpointForArtifact
  ) {
    throw new Error("Generic experiment checkpointPolicy final requires a deterministic final checkpoint builder.");
  }
  if (
    spec.checkpointPolicy.mode === "native-boundaries" &&
    !options.adapter.checkpointing?.nativeCheckpointForArtifactBoundary
  ) {
    throw new Error(
      "Generic experiment checkpointPolicy native-boundaries requires a deterministic native-boundary checkpoint builder."
    );
  }
  if (
    typeof options.artifactStore.putCheckpoint !== "function" ||
    typeof options.artifactStore.getCheckpoint !== "function"
  ) {
    throw new Error(
      `Generic experiment checkpointPolicy ${spec.checkpointPolicy.mode} requires canonical checkpoint read/write authority.`
    );
  }
}

interface GenericCheckpointingAdapter<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
> {
  finalCheckpointForArtifact?(
    artifact: TArtifact,
    context: GenericExperimentEpisodeContext
  ): TCheckpoint | Promise<TCheckpoint>;
  nativeCheckpointForArtifactBoundary?(
    artifact: TArtifact,
    boundary: GenericExperimentNativeCheckpointBoundary,
    context: GenericExperimentEpisodeContext
  ): TCheckpoint | Promise<TCheckpoint>;
}

export async function ensurePolicyCheckpointsForEpisodes<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(input: {
  episodes: Array<{
    index: number;
    seed: string;
    result?: ExecutedGenericExperimentEpisode<TArtifact>;
  }>;
  options: {
    adapter: { checkpointing?: GenericCheckpointingAdapter<TArtifact, TCheckpoint> };
    artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  };
  spec: NormalizedGenericExperimentSpecV1;
  experiment: GenericExperimentProvenanceV1;
  abortSignal: AbortSignal;
}): Promise<void> {
  if (input.spec.checkpointPolicy.mode === "none") return;
  for (const episode of input.episodes) {
    if (!episode.result) continue;
    await ensurePolicyCheckpointsForArtifact({
      artifact: episode.result.artifact,
      context: createEpisodeContext(episode, input.spec, input.experiment, input.abortSignal),
      options: input.options,
      spec: input.spec
    });
  }
}

export async function ensurePolicyCheckpointsForArtifact<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(input: {
  artifact: TArtifact;
  context: GenericExperimentEpisodeContext;
  options: {
    adapter: { checkpointing?: GenericCheckpointingAdapter<TArtifact, TCheckpoint> };
    artifactStore: GenericExperimentArtifactStore<TArtifact, TCheckpoint>;
  };
  spec: NormalizedGenericExperimentSpecV1;
}): Promise<void> {
  if (input.spec.checkpointPolicy.mode === "none") return;
  const getCheckpoint = input.options.artifactStore.getCheckpoint?.bind(input.options.artifactStore);
  const putCheckpoint = input.options.artifactStore.putCheckpoint?.bind(input.options.artifactStore);
  if (!getCheckpoint || !putCheckpoint) {
    throw new Error("Generic experiment checkpoint authority disappeared after preflight validation.");
  }
  const expectedExperiment = structuredClone(input.context.experiment);
  const checkpointContext: GenericExperimentEpisodeContext = {
    ...input.context,
    spec: structuredClone(input.context.spec),
    experiment: structuredClone(expectedExperiment)
  };

  if (input.spec.checkpointPolicy.mode === "final") {
    const builder = input.options.adapter.checkpointing?.finalCheckpointForArtifact;
    if (!builder) throw new Error("Generic experiment final checkpoint builder disappeared after preflight validation.");
    const checkpoint = structuredClone(await awaitWithAbort(
      () => builder(structuredClone(input.artifact), structuredClone(checkpointContext)),
      input.context.abortSignal
    ));
    assertFinalCheckpointBinding(checkpoint, input.artifact, expectedExperiment);
    await publishCheckpointCandidate({
      checkpoint,
      artifact: input.artifact,
      experiment: expectedExperiment,
      getCheckpoint,
      putCheckpoint,
      abortSignal: input.context.abortSignal,
      assertBinding: assertFinalCheckpointBinding,
      policyLabel: "final"
    });
    return;
  }

  const builder = input.options.adapter.checkpointing?.nativeCheckpointForArtifactBoundary;
  if (!builder) throw new Error("Generic experiment native-boundary checkpoint builder disappeared after preflight validation.");
  for (const [stepIndex, step] of input.artifact.socialEpisode.steps.entries()) {
    if (!isSocialStepCommitted(step) || !isSafeHarnessCheckpointBoundary(input.artifact.socialEpisode.steps, stepIndex)) {
      continue;
    }
    const boundary: GenericExperimentNativeCheckpointBoundary = {
      nativeStepCount: stepIndex + 1,
      traceId: step.traceId
    };
    const checkpoint = structuredClone(await awaitWithAbort(
      () => builder(
        structuredClone(input.artifact),
        structuredClone(boundary),
        structuredClone(checkpointContext)
      ),
      input.context.abortSignal
    ));
    assertNativeCheckpointBinding(checkpoint, input.artifact, expectedExperiment, boundary);
    await publishCheckpointCandidate({
      checkpoint,
      artifact: input.artifact,
      experiment: expectedExperiment,
      getCheckpoint,
      putCheckpoint,
      abortSignal: input.context.abortSignal,
      assertBinding: (candidate, artifact, experiment) =>
        assertNativeCheckpointBinding(candidate, artifact, experiment, boundary),
      policyLabel: "native-boundary"
    });
  }
}

export async function publishCheckpointCandidate<
  TArtifact extends GenericEpisodeEnvelope,
  TCheckpoint extends GenericCheckpointEnvelope
>(input: {
  checkpoint: TCheckpoint;
  artifact: TArtifact;
  experiment: GenericExperimentProvenanceV1;
  getCheckpoint(runId: string, checkpointId: string): Promise<TCheckpoint | undefined>;
  putCheckpoint(runId: string, checkpoint: TCheckpoint): Promise<unknown>;
  abortSignal: AbortSignal;
  assertBinding(
    checkpoint: GenericCheckpointEnvelope,
    artifact: GenericEpisodeEnvelope,
    experiment: GenericExperimentProvenanceV1
  ): void;
  policyLabel: "final" | "native-boundary";
}): Promise<void> {
  const { checkpoint } = input;
  const candidateHash = hashStableJsonValue(checkpoint);
  const existing = await awaitWithAbort(
    () => input.getCheckpoint(input.artifact.runId, checkpoint.checkpointId),
    input.abortSignal
  );
  if (existing !== undefined) {
    input.assertBinding(existing, input.artifact, input.experiment);
    if (hashStableJsonValue(existing) !== candidateHash) {
      throw new Error(
        `Canonical ${input.policyLabel} checkpoint identity conflicts with the deterministic checkpoint candidate.`
      );
    }
    return;
  }
  throwIfAborted(input.abortSignal);
  // Canonical mutation is deliberately awaited to completion while the run
  // lease is held. Racing an irreversible store write against abort could
  // release the lease while publication is still in flight.
  await input.putCheckpoint(input.artifact.runId, checkpoint);
  const published = await awaitWithAbort(
    () => input.getCheckpoint(input.artifact.runId, checkpoint.checkpointId),
    input.abortSignal
  );
  if (published === undefined || hashStableJsonValue(published) !== candidateHash) {
    throw new Error(`Canonical ${input.policyLabel} checkpoint publication could not be verified.`);
  }
  input.assertBinding(published, input.artifact, input.experiment);
}

export function assertFinalCheckpointBinding(
  checkpoint: GenericCheckpointEnvelope,
  artifact: GenericEpisodeEnvelope,
  experiment: GenericExperimentProvenanceV1
): void {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new Error("Final checkpoint builder must return a checkpoint envelope.");
  }
  if (!checkpoint.checkpointId?.trim() || !checkpoint.createdAt?.trim()) {
    throw new Error("Final checkpoint identity and createdAt are required.");
  }
  if (
    checkpoint.source.runId !== artifact.runId ||
    checkpoint.source.sourceArtifactVersion !== artifact.artifactVersion ||
    checkpoint.source.status !== artifact.status
  ) {
    throw new Error("Final checkpoint source identity does not match its canonical episode artifact.");
  }
  if (
    checkpoint.source.nativeStepCount !== artifact.socialEpisode.steps.length ||
    checkpoint.executionPrefix.steps.length !== artifact.socialEpisode.steps.length ||
    checkpoint.source.messageCount !== artifact.socialEpisode.messages.length ||
    checkpoint.executionPrefix.messages.length !== artifact.socialEpisode.messages.length
  ) {
    throw new Error("Final checkpoint is not the complete native episode boundary.");
  }
  if (
    hashStableState(checkpoint.executionPrefix.steps) !== hashStableState(artifact.socialEpisode.steps) ||
    hashStableState(checkpoint.executionPrefix.messages) !== hashStableState(artifact.socialEpisode.messages) ||
    hashStableState(checkpoint.state) !== hashStableState(artifact.finalState) ||
    hashStableState(checkpoint.agents) !== hashStableState(artifact.agents) ||
    hashStableState(checkpoint.executionPrefix.initialState) !== hashStableState(artifact.socialEpisode.initialState) ||
    hashStableState(checkpoint.executionPrefix.finalState) !== hashStableState(artifact.socialEpisode.finalState) ||
    hashStableState(checkpoint.executionPrefix.channels) !== hashStableState(artifact.socialEpisode.channels) ||
    hashStableState(checkpoint.executionPrefix.runtimeActorIds) !== hashStableState(artifact.socialEpisode.runtimeActorIds) ||
    checkpoint.executionPrefix.domainId !== artifact.socialEpisode.domainId ||
    checkpoint.executionPrefix.schedulerMode !== artifact.socialEpisode.schedulerMode
  ) {
    throw new Error("Final checkpoint state or execution prefix does not match its canonical episode artifact.");
  }
  if (
    hashStableState(normalizeFinalCheckpointPrefix(checkpoint.executionPrefix)) !==
    hashStableState(normalizeFinalCheckpointPrefix(artifact.socialEpisode))
  ) {
    throw new Error("Final checkpoint execution prefix is not an exact canonical episode projection.");
  }
  if (
    artifact.experiment === undefined ||
    hashStableJsonValue(artifact.experiment) !== hashStableJsonValue(experiment) ||
    checkpoint.source.experiment === undefined ||
    hashStableJsonValue(checkpoint.source.experiment) !== hashStableJsonValue(experiment)
  ) {
    throw new Error("Final checkpoint experiment provenance does not match its canonical episode artifact.");
  }
}

export function assertNativeCheckpointBinding(
  checkpoint: GenericCheckpointEnvelope,
  artifact: GenericEpisodeEnvelope,
  experiment: GenericExperimentProvenanceV1,
  boundary: GenericExperimentNativeCheckpointBoundary
): void {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new Error("Native-boundary checkpoint builder must return a checkpoint envelope.");
  }
  const envelopeErrors = validateHarnessCheckpointEnvelope(checkpoint);
  if (envelopeErrors.length) {
    throw new Error(`Native-boundary checkpoint envelope is invalid: ${envelopeErrors.join(" ")}`);
  }
  if (!checkpoint.checkpointId?.trim() || !checkpoint.createdAt?.trim()) {
    throw new Error("Native-boundary checkpoint identity and createdAt are required.");
  }
  const stepIndex = boundary.nativeStepCount - 1;
  const sourceStep = artifact.socialEpisode.steps[stepIndex];
  if (
    !sourceStep ||
    sourceStep.traceId !== boundary.traceId ||
    !isSocialStepCommitted(sourceStep) ||
    !isSafeHarnessCheckpointBoundary(artifact.socialEpisode.steps, stepIndex)
  ) {
    throw new Error("Native-boundary checkpoint no longer matches a harness-selected committed scheduler boundary.");
  }
  if (!sourceStep.actorSnapshotsHashAfterStep) {
    throw new Error("Native-boundary checkpoint requires a durable actor snapshot at the selected boundary.");
  }

  const expectedSteps = structuredClone(artifact.socialEpisode.steps.slice(0, boundary.nativeStepCount));
  const maxMessageSeq = latestMessageSeqForHarnessPrefix(artifact.socialEpisode, expectedSteps);
  const expectedMessages = structuredClone(
    artifact.socialEpisode.messages.filter((message) => message.seq <= maxMessageSeq)
  );
  const expectedLastMessageSeq = expectedMessages.at(-1)?.seq;
  if (
    checkpoint.source.runId !== artifact.runId ||
    checkpoint.source.sourceArtifactVersion !== artifact.artifactVersion ||
    checkpoint.source.status !== artifact.status ||
    checkpoint.source.nativeStepCount !== boundary.nativeStepCount ||
    checkpoint.source.messageCount !== expectedMessages.length ||
    checkpoint.source.lastMessageSeq !== expectedLastMessageSeq ||
    checkpoint.source.boundaryTraceId !== sourceStep.traceId ||
    checkpoint.source.boundaryTurnIndex !== sourceStep.turnIndex ||
    checkpoint.source.boundaryBatchId !== sourceStep.batchId ||
    checkpoint.source.boundaryBatchIndex !== sourceStep.batchIndex ||
    checkpoint.source.boundarySchedulerMode !== sourceStep.schedulerMode
  ) {
    throw new Error("Native-boundary checkpoint source identity does not match its canonical episode prefix.");
  }
  if (
    checkpoint.executionPrefix.status !== "truncated" ||
    checkpoint.executionPrefix.truncationReason !==
      `checkpoint boundary after native step ${boundary.nativeStepCount}` ||
    checkpoint.executionPrefix.terminationReason !== undefined ||
    checkpoint.executionPrefix.failureReason !== undefined ||
    checkpoint.executionPrefix.error !== undefined
  ) {
    throw new Error("Native-boundary checkpoint lifecycle is not the canonical truncated prefix projection.");
  }

  const checkpointStateHash = hashStableState(checkpoint.state);
  const checkpointAgentsHash = hashStableState(checkpoint.agents);
  if (
    hashStableState(checkpoint.executionPrefix.steps) !== hashStableState(expectedSteps) ||
    hashStableState(checkpoint.executionPrefix.messages) !== hashStableState(expectedMessages) ||
    hashStableState(checkpoint.executionPrefix.initialState) !== hashStableState(artifact.socialEpisode.initialState) ||
    hashStableState(checkpoint.executionPrefix.finalState) !== checkpointStateHash ||
    hashStableState(checkpoint.executionPrefix.channels) !== hashStableState(artifact.socialEpisode.channels) ||
    hashStableState(checkpoint.executionPrefix.runtimeActorIds) !== hashStableState(artifact.socialEpisode.runtimeActorIds) ||
    checkpoint.executionPrefix.domainId !== artifact.socialEpisode.domainId ||
    checkpoint.executionPrefix.schedulerMode !== artifact.socialEpisode.schedulerMode ||
    checkpointAgentsHash !== sourceStep.actorSnapshotsHashAfterStep ||
    checkpoint.source.agentSnapshotFrameId !== sourceStep.actorSnapshotFrameIdAfterStep
  ) {
    throw new Error("Native-boundary checkpoint state, agents, or execution prefix drifted from canonical authority.");
  }

  const expectedPrefix = structuredClone(artifact.socialEpisode);
  expectedPrefix.status = "truncated";
  expectedPrefix.terminationReason = undefined;
  expectedPrefix.truncationReason = `checkpoint boundary after native step ${boundary.nativeStepCount}`;
  expectedPrefix.failureReason = undefined;
  expectedPrefix.error = undefined;
  expectedPrefix.finalState = structuredClone(checkpoint.state);
  expectedPrefix.steps = expectedSteps;
  expectedPrefix.messages = expectedMessages;
  expectedPrefix.exposureRecords = undefined;
  expectedPrefix.exposureSummary = undefined;
  expectedPrefix.metrics = undefined;
  if (
    hashStableState(checkpoint.executionPrefix) !== hashStableState(expectedPrefix) ||
    checkpoint.source.stateHash !== checkpointStateHash ||
    checkpoint.source.executionPrefixHash !== hashStableState(checkpoint.executionPrefix) ||
    checkpoint.source.agentsHash !== checkpointAgentsHash ||
    checkpoint.source.channelsHash !== hashStableState(checkpoint.executionPrefix.channels) ||
    checkpoint.source.messagesHash !== hashStableState(checkpoint.executionPrefix.messages) ||
    hashStableState(checkpoint.source.domainAdapter) !== hashStableState(checkpoint.executionPrefix.domainAdapter)
  ) {
    throw new Error("Native-boundary checkpoint hashes or exact canonical prefix projection are invalid.");
  }
  if (
    artifact.experiment === undefined ||
    hashStableJsonValue(artifact.experiment) !== hashStableJsonValue(experiment) ||
    checkpoint.source.experiment === undefined ||
    hashStableJsonValue(checkpoint.source.experiment) !== hashStableJsonValue(experiment)
  ) {
    throw new Error("Native-boundary checkpoint experiment provenance does not match its canonical episode artifact.");
  }
}

export function normalizeFinalCheckpointPrefix(prefix: unknown): unknown {
  const normalized = structuredClone(prefix) as Record<string, unknown>;
  // Werewolf keeps exposure evidence in the immutable episode artifact while
  // the generic checkpoint envelope intentionally carries only replay/fork
  // execution authority. These are the only permitted projection omissions.
  delete normalized.exposureRecords;
  delete normalized.exposureSummary;
  return normalized;
}
