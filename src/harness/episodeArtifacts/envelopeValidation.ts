import { endsAtCompleteNativeBatch, isNonemptyString, isRecord } from "./support";
import { compareSocialDomainAdapterManifests, validateSocialDomainAdapterManifest } from "../domainAdapter";
import { GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION, GENERIC_EXPERIMENT_PROVENANCE_VERSION, validateGenericExperimentExecutionAttestation, validateGenericExperimentExecutionEvidence, validateGenericExperimentForkLineage, validateGenericExperimentProvenance } from "../experimentSpec";
import { hashStableState } from "../hash";
import { SocialEpisodeArtifact, SocialHarnessStep, SocialMessage, validateSocialEpisodeArtifact } from "../social";
import { GenericForkProvenance, HARNESS_FORK_PROVENANCE_VERSION, HarnessCheckpointEnvelope, HarnessCheckpointReplayResult, HarnessCheckpointSource, HarnessEpisodeArtifactEnvelope, harnessAgentSnapshotFrameId } from "./envelopeModel";
import { auditRecordedSocialAgentSnapshots, validateHarnessAgentSnapshotFrameRegistry } from "./snapshotAudit";
export function validateHarnessEpisodeArtifactEnvelope<
  TState,
  TObservation,
  TPending,
  TCommand,
  TAgentState,
  TForkProvenance extends GenericForkProvenance | undefined
