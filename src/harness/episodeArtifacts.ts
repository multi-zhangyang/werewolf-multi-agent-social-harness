import { hashStableState } from "./hash";
import {
  isSocialStepCommitted,
  validateSocialEpisodeArtifact,
  type SocialEpisodeArtifact,
  type SocialHarnessStep,
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
 * A generic checkpoint can only be created at a complete native execution
 * boundary.  These error codes are deliberately domain-neutral: a domain may
 * add stricter validation for its own actor snapshots, but it must not
 * reinterpret a partial joint batch as a valid continuation point.
 */
export type HarnessCheckpointSelectionErrorCode =
  | "ambiguous_selector"
  | "selector_not_found"
  | "missing_agent_snapshots"
  | "unsafe_batch_boundary"
  | "prefix_replay_mismatch";

export class HarnessCheckpointSelectionError extends Error {
  constructor(
    readonly code: HarnessCheckpointSelectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HarnessCheckpointSelectionError";
  }
}

/** Select exactly one native step as a checkpoint boundary. */
export interface HarnessCheckpointPrefixSelector {
  traceId?: string;
  nativeTurnIndex?: number;
  nativeStepCount?: number;
}

/**
 * A domain owns the schema and restore semantics of an actor snapshot.  The
 * harness owns only the stable ordering and integrity link used by checkpoints
 * and provenance.
 */
export interface ResolvedHarnessAgentSnapshot<TAgentState> {
  agents: TAgentState[];
  agentsHash: string;
  frameId?: string;
}

export type HarnessAgentSnapshotResolver<TState, TObservation, TPending, TCommand, TAgentState> = (input: {
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  step: SocialHarnessStep<TObservation, TPending, TCommand>;
  stepIndex: number;
}) => ResolvedHarnessAgentSnapshot<TAgentState> | undefined;

/**
 * The prefix replay callback deliberately receives no actor, policy, or model
 * factory.  It is a deterministic domain-state/message verifier only.
 */
export interface HarnessCheckpointPrefixReplayResult<TState> extends HarnessCheckpointReplayResult {
  finalState: TState;
}

export interface BuildHarnessCheckpointFromEpisodeOptions<TState, TObservation, TPending, TCommand, TAgentState> {
  artifactVersion: string;
  kind: string;
  checkpointId?: string;
  createdAt?: string;
  reason?: string;
  sourceArtifactVersion: string;
  runId?: string;
  sourceStatus?: SocialEpisodeStatus;
  failureReason?: string;
  truncationReason?: string;
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  /** Defaults to the execution prefix final state. */
  state?: TState;
  agents: TAgentState[];
  agentSnapshotFrameId?: string;
}

export interface BuildHarnessCheckpointAtPrefixOptions<TState, TObservation, TPending, TCommand, TAgentState>
  extends Omit<BuildHarnessCheckpointFromEpisodeOptions<TState, TObservation, TPending, TCommand, TAgentState>, "state" | "agents" | "agentSnapshotFrameId"> {
  selector: HarnessCheckpointPrefixSelector;
  resolveAgentSnapshot?: HarnessAgentSnapshotResolver<TState, TObservation, TPending, TCommand, TAgentState>;
  replayPrefix: (
    episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>
  ) => HarnessCheckpointPrefixReplayResult<TState>;
  /** Optional domain-owned semantic validation; generic code checks only hashes and batch safety. */
  validateAgentSnapshot?: (input: {
    agents: readonly TAgentState[];
    step: SocialHarnessStep<TObservation, TPending, TCommand>;
    stepIndex: number;
    maxMessageSeq: number;
  }) => readonly string[];
}

export interface CreateGenericForkProvenanceOptions {
  createdAt?: string;
  reason?: string;
  parentArtifactId?: string;
  parentEvidenceTraceIds?: string[];
}

/**
 * Model-free verification result for recorded durable actor snapshots.  This
 * audits recorded state/hash/batch relationships; it intentionally does not
 * recreate actors or regenerate memory/belief mutations with a model.
 */
export interface RecordedSocialAgentStateAuditResult {
  ok: boolean;
  checkedNativeSteps: number;
  checkedSnapshots: number;
  mismatches: string[];
}

export interface AuditRecordedSocialAgentSnapshotsOptions<TState, TObservation, TPending, TCommand, TAgentState> {
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  /** Require a durable state capture after every committed actor receipt. */
  requireSnapshotsAfterCommitted?: boolean;
  /** When provided, bind the last recorded state frame to an artifact's final actor snapshot. */
  finalAgents?: readonly TAgentState[];
  /** Optional pure, domain-owned validation of one recorded durable snapshot. */
  validateSnapshot?: (input: {
    agents: readonly TAgentState[];
    step: SocialHarnessStep<TObservation, TPending, TCommand>;
    stepIndex: number;
  }) => readonly string[];
}

/**
 * Audit inline actor snapshots currently carried by native social steps.
 * Snapshot frames/redaction schemas remain optional domain-level artifact
 * concerns; this verifies the generic causal invariants shared by every
 * domain without touching an actor, policy, reasoner, or provider.
 */
export function auditRecordedSocialAgentSnapshots<TState, TObservation, TPending, TCommand, TAgentState>(
  options: AuditRecordedSocialAgentSnapshotsOptions<TState, TObservation, TPending, TCommand, TAgentState>
): RecordedSocialAgentStateAuditResult {
  const mismatches: string[] = [];
  const requireSnapshots = options.requireSnapshotsAfterCommitted ?? false;
  let checkedSnapshots = 0;
  let previousHash: string | undefined;
  const parallelHashesByBatch = new Map<string, Set<string>>();

  for (const [stepIndex, step] of options.episode.steps.entries()) {
    const committed = isSocialStepCommitted(step);
    const hasAgents = Array.isArray(step.actorSnapshotsAfterStep);
    const hasHash = typeof step.actorSnapshotsHashAfterStep === "string";
    if (hasAgents !== hasHash) {
      mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot payload/hash must be recorded together.`);
      continue;
    }
    if (!hasAgents) {
      if (committed && requireSnapshots) {
        mismatches.push(`Native step ${stepIndex} ${step.traceId}: committed step is missing a durable actor snapshot.`);
      }
      continue;
    }

    const agents = step.actorSnapshotsAfterStep as TAgentState[];
    const actualHash = hashStableState(agents);
    checkedSnapshots += 1;
    if (actualHash !== step.actorSnapshotsHashAfterStep) {
      mismatches.push(
        `Native step ${stepIndex} ${step.traceId}: actor snapshot hash mismatch ${actualHash} !== ${step.actorSnapshotsHashAfterStep}.`
      );
    }
    if (
      step.actorSnapshotFrameIdAfterStep !== undefined &&
      step.actorSnapshotFrameIdAfterStep !== harnessAgentSnapshotFrameId(step.actorSnapshotsHashAfterStep!)
    ) {
      mismatches.push(`Native step ${stepIndex} ${step.traceId}: actor snapshot frame id does not match its hash.`);
    }
    if (!committed && previousHash !== undefined && step.actorSnapshotsHashAfterStep !== previousHash) {
      mismatches.push(`Native step ${stepIndex} ${step.traceId}: rejected step changed the recorded durable actor state.`);
    }
    if (step.schedulerMode === "parallel" && step.atomic && step.batchId) {
      const hashes = parallelHashesByBatch.get(step.batchId) ?? new Set<string>();
      hashes.add(step.actorSnapshotsHashAfterStep!);
      parallelHashesByBatch.set(step.batchId, hashes);
    }
    for (const error of options.validateSnapshot?.({ agents, step, stepIndex }) ?? []) {
      mismatches.push(`Native step ${stepIndex} ${step.traceId}: ${error}`);
    }
    previousHash = step.actorSnapshotsHashAfterStep;
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
 * Build a structurally complete checkpoint from a final or already-sliced
 * episode.  It does not invoke a domain replay factory; callers that need
 * deterministic replay proof should use validateHarnessCheckpointReplay().
 */
export function buildHarnessCheckpointFromEpisode<TState, TObservation, TPending, TCommand, TAgentState>(
  options: BuildHarnessCheckpointFromEpisodeOptions<TState, TObservation, TPending, TCommand, TAgentState>
): HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand> {
  const executionPrefix = cloneArtifact(options.episode);
  const state = cloneArtifact(options.state ?? executionPrefix.finalState);
  const agents = cloneArtifact(options.agents);
  const boundary = executionPrefix.steps.at(-1);
  const lastMessage = executionPrefix.messages.at(-1);
  const runId = options.runId ?? executionPrefix.id;
  const checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand> = {
    artifactVersion: options.artifactVersion,
    kind: options.kind,
    checkpointId: options.checkpointId ?? `${runId}:checkpoint:native:${executionPrefix.steps.length}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    reason: options.reason,
    source: {
      sourceArtifactVersion: options.sourceArtifactVersion,
      runId,
      status: options.sourceStatus ?? executionPrefix.status,
      boundaryTraceId: boundary?.traceId,
      boundaryTurnIndex: boundary?.turnIndex,
      boundaryBatchId: boundary?.batchId,
      boundaryBatchIndex: boundary?.batchIndex,
      boundarySchedulerMode: boundary?.schedulerMode,
      nativeStepCount: executionPrefix.steps.length,
      messageCount: executionPrefix.messages.length,
      lastMessageSeq: lastMessage?.seq,
      stateHash: hashStableState(state),
      executionPrefixHash: hashStableState(executionPrefix),
      agentsHash: hashStableState(agents),
      channelsHash: hashStableState(executionPrefix.channels),
      messagesHash: hashStableState(executionPrefix.messages),
      agentSnapshotFrameId: options.agentSnapshotFrameId,
      failureReason: options.failureReason,
      truncationReason: options.truncationReason
    },
    state,
    agents,
    executionPrefix
  };
  return checkpoint;
}

/**
 * Build a checkpoint from a recorded native prefix.  A domain supplies only
 * (a) how its durable actor states are resolved and (b) a model-free replay
 * callback.  The harness constructs the prefix, validates batch safety, and
 * binds the resulting state/message/agent hashes into the common envelope.
 */
export function buildHarnessCheckpointAtPrefix<TState, TObservation, TPending, TCommand, TAgentState>(
  options: BuildHarnessCheckpointAtPrefixOptions<TState, TObservation, TPending, TCommand, TAgentState>
): HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand> {
  const selected = resolveHarnessCheckpointPrefixSelection(options.episode, options.selector);
  assertSafeHarnessCheckpointBoundary(options.episode.steps, selected.index);
  const snapshot = resolveHarnessAgentSnapshotAtStep({
    episode: options.episode,
    step: selected.step,
    stepIndex: selected.index,
    resolver: options.resolveAgentSnapshot
  });
  if (!snapshot) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: no durable agent snapshot was recorded for this boundary.`
    );
  }
  const snapshotHash = hashStableState(snapshot.agents);
  if (snapshotHash !== snapshot.agentsHash) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: agent snapshot hash mismatch.`
    );
  }

  const steps = cloneArtifact(options.episode.steps.slice(0, selected.index + 1));
  const maxMessageSeq = latestMessageSeqForHarnessPrefix(options.episode, steps);
  const messages = cloneArtifact(options.episode.messages.filter((message) => message.seq <= maxMessageSeq));
  const agentValidationErrors = options.validateAgentSnapshot?.({
    agents: snapshot.agents,
    step: selected.step,
    stepIndex: selected.index,
    maxMessageSeq
  }) ?? [];
  if (agentValidationErrors.length) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: ${agentValidationErrors.join(" ")}`
    );
  }

  // The replay callback derives the real prefix final state.  Do not infer it
  // from command text or from the completed parent artifact.
  const executionPrefix = cloneArtifact({
    ...options.episode,
    status: "truncated" as const,
    terminationReason: undefined,
    truncationReason: `checkpoint boundary after native step ${selected.index + 1}`,
    failureReason: undefined,
    error: undefined,
    finalState: options.episode.initialState,
    steps,
    messages,
    exposureRecords: undefined,
    exposureSummary: undefined,
    metrics: undefined
  });
  const replay = options.replayPrefix(executionPrefix);
  if (replay.mismatches.length) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: ${replay.mismatches.join(" ")}`
    );
  }
  executionPrefix.finalState = cloneArtifact(replay.finalState);
  const replayedStateHash = hashStableState(executionPrefix.finalState);
  if (replay.finalHash !== undefined && replay.finalHash !== replayedStateHash) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: replay final hash does not match its final state.`
    );
  }
  const replayedMessagesHash = hashStableState(executionPrefix.messages);
  if (replay.messagesHash !== undefined && replay.messagesHash !== replayedMessagesHash) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: replay messages hash does not match the selected prefix.`
    );
  }

  return buildHarnessCheckpointFromEpisode({
    artifactVersion: options.artifactVersion,
    kind: options.kind,
    checkpointId: options.checkpointId,
    createdAt: options.createdAt,
    reason: options.reason,
    sourceArtifactVersion: options.sourceArtifactVersion,
    runId: options.runId,
    sourceStatus: options.sourceStatus ?? options.episode.status,
    failureReason: options.failureReason,
    truncationReason: options.truncationReason,
    episode: executionPrefix,
    state: executionPrefix.finalState,
    agents: snapshot.agents,
    agentSnapshotFrameId: snapshot.frameId
  });
}

