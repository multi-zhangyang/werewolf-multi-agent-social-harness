import { cloneJson } from "./validationSupport";
import { GameState } from "../../core/types";
import { harnessAgentSnapshotFrameId } from "../episodeArtifacts";
import { hashStableState } from "../hash";
import { HarnessAssignmentConfig, ResolvedAgentAssignment } from "../profiles";
import { sanitizePersistedProviderDiagnostics } from "../providerFailure";
import { redactSecrets } from "../redaction";
import { SocialEpisodeArtifact } from "../social";
import { AgentHarnessState, HarnessAgentProfile, HarnessRunResult, HarnessStepRecord } from "../types";
import { AGENT_SNAPSHOT_FRAME_VERSION, AgentSnapshotFrame, MATCH_ARTIFACT_VERSION, MatchArtifact } from "./types";
export function buildMatchArtifact(options: {
  runId: string;
  matchId?: string;
  createdAt?: string;
  seed: string;
  models: string[];
  profiles: HarnessAgentProfile[];
  assignment?: HarnessAssignmentConfig;
  resolvedAssignments: ResolvedAgentAssignment[];
  result: HarnessRunResult;
}): MatchArtifact {
  const compactedSnapshots = cloneAndCompactAgentSnapshots({
    trajectory: options.result.trajectory,
    socialEpisode: options.result.socialEpisode
  });
  const artifact: MatchArtifact = {
    artifactVersion: MATCH_ARTIFACT_VERSION,
    kind: "match",
    runId: options.runId,
    matchId: options.matchId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    seed: options.seed,
    rulesetId: options.result.initialState.config.rulesetId,
    config: cloneJson(options.result.initialState.config),
    models: [...options.models],
    profiles: cloneJson(options.profiles),
    assignment: cloneJson(options.assignment),
    resolvedAssignments: cloneJson(options.resolvedAssignments),
    status: options.result.status,
    truncationReason: options.result.truncationReason,
    failureReason: options.result.failureReason,
    failureStateHash: options.result.failureStateHash,
    forkOf: cloneJson(options.result.forkOf),
    initialState: cloneJson(options.result.initialState),
    finalState: cloneJson(options.result.state),
    trajectory: compactedSnapshots.trajectory,
    socialEpisode: compactedSnapshots.socialEpisode,
    events: cloneJson(options.result.state.events),
    evaluation: cloneJson(options.result.evaluation),
    evaluationReport: cloneJson(options.result.evaluationReport),
    metrics: cloneJson(options.result.metrics),
    agents: cloneJson(options.result.agents),
    agentSnapshotFrames: compactedSnapshots.frames.length ? compactedSnapshots.frames : undefined
  };
  const redacted = sanitizePersistedProviderDiagnostics(redactSecrets(artifact));
  normalizeAgentSnapshotFramesAfterRedaction(redacted);
  return redacted;
}

export function resolveAgentSnapshotsAfterStep(artifact: MatchArtifact, step: HarnessStepRecord): AgentHarnessState[] | undefined {
  if (step.agentSnapshotsAfterStep) return cloneJson(step.agentSnapshotsAfterStep);
  const frame = findAgentSnapshotFrame(artifact, step);
  return frame ? cloneJson(frame.agents) : undefined;
}

/**
 * Clone the two replay-authority projections while moving inline actor state
 * directly into a shared frame registry. Cloning each snapshot-heavy
 * projection in full before compaction made artifact construction retain
 * several complete copies of the same growing actor history at once.
 *
 * The caller-owned run result remains untouched: ordinary step fields are
 * cloned, every inline snapshot is hash-checked, and each distinct snapshot is
 * cloned exactly once into the returned frame registry.
 */