>(
  artifact: HarnessEpisodeArtifactEnvelope<TState, TObservation, TPending, TCommand, TAgentState, TForkProvenance>
): string[] {
  const errors: string[] = [];
  if (!isNonemptyString(artifact.artifactVersion)) errors.push("artifactVersion is required.");
  if (!isNonemptyString(artifact.kind)) errors.push("kind is required.");
  if (!isNonemptyString(artifact.runId)) errors.push("runId is required.");
  if (!isNonemptyString(artifact.createdAt)) errors.push("createdAt is required.");
  if (artifact.experiment !== undefined && artifact.runId !== artifact.socialEpisode.id) {
    errors.push("runId must match socialEpisode.id.");
  }
  if (artifact.socialEpisode.status !== artifact.status) {
    errors.push(`socialEpisode.status mismatch: expected ${artifact.status}, received ${artifact.socialEpisode.status}.`);
  }
  if (hashStableState(artifact.initialState) !== hashStableState(artifact.socialEpisode.initialState)) {
    errors.push("initialState does not match socialEpisode.initialState.");
  }
  if (hashStableState(artifact.finalState) !== hashStableState(artifact.socialEpisode.finalState)) {
    errors.push("finalState does not match socialEpisode.finalState.");
  }
  for (const error of validateSocialEpisodeArtifact(artifact.socialEpisode)) errors.push(`socialEpisode.${error}`);
  if (artifact.agentSnapshotFrames !== undefined) {
    if (!Array.isArray(artifact.agentSnapshotFrames)) {
      errors.push("agentSnapshotFrames must be an array when present.");
    } else {
      const audit = validateHarnessAgentSnapshotFrameRegistry({
        episode: artifact.socialEpisode,
        frames: artifact.agentSnapshotFrames,
        finalAgents: artifact.agents
      });
      for (const mismatch of audit.mismatches) errors.push(`agentSnapshotFrames: ${mismatch}`);
    }
  } else if (
    artifact.socialEpisode.steps.some(
      (step) =>
        step.actorSnapshotsAfterStep !== undefined ||
        step.actorSnapshotsHashAfterStep !== undefined ||
        step.actorSnapshotFrameIdAfterStep !== undefined
    )
  ) {
    // Canonical episode envelopes may retain raw inline snapshots without a
    // sidecar, but a compacted hash/frame reference is only auditable with its
    // registry. The no-parent-registry replay exception belongs exclusively to
    // an explicitly selected bare checkpoint prefix, never to a canonical
    // artifact that claims replay/fork authority.
    const audit = auditRecordedSocialAgentSnapshots({
      episode: artifact.socialEpisode,
      finalAgents: artifact.agents
    });
    for (const mismatch of audit.mismatches) errors.push(`agentSnapshots: ${mismatch}`);
  }
  if (artifact.experiment !== undefined) {
    const experimentErrors = validateGenericExperimentProvenance(artifact.experiment, "experiment");
    errors.push(...experimentErrors);
    if (!artifact.socialEpisode.domainAdapter) {
      errors.push("socialEpisode.domainAdapter is required when experiment provenance is present.");
    } else if (!experimentErrors.length) {
      for (const error of compareSocialDomainAdapterManifests(
        artifact.experiment.spec.domainAdapter,
        artifact.socialEpisode.domainAdapter,
        { recordedPath: "experiment.spec.domainAdapter", runtimePath: "socialEpisode.domainAdapter" }
      )) {
        errors.push(error);
      }
      if (artifact.experiment.spec.schedulerMode !== artifact.socialEpisode.schedulerMode) {
        errors.push("experiment.spec.schedulerMode must match socialEpisode.schedulerMode.");
      }
      if (!artifact.socialEpisode.runtimeActorIds) {
        errors.push("socialEpisode.runtimeActorIds is required when experiment provenance is present.");
      } else if (artifact.experiment.spec.actorCount !== artifact.socialEpisode.runtimeActorIds.length) {
        errors.push("experiment.spec.actorCount must match socialEpisode.runtimeActorIds length.");
      }
      if (artifact.executionAttestation === undefined) {
        // No unauthenticated schema-version flag can safely distinguish a
        // genuinely old envelope from a downgraded new one. Any canonical
        // experiment-bound envelope therefore fails closed without the
        // runner-bound attestation; legacy bare social artifacts remain valid.
        errors.push("executionAttestation is required by experiment provenance.");
      } else {
        if (
          artifact.experiment.schemaVersion === GENERIC_EXPERIMENT_PROVENANCE_VERSION &&
          artifact.executionAttestation.schemaVersion !== GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION
        ) {
          errors.push(
            `executionAttestation.schemaVersion must be ${GENERIC_EXPERIMENT_EXECUTION_ATTESTATION_VERSION} for ${GENERIC_EXPERIMENT_PROVENANCE_VERSION}.`
          );
        }
        errors.push(...validateGenericExperimentExecutionAttestation(
          artifact.executionAttestation,
          artifact.experiment.spec,
          artifact.socialEpisode,
          "executionAttestation"
        ));
      }
    }
  } else if (artifact.executionAttestation !== undefined) {
    errors.push("experiment is required when executionAttestation is present.");
  }
  if (artifact.forkOf !== undefined) {
    if (!isRecord(artifact.forkOf)) {
      errors.push("forkOf must be an object when present.");
      return errors;
    }
    const forkOf = artifact.forkOf as GenericForkProvenance;
    errors.push(...validateGenericForkProvenance(forkOf));
    if (forkOf.parentDomainAdapter !== undefined && !artifact.socialEpisode.domainAdapter) {
      errors.push("socialEpisode.domainAdapter is required when forkOf records parent adapter provenance.");
    }
    if (forkOf.experimentLineage !== undefined) {
      const lineageErrors = validateGenericExperimentForkLineage(
        forkOf.experimentLineage,
        "forkOf.experimentLineage"
      );
      if (artifact.experiment === undefined) {
        errors.push("experiment is required when forkOf records experiment lineage.");
      } else if (!isRecord(artifact.experiment)) {
        // The experiment validator above already records the canonical shape
        // error; never dereference an explicit null/non-object legacy forgery.
      } else if (!lineageErrors.length && artifact.experiment.specHash !== forkOf.experimentLineage.child.specHash) {
        errors.push("experiment.specHash must match forkOf.experimentLineage.child.specHash.");
      } else if (!lineageErrors.length && hashStableState(artifact.experiment) !== hashStableState(forkOf.experimentLineage.child)) {
        errors.push("experiment must exactly match forkOf.experimentLineage.child.");
      }
      if (forkOf.parentDomainAdapter === undefined) {
        errors.push("forkOf.parentDomainAdapter is required when experiment lineage is present.");
      } else if (!lineageErrors.length) {
        for (const error of compareSocialDomainAdapterManifests(
          forkOf.experimentLineage.parent.spec.domainAdapter,
          forkOf.parentDomainAdapter,
          { recordedPath: "forkOf.experimentLineage.parent.spec.domainAdapter", runtimePath: "forkOf.parentDomainAdapter" }
        )) {
          errors.push(error);
        }
      }
    }
  }
  return errors;
}

