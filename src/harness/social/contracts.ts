import { cloneJson } from "./valueUtils";
import { type SocialDomainAdapterManifest } from "../domainAdapter";
import { type ProviderFailureKind, type ProviderFailureStage, type ProviderRetryHistoryEntry, type ProviderStreamTelemetry } from "../../agents/schema";
export type SocialChannelKind = "public" | "team" | "private" | "system";
export type SocialResolvedSchedulerMode = "aec" | "aec-batched-decision" | "parallel";
export type SocialSchedulerMode = SocialResolvedSchedulerMode | "simultaneous-batch";
export type SocialEpisodeStatus = "completed" | "truncated" | "failed";
export type SocialDecisionFailureStage =
  | "pending_actor_resolution"
  | "actor_lookup"
  | "decision_identity"
  | "environment_observe"
  | "observation_assembly"
  | "actor_observe"
  | "actor_decide"
  /** The caller's control-plane abort signal ended a pending decision. */
  | "execution_abort"
  /** The generic runner's per-decision budget expired before a proposal. */
  | "decision_timeout";

/**
 * Optional execution limits owned by the generic runner, rather than by a
 * specific provider implementation. They are intentionally independent from
 * model-client retry or HTTP timeout settings: any SocialActor may be slow or
 * never settle.
 *
 * `abortSignal` is runtime-only and never serialized into an episode artifact.
 * The artifact records the resulting rejected step/failure stage instead.
 */
export interface SocialExecutionLimits {
  abortSignal?: AbortSignal;
  decisionTimeoutMs?: number;
}

export interface NormalizedSocialExecutionLimits {
  abortSignal?: AbortSignal;
  decisionTimeoutMs?: number;
}

