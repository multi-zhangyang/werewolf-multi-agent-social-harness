import { assertClosedProjectionKeys, cloneArtifact, isNonemptyString, isRecord, isSha256, validatePortableProjectionJson } from "./support";
import { SocialDomainAdapterManifest } from "../domainAdapter";
import { GenericExperimentExecutionAttestationV1, GenericExperimentForkChangeDeclarationV1, GenericExperimentForkLineageV1, GenericExperimentProvenanceV1 } from "../experimentSpec";
import { hashStableJsonValue } from "../hash";
import { SocialEpisodeArtifact, SocialEpisodeStatus, SocialHarnessStep, SocialResolvedSchedulerMode } from "../social";
/**
 * Domain-neutral artifact primitives. A domain owns its state, command codec,
 * evaluator payload, and public projection; this module owns only the stable
 * execution envelope shared by replayable social experiments.
 */
export const HARNESS_EPISODE_ENVELOPE_VERSION = "harness.episode-envelope.v1";
export const HARNESS_EPISODE_PROJECTION_VERSION = "harness.episode-projection.v1";
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
  /** Same safe adapter identity recorded by the parent checkpoint, when present. */
  parentDomainAdapter?: SocialDomainAdapterManifest;
  /** Optional v1 experiment authority; absent only for legacy/unbound artifacts. */
  experimentLineage?: GenericExperimentForkLineageV1;
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
  /** Optional compacted durable actor-state sidecar for the native episode. */
  agentSnapshotFrames?: HarnessAgentSnapshotFrame<TAgentState>[];
  /** Stable normalized control-plane authority for this episode. */
  experiment?: GenericExperimentProvenanceV1;
  /** Central binding from the normalized spec to runner-authored execution facts. */
  executionAttestation?: GenericExperimentExecutionAttestationV1;
  forkOf?: TForkProvenance;
}

export type HarnessEpisodeProjectionVisibility = "postgame-redacted" | "public";

/**
 * A derived display/export sidecar bound to one immutable canonical episode.
 * It is intentionally not replay, checkpoint, evaluator, or environment
 * authority. The closed envelope has no generatedAt field, so exact retries
 * remain stable across processes and restarts.
 */
export interface HarnessEpisodeProjectionEnvelope<TPayload = unknown> {
  schemaVersion: typeof HARNESS_EPISODE_PROJECTION_VERSION;
  kind: "episode-projection";
  source: {
    runId: string;
    artifactSha256: string;
    visibility: HarnessEpisodeProjectionVisibility;
    policyId: string;
    policyVersion: string;
  };
  payloadSha256: string;
  payload: TPayload;
}

