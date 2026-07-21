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
  | "actor_decide";

export interface SocialAgentProfile {
  id: string;
  model: string;
  temperature?: number;
  role?: string;
  team?: string;
  policyId?: string;
  persona?: string;
  metadata?: Record<string, unknown>;
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
  error: unknown;
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
   * cannot roll back arbitrary domain state; a mutation followed by an error
   * is recorded as a non-atomic environment failure and is not replayable.
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
  action: SocialAction<TCommand>;
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
  status: SocialEpisodeStatus;
  execution?: {
    schemaVersion: "harness.social-execution.v1";
    started: boolean;
    notStartedStage?: string;
    initialMessageCount: number;
    initialMessagesHash?: string;
  };
  schedulerMode: SocialResolvedSchedulerMode;
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

export interface SocialStepCommitCounts {
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
}

/**
 * Whether a native social step is committed for progress/replay filtering.
 * Legacy steps without commitStatus treat absence of error as committed.
 */
export function isSocialStepCommitted(
  step: Pick<SocialHarnessStep, "commitStatus" | "error">
): boolean {
  if (step.commitStatus === "committed") return true;
  if (step.commitStatus === "rejected") return false;
  // Missing/unknown commitStatus: absence of error is treated as committed.
  return !step.error;
}

/**
 * A non-atomic environment failure means a domain adapter mutated state and
 * then threw before it could return a committed result. The record is useful
 * failure evidence, but it cannot be deterministic replay authority.
 */
export function isSocialStepNonReplayableFailure(
  step: Pick<SocialHarnessStep, "failure">
): boolean {
  return step.failure?.stage === "environment_non_atomic_failure";
}

/**
 * Count native social-episode steps by commit status.
 * Legacy steps without commitStatus treat absence of error as committed.
 */
export function countSocialStepCommits(
  steps: ReadonlyArray<Pick<SocialHarnessStep, "commitStatus" | "error">>
): SocialStepCommitCounts {
  let committedSteps = 0;
  let rejectedSteps = 0;
  for (const step of steps) {
    if (isSocialStepCommitted(step)) committedSteps += 1;
    else rejectedSteps += 1;
  }
  return {
    nativeSteps: steps.length,
    committedSteps,
    rejectedSteps
  };
}

/**
 * Count native social-episode steps by actor, excluding system transitions.
 * Shared by agents.csv, match CLI agent summaries, and other actor-level density surfaces.
 */
export function countSocialStepCommitsByActor(
  steps: ReadonlyArray<Pick<SocialHarnessStep, "actorId" | "commitStatus" | "error">>
): Map<string, SocialStepCommitCounts> {
  const byActor = new Map<string, SocialStepCommitCounts>();
  for (const step of steps) {
    if (step.actorId === "system") continue;
    const current = byActor.get(step.actorId) ?? {
      nativeSteps: 0,
      committedSteps: 0,
      rejectedSteps: 0
    };
    current.nativeSteps += 1;
    if (isSocialStepCommitted(step)) current.committedSteps += 1;
    else current.rejectedSteps += 1;
    byActor.set(step.actorId, current);
  }
  return byActor;
}

export function deriveSocialExposureRecords<TState, TObservation, TPending, TCommand>(
  episode: Pick<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>, "steps" | "messages">,
  options: { includeSelf?: boolean } = {}
): SocialExposureRecord[] {
  const committedMessages = new Map<string, SocialMessage>();
  for (const message of episode.messages) {
    committedMessages.set(`id:${message.id}`, message);
    committedMessages.set(`seq:${message.seq}`, message);
  }

  const records: SocialExposureRecord[] = [];
  const seen = new Set<string>();
  for (const step of episode.steps) {
    const observed = extractObservedSocialMessages(step);
    if (!observed) continue;
    for (const observedMessage of observed.messages) {
      const message = findCommittedMessage(committedMessages, observedMessage);
      if (!message) continue;
      if (!options.includeSelf && message.senderId === observed.observerId) continue;
      const key = `${message.id}:${observed.observerId}:${step.traceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const deliveryReceipt = message.deliveryReceipts?.find((receipt) => receipt.observerId === observed.observerId);
      records.push({
        messageId: message.id,
        messageSeq: message.seq,
        sourceId: message.senderId,
        observerId: observed.observerId,
        observedAtTraceId: step.traceId,
        observedAtTurnIndex: step.turnIndex,
        observedAtActionKind: step.action.kind,
        channelId: message.channelId,
        visibility: message.visibility,
        kind: stringMetadata(message.metadata?.kind),
        deliveryReceipt: deliveryReceipt ? cloneJson(deliveryReceipt) : undefined,
        evidenceRefs: [
          {
            artifact: "message",
            id: message.id,
            seq: message.seq,
            description: message.channelId
          },
          ...(deliveryReceipt
            ? [
                {
                  artifact: "delivery_receipt" as const,
                  id: deliveryReceipt.id,
                  seq: message.seq,
                  description: `${deliveryReceipt.redactionPolicy}:${deliveryReceipt.observerId}`
                }
              ]
            : []),
          {
            artifact: "trace",
            traceId: step.traceId,
            seq: step.turnIndex,
            description: step.action.kind
          },
          {
            artifact: "observation",
            traceId: step.traceId,
            seq: step.turnIndex,
            description: `scoped social observation for ${observed.observerId}`
          }
        ]
      });
    }
  }
  return records;
}

export function validateSocialEpisodeArtifact<TState, TObservation, TPending, TCommand>(
  episode: Pick<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>, "channels" | "steps" | "messages">
): string[] {
  const errors: string[] = [];
  const channelsById = new Map<string, SocialChannel>();
  for (const [index, channel] of episode.channels.entries()) {
    if (!channel.id.trim()) {
      errors.push(`channels[${index}] is missing id.`);
      continue;
    }
    if (channelsById.has(channel.id)) errors.push(`Duplicate social channel id ${channel.id}.`);
    channelsById.set(channel.id, channel);
  }

  const messagesById = new Map<string, SocialMessage>();
  const messagesBySeq = new Map<number, SocialMessage>();
  for (const [index, message] of episode.messages.entries()) {
    const expectedSeq = index + 1;
    if (message.seq !== expectedSeq) {
      errors.push(`messages[${index}] sequence mismatch: expected ${expectedSeq}, received ${message.seq}.`);
    }
    if (!message.id.trim()) {
      errors.push(`messages[${index}] is missing id.`);
    } else if (messagesById.has(message.id)) {
      errors.push(`Duplicate social message id ${message.id}.`);
    }
    if (messagesBySeq.has(message.seq)) errors.push(`Duplicate social message seq ${message.seq}.`);
    messagesById.set(message.id, message);
    messagesBySeq.set(message.seq, message);
    validateMessageEnvelope(message, channelsById, `messages[${index}]`, errors);
    validateSpeechActs(message, `messages[${index}]`, errors);
    validateDeliveryReceipts(message, channelsById, `messages[${index}]`, errors);
  }

  const stepsByTraceId = new Map<string, SocialHarnessStep<TObservation, TPending, TCommand>>();
  for (const [index, step] of episode.steps.entries()) {
    if (!step.traceId.trim()) {
      errors.push(`steps[${index}] is missing traceId.`);
    } else if (stepsByTraceId.has(step.traceId)) {
      errors.push(`Duplicate social step traceId ${step.traceId}.`);
    }
    stepsByTraceId.set(step.traceId, step);
    validateSeqRange(step.messageSeqRange, messagesBySeq, `steps[${index}].messageSeqRange`, errors);

    if (step.action.actorId !== step.actorId) {
      errors.push(
        `steps[${index}].action.actorId ${step.action.actorId} does not match scheduled actor ${step.actorId}.`
      );
    }
    for (const [messageIndex, message] of (step.action.messages ?? []).entries()) {
      if (message.senderId !== step.actorId) {
        errors.push(
          `steps[${index}].action.messages[${messageIndex}].senderId ${message.senderId} does not match scheduled actor ${step.actorId}.`
        );
      }
    }
    if (isSocialStepNonReplayableFailure(step)) {
      errors.push(`steps[${index}] records an environment_non_atomic_failure and cannot be replayed as a valid artifact.`);
    }
    if (
      !isSocialStepCommitted(step) &&
      step.preStateHash !== undefined &&
      step.postStateHash !== undefined &&
      step.preStateHash !== step.postStateHash
    ) {
      errors.push(`steps[${index}] rejected step changed domain state hash ${step.preStateHash} -> ${step.postStateHash}.`);
    }

    if (step.messageSeqRange && isSeqRange(step.messageSeqRange)) {
      const [start, end] = step.messageSeqRange;
      for (let seq = start; seq <= end; seq += 1) {
        const message = messagesBySeq.get(seq);
        const messageTraceId = stringMetadata(asRecord(message?.metadata)?.traceId);
        if (messageTraceId && messageTraceId !== step.traceId) {
          errors.push(`steps[${index}].messageSeqRange includes message seq ${seq} from trace ${messageTraceId}, expected ${step.traceId}.`);
        }
      }
    }

    const observed = extractObservedSocialMessages(step);
    if (!observed) continue;
    for (const observedMessage of observed.messages) {
      const committed = findCommittedMessageByIndexes(messagesById, messagesBySeq, observedMessage);
      if (!committed) {
        errors.push(
          `steps[${index}] observation for ${observed.observerId} references uncommitted social message ${observedMessage.id}/${observedMessage.seq}.`
        );
        continue;
      }
      if (committed.id !== observedMessage.id) {
        errors.push(`steps[${index}] observation message id mismatch for seq ${observedMessage.seq}: ${observedMessage.id} !== ${committed.id}.`);
      }
      if (committed.seq !== observedMessage.seq) {
        errors.push(`steps[${index}] observation message seq mismatch for ${observedMessage.id}: ${observedMessage.seq} !== ${committed.seq}.`);
      }
      if (!messageVisibleToObserver(committed, observed.observerId, channelsById)) {
        errors.push(`steps[${index}] observation for ${observed.observerId} includes non-visible social message ${committed.id}/${committed.seq}.`);
      }
    }
  }

  for (const exposure of deriveSocialExposureRecords(episode)) {
    if (!messagesById.has(exposure.messageId)) errors.push(`social exposure references unknown message ${exposure.messageId}.`);
    if (!stepsByTraceId.has(exposure.observedAtTraceId)) errors.push(`social exposure references unknown trace ${exposure.observedAtTraceId}.`);
    for (const evidenceRef of exposure.evidenceRefs) {
      if (evidenceRef.artifact === "message" && evidenceRef.id && !messagesById.has(evidenceRef.id)) {
        errors.push(`social exposure evidence references unknown message ${evidenceRef.id}.`);
      }
      if ((evidenceRef.artifact === "trace" || evidenceRef.artifact === "observation") && evidenceRef.traceId && !stepsByTraceId.has(evidenceRef.traceId)) {
        errors.push(`social exposure evidence references unknown trace ${evidenceRef.traceId}.`);
      }
    }
  }

  errors.push(...validateSocialParallelBatchLayout(episode.steps));

  return errors;
}

/**
 * A true parallel transition is one atomic environment step over a complete
 * joint command set. These structural checks prevent an artifact from being
 * replayed as a truncated or mixed batch.
 */
export function validateSocialParallelBatchLayout<TObservation, TPending, TCommand>(
  steps: ReadonlyArray<SocialHarnessStep<TObservation, TPending, TCommand>>
): string[] {
  const errors: string[] = [];
  const stepsByBatchId = new Map<string, Array<{ index: number; step: SocialHarnessStep<TObservation, TPending, TCommand> }>>();
  const parallelBatchIds = new Set<string>();

  for (const [index, step] of steps.entries()) {
    const batchId = step.batchId?.trim();
    if (batchId) {
      const entries = stepsByBatchId.get(batchId) ?? [];
      entries.push({ index, step });
      stepsByBatchId.set(batchId, entries);
    }

    if (step.schedulerMode !== "parallel") {
      if (step.resolutionPolicy === "parallel-stepBatch") {
        errors.push(`steps[${index}] uses parallel-stepBatch without the parallel scheduler.`);
      }
      continue;
    }
    if (isParallelSystemTransitionStep(step)) continue;

    if (step.atomic !== true) {
      errors.push(`steps[${index}] parallel step must be atomic.`);
    }
    if (step.resolutionPolicy !== "parallel-stepBatch") {
      errors.push(`steps[${index}] parallel step must use resolutionPolicy parallel-stepBatch.`);
    }
    if (!batchId) {
      errors.push(`steps[${index}] parallel batch is missing batchId.`);
    } else {
      parallelBatchIds.add(batchId);
    }
    if (!isPositiveInteger(step.batchIndex)) {
      errors.push(`steps[${index}] parallel batch has invalid batchIndex ${String(step.batchIndex)}.`);
    }
    if (!isPositiveInteger(step.batchSize)) {
      errors.push(`steps[${index}] parallel batch has invalid batchSize ${String(step.batchSize)}.`);
    }
  }

  for (const batchId of parallelBatchIds) {
    const batch = stepsByBatchId.get(batchId) ?? [];
    const reference = batch.find(({ step }) => step.schedulerMode === "parallel" && !isParallelSystemTransitionStep(step));
    if (!reference) continue;

    const { step: first } = reference;
    const expectedSize = first.batchSize;
    const expectedBatchIndex = first.batchIndex;
    for (let offset = 1; offset < batch.length; offset += 1) {
      if (batch[offset].index !== batch[offset - 1].index + 1) {
        errors.push(`parallel batch ${batchId} is not contiguous.`);
        break;
      }
    }
    if (isPositiveInteger(expectedSize) && batch.length !== expectedSize) {
      errors.push(`parallel batch ${batchId} is incomplete: expected ${expectedSize} steps, found ${batch.length}.`);
    }

    const actorIds = new Set<string>();
    const committed = isSocialStepCommitted(first);
    for (const { index, step } of batch) {
      if (!isSocialParallelJointStep(step)) {
        errors.push(`steps[${index}] joins parallel batch ${batchId} without parallel atomic metadata.`);
      }
      if (step.batchSize !== expectedSize) {
        errors.push(`steps[${index}] batchSize ${String(step.batchSize)} does not match parallel batch ${batchId} size ${String(expectedSize)}.`);
      }
      if (step.batchIndex !== expectedBatchIndex) {
        errors.push(`steps[${index}] batchIndex ${String(step.batchIndex)} does not match parallel batch ${batchId}.`);
      }
      if (step.preStateHash !== first.preStateHash) {
        errors.push(`steps[${index}] preStateHash does not match parallel batch ${batchId}.`);
      }
      if (step.decisionStateHash !== first.decisionStateHash) {
        errors.push(`steps[${index}] decisionStateHash does not match parallel batch ${batchId}.`);
      }
      if (isSocialStepCommitted(step) !== committed) {
        errors.push(`steps[${index}] commit status does not match parallel batch ${batchId}.`);
      }
      if (actorIds.has(step.actorId)) {
        errors.push(`steps[${index}] duplicates actor ${step.actorId} in parallel batch ${batchId}.`);
      }
      actorIds.add(step.actorId);
      if (committed && step.postStateHash !== first.postStateHash) {
        errors.push(`steps[${index}] postStateHash does not match committed parallel batch ${batchId}.`);
      }
      if (committed && !sameOptionalRange(step.eventSeqRange, first.eventSeqRange)) {
        errors.push(`steps[${index}] eventSeqRange does not match committed parallel batch ${batchId}.`);
      }
    }
  }
  return errors;
}

export function isSocialParallelJointStep(step: Pick<SocialHarnessStep, "schedulerMode" | "atomic" | "resolutionPolicy">): boolean {
  return step.schedulerMode === "parallel" && step.atomic === true && step.resolutionPolicy === "parallel-stepBatch";
}

function isParallelSystemTransitionStep(
  step: Pick<SocialHarnessStep, "actorId" | "schedulerMode" | "atomic" | "resolutionPolicy">
): boolean {
  return (
    step.schedulerMode === "parallel" &&
    step.actorId === "system" &&
    step.atomic !== true &&
    (step.resolutionPolicy === "system-transition" || step.resolutionPolicy === "scheduler-validation")
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function sameOptionalRange(left: [number, number] | undefined, right: [number, number] | undefined): boolean {
  if (!left || !right) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}

export class SocialCommunicationBus {
  private readonly channels = new Map<string, SocialChannel>();
  private readonly messages: SocialMessage[] = [];

  constructor(channels: SocialChannel[] = [], initialMessages: SocialMessage[] = []) {
    for (const channel of channels) this.channels.set(channel.id, channel);
    this.restoreMessages(initialMessages);
  }

  listChannels(): SocialChannel[] {
    return [...this.channels.values()].map(cloneJson);
  }

  listMessages(): SocialMessage[] {
    return this.messages.map(cloneJson);
  }

  addChannel(channel: SocialChannel): void {
    if (this.channels.has(channel.id)) throw new Error(`Duplicate social channel ${channel.id}.`);
    this.channels.set(channel.id, cloneJson(channel));
  }

  publish(message: Omit<SocialMessage, "id" | "seq" | "createdAt">): SocialMessage {
    return this.publishMany([message])[0];
  }

  publishMany(messages: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">>): SocialMessage[] {
    const records = this.prepareMessages(messages);
    this.messages.push(...records);
    return records.map(cloneJson);
  }

  validateMessages(messages: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">>): void {
    // Build the complete batch before the environment commits. This detects
    // serialization/speech-act failures while publication is still side-effect
    // free, and lets publishMany append the batch atomically.
    this.prepareMessages(messages);
  }

  private prepareMessages(messages: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">>): SocialMessage[] {
    for (const message of messages) this.validateMessage(message);
    const startingSeq = this.messages.at(-1)?.seq ?? 0;
    return messages.map((message, index) => {
      const seq = startingSeq + index + 1;
      const id = `msg-${seq}`;
      const draft = cloneJson(message);
      return {
        ...draft,
        id,
        seq,
        speechActs: normalizeSpeechActs(draft, id, seq),
        deliveryReceipts: deliveryReceiptsForMessage(draft, this.channels.get(draft.channelId), id, seq),
        createdAt: deterministicMessageTimestamp(seq)
      };
    });
  }

  private restoreMessages(messages: SocialMessage[]): void {
    let expectedSeq = 1;
    const ids = new Set<string>();
    for (const message of messages) {
      if (!Number.isInteger(message.seq) || message.seq !== expectedSeq) {
        throw new Error(`Restored social message sequence must be contiguous from 1; expected ${expectedSeq}, received ${message.seq}.`);
      }
      if (!message.id) throw new Error(`Restored social message ${message.seq} is missing id.`);
      if (ids.has(message.id)) throw new Error(`Duplicate restored social message id ${message.id}.`);
      ids.add(message.id);
      this.validateMessage(message);
      this.messages.push(cloneJson(message));
      expectedSeq += 1;
    }
  }

  private validateMessage(message: Omit<SocialMessage, "id" | "seq" | "createdAt">): void {
    const channel = this.channels.get(message.channelId);
    if (!channel) throw new Error(`Unknown social channel ${message.channelId}.`);
    if (!channel.participantIds.includes(message.senderId) && channel.kind !== "system") {
      throw new Error(`Sender ${message.senderId} is not in channel ${message.channelId}.`);
    }
    for (const recipientId of message.recipientIds) {
      if (!channel.participantIds.includes(recipientId) && channel.readableBy !== "all") {
        throw new Error(`Recipient ${recipientId} is not allowed in channel ${message.channelId}.`);
      }
    }
    const speechActs = message.speechActs;
    if (speechActs !== undefined && !Array.isArray(speechActs)) throw new Error(`Social message speechActs must be an array.`);
    const deliveryReceipts = message.deliveryReceipts;
    if (deliveryReceipts !== undefined && !Array.isArray(deliveryReceipts)) throw new Error(`Social message deliveryReceipts must be an array.`);
  }

  observe(agentId: string): { channels: SocialChannel[]; messages: SocialMessage[] } {
    const channels = [...this.channels.values()].filter(
      (channel) => channel.readableBy === "all" || channel.participantIds.includes(agentId)
    );
    const channelIds = new Set(channels.map((channel) => channel.id));
    const messages = this.messages.filter((message) => {
      if (!channelIds.has(message.channelId)) return false;
      if (message.visibility === "public") return true;
      if (message.visibility === "postgame") return false;
      return message.senderId === agentId || message.recipientIds.includes(agentId);
    });
    return {
      channels: channels.map(cloneJson),
      messages: messages.map(cloneJson)
    };
  }
}

export interface SocialEpisodeOptions<TState, TObservation, TPending extends { actorId?: string }, TCommand> {
  id: string;
  domainId?: string;
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  actors: Array<SocialActor<TObservation, TPending, TCommand>>;
  channels?: SocialChannel[];
  initialMessages?: SocialMessage[];
  schedulerMode?: SocialSchedulerMode;
  maxTransitions?: number;
  hashState?: (state: TState) => string;
  hashMessages?: (messages: SocialMessage[]) => string;
  eventSeq?: (state: TState) => number;
	  afterEnvironmentStep?: SocialAfterEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
  assembleObservation?: SocialObservationAssembler<TObservation, TPending>;
  systemTransition?: SocialSystemTransitionProvider<TState, TObservation, TPending, TCommand>;
  traceIdForDecision?: SocialTraceIdProvider<TState, TPending>;
	  actorTurnIndexForDecision?: SocialActorTurnIndexProvider<TState, TPending>;
	  schedulerModeForBatch?: SocialSchedulerResolver<TState, TPending>;
	  onDecisionFailure?: SocialDecisionFailureHook<TState, TObservation, TPending, TCommand>;
	  onEnvironmentStepFailure?: SocialEnvironmentStepFailureHook<TState, TObservation, TPending, TCommand>;
}

export async function runSocialEpisode<TState, TObservation, TPending extends { actorId?: string }, TCommand>(
  options: SocialEpisodeOptions<TState, TObservation, TPending, TCommand>
): Promise<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>> {
  const defaultSchedulerMode = normalizeSchedulerMode(options.schedulerMode ?? "aec");
  const bus = new SocialCommunicationBus(options.channels ?? [], options.initialMessages ?? []);
  const initialMessages = bus.listMessages();
  const execution = {
    schemaVersion: "harness.social-execution.v1" as const,
    started: true,
    initialMessageCount: initialMessages.length,
    initialMessagesHash: options.hashMessages?.(initialMessages)
  };
  const actorById = new Map(options.actors.map((actor) => [actor.id, actor]));
  const initialState = cloneJson(options.environment.snapshot());
  const steps: Array<SocialHarnessStep<TObservation, TPending, TCommand>> = [];
  const maxTransitions = options.maxTransitions ?? 320;

  let status: SocialEpisodeStatus = "completed";
  let terminationReason: string | undefined;
  let truncationReason: string | undefined;
  let failureReason: string | undefined;
  let turnIndex = 1;
  let batchIndex = 1;
  if (defaultSchedulerMode === "parallel" && !isParallelEnvironment(options.environment)) {
    failureReason = "Parallel scheduler requires environment.stepBatch().";
    return {
      id: options.id,
      domainId: options.domainId,
      status: "failed",
      execution,
      schedulerMode: defaultSchedulerMode,
      profiles: options.actors.map((actor) => cloneJson(actor.profile)),
      channels: bus.listChannels(),
      initialState,
      finalState: cloneJson(options.environment.snapshot()),
      steps,
      messages: bus.listMessages(),
      failureReason,
      error: failureReason
    };
  }

  while (!options.environment.done() && turnIndex <= maxTransitions) {
    const pendingActions = options.environment.pendingActions();
    const stateForScheduler = options.environment.snapshot();
    const schedulerMode = resolveSchedulerMode({
      optionsId: options.id,
      state: stateForScheduler,
      pendingActions,
      turnIndex,
      batchIndex,
      defaultSchedulerMode,
      schedulerModeForBatch: options.schedulerModeForBatch
    });
    if (schedulerMode === "parallel" && !isParallelEnvironment(options.environment)) {
      status = "failed";
      failureReason = "Parallel scheduler requires environment.stepBatch().";
      break;
    }
    const pendingBatch = selectPendingBatch(pendingActions, schedulerMode);
    if (!pendingBatch.length) {
      const systemOutcome = applyOptionalSystemTransition({
        optionsId: options.id,
        environment: options.environment,
        bus,
        turnIndex,
        batchIndex,
        schedulerMode,
        hashState: options.hashState,
        eventSeq: options.eventSeq,
        systemTransition: options.systemTransition
      });
      if (!systemOutcome) break;
      steps.push(systemOutcome.step);
      if (systemOutcome.status === "failed") {
        status = "failed";
        failureReason = systemOutcome.reason;
        break;
      }
      if (systemOutcome.feedback.episodeTruncated) {
        status = "truncated";
        truncationReason = systemOutcome.feedback.truncationReason;
        break;
      }
      if (systemOutcome.feedback.episodeTerminated) {
        status = "completed";
        terminationReason = systemOutcome.feedback.terminationReason;
        break;
      }
      turnIndex += 1;
      batchIndex += 1;
      continue;
    }
    const decisionState = options.environment.snapshot();
    const decisionStateHash = options.hashState?.(decisionState);
    const batchId = `${options.id}:batch:${batchIndex}`;

    const duplicateActorId = findDuplicatePendingActorId(pendingBatch);
    if (duplicateActorId) {
      const reason = `Scheduler batch ${batchId} contains multiple pending actions for actor ${duplicateActorId}.`;
      const failure = defaultFailureEvidence("scheduler_validation", reason);
      const stateHash = options.hashState?.(options.environment.snapshot());
      steps.push(
        schedulerFailureStep({
          optionsId: options.id,
          turnIndex,
          batchId,
          batchIndex,
          batchSize: pendingBatch.length,
          schedulerMode,
          pendingAction: pendingBatch.find((pending) => pending.actorId === duplicateActorId) ?? pendingBatch[0],
          decisionStateHash,
          preStateHash: stateHash,
          postStateHash: stateHash,
          failure
        })
      );
      status = "failed";
      failureReason = reason;
      break;
    }

    const decisions = await Promise.all(
      pendingBatch.map((pending, pendingIndex) =>
	        collectDecision({
	          optionsId: options.id,
	          environment: options.environment,
	          actorById,
	          bus,
	          pending,
	          pendingIndex,
	          turnIndex: turnIndex + pendingIndex,
	          batchId,
	          batchIndex,
	          batchSize: pendingBatch.length,
	          schedulerMode,
	          assembleObservation: options.assembleObservation,
	          traceIdForDecision: options.traceIdForDecision,
	          actorTurnIndexForDecision: options.actorTurnIndexForDecision
	        })
	      )
	    );

    const failedDecision = decisions.find((decision) => !decision.ok);
    if (failedDecision) {
      status = "failed";
      failureReason = failedDecision.error;
      const failedTurnIndex = failedDecision.turnIndex;
      const adapterFailure = options.onDecisionFailure?.({
        actor: failedDecision.actor,
        actorId: failedDecision.actorId,
        profileId: failedDecision.actor?.profile.id ?? failedDecision.actorId,
        turnIndex: failedTurnIndex,
        actorTurnIndex: failedDecision.actorTurnIndex,
        batchId,
        batchIndex,
        batchSize: pendingBatch.length,
        schedulerMode,
        pendingAction: cloneJson(failedDecision.pending),
        observation: cloneJson(failedDecision.observation as TObservation | undefined),
        traceId: failedDecision.traceId,
        decisionState: cloneJson(decisionState),
        decisionStateHash,
        preStateHash: decisionStateHash,
        failureStage: failedDecision.failureStage,
        error: failedDecision.rawError
      });
      const failedPostState = options.environment.snapshot();
      const failedPostStateHash = options.hashState?.(failedPostState);
      const failedEventSeqRange = eventSeqRange(options.eventSeq?.(decisionState), options.eventSeq?.(failedPostState));
      const decisionFailure = adapterFailure ?? defaultFailureEvidence(failedDecision.failureStage, failedDecision.rawError);
      const failureForDecision = (decision: SocialDecision<TObservation, TPending, TCommand>): SocialStepFailureEvidence => {
        if (!decision.ok) {
          return decision === failedDecision
            ? decisionFailure
            : defaultFailureEvidence(decision.failureStage, decision.rawError);
        }
        return {
          stage: "batch_aborted",
          message: `Parallel batch ${batchId} was abandoned before stepBatch() because ${failedDecision.actorId} failed during ${failedDecision.failureStage}.`
        };
      };
      rejectUncommittedDecisions(decisions, failureForDecision);
      if (schedulerMode === "parallel") {
        steps.push(
          ...rejectedParallelDecisionBatchSteps({
            optionsId: options.id,
            decisions,
            batchId,
            batchIndex,
            batchSize: pendingBatch.length,
            decisionStateHash,
            preStateHash: decisionStateHash,
            postStateHash: failedPostStateHash,
            eventSeqRange: failedEventSeqRange,
            failureForDecision
          })
        );
      } else {
        steps.push(
          ...rejectedSequentialDecisionBatchSteps({
            optionsId: options.id,
            decisions,
            batchId,
            batchIndex,
            batchSize: pendingBatch.length,
            schedulerMode,
            decisionStateHash,
            preStateHash: decisionStateHash,
            postStateHash: failedPostStateHash,
            eventSeqRange: failedEventSeqRange,
            failureForDecision
          })
        );
      }
      break;
    }
    const successfulDecisions = decisions.filter(isSuccessfulDecision);

    if (schedulerMode === "parallel") {
      if (turnIndex + successfulDecisions.length - 1 > maxTransitions) {
        status = "truncated";
        truncationReason = `maxTransitions ${maxTransitions} reached before parallel batch could be applied`;
        const truncationFailure: SocialStepFailureEvidence = {
          stage: "scheduler_truncation",
          message: truncationReason
        };
        rejectUncommittedDecisions(successfulDecisions, truncationFailure);
        const truncationState = options.environment.snapshot();
        steps.push(
          ...rejectedParallelDecisionBatchSteps({
            optionsId: options.id,
            decisions: successfulDecisions,
            batchId,
            batchIndex,
            batchSize: pendingBatch.length,
            decisionStateHash,
            preStateHash: decisionStateHash,
            postStateHash: options.hashState?.(truncationState),
            eventSeqRange: eventSeqRange(options.eventSeq?.(decisionState), options.eventSeq?.(truncationState)),
            failureForDecision: () => truncationFailure
          })
        );
        break;
      }
      const outcome = applyParallelBatch({
        optionsId: options.id,
        environment: options.environment as SocialParallelEnvironment<TState, TObservation, TPending, TCommand>,
        bus,
        decisions: successfulDecisions,
        turnIndex,
        batchId,
        batchIndex,
        batchSize: pendingBatch.length,
        schedulerMode,
	        decisionStateHash,
	        hashState: options.hashState,
	        eventSeq: options.eventSeq,
	        afterEnvironmentStep: options.afterEnvironmentStep,
	        onEnvironmentStepFailure: options.onEnvironmentStepFailure
	      });
      steps.push(...outcome.steps);
      if (outcome.status === "failed") {
        status = "failed";
        failureReason = outcome.reason;
        break;
      }
      if (outcome.feedback.episodeTruncated) {
        status = "truncated";
        truncationReason = outcome.feedback.truncationReason;
        break;
      }
      if (outcome.feedback.episodeTerminated) {
        status = "completed";
        terminationReason = outcome.feedback.terminationReason;
        break;
      }
      turnIndex += successfulDecisions.length;
    } else {
      for (const [decisionIndex, decision] of successfulDecisions.entries()) {
        const outcome = applySequentialDecision({
          optionsId: options.id,
          environment: options.environment,
          bus,
          decision,
          turnIndex,
          batchId,
          batchIndex,
          batchSize: pendingBatch.length,
          schedulerMode,
	          decisionStateHash,
	          hashState: options.hashState,
	          eventSeq: options.eventSeq,
	          afterEnvironmentStep: options.afterEnvironmentStep,
	          onEnvironmentStepFailure: options.onEnvironmentStepFailure
	        });
        steps.push(outcome.step);
        if (outcome.status === "failed") {
          status = "failed";
          failureReason = outcome.reason;
          const remainingDecisions = successfulDecisions.slice(decisionIndex + 1);
          const batchAbortFailure: SocialStepFailureEvidence = {
            stage: "batch_aborted",
            message: `Batch ${batchId} stopped before this proposal reached the environment: ${outcome.reason ?? "a prior transition failed"}.`
          };
          rejectUncommittedDecisions(remainingDecisions, batchAbortFailure);
          const abortedStateHash = options.hashState?.(options.environment.snapshot());
          steps.push(
            ...rejectedSequentialDecisionBatchSteps({
              optionsId: options.id,
              decisions: remainingDecisions,
              batchId,
              batchIndex,
              batchSize: pendingBatch.length,
              schedulerMode,
              decisionStateHash,
              preStateHash: abortedStateHash,
              postStateHash: abortedStateHash,
              failureForDecision: () => batchAbortFailure
            })
          );
          break;
        }
        if (outcome.feedback.episodeTruncated) {
          status = "truncated";
          truncationReason = outcome.feedback.truncationReason;
          const remainingDecisions = successfulDecisions.slice(decisionIndex + 1);
          const batchAbortFailure: SocialStepFailureEvidence = {
            stage: "batch_aborted",
            message: truncationReason ?? `Batch ${batchId} stopped before this proposal reached the environment because the episode was truncated.`
          };
          rejectUncommittedDecisions(remainingDecisions, batchAbortFailure);
          const abortedStateHash = options.hashState?.(options.environment.snapshot());
          steps.push(
            ...rejectedSequentialDecisionBatchSteps({
              optionsId: options.id,
              decisions: remainingDecisions,
              batchId,
              batchIndex,
              batchSize: pendingBatch.length,
              schedulerMode,
              decisionStateHash,
              preStateHash: abortedStateHash,
              postStateHash: abortedStateHash,
              failureForDecision: () => batchAbortFailure
            })
          );
          break;
        }
        if (outcome.feedback.episodeTerminated) {
          status = "completed";
          terminationReason = outcome.feedback.terminationReason;
          const remainingDecisions = successfulDecisions.slice(decisionIndex + 1);
          const batchAbortFailure: SocialStepFailureEvidence = {
            stage: "batch_aborted",
            message: terminationReason ?? `Batch ${batchId} stopped before this proposal reached the environment because the episode terminated.`
          };
          rejectUncommittedDecisions(remainingDecisions, batchAbortFailure);
          const abortedStateHash = options.hashState?.(options.environment.snapshot());
          steps.push(
            ...rejectedSequentialDecisionBatchSteps({
              optionsId: options.id,
              decisions: remainingDecisions,
              batchId,
              batchIndex,
              batchSize: pendingBatch.length,
              schedulerMode,
              decisionStateHash,
              preStateHash: abortedStateHash,
              postStateHash: abortedStateHash,
              failureForDecision: () => batchAbortFailure
            })
          );
          break;
        }
        turnIndex += 1;
      }
    }

    if (status === "failed" || status === "truncated" || terminationReason) break;
    batchIndex += 1;
  }

  if (!options.environment.done() && status !== "failed" && status !== "truncated") {
    status = "truncated";
    truncationReason = `maxTransitions ${maxTransitions} reached before terminal state`;
  }
  return {
    id: options.id,
    domainId: options.domainId,
    status,
    execution,
    schedulerMode: defaultSchedulerMode,
    profiles: options.actors.map((actor) => cloneJson(actor.profile)),
    channels: bus.listChannels(),
    initialState,
    finalState: cloneJson(options.environment.snapshot()),
    steps,
    messages: bus.listMessages(),
    terminationReason,
    truncationReason,
    failureReason,
    error: failureReason
  };
}

type SocialDecision<TObservation, TPending, TCommand> =
  | {
      ok: true;
      actor: SocialActor<TObservation, TPending, TCommand>;
      actorId: string;
      pending: TPending;
      observation: TObservation;
      action: SocialAction<TCommand>;
      pendingIndex: number;
      turnIndex: number;
      transactionId: string;
    }
  | {
      ok: false;
      actor?: SocialActor<TObservation, TPending, TCommand>;
      actorId: string;
      pending: TPending;
      observation?: TObservation;
      pendingIndex: number;
      turnIndex: number;
      traceId?: string;
      transactionId?: string;
      actorTurnIndex?: number;
      failureStage: SocialDecisionFailureStage;
      error: string;
      rawError: unknown;
    };

function isSuccessfulDecision<TObservation, TPending, TCommand>(
  decision: SocialDecision<TObservation, TPending, TCommand>
): decision is Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }> {
  return decision.ok;
}

/**
 * A batch can be abandoned after actors have observed and reasoned but before
 * their commands reach the environment. Tell each affected actor explicitly
 * so staged private/social state is discarded rather than becoming a hidden
 * side effect of an uncommitted proposal.
 */
function rejectUncommittedDecisions<TObservation, TPending, TCommand>(
  decisions: readonly SocialDecision<TObservation, TPending, TCommand>[],
  failure: SocialStepFailureEvidence | ((decision: SocialDecision<TObservation, TPending, TCommand>) => SocialStepFailureEvidence)
): void {
  for (const decision of decisions) {
    if (!decision.actor) continue;
    const resolvedFailure = typeof failure === "function" ? failure(decision) : failure;
    const traceId = decision.ok
      ? decision.action.traceId ?? `social:${decision.turnIndex}:${decision.actorId}`
      : decision.traceId ?? `social:${decision.turnIndex}:${decision.actorId}`;
    deliverActorStepReceipt(decision.actor, {
      id: `${traceId}:rejected`,
      status: "rejected",
      traceId,
      transactionId: decision.transactionId,
      turnIndex: decision.turnIndex,
      actorId: decision.actorId,
      pendingAction: cloneJson(decision.pending),
      action: decision.ok ? cloneJson(decision.action) : undefined,
      failure: cloneJson(resolvedFailure)
    });
  }
}

async function collectDecision<TState, TObservation, TPending extends { actorId?: string }, TCommand>(input: {
  optionsId: string;
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  actorById: Map<string, SocialActor<TObservation, TPending, TCommand>>;
  bus: SocialCommunicationBus;
  pending: TPending;
  pendingIndex: number;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  assembleObservation?: SocialObservationAssembler<TObservation, TPending>;
  traceIdForDecision?: SocialTraceIdProvider<TState, TPending>;
  actorTurnIndexForDecision?: SocialActorTurnIndexProvider<TState, TPending>;
}): Promise<SocialDecision<TObservation, TPending, TCommand>> {
  const actorId = input.pending.actorId;
  if (!actorId) {
    const error = new Error("Social pending action must expose actorId.");
    return {
      ok: false,
      actorId: "unknown",
      pending: input.pending,
      pendingIndex: input.pendingIndex,
      turnIndex: input.turnIndex,
      failureStage: "pending_actor_resolution",
      error: error.message,
      rawError: error
    };
  }
  const actor = input.actorById.get(actorId);
  if (!actor) {
    const error = new Error(`Missing social actor ${actorId}.`);
    return {
      ok: false,
      actorId,
      pending: input.pending,
      pendingIndex: input.pendingIndex,
      turnIndex: input.turnIndex,
      failureStage: "actor_lookup",
      error: error.message,
      rawError: error
    };
  }
  const transactionId = `${input.batchId}:transaction:${input.pendingIndex}:${input.turnIndex}:${actorId}`;
  let observation: TObservation | undefined;
  let traceId: string | undefined;
  let actorTurnIndex: number | undefined;
  let failureStage: SocialDecisionFailureStage = "decision_identity";
  try {
    const stateBeforeObserve = input.environment.snapshot();
    const decisionIdentityContext: SocialTraceIdProviderContext<TState, TPending> = {
      id: input.optionsId,
      state: cloneJson(stateBeforeObserve),
      pendingAction: cloneJson(input.pending),
      actorId,
      turnIndex: input.turnIndex,
      batchId: input.batchId,
      batchIndex: input.batchIndex,
      batchSize: input.batchSize,
      schedulerMode: input.schedulerMode
    };
    actorTurnIndex = input.actorTurnIndexForDecision?.(decisionIdentityContext);
    traceId = input.traceIdForDecision?.({
      ...decisionIdentityContext,
      actorTurnIndex
    }) ?? `${input.optionsId}:social:${input.turnIndex}:${actorId}`;
    failureStage = "environment_observe";
    const environmentObservation = input.environment.observe(actorId, input.pending);
    const visibleSocial = input.bus.observe(actorId);
    failureStage = "observation_assembly";
    observation = input.assembleObservation
      ? input.assembleObservation({
          agentId: actorId,
          pendingAction: cloneJson(input.pending),
          environmentObservation,
          visibleSocial
        })
      : environmentObservation;
    failureStage = "actor_observe";
    actor.observe(observation, {
      traceId,
      transactionId,
      transactional: true,
      turnIndex: input.turnIndex,
      actorTurnIndex,
      batchId: input.batchId,
      batchIndex: input.batchIndex,
      batchSize: input.batchSize,
      schedulerMode: input.schedulerMode,
      pendingAction: cloneJson(input.pending)
    });
    failureStage = "actor_decide";
    const action = await actor.decide(input.pending);
    const actionWithTraceId = action.traceId ? action : { ...action, traceId };
    return {
      ok: true,
      actor,
      actorId,
      pending: input.pending,
      observation,
      action: actionWithTraceId,
      pendingIndex: input.pendingIndex,
      turnIndex: input.turnIndex,
      transactionId
    };
  } catch (error) {
    return {
      ok: false,
      actor,
      actorId,
      pending: input.pending,
      observation,
      pendingIndex: input.pendingIndex,
      turnIndex: input.turnIndex,
      traceId,
      transactionId,
      actorTurnIndex,
      failureStage,
      error: error instanceof Error ? error.message : String(error),
      rawError: error
    };
  }
}

function applyOptionalSystemTransition<TState, TObservation, TPending extends { actorId?: string }, TCommand>(input: {
  optionsId: string;
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  bus: SocialCommunicationBus;
  turnIndex: number;
  batchIndex: number;
  schedulerMode: SocialResolvedSchedulerMode;
  hashState?: (state: TState) => string;
  eventSeq?: (state: TState) => number;
  systemTransition?: SocialSystemTransitionProvider<TState, TObservation, TPending, TCommand>;
}):
  | {
      status: "ok" | "failed";
      step: SocialHarnessStep<TObservation, TPending, TCommand>;
      feedback: SocialStepFeedback<TState, TObservation>;
      reason?: string;
    }
  | undefined {
  if (!input.systemTransition) return undefined;
  const preState = input.environment.snapshot();
  let transition: SocialSystemTransition<TObservation, TPending, TCommand> | undefined | null;
  try {
    transition = input.systemTransition({
      state: cloneJson(preState),
      turnIndex: input.turnIndex,
      schedulerMode: input.schedulerMode
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const feedback = emptyStepFeedback(input.environment.snapshot(), input.environment);
    const actorId = "system";
    return {
      status: "failed",
      reason,
      feedback,
      step: {
        traceId: `${input.optionsId}:social:${input.turnIndex}:${actorId}`,
        turnIndex: input.turnIndex,
        batchId: `${input.optionsId}:system:${input.batchIndex}`,
        batchIndex: 1,
        batchSize: 1,
        actorId,
        profileId: actorId,
        schedulerMode: input.schedulerMode,
        atomic: false,
        resolutionPolicy: "system-transition",
        pendingAction: undefined as unknown as TPending,
        observation: undefined as unknown as TObservation,
        action: { actorId, kind: "system.error", command: undefined as TCommand },
        commitStatus: "rejected",
        decisionStateHash: input.hashState?.(preState),
        preStateHash: input.hashState?.(preState),
        error: reason,
        failure: defaultFailureEvidence("system_transition_resolution", error)
      }
    };
  }
  if (!transition) return undefined;
  const actorId = transition.actorId ?? transition.action.actorId;
  const profileId = transition.profileId ?? actorId;
  const batchId = `${input.optionsId}:system:${input.batchIndex}`;
  const preStateHash = input.hashState?.(preState);
  const beforeEventSeq = input.eventSeq?.(preState);
  const beforeSeq = input.bus.listMessages().at(-1)?.seq ?? 0;
  const messages = transition.action.messages ?? [];
  const base = {
    traceId: `${input.optionsId}:social:${input.turnIndex}:${actorId}`,
    turnIndex: input.turnIndex,
    batchId,
    batchIndex: 1,
    batchSize: 1,
    actorId,
    profileId,
    schedulerMode: input.schedulerMode,
    atomic: false,
    resolutionPolicy: "system-transition",
    pendingAction: cloneJson(transition.pendingAction),
    observation: cloneJson(transition.observation),
    action: cloneJson(transition.action),
    decisionStateHash: preStateHash,
    preStateHash
  } satisfies SocialHarnessStep<TObservation, TPending, TCommand>;
  let environmentStepStarted = false;
  let environmentCommitted = false;
  let feedback: SocialStepFeedback<TState, TObservation> | undefined;
  try {
    assertSocialActionOwnership(transition.action, actorId);
    assertSocialActionValid(input.environment, transition.action.command, transition.pendingAction);
    input.bus.validateMessages(messages);
    environmentStepStarted = true;
    const result = input.environment.step(transition.action.command);
    environmentCommitted = true;
    feedback = normalizeStepFeedback(result, input.environment);
    input.bus.publishMany(messages);
    const afterEventSeq = input.eventSeq?.(feedback.state);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;
    return {
      status: "ok",
      feedback,
      step: {
        ...base,
        commitStatus: "committed",
        postStateHash: input.hashState?.(feedback.state),
        eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
        messageSeqRange: afterSeq > beforeSeq ? [beforeSeq + 1, afterSeq] : undefined,
        ...feedbackFields(feedback)
      }
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failureState = input.environment.snapshot();
    const failureStateHash = input.hashState?.(failureState);
    const afterEventSeq = input.eventSeq?.(failureState);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;
    if (environmentCommitted) {
      const committedFeedback = feedback ?? emptyStepFeedback(failureState, input.environment);
      const failure = defaultFailureEvidence("post_commit_failure", error);
      return {
        status: "failed",
        reason: failure.message,
        feedback: committedFeedback,
        step: {
          ...base,
          commitStatus: "committed",
          postStateHash: failureStateHash,
          eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
          messageSeqRange: afterSeq > beforeSeq ? [beforeSeq + 1, afterSeq] : undefined,
          error: failure.message,
          failure,
          ...feedbackFields(committedFeedback)
        }
      };
    }
    const rejectedFeedback = emptyStepFeedback(failureState, input.environment);
    const failure = environmentFailureEvidence({
      error,
      fallbackStage: failureStageForError(error, "system_environment_step"),
      environmentStepStarted,
      preStateHash,
      failureStateHash
    });
    return {
      status: "failed",
      reason,
      feedback: rejectedFeedback,
      step: {
        ...base,
        commitStatus: "rejected",
        postStateHash: failureStateHash,
        eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
        error: reason,
        failure
      }
    };
  }
}

function applySequentialDecision<TState, TObservation, TPending extends { actorId?: string }, TCommand>(input: {
  optionsId: string;
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  bus: SocialCommunicationBus;
  decision: Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }>;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
	  decisionStateHash?: string;
	  hashState?: (state: TState) => string;
	  eventSeq?: (state: TState) => number;
	  afterEnvironmentStep?: SocialAfterEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
	  onEnvironmentStepFailure?: SocialEnvironmentStepFailureHook<TState, TObservation, TPending, TCommand>;
	}): {
  status: "ok" | "failed";
  step: SocialHarnessStep<TObservation, TPending, TCommand>;
  feedback: SocialStepFeedback<TState, TObservation>;
  reason?: string;
} {
  const preState = input.environment.snapshot();
  const beforeEventSeq = input.eventSeq?.(preState);
  const beforeSeq = input.bus.listMessages().at(-1)?.seq ?? 0;
  const messages = input.decision.action.messages ?? [];
  const stepBase = baseStep(input);
  const preStateHash = input.hashState?.(preState);
  let environmentStepStarted = false;
  let environmentCommitted = false;
  let feedback: SocialStepFeedback<TState, TObservation> | undefined;
  let actorReceiptDelivered = false;
  try {
    assertSocialActionOwnership(input.decision.action, input.decision.actorId);
    assertSocialActionValid(input.environment, input.decision.action.command, input.decision.pending);
    input.bus.validateMessages(messages);
    environmentStepStarted = true;
    const result = input.environment.step(input.decision.action.command);
    environmentCommitted = true;
    feedback = normalizeStepFeedback(result, input.environment);
    input.bus.publishMany(messages);
    const afterEventSeq = input.eventSeq?.(feedback.state);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;
    const postStateHash = input.hashState?.(feedback.state);
    const committedEventSeqRange = eventSeqRange(beforeEventSeq, afterEventSeq);
    const committedMessageSeqRange = afterSeq > beforeSeq ? ([beforeSeq + 1, afterSeq] as [number, number]) : undefined;
    const actorFeedbackFailure = deliverActorStepReceipt(input.decision.actor, {
      id: `${stepBase.traceId}:committed`,
      status: "committed",
      traceId: stepBase.traceId,
      transactionId: input.decision.transactionId,
      turnIndex: stepBase.turnIndex,
      actorId: stepBase.actorId,
      pendingAction: cloneJson(input.decision.pending),
      action: input.decision.action,
      observation: cloneJson(feedback.observationsByAgent[stepBase.actorId]),
      reward: feedback.rewardsByAgent[stepBase.actorId],
      terminated: feedback.terminationsByAgent[stepBase.actorId],
      truncated: feedback.truncationsByAgent[stepBase.actorId],
      info: cloneJson(feedback.infosByAgent[stepBase.actorId]),
      postStateHash,
      eventSeqRange: committedEventSeqRange,
      messageSeqRange: committedMessageSeqRange
    });
    actorReceiptDelivered = true;
    const afterEnvironmentFailure = invokeAfterEnvironmentStep(input.afterEnvironmentStep, {
      actor: input.decision.actor,
      actorId: stepBase.actorId,
      profileId: stepBase.profileId,
      turnIndex: stepBase.turnIndex,
      batchId: input.batchId,
      batchIndex: input.batchIndex,
      batchSize: input.batchSize,
      schedulerMode: stepBase.schedulerMode,
      atomic: false,
      resolutionPolicy: stepBase.resolutionPolicy ?? "sequential-apply",
      pendingAction: cloneJson(input.decision.pending),
      observation: cloneJson(input.decision.observation),
      action: cloneJson(input.decision.action),
      preState: cloneJson(preState),
      preStateHash,
      decisionStateHash: input.decisionStateHash,
      feedback: cloneJson(feedback),
      postStateHash,
      eventSeqRange: committedEventSeqRange,
      messageSeqRange: committedMessageSeqRange
    });
    const postCommitFailure = combineStepFailureEvidence(actorFeedbackFailure, afterEnvironmentFailure);
    return {
      status: postCommitFailure ? "failed" : "ok",
      reason: postCommitFailure?.message,
      feedback,
      step: {
        ...stepBase,
        action: cloneJson(input.decision.action),
        commitStatus: "committed",
        preStateHash,
        postStateHash,
        eventSeqRange: committedEventSeqRange,
        messageSeqRange: committedMessageSeqRange,
        error: postCommitFailure?.message,
        failure: postCommitFailure,
        ...feedbackFields(feedback)
      }
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failureState = input.environment.snapshot();
    const failureStateHash = input.hashState?.(failureState);
    const afterEventSeq = input.eventSeq?.(failureState);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;

    // An environment return is the commit boundary. Errors from feedback
    // normalization, bus publication, or post-step observers must not rewrite
    // a committed domain transition as a rejected proposal.
    if (environmentCommitted) {
      const committedFeedback = feedback ?? emptyStepFeedback(failureState, input.environment);
      const committedEventSeqRange = eventSeqRange(beforeEventSeq, afterEventSeq);
      const committedMessageSeqRange = afterSeq > beforeSeq ? ([beforeSeq + 1, afterSeq] as [number, number]) : undefined;
      const postCommitFailure = defaultFailureEvidence("post_commit_failure", error);
      const receiptFailure = actorReceiptDelivered
        ? undefined
        : deliverActorStepReceipt(input.decision.actor, {
            id: `${stepBase.traceId}:committed`,
            status: "committed",
            traceId: stepBase.traceId,
            transactionId: input.decision.transactionId,
            turnIndex: stepBase.turnIndex,
            actorId: stepBase.actorId,
            pendingAction: cloneJson(input.decision.pending),
            action: input.decision.action,
            observation: cloneJson(committedFeedback.observationsByAgent[stepBase.actorId]),
            reward: committedFeedback.rewardsByAgent[stepBase.actorId],
            terminated: committedFeedback.terminationsByAgent[stepBase.actorId],
            truncated: committedFeedback.truncationsByAgent[stepBase.actorId],
            info: cloneJson(committedFeedback.infosByAgent[stepBase.actorId]),
            postStateHash: failureStateHash,
            eventSeqRange: committedEventSeqRange,
            messageSeqRange: committedMessageSeqRange
          });
      const failure = combineStepFailureEvidence(postCommitFailure, receiptFailure) ?? postCommitFailure;
      return {
        status: "failed",
        reason: failure.message,
        feedback: committedFeedback,
        step: {
          ...stepBase,
          action: cloneJson(input.decision.action),
          commitStatus: "committed",
          preStateHash,
          postStateHash: failureStateHash,
          eventSeqRange: committedEventSeqRange,
          messageSeqRange: committedMessageSeqRange,
          error: failure.message,
          failure,
          ...feedbackFields(committedFeedback)
        }
      };
    }

    const failureStateBeforeHook = failureState;
    const adapterFailure = input.onEnvironmentStepFailure?.({
      actor: input.decision.actor,
	      actorId: stepBase.actorId,
	      profileId: stepBase.profileId,
	      turnIndex: stepBase.turnIndex,
	      batchId: input.batchId,
	      batchIndex: input.batchIndex,
	      batchSize: input.batchSize,
	      schedulerMode: stepBase.schedulerMode,
	      atomic: false,
	      resolutionPolicy: stepBase.resolutionPolicy ?? "sequential-apply",
      pendingAction: cloneJson(input.decision.pending),
      observation: cloneJson(input.decision.observation),
      action: cloneJson(input.decision.action),
      preState: cloneJson(preState),
      preStateHash,
      decisionStateHash: input.decisionStateHash,
      failureState: cloneJson(failureStateBeforeHook),
      failureStateHash,
      error
    }) ?? undefined;
    const rejectedFeedback = emptyStepFeedback(failureState, input.environment);
    const failure = environmentFailureEvidence({
      error,
      fallbackStage: failureStageForError(error, "environment_step"),
      adapterFailure,
      environmentStepStarted,
      preStateHash,
      failureStateHash
    });
    const rejectedEventSeqRange = eventSeqRange(beforeEventSeq, afterEventSeq);
    const receiptFailure = deliverActorStepReceipt(input.decision.actor, {
	      id: `${stepBase.traceId}:rejected`,
	      status: "rejected",
	      traceId: stepBase.traceId,
      transactionId: input.decision.transactionId,
	      turnIndex: stepBase.turnIndex,
	      actorId: stepBase.actorId,
      pendingAction: cloneJson(input.decision.pending),
      action: input.decision.action,
      postStateHash: failureStateHash,
      eventSeqRange: rejectedEventSeqRange,
      failure
    });
    return {
      status: "failed",
      reason,
      feedback: rejectedFeedback,
      step: {
        ...stepBase,
        action: cloneJson(input.decision.action),
        commitStatus: "rejected",
        preStateHash,
        postStateHash: failureStateHash,
        eventSeqRange: rejectedEventSeqRange,
        error: reason,
        failure: receiptFailure ?? failure
	      }
    };
  }
}

function applyParallelBatch<TState, TObservation, TPending extends { actorId?: string }, TCommand>(input: {
  optionsId: string;
  environment: SocialParallelEnvironment<TState, TObservation, TPending, TCommand>;
  bus: SocialCommunicationBus;
  decisions: Array<Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }>>;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
	  decisionStateHash?: string;
	  hashState?: (state: TState) => string;
	  eventSeq?: (state: TState) => number;
	  afterEnvironmentStep?: SocialAfterEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
	  onEnvironmentStepFailure?: SocialEnvironmentStepFailureHook<TState, TObservation, TPending, TCommand>;
	}): {
  status: "ok" | "failed";
  steps: Array<SocialHarnessStep<TObservation, TPending, TCommand>>;
  feedback: SocialStepFeedback<TState, TObservation>;
  reason?: string;
} {
  const preState = input.environment.snapshot();
  const beforeEventSeq = input.eventSeq?.(preState);
  const beforeSeq = input.bus.listMessages().at(-1)?.seq ?? 0;
  const messages = input.decisions.flatMap((decision) => decision.action.messages ?? []);
  const preStateHash = input.hashState?.(preState);
  const messageSeqRangeByActor = new Map<string, [number, number] | undefined>();
  const receiptDeliveredByActor = new Set<string>();
  let environmentStepStarted = false;
  let environmentCommitted = false;
  let feedback: SocialStepFeedback<TState, TObservation> | undefined;
  try {
    for (const decision of input.decisions) {
      assertSocialActionOwnership(decision.action, decision.actorId);
      assertSocialActionValid(input.environment, decision.action.command, decision.pending);
    }
    assertParallelActorIdsUnique(input.decisions);
    input.bus.validateMessages(messages);
    const commandsByAgent = Object.fromEntries(input.decisions.map((decision) => [decision.actorId, decision.action.command]));
    environmentStepStarted = true;
    const result = input.environment.stepBatch(commandsByAgent);
    environmentCommitted = true;
    feedback = normalizeStepFeedback(result, input.environment);
    // Publish in decision order and retain per-actor seq ranges so integrity can
    // attribute message metadata.traceId to the owning step in a joint batch.
    for (const decision of input.decisions) {
      const actorMessages = decision.action.messages ?? [];
      if (!actorMessages.length) {
        messageSeqRangeByActor.set(decision.actorId, undefined);
        continue;
      }
      const published = input.bus.publishMany(actorMessages);
      const firstSeq = published[0]?.seq;
      const lastSeq = published.at(-1)?.seq;
      messageSeqRangeByActor.set(
        decision.actorId,
        firstSeq !== undefined && lastSeq !== undefined ? [firstSeq, lastSeq] : undefined
      );
    }
    const afterEventSeq = input.eventSeq?.(feedback.state);
    const postStateHash = input.hashState?.(feedback.state);
    const committedEventSeqRange = eventSeqRange(beforeEventSeq, afterEventSeq);
    const receiptFailures = new Map<string, SocialStepFailureEvidence>();
    for (const [index, decision] of input.decisions.entries()) {
      const stepBase = baseStep({ ...input, decision, turnIndex: input.turnIndex + index });
      const committedMessageSeqRange = messageSeqRangeByActor.get(decision.actorId);
      const failure = deliverActorStepReceipt(decision.actor, {
        id: `${stepBase.traceId}:committed`,
        status: "committed",
        traceId: stepBase.traceId,
        transactionId: decision.transactionId,
        turnIndex: stepBase.turnIndex,
        actorId: stepBase.actorId,
        pendingAction: cloneJson(decision.pending),
        action: decision.action,
        observation: cloneJson(feedback.observationsByAgent[stepBase.actorId]),
        reward: feedback.rewardsByAgent[stepBase.actorId],
        terminated: feedback.terminationsByAgent[stepBase.actorId],
        truncated: feedback.truncationsByAgent[stepBase.actorId],
        info: cloneJson(feedback.infosByAgent[stepBase.actorId]),
        postStateHash,
        eventSeqRange: committedEventSeqRange,
        messageSeqRange: committedMessageSeqRange
      });
      receiptDeliveredByActor.add(stepBase.actorId);
      if (failure) receiptFailures.set(stepBase.actorId, failure);
    }

    // Agent-private state is part of the committed joint outcome. Run snapshot
    // hooks only after every actor has processed its receipt, so all records
    // taken for this batch describe the same post-commit agent state.
    const actorFeedbackFailures = new Map<string, SocialStepFailureEvidence>();
    for (const [index, decision] of input.decisions.entries()) {
      const stepBase = baseStep({ ...input, decision, turnIndex: input.turnIndex + index });
      const committedMessageSeqRange = messageSeqRangeByActor.get(decision.actorId);
      const afterEnvironmentFailure = invokeAfterEnvironmentStep(input.afterEnvironmentStep, {
        actor: decision.actor,
        actorId: stepBase.actorId,
        profileId: stepBase.profileId,
        turnIndex: stepBase.turnIndex,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        schedulerMode: stepBase.schedulerMode,
        atomic: true,
        resolutionPolicy: "parallel-stepBatch",
        pendingAction: cloneJson(decision.pending),
        observation: cloneJson(decision.observation),
        action: cloneJson(decision.action),
        preState: cloneJson(preState),
        preStateHash,
        decisionStateHash: input.decisionStateHash,
        feedback: cloneJson(feedback),
        postStateHash,
        eventSeqRange: committedEventSeqRange,
        messageSeqRange: committedMessageSeqRange
      });
      const postCommitFailure = combineStepFailureEvidence(receiptFailures.get(stepBase.actorId), afterEnvironmentFailure);
      if (postCommitFailure) actorFeedbackFailures.set(stepBase.actorId, postCommitFailure);
    }
    const firstActorFeedbackFailure = actorFeedbackFailures.values().next().value as SocialStepFailureEvidence | undefined;
    return {
      status: firstActorFeedbackFailure ? "failed" : "ok",
      reason: firstActorFeedbackFailure?.message,
      feedback,
      steps: input.decisions.map((decision, index) => {
        const feedbackFailure = actorFeedbackFailures.get(decision.actorId);
        return {
          ...baseStep({ ...input, decision, turnIndex: input.turnIndex + index }),
          action: cloneJson(decision.action),
          commitStatus: "committed" as const,
          atomic: true,
          resolutionPolicy: "parallel-stepBatch",
          preStateHash,
          postStateHash,
          eventSeqRange: committedEventSeqRange,
          messageSeqRange: messageSeqRangeByActor.get(decision.actorId),
          error: feedbackFailure?.message,
          failure: feedbackFailure,
          ...feedbackFields(feedback!)
        };
      })
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failureState = input.environment.snapshot();
    const failureStateHash = input.hashState?.(failureState);
    const afterEventSeq = input.eventSeq?.(failureState);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;

    if (environmentCommitted) {
      const committedFeedback = feedback ?? emptyStepFeedback(failureState, input.environment);
      const committedEventSeqRange = eventSeqRange(beforeEventSeq, afterEventSeq);
      const committedFailures = new Map<string, SocialStepFailureEvidence>();
      for (const [index, decision] of input.decisions.entries()) {
        const stepBase = baseStep({ ...input, decision, turnIndex: input.turnIndex + index });
        const postCommitFailure = defaultFailureEvidence("post_commit_failure", error);
        const receiptFailure = receiptDeliveredByActor.has(stepBase.actorId)
          ? undefined
          : deliverActorStepReceipt(decision.actor, {
              id: `${stepBase.traceId}:committed`,
              status: "committed",
              traceId: stepBase.traceId,
              transactionId: decision.transactionId,
              turnIndex: stepBase.turnIndex,
              actorId: stepBase.actorId,
              pendingAction: cloneJson(decision.pending),
              action: decision.action,
              observation: cloneJson(committedFeedback.observationsByAgent[stepBase.actorId]),
              reward: committedFeedback.rewardsByAgent[stepBase.actorId],
              terminated: committedFeedback.terminationsByAgent[stepBase.actorId],
              truncated: committedFeedback.truncationsByAgent[stepBase.actorId],
              info: cloneJson(committedFeedback.infosByAgent[stepBase.actorId]),
              postStateHash: failureStateHash,
              eventSeqRange: committedEventSeqRange,
              messageSeqRange: messageSeqRangeByActor.get(stepBase.actorId)
            });
        committedFailures.set(
          stepBase.actorId,
          combineStepFailureEvidence(postCommitFailure, receiptFailure) ?? postCommitFailure
        );
      }
      const failure = committedFailures.values().next().value as SocialStepFailureEvidence;
      return {
        status: "failed",
        reason: failure.message,
        feedback: committedFeedback,
        steps: input.decisions.map((decision, index) => ({
          ...baseStep({ ...input, decision, turnIndex: input.turnIndex + index }),
          action: cloneJson(decision.action),
          commitStatus: "committed" as const,
          atomic: true,
          resolutionPolicy: "parallel-stepBatch",
          preStateHash,
          postStateHash: failureStateHash,
          eventSeqRange: committedEventSeqRange,
          messageSeqRange: messageSeqRangeByActor.get(decision.actorId),
          error: committedFailures.get(decision.actorId)?.message,
          failure: committedFailures.get(decision.actorId),
          ...feedbackFields(committedFeedback)
        }))
      };
    }

    const failureStateBeforeHook = failureState;
    const parallelFailures = new Map<string, SocialStepFailureEvidence>();
    for (const [index, decision] of input.decisions.entries()) {
	      const stepBase = baseStep({ ...input, decision, turnIndex: input.turnIndex + index });
      const adapterFailure = input.onEnvironmentStepFailure?.({
	        actor: decision.actor,
	        actorId: stepBase.actorId,
	        profileId: stepBase.profileId,
	        turnIndex: stepBase.turnIndex,
	        batchId: input.batchId,
	        batchIndex: input.batchIndex,
	        batchSize: input.batchSize,
	        schedulerMode: stepBase.schedulerMode,
	        atomic: true,
	        resolutionPolicy: "parallel-stepBatch",
	        pendingAction: cloneJson(decision.pending),
	        observation: cloneJson(decision.observation),
        action: cloneJson(decision.action),
        preState: cloneJson(preState),
        preStateHash,
        decisionStateHash: input.decisionStateHash,
        failureState: cloneJson(failureStateBeforeHook),
        failureStateHash,
        error
      }) ?? undefined;
      const failure = environmentFailureEvidence({
        error,
        fallbackStage: failureStageForError(error, "parallel_environment_step"),
        adapterFailure,
        environmentStepStarted,
        preStateHash,
        failureStateHash
      });
      const receiptFailure = deliverActorStepReceipt(decision.actor, {
	        id: `${stepBase.traceId}:rejected`,
	        status: "rejected",
	        traceId: stepBase.traceId,
        transactionId: decision.transactionId,
	        turnIndex: stepBase.turnIndex,
	        actorId: stepBase.actorId,
        pendingAction: cloneJson(decision.pending),
        action: decision.action,
        postStateHash: failureStateHash,
        failure
      });
      parallelFailures.set(decision.actorId, receiptFailure ?? failure);
    }
    const rejectedFeedback = emptyStepFeedback(failureState, input.environment);
    return {
      status: "failed",
      reason,
      feedback: rejectedFeedback,
      steps: input.decisions.map((decision, index) => ({
        ...baseStep({ ...input, decision, turnIndex: input.turnIndex + index }),
	        action: cloneJson(decision.action),
	        commitStatus: "rejected",
        atomic: true,
        resolutionPolicy: "parallel-stepBatch",
        preStateHash,
        postStateHash: failureStateHash,
        eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
	        error: reason,
	        failure: parallelFailures.get(decision.actorId) ?? defaultFailureEvidence("parallel_environment_step", error)
	      }))
    };
  }
}

function baseStep<TObservation, TPending, TCommand>(input: {
  optionsId: string;
  decision: Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }>;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  decisionStateHash?: string;
}): Omit<SocialHarnessStep<TObservation, TPending, TCommand>, "action"> {
  return {
    traceId: input.decision.action.traceId ?? `${input.optionsId}:social:${input.turnIndex}:${input.decision.actorId}`,
    turnIndex: input.turnIndex,
    batchId: input.batchId,
    batchIndex: input.batchIndex,
    batchSize: input.batchSize,
    actorId: input.decision.actorId,
    profileId: input.decision.actor.profile.id,
    schedulerMode: input.schedulerMode,
    atomic: false,
    resolutionPolicy: input.schedulerMode === "aec-batched-decision" ? "sequential-apply-from-shared-decision-state" : "sequential-apply",
    pendingAction: cloneJson(input.decision.pending),
    observation: cloneJson(input.decision.observation),
    decisionStateHash: input.decisionStateHash
  };
}

function failedDecisionToStep<TObservation, TPending, TCommand>(input: {
  optionsId: string;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  decisionStateHash?: string;
  preStateHash?: string;
  postStateHash?: string;
  eventSeqRange?: [number, number];
  failure: SocialStepFailureEvidence;
  decision: Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: false }>;
}): SocialHarnessStep<TObservation, TPending, TCommand> {
  return {
    traceId: input.decision.traceId ?? `${input.optionsId}:social:${input.turnIndex}:${input.decision.actorId}`,
    turnIndex: input.turnIndex,
    batchId: input.batchId,
    batchIndex: input.batchIndex,
    batchSize: input.batchSize,
    actorId: input.decision.actorId,
    profileId: input.decision.actor?.profile.id ?? input.decision.actorId,
    schedulerMode: input.schedulerMode,
    atomic: input.schedulerMode === "parallel",
    resolutionPolicy:
      input.schedulerMode === "parallel"
        ? "parallel-stepBatch"
        : input.schedulerMode === "aec-batched-decision"
          ? "sequential-apply-from-shared-decision-state"
          : "sequential-apply",
    pendingAction: cloneJson(input.decision.pending),
    observation: cloneJson(input.decision.observation as TObservation),
    action: { actorId: input.decision.actorId, kind: "error", command: undefined as TCommand },
    commitStatus: "rejected",
    decisionStateHash: input.decisionStateHash,
    preStateHash: input.preStateHash,
    postStateHash: input.postStateHash,
    eventSeqRange: input.eventSeqRange,
    error: input.decision.error,
    failure: cloneJson(input.failure)
  };
}

/**
 * Scheduler/input failures happen before any actor observes or decides. Keep
 * them as explicit rejected native records so the artifact explains why the
 * runner made no environment call without pretending a joint action existed.
 */
function schedulerFailureStep<TObservation, TPending, TCommand>(input: {
  optionsId: string;
  turnIndex: number;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: SocialResolvedSchedulerMode;
  pendingAction: TPending;
  decisionStateHash?: string;
  preStateHash?: string;
  postStateHash?: string;
  failure: SocialStepFailureEvidence;
}): SocialHarnessStep<TObservation, TPending, TCommand> {
  return {
    traceId: `${input.optionsId}:scheduler:${input.batchIndex}:rejected`,
    turnIndex: input.turnIndex,
    batchId: input.batchId,
    batchIndex: input.batchIndex,
    batchSize: input.batchSize,
    actorId: "system",
    profileId: "system",
    schedulerMode: input.schedulerMode,
    atomic: false,
    resolutionPolicy: "scheduler-validation",
    pendingAction: cloneJson(input.pendingAction),
    observation: undefined as unknown as TObservation,
    action: { actorId: "system", kind: "scheduler.error", command: undefined as TCommand },
    commitStatus: "rejected",
    decisionStateHash: input.decisionStateHash,
    preStateHash: input.preStateHash,
    postStateHash: input.postStateHash,
    error: input.failure.message,
    failure: cloneJson(input.failure)
  };
}

/**
 * AEC batched collection is concurrent only while agents form proposals. If
 * the batch is abandoned before a proposal is applied, record every affected
 * proposal as rejected so receipts and native evidence remain symmetric.
 */
function rejectedSequentialDecisionBatchSteps<TObservation, TPending, TCommand>(input: {
  optionsId: string;
  decisions: ReadonlyArray<SocialDecision<TObservation, TPending, TCommand>>;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  schedulerMode: Exclude<SocialResolvedSchedulerMode, "parallel">;
  decisionStateHash?: string;
  preStateHash?: string;
  postStateHash?: string;
  eventSeqRange?: [number, number];
  failureForDecision: (decision: SocialDecision<TObservation, TPending, TCommand>) => SocialStepFailureEvidence;
}): Array<SocialHarnessStep<TObservation, TPending, TCommand>> {
  return input.decisions.map((decision) => {
    const failure = input.failureForDecision(decision);
    if (!decision.ok) {
      return failedDecisionToStep({
        optionsId: input.optionsId,
        turnIndex: decision.turnIndex,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        schedulerMode: input.schedulerMode,
        decisionStateHash: input.decisionStateHash,
        preStateHash: input.preStateHash,
        postStateHash: input.postStateHash,
        eventSeqRange: input.eventSeqRange,
        failure,
        decision
      });
    }

    return {
      ...baseStep({
        optionsId: input.optionsId,
        decision,
        turnIndex: decision.turnIndex,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        schedulerMode: input.schedulerMode,
        decisionStateHash: input.decisionStateHash
      }),
      action: cloneJson(decision.action),
      commitStatus: "rejected",
      preStateHash: input.preStateHash,
      postStateHash: input.postStateHash,
      eventSeqRange: input.eventSeqRange,
      error: failure.message,
      failure: cloneJson(failure)
    };
  });
}

function rejectedParallelDecisionBatchSteps<TObservation, TPending, TCommand>(input: {
  optionsId: string;
  decisions: ReadonlyArray<SocialDecision<TObservation, TPending, TCommand>>;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  decisionStateHash?: string;
  preStateHash?: string;
  postStateHash?: string;
  eventSeqRange?: [number, number];
  failureForDecision: (decision: SocialDecision<TObservation, TPending, TCommand>) => SocialStepFailureEvidence;
}): Array<SocialHarnessStep<TObservation, TPending, TCommand>> {
  return input.decisions.map((decision) => {
    const failure = input.failureForDecision(decision);
    if (!decision.ok) {
      return failedDecisionToStep({
        optionsId: input.optionsId,
        turnIndex: decision.turnIndex,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        schedulerMode: "parallel",
        decisionStateHash: input.decisionStateHash,
        preStateHash: input.preStateHash,
        postStateHash: input.postStateHash,
        eventSeqRange: input.eventSeqRange,
        failure,
        decision
      });
    }

    return {
      ...baseStep({
        optionsId: input.optionsId,
        decision,
        turnIndex: decision.turnIndex,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        schedulerMode: "parallel",
        decisionStateHash: input.decisionStateHash
      }),
      action: cloneJson(decision.action),
      commitStatus: "rejected",
      atomic: true,
      resolutionPolicy: "parallel-stepBatch",
      preStateHash: input.preStateHash,
      postStateHash: input.postStateHash,
      eventSeqRange: input.eventSeqRange,
      error: failure.message,
      failure: cloneJson(failure)
    };
  });
}

function defaultFailureEvidence(stage: string, error: unknown): SocialStepFailureEvidence {
  const validation = error instanceof SocialActionValidationError ? error.result : undefined;
  return {
    stage,
    message: error instanceof Error ? error.message : String(error),
    causeName: error instanceof Error ? error.name : undefined,
    metadata: validation
      ? {
          code: validation.code,
          ...(validation.metadata ?? {})
        }
      : undefined
  };
}

function failureStageForError(error: unknown, fallback: string): string {
  if (error instanceof SocialActionValidationError) return "environment_validation";
  if (error instanceof SocialActionOwnershipError) return "action_ownership";
  return fallback;
}

function environmentFailureEvidence(input: {
  error: unknown;
  fallbackStage: string;
  adapterFailure?: SocialStepFailureEvidence;
  environmentStepStarted: boolean;
  preStateHash?: string;
  failureStateHash?: string;
}): SocialStepFailureEvidence {
  const base = input.adapterFailure ?? defaultFailureEvidence(input.fallbackStage, input.error);
  if (input.error instanceof SocialPreflightMutationError) {
    return {
      stage: "environment_non_atomic_failure",
      message: "Environment validateAction() mutated domain state; the failure is not replayable.",
      causeName: input.error.name,
      metadata: {
        originalStage: base.stage,
        preflightBeforeFingerprint: input.error.beforeFingerprint,
        preflightAfterFingerprint: input.error.afterFingerprint,
        ...(base.metadata ? { originalMetadata: cloneJson(base.metadata) } : {})
      }
    };
  }
  if (
    input.environmentStepStarted &&
    input.preStateHash !== undefined &&
    input.failureStateHash !== undefined &&
    input.preStateHash !== input.failureStateHash
  ) {
    return {
      stage: "environment_non_atomic_failure",
      message: "Environment transition threw after mutating domain state; the failure is not replayable.",
      causeName: base.causeName,
      metadata: {
        originalStage: base.stage,
        preStateHash: input.preStateHash,
        failureStateHash: input.failureStateHash,
        ...(base.metadata ? { originalMetadata: cloneJson(base.metadata) } : {})
      }
    };
  }
  return base;
}

function invokeAfterEnvironmentStep<TState, TObservation, TPending, TCommand>(
  hook: SocialAfterEnvironmentStepHook<TState, TObservation, TPending, TCommand> | undefined,
  context: SocialAfterEnvironmentStepContext<TState, TObservation, TPending, TCommand>
): SocialStepFailureEvidence | undefined {
  if (!hook) return undefined;
  try {
    hook(context);
    return undefined;
  } catch (error) {
    return defaultFailureEvidence("after_environment_step", error);
  }
}

function combineStepFailureEvidence(
  ...failures: Array<SocialStepFailureEvidence | undefined>
): SocialStepFailureEvidence | undefined {
  const present = failures.filter((failure): failure is SocialStepFailureEvidence => failure !== undefined);
  if (!present.length) return undefined;
  if (present.length === 1) return present[0];
  return {
    stage: "post_commit_feedback",
    message: present.map((failure) => `${failure.stage}: ${failure.message}`).join("; "),
    metadata: {
      failures: present.map((failure) => ({
        stage: failure.stage,
        message: failure.message,
        ...(failure.causeName ? { causeName: failure.causeName } : {})
      }))
    }
  };
}

function assertSocialActionValid<TState, TObservation, TPending, TCommand>(
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>,
  command: TCommand,
  pending: TPending
): void {
  if (!environment.validateAction) return;
  const beforeFingerprint = fingerprintState(environment.snapshot());
  const result = environment.validateAction(command, cloneJson(pending));
  const afterFingerprint = fingerprintState(environment.snapshot());
  if (beforeFingerprint !== afterFingerprint) {
    throw new SocialPreflightMutationError(beforeFingerprint, afterFingerprint);
  }
  if (!result.valid) throw new SocialActionValidationError(result);
}

function fingerprintState(value: unknown): string {
  return JSON.stringify(normalizeForFingerprint(value));
}

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForFingerprint);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForFingerprint(record[key])])
    );
  }
  return value;
}

function assertSocialActionOwnership<TCommand>(action: SocialAction<TCommand>, expectedActorId: string): void {
  if (action.actorId !== expectedActorId) {
    throw new SocialActionOwnershipError(
      `Scheduled actor ${expectedActorId} returned an action owned by ${action.actorId}.`
    );
  }
  for (const [index, message] of (action.messages ?? []).entries()) {
    if (message.senderId !== expectedActorId) {
      throw new SocialActionOwnershipError(
        `Scheduled actor ${expectedActorId} returned message draft ${index} with sender ${message.senderId}.`
      );
    }
  }
}

function assertParallelActorIdsUnique<TObservation, TPending, TCommand>(
  decisions: Array<Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }>>
): void {
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.actorId)) {
      throw new SocialActionOwnershipError(
        `Parallel batch contains multiple decisions for scheduled actor ${decision.actorId}.`
      );
    }
    seen.add(decision.actorId);
  }
}

function deliverActorStepReceipt<TObservation, TPending, TCommand>(
  actor: SocialActor<TObservation, TPending, TCommand>,
  receipt: SocialActorStepReceipt<TObservation, TPending, TCommand>
): SocialStepFailureEvidence | undefined {
  if (!actor.onStepResult) return undefined;
  try {
    // Actor feedback is advisory lifecycle input, never a mutable handle to
    // the runner-owned proposed action that will be serialized in the native
    // artifact. Give each actor an isolated serializable receipt.
    actor.onStepResult(cloneJson(receipt));
    return undefined;
  } catch (error) {
    return defaultFailureEvidence("actor_step_feedback", error);
  }
}

function feedbackFields<TState, TObservation>(feedback: SocialStepFeedback<TState, TObservation>): Pick<
  SocialHarnessStep<TObservation>,
  | "rewardsByAgent"
  | "terminationsByAgent"
  | "truncationsByAgent"
  | "doneByAgent"
  | "infosByAgent"
  | "episodeTerminated"
  | "episodeTruncated"
  | "terminationReason"
  | "truncationReason"
> {
  return {
    rewardsByAgent: cloneJson(feedback.rewardsByAgent),
    terminationsByAgent: cloneJson(feedback.terminationsByAgent),
    truncationsByAgent: cloneJson(feedback.truncationsByAgent),
    doneByAgent: doneByAgent(feedback),
    infosByAgent: cloneJson(feedback.infosByAgent),
    episodeTerminated: feedback.episodeTerminated,
    episodeTruncated: feedback.episodeTruncated,
    terminationReason: feedback.terminationReason,
    truncationReason: feedback.truncationReason
  };
}

function eventSeqRange(before: number | undefined, after: number | undefined): [number, number] | undefined {
  if (typeof before !== "number" || typeof after !== "number") return undefined;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return undefined;
  if (after <= before) return undefined;
  return [before + 1, after];
}

function normalizeStepFeedback<TState, TObservation>(
  result: SocialStepResult<TState, TObservation>,
  environment: SocialEnvironment<TState, TObservation>
): SocialStepFeedback<TState, TObservation> {
  if (isStepFeedback<TState, TObservation>(result)) return cloneJson(result);
  return emptyStepFeedback(result, environment);
}

function emptyStepFeedback<TState, TObservation>(
  state: TState,
  environment: SocialEnvironment<TState, TObservation>
): SocialStepFeedback<TState, TObservation> {
  return {
    state: cloneJson(state),
    observationsByAgent: {},
    rewardsByAgent: {},
    terminationsByAgent: {},
    truncationsByAgent: {},
    infosByAgent: {},
    episodeTerminated: environment.done(),
    episodeTruncated: false
  };
}

function isStepFeedback<TState, TObservation>(value: SocialStepResult<TState, TObservation>): value is SocialStepFeedback<TState, TObservation> {
  if (value === null || typeof value !== "object") return false;
  return "state" in value && "rewardsByAgent" in value && "terminationsByAgent" in value && "truncationsByAgent" in value;
}

function doneByAgent<TState, TObservation>(feedback: SocialStepFeedback<TState, TObservation>): Record<string, boolean> {
  const agentIds = new Set([...Object.keys(feedback.terminationsByAgent), ...Object.keys(feedback.truncationsByAgent)]);
  return Object.fromEntries([...agentIds].map((agentId) => [agentId, Boolean(feedback.terminationsByAgent[agentId] || feedback.truncationsByAgent[agentId])]));
}

function isParallelEnvironment<TState, TObservation, TPending, TCommand>(
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>
): environment is SocialParallelEnvironment<TState, TObservation, TPending, TCommand> {
  return typeof (environment as Partial<SocialParallelEnvironment<TState, TObservation, TPending, TCommand>>).stepBatch === "function";
}

function normalizeSchedulerMode(mode: SocialSchedulerMode): SocialResolvedSchedulerMode {
  if (mode === "simultaneous-batch") return "aec-batched-decision";
  return mode;
}

function resolveSchedulerMode<TState, TPending>(input: {
  optionsId: string;
  state: TState;
  pendingActions: TPending[];
  turnIndex: number;
  batchIndex: number;
  defaultSchedulerMode: SocialResolvedSchedulerMode;
  schedulerModeForBatch?: SocialSchedulerResolver<TState, TPending>;
}): SocialResolvedSchedulerMode {
  const selected = input.schedulerModeForBatch?.({
    id: input.optionsId,
    state: cloneJson(input.state),
    pendingActions: cloneJson(input.pendingActions),
    turnIndex: input.turnIndex,
    batchIndex: input.batchIndex,
    defaultSchedulerMode: input.defaultSchedulerMode
  });
  return normalizeSchedulerMode(selected ?? input.defaultSchedulerMode);
}

function selectPendingBatch<TPending>(pending: TPending[], schedulerMode: SocialResolvedSchedulerMode): TPending[] {
  if (schedulerMode === "aec-batched-decision" || schedulerMode === "parallel") return pending;
  return pending.slice(0, 1);
}

function findDuplicatePendingActorId<TPending extends { actorId?: string }>(pendingBatch: readonly TPending[]): string | undefined {
  const actorIds = new Set<string>();
  for (const pending of pendingBatch) {
    const actorId = pending.actorId;
    if (!actorId) continue;
    if (actorIds.has(actorId)) return actorId;
    actorIds.add(actorId);
  }
  return undefined;
}

function deterministicMessageTimestamp(seq: number): string {
  return new Date(seq * 1000).toISOString();
}

function normalizeSpeechActs(
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">,
  messageId: string,
  messageSeq: number
): SocialSpeechAct[] | undefined {
  const explicitActs = Array.isArray(message.speechActs) ? message.speechActs : [];
  const derivedActs = speechActsFromStructuredSocialFacts(message);
  const acts = [...explicitActs, ...derivedActs];
  if (!acts.length) return undefined;
  return acts.map((act, index) => {
    const evidenceRef: SocialEvidenceRef = {
      artifact: "message",
      id: messageId,
      seq: messageSeq,
      description: message.channelId
    };
    const evidenceRefs = Array.isArray(act.evidenceRefs) && act.evidenceRefs.length ? cloneJson(act.evidenceRefs) : [evidenceRef];
    if (!evidenceRefs.some((ref) => ref.artifact === "message" && ref.id === messageId)) evidenceRefs.unshift(evidenceRef);
    return {
      ...cloneJson(act),
      id: act.id?.trim() ? act.id : `${messageId}:speech-act:${index + 1}`,
      evidenceRefs
    };
  });
}

function speechActsFromStructuredSocialFacts(message: Omit<SocialMessage, "id" | "seq" | "createdAt">): SocialSpeechAct[] {
  const metadata = asRecord(message.metadata);
  if (!metadata) return [];
  const acts: SocialSpeechAct[] = [];
  const evidenceRefs: SocialEvidenceRef[] = [];
  for (const fact of socialFactsFromMetadata(metadata)) {
    const factKind = stringMetadata(fact.kind);
    const actKind = speechActKindFromSocialFact(factKind);
    if (!actKind) continue;
    acts.push({
      id: "",
      kind: actKind,
      subjectId: stringMetadata(fact.actorId) ?? stringMetadata(fact.speakerId) ?? stringMetadata(fact.subjectId) ?? message.senderId,
      targetId: stringMetadata(fact.targetId),
      value: fact.claim ?? fact.stance ?? fact.sharedGoal ?? fact.expectedBehavior ?? fact.status ?? factKind,
      confidence: numberMetadata(fact.confidence),
      evidenceRefs,
      metadata: { source: "metadata.socialFacts", factKind, factId: stringMetadata(fact.id) }
    });
  }
  return acts;
}

function deliveryReceiptsForMessage(
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">,
  channel: SocialChannel | undefined,
  messageId: string,
  messageSeq: number
): SocialDeliveryReceipt[] | undefined {
  if (!channel || message.visibility === "postgame") return undefined;
  const observerIds = visibleObserverIdsForMessage(message, channel);
  if (!observerIds.length) return undefined;
  const turnIndex = numberMetadata(asRecord(message.metadata)?.turnIndex);
  return observerIds.map((observerId, index) => ({
    id: `${messageId}:delivery:${index + 1}:${observerId}`,
    messageId,
    messageSeq,
    channelId: message.channelId,
    senderId: message.senderId,
    observerId,
    visibility: message.visibility,
    deliveredAtTurn: turnIndex,
    redactionPolicy: `runtime-visible:${message.visibility}`
  }));
}

function visibleObserverIdsForMessage(message: Omit<SocialMessage, "id" | "seq" | "createdAt">, channel: SocialChannel): string[] {
  const ids = new Set<string>();
  if (message.visibility === "public") {
    for (const participantId of channel.participantIds) ids.add(participantId);
    if (channel.readableBy === "all") {
      ids.add(message.senderId);
      for (const recipientId of message.recipientIds) ids.add(recipientId);
    }
  } else {
    ids.add(message.senderId);
    for (const recipientId of message.recipientIds) ids.add(recipientId);
  }
  return [...ids].filter((observerId) => observerId.trim()).sort();
}

function speechActKindFromSocialFact(kind: string | undefined): SocialSpeechActKind | undefined {
  if (kind === "commitment" || kind === "commitment-status") return "commitment";
  if (kind === "coalition" || kind === "coalition-evidence") return "coalition_signal";
  if (kind === "gossip") return "claim";
  if (kind === "norm-sanction" || kind === "norm-sanction-status") return "threat";
  if (kind === "trust-repair" || kind === "trust-repair-status") return "trust_repair";
  if (kind === "betrayal" || kind === "betrayal-evidence") return "claim";
  return undefined;
}

function socialFactsFromMetadata(metadata: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(metadata.socialFacts) ? metadata.socialFacts.flatMap((item) => (asRecord(item) ? [asRecord(item)!] : [])) : [];
}

function extractObservedSocialMessages<TObservation, TPending, TCommand>(
  step: SocialHarnessStep<TObservation, TPending, TCommand>
): { observerId: string; messages: SocialMessage[] } | undefined {
  const observation = asRecord(step.observation);
  const direct = observation ? socialViewFromRecord(observation, step.actorId) : undefined;
  if (direct) return direct;
  const wrappedView = asRecord(observation?.view);
  return wrappedView ? socialViewFromRecord(wrappedView, stringValue(observation?.agentId, step.actorId)) : undefined;
}

function socialViewFromRecord(record: Record<string, unknown>, fallbackObserverId: string): { observerId: string; messages: SocialMessage[] } | undefined {
  const social = asRecord(record.social);
  const rawMessages = Array.isArray(social?.messages) ? social.messages : record.visibleMessages;
  if (!Array.isArray(rawMessages)) return undefined;
  const you = asRecord(record.you);
  const observerId = stringValue(you?.id, stringValue(record.agentId, fallbackObserverId));
  return {
    observerId,
    messages: rawMessages.filter(isSocialMessage)
  };
}

function findCommittedMessage(committedMessages: Map<string, SocialMessage>, observedMessage: SocialMessage): SocialMessage | undefined {
  return committedMessages.get(`id:${observedMessage.id}`) ?? committedMessages.get(`seq:${observedMessage.seq}`);
}

function findCommittedMessageByIndexes(
  messagesById: Map<string, SocialMessage>,
  messagesBySeq: Map<number, SocialMessage>,
  observedMessage: SocialMessage
): SocialMessage | undefined {
  const byId = messagesById.get(observedMessage.id);
  const bySeq = messagesBySeq.get(observedMessage.seq);
  if (byId && bySeq && byId.id !== bySeq.id) return undefined;
  return byId ?? bySeq;
}

function validateMessageEnvelope(
  message: SocialMessage,
  channelsById: Map<string, SocialChannel>,
  label: string,
  errors: string[]
): void {
  const channel = channelsById.get(message.channelId);
  if (!channel) {
    errors.push(`${label}.channelId references unknown channel ${message.channelId}.`);
    return;
  }
  if (!channel.participantIds.includes(message.senderId) && channel.kind !== "system") {
    errors.push(`${label}.senderId ${message.senderId} is not in channel ${message.channelId}.`);
  }
  for (const recipientId of message.recipientIds) {
    if (!channel.participantIds.includes(recipientId) && channel.readableBy !== "all") {
      errors.push(`${label}.recipientIds includes ${recipientId}, which is not allowed in channel ${message.channelId}.`);
    }
  }
}

function validateSeqRange(
  range: [number, number] | undefined,
  messagesBySeq: Map<number, SocialMessage>,
  label: string,
  errors: string[]
): void {
  if (!range) return;
  if (!isSeqRange(range)) {
    errors.push(`${label} must be a positive integer [start, end] range with start <= end.`);
    return;
  }
  const [start, end] = range;
  for (let seq = start; seq <= end; seq += 1) {
    if (!messagesBySeq.has(seq)) errors.push(`${label} references missing social message seq ${seq}.`);
  }
}

function validateSpeechActs(message: SocialMessage, label: string, errors: string[]): void {
  if (message.speechActs === undefined) return;
  if (!Array.isArray(message.speechActs)) {
    errors.push(`${label}.speechActs must be an array.`);
    return;
  }
  const ids = new Set<string>();
  for (const [index, act] of message.speechActs.entries()) {
    const actLabel = `${label}.speechActs[${index}]`;
    if (!act.id?.trim()) errors.push(`${actLabel}.id is missing.`);
    else if (ids.has(act.id)) errors.push(`${actLabel}.id duplicates ${act.id}.`);
    ids.add(act.id);
    if (!String(act.kind ?? "").trim()) errors.push(`${actLabel}.kind is missing.`);
    if (!Array.isArray(act.evidenceRefs)) errors.push(`${actLabel}.evidenceRefs must be an array.`);
  }
}

function validateDeliveryReceipts(
  message: SocialMessage,
  channelsById: Map<string, SocialChannel>,
  label: string,
  errors: string[]
): void {
  if (message.deliveryReceipts === undefined) return;
  if (!Array.isArray(message.deliveryReceipts)) {
    errors.push(`${label}.deliveryReceipts must be an array.`);
    return;
  }
  const ids = new Set<string>();
  const observers = new Set<string>();
  for (const [index, receipt] of message.deliveryReceipts.entries()) {
    const receiptLabel = `${label}.deliveryReceipts[${index}]`;
    if (!receipt.id?.trim()) errors.push(`${receiptLabel}.id is missing.`);
    else if (ids.has(receipt.id)) errors.push(`${receiptLabel}.id duplicates ${receipt.id}.`);
    ids.add(receipt.id);
    if (receipt.messageId !== message.id) errors.push(`${receiptLabel}.messageId ${receipt.messageId} does not match ${message.id}.`);
    if (receipt.messageSeq !== message.seq) errors.push(`${receiptLabel}.messageSeq ${receipt.messageSeq} does not match ${message.seq}.`);
    if (receipt.channelId !== message.channelId) errors.push(`${receiptLabel}.channelId ${receipt.channelId} does not match ${message.channelId}.`);
    if (receipt.senderId !== message.senderId) errors.push(`${receiptLabel}.senderId ${receipt.senderId} does not match ${message.senderId}.`);
    if (!receipt.observerId?.trim()) errors.push(`${receiptLabel}.observerId is missing.`);
    else if (observers.has(receipt.observerId)) errors.push(`${receiptLabel}.observerId duplicates ${receipt.observerId}.`);
    observers.add(receipt.observerId);
    if (receipt.visibility !== message.visibility) errors.push(`${receiptLabel}.visibility ${receipt.visibility} does not match ${message.visibility}.`);
    if (!receipt.redactionPolicy?.trim()) errors.push(`${receiptLabel}.redactionPolicy is missing.`);
    if (!messageVisibleToObserver(message, receipt.observerId, channelsById)) {
      errors.push(`${receiptLabel}.observerId ${receipt.observerId} cannot see message ${message.id}/${message.seq}.`);
    }
  }
}

function isSeqRange(range: [number, number]): boolean {
  const [start, end] = range;
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start;
}

function messageVisibleToObserver(message: SocialMessage, observerId: string, channelsById: Map<string, SocialChannel>): boolean {
  const channel = channelsById.get(message.channelId);
  if (!channel) return false;
  const canReadChannel = channel.readableBy === "all" || channel.participantIds.includes(observerId);
  if (!canReadChannel) return false;
  if (message.visibility === "public") return true;
  if (message.visibility === "postgame") return false;
  return message.senderId === observerId || message.recipientIds.includes(observerId);
}

function isSocialMessage(value: unknown): value is SocialMessage {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.seq === "number" &&
      typeof record.channelId === "string" &&
      typeof record.senderId === "string" &&
      Array.isArray(record.recipientIds) &&
      typeof record.visibility === "string" &&
      typeof record.createdAt === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