export interface SocialAgentProfile {
  id: string;
  /** Reviewed profile contract identity. Required by experiment-bound runs. */
  version?: string;
  model: string;
  temperature?: number;
  role?: string;
  team?: string;
  policyId?: string;
  reasonerId?: string;
  personaId?: string;
  persona?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Content-safe actor/profile composition recorded by the generic runner. It
 * binds a durable actor id to the reviewed profile identities actually used at
 * runtime without persisting persona text, provider configuration, or secrets.
 */
export interface SocialRuntimeActorBinding {
  actorId: string;
  profileId: string;
  profileVersion?: string;
  model: string;
  temperature?: number;
  policyId?: string;
  reasonerId?: string;
  personaId?: string;
}

/**
 * Runner-authored classification of the cognition path available to an
 * episode. Provider telemetry describes what a reported call looked like; it
 * does not by itself prove that the episode used a production provider
 * reasoner. Legacy artifacts may omit this field.
 */
export type SocialReasonerExecutionClass = "live-provider" | "policy-only" | "injected-unverified";

export const SOCIAL_ASSIGNMENT_RESOLUTION_VERSION = "harness.assignment-resolution.v1" as const;

export type SocialAssignmentJsonPrimitive = string | number | boolean | null;
export type SocialAssignmentJsonValue =
  | SocialAssignmentJsonPrimitive
  | SocialAssignmentJsonValue[]
  | { [key: string]: SocialAssignmentJsonValue };

/**
 * Domain-authored output of one reviewed assignment resolver. The generic
 * control plane stamps policy/configuration and episode identity around these
 * rows, then binds the closed record to the actual runtime actor roster.
 * `seat`, `role`, and `team` are optional because not every social domain has
 * those concepts; `domain` carries other portable assignment coordinates.
 */
export interface SocialAssignmentActorResolution {
  actorId: string;
  profileId: string;
  model: string;
  seat?: string | number;
  role?: string;
  team?: string;
  domain?: { [key: string]: SocialAssignmentJsonValue };
}

export interface SocialAssignmentResolutionEvidence {
  schemaVersion: typeof SOCIAL_ASSIGNMENT_RESOLUTION_VERSION;
  policy: {
    id: string;
    version: string;
    configurationHash: string;
  };
  episode: {
    index: number;
    seed: string;
  };
  actors: SocialAssignmentActorResolution[];
}

export interface SocialChannel {
  id: string;
  kind: SocialChannelKind;
  participantIds: string[];
  readableBy: "participants" | "all" | "postgame";
}

export interface SocialMessage {
  id: string;
  seq: number;
  channelId: string;
  senderId: string;
  recipientIds: string[];
  /**
   * Optional, immutable-at-publication runtime observer snapshot.  A channel
   * describes the durable communication topology, while this field narrows
   * one committed message to the actors that could actually observe it at the
   * moment it was produced (for example, living members of a team channel).
   *
   * It is deliberately optional: artifacts written before this contract keep
   * their original channel-derived visibility semantics when the field is
   * absent.  New snapshots are canonical sorted subsets of the normal channel
   * audience and are never recomputed from a later environment state.
   */
  runtimeAudienceIds?: readonly string[];
  visibility: "private" | "team" | "public" | "postgame";
  content: string;
  speechActs?: SocialSpeechAct[];
  deliveryReceipts?: SocialDeliveryReceipt[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export type SocialSpeechActKind =
  | "claim"
  | "role_claim"
  | "accusation"
  | "defense"
  | "vote_intent"
  | "request"
  | "agreement"
  | "disagreement"
  | "commitment"
  | "coalition_signal"
  | "threat"
  | "trust_repair"
  | "private_note"
  | "role_action"
  | "other";

export interface SocialEvidenceRef {
  artifact: "message" | "trace" | "observation" | "delivery_receipt" | "action" | "event" | "state";
  id?: string;
  seq?: number;
  traceId?: string;
  description?: string;
}

export interface SocialSpeechAct {
  id: string;
  kind: SocialSpeechActKind | string;
  subjectId?: string;
  targetId?: string;
  value?: unknown;
  confidence?: number;
  evidenceRefs: SocialEvidenceRef[];
  metadata?: Record<string, unknown>;
}

export interface SocialDeliveryReceipt {
  id: string;
  messageId: string;
  messageSeq: number;
  channelId: string;
  senderId: string;
  observerId: string;
  visibility: SocialMessage["visibility"];
  deliveredAtTurn?: number;
  observationTraceId?: string;
  redactionPolicy: string;
}

export interface SocialObservation<TVisibleState = unknown, TPending = unknown> {
  agentId: string;
  visibleState: TVisibleState;
  pendingAction: TPending;
  visibleMessages: SocialMessage[];
  channels: SocialChannel[];
}

/**
 * Adapter-safe inputs for constructing an actor observation. The canonical
 * domain state deliberately does not cross this boundary: only the
 * environment's actor-scoped projection and the actor's visible social slice
 * may be incorporated into an observation.
 */
export interface SocialObservationAssemblyContext<TObservation = unknown, TPending = unknown> {
  agentId: string;
  pendingAction: TPending;
  environmentObservation: TObservation;
  visibleSocial: {
    channels: SocialChannel[];
    messages: SocialMessage[];
  };
}

export type SocialObservationAssembler<TObservation = unknown, TPending = unknown> = (
  context: SocialObservationAssemblyContext<TObservation, TPending>
) => TObservation;

export interface SocialAction<TCommand = unknown> {
  actorId: string;
  kind: string;
  traceId?: string;
  command: TCommand;
  messages?: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">>;
  metadata?: Record<string, unknown>;
}

export const SOCIAL_REASONER_CALL_EVIDENCE_VERSION = "harness.reasoner-call-evidence.v1" as const;

export type SocialReasonerCallOutcome = "completed" | "failed" | "aborted";

export interface SocialReasonerCallFailure {
  failureKind: ProviderFailureKind;
  providerStage?: ProviderFailureStage;
  status?: number;
  timeoutMs?: number;
  aborted?: boolean;
  retryable?: boolean;
  attempts?: number;
  maxAttempts?: number;
}

/**
 * Unbound, provider-neutral lifecycle facts exposed by an instrumented actor.
 * The actor deliberately cannot choose actor/profile/model/trace/call identity;
 * those fields are stamped by the generic runner after decide() settles.
 *
 * This is an in-process instrumentation trust boundary, not remote attestation:
 * the runner proves canonical binding and closed shape, while the actor/model
 * client remains responsible for honestly reporting its SDK result.
 */
export interface SocialReasonerCallReport {
  outcome: SocialReasonerCallOutcome;
  latencyMs?: number;
  attempts?: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  retryHistory?: ProviderRetryHistoryEntry[];
  stream: ProviderStreamTelemetry;
  failure?: SocialReasonerCallFailure;
}

/** Portable, runner-bound reasoner execution evidence retained by one native step. */
export interface SocialReasonerCallEvidence extends SocialReasonerCallReport {
  schemaVersion: typeof SOCIAL_REASONER_CALL_EVIDENCE_VERSION;
  callId: string;
  traceId: string;
  actorId: string;
  profileId: string;
  model: string;
}

export interface SocialReasonerCallCollectionContext {
  transactionId: string;
  traceId: string;
  turnIndex: number;
}

export interface SocialActorObservationContext<TPending = unknown> {
  traceId?: string;
  /** Runner-owned key for staging and resolving one actor turn. It is kept
   * distinct from action trace ids, which adapters may supply for evidence. */
  transactionId?: string;
  /**
   * Set only by the harness runner. Actors must stage durable state while this
   * is true and merge it only from a committed step receipt.
   */
  transactional?: true;
  turnIndex: number;
  actorTurnIndex?: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  pendingAction: TPending;
}

export interface SocialSystemTransitionContext<TState = unknown> {
  state: TState;
  turnIndex: number;
  schedulerMode: SocialResolvedSchedulerMode;
}

export interface SocialSystemTransition<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  actorId?: string;
  profileId?: string;
  pendingAction: TPending;
  observation: TObservation;
  action: SocialAction<TCommand>;
}

export type SocialSystemTransitionProvider<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> = (
  context: SocialSystemTransitionContext<TState>
) => SocialSystemTransition<TObservation, TPending, TCommand> | undefined | null;

export interface SocialEnvironmentStepContext<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> {
  actor?: SocialActor<TObservation, TPending, TCommand>;
  actorId: string;
  profileId: string;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  atomic: boolean;
  resolutionPolicy: string;
  pendingAction: TPending;
  observation: TObservation;
  action: SocialAction<TCommand>;
  preState: TState;
  preStateHash?: string;
  decisionStateHash?: string;
}

export interface SocialAfterEnvironmentStepContext<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown>
  extends SocialEnvironmentStepContext<TState, TObservation, TPending, TCommand> {
  feedback: SocialStepFeedback<TState, TObservation>;
  postStateHash?: string;
  eventSeqRange?: [number, number];
  messageSeqRange?: [number, number];
}

export type SocialAfterEnvironmentStepHook<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> = (
  context: SocialAfterEnvironmentStepContext<TState, TObservation, TPending, TCommand>
) => void;

export interface SocialDecisionFailureContext<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> {
  actor?: SocialActor<TObservation, TPending, TCommand>;
  actorId: string;
  profileId: string;
  turnIndex: number;
  actorTurnIndex?: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  pendingAction: TPending;
  observation?: TObservation;
  traceId?: string;
  decisionState: TState;
  decisionStateHash?: string;
  preStateHash?: string;
  failureStage: SocialDecisionFailureStage;
  error: unknown;
}

export type SocialDecisionFailureHook<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> = (
  context: SocialDecisionFailureContext<TState, TObservation, TPending, TCommand>
) => SocialStepFailureEvidence | void;

export interface SocialEnvironmentStepFailureContext<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> {
  actor?: SocialActor<TObservation, TPending, TCommand>;
  actorId: string;
  profileId: string;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  atomic: boolean;
  resolutionPolicy: string;
  pendingAction: TPending;
  observation: TObservation;
  action: SocialAction<TCommand>;
  preState: TState;
  preStateHash?: string;
  decisionStateHash?: string;
  failureState: TState;
  failureStateHash?: string;
  /** Canonical state retained by the runner after an optional verified rollback. */
  effectiveState?: TState;
  effectiveStateHash?: string;
  rollback?: SocialEnvironmentRollbackEvidence;
  error: unknown;
}

export interface SocialEnvironmentRollbackEvidence {
  mutationDetected: boolean;
  attempted: boolean;
  succeeded: boolean;
  failureCode?: "restore_threw" | "state_mismatch" | "hash_mismatch" | "event_sequence_mismatch";
}

export type SocialStepCommitStatus = "committed" | "rejected";

export interface SocialStepFailureEvidence {
  stage: string;
  message: string;
  causeName?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Optional preflight result returned by an environment before the runner
 * commits a command. Environments remain the authority for legality; the
 * runner only records and enforces the result before calling `step()` or
 * publishing social messages.
 */
export interface SocialActionValidationResult {
  valid: boolean;
  code?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export class SocialActionValidationError extends Error {
  readonly result: SocialActionValidationResult;

  constructor(result: SocialActionValidationResult) {
    super(result.message ?? result.code ?? "Social action rejected by environment validation.");
    this.name = "SocialActionValidationError";
    this.result = cloneJson(result);
  }
}

/** Raised when an allegedly pure preflight changes canonical environment state. */
export class SocialPreflightMutationError extends Error {
  constructor(
    readonly beforeFingerprint: string,
    readonly afterFingerprint: string
  ) {
    super("Environment validateAction() mutated canonical state; preflight must be pure.");
    this.name = "SocialPreflightMutationError";
  }
}

/**
 * The runner owns the identity boundary between a scheduled actor and its
 * action/message drafts. Domain environments still validate command payloads,
 * but a scheduled actor must never be able to impersonate another actor in a
 * generic harness episode.
 */
export class SocialActionOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialActionOwnershipError";
  }
}

export type SocialEnvironmentStepFailureHook<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> = (
  context: SocialEnvironmentStepFailureContext<TState, TObservation, TPending, TCommand>
) => SocialStepFailureEvidence | void;

export interface SocialStepFeedback<TState = unknown, TObservation = unknown> {
  state: TState;
  observationsByAgent: Record<string, TObservation>;
  rewardsByAgent: Record<string, number>;
  terminationsByAgent: Record<string, boolean>;
  truncationsByAgent: Record<string, boolean>;
  infosByAgent: Record<string, Record<string, unknown>>;
  episodeTerminated: boolean;
  episodeTruncated: boolean;
  terminationReason?: string;
  truncationReason?: string;
}

export type SocialStepResult<TState = unknown, TObservation = unknown> = TState | SocialStepFeedback<TState, TObservation>;

export interface SocialEnvironment<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> {
  snapshot(): TState;
  /**
   * Optional defensive recovery for an uncommitted failed transition. It must
   * restore all canonical state represented by snapshot() without external
   * side effects. The runner verifies the restored snapshot; step/stepBatch
   * remain required to be atomic even when this capability exists.
   */
  restore?(snapshot: TState): void;
  pendingActions(): TPending[];
  observe(agentId: string, pending: TPending): TObservation;
  /**
   * Validate a command against the supplied pending action without mutating
   * environment state. The runner invokes this before message validation and
   * before `step`/`stepBatch`; implementations may omit it when `step` already
   * provides an equivalent pure legality boundary.
   */
  validateAction?(command: TCommand, pending: TPending): SocialActionValidationResult;
  /**
   * Apply one command atomically. If this method throws, `snapshot()` must
   * remain observationally equal to its value before the call. The runner
   * A mutation followed by an error is recorded as non-atomic unless an
   * optional restore() capability returns the complete state to the verified
   * pre-transition snapshot.
   */
  step(command: TCommand): SocialStepResult<TState, TObservation>;
  done(): boolean;
}

export interface SocialParallelEnvironment<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown>
  extends SocialEnvironment<TState, TObservation, TPending, TCommand> {
  /**
   * Apply the complete joint command set atomically under the same failure
   * contract as `step()`.
   */
  stepBatch(commandsByAgent: Record<string, TCommand>): SocialStepResult<TState, TObservation>;
}

export interface SocialActor<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  readonly id: string;
  readonly profile: SocialAgentProfile;
  observe(observation: TObservation, context?: SocialActorObservationContext<TPending>): void;
  decide(pending: TPending): Promise<SocialAction<TCommand>> | SocialAction<TCommand>;
  /**
   * Consume reports produced while resolving exactly one transactional
   * decision. The runner invokes this at most once after decide() settles or
   * throws. Returning no reports is valid for a policy-only actor.
   */
  takeReasonerCallReports?(context: SocialReasonerCallCollectionContext): SocialReasonerCallReport[];
  onStepResult?(receipt: SocialActorStepReceipt<TObservation, TPending, TCommand>): void;
}

export interface SocialActorStepReceipt<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  id: string;
  status: SocialStepCommitStatus;
  traceId: string;
  /** Matches the transactional observation context, not necessarily traceId. */
  transactionId?: string;
  turnIndex: number;
  actorId: string;
  pendingAction: TPending;
  action?: SocialAction<TCommand>;
  observation?: TObservation;
  reward?: number;
  terminated?: boolean;
  truncated?: boolean;
  info?: Record<string, unknown>;
  postStateHash?: string;
  eventSeqRange?: [number, number];
  messageSeqRange?: [number, number];
  failure?: SocialStepFailureEvidence;
}

