import type { HarnessCheckpoint, MatchArtifact } from "../harness/artifacts";
import { hashStableState } from "../harness/hash";
import { countSocialStepCommits } from "../harness/social";
import type { HarnessAgentProfile, HarnessForkProvenance } from "../harness/types";
import { sanitizeApiErrorText } from "./apiFailure";
import { optionalIntegerQuery } from "./httpValidation";
import { isRecord } from "./jsonUtil";
import type { StoredCheckpointForkAttempt } from "./store";

export const CHECKPOINT_BRANCH_TREE_MAX_DEPTH_LIMIT = 100;

export const CHECKPOINT_BRANCH_TREE_MAX_NODES_LIMIT = 1000;

export interface CheckpointBranchTreeQuery {
  maxDepth?: number;
  maxNodes?: number;
}

export function serializeCheckpointPublicResponse(checkpoint: HarnessCheckpoint): object {
  return {
    summary: serializeCheckpointSummary(checkpoint),
    artifactUrl: checkpointArtifactUrl(checkpoint.checkpointId)
  };
}

export function serializeCheckpointSummary(checkpoint: HarnessCheckpoint): object {
  return {
    kind: "checkpoint",
    ok: true,
    checkpointId: checkpoint.checkpointId,
    createdAt: checkpoint.createdAt,
    reason: checkpoint.reason ?? null,
    source: {
      runId: checkpoint.source.runId,
      matchId: checkpoint.source.matchId ?? null,
      seed: checkpoint.source.seed,
      rulesetId: checkpoint.source.rulesetId,
      status: checkpoint.source.status,
      boundaryTraceRef: checkpoint.source.boundaryTraceId
        ? hashStableState({ traceId: checkpoint.source.boundaryTraceId }).slice(0, 16)
        : null,
      boundaryTurnIndex: checkpoint.source.boundaryTurnIndex ?? null,
      boundaryBatchId: checkpoint.source.boundaryBatchId ?? null,
      boundaryBatchIndex: checkpoint.source.boundaryBatchIndex ?? null,
      boundarySchedulerMode: checkpoint.source.boundarySchedulerMode ?? null,
      nativeStepCount: checkpoint.source.nativeStepCount,
      messageCount: checkpoint.source.messageCount,
      lastMessageSeq: checkpoint.source.lastMessageSeq ?? null,
      stateHash: checkpoint.source.stateHash,
      executionPrefixHash: checkpoint.source.executionPrefixHash,
      agentsHash: checkpoint.source.agentsHash,
      channelsHash: checkpoint.source.channelsHash,
      messagesHash: checkpoint.source.messagesHash,
      failureReason: checkpoint.source.failureReason ? sanitizeApiErrorText(checkpoint.source.failureReason) : null,
      truncationReason: checkpoint.source.truncationReason ?? null
    },
    counts: {
      agents: checkpoint.agents.length,
      ...countSocialStepCommits(checkpoint.executionPrefix.steps),
      socialMessages: checkpoint.executionPrefix.messages.length,
      channels: checkpoint.executionPrefix.channels.length
    }
  };
}

export function buildCheckpointForksSummary(
  checkpoint: HarnessCheckpoint,
  artifacts: MatchArtifact[],
  attempts: StoredCheckpointForkAttempt[] = []
): object {
  const forks = artifacts.map((artifact) => buildForkChildSummary(artifact, checkpoint));
  const artifactRunIds = new Set(artifacts.map((artifact) => artifact.runId));
  const unresolvedAttempts = attempts
    .filter((attempt) => !artifactRunIds.has(attempt.childRunId))
    .map((attempt) => buildCheckpointForkAttemptSummary(attempt, checkpoint));
  return {
    kind: "checkpoint-forks",
    schemaVersion: "server.checkpoint-forks-summary.v3",
    ok:
      forks.every((fork) => isRecord(fork.lineage) && fork.lineage.ok === true) &&
      unresolvedAttempts.every((attempt) => isRecord(attempt.boundary) && attempt.boundary.ok === true),
    checkpoint: serializeCheckpointSummary(checkpoint),
    childCount: forks.length + unresolvedAttempts.length,
    artifactChildCount: forks.length,
    attemptCount: unresolvedAttempts.length,
    failedAttemptCount: unresolvedAttempts.filter((attempt) => attempt.status === "failed").length,
    runningAttemptCount: unresolvedAttempts.filter((attempt) => attempt.status === "running").length,
    forks,
    attempts: unresolvedAttempts
  };
}

