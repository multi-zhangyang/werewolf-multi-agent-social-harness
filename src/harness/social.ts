export type SocialChannelKind = "public" | "team" | "private" | "system";
export type SocialResolvedSchedulerMode = "aec" | "aec-batched-decision" | "parallel";
export type SocialSchedulerMode = SocialResolvedSchedulerMode | "simultaneous-batch";
export type SocialEpisodeStatus = "completed" | "truncated" | "failed";

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

export interface SocialObservationAssemblyContext<TState = unknown, TObservation = unknown, TPending = unknown> {
  agentId: string;
  pendingAction: TPending;
  environmentObservation: TObservation;
  visibleSocial: {
    channels: SocialChannel[];
    messages: SocialMessage[];
  };
  state: TState;
}

export type SocialObservationAssembler<TState = unknown, TObservation = unknown, TPending = unknown> = (
  context: SocialObservationAssemblyContext<TState, TObservation, TPending>
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

export interface SocialBeforeEnvironmentStepContext<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> {
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
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

export type SocialBeforeEnvironmentStepHook<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> = (
  context: SocialBeforeEnvironmentStepContext<TState, TObservation, TPending, TCommand>
) => void;

export interface SocialDecisionFailureContext<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> {
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
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
  error: unknown;
}

export type SocialDecisionFailureHook<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> = (
  context: SocialDecisionFailureContext<TState, TObservation, TPending, TCommand>
) => void;

export interface SocialEnvironmentStepFailureContext<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> {
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
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

export type SocialEnvironmentStepFailureHook<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> = (
  context: SocialEnvironmentStepFailureContext<TState, TObservation, TPending, TCommand>
) => void;

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
  step(command: TCommand): SocialStepResult<TState, TObservation>;
  done(): boolean;
}

export interface SocialParallelEnvironment<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown>
  extends SocialEnvironment<TState, TObservation, TPending, TCommand> {
  stepBatch(commandsByAgent: Record<string, TCommand>): SocialStepResult<TState, TObservation>;
}

export interface SocialActor<TObservation = unknown, TPending = unknown, TCommand = unknown> {
  readonly id: string;
  readonly profile: SocialAgentProfile;
  observe(observation: TObservation, context?: SocialActorObservationContext<TPending>): void;
  decide(pending: TPending): Promise<SocialAction<TCommand>> | SocialAction<TCommand>;
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
}

export interface SocialEpisodeArtifact<TState = unknown, TObservation = unknown, TPending = unknown, TCommand = unknown> {
  id: string;
  status: SocialEpisodeStatus;
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

  return errors;
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
    for (const message of messages) this.validateMessage(message);
    const records: SocialMessage[] = [];
    for (const message of messages) {
      const seq = (this.messages.at(-1)?.seq ?? 0) + 1;
      const id = `msg-${seq}`;
      const draft = cloneJson(message);
      const record: SocialMessage = {
        ...draft,
        id,
        seq,
        speechActs: normalizeSpeechActs(draft, id, seq),
        deliveryReceipts: deliveryReceiptsForMessage(draft, this.channels.get(draft.channelId), id, seq),
        createdAt: deterministicMessageTimestamp(seq)
      };
      this.messages.push(record);
      records.push(cloneJson(record));
    }
    return records;
  }

  validateMessages(messages: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">>): void {
    for (const message of messages) this.validateMessage(message);
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

export async function runSocialEpisode<TState, TObservation, TPending extends { actorId?: string }, TCommand>(options: {
  id: string;
  environment: SocialEnvironment<TState, TObservation, TPending, TCommand>;
  actors: Array<SocialActor<TObservation, TPending, TCommand>>;
  channels?: SocialChannel[];
  initialMessages?: SocialMessage[];
  schedulerMode?: SocialSchedulerMode;
  maxTransitions?: number;
  hashState?: (state: TState) => string;
  eventSeq?: (state: TState) => number;
	  beforeEnvironmentStep?: SocialBeforeEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
  assembleObservation?: SocialObservationAssembler<TState, TObservation, TPending>;
  systemTransition?: SocialSystemTransitionProvider<TState, TObservation, TPending, TCommand>;
  traceIdForDecision?: SocialTraceIdProvider<TState, TPending>;
	  actorTurnIndexForDecision?: SocialActorTurnIndexProvider<TState, TPending>;
	  schedulerModeForBatch?: SocialSchedulerResolver<TState, TPending>;
	  onDecisionFailure?: SocialDecisionFailureHook<TState, TObservation, TPending, TCommand>;
	  onEnvironmentStepFailure?: SocialEnvironmentStepFailureHook<TState, TObservation, TPending, TCommand>;
		}): Promise<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>> {
  const defaultSchedulerMode = normalizeSchedulerMode(options.schedulerMode ?? "aec");
  const bus = new SocialCommunicationBus(options.channels ?? [], options.initialMessages ?? []);
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
      status: "failed",
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
        beforeEnvironmentStep: options.beforeEnvironmentStep,
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
      const failedPreState = options.environment.snapshot();
      const failedPreStateHash = options.hashState?.(failedPreState);
      const beforeFailureEventSeq = options.eventSeq?.(failedPreState);
      options.onDecisionFailure?.({
        environment: options.environment,
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
        preStateHash: failedPreStateHash,
        error: failedDecision.rawError
      });
      const failedPostState = options.environment.snapshot();
      const afterFailureEventSeq = options.eventSeq?.(failedPostState);
      steps.push(failedDecisionToStep({
        optionsId: options.id,
        turnIndex: failedTurnIndex,
        batchId,
        batchIndex,
        batchSize: pendingBatch.length,
        schedulerMode,
        decisionStateHash,
        preStateHash: failedPreStateHash,
        postStateHash: options.hashState?.(failedPostState),
        eventSeqRange: eventSeqRange(beforeFailureEventSeq, afterFailureEventSeq),
        decision: failedDecision
      }));
      break;
    }
    const successfulDecisions = decisions.filter(isSuccessfulDecision);

    if (schedulerMode === "parallel") {
      if (turnIndex + successfulDecisions.length - 1 > maxTransitions) {
        status = "truncated";
        truncationReason = `maxTransitions ${maxTransitions} reached before parallel batch could be applied`;
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
	        beforeEnvironmentStep: options.beforeEnvironmentStep,
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
      for (const decision of successfulDecisions) {
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
	          beforeEnvironmentStep: options.beforeEnvironmentStep,
	          onEnvironmentStepFailure: options.onEnvironmentStepFailure
	        });
        steps.push(outcome.step);
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
    status,
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
      actorTurnIndex?: number;
      error: string;
      rawError: unknown;
    };

function isSuccessfulDecision<TObservation, TPending, TCommand>(
  decision: SocialDecision<TObservation, TPending, TCommand>
): decision is Extract<SocialDecision<TObservation, TPending, TCommand>, { ok: true }> {
  return decision.ok;
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
  assembleObservation?: SocialObservationAssembler<TState, TObservation, TPending>;
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
      error: error.message,
      rawError: error
    };
  }
  let observation: TObservation | undefined;
  let traceId: string | undefined;
  let actorTurnIndex: number | undefined;
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
    });
    const environmentObservation = input.environment.observe(actorId, input.pending);
    const state = input.environment.snapshot();
    const visibleSocial = input.bus.observe(actorId);
    observation = input.assembleObservation
      ? input.assembleObservation({
          agentId: actorId,
          pendingAction: cloneJson(input.pending),
          environmentObservation,
          visibleSocial,
          state: cloneJson(state)
        })
      : environmentObservation;
    actor.observe(observation, {
      traceId,
      turnIndex: input.turnIndex,
      actorTurnIndex,
      batchId: input.batchId,
      batchIndex: input.batchIndex,
      batchSize: input.batchSize,
      schedulerMode: input.schedulerMode,
      pendingAction: cloneJson(input.pending)
    });
    const action = await actor.decide(input.pending);
    return { ok: true, actor, actorId, pending: input.pending, observation, action, pendingIndex: input.pendingIndex, turnIndex: input.turnIndex };
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
      actorTurnIndex,
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
  beforeEnvironmentStep?: SocialBeforeEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
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
        decisionStateHash: input.hashState?.(preState),
        preStateHash: input.hashState?.(preState),
        error: reason
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
  try {
    input.bus.validateMessages(messages);
    input.beforeEnvironmentStep?.({
      environment: input.environment,
      actorId,
      profileId,
      turnIndex: input.turnIndex,
      batchId,
      batchIndex: 1,
      batchSize: 1,
      schedulerMode: input.schedulerMode,
      atomic: false,
      resolutionPolicy: "system-transition",
      pendingAction: cloneJson(transition.pendingAction),
      observation: cloneJson(transition.observation),
      action: cloneJson(transition.action),
      preState: cloneJson(preState),
      preStateHash,
      decisionStateHash: preStateHash
    });
    const feedback = normalizeStepFeedback(input.environment.step(transition.action.command), input.environment);
    input.bus.publishMany(messages);
    const afterEventSeq = input.eventSeq?.(feedback.state);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;
    return {
      status: "ok",
      feedback,
      step: {
        ...base,
        postStateHash: input.hashState?.(feedback.state),
        eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
        messageSeqRange: afterSeq > beforeSeq ? [beforeSeq + 1, afterSeq] : undefined,
        ...feedbackFields(feedback)
      }
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failureState = input.environment.snapshot();
    const feedback = emptyStepFeedback(failureState, input.environment);
    const afterEventSeq = input.eventSeq?.(failureState);
    return {
      status: "failed",
      reason,
      feedback,
      step: {
        ...base,
        eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
        error: reason
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
	  beforeEnvironmentStep?: SocialBeforeEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
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
  try {
    input.bus.validateMessages(messages);
    const stepBase = baseStep(input);
    const preStateHash = input.hashState?.(preState);
    input.beforeEnvironmentStep?.({
      environment: input.environment,
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
      decisionStateHash: input.decisionStateHash
    });
    const feedback = normalizeStepFeedback(input.environment.step(input.decision.action.command), input.environment);
    input.bus.publishMany(messages);
    const afterEventSeq = input.eventSeq?.(feedback.state);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;
    return {
      status: "ok",
      feedback,
      step: {
        ...stepBase,
        action: cloneJson(input.decision.action),
        preStateHash,
        postStateHash: input.hashState?.(feedback.state),
        eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
        messageSeqRange: afterSeq > beforeSeq ? [beforeSeq + 1, afterSeq] : undefined,
        ...feedbackFields(feedback)
      }
    };
	  } catch (error) {
	    const reason = error instanceof Error ? error.message : String(error);
	    const stepBase = baseStep(input);
	    const preStateHash = input.hashState?.(preState);
	    const failureStateBeforeHook = input.environment.snapshot();
	    input.onEnvironmentStepFailure?.({
	      environment: input.environment,
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
	      failureStateHash: input.hashState?.(failureStateBeforeHook),
	      error
	    });
	    const failureState = input.environment.snapshot();
	    const feedback = emptyStepFeedback(failureState, input.environment);
	    const afterEventSeq = input.eventSeq?.(failureState);
	    return {
      status: "failed",
      reason,
	      feedback,
	      step: {
	        ...stepBase,
	        action: cloneJson(input.decision.action),
	        preStateHash,
	        postStateHash: input.hashState?.(failureState),
	        eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
	        error: reason
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
	  beforeEnvironmentStep?: SocialBeforeEnvironmentStepHook<TState, TObservation, TPending, TCommand>;
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
  try {
    input.bus.validateMessages(messages);
    const preStateHash = input.hashState?.(preState);
    input.decisions.forEach((decision, index) => {
      const stepBase = baseStep({ ...input, decision, turnIndex: input.turnIndex + index });
      input.beforeEnvironmentStep?.({
        environment: input.environment,
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
        decisionStateHash: input.decisionStateHash
      });
    });
    const commandsByAgent = Object.fromEntries(input.decisions.map((decision) => [decision.actorId, decision.action.command]));
    const feedback = normalizeStepFeedback(input.environment.stepBatch(commandsByAgent), input.environment);
    input.bus.publishMany(messages);
    const afterEventSeq = input.eventSeq?.(feedback.state);
    const afterSeq = input.bus.listMessages().at(-1)?.seq ?? beforeSeq;
    return {
      status: "ok",
      feedback,
      steps: input.decisions.map((decision, index) => ({
        ...baseStep({ ...input, decision, turnIndex: input.turnIndex + index }),
        action: cloneJson(decision.action),
        atomic: true,
        resolutionPolicy: "parallel-stepBatch",
        preStateHash,
        postStateHash: input.hashState?.(feedback.state),
        eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
        messageSeqRange: afterSeq > beforeSeq ? [beforeSeq + 1, afterSeq] : undefined,
        ...feedbackFields(feedback)
      }))
    };
	  } catch (error) {
	    const reason = error instanceof Error ? error.message : String(error);
	    const preStateHash = input.hashState?.(preState);
	    const failureStateBeforeHook = input.environment.snapshot();
	    for (const [index, decision] of input.decisions.entries()) {
	      const stepBase = baseStep({ ...input, decision, turnIndex: input.turnIndex + index });
	      input.onEnvironmentStepFailure?.({
	        environment: input.environment,
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
	        failureStateHash: input.hashState?.(failureStateBeforeHook),
	        error
	      });
	    }
	    const failureState = input.environment.snapshot();
	    const feedback = emptyStepFeedback(failureState, input.environment);
	    const afterEventSeq = input.eventSeq?.(failureState);
	    return {
      status: "failed",
      reason,
      feedback,
      steps: input.decisions.map((decision, index) => ({
        ...baseStep({ ...input, decision, turnIndex: input.turnIndex + index }),
	        action: cloneJson(decision.action),
	        atomic: true,
	        resolutionPolicy: "parallel-stepBatch",
	        preStateHash,
	        postStateHash: input.hashState?.(failureState),
	        eventSeqRange: eventSeqRange(beforeEventSeq, afterEventSeq),
	        error: reason
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
    atomic: false,
    resolutionPolicy:
      input.schedulerMode === "parallel"
        ? "parallel-stepBatch"
        : input.schedulerMode === "aec-batched-decision"
          ? "sequential-apply-from-shared-decision-state"
          : "sequential-apply",
    pendingAction: cloneJson(input.decision.pending),
    observation: cloneJson(input.decision.observation as TObservation),
    action: { actorId: input.decision.actorId, kind: "error", command: undefined as TCommand },
    decisionStateHash: input.decisionStateHash,
    preStateHash: input.preStateHash,
    postStateHash: input.postStateHash,
    eventSeqRange: input.eventSeqRange,
    error: input.decision.error
  };
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

function deterministicMessageTimestamp(seq: number): string {
  return new Date(seq * 1000).toISOString();
}

function normalizeSpeechActs(
  message: Omit<SocialMessage, "id" | "seq" | "createdAt">,
  messageId: string,
  messageSeq: number
): SocialSpeechAct[] | undefined {
  const explicitActs = Array.isArray(message.speechActs) ? message.speechActs : [];
  const derivedActs = speechActsFromMetadata(message);
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

function speechActsFromMetadata(message: Omit<SocialMessage, "id" | "seq" | "createdAt">): SocialSpeechAct[] {
  const metadata = asRecord(message.metadata);
  if (!metadata) return [];
  const acts: SocialSpeechAct[] = [];
  const evidenceRefs: SocialEvidenceRef[] = [];
  const kind = stringMetadata(metadata.kind);
  const claimedRole = stringMetadata(metadata.claimedRole);
  if (claimedRole) {
    acts.push({
      id: "",
      kind: "role_claim",
      subjectId: message.senderId,
      value: claimedRole,
      confidence: 1,
      evidenceRefs,
      metadata: { source: "metadata.claimedRole", messageKind: kind }
    });
  }
  const pressureTargetId = stringMetadata(metadata.pressureTargetId);
  if (pressureTargetId) {
    acts.push({
      id: "",
      kind: "accusation",
      subjectId: message.senderId,
      targetId: pressureTargetId,
      value: "pressure_target",
      confidence: 0.8,
      evidenceRefs,
      metadata: { source: "metadata.pressureTargetId", messageKind: kind }
    });
  }
  const targetId = stringMetadata(metadata.targetId);
  if (kind === "public-vote" && targetId) {
    acts.push({
      id: "",
      kind: "vote_intent",
      subjectId: message.senderId,
      targetId,
      value: "vote.cast",
      confidence: 1,
      evidenceRefs,
      metadata: { source: "metadata.targetId", abstain: Boolean(metadata.abstain), messageKind: kind }
    });
  }
  if (kind === "public-hunter-shot" && targetId) {
    acts.push({
      id: "",
      kind: "role_action",
      subjectId: message.senderId,
      targetId,
      value: "hunter.shoot",
      confidence: 1,
      evidenceRefs,
      metadata: { source: "metadata.targetId", messageKind: kind }
    });
  }
  if (kind === "werewolf-kill-vote" && targetId) {
    acts.push({
      id: "",
      kind: "coalition_signal",
      subjectId: message.senderId,
      targetId,
      value: "werewolf.killVote",
      confidence: 1,
      evidenceRefs,
      metadata: { source: "metadata.targetId", messageKind: kind }
    });
  }
  if (kind === "private-seer-inspect" && targetId) {
    acts.push({
      id: "",
      kind: "role_action",
      subjectId: message.senderId,
      targetId,
      value: "seer.inspect",
      confidence: 1,
      evidenceRefs,
      metadata: { source: "metadata.targetId", messageKind: kind }
    });
  }
  if (kind === "private-witch-action") {
    acts.push({
      id: "",
      kind: "role_action",
      subjectId: message.senderId,
      targetId: stringMetadata(metadata.poisonTargetId) ?? stringMetadata(metadata.saveTargetId),
      value: "witch.act",
      confidence: 1,
      evidenceRefs,
      metadata: {
        source: "metadata.kind",
        messageKind: kind,
        hasSave: Boolean(metadata.saveTargetId),
        hasPoison: Boolean(metadata.poisonTargetId)
      }
    });
  }
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