export interface SocialTraceIdProviderContext<TState = unknown, TPending = unknown> {
  id: string;
  state: TState;
  pendingAction: TPending;
  actorId: string;
  turnIndex: number;
  actorTurnIndex?: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
}

export type SocialTraceIdProvider<TState = unknown, TPending = unknown> = (
  context: SocialTraceIdProviderContext<TState, TPending>
) => string | undefined;

export type SocialActorTurnIndexProvider<TState = unknown, TPending = unknown> = (
  context: SocialTraceIdProviderContext<TState, TPending>
) => number | undefined;

export interface SocialSchedulerResolverContext<TState = unknown, TPending = unknown> {
  id: string;
  state: TState;
  pendingActions: TPending[];
  turnIndex: number;
  batchIndex: number;
  defaultSchedulerMode: SocialResolvedSchedulerMode;
}

export type SocialSchedulerResolver<TState = unknown, TPending = unknown> = (
  context: SocialSchedulerResolverContext<TState, TPending>
) => SocialSchedulerMode | undefined;

export interface SocialHarnessStep<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  traceId: string;
  turnIndex: number;
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
  actorId: string;
  profileId: string;
  schedulerMode: SocialResolvedSchedulerMode;
  atomic?: boolean;
  resolutionPolicy?: string;
  pendingAction: TPending;
  observation: TObservation;
  /**
   * Exact actor-scoped observation delivered with a committed receipt. This
   * remains private artifact evidence (like `observation`), not a public
   * projection or an environment-state authority. It lets a model-free replay
   * auditor distinguish decision-time evidence from receipt-time evidence
   * without recreating an actor.
   */
  receiptObservation?: TObservation;
  action: SocialAction<TCommand>;
  /** Runner-bound, content-free provider/reasoner lifecycle evidence. */
  reasonerCalls?: SocialReasonerCallEvidence[];
  commitStatus?: SocialStepCommitStatus;
  decisionStateHash?: string;
  preStateHash?: string;
  postStateHash?: string;
  actorSnapshotsAfterStep?: unknown[];
  actorSnapshotsHashAfterStep?: string;
  actorSnapshotFrameIdAfterStep?: string;
  messageSeqRange?: [number, number];
  eventSeqRange?: [number, number];
  rewardsByAgent?: Record<string, number>;
  terminationsByAgent?: Record<string, boolean>;
  truncationsByAgent?: Record<string, boolean>;
  doneByAgent?: Record<string, boolean>;
  infosByAgent?: Record<string, Record<string, unknown>>;
  episodeTerminated?: boolean;
  episodeTruncated?: boolean;
  terminationReason?: string;
  truncationReason?: string;
  error?: string;
  failure?: SocialStepFailureEvidence;
}