export function buildCheckpointBranchTreeSummary(
  rootCheckpoint: HarnessCheckpoint,
  artifacts: MatchArtifact[],
  checkpoints: HarnessCheckpoint[],
  attempts: StoredCheckpointForkAttempt[] = [],
  limits: CheckpointBranchTreeQuery = {}
): object {
  const checkpointById = new Map<string, HarnessCheckpoint>();
  for (const checkpoint of checkpoints) checkpointById.set(checkpoint.checkpointId, checkpoint);
  checkpointById.set(rootCheckpoint.checkpointId, rootCheckpoint);

  const artifactsByParentCheckpoint = new Map<string, MatchArtifact[]>();
  for (const artifact of artifacts) {
    const checkpointId = artifact.forkOf?.checkpointId;
    if (!checkpointId) continue;
    const current = artifactsByParentCheckpoint.get(checkpointId) ?? [];
    current.push(artifact);
    artifactsByParentCheckpoint.set(checkpointId, current);
  }
  for (const children of artifactsByParentCheckpoint.values()) {
    children.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const artifactRunIds = new Set(artifacts.map((artifact) => artifact.runId));
  const attemptsByParentCheckpoint = new Map<string, StoredCheckpointForkAttempt[]>();
  for (const attempt of attempts) {
    if (artifactRunIds.has(attempt.childRunId)) continue;
    const current = attemptsByParentCheckpoint.get(attempt.forkOf.checkpointId) ?? [];
    current.push(attempt);
    attemptsByParentCheckpoint.set(attempt.forkOf.checkpointId, current);
  }
  for (const children of attemptsByParentCheckpoint.values()) {
    children.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const checkpointsBySourceRun = new Map<string, HarnessCheckpoint[]>();
  for (const checkpoint of checkpointById.values()) {
    const sourceIds = new Set([checkpoint.source.runId, checkpoint.source.matchId].filter((id): id is string => Boolean(id)));
    for (const sourceId of sourceIds) {
      const current = checkpointsBySourceRun.get(sourceId) ?? [];
      current.push(checkpoint);
      checkpointsBySourceRun.set(sourceId, current);
    }
  }
  for (const sourceCheckpoints of checkpointsBySourceRun.values()) {
    sourceCheckpoints.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const checkpointNodes = new Map<string, object>();
  const matchNodes = new Map<string, object>();
  const attemptNodes = new Map<string, object>();
  const edges = new Map<string, object>();
  const truncationReasons = new Set<string>();
  const truncation = {
    omittedCheckpoints: 0,
    omittedMatches: 0,
    omittedAttempts: 0,
    omittedEdges: 0
  };
  const nodeCount = () => checkpointNodes.size + matchNodes.size + attemptNodes.size;
  const recordOmittedNode = (kind: "checkpoint" | "match" | "attempt", reason: "maxDepth" | "maxNodes") => {
    truncationReasons.add(reason);
    if (kind === "checkpoint") truncation.omittedCheckpoints += 1;
    else if (kind === "match") truncation.omittedMatches += 1;
    else truncation.omittedAttempts += 1;
  };
  const canIncludeNode = (kind: "checkpoint" | "match" | "attempt", alreadyIncluded: boolean, depth: number): boolean => {
    if (limits.maxDepth !== undefined && depth > limits.maxDepth) {
      recordOmittedNode(kind, "maxDepth");
      return false;
    }
    if (!alreadyIncluded && limits.maxNodes !== undefined && nodeCount() >= limits.maxNodes) {
      recordOmittedNode(kind, "maxNodes");
      return false;
    }
    return true;
  };
  const includeCheckpointNode = (checkpoint: HarnessCheckpoint, depth: number): boolean => {
    const existing = checkpointNodes.get(checkpoint.checkpointId);
    const existingDepth = checkpointNodeDepth(existing);
    if (existingDepth !== null && existingDepth <= depth) return true;
    if (!canIncludeNode("checkpoint", Boolean(existing), depth)) return false;
    checkpointNodes.set(checkpoint.checkpointId, {
      depth,
      checkpointId: checkpoint.checkpointId,
      createdAt: checkpoint.createdAt,
      childForkCount:
        (artifactsByParentCheckpoint.get(checkpoint.checkpointId)?.length ?? 0) +
        (attemptsByParentCheckpoint.get(checkpoint.checkpointId)?.length ?? 0),
      artifactChildCount: artifactsByParentCheckpoint.get(checkpoint.checkpointId)?.length ?? 0,
      childAttemptCount: attemptsByParentCheckpoint.get(checkpoint.checkpointId)?.length ?? 0,
      summary: serializeCheckpointSummary(checkpoint)
    });
    return true;
  };
  const includeMatchNode = (artifact: MatchArtifact, checkpoint: HarnessCheckpoint, depth: number): Record<string, unknown> | undefined => {
    const existing = matchNodes.get(artifact.runId);
    const existingDepth = checkpointNodeDepth(existing);
    if (isRecord(existing) && existingDepth !== null && existingDepth <= depth) return existing;
    if (!canIncludeNode("match", Boolean(existing), depth)) return undefined;
    const childSummary = buildForkChildSummary(artifact, checkpoint);
    const node = {
      depth,
      parentCheckpointId: checkpoint.checkpointId,
      ...childSummary
    };
    matchNodes.set(artifact.runId, node);
    return node;
  };
  const includeAttemptNode = (
    attempt: StoredCheckpointForkAttempt,
    checkpoint: HarnessCheckpoint,
    depth: number
  ): Record<string, unknown> | undefined => {
    const existing = attemptNodes.get(attempt.childRunId);
    const existingDepth = checkpointNodeDepth(existing);
    if (isRecord(existing) && existingDepth !== null && existingDepth <= depth) return existing;
    if (!canIncludeNode("attempt", Boolean(existing), depth)) return undefined;
    const node = {
      depth,
      parentCheckpointId: checkpoint.checkpointId,
      ...buildCheckpointForkAttemptSummary(attempt, checkpoint)
    };
    attemptNodes.set(attempt.childRunId, node);
    return node;
  };
  const queue: Array<{ kind: "checkpoint"; checkpoint: HarnessCheckpoint; depth: number } | { kind: "match"; artifact: MatchArtifact; depth: number }> = [
    { kind: "checkpoint", checkpoint: rootCheckpoint, depth: 0 }
  ];
  const processedCheckpoints = new Set<string>();
  const processedMatches = new Set<string>();

  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    if (item.kind === "checkpoint") {
      const checkpoint = item.checkpoint;
      if (!includeCheckpointNode(checkpoint, item.depth)) continue;
      if (processedCheckpoints.has(checkpoint.checkpointId)) continue;
      processedCheckpoints.add(checkpoint.checkpointId);

      for (const artifact of artifactsByParentCheckpoint.get(checkpoint.checkpointId) ?? []) {
        const childDepth = item.depth + 1;
        const childSummary = includeMatchNode(artifact, checkpoint, childDepth);
        if (!childSummary) {
          truncation.omittedEdges += 1;
          continue;
        }
        const edgeId = `checkpoint-fork:${checkpoint.checkpointId}:${artifact.runId}`;
        const lineage = isRecord(childSummary.lineage) ? childSummary.lineage : {};
        const boundary = isRecord(lineage.boundary) ? lineage.boundary : {};
        edges.set(edgeId, {
          id: edgeId,
          kind: "checkpoint-fork",
          fromCheckpointId: checkpoint.checkpointId,
          toRunId: artifact.runId,
          ok: lineage.ok === true,
          boundaryStatus: typeof boundary.status === "string" ? boundary.status : "unknown"
        });
        if (!processedMatches.has(artifact.runId)) queue.push({ kind: "match", artifact, depth: childDepth });
      }
      for (const attempt of attemptsByParentCheckpoint.get(checkpoint.checkpointId) ?? []) {
        const childDepth = item.depth + 1;
        const attemptSummary = includeAttemptNode(attempt, checkpoint, childDepth);
        if (!attemptSummary) {
          truncation.omittedEdges += 1;
          continue;
        }
        const edgeId = `checkpoint-fork-attempt:${checkpoint.checkpointId}:${attempt.childRunId}`;
        const boundary = isRecord(attemptSummary.boundary) ? attemptSummary.boundary : {};
        edges.set(edgeId, {
          id: edgeId,
          kind: "checkpoint-fork-attempt",
          fromCheckpointId: checkpoint.checkpointId,
          toRunId: attempt.childRunId,
          ok: boundary.ok === true,
          boundaryStatus: typeof boundary.status === "string" ? boundary.status : "unknown"
        });
      }
    } else {
      const artifact = item.artifact;
      if (processedMatches.has(artifact.runId)) continue;
      processedMatches.add(artifact.runId);
      const sourceCheckpoints = checkpointsBySourceRun.get(artifact.runId) ?? [];
      for (const checkpoint of sourceCheckpoints) {
        if (checkpoint.checkpointId === rootCheckpoint.checkpointId) continue;
        const childDepth = item.depth + 1;
        if (!includeCheckpointNode(checkpoint, childDepth)) {
          truncation.omittedEdges += 1;
          continue;
        }
        const edgeId = `match-checkpoint:${artifact.runId}:${checkpoint.checkpointId}`;
        edges.set(edgeId, {
          id: edgeId,
          kind: "match-checkpoint",
          fromRunId: artifact.runId,
          toCheckpointId: checkpoint.checkpointId
        });
        if (!processedCheckpoints.has(checkpoint.checkpointId)) {
          queue.push({ kind: "checkpoint", checkpoint, depth: childDepth });
        }
      }
    }
  }

  const checkpointList = [...checkpointNodes.values()].sort(branchNodeSort);
  const matchList = [...matchNodes.values()].sort(branchNodeSort);
  const attemptList = [...attemptNodes.values()].sort(branchNodeSort);
  const edgeList = [...edges.values()].sort((a, b) => branchNodeId(a).localeCompare(branchNodeId(b)));
  const lineageOk = matchList.every((node) => {
    if (!isRecord(node) || !isRecord(node.lineage)) return true;
    return node.lineage.ok === true;
  });
  const attemptLineageOk = attemptList.every((node) => isRecord(node) && isRecord(node.boundary) && node.boundary.ok === true);
  const maxDepth = [...checkpointList, ...matchList, ...attemptList].reduce(
    (max, node) => Math.max(max, checkpointNodeDepth(node) ?? 0),
    0
  );
  return {
    kind: "checkpoint-branch-tree",
    schemaVersion: "server.checkpoint-branch-tree-summary.v3",
    ok: lineageOk && attemptLineageOk,
    okScope: "returned",
    rootCheckpointId: rootCheckpoint.checkpointId,
    root: serializeCheckpointSummary(rootCheckpoint),
    counts: {
      checkpoints: checkpointList.length,
      matches: matchList.length,
      attempts: attemptList.length,
      failedAttempts: attemptList.filter((node) => isRecord(node) && node.status === "failed").length,
      runningAttempts: attemptList.filter((node) => isRecord(node) && node.status === "running").length,
      edges: edgeList.length,
      maxDepth
    },
    limits: {
      maxDepth: limits.maxDepth ?? null,
      maxNodes: limits.maxNodes ?? null
    },
    truncation: {
      isTruncated: truncationReasons.size > 0,
      reasons: [...truncationReasons].sort(),
      omittedCheckpoints: truncation.omittedCheckpoints,
      omittedMatches: truncation.omittedMatches,
      omittedAttempts: truncation.omittedAttempts,
      omittedEdges: truncation.omittedEdges
    },
    checkpoints: checkpointList,
    matches: matchList,
    attempts: attemptList,
    edges: edgeList
  };
}

export function buildForkChildSummary(artifact: MatchArtifact, checkpoint: HarnessCheckpoint): Record<string, unknown> {
  const lineage = buildForkLineageSummary(artifact, checkpoint);
  const stepCounts = countSocialStepCommits(artifact.socialEpisode.steps);
  return {
    runId: artifact.runId,
    matchId: artifact.matchId ?? null,
    createdAt: artifact.createdAt,
    status: artifact.status,
    truncationReason: artifact.truncationReason ?? null,
    failureReason: artifact.failureReason ? sanitizeApiErrorText(artifact.failureReason) : null,
    nativeStepCount: stepCounts.nativeSteps,
    committedSteps: stepCounts.committedSteps,
    rejectedSteps: stepCounts.rejectedSteps,
    legacyProjectionSteps: artifact.trajectory.length,
    socialMessages: artifact.socialEpisode.messages.length,
    forkOf: artifact.forkOf ? summarizeForkProvenance(artifact.forkOf) : null,
    lineage
  };
}

export function buildCheckpointForkAttemptSummary(
  attempt: StoredCheckpointForkAttempt,
  checkpoint?: HarnessCheckpoint
): Record<string, unknown> {
  const checkpointSourceMatchesForkOf = checkpoint
    ? checkpointSourceMatchesForkProvenance(checkpoint, attempt.forkOf)
    : null;
  return {
    kind: "checkpoint-fork-attempt",
    schemaVersion: attempt.schemaVersion,
    runId: attempt.childRunId,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    status: attempt.status,
    hasArtifact: false,
    forkOf: summarizeForkProvenance(attempt.forkOf),
    limits: {
      maxTransitions: attempt.limits.maxTransitions,
      timeoutMs: attempt.limits.timeoutMs
    },
    elapsedMs: attempt.elapsedMs ?? null,
    timedOut: attempt.timedOut ?? null,
    failureCode: attempt.failureCode ?? null,
    failureReason: attempt.failureReason ? sanitizeApiErrorText(attempt.failureReason) : null,
    providerFailure: attempt.providerFailure ?? null,
    boundary: {
      status: attempt.status === "failed" ? "fork_attempt_failed_before_artifact" : "fork_attempt_running_before_artifact",
      ok: false,
      provenanceOk: checkpointSourceMatchesForkOf === true,
      checkpointFound: Boolean(checkpoint),
      checkpointSourceMatchesForkOf
    }
  };
}

export function buildCheckpointForkAttemptLineageSummary(
  attempt: StoredCheckpointForkAttempt,
  checkpoint?: HarnessCheckpoint
): object {
  const summary = buildCheckpointForkAttemptSummary(attempt, checkpoint);
  const boundary = isRecord(summary.boundary) ? summary.boundary : {};
  return {
    kind: "fork-lineage",
    schemaVersion: "server.fork-lineage-summary.v3",
    ok: boundary.ok === true,
    isFork: true,
    artifactAvailable: false,
    runId: attempt.childRunId,
    matchId: attempt.childRunId,
    forkOf: summary.forkOf,
    parent: {
      checkpointId: attempt.forkOf.checkpointId,
      runId: attempt.forkOf.parentRunId ?? null,
      matchId: attempt.forkOf.parentMatchId ?? null,
      checkpointFound: Boolean(checkpoint)
    },
    child: {
      runId: attempt.childRunId,
      matchId: attempt.childRunId,
      status: attempt.status,
      artifactAvailable: false,
      failureReason: summary.failureReason
    },
    boundary
  };
}

export function branchNodeSort(a: object, b: object): number {
  const depthDelta = (checkpointNodeDepth(a) ?? 0) - (checkpointNodeDepth(b) ?? 0);
  if (depthDelta !== 0) return depthDelta;
  const aCreatedAt = isRecord(a) && typeof a.createdAt === "string" ? a.createdAt : "";
  const bCreatedAt = isRecord(b) && typeof b.createdAt === "string" ? b.createdAt : "";
  return bCreatedAt.localeCompare(aCreatedAt);
}

export function checkpointNodeDepth(value: unknown): number | null {
  return isRecord(value) && typeof value.depth === "number" ? value.depth : null;
}

export function branchNodeId(value: unknown): string {
  return isRecord(value) && typeof value.id === "string" ? value.id : "";
}

export function buildForkLineageSummary(artifact: MatchArtifact, checkpoint?: HarnessCheckpoint): object {
  const forkOf = artifact.forkOf;
  const firstStep = artifact.socialEpisode.steps[0];
  const finalStep = artifact.socialEpisode.steps.at(-1);
  const lastMessage = artifact.socialEpisode.messages.at(-1);
  const stepCounts = countSocialStepCommits(artifact.socialEpisode.steps);
  const childSummary = {
    runId: artifact.runId,
    matchId: artifact.matchId ?? null,
    createdAt: artifact.createdAt,
    status: artifact.status,
    truncationReason: artifact.truncationReason ?? null,
    failureReason: artifact.failureReason ? sanitizeApiErrorText(artifact.failureReason) : null,
    nativeStepCount: stepCounts.nativeSteps,
    committedSteps: stepCounts.committedSteps,
    rejectedSteps: stepCounts.rejectedSteps,
    legacyProjectionSteps: artifact.trajectory.length,
    socialMessages: artifact.socialEpisode.messages.length,
    firstStepPreStateHash: firstStep?.preStateHash ?? null,
    finalStepPostStateHash: finalStep?.postStateHash ?? null,
    finalStateHash: hashStableState(artifact.finalState),
    firstNewMessageSeq: checkpoint ? artifact.socialEpisode.messages[checkpoint.executionPrefix.messages.length]?.seq ?? null : null,
    lastMessageSeq: lastMessage?.seq ?? null
  };

  if (!forkOf) {
    return {
      kind: "fork-lineage",
      schemaVersion: "server.fork-lineage-summary.v2",
      ok: true,
      isFork: false,
      runId: artifact.runId,
      matchId: artifact.matchId ?? null,
      forkOf: null,
      parent: null,
      child: childSummary,
      boundary: {
        status: "not_fork",
        checkpointFound: false,
        stateHashMatches: null,
        checkpointSourceMatchesForkOf: null,
        messagePrefixMatchesCheckpoint: null,
        newNativeSteps: stepCounts.nativeSteps,
        newCommittedSteps: stepCounts.committedSteps,
        newRejectedSteps: stepCounts.rejectedSteps,
        newSocialMessages: null
      }
    };
  }

  const checkpointSourceMatchesForkOf = checkpoint ? checkpointSourceMatchesForkProvenance(checkpoint, forkOf) : null;
  const messagePrefixMatchesCheckpoint = checkpoint ? socialMessagePrefixMatchesCheckpoint(artifact, checkpoint) : null;
  const stateHashMatches = firstStep ? firstStep.preStateHash === forkOf.parentStateHash : null;
  const boundaryStatus = forkBoundaryStatus({
    checkpoint,
    checkpointSourceMatchesForkOf,
    messagePrefixMatchesCheckpoint,
    stateHashMatches,
    hasChildStep: Boolean(firstStep)
  });
  const newSocialMessages = checkpoint ? artifact.socialEpisode.messages.length - checkpoint.executionPrefix.messages.length : null;

  return {
    kind: "fork-lineage",
    schemaVersion: "server.fork-lineage-summary.v2",
    ok: boundaryStatus !== "mismatch",
    isFork: true,
    runId: artifact.runId,
    matchId: artifact.matchId ?? null,
    forkOf: summarizeForkProvenance(forkOf),
    parent: {
      checkpointId: forkOf.checkpointId,
      runId: forkOf.parentRunId ?? null,
      matchId: forkOf.parentMatchId ?? null,
      boundaryTraceRef: forkOf.parentBoundaryTraceId
        ? hashStableState({ traceId: forkOf.parentBoundaryTraceId }).slice(0, 16)
        : null,
      boundaryTurnIndex: forkOf.parentBoundaryTurnIndex ?? null,
      nativeStepCount: forkOf.parentNativeStepCount,
      messageCount: forkOf.parentMessageCount,
      lastMessageSeq: checkpoint?.source.lastMessageSeq ?? null,
      stateHash: forkOf.parentStateHash,
      executionPrefixHash: forkOf.parentExecutionPrefixHash,
      agentsHash: forkOf.parentAgentsHash,
      channelsHash: forkOf.parentChannelsHash,
      messagesHash: forkOf.parentMessagesHash,
      checkpointFound: Boolean(checkpoint)
    },
    child: childSummary,
    boundary: {
      status: boundaryStatus,
      checkpointFound: Boolean(checkpoint),
      stateHashMatches,
      checkpointSourceMatchesForkOf,
      messagePrefixMatchesCheckpoint,
      newNativeSteps: stepCounts.nativeSteps,
      newCommittedSteps: stepCounts.committedSteps,
      newRejectedSteps: stepCounts.rejectedSteps,
      newSocialMessages
    }
  };
}

export function checkpointSourceMatchesForkProvenance(checkpoint: HarnessCheckpoint, forkOf: HarnessForkProvenance): boolean {
  return (
    checkpoint.checkpointId === forkOf.checkpointId &&
    checkpoint.source.runId === forkOf.parentRunId &&
    (checkpoint.source.matchId ?? null) === (forkOf.parentMatchId ?? null) &&
    checkpoint.source.rulesetId === forkOf.parentRulesetId &&
    (checkpoint.source.boundaryTraceId ?? null) === (forkOf.parentBoundaryTraceId ?? null) &&
    (checkpoint.source.boundaryTurnIndex ?? null) === (forkOf.parentBoundaryTurnIndex ?? null) &&
    checkpoint.source.stateHash === forkOf.parentStateHash &&
    checkpoint.source.executionPrefixHash === forkOf.parentExecutionPrefixHash &&
    checkpoint.source.agentsHash === forkOf.parentAgentsHash &&
    checkpoint.source.channelsHash === forkOf.parentChannelsHash &&
    checkpoint.source.messagesHash === forkOf.parentMessagesHash &&
    checkpoint.source.nativeStepCount === forkOf.parentNativeStepCount &&
    checkpoint.source.messageCount === forkOf.parentMessageCount
  );
}

export function socialMessagePrefixMatchesCheckpoint(artifact: MatchArtifact, checkpoint: HarnessCheckpoint): boolean {
  if (artifact.socialEpisode.messages.length < checkpoint.executionPrefix.messages.length) return false;
  const prefix = artifact.socialEpisode.messages.slice(0, checkpoint.executionPrefix.messages.length);
  return hashStableState(prefix) === checkpoint.source.messagesHash;
}

export function forkBoundaryStatus(input: {
  checkpoint: HarnessCheckpoint | undefined;
  checkpointSourceMatchesForkOf: boolean | null;
  messagePrefixMatchesCheckpoint: boolean | null;
  stateHashMatches: boolean | null;
  hasChildStep: boolean;
}): string {
  if (
    input.stateHashMatches === false ||
    input.checkpointSourceMatchesForkOf === false ||
    input.messagePrefixMatchesCheckpoint === false
  ) {
    return "mismatch";
  }
  if (!input.hasChildStep) return "no_child_steps";
  if (!input.checkpoint) return "checkpoint_unavailable";
  return "verified";
}

export function checkpointArtifactUrl(checkpointId: string): string {
  return `/api/checkpoints/${encodeURIComponent(checkpointId)}/artifact`;
}

export function modelsFromCheckpoint(checkpoint: HarnessCheckpoint): string[] {
  return Array.from(new Set(checkpoint.agents.map((agent) => agent.model)));
}

export function profilesFromCheckpoint(checkpoint: HarnessCheckpoint): HarnessAgentProfile[] {
  const profiles = new Map<string, HarnessAgentProfile>();
  for (const agent of checkpoint.agents) {
    const id = agent.profileId ?? agent.playerId;
    if (profiles.has(id)) continue;
    profiles.set(id, {
      id,
      model: agent.model,
      temperature: agent.temperature,
      policyName: agent.policyName
    });
  }
  return [...profiles.values()];
}

export function checkpointBranchTreeQueryFromRequest(query: unknown): CheckpointBranchTreeQuery {
  const record = isRecord(query) ? query : {};
  return {
    maxDepth: optionalIntegerQuery(record, "maxDepth", {
      min: 0,
      max: CHECKPOINT_BRANCH_TREE_MAX_DEPTH_LIMIT,
      label: "Checkpoint branch tree"
    }),
    maxNodes: optionalIntegerQuery(record, "maxNodes", {
      min: 1,
      max: CHECKPOINT_BRANCH_TREE_MAX_NODES_LIMIT,
      label: "Checkpoint branch tree"
    })
  };
}

export function summarizeForkProvenance(forkOf: HarnessForkProvenance): object {
  return {
    schemaVersion: forkOf.schemaVersion,
    checkpointArtifactVersion: forkOf.checkpointArtifactVersion,
    checkpointId: forkOf.checkpointId,
    parentRunId: forkOf.parentRunId,
    parentMatchId: forkOf.parentMatchId,
    parentRulesetId: forkOf.parentRulesetId,
    parentBoundaryTraceRef: forkOf.parentBoundaryTraceId
      ? hashStableState({ traceId: forkOf.parentBoundaryTraceId }).slice(0, 16)
      : null,
    parentBoundaryTurnIndex: forkOf.parentBoundaryTurnIndex,
    parentStateHash: forkOf.parentStateHash,
    parentExecutionPrefixHash: forkOf.parentExecutionPrefixHash,
    parentAgentsHash: forkOf.parentAgentsHash,
    parentChannelsHash: forkOf.parentChannelsHash,
    parentMessagesHash: forkOf.parentMessagesHash,
    parentNativeStepCount: forkOf.parentNativeStepCount,
    parentMessageCount: forkOf.parentMessageCount,
    createdAt: forkOf.createdAt,
    reason: forkOf.reason
  };
}