export function validateGenericForkProvenance(input: unknown): string[] {
  if (!isRecord(input)) return ["forkOf must be an object."];
  const provenance = input as unknown as GenericForkProvenance;
  const errors: string[] = [];
  if (provenance.schemaVersion !== HARNESS_FORK_PROVENANCE_VERSION) {
    errors.push(`forkOf.schemaVersion must be ${HARNESS_FORK_PROVENANCE_VERSION}.`);
  }
  if (!isNonemptyString(provenance.checkpointArtifactVersion)) errors.push("forkOf.checkpointArtifactVersion is required.");
  if (!isNonemptyString(provenance.checkpointId)) errors.push("forkOf.checkpointId is required.");
  if (!isNonemptyString(provenance.createdAt)) errors.push("forkOf.createdAt is required.");
  if (provenance.parentDomainAdapter !== undefined) {
    errors.push(...validateSocialDomainAdapterManifest(provenance.parentDomainAdapter, "forkOf.parentDomainAdapter"));
  }
  if (provenance.experimentLineage !== undefined) {
    errors.push(...validateGenericExperimentForkLineage(provenance.experimentLineage, "forkOf.experimentLineage"));
  }
  for (const field of [
    "parentStateHash",
    "parentExecutionPrefixHash",
    "parentAgentsHash",
    "parentChannelsHash",
    "parentMessagesHash"
  ] as const) {
    if (!isNonemptyString(provenance[field])) errors.push(`forkOf.${field} is required.`);
  }
  for (const field of ["parentNativeStepCount", "parentMessageCount"] as const) {
    if (!Number.isInteger(provenance[field]) || provenance[field] < 0) {
      errors.push(`forkOf.${field} must be a non-negative integer.`);
    }
  }
  if (
    provenance.parentBoundaryTurnIndex !== undefined &&
    (!Number.isInteger(provenance.parentBoundaryTurnIndex) || provenance.parentBoundaryTurnIndex < 0)
  ) {
    errors.push("forkOf.parentBoundaryTurnIndex must be a non-negative integer when present.");
  }
  if (
    provenance.parentEvidenceTraceIds !== undefined &&
    (!Array.isArray(provenance.parentEvidenceTraceIds) ||
      provenance.parentEvidenceTraceIds.some((traceId) => typeof traceId !== "string" || !traceId.trim()))
  ) {
    errors.push("forkOf.parentEvidenceTraceIds must contain nonempty trace ids when present.");
  }
  for (const field of ["parentRunId", "parentArtifactId", "parentBoundaryTraceId", "reason"] as const) {
    if (provenance[field] !== undefined && !isNonemptyString(provenance[field])) {
      errors.push(`forkOf.${field} must be a nonempty string when present.`);
    }
  }
  return errors;
}

/**
 * Structural checkpoint validation shared by all domains. It intentionally
 * does not reconstruct an environment: callers supply a domain replay factory
 * through validateHarnessCheckpointReplay when deterministic replay is needed.
 */
export function validateHarnessCheckpointEnvelope<
  TState,
  TAgentState,
  TObservation,
  TPending,
  TCommand,
  TSource extends HarnessCheckpointSource