export function resolveHarnessCheckpointPrefixSelection<TState, TObservation, TPending, TCommand>(
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>,
  selector: HarnessCheckpointPrefixSelector
): { index: number; step: SocialHarnessStep<TObservation, TPending, TCommand> } {
  const selectorNames = [
    selector.traceId !== undefined ? "traceId" : undefined,
    selector.nativeTurnIndex !== undefined ? "nativeTurnIndex" : undefined,
    selector.nativeStepCount !== undefined ? "nativeStepCount" : undefined
  ].filter((value): value is string => Boolean(value));
  if (selectorNames.length !== 1) {
    throw new HarnessCheckpointSelectionError(
      selectorNames.length === 0 ? "selector_not_found" : "ambiguous_selector",
      selectorNames.length === 0
        ? "Prefix checkpoint requires exactly one selector."
        : `Prefix checkpoint selector is ambiguous: ${selectorNames.join(", ")}.`
    );
  }
  const index =
    selector.traceId !== undefined
      ? episode.steps.findIndex((step) => step.traceId === selector.traceId)
      : selector.nativeTurnIndex !== undefined
        ? episode.steps.findIndex((step) => step.turnIndex === selector.nativeTurnIndex)
        : (selector.nativeStepCount ?? 0) - 1;
  const step = episode.steps[index];
  if (!step) {
    throw new HarnessCheckpointSelectionError("selector_not_found", "Prefix checkpoint selector did not match a native social execution step.");
  }
  return { index, step };
}