export interface SocialEpisodeArtifact<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> {
  id: string;
  /** Domain adapter identifier; absent only on legacy artifacts. */
  domainId?: string;
  /**
   * Immutable, safe execution provenance. New domain adapters should provide
   * it; old artifacts without it remain explicitly legacy-compatible.
   */
  domainAdapter?: SocialDomainAdapterManifest;
  status: SocialEpisodeStatus;
  execution?: {
    schemaVersion: "harness.social-execution.v1";
    started: boolean;
    notStartedStage?: string;
    initialMessageCount: number;
    initialMessagesHash?: string;
    /** Configured transition budget, including zero. */
    maxTransitions?: number;
    /** Configured generic runner budget; runtime AbortSignal itself is never serialized. */
    decisionTimeoutMs?: number;
    /** Machine-readable cognition provenance; absent only on legacy/direct social artifacts. */
    reasonerExecutionClass?: SocialReasonerExecutionClass;
  };
  schedulerMode: SocialResolvedSchedulerMode;
  /** Immutable actor registry for this live execution. It bounds `readableBy:
   * "all"` and makes delivery receipts auditable. Absent only on legacy
   * artifacts, where visibility deliberately falls back to channel members. */
  runtimeActorIds?: string[];
  /** Exact actor/profile/model composition for this run; absent only on legacy artifacts. */
  runtimeActors?: SocialRuntimeActorBinding[];
  /** Versioned experiment assignment output; absent on legacy/unbound artifacts. */
  assignmentResolution?: SocialAssignmentResolutionEvidence;
  profiles: SocialAgentProfile[];
  channels: SocialChannel[];
  initialState: TState;
  finalState: TState;
  steps: Array<SocialHarnessStep<TObservation, TPending, TCommand>>;
  messages: SocialMessage[];
  exposureRecords?: SocialExposureRecord[];
  exposureSummary?: SocialExposureSummary;
  metrics?: Record<string, unknown>;
  terminationReason?: string;
  truncationReason?: string;
  failureReason?: string;
  error?: string;
}

export interface SocialExposureRecord {
  messageId: string;
  messageSeq: number;
  sourceId: string;
  observerId: string;
  observedAtTraceId: string;
  observedAtTurnIndex: number;
  observedAtActionKind: string;
  channelId: string;
  visibility: SocialMessage["visibility"];
  kind?: string;
  deliveryReceipt?: SocialDeliveryReceipt;
  evidenceRefs: Array<{
    artifact: "message" | "trace" | "observation" | "delivery_receipt";
    id?: string;
    seq?: number;
    traceId?: string;
    description?: string;
  }>;
}

export interface SocialExposureSummary {
  schemaVersion: string;
  source: "scoped_observation";
  privateEvidenceRedacted: boolean;
  recordCount: number;
  messageCount: number;
  sourceCount: number;
  observerCount: number;
  byVisibility: Record<SocialMessage["visibility"], number>;
}

/**
 * Canonical summary identity for an optional cached social-exposure sidecar.
 * The sidecar is never an additional evidence source: its records and summary
 * must be reproducible from committed messages plus scoped observations.
 */
export const SOCIAL_EXPOSURE_SUMMARY_VERSION = "harness.social-exposure-summary.v1" as const;

export interface SocialStepCommitCounts {
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
}