function cloneAndCompactAgentSnapshots(options: {
  trajectory: readonly HarnessStepRecord[];
  socialEpisode: SocialEpisodeArtifact<GameState, unknown, unknown, unknown>;
}): {
  trajectory: HarnessStepRecord[];
  socialEpisode: SocialEpisodeArtifact<GameState, unknown, unknown, unknown>;
  frames: AgentSnapshotFrame[];
} {
  const framesById = new Map<string, AgentSnapshotFrame>();
  const frameFor = (
    agents: AgentHarnessState[],
    providedHash: string,
    label: string,
    providedFrameId?: string
  ): AgentSnapshotFrame => {
    const agentsHash = hashStableState(agents);
    if (agentsHash !== providedHash) {
      throw new Error(`${label}: agent snapshot hash mismatch: expected ${agentsHash}, received ${providedHash}.`);
    }
    const frameId = harnessAgentSnapshotFrameId(agentsHash);
    if (providedFrameId !== undefined && providedFrameId !== frameId) {
      throw new Error(`${label}: agent snapshot frame id does not match its hash.`);
    }
    const existing = framesById.get(frameId);
    if (existing) return existing;
    const frame: AgentSnapshotFrame = {
      artifactVersion: AGENT_SNAPSHOT_FRAME_VERSION,
      kind: "agent-snapshot-frame",
      frameId,
      agentsHash,
      agents: cloneJson(agents)
    };
    framesById.set(frameId, frame);
    return frame;
  };

  const trajectory = options.trajectory.map((step, stepIndex) => {
    const agents = step.agentSnapshotsAfterStep;
    const agentsHash = step.agentSnapshotsHashAfterStep;
    if (agents === undefined && agentsHash === undefined) return cloneJson(step);
    if (!Array.isArray(agents) || typeof agentsHash !== "string") {
      throw new Error(`Trajectory step ${stepIndex} ${step.traceId}: agent snapshot payload/hash must be recorded together.`);
    }
    const frame = frameFor(
      agents,
      agentsHash,
      `Trajectory step ${stepIndex} ${step.traceId}`,
      step.agentSnapshotFrameIdAfterStep
    );
    const { agentSnapshotsAfterStep: _inlineAgents, ...stepWithoutInlineAgents } = step;
    return cloneJson({
      ...stepWithoutInlineAgents,
      agentSnapshotsHashAfterStep: frame.agentsHash,
      agentSnapshotFrameIdAfterStep: frame.frameId
    });
  });

  const socialSteps = options.socialEpisode.steps.map((step, stepIndex) => {
    const hasAgents = Array.isArray(step.actorSnapshotsAfterStep);
    const hasHash = typeof step.actorSnapshotsHashAfterStep === "string";
    const hasFrameId = typeof step.actorSnapshotFrameIdAfterStep === "string";
    const label = `Native step ${stepIndex} ${step.traceId}`;
    if (hasAgents !== hasHash) {
      throw new Error(`${label}: actor snapshot payload/hash must be recorded together.`);
    }
    if (hasFrameId && !hasHash) {
      throw new Error(`${label}: actor snapshot frame id requires a snapshot hash.`);
    }
    if (hasAgents) {
      const frame = frameFor(
        step.actorSnapshotsAfterStep as AgentHarnessState[],
        step.actorSnapshotsHashAfterStep!,
        label,
        step.actorSnapshotFrameIdAfterStep
      );
      const { actorSnapshotsAfterStep: _inlineAgents, ...stepWithoutInlineAgents } = step;
      return cloneJson({
        ...stepWithoutInlineAgents,
        actorSnapshotsHashAfterStep: frame.agentsHash,
        actorSnapshotFrameIdAfterStep: frame.frameId
      });
    }
    if (hasHash) {
      const frameId = step.actorSnapshotFrameIdAfterStep!;
      if (frameId !== harnessAgentSnapshotFrameId(step.actorSnapshotsHashAfterStep!)) {
        throw new Error(`${label}: actor snapshot frame id does not match its hash.`);
      }
      const frame = framesById.get(frameId);
      if (!frame || frame.agentsHash !== step.actorSnapshotsHashAfterStep) {
        throw new Error(`${label}: actor snapshot frame reference cannot be resolved.`);
      }
    }
    return cloneJson(step);
  });
  const { steps: _inlineSnapshotSteps, ...episodeWithoutSteps } = options.socialEpisode;
  const socialEpisode = {
    ...cloneJson(episodeWithoutSteps),
    steps: socialSteps
  } as SocialEpisodeArtifact<GameState, unknown, unknown, unknown>;

  return {
    trajectory,
    socialEpisode,
    frames: [...framesById.values()].sort((left, right) => left.frameId.localeCompare(right.frameId))
  };
}

function normalizeAgentSnapshotFramesAfterRedaction(artifact: MatchArtifact): void {
  if (!artifact.agentSnapshotFrames?.length) return;

  const frameByOldId = new Map<string, AgentSnapshotFrame>();
  const frameByOldHash = new Map<string, AgentSnapshotFrame>();
  const dedupedFramesById = new Map<string, AgentSnapshotFrame>();

  for (const frame of artifact.agentSnapshotFrames) {
    const oldFrameId = frame.frameId;
    const oldAgentsHash = frame.agentsHash;
    const agentsHash = hashStableState(frame.agents);
    const frameId = harnessAgentSnapshotFrameId(agentsHash);
    const canonical = dedupedFramesById.get(frameId) ?? {
      artifactVersion: AGENT_SNAPSHOT_FRAME_VERSION,
      kind: "agent-snapshot-frame" as const,
      frameId,
      agentsHash,
      agents: cloneJson(frame.agents)
    };
    dedupedFramesById.set(frameId, canonical);
    frameByOldId.set(oldFrameId, canonical);
    frameByOldHash.set(oldAgentsHash, canonical);
  }

  for (const step of artifact.trajectory) {
    const frame = (step.agentSnapshotFrameIdAfterStep ? frameByOldId.get(step.agentSnapshotFrameIdAfterStep) : undefined) ??
      (step.agentSnapshotsHashAfterStep ? frameByOldHash.get(step.agentSnapshotsHashAfterStep) : undefined);
    if (!frame) continue;
    step.agentSnapshotsHashAfterStep = frame.agentsHash;
    step.agentSnapshotFrameIdAfterStep = frame.frameId;
  }

  for (const step of artifact.socialEpisode.steps) {
    const frame = (step.actorSnapshotFrameIdAfterStep ? frameByOldId.get(step.actorSnapshotFrameIdAfterStep) : undefined) ??
      (step.actorSnapshotsHashAfterStep ? frameByOldHash.get(step.actorSnapshotsHashAfterStep) : undefined);
    if (!frame) continue;
    step.actorSnapshotsHashAfterStep = frame.agentsHash;
    step.actorSnapshotFrameIdAfterStep = frame.frameId;
  }

  artifact.agentSnapshotFrames = [...dedupedFramesById.values()].sort((a, b) => a.frameId.localeCompare(b.frameId));
}

function findAgentSnapshotFrame(artifact: MatchArtifact, step: HarnessStepRecord): AgentSnapshotFrame | undefined {
  const frames = artifact.agentSnapshotFrames ?? [];
  const byFrameId = step.agentSnapshotFrameIdAfterStep
    ? frames.find((frame) => frame.frameId === step.agentSnapshotFrameIdAfterStep)
    : undefined;
  if (byFrameId) return byFrameId;
  if (!step.agentSnapshotsHashAfterStep) return undefined;
  return frames.find((frame) => frame.agentsHash === step.agentSnapshotsHashAfterStep);
}