>(
  checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand, TSource>
): string[] {
  const errors: string[] = [];
  if (!isNonemptyString(checkpoint.artifactVersion)) errors.push("artifactVersion is required.");
  if (!isNonemptyString(checkpoint.kind)) errors.push("kind is required.");
  if (!isNonemptyString(checkpoint.checkpointId)) errors.push("checkpointId is required.");
  if (!isNonemptyString(checkpoint.createdAt)) errors.push("createdAt is required.");
  if (!isNonemptyString(checkpoint.source.sourceArtifactVersion)) errors.push("source.sourceArtifactVersion is required.");
  if (!isNonemptyString(checkpoint.source.runId)) errors.push("source.runId is required.");
  if (checkpoint.source.experiment !== undefined && checkpoint.source.runId !== checkpoint.executionPrefix.id) {
    errors.push("source.runId must match executionPrefix.id.");
  }
  if (checkpoint.executionPrefix.domainAdapter) {
    if (!checkpoint.source.domainAdapter) {
      errors.push("source.domainAdapter is required when executionPrefix records adapter provenance.");
    } else {
      for (const error of compareSocialDomainAdapterManifests(
        checkpoint.executionPrefix.domainAdapter,
        checkpoint.source.domainAdapter,
        { recordedPath: "executionPrefix.domainAdapter", runtimePath: "source.domainAdapter" }
      )) {
        errors.push(error);
      }
    }
  } else if (checkpoint.source.domainAdapter) {
    errors.push(...validateSocialDomainAdapterManifest(checkpoint.source.domainAdapter, "source.domainAdapter"));
    errors.push("source.domainAdapter must be absent when executionPrefix has no adapter provenance.");
  }
  if (checkpoint.source.experiment !== undefined) {
    const experimentErrors = validateGenericExperimentProvenance(checkpoint.source.experiment, "source.experiment");
    errors.push(...experimentErrors);
    if (!checkpoint.executionPrefix.domainAdapter) {
      errors.push("executionPrefix.domainAdapter is required when source.experiment records adapter-bound authority.");
    } else if (!experimentErrors.length) {
      for (const error of compareSocialDomainAdapterManifests(
        checkpoint.source.experiment.spec.domainAdapter,
        checkpoint.executionPrefix.domainAdapter,
        { recordedPath: "source.experiment.spec.domainAdapter", runtimePath: "executionPrefix.domainAdapter" }
      )) {
        errors.push(error);
      }
      if (checkpoint.source.experiment.spec.schedulerMode !== checkpoint.executionPrefix.schedulerMode) {
        errors.push("source.experiment.spec.schedulerMode must match executionPrefix.schedulerMode.");
      }
      if (!checkpoint.executionPrefix.runtimeActorIds) {
        errors.push("executionPrefix.runtimeActorIds is required when source.experiment is present.");
      } else if (checkpoint.source.experiment.spec.actorCount !== checkpoint.executionPrefix.runtimeActorIds.length) {
        errors.push("source.experiment.spec.actorCount must match executionPrefix.runtimeActorIds length.");
      }
      // Checkpoints do not duplicate the envelope attestation, but their
      // immutable execution prefix must always prove the same runner facts.
      // Requiring this for every experiment-bound checkpoint prevents a v2
      // record from being downgraded to a marker-free v1 record.
      errors.push(...validateGenericExperimentExecutionEvidence(
        checkpoint.source.experiment.spec,
        checkpoint.executionPrefix,
        "executionPrefix",
        {
          requireAssignmentResolution:
            checkpoint.source.experiment.schemaVersion === GENERIC_EXPERIMENT_PROVENANCE_VERSION
        }
      ));
    }
  }

  const actualStateHash = hashStableState(checkpoint.state);
  if (checkpoint.source.stateHash !== actualStateHash) {
    errors.push(`source.stateHash mismatch: expected ${actualStateHash}, received ${checkpoint.source.stateHash}.`);
  }
  const prefixStateHash = hashStableState(checkpoint.executionPrefix.finalState);
  if (checkpoint.source.stateHash !== prefixStateHash) {
    errors.push(`executionPrefix.finalState hash mismatch: expected ${checkpoint.source.stateHash}, received ${prefixStateHash}.`);
  }
  const actualExecutionPrefixHash = hashStableState(checkpoint.executionPrefix);
  if (checkpoint.source.executionPrefixHash !== actualExecutionPrefixHash) {
    errors.push(
      `source.executionPrefixHash mismatch: expected ${actualExecutionPrefixHash}, received ${checkpoint.source.executionPrefixHash ?? "undefined"}.`
    );
  }
  const actualAgentsHash = hashStableState(checkpoint.agents);
  if (checkpoint.source.agentsHash !== actualAgentsHash) {
    errors.push(`source.agentsHash mismatch: expected ${actualAgentsHash}, received ${checkpoint.source.agentsHash ?? "undefined"}.`);
  }
  const actualChannelsHash = hashStableState(checkpoint.executionPrefix.channels);
  if (checkpoint.source.channelsHash !== actualChannelsHash) {
    errors.push(`source.channelsHash mismatch: expected ${actualChannelsHash}, received ${checkpoint.source.channelsHash ?? "undefined"}.`);
  }
  const actualMessagesHash = hashStableState(checkpoint.executionPrefix.messages);
  if (checkpoint.source.messagesHash !== actualMessagesHash) {
    errors.push(`source.messagesHash mismatch: expected ${actualMessagesHash}, received ${checkpoint.source.messagesHash ?? "undefined"}.`);
  }
  if (checkpoint.source.nativeStepCount !== checkpoint.executionPrefix.steps.length) {
    errors.push(
      `source.nativeStepCount mismatch: expected ${checkpoint.executionPrefix.steps.length}, received ${checkpoint.source.nativeStepCount}.`
    );
  }
  if (checkpoint.source.messageCount !== checkpoint.executionPrefix.messages.length) {
    errors.push(`source.messageCount mismatch: expected ${checkpoint.executionPrefix.messages.length}, received ${checkpoint.source.messageCount}.`);
  }

  const lastStep = checkpoint.executionPrefix.steps.at(-1);
  // Failed runs may be persisted as environment/message replay evidence even
  // when their final native record is a rejected decision and therefore has
  // no post-receipt actor snapshot. They are not forkable; the fork runtime
  // performs the stricter restore-boundary guard before creating anything.
  const terminalRejectedFailureBoundary =
    checkpoint.source.status === "failed" &&
    checkpoint.executionPrefix.status === "failed" &&
    lastStep?.commitStatus === "rejected" &&
    Boolean(lastStep?.failure);
  if (lastStep) {
    if (checkpoint.source.boundaryTraceId !== lastStep.traceId) {
      errors.push(
        `source.boundaryTraceId mismatch: expected ${lastStep.traceId}, received ${checkpoint.source.boundaryTraceId ?? "undefined"}.`
      );
    }
    if (checkpoint.source.boundaryTurnIndex !== lastStep.turnIndex) {
      errors.push(
        `source.boundaryTurnIndex mismatch: expected ${lastStep.turnIndex}, received ${checkpoint.source.boundaryTurnIndex ?? "undefined"}.`
      );
    }
    if ((checkpoint.source.boundaryBatchId ?? undefined) !== lastStep.batchId) {
      errors.push("source.boundaryBatchId mismatch with final native step.");
    }
    if ((checkpoint.source.boundaryBatchIndex ?? undefined) !== lastStep.batchIndex) {
      errors.push("source.boundaryBatchIndex mismatch with final native step.");
    }
    if (checkpoint.source.boundarySchedulerMode !== lastStep.schedulerMode) {
      errors.push("source.boundarySchedulerMode mismatch with final native step.");
    }
    if (!terminalRejectedFailureBoundary) validateCheckpointBoundaryAgentSnapshot(checkpoint, lastStep, errors);
  } else {
    if (checkpoint.source.boundaryTraceId !== undefined) errors.push("source.boundaryTraceId must be undefined when native prefix is empty.");
    if (checkpoint.source.boundaryTurnIndex !== undefined) errors.push("source.boundaryTurnIndex must be undefined when native prefix is empty.");
    if (checkpoint.source.boundarySchedulerMode !== undefined) errors.push("source.boundarySchedulerMode must be undefined when native prefix is empty.");
    errors.push("Forkable checkpoint executionPrefix requires a recorded native boundary with durable actor snapshots.");
  }

  validateCheckpointMessages(checkpoint.executionPrefix.messages, checkpoint.source.lastMessageSeq, errors);
  for (const error of validateSocialEpisodeArtifact(checkpoint.executionPrefix)) errors.push(`executionPrefix: ${error}`);
  if (!endsAtCompleteNativeBatch(checkpoint.executionPrefix.steps) && !terminalRejectedFailureBoundary) {
    errors.push("executionPrefix ends in the middle of a native scheduler batch.");
  }
  if (
    checkpoint.source.agentSnapshotFrameId &&
    checkpoint.source.agentSnapshotFrameId !== harnessAgentSnapshotFrameId(checkpoint.source.agentsHash)
  ) {
    errors.push("source.agentSnapshotFrameId does not match source.agentsHash.");
  }
  return errors;
}

