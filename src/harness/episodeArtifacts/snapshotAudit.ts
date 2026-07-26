import { assertCanonicalHarnessAgentSnapshotFrame, cloneArtifact, isNonemptyString } from "./support";
import { hashStableState } from "../hash";
import { SocialEpisodeArtifact, SocialHarnessStep, isSocialStepCommitted } from "../social";
import { AuditRecordedSocialAgentSnapshotsOptions, HARNESS_AGENT_SNAPSHOT_FRAME_VERSION, HarnessAgentSnapshotFrame, HarnessAgentSnapshotFrameRegistry, RecordedSocialAgentStateAuditResult, harnessAgentSnapshotFrameId } from "./envelopeModel";
export function auditRecordedSocialAgentSnapshots<TState, TObservation, TPending, TCommand, TAgentState>(
  options: AuditRecordedSocialAgentSnapshotsOptions<TState, TObservation, TPending, TCommand, TAgentState>
): RecordedSocialAgentStateAuditResult {
  const mismatches: string[] = [];
  const requireSnapshots = options.requireSnapshotsAfterCommitted ?? false;
  let checkedSnapshots = 0;
  let previousHash: string | undefined;
  const parallelHashesByBatch = new Map<string, Set<string>>();
  const snapshotFramesById = new Map((options.snapshotFrames ?? []).map((frame) => [frame.frameId, frame]));
  const verifiedFramePayloadHashes = new Map<string, string>();

  const resolveFrame = (
    step: SocialHarnessStep<TObservation, TPending, TCommand>
  ): { agents: TAgentState[]; agentsHash: string; actualHash: string } | undefined => {
    const frameId = step.actorSnapshotFrameIdAfterStep;
    const agentsHash = step.actorSnapshotsHashAfterStep;
    if (!frameId || !agentsHash) return undefined;
    const frame = snapshotFramesById.get(frameId);
    if (!frame || frame.agentsHash !== agentsHash) return undefined;
    let actualHash = verifiedFramePayloadHashes.get(frameId);
    if (!actualHash) {
      actualHash = hashStableState(frame.agents);
      verifiedFramePayloadHashes.set(frameId, actualHash);
    }
    return {
      // Audit callbacks already receive caller-owned inline arrays directly.
      // Reading the canonical frame payload here avoids cloning a potentially
      // multi-megabyte actor table once per native step; the audit never
      // mutates it or returns it.
      agents: frame.agents as TAgentState[],
      agentsHash: frame.agentsHash,
      actualHash
    };
  };

  for (const [stepIndex, step] of options.episode.steps.entries()) {
    const committed = isSocialStepCommitted(step);
    const hasInlineAgents = Array.isArray(step.actorSnapshotsAfterStep);
    const hasHash = typeof step.actorSnapshotsHashAfterStep === "string";
    const hasFrameId = typeof step.actorSnapshotFrameIdAfterStep === "string";
    if (hasInlineAgents && !hasHash) {
      mismatches.push(`Native step ${stepIndex} ${step.traceId}: inline actor snapshot requires a snapshot hash.`);
      continue;
    }
    if (hasFrameId && !hasHash) {
      mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame id requires a snapshot hash.`);
      continue;
    }

    let agents: TAgentState[] | undefined;
    let resolvedHash: string | undefined;
    if (hasInlineAgents) {
      agents = step.actorSnapshotsAfterStep as TAgentState[];
      resolvedHash = step.actorSnapshotsHashAfterStep;
      const actualHash = hashStableState(agents);
      checkedSnapshots += 1;
      if (actualHash !== resolvedHash) {
        mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot hash mismatch ${actualHash} !== ${resolvedHash}.`);
      }
      if (hasFrameId) {
        if (step.actorSnapshotFrameIdAfterStep !== harnessAgentSnapshotFrameId(resolvedHash!)) {
          mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame id does not match its hash.`);
        }
        if (options.snapshotFrames) {
          const resolved = resolveFrame(step);
          if (!resolved) {
            mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame reference cannot be resolved.`);
          } else if (resolved.agentsHash !== actualHash || resolved.actualHash !== actualHash) {
            mismatches.push(`Native step ${stepIndex} ${step.traceId}: inline actor snapshot does not match its frame payload.`);
          }
        }
      }
    } else if (hasHash || hasFrameId) {
      if (!hasHash || !hasFrameId) {
        mismatches.push(`Native step ${stepIndex} ${step.traceId}: compacted actor snapshot requires both hash and frame id.`);
      } else if (!options.snapshotFrames) {
        mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame reference requires an external frame registry.`);
      } else {
        const resolved = resolveFrame(step);
        if (!resolved) {
          mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame reference cannot be resolved.`);
        } else {
          agents = resolved.agents;
          resolvedHash = resolved.agentsHash;
          checkedSnapshots += 1;
          const actualHash = resolved.actualHash;
          if (actualHash !== resolvedHash) {
            mismatches.push(`Native step ${stepIndex} ${step.traceId}: resolved actor snapshot hash mismatch ${actualHash} !== ${resolvedHash}.`);
          }
        }
      }
    }

    if (!agents || !resolvedHash) {
      if (committed && requireSnapshots) {
        mismatches.push(`Native step ${stepIndex} ${step.traceId}: committed step is missing a durable actor snapshot.`);
      }
      continue;
    }

    if (!committed && previousHash !== undefined && resolvedHash !== previousHash) {
      mismatches.push(`Native step ${stepIndex} ${step.traceId}: rejected step changed the recorded durable actor state.`);
    }
    if (step.schedulerMode === "parallel" && step.atomic && step.batchId) {
      const hashes = parallelHashesByBatch.get(step.batchId) ?? new Set<string>();
      hashes.add(resolvedHash);
      parallelHashesByBatch.set(step.batchId, hashes);
    }
    for (const error of options.validateSnapshot?.({ agents, step, stepIndex }) ?? []) {
      mismatches.push(`Native step ${stepIndex} ${step.traceId}: ${error}`);
    }
    previousHash = resolvedHash;
  }

  for (const [batchId, hashes] of parallelHashesByBatch) {
    if (hashes.size > 1) {
      mismatches.push(`Parallel batch ${batchId}: native steps do not share one post-receipt actor snapshot.`);
    }
  }
  if (options.finalAgents !== undefined && previousHash !== undefined) {
    const finalAgentsHash = hashStableState(options.finalAgents);
    if (previousHash !== finalAgentsHash) {
      mismatches.push(`Final actor snapshot hash mismatch ${previousHash} !== ${finalAgentsHash}.`);
    }
  }
  return {
    ok: mismatches.length === 0,
    checkedNativeSteps: options.episode.steps.length,
    checkedSnapshots,
    mismatches
  };
}

