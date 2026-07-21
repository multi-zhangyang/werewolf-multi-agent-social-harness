import { hashStableState } from "./hash";
import {
  validateSocialEpisodeArtifact,
  type SocialEpisodeArtifact,
  type SocialEpisodeStatus,
  type SocialMessage,
  type SocialResolvedSchedulerMode
} from "./social";

/**
 * Domain-neutral artifact primitives. A domain owns its state, command codec,
 * evaluator payload, and public projection; this module owns only the stable
 * execution envelope shared by replayable social experiments.
 */
export const HARNESS_EPISODE_ENVELOPE_VERSION = "harness.episode-envelope.v1";
export const HARNESS_CHECKPOINT_ENVELOPE_VERSION = "harness.checkpoint-envelope.v1";
export const HARNESS_FORK_PROVENANCE_VERSION = "harness.fork-provenance.v2";
export const HARNESS_AGENT_SNAPSHOT_FRAME_VERSION = "harness.agent-snapshot-frame.v1";

export interface GenericForkProvenance<TCheckpointArtifactVersion extends string = string> {
  schemaVersion: typeof HARNESS_FORK_PROVENANCE_VERSION;
  checkpointArtifactVersion: TCheckpointArtifactVersion;
  checkpointId: string;
  parentRunId?: string;
  /** Generic parent identity. Domain compatibility layers may add their own id. */
  parentArtifactId?: string;
  parentBoundaryTraceId?: string;
  parentEvidenceTraceIds?: string[];
  parentBoundaryTurnIndex?: number;
  parentStateHash: string;
  parentExecutionPrefixHash: string;
  parentAgentsHash: string;
  parentChannelsHash: string;
  parentMessagesHash: string;
  parentNativeStepCount: number;
  parentMessageCount: number;
  createdAt: string;
  reason?: string;
}

/**
 * The domain-neutral, canonical portion of a completed or truncated social
 * episode. It deliberately has no seed, role, team, evaluator, or UI fields.
 */
export interface HarnessEpisodeArtifactEnvelope<
  TState = unknown,
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TAgentState = unknown,
  TForkProvenance = GenericForkProvenance
> {
  artifactVersion: string;
  kind: string;
  runId: string;
  createdAt: string;
  status: SocialEpisodeStatus;
  initialState: TState;
  finalState: TState;
  socialEpisode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  agents: TAgentState[];
  forkOf?: TForkProvenance;
}

/**
 * Snapshots are deduplicated by the stable hash of the full actor-state array.
 * The payload stays generic so a domain can choose its own actor-state schema.
 */
export interface HarnessAgentSnapshotFrame<TAgentState = unknown> {
  artifactVersion: string;
  kind: string;
  frameId: string;
  agentsHash: string;
  agents: TAgentState[];
}

export function harnessAgentSnapshotFrameId(agentsHash: string): string {
  return `agent-snapshot:${agentsHash}`;
}

/**
 * Generic checkpoint source provenance. A domain can extend this with its
 * initialization recipe (for example a seed or scenario id) without making
 * that domain detail part of the harness core.
 */
export interface HarnessCheckpointSource {
  sourceArtifactVersion: string;
  runId: string;
  status: SocialEpisodeStatus;
  boundaryTraceId?: string;
  boundaryTurnIndex?: number;
  boundaryBatchId?: string;
  boundaryBatchIndex?: number;
  boundarySchedulerMode?: SocialResolvedSchedulerMode;
  nativeStepCount: number;
  messageCount: number;
  lastMessageSeq?: number;
  stateHash: string;
  executionPrefixHash: string;
  agentsHash: string;
  channelsHash: string;
  messagesHash: string;
  agentSnapshotFrameId?: string;
  failureReason?: string;
  truncationReason?: string;
}

/**
 * A checkpoint is replay/fork authority only when paired with a domain-owned
 * environment factory. This envelope contains no model provider or public
 * projection data, so deterministic replay can use it without model calls.
 */
export interface HarnessCheckpointEnvelope<
  TState = unknown,
  TAgentState = unknown,
  TObservation = unknown,
  TPending = unknown,
  TCommand = unknown,
  TSource extends HarnessCheckpointSource = HarnessCheckpointSource
> {
  artifactVersion: string;
  kind: string;
  checkpointId: string;
  createdAt: string;
  reason?: string;
  source: TSource;
  state: TState;
  agents: TAgentState[];
  executionPrefix: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
}

export interface HarnessCheckpointReplayResult {
  mismatches: readonly string[];
  finalHash?: string;
  messagesHash?: string;
}

/**
 * Validates only invariants that every social domain shares. Domain adapters
 * add role/action/evaluator checks in their own artifact validators.
 */
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
  if (artifact.forkOf) errors.push(...validateGenericForkProvenance(artifact.forkOf));
  return errors;
}

export function validateGenericForkProvenance(provenance: GenericForkProvenance): string[] {
  const errors: string[] = [];
  if (provenance.schemaVersion !== HARNESS_FORK_PROVENANCE_VERSION) {
    errors.push(`forkOf.schemaVersion must be ${HARNESS_FORK_PROVENANCE_VERSION}.`);
  }
  if (!isNonemptyString(provenance.checkpointArtifactVersion)) errors.push("forkOf.checkpointArtifactVersion is required.");
  if (!isNonemptyString(provenance.checkpointId)) errors.push("forkOf.checkpointId is required.");
  if (!isNonemptyString(provenance.createdAt)) errors.push("forkOf.createdAt is required.");
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
  } else {
    if (checkpoint.source.boundaryTraceId !== undefined) errors.push("source.boundaryTraceId must be undefined when native prefix is empty.");
    if (checkpoint.source.boundaryTurnIndex !== undefined) errors.push("source.boundaryTurnIndex must be undefined when native prefix is empty.");
    if (checkpoint.source.boundarySchedulerMode !== undefined) errors.push("source.boundarySchedulerMode must be undefined when native prefix is empty.");
  }

  validateCheckpointMessages(checkpoint.executionPrefix.messages, checkpoint.source.lastMessageSeq, errors);
  for (const error of validateSocialEpisodeArtifact(checkpoint.executionPrefix)) errors.push(`executionPrefix: ${error}`);
  const terminalRejectedFailureBoundary =
    checkpoint.source.status === "failed" &&
    checkpoint.executionPrefix.status === "failed" &&
    checkpoint.executionPrefix.steps.at(-1)?.commitStatus === "rejected" &&
    Boolean(checkpoint.executionPrefix.steps.at(-1)?.failure);
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

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function endsAtCompleteNativeBatch(steps: SocialEpisodeArtifact["steps"]): boolean {
  const boundary = steps.at(-1);
  if (!boundary?.batchId || boundary.schedulerMode === "aec") return true;
  if (!boundary.batchSize || boundary.batchSize < 1) return false;
  let contiguousBatchSize = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].batchId !== boundary.batchId) break;
    contiguousBatchSize += 1;
  }
  return contiguousBatchSize === boundary.batchSize;
}