export function assertSafeHarnessCheckpointBoundary(
  steps: readonly SocialHarnessStep[],
  stepIndex: number
): void {
  if (!isSafeHarnessCheckpointBoundary(steps, stepIndex)) {
    throw new HarnessCheckpointSelectionError(
      "unsafe_batch_boundary",
      "Prefix checkpoint cannot be built from the middle of a native scheduler batch."
    );
  }
}

export function isSafeHarnessCheckpointBoundary(steps: readonly SocialHarnessStep[], stepIndex: number): boolean {
  if (stepIndex < 0) return steps.length === 0;
  const step = steps[stepIndex];
  if (!step) return false;
  const nextStep = steps[stepIndex + 1];
  if (!step.batchId || nextStep?.batchId !== step.batchId) return true;
  return step.schedulerMode === "aec" && !step.atomic;
}

export function latestMessageSeqForHarnessPrefix<TState, TObservation, TPending, TCommand>(
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>,
  steps: readonly SocialHarnessStep<TObservation, TPending, TCommand>[]
): number {
  let messageSeq = episode.execution?.initialMessageCount ?? 0;
  for (const step of steps) {
    if (step.messageSeqRange) messageSeq = Math.max(messageSeq, step.messageSeqRange[1]);
  }
  return messageSeq;
}