/**
 * Validate a canonical compacted registry, then run the same causal audit as
 * raw inline episodes. The registry is intentionally domain-neutral: it does
 * not inspect player ids, roles, teams, social journals, or private schemas.
 */
export function validateHarnessAgentSnapshotFrameRegistry<TState, TObservation, TPending, TCommand, TAgentState>(
  options: AuditRecordedSocialAgentSnapshotsOptions<TState, TObservation, TPending, TCommand, TAgentState> & {
    frames: HarnessAgentSnapshotFrameRegistry<TAgentState>;
  }
): RecordedSocialAgentStateAuditResult {
  const mismatches: string[] = [];
  const framesById = new Map<string, HarnessAgentSnapshotFrame<TAgentState>>();
  const hashes = new Set<string>();
  for (const [index, frame] of options.frames.entries()) {
    const label = `Agent snapshot frame ${index}`;
    if (frame.artifactVersion !== HARNESS_AGENT_SNAPSHOT_FRAME_VERSION) {
      mismatches.push(`${label}: artifactVersion must be ${HARNESS_AGENT_SNAPSHOT_FRAME_VERSION}.`);
    }
    if (frame.kind !== "agent-snapshot-frame") mismatches.push(`${label}: kind must be agent-snapshot-frame.`);
    if (!isNonemptyString(frame.frameId)) {
      mismatches.push(`${label}: frameId is required.`);
    } else if (framesById.has(frame.frameId)) {
      mismatches.push(`${label}: duplicate frameId ${frame.frameId}.`);
    }
    if (!Array.isArray(frame.agents)) {
      mismatches.push(`${label}: agents must be an array.`);
      continue;
    }
    const actualHash = hashStableState(frame.agents);
    if (frame.agentsHash !== actualHash) {
      mismatches.push(`${label}: agentsHash mismatch ${actualHash} !== ${frame.agentsHash}.`);
    }
    if (frame.frameId !== harnessAgentSnapshotFrameId(frame.agentsHash)) {
      mismatches.push(`${label}: frameId does not match agentsHash.`);
    }
    if (hashes.has(frame.agentsHash)) mismatches.push(`${label}: duplicate agentsHash ${frame.agentsHash}.`);
    hashes.add(frame.agentsHash);
    if (isNonemptyString(frame.frameId) && !framesById.has(frame.frameId)) framesById.set(frame.frameId, frame);
  }

  const referencedFrameIds = new Set<string>();
  for (const [stepIndex, step] of options.episode.steps.entries()) {
    const hasHash = typeof step.actorSnapshotsHashAfterStep === "string";
    const frameId = step.actorSnapshotFrameIdAfterStep;
    if (frameId !== undefined && typeof frameId !== "string") {
      mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame id must be a string when present.`);
      continue;
    }
    if (frameId !== undefined) {
      referencedFrameIds.add(frameId);
      if (!hasHash) {
        mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame id requires a snapshot hash.`);
        continue;
      }
      const frame = framesById.get(frameId);
      if (!frame) {
        mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame ${frameId} is missing.`);
      } else if (frame.agentsHash !== step.actorSnapshotsHashAfterStep) {
        mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame hash does not match the step hash.`);
      }
    } else if (hasHash && !Array.isArray(step.actorSnapshotsAfterStep)) {
      mismatches.push(`Native step ${stepIndex} ${step.traceId}: compacted actor snapshot hash is missing a frame id.`);
    }
  }
  for (const frame of options.frames) {
    if (!referencedFrameIds.has(frame.frameId)) {
      mismatches.push(`Agent snapshot frame ${frame.frameId} is orphaned from the native social episode.`);
    }
  }

  const audit = auditRecordedSocialAgentSnapshots({ ...options, snapshotFrames: options.frames });
  const allMismatches = [...mismatches, ...audit.mismatches];
  return {
    ok: allMismatches.length === 0,
    checkedNativeSteps: audit.checkedNativeSteps,
    checkedSnapshots: audit.checkedSnapshots,
    mismatches: allMismatches
  };
}