/**
 * A checkpoint is allowed to restore only the exact durable actor state that
 * the parent native trajectory recorded after its final complete scheduler
 * batch. Hashing checkpoint.agents against its own source field is not enough:
 * that would make a self-consistent forged memory/belief/relationship snapshot
 * forkable. Frame IDs are identity evidence when a canonical artifact compacts
 * the snapshot payload into a sidecar.
 */
function validateCheckpointBoundaryAgentSnapshot<
  TState,
  TAgentState,
  TObservation,
  TPending,
  TCommand,
  TSource extends HarnessCheckpointSource
>(
  checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand, TSource>,
  boundary: SocialHarnessStep<TObservation, TPending, TCommand>,
  errors: string[]
): void {
  const recordedHash = boundary.actorSnapshotsHashAfterStep;
  const recordedFrameId = boundary.actorSnapshotFrameIdAfterStep;
  const recordedAgents = boundary.actorSnapshotsAfterStep;
  if (!recordedHash) {
    errors.push("executionPrefix final boundary is missing a durable actor snapshot hash.");
    return;
  }
  if (checkpoint.source.agentsHash !== recordedHash) {
    errors.push(
      `source.agentsHash does not match final boundary actor snapshot hash: ${checkpoint.source.agentsHash} !== ${recordedHash}.`
    );
  }
  if (Array.isArray(recordedAgents)) {
    const actualRecordedHash = hashStableState(recordedAgents);
    if (actualRecordedHash !== recordedHash) {
      errors.push(
        `executionPrefix final boundary actor snapshot hash mismatch: expected ${actualRecordedHash}, received ${recordedHash}.`
      );
    }
  } else if (!recordedFrameId) {
    errors.push("executionPrefix final boundary actor snapshot requires inline agents or a compacted frame reference.");
  }

  if (recordedFrameId) {
    if (recordedFrameId !== harnessAgentSnapshotFrameId(recordedHash)) {
      errors.push("executionPrefix final boundary actor snapshot frame id does not match its snapshot hash.");
    }
    if (checkpoint.source.agentSnapshotFrameId !== recordedFrameId) {
      errors.push("source.agentSnapshotFrameId does not match final boundary actor snapshot frame id.");
    }
  } else if (checkpoint.source.agentSnapshotFrameId !== undefined) {
    errors.push("source.agentSnapshotFrameId is present but final boundary has no actor snapshot frame id.");
  }
}