export function resolveHarnessAgentSnapshotAtStep<TState, TObservation, TPending, TCommand, TAgentState>(input: {
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  step: SocialHarnessStep<TObservation, TPending, TCommand>;
  stepIndex: number;
  resolver?: HarnessAgentSnapshotResolver<TState, TObservation, TPending, TCommand, TAgentState>;
}): ResolvedHarnessAgentSnapshot<TAgentState> | undefined {
  const resolved = input.resolver?.({
    episode: input.episode,
    step: input.step,
    stepIndex: input.stepIndex
  });
  if (resolved) {
    return {
      agents: cloneArtifact(resolved.agents),
      agentsHash: resolved.agentsHash,
      frameId: resolved.frameId
    };
  }
  if (!Array.isArray(input.step.actorSnapshotsAfterStep)) return undefined;
  const agents = cloneArtifact(input.step.actorSnapshotsAfterStep) as TAgentState[];
  return {
    agents,
    agentsHash: input.step.actorSnapshotsHashAfterStep ?? hashStableState(agents),
    frameId: input.step.actorSnapshotFrameIdAfterStep
  };
}

/** Build domain-neutral lineage from a validated checkpoint envelope. */
export function createGenericForkProvenance<
  TState,
  TAgentState,
  TObservation,
  TPending,
  TCommand,
  TSource extends HarnessCheckpointSource,
  TCheckpointArtifactVersion extends string = string