/**
 * Deduplicate inline native snapshots into a canonical external frame registry
 * without altering the caller-owned episode. Legacy trajectory projections are
 * intentionally not touched here; a domain compatibility layer owns them.
 */
export function compactRecordedSocialAgentSnapshots<TState, TObservation, TPending, TCommand, TAgentState>(input: {
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  existingFrames?: HarnessAgentSnapshotFrameRegistry<TAgentState>;
}): {
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  frames: HarnessAgentSnapshotFrame<TAgentState>[];
} {
  const episode = cloneArtifact(input.episode);
  const framesById = new Map<string, HarnessAgentSnapshotFrame<TAgentState>>();
  for (const [index, frame] of (input.existingFrames ?? []).entries()) {
    const label = `Existing agent snapshot frame ${index}`;
    assertCanonicalHarnessAgentSnapshotFrame(frame, label);
    if (framesById.has(frame.frameId)) throw new Error(`${label}: duplicate frameId ${frame.frameId}.`);
    framesById.set(frame.frameId, cloneArtifact(frame));
  }

  for (const [stepIndex, step] of episode.steps.entries()) {
    const hasAgents = Array.isArray(step.actorSnapshotsAfterStep);
    const hasHash = typeof step.actorSnapshotsHashAfterStep === "string";
    const hasFrameId = typeof step.actorSnapshotFrameIdAfterStep === "string";
    if (hasAgents !== hasHash) {
      throw new Error(`Native step ${stepIndex} ${step.traceId}: actor snapshot payload/hash must be recorded together.`);
    }
    if (hasFrameId && !hasHash) {
      throw new Error(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame id requires a snapshot hash.`);
    }
    if (hasAgents) {
      const agents = step.actorSnapshotsAfterStep as TAgentState[];
      const agentsHash = hashStableState(agents);
      if (agentsHash !== step.actorSnapshotsHashAfterStep) {
        throw new Error(`Native step ${stepIndex} ${step.traceId}: actor snapshot hash mismatch.`);
      }
      const frameId = harnessAgentSnapshotFrameId(agentsHash);
      if (hasFrameId && step.actorSnapshotFrameIdAfterStep !== frameId) {
        throw new Error(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame id does not match its hash.`);
      }
      const existing = framesById.get(frameId);
      if (!existing) {
        framesById.set(frameId, {
          artifactVersion: HARNESS_AGENT_SNAPSHOT_FRAME_VERSION,
          kind: "agent-snapshot-frame",
          frameId,
          agentsHash,
          agents: cloneArtifact(agents)
        });
      }
      step.actorSnapshotsHashAfterStep = agentsHash;
      step.actorSnapshotFrameIdAfterStep = frameId;
      delete step.actorSnapshotsAfterStep;
      continue;
    }
    if (!hasHash) continue;
    if (!hasFrameId) {
      throw new Error(`Native step ${stepIndex} ${step.traceId}: compacted actor snapshot hash is missing a frame id.`);
    }
    const frameId = step.actorSnapshotFrameIdAfterStep!;
    if (frameId !== harnessAgentSnapshotFrameId(step.actorSnapshotsHashAfterStep!)) {
      throw new Error(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame id does not match its hash.`);
    }
    const frame = framesById.get(frameId);
    if (!frame || frame.agentsHash !== step.actorSnapshotsHashAfterStep) {
      throw new Error(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame reference cannot be resolved.`);
    }
  }

  return {
    episode,
    frames: [...framesById.values()].sort((left, right) => left.frameId.localeCompare(right.frameId))
  };
}

/**
 * Build a structurally complete checkpoint from a final or already-sliced
 * episode.  It does not invoke a domain replay factory; callers that need
 * deterministic replay proof should use validateHarnessCheckpointReplay().
 */