/**
 * Kept separate from structural validation so a generic envelope never
 * imports a domain environment or accidentally turns replay into a model run.
 */
export function validateHarnessCheckpointReplay<
  TState,
  TAgentState,
  TObservation,
  TPending,
  TCommand,
  TSource extends HarnessCheckpointSource
>(
  checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand, TSource>,
  replay: (episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>) => HarnessCheckpointReplayResult
): string[] {
  const result = replay(checkpoint.executionPrefix);
  const errors = result.mismatches.map((mismatch) => `executionPrefix replay: ${mismatch}`);
  if (result.finalHash !== undefined && result.finalHash !== checkpoint.source.stateHash) {
    errors.push(`executionPrefix replay state hash mismatch: expected ${checkpoint.source.stateHash}, received ${result.finalHash}.`);
  }
  if (result.messagesHash !== undefined && result.messagesHash !== checkpoint.source.messagesHash) {
    errors.push(`executionPrefix replay messages hash mismatch: expected ${checkpoint.source.messagesHash}, received ${result.messagesHash}.`);
  }
  return errors;
}

function validateCheckpointMessages(messages: readonly SocialMessage[], lastMessageSeq: number | undefined, errors: string[]): void {
  const messageIds = new Set<string>();
  for (const [index, message] of messages.entries()) {
    const expectedSeq = index + 1;
    if (message.seq !== expectedSeq) {
      errors.push(`socialMessages sequence mismatch: expected ${expectedSeq}, received ${message.seq}.`);
    }
    if (!message.id) {
      errors.push(`socialMessages[${index}] is missing id.`);
    } else if (messageIds.has(message.id)) {
      errors.push(`Duplicate social message id ${message.id}.`);
    }
    messageIds.add(message.id);
  }
  const lastMessage = messages.at(-1);
  if (lastMessage) {
    if (lastMessageSeq !== lastMessage.seq) {
      errors.push(`source.lastMessageSeq mismatch: expected ${lastMessage.seq}, received ${lastMessageSeq ?? "undefined"}.`);
    }
  } else if (lastMessageSeq !== undefined) {
    errors.push("source.lastMessageSeq must be undefined when messages are empty.");
  }
}