>(
  checkpoint: HarnessCheckpointEnvelope<TState, TAgentState, TObservation, TPending, TCommand, TSource> & {
    artifactVersion: TCheckpointArtifactVersion;
  },
  options: CreateGenericForkProvenanceOptions = {}
): GenericForkProvenance<TCheckpointArtifactVersion> {
  return {
    schemaVersion: HARNESS_FORK_PROVENANCE_VERSION,
    checkpointArtifactVersion: checkpoint.artifactVersion,
    checkpointId: checkpoint.checkpointId,
    parentRunId: checkpoint.source.runId,
    parentArtifactId: options.parentArtifactId,
    parentBoundaryTraceId: checkpoint.source.boundaryTraceId,
    parentEvidenceTraceIds: options.parentEvidenceTraceIds,
    parentBoundaryTurnIndex: checkpoint.source.boundaryTurnIndex,
    parentStateHash: checkpoint.source.stateHash,
    parentExecutionPrefixHash: checkpoint.source.executionPrefixHash,
    parentAgentsHash: checkpoint.source.agentsHash,
    parentChannelsHash: checkpoint.source.channelsHash,
    parentMessagesHash: checkpoint.source.messagesHash,
    parentNativeStepCount: checkpoint.source.nativeStepCount,
    parentMessageCount: checkpoint.source.messageCount,
    createdAt: options.createdAt ?? new Date().toISOString(),
    reason: options.reason
  };
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

/**
 * Harness artifacts are required to be serializable.  Clone at every generic
 * artifact boundary so checkpoint builders never retain a domain actor's
 * mutable state object.
 */
function cloneArtifact<T>(value: T): T {
  return structuredClone(value);
}