/** Validate the complete closed projection envelope and portable JSON payload. */
export function validateHarnessEpisodeProjectionEnvelope(value: unknown): string[] {
  if (!isRecord(value)) return ["Episode projection must be an object."];
  const errors: string[] = [];
  assertClosedProjectionKeys(value, ["schemaVersion", "kind", "source", "payloadSha256", "payload"], "projection", errors);
  if (value.schemaVersion !== HARNESS_EPISODE_PROJECTION_VERSION) {
    errors.push(`projection.schemaVersion must be ${HARNESS_EPISODE_PROJECTION_VERSION}.`);
  }
  if (value.kind !== "episode-projection") errors.push("projection.kind must be episode-projection.");
  if (!isRecord(value.source)) {
    errors.push("projection.source must be an object.");
  } else {
    assertClosedProjectionKeys(
      value.source,
      ["runId", "artifactSha256", "visibility", "policyId", "policyVersion"],
      "projection.source",
      errors
    );
    if (!isNonemptyString(value.source.runId)) errors.push("projection.source.runId is required.");
    if (!isSha256(value.source.artifactSha256)) errors.push("projection.source.artifactSha256 must be a SHA-256 digest.");
    if (value.source.visibility !== "postgame-redacted" && value.source.visibility !== "public") {
      errors.push("projection.source.visibility must be postgame-redacted or public.");
    }
    if (!isNonemptyString(value.source.policyId)) errors.push("projection.source.policyId is required.");
    if (!isNonemptyString(value.source.policyVersion)) errors.push("projection.source.policyVersion is required.");
  }
  if (!isSha256(value.payloadSha256)) errors.push("projection.payloadSha256 must be a SHA-256 digest.");
  const payloadErrors = validatePortableProjectionJson(value.payload, "projection.payload");
  errors.push(...payloadErrors);
  if (!payloadErrors.length && isSha256(value.payloadSha256)) {
    try {
      if (hashStableJsonValue(value.payload) !== value.payloadSha256) {
        errors.push("projection.payloadSha256 does not match projection.payload.");
      }
    } catch {
      errors.push("projection.payload could not be hashed as portable JSON.");
    }
  }
  return errors;
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

/**
 * A frame registry remains a sidecar, rather than scheduler state. It may be
 * stored with a canonical artifact, supplied to model-free replay, or used by
 * a checkpoint resolver; it never contains a policy, reasoner, or provider.
 */
export type HarnessAgentSnapshotFrameRegistry<TAgentState = unknown> = readonly HarnessAgentSnapshotFrame<TAgentState>[];

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
  /** Mirrors executionPrefix.domainAdapter for adapter-bound checkpoints. */
  domainAdapter?: SocialDomainAdapterManifest;
  /** Parent experiment authority retained across checkpoint/restart/fork. */
  experiment?: GenericExperimentProvenanceV1;
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

/**
 * Resolve one compacted recorded state without constructing an actor. This
 * helper intentionally returns undefined for dangling or inconsistent refs;
 * validators turn that absence into artifact evidence rather than guessing a
 * state from a command or replaying a model decision.
 */
export function resolveHarnessAgentSnapshotFrame<TAgentState>(input: {
  frames: HarnessAgentSnapshotFrameRegistry<TAgentState>;
  step: Pick<SocialHarnessStep, "actorSnapshotsHashAfterStep" | "actorSnapshotFrameIdAfterStep">;
}): ResolvedHarnessAgentSnapshot<TAgentState> | undefined {
  const frameId = input.step.actorSnapshotFrameIdAfterStep;
  const agentsHash = input.step.actorSnapshotsHashAfterStep;
  if (!frameId || !agentsHash) return undefined;
  const frame = input.frames.find((candidate) => candidate.frameId === frameId);
  if (!frame || frame.agentsHash !== agentsHash) return undefined;
  return {
    agents: cloneArtifact(frame.agents),
    agentsHash: frame.agentsHash,
    frameId: frame.frameId
  };
}

/**
 * Adapt an external frame registry to the existing prefix-checkpoint resolver
 * seam. The returned resolver only reads recorded immutable data; it does not
 * know a domain's actor schema or restoration behavior.
 */
export function createHarnessAgentSnapshotFrameResolver<TAgentState>(frames: HarnessAgentSnapshotFrameRegistry<TAgentState>) {
  return <TState, TObservation, TPending, TCommand>(input: {
    episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
    step: SocialHarnessStep<TObservation, TPending, TCommand>;
    stepIndex: number;
  }): ResolvedHarnessAgentSnapshot<TAgentState> | undefined =>
    resolveHarnessAgentSnapshotFrame({ frames, step: input.step });
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
  experiment?: GenericExperimentProvenanceV1;
  agentSnapshotFrameId?: string;
}

export interface BuildHarnessCheckpointAtPrefixOptions<TState, TObservation, TPending, TCommand, TAgentState>
  extends Omit<BuildHarnessCheckpointFromEpisodeOptions<TState, TObservation, TPending, TCommand, TAgentState>, "state" | "agents" | "agentSnapshotFrameId"> {
  selector: HarnessCheckpointPrefixSelector;
  resolveAgentSnapshot?: HarnessAgentSnapshotResolver<TState, TObservation, TPending, TCommand, TAgentState>;
  replayPrefix: (
    episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>
  ) => HarnessCheckpointPrefixReplayResult<TState>;
  /**
   * Explicit domain-owned semantic policy for the durable actor snapshot that
   * will become fork authority. A state-bearing checkpoint may not silently
   * skip this validation.
   */
  recordedAgentState:
    | {
        mode: "validate";
        validator: (input: {
          agents: readonly TAgentState[];
          step: SocialHarnessStep<TObservation, TPending, TCommand>;
          stepIndex: number;
          maxMessageSeq: number;
        }) => readonly string[];
      }
    | {
        mode: "none";
        reason: string;
      };
}

/**
 * A display/review prefix is deliberately weaker than a checkpoint: it binds
 * a complete native scheduler boundary to a model-free environment/message
 * replay, but never resolves, restores, or exposes durable agent state.
 */
export interface ReplayableSocialPrefix<
  TState,
  TObservation,
  TPending,
  TCommand,
  TReplay extends HarnessCheckpointPrefixReplayResult<TState> = HarnessCheckpointPrefixReplayResult<TState>
> {
  /** Zero-based index of the selected complete native scheduler boundary. */
  stepIndex: number;
  /** One-based native-step count, suitable for an external cursor contract. */
  nativeStepCount: number;
  step: SocialHarnessStep<TObservation, TPending, TCommand>;
  /** The inclusive message sequence limit covered by this native prefix. */
  maxMessageSeq: number;
  /** Canonical, derived prefix used only as input to deterministic replay/projection. */
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  replay: TReplay;
}

export interface BuildReplayableSocialPrefixOptions<
  TState,
  TObservation,
  TPending,
  TCommand,
  TReplay extends HarnessCheckpointPrefixReplayResult<TState> = HarnessCheckpointPrefixReplayResult<TState>
> {
  episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>;
  selector: HarnessCheckpointPrefixSelector;
  /**
   * The injected callback is a deterministic domain replay seam. It receives
   * no actor, policy, reasoner, provider, or restore factory.
   */
  replayPrefix: (
    episode: SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>
  ) => TReplay;
}

export interface CreateGenericForkProvenanceOptions {
  createdAt?: string;
  reason?: string;
  parentArtifactId?: string;
  parentEvidenceTraceIds?: string[];
  /** Required with an experiment-bound checkpoint, even when the spec is unchanged. */
  childExperiment?: GenericExperimentProvenanceV1;
  /** Caller-declared semantic fields; generic code verifies exact coverage but never invents them. */
  changedExperimentFields?: readonly GenericExperimentForkChangeDeclarationV1[];
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
  /** Optional external registry used by compacted canonical artifacts. */
  snapshotFrames?: HarnessAgentSnapshotFrameRegistry<TAgentState>;
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
 * Audit inline or compacted recorded actor snapshots carried by native social
 * steps. This verifies generic causal invariants without touching an actor,
 * policy, reasoner, or provider.
 */
