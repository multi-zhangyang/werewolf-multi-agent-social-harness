import type { GameCommand, GameConfig, GameEvent, GameState, MatchMetrics, WerewolfRulesetId } from "../core/types";
import { isSupportedWerewolfRulesetId } from "../core/roles";
import type { HarnessAssignmentConfig, ResolvedAgentAssignment } from "./profiles";
import { summarizeEvaluationWarnings } from "./evaluation";
import { deriveSocialExposureRecords, isSocialStepCommitted, type SocialEpisodeArtifact, type SocialMessage } from "./social";
import type {
  AdversarialEvaluation,
  AgentHarnessState,
  HarnessAgentProfile,
  HarnessForkProvenance,
  HarnessReasoner,
  HarnessRunOptions,
  HarnessEvaluationReport,
  HarnessRunResult,
  HarnessStepRecord
} from "./types";
import { hashStableState } from "./hash";
import { harnessFailureEvidenceFromEpisode } from "./executionEvidence";
import { werewolfHarnessTurnEvidenceFromEpisode } from "./werewolfExecutionEvidence";
import { replayWerewolfSocialEpisode } from "./replay";
import { redactSecrets } from "./redaction";
import {
  HARNESS_AGENT_SNAPSHOT_FRAME_VERSION,
  compactRecordedSocialAgentSnapshots,
  createGenericForkProvenance,
  harnessAgentSnapshotFrameId,
  validateHarnessCheckpointEnvelope,
  validateHarnessCheckpointReplay,
  validateHarnessEpisodeArtifactEnvelope,
  type HarnessAgentSnapshotFrame,
  type HarnessCheckpointEnvelope,
  type HarnessCheckpointSource,
  type HarnessEpisodeArtifactEnvelope
} from "./episodeArtifacts";

export const MATCH_ARTIFACT_VERSION = "harness.match.v2";
export const HARNESS_CHECKPOINT_VERSION = "harness.checkpoint.v2";
export const AGENT_SNAPSHOT_FRAME_VERSION = HARNESS_AGENT_SNAPSHOT_FRAME_VERSION;

export interface AgentSnapshotFrame extends HarnessAgentSnapshotFrame<AgentHarnessState> {
  artifactVersion: typeof AGENT_SNAPSHOT_FRAME_VERSION;
  kind: "agent-snapshot-frame";
}

/** Werewolf specialization of the domain-neutral social episode envelope. */
export interface MatchArtifact
  extends HarnessEpisodeArtifactEnvelope<
    GameState,
    unknown,
    unknown,
    unknown,
    AgentHarnessState,
    HarnessForkProvenance
  > {
  artifactVersion: typeof MATCH_ARTIFACT_VERSION;
  kind: "match";
  runId: string;
  matchId?: string;
  createdAt: string;
  seed: string;
  /** Domain-owned replay semantic identity, derived only from initial state. */
  rulesetId: WerewolfRulesetId;
  config: GameConfig;
  models: string[];
  profiles: HarnessAgentProfile[];
  assignment?: HarnessAssignmentConfig;
  resolvedAssignments: ResolvedAgentAssignment[];
  status: HarnessRunResult["status"];
  truncationReason?: string;
  failureReason?: string;
  failureStateHash?: string;
  forkOf?: HarnessForkProvenance;
  initialState: GameState;
  finalState: GameState;
  /** Legacy Werewolf committed-command projection retained for checkpoint migration. */
  trajectory: HarnessStepRecord[];
  /** Native generic scheduler/environment/message-bus execution authority. */
  socialEpisode: SocialEpisodeArtifact<GameState, unknown, unknown, unknown>;
  events: GameEvent[];
  evaluation: AdversarialEvaluation;
  evaluationReport: HarnessEvaluationReport;
  metrics: MatchMetrics;
  agents: AgentHarnessState[];
  agentSnapshotFrames?: AgentSnapshotFrame[];
}

export type TrajectoryJsonlStepSource = Omit<
  HarnessStepRecord,
  "pendingAction" | "observation" | "policyPlan" | "reasonerOutput" | "command"
> & {
  pendingAction: unknown;
  observation: unknown;
  policyPlan: unknown;
  reasonerOutput: unknown;
  command: unknown;
};

/**
 * An export view may deliberately omit evaluator truth. JSONL is a rendered
 * artifact surface, not replay authority, so it must model that redaction
 * honestly instead of pretending every source is a canonical match artifact.
 */
export type TrajectoryJsonlEvaluationReportSource = Partial<
  Pick<
    HarnessEvaluationReport,
    "id" | "createdAt" | "evaluatorIds" | "evaluatorRegistry" | "metricCount" | "warnings" | "summary" | "metrics"
  >
>;

/**
 * JSONL export consumes a rendered artifact view and never requires canonical
 * replay authority. Optional identity, evaluation, metric, and trajectory
 * fields allow a server-owned truth-redacted projection to omit sensitive
 * postgame evidence rather than smuggling it back in as a fallback.
 */
export interface TrajectoryJsonlSource {
  artifactVersion?: string;
  kind?: string;
  runId?: string;
  matchId?: string;
  createdAt?: string;
  seed?: string;
  rulesetId?: WerewolfRulesetId;
  models?: unknown;
  profiles?: unknown;
  assignment?: unknown;
  resolvedAssignments?: unknown;
  status?: unknown;
  truncationReason?: string;
  failureReason?: string;
  failureStateHash?: string;
  forkOf?: unknown;
  metrics?: unknown;
  evaluationReport?: TrajectoryJsonlEvaluationReportSource;
  socialEpisode: Pick<SocialEpisodeArtifact, "id" | "channels" | "steps" | "messages" | "exposureRecords">;
  trajectory?: readonly TrajectoryJsonlStepSource[];
  events?: readonly GameEvent[];
  agents?: readonly AgentHarnessState[];
  agentSnapshotFrames?: readonly Pick<AgentSnapshotFrame, "frameId" | "agentsHash" | "agents">[];
}

export interface WerewolfHarnessCheckpointSource extends HarnessCheckpointSource {
  sourceArtifactVersion: typeof MATCH_ARTIFACT_VERSION;
  matchId?: string;
  seed: string;
  /** Explicit domain semantic binding; never inferred from an artifact version. */
  rulesetId: WerewolfRulesetId;
  status: HarnessRunResult["status"];
}

/** Werewolf specialization of the generic checkpoint envelope. */
export interface HarnessCheckpoint
  extends HarnessCheckpointEnvelope<
    GameState,
    AgentHarnessState,
    unknown,
    unknown,
    GameCommand,
    WerewolfHarnessCheckpointSource
  > {
  artifactVersion: typeof HARNESS_CHECKPOINT_VERSION;
  kind: "checkpoint";
  executionPrefix: SocialEpisodeArtifact<GameState, unknown, unknown, GameCommand>;
}

export interface HarnessCheckpointPrefixSelector {
  traceId?: string;
  nativeTurnIndex?: number;
  nativeStepCount?: number;
}

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
  const trajectory = cloneJson(options.result.trajectory);
  const socialEpisode = cloneJson(options.result.socialEpisode);
  const agentSnapshotFrames = extractAgentSnapshotFrames({
    trajectory,
    socialEpisode
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
    trajectory,
    socialEpisode,
    events: cloneJson(options.result.state.events),
    evaluation: cloneJson(options.result.evaluation),
    evaluationReport: cloneJson(options.result.evaluationReport),
    metrics: cloneJson(options.result.metrics),
    agents: cloneJson(options.result.agents),
    agentSnapshotFrames: agentSnapshotFrames.length ? agentSnapshotFrames : undefined
  };
  const redacted = redactSecrets(artifact);
  normalizeAgentSnapshotFramesAfterRedaction(redacted);
  return redacted;
}

export function resolveAgentSnapshotsAfterStep(artifact: MatchArtifact, step: HarnessStepRecord): AgentHarnessState[] | undefined {
  if (step.agentSnapshotsAfterStep) return cloneJson(step.agentSnapshotsAfterStep);
  const frame = findAgentSnapshotFrame(artifact, step);
  return frame ? cloneJson(frame.agents) : undefined;
}

function extractAgentSnapshotFrames(options: {
  trajectory: HarnessStepRecord[];
  socialEpisode: SocialEpisodeArtifact;
}): AgentSnapshotFrame[] {
  const framesById = new Map<string, AgentSnapshotFrame>();
  const frameFor = (agents: AgentHarnessState[], providedHash: string): AgentSnapshotFrame => {
    const agentsHash = hashStableState(agents);
    if (agentsHash !== providedHash) {
      throw new Error(`Agent snapshot hash mismatch: expected ${agentsHash}, received ${providedHash}.`);
    }
    const frameId = harnessAgentSnapshotFrameId(agentsHash);
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

  for (const step of options.trajectory) {
    if (!step.agentSnapshotsAfterStep || !step.agentSnapshotsHashAfterStep) continue;
    const frame = frameFor(step.agentSnapshotsAfterStep, step.agentSnapshotsHashAfterStep);
    step.agentSnapshotFrameIdAfterStep = frame.frameId;
    delete step.agentSnapshotsAfterStep;
  }

  const compacted = compactRecordedSocialAgentSnapshots({
    episode: options.socialEpisode,
    existingFrames: [...framesById.values()]
  });
  Object.assign(options.socialEpisode, compacted.episode);
  return compacted.frames
    .map(
      (frame): AgentSnapshotFrame => ({
        artifactVersion: AGENT_SNAPSHOT_FRAME_VERSION,
        kind: "agent-snapshot-frame",
        frameId: frame.frameId,
        agentsHash: frame.agentsHash,
        agents: cloneJson(frame.agents)
      })
    )
    .sort((left, right) => left.frameId.localeCompare(right.frameId));
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

export function toTrajectoryJsonl(artifact: TrajectoryJsonlSource): string {
  const evaluationReport = artifact.evaluationReport;
  const evaluationWarnings = evaluationReport?.warnings ?? [];
  const evaluationMetrics = evaluationReport?.metrics ?? [];
  const hasExportIdentity = artifact.runId !== undefined || artifact.matchId !== undefined || artifact.seed !== undefined;
  const lines: unknown[] = [
    {
      type: "header",
      artifactVersion: artifact.artifactVersion,
      kind: artifact.kind,
      runId: artifact.runId,
      matchId: artifact.matchId,
      createdAt: artifact.createdAt,
      seed: artifact.seed,
      rulesetId: artifact.rulesetId,
      models: artifact.models,
      profiles: artifact.profiles,
      assignment: artifact.assignment,
      resolvedAssignments: artifact.resolvedAssignments,
      status: artifact.status,
      truncationReason: artifact.truncationReason ?? null,
      failureReason: artifact.failureReason ?? null,
      failureStateHash: artifact.failureStateHash ?? null,
      ...(artifact.forkOf === undefined ? (hasExportIdentity ? { forkOf: null } : {}) : { forkOf: artifact.forkOf })
    },
    {
      type: "match_metrics",
      runId: artifact.runId,
      matchId: artifact.matchId,
      metrics: artifact.metrics
    },
    {
      type: "evaluation_report",
      runId: artifact.runId,
      matchId: artifact.matchId,
      id: evaluationReport?.id ?? null,
      createdAt: evaluationReport?.createdAt ?? null,
      evaluatorIds: evaluationReport?.evaluatorIds ?? [],
      evaluatorRegistry: evaluationReport?.evaluatorRegistry ?? [],
      metricCount: evaluationReport?.metricCount ?? null,
      warnings: evaluationWarnings,
      warningSummary: summarizeEvaluationWarnings(evaluationWarnings),
      summary: evaluationReport?.summary ?? null
    },
    ...artifact.socialEpisode.channels.map((channel) => ({
      type: "channel",
      ...channel
    })),
    ...artifact.socialEpisode.steps.map((step) => ({
      type: "social_step",
      runId: artifact.runId,
      matchId: artifact.matchId ?? null,
      episodeId: artifact.socialEpisode.id,
      traceId: step.traceId,
      turnIndex: step.turnIndex,
      batchId: step.batchId ?? null,
      batchIndex: step.batchIndex ?? null,
      batchSize: step.batchSize ?? null,
      actorId: step.actorId,
      profileId: step.profileId,
      schedulerMode: step.schedulerMode,
      atomic: step.atomic ?? false,
      resolutionPolicy: step.resolutionPolicy ?? null,
      pendingAction: step.pendingAction,
      observation: step.observation,
      action: step.action,
      commitStatus: step.commitStatus ?? (step.error ? "rejected" : "committed"),
      decisionStateHash: step.decisionStateHash ?? null,
      preStateHash: step.preStateHash ?? null,
      postStateHash: step.postStateHash ?? null,
      actorSnapshotsHashAfterStep: step.actorSnapshotsHashAfterStep ?? null,
      actorSnapshotFrameIdAfterStep: step.actorSnapshotFrameIdAfterStep ?? null,
      eventSeqRange: step.eventSeqRange ?? null,
      messageSeqRange: step.messageSeqRange ?? null,
      rewardsByAgent: step.rewardsByAgent ?? null,
      terminationsByAgent: step.terminationsByAgent ?? null,
      truncationsByAgent: step.truncationsByAgent ?? null,
      doneByAgent: step.doneByAgent ?? null,
      ...(step.infosByAgent === undefined ? {} : { infosByAgent: step.infosByAgent }),
      episodeTerminated: step.episodeTerminated ?? null,
      episodeTruncated: step.episodeTruncated ?? null,
      terminationReason: step.terminationReason ?? null,
      truncationReason: step.truncationReason ?? null,
      error: step.error ?? null,
      failure: step.failure ?? null
    })),
    ...(artifact.trajectory ?? []).map((step) => ({
      type: "step",
      traceId: step.traceId,
      turnIndex: step.turnIndex,
      actorId: step.actorId,
      profileId: step.profileId,
      model: step.model,
      pendingAction: step.pendingAction,
      command: step.command,
      agentStateHash: step.agentStateHash,
      agentSnapshotsHashAfterStep: step.agentSnapshotsHashAfterStep ?? null,
      agentSnapshotFrameIdAfterStep: step.agentSnapshotFrameIdAfterStep ?? null,
      decisionStateHash: step.decisionStateHash,
      preStateHash: step.preStateHash,
      postStateHash: step.postStateHash,
      eventSeqRange: step.eventSeqRange,
      messageSeqRange: step.messageSeqRange,
      observation: step.observation,
      policyPlan: step.policyPlan,
      reasonerOutput: step.reasonerOutput
    })),
    ...werewolfHarnessTurnEvidenceFromEpisode(artifact.socialEpisode).map(({ step, trace }) => ({
      type: "trace",
      traceId: trace.traceId,
      turnIndex: step.turnIndex,
      actorId: step.actorId,
      profileId: trace.profileId,
      model: trace.model,
      actionKind: trace.actionKind,
      commandType: trace.commandType,
      policyPlan: (step.action.metadata as Record<string, unknown> | undefined)?.policyPlan ?? null,
      reasonerOutput: (step.action.metadata as Record<string, unknown> | undefined)?.reasonerOutput ?? null,
      turnTrace: trace,
      agentStateHash: trace.agentStateHash,
      agentSnapshotsHashAfterStep: step.actorSnapshotsHashAfterStep ?? null,
      agentSnapshotFrameIdAfterStep: step.actorSnapshotFrameIdAfterStep ?? null,
      decisionStateHash: step.decisionStateHash,
      preStateHash: step.preStateHash,
      postStateHash: step.postStateHash,
      eventSeqRange: step.eventSeqRange,
      messageSeqRange: step.messageSeqRange
    })),
    ...artifact.socialEpisode.messages.map((message: SocialMessage) => ({
      type: "message",
      ...message
    })),
    ...artifact.socialEpisode.messages.flatMap((message: SocialMessage) =>
      (message.speechActs ?? []).map((act, index) => ({
        type: "social_speech_act",
        runId: artifact.runId,
        matchId: artifact.matchId ?? null,
        messageId: message.id,
        messageSeq: message.seq,
        channelId: message.channelId,
        senderId: message.senderId,
        visibility: message.visibility,
        speechActIndex: index,
        speechActId: act.id,
        kind: act.kind,
        subjectId: act.subjectId ?? null,
        targetId: act.targetId ?? null,
        value: act.value ?? null,
        confidence: act.confidence ?? null,
        evidenceRefs: act.evidenceRefs,
        metadata: act.metadata ?? null
      }))
    ),
    ...artifact.socialEpisode.messages.flatMap((message: SocialMessage) =>
      (message.deliveryReceipts ?? []).map((receipt) => ({
        type: "social_delivery_receipt",
        runId: artifact.runId,
        matchId: artifact.matchId ?? null,
        messageId: message.id,
        messageSeq: message.seq,
        receiptId: receipt.id,
        channelId: receipt.channelId,
        senderId: receipt.senderId,
        observerId: receipt.observerId,
        visibility: receipt.visibility,
        deliveredAtTurn: receipt.deliveredAtTurn ?? null,
        observationTraceId: receipt.observationTraceId ?? null,
        redactionPolicy: receipt.redactionPolicy
      }))
    ),
    ...(artifact.socialEpisode.exposureRecords ?? deriveSocialExposureRecords(artifact.socialEpisode)).map((exposure) => ({
      type: "social_exposure",
      runId: artifact.runId,
      matchId: artifact.matchId,
      ...exposure
    })),
    ...(artifact.events ?? []).map((event) => ({
      ...event,
      type: "event",
      eventType: event.type
    })),
    ...harnessFailureEvidenceFromEpisode(artifact.socialEpisode)
      .map(({ step, failure, payload }) => ({
        type: "error",
        traceId: step.traceId,
        turnIndex: step.turnIndex,
        actorId: step.actorId,
        failureStage: failure.stage,
        failureReason: failure.message,
        payload: payload ?? failure.metadata ?? null
      })),
    ...(artifact.agents ?? []).map((agent) => ({
      type: "agent_state",
      runId: artifact.runId,
      matchId: artifact.matchId,
      playerId: agent.playerId,
      profileId: agent.profileId,
      model: agent.model,
      temperature: agent.temperature,
      policyName: agent.policyName,
      turns: agent.turns,
      observations: agent.observations,
      socialStateHash: agent.socialStateHash ?? null,
      social: agent.social ?? null
    })),
    ...(artifact.agentSnapshotFrames ?? []).map((frame) => ({
      type: "agent_snapshot_frame",
      runId: artifact.runId,
      matchId: artifact.matchId,
      frameId: frame.frameId,
      agentsHash: frame.agentsHash,
      agentCount: frame.agents.length
    })),
    ...(artifact.agents ?? []).flatMap((agent) =>
      (agent.social?.journal?.entries ?? []).map((entry) => ({
        type: "social_state_mutation",
        runId: artifact.runId,
        matchId: artifact.matchId,
        playerId: agent.playerId,
        agentId: entry.agentId,
        profileId: entry.profileId ?? agent.profileId,
        model: agent.model,
        policyName: agent.policyName,
        socialStateHash: agent.socialStateHash ?? null,
        journalSeq: entry.journalSeq,
        seq: entry.journalSeq,
        traceId: entry.traceId ?? null,
        turnIndex: entry.turnIndex ?? null,
        phase: entry.phase ?? null,
        day: entry.day ?? null,
        store: entry.store,
        mutationKind: entry.mutationKind,
        subjectId: entry.subjectId ?? null,
        beforeSummary: entry.beforeSummary ?? null,
        afterSummary: entry.afterSummary ?? null,
        deltaSummary: entry.deltaSummary ?? null,
        evidenceRefs: entry.evidenceRefs,
        messageSeqRange: entry.messageSeqRange ?? null,
        eventSeqRange: entry.eventSeqRange ?? null,
        redactionClass: entry.redactionClass,
        hiddenTruthUsed: entry.hiddenTruthUsed,
        createdAt: entry.createdAt,
        metadata: entry.metadata ?? null
      }))
    ),
    ...evaluationMetrics.map((metric) => ({
      type: "metric",
      evaluationReportId: evaluationReport?.id ?? null,
      ...metric
    }))
  ];
  return `${lines.map((line) => JSON.stringify(redactSecrets(line))).join("\n")}\n`;
}

export function validateMatchArtifactIntegrity(artifact: MatchArtifact): string[] {
  const errors = validateHarnessEpisodeArtifactEnvelope(artifact);
  if (artifact.artifactVersion !== MATCH_ARTIFACT_VERSION) errors.push(`artifactVersion must be ${MATCH_ARTIFACT_VERSION}.`);
  if (artifact.kind !== "match") errors.push("kind must be match.");
  if (artifact.forkOf) {
    if (artifact.forkOf.checkpointArtifactVersion !== HARNESS_CHECKPOINT_VERSION) {
      errors.push(`forkOf.checkpointArtifactVersion must be ${HARNESS_CHECKPOINT_VERSION}.`);
    }
  }
  const errorsBeforeRulesetBinding = errors.length;
  validateMatchArtifactRulesetBinding(artifact, errors);
  const rulesetBindingInvalid = errors.length > errorsBeforeRulesetBinding;

  const finalEvents = artifact.finalState.events ?? [];
  if (artifact.events.length !== finalEvents.length) {
    errors.push(`events length mismatch: expected ${finalEvents.length}, received ${artifact.events.length}.`);
  }
  const eventSeqs = new Set<number>();
  for (const [index, event] of artifact.events.entries()) {
    eventSeqs.add(event.seq);
    const finalEvent = finalEvents[index];
    if (!finalEvent) continue;
    if (event.seq !== finalEvent.seq || event.type !== finalEvent.type || event.id !== finalEvent.id) {
      errors.push(`events[${index}] does not match finalState.events[${index}].`);
    }
  }

  validateNativeSocialExecution(artifact, errors, { replay: !rulesetBindingInvalid });

  const socialStepByTrace = new Map(artifact.socialEpisode.steps.map((step) => [step.traceId, step]));
  const messageSeqs = new Set(artifact.socialEpisode.messages.map((message) => message.seq));
  const playerIds = new Set(artifact.finalState.players.map((player) => player.id));
  validateAgentSnapshotFrames(artifact, playerIds, errors);
  const hasStepAgentSnapshots = artifact.trajectory.some(
    (step) =>
      step.agentSnapshotsAfterStep !== undefined ||
      step.agentSnapshotsHashAfterStep !== undefined ||
      step.agentSnapshotFrameIdAfterStep !== undefined
  ) || Boolean(artifact.agentSnapshotFrames?.length);
  for (const [index, step] of artifact.trajectory.entries()) {
    validateEventSeqRange(step.eventSeqRange, eventSeqs, `trajectory[${index}].eventSeqRange`, errors);
    validateMessageSeqRange(step.messageSeqRange, messageSeqs, `trajectory[${index}].messageSeqRange`, errors);
    validateAgentSnapshotFrameReference({
      frames: artifact.agentSnapshotFrames ?? [],
      frameId: step.agentSnapshotFrameIdAfterStep,
      snapshotHash: step.agentSnapshotsHashAfterStep,
      label: `trajectory[${index}]`,
      fieldName: "agentSnapshotFrameIdAfterStep",
      hashFieldName: "agentSnapshotsHashAfterStep",
      errors
    });
    const snapshots = resolveAgentSnapshotsAfterStep(artifact, step);
    validateStepAgentSnapshots({
      snapshots,
      snapshotHash: step.agentSnapshotsHashAfterStep,
      playerIds,
      actorId: step.actorId,
      agentStateHash: step.agentStateHash,
      label: `trajectory[${index}]`,
      required: hasStepAgentSnapshots,
      errors
    });
    const socialStep = socialStepByTrace.get(step.traceId);
    if (!socialStep) {
      errors.push(`trajectory[${index}] traceId ${step.traceId} has no matching socialEpisode step.`);
      continue;
    }
    if (socialStep.actorId !== step.actorId) errors.push(`trajectory[${index}] actorId mismatch with socialEpisode step ${step.traceId}.`);
    if (socialStep.commitStatus && socialStep.commitStatus !== "committed") {
      errors.push(`trajectory[${index}] references non-committed socialEpisode step ${step.traceId}.`);
    }
    if (socialStep.preStateHash !== step.preStateHash) errors.push(`trajectory[${index}] preStateHash mismatch with socialEpisode step ${step.traceId}.`);
    if (socialStep.postStateHash !== step.postStateHash) errors.push(`trajectory[${index}] postStateHash mismatch with socialEpisode step ${step.traceId}.`);
    if (!sameRange(socialStep.eventSeqRange, step.eventSeqRange)) {
      errors.push(`trajectory[${index}] eventSeqRange mismatch with socialEpisode step ${step.traceId}.`);
    }
    if (!sameRange(socialStep.messageSeqRange, step.messageSeqRange)) {
      errors.push(`trajectory[${index}] messageSeqRange mismatch with socialEpisode step ${step.traceId}.`);
    }
    if ((socialStep.actorSnapshotsHashAfterStep ?? undefined) !== (step.agentSnapshotsHashAfterStep ?? undefined)) {
      errors.push(`trajectory[${index}] agentSnapshotsHashAfterStep mismatch with socialEpisode step ${step.traceId}.`);
    }
    if ((socialStep.actorSnapshotFrameIdAfterStep ?? undefined) !== (step.agentSnapshotFrameIdAfterStep ?? undefined)) {
      errors.push(`trajectory[${index}] agentSnapshotFrameIdAfterStep mismatch with socialEpisode step ${step.traceId}.`);
    }
    validateAgentSnapshotFrameReference({
      frames: artifact.agentSnapshotFrames ?? [],
      frameId: socialStep.actorSnapshotFrameIdAfterStep,
      snapshotHash: socialStep.actorSnapshotsHashAfterStep,
      label: `socialEpisode step ${step.traceId}`,
      fieldName: "actorSnapshotFrameIdAfterStep",
      hashFieldName: "actorSnapshotsHashAfterStep",
      errors
    });
    const socialCommandType = commandTypeFromUnknown(socialStep.action.command);
    if (socialCommandType && socialCommandType !== step.command.type) {
      errors.push(`trajectory[${index}] command type mismatch with socialEpisode step ${step.traceId}: ${socialCommandType} !== ${step.command.type}.`);
    }
  }
  const lastSuccessfulStep = artifact.trajectory.at(-1);
  const lastSuccessfulSnapshot = lastSuccessfulStep ? resolveAgentSnapshotsAfterStep(artifact, lastSuccessfulStep) : undefined;
  if (artifact.status !== "failed" && lastSuccessfulSnapshot) {
    const finalAgentsHash = hashStableState(artifact.agents);
    const lastSnapshotHash = hashStableState(lastSuccessfulSnapshot);
    if (lastSnapshotHash !== finalAgentsHash) {
      errors.push(`Last trajectory agentSnapshotsAfterStep does not match final artifact agents.`);
    }
  }

  const seenAgentIds = new Set<string>();
  const traceIds = new Set([
    ...artifact.trajectory.map((step) => step.traceId),
    ...artifact.socialEpisode.steps.map((step) => step.traceId)
  ]);
  for (const [index, agent] of artifact.agents.entries()) {
    if (seenAgentIds.has(agent.playerId)) errors.push(`agents[${index}] duplicates playerId ${agent.playerId}.`);
    seenAgentIds.add(agent.playerId);
    if (!playerIds.has(agent.playerId)) errors.push(`agents[${index}] references unknown player ${agent.playerId}.`);

    for (const entry of agent.social?.journal?.entries ?? []) {
      if (entry.agentId !== agent.playerId) {
        errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} agentId mismatch: ${entry.agentId} !== ${agent.playerId}.`);
      }
      const evidenceRefs = Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs : [];
      if (!Array.isArray(entry.evidenceRefs)) {
        errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} evidenceRefs must be an array.`);
      }
      if (!evidenceRefs.length) errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} is missing evidenceRefs.`);
      if (entry.redactionClass !== "agent_private_summary") {
        errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} has invalid redactionClass ${entry.redactionClass}.`);
      }
      if (entry.hiddenTruthUsed) errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} uses hidden truth.`);
      validateMutationRange(entry.messageSeqRange, messageSeqs, `agents[${index}].social.journal entry ${entry.journalSeq}.messageSeqRange`, errors);
      validateMutationRange(entry.eventSeqRange, eventSeqs, `agents[${index}].social.journal entry ${entry.journalSeq}.eventSeqRange`, errors);
      for (const evidenceRef of evidenceRefs) {
        if (evidenceRef.artifact === "message" && evidenceRef.seq !== undefined && !messageSeqs.has(evidenceRef.seq)) {
          errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} evidence references missing message seq ${evidenceRef.seq}.`);
        }
        if (evidenceRef.artifact === "event" && evidenceRef.seq !== undefined && !eventSeqs.has(evidenceRef.seq)) {
          errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} evidence references missing event seq ${evidenceRef.seq}.`);
        }
        if (
          evidenceRef.artifact === "trace" &&
          evidenceRef.traceId &&
          !traceIds.has(evidenceRef.traceId) &&
          !isForkParentTraceRef(artifact, evidenceRef.traceId)
        ) {
          errors.push(`agents[${index}].social.journal entry ${entry.journalSeq} evidence references missing trace ${evidenceRef.traceId}.`);
        }
      }
    }
  }
  for (const playerId of playerIds) {
    if (!seenAgentIds.has(playerId)) errors.push(`Missing agent state for player ${playerId}.`);
  }

  if (artifact.evaluationReport.metricCount !== artifact.evaluationReport.metrics.length) {
    errors.push(
      `evaluationReport.metricCount mismatch: expected ${artifact.evaluationReport.metrics.length}, received ${artifact.evaluationReport.metricCount}.`
    );
  }
  validateEvaluationPromotionIntegrity(artifact.evaluationReport, errors);

  return errors;
}

function validateEvaluationPromotionIntegrity(report: HarnessEvaluationReport, errors: string[]): void {
  const promotion = report.summary?.promotion;
  const recordedDecisionCount = report.metrics.filter((metric) => Boolean(metric.promotionDecision)).length;
  const usesRecordedDecisionContract = promotion?.decisionStorage === "per_metric_recorded";
  if (!usesRecordedDecisionContract && !recordedDecisionCount) return;
  const identityFields = [
    "policyId",
    "policyVersion",
    "policyHash",
    "catalogId",
    "catalogVersion",
    "catalogHash",
    "catalogDomainId"
  ] as const;

  for (const field of identityFields) {
    if (typeof promotion?.[field] !== "string" || !promotion[field]) {
      errors.push(`evaluationReport.summary.promotion.${field} is required for recorded metric decisions.`);
    }
  }

  for (const [index, metric] of report.metrics.entries()) {
    const decision = metric.promotionDecision;
    if (!decision) {
      errors.push(`evaluationReport.metrics[${index}] is missing promotionDecision for recorded catalog ${promotion?.catalogId ?? "unknown"}.`);
      continue;
    }

    if (decision.resolution !== "recorded") {
      errors.push(`evaluationReport.metrics[${index}].promotionDecision.resolution must be recorded.`);
    }
    if (
      decision.promotionClass !== "scorecard" &&
      decision.promotionClass !== "diagnostic" &&
      decision.promotionClass !== "benchmark_only"
    ) {
      errors.push(`evaluationReport.metrics[${index}].promotionDecision has invalid promotionClass ${String(decision.promotionClass)}.`);
    }
    if (typeof decision.eligibleForScorecard !== "boolean") {
      errors.push(`evaluationReport.metrics[${index}].promotionDecision.eligibleForScorecard must be boolean.`);
    }
    if (
      !Array.isArray(decision.reasons) ||
      !decision.reasons.length ||
      decision.reasons.some((reason) => typeof reason !== "string" || !reason)
    ) {
      errors.push(`evaluationReport.metrics[${index}].promotionDecision.reasons must be a nonempty string array.`);
    }
    if (metric.promotionClass !== decision.promotionClass) {
      errors.push(
        `evaluationReport.metrics[${index}].promotionClass must match promotionDecision.promotionClass: ${String(metric.promotionClass)} !== ${decision.promotionClass}.`
      );
    }
    if (decision.eligibleForScorecard) {
      if (decision.promotionClass !== "scorecard") {
        errors.push(`evaluationReport.metrics[${index}].promotionDecision can only be scorecard-eligible with scorecard class.`);
      }
      if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
        errors.push(`evaluationReport.metrics[${index}] scorecard-eligible decision requires a finite numeric value.`);
      }
      if (typeof metric.weight !== "number" || !Number.isFinite(metric.weight) || metric.weight <= 0) {
        errors.push(`evaluationReport.metrics[${index}] scorecard-eligible decision requires a positive finite weight.`);
      }
      if (!(metric.evidenceRefs?.length ?? 0)) {
        errors.push(`evaluationReport.metrics[${index}] scorecard-eligible decision requires evidenceRefs.`);
      }
    }

    for (const field of identityFields) {
      const expected = promotion?.[field];
      if (typeof expected !== "string" || !expected) {
        errors.push(`evaluationReport.summary.promotion.${field} is required to validate recorded metric decision ${index}.`);
        continue;
      }
      if (decision[field] !== expected) {
        errors.push(
          `evaluationReport.metrics[${index}].promotionDecision.${field} mismatch: expected ${expected}, received ${String(decision[field])}.`
        );
      }
    }
  }

  if (!promotion) return;
  const decisions = report.metrics.flatMap((metric) => (metric.promotionDecision ? [{ metric, decision: metric.promotionDecision }] : []));
  const scorecardMetricCount = decisions.filter(({ decision }) => decision.eligibleForScorecard).length;
  const diagnosticMetricCount = decisions.filter(({ decision }) => !decision.eligibleForScorecard).length;
  const weightedMetrics = report.metrics.filter(
    (metric) => typeof metric.weight === "number" && Number.isFinite(metric.weight) && metric.weight > 0
  );
  const excludedWeighted = decisions.filter(
    ({ metric, decision }) =>
      typeof metric.weight === "number" && Number.isFinite(metric.weight) && metric.weight > 0 && !decision.eligibleForScorecard
  );
  const excludedWeightedMetricIds = [...new Set(excludedWeighted.map(({ metric }) => metric.id))].sort();
  if (promotion.scorecardMetricCount !== scorecardMetricCount) {
    errors.push(
      `evaluationReport.summary.promotion.scorecardMetricCount mismatch: expected ${scorecardMetricCount}, received ${promotion.scorecardMetricCount}.`
    );
  }
  if (promotion.diagnosticMetricCount !== diagnosticMetricCount) {
    errors.push(
      `evaluationReport.summary.promotion.diagnosticMetricCount mismatch: expected ${diagnosticMetricCount}, received ${promotion.diagnosticMetricCount}.`
    );
  }
  if (promotion.weightedMetricCount !== weightedMetrics.length) {
    errors.push(
      `evaluationReport.summary.promotion.weightedMetricCount mismatch: expected ${weightedMetrics.length}, received ${promotion.weightedMetricCount}.`
    );
  }
  if (promotion.excludedWeightedMetricCount !== excludedWeighted.length) {
    errors.push(
      `evaluationReport.summary.promotion.excludedWeightedMetricCount mismatch: expected ${excludedWeighted.length}, received ${promotion.excludedWeightedMetricCount}.`
    );
  }
  if (
    promotion.excludedWeightedMetricIds.length !== excludedWeightedMetricIds.length ||
    promotion.excludedWeightedMetricIds.some((metricId, index) => metricId !== excludedWeightedMetricIds[index])
  ) {
    errors.push("evaluationReport.summary.promotion.excludedWeightedMetricIds must match the sorted unique excluded weighted metric ids.");
  }
}

function validateNativeSocialExecution(artifact: MatchArtifact, errors: string[], options: { replay?: boolean } = {}): void {
  const execution = artifact.socialEpisode;
  if (!execution.execution) {
    errors.push("socialEpisode.execution metadata is required for harness.match.v2.");
  } else {
    if (execution.execution.schemaVersion !== "harness.social-execution.v1") {
      errors.push(`socialEpisode.execution.schemaVersion must be harness.social-execution.v1.`);
    }
    const initialMessageCount = execution.execution.initialMessageCount;
    if (!Number.isInteger(initialMessageCount) || initialMessageCount < 0 || initialMessageCount > execution.messages.length) {
      errors.push(`socialEpisode.execution.initialMessageCount is invalid: ${initialMessageCount}.`);
    } else {
      const initialMessages = execution.messages.slice(0, initialMessageCount);
      const expectedInitialMessagesHash = hashStableState(initialMessages);
      if (!execution.execution.initialMessagesHash) {
        errors.push("socialEpisode.execution.initialMessagesHash is required.");
      } else if (execution.execution.initialMessagesHash !== expectedInitialMessagesHash) {
        errors.push(
          `socialEpisode.execution.initialMessagesHash mismatch: expected ${expectedInitialMessagesHash}, received ${execution.execution.initialMessagesHash}.`
        );
      }
      if (artifact.forkOf?.parentMessagesHash && execution.execution.initialMessagesHash !== artifact.forkOf.parentMessagesHash) {
        errors.push("socialEpisode initial message prefix does not match forkOf.parentMessagesHash.");
      }
      if (artifact.forkOf && initialMessageCount !== artifact.forkOf.parentMessageCount) {
        errors.push("socialEpisode initial message count does not match forkOf.parentMessageCount.");
      }
    }
  }

  if (artifact.forkOf?.parentChannelsHash && hashStableState(execution.channels) !== artifact.forkOf.parentChannelsHash) {
    errors.push("socialEpisode channels do not match forkOf.parentChannelsHash.");
  }
  if (artifact.forkOf?.parentStateHash && hashStableState(execution.initialState) !== artifact.forkOf.parentStateHash) {
    errors.push("socialEpisode initial state does not match forkOf.parentStateHash.");
  }

  if (hashStableState(execution.initialState) !== hashStableState(artifact.initialState)) {
    errors.push("socialEpisode.initialState does not match artifact.initialState.");
  }
  if (hashStableState(execution.finalState) !== hashStableState(artifact.finalState)) {
    errors.push("socialEpisode.finalState does not match artifact.finalState.");
  }

  for (const [index, step] of execution.steps.entries()) {
    const committed = isSocialStepCommitted(step);
    if (committed && (!step.preStateHash || !step.postStateHash)) {
      errors.push(`socialEpisode.steps[${index}] committed step requires preStateHash and postStateHash.`);
    }
    if (!committed && step.messageSeqRange) {
      errors.push(`socialEpisode.steps[${index}] rejected step cannot reference committed messages.`);
    }
    validateAgentSnapshotFrameReference({
      frames: artifact.agentSnapshotFrames ?? [],
      frameId: step.actorSnapshotFrameIdAfterStep,
      snapshotHash: step.actorSnapshotsHashAfterStep,
      label: `socialEpisode.steps[${index}]`,
      fieldName: "actorSnapshotFrameIdAfterStep",
      hashFieldName: "actorSnapshotsHashAfterStep",
      errors
    });
  }

  if (options.replay !== false) {
    const replay = replayWerewolfSocialEpisode(execution as SocialEpisodeArtifact<GameState, unknown, unknown, GameCommand>, {
      stopOnMismatch: false,
      agentSnapshotFrames: artifact.agentSnapshotFrames
    });
    for (const mismatch of replay.mismatches) errors.push(`socialEpisode replay: ${mismatch}`);
  }
}

export function assertValidMatchArtifactIntegrity(artifact: MatchArtifact): void {
  const errors = validateMatchArtifactIntegrity(artifact);
  if (errors.length) throw new Error(`Invalid match artifact ${artifact.runId}: ${errors.join(" ")}`);
}

export function buildFinalHarnessCheckpoint(options: {
  artifact: MatchArtifact;
  checkpointId?: string;
  createdAt?: string;
  reason?: string;
}): HarnessCheckpoint {
  assertValidMatchArtifactIntegrity(options.artifact);
  const executionPrefix = cloneJson(options.artifact.socialEpisode) as HarnessCheckpoint["executionPrefix"];
  delete executionPrefix.exposureRecords;
  delete executionPrefix.exposureSummary;
  const finalAgentsHash = hashStableState(options.artifact.agents);
  const finalAgentSnapshotFrameId = options.artifact.agentSnapshotFrames?.find((frame) => frame.agentsHash === finalAgentsHash)?.frameId;
  const checkpoint = buildNativeCheckpointRecord({
    artifact: options.artifact,
    checkpointId: options.checkpointId ?? `${options.artifact.runId}:checkpoint:native:${executionPrefix.steps.length}`,
    createdAt: options.createdAt,
    reason: options.reason,
    executionPrefix,
    state: cloneJson(options.artifact.finalState),
    agents: cloneJson(options.artifact.agents),
    agentSnapshotFrameId: finalAgentSnapshotFrameId
  });
  assertValidHarnessCheckpoint(checkpoint);
  return checkpoint;
}

export function buildHarnessCheckpointAtPrefix(options: {
  artifact: MatchArtifact;
  selector: HarnessCheckpointPrefixSelector;
  checkpointId?: string;
  createdAt?: string;
  reason?: string;
}): HarnessCheckpoint {
  assertValidMatchArtifactIntegrity(options.artifact);
  const selected = resolveCheckpointPrefixSelection(options.artifact, options.selector);
  assertSafeCheckpointBoundary(options.artifact, selected.index);
  const agents = resolveAgentSnapshotsAfterNativeStep(options.artifact, selected.step);
  if (!agents || !selected.step.actorSnapshotsHashAfterStep) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: agent snapshots are not recorded for this boundary.`
    );
  }
  const agentsHash = hashStableState(agents);
  if (agentsHash !== selected.step.actorSnapshotsHashAfterStep) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: agent snapshot hash mismatch.`
    );
  }
  const steps = cloneJson(options.artifact.socialEpisode.steps.slice(0, selected.index + 1));
  const messageSeq = latestMessageSeqForNativePrefix(options.artifact.socialEpisode, steps);
  const messages = cloneJson(options.artifact.socialEpisode.messages.filter((message) => message.seq <= messageSeq));
  const snapshotEvidenceErrors: string[] = [];
  const maxEventSeq = steps.reduce((max, step) => (step.eventSeqRange ? Math.max(max, step.eventSeqRange[1]) : max), 0);
  const futureTraceIds = new Set(options.artifact.socialEpisode.steps.slice(selected.index + 1).map((step) => step.traceId));
  for (const [agentIndex, agent] of agents.entries()) {
    validateAgentEvidenceNotBeyondBoundary({
      agent,
      maxMessageSeq: messageSeq,
      maxEventSeq,
      futureTraceIds,
      label: `nativeSnapshot[${agentIndex}]`,
      errors: snapshotEvidenceErrors
    });
  }
  if (snapshotEvidenceErrors.length) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: ${snapshotEvidenceErrors.join(" ")}`
    );
  }
  const executionPrefix = cloneJson({
    ...options.artifact.socialEpisode,
    status: "truncated",
    truncationReason: `checkpoint boundary after native step ${selected.index + 1}`,
    terminationReason: undefined,
    failureReason: undefined,
    error: undefined,
    finalState: options.artifact.initialState,
    steps,
    messages,
    exposureRecords: undefined,
    exposureSummary: undefined,
    metrics: undefined
  }) as HarnessCheckpoint["executionPrefix"];
  const firstReplay = replayWerewolfSocialEpisode(executionPrefix, {
    stopOnMismatch: false,
    agentSnapshotFrames: options.artifact.agentSnapshotFrames
  });
  const nonFinalHashMismatches = firstReplay.mismatches.filter((mismatch) => !mismatch.startsWith("Replay final state hash mismatch"));
  if (nonFinalHashMismatches.length) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build native prefix checkpoint at step ${selected.index + 1}: ${nonFinalHashMismatches.join(" ")}`
    );
  }
  executionPrefix.finalState = cloneJson(firstReplay.finalState);
  const checkpoint = buildNativeCheckpointRecord({
    artifact: options.artifact,
    checkpointId: options.checkpointId ?? `${options.artifact.runId}:checkpoint:native:${steps.length}`,
    createdAt: options.createdAt,
    reason: options.reason,
    executionPrefix,
    state: cloneJson(firstReplay.finalState),
    agents,
    agentSnapshotFrameId: selected.step.actorSnapshotFrameIdAfterStep
  });
  assertValidHarnessCheckpoint(checkpoint);
  return checkpoint;
}

export function forkHarnessRunOptions(options: {
  checkpoint: HarnessCheckpoint;
  reasoner: HarnessReasoner;
  agents?: HarnessRunOptions["agents"];
  maxTransitions?: number;
  createdAt?: string;
  reason?: string;
}): HarnessRunOptions {
  assertValidHarnessCheckpoint(options.checkpoint);
  assertForkableWerewolfCheckpointBoundary(options.checkpoint);
  const genericFork = createGenericForkProvenance(options.checkpoint, {
    createdAt: options.createdAt,
    reason: options.reason,
    parentArtifactId: options.checkpoint.source.matchId ?? options.checkpoint.source.runId,
    parentEvidenceTraceIds: inheritedEvidenceTraceIdsFromCheckpoint(options.checkpoint)
  });
  return {
    initialState: cloneJson(options.checkpoint.state),
    initialAgentStates: cloneJson(options.checkpoint.agents),
    initialSocialChannels: cloneJson(options.checkpoint.executionPrefix.channels),
    initialSocialMessages: cloneJson(options.checkpoint.executionPrefix.messages),
    agents: cloneJson(options.agents ?? agentConfigsFromCheckpoint(options.checkpoint)),
    reasoner: options.reasoner,
    maxTransitions: options.maxTransitions,
    forkOf: {
      ...genericFork,
      parentMatchId: options.checkpoint.source.matchId,
      parentRulesetId: options.checkpoint.source.rulesetId,
    }
  };
}

export function validateHarnessCheckpoint(checkpoint: HarnessCheckpoint): string[] {
  const errors = validateHarnessCheckpointEnvelope(checkpoint);
  if (checkpoint.artifactVersion !== HARNESS_CHECKPOINT_VERSION) {
    errors.push(`artifactVersion must be ${HARNESS_CHECKPOINT_VERSION}.`);
  }
  if (checkpoint.kind !== "checkpoint") {
    errors.push("kind must be checkpoint.");
  }
  if (checkpoint.source.sourceArtifactVersion !== MATCH_ARTIFACT_VERSION) {
    errors.push(`source.sourceArtifactVersion must be ${MATCH_ARTIFACT_VERSION}.`);
  }
  if (checkpoint.source.seed !== checkpoint.state.seed) {
    errors.push(`source.seed mismatch: expected ${checkpoint.state.seed}, received ${checkpoint.source.seed}.`);
  }
  validateHarnessCheckpointRulesetBinding(checkpoint, errors);

  const playerIds = new Set(checkpoint.state.players.map((player) => player.id));
  const seenAgentIds = new Set<string>();
  for (const agent of checkpoint.agents) {
    if (seenAgentIds.has(agent.playerId)) {
      errors.push(`Duplicate restored agent state for ${agent.playerId}.`);
    }
    seenAgentIds.add(agent.playerId);
    if (!playerIds.has(agent.playerId)) {
      errors.push(`Restored agent state references unknown player ${agent.playerId}.`);
    }
  }
  for (const playerId of playerIds) {
    if (!seenAgentIds.has(playerId)) {
      errors.push(`Missing restored agent state for ${playerId}.`);
    }
  }
  errors.push(
    ...validateHarnessCheckpointReplay(checkpoint, (executionPrefix) =>
      replayWerewolfSocialEpisode(executionPrefix, { stopOnMismatch: false })
    )
  );
  validateCheckpointAgentEvidence(checkpoint, errors);

  return errors;
}

export function assertValidHarnessCheckpoint(checkpoint: HarnessCheckpoint): void {
  const errors = validateHarnessCheckpoint(checkpoint);
  if (errors.length) {
    throw new Error(`Invalid harness checkpoint ${checkpoint.checkpointId}: ${errors.join(" ")}`);
  }
}

function assertForkableWerewolfCheckpointBoundary(checkpoint: HarnessCheckpoint): void {
  const boundary = checkpoint.executionPrefix.steps.at(-1);
  if (!boundary?.actorSnapshotsHashAfterStep) {
    throw new Error(
      `Checkpoint ${checkpoint.checkpointId} is not forkable: final native boundary has no recorded durable actor snapshot.`
    );
  }
  if (boundary.actorSnapshotsHashAfterStep !== checkpoint.source.agentsHash) {
    throw new Error(
      `Checkpoint ${checkpoint.checkpointId} is not forkable: final boundary actor snapshot hash does not match source.agentsHash.`
    );
  }
  if (boundary.actorSnapshotFrameIdAfterStep !== checkpoint.source.agentSnapshotFrameId) {
    throw new Error(
      `Checkpoint ${checkpoint.checkpointId} is not forkable: final boundary actor snapshot frame id does not match source.agentSnapshotFrameId.`
    );
  }
}

function agentConfigsFromCheckpoint(checkpoint: HarnessCheckpoint): HarnessRunOptions["agents"] {
  return checkpoint.agents.map((agent) => ({
    playerId: agent.playerId,
    profileId: agent.profileId,
    model: agent.model,
    temperature: agent.temperature,
    policyName: agent.policyName
  }));
}

function buildNativeCheckpointRecord(options: {
  artifact: MatchArtifact;
  checkpointId: string;
  createdAt?: string;
  reason?: string;
  executionPrefix: HarnessCheckpoint["executionPrefix"];
  state: GameState;
  agents: AgentHarnessState[];
  agentSnapshotFrameId?: string;
}): HarnessCheckpoint {
  const boundary = options.executionPrefix.steps.at(-1);
  const lastMessage = options.executionPrefix.messages.at(-1);
  return {
    artifactVersion: HARNESS_CHECKPOINT_VERSION,
    kind: "checkpoint",
    checkpointId: options.checkpointId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    reason: options.reason,
    source: {
      sourceArtifactVersion: MATCH_ARTIFACT_VERSION,
      runId: options.artifact.runId,
      matchId: options.artifact.matchId,
      seed: options.artifact.seed,
      rulesetId: options.artifact.rulesetId,
      status: options.artifact.status,
      boundaryTraceId: boundary?.traceId,
      boundaryTurnIndex: boundary?.turnIndex,
      boundaryBatchId: boundary?.batchId,
      boundaryBatchIndex: boundary?.batchIndex,
      boundarySchedulerMode: boundary?.schedulerMode,
      nativeStepCount: options.executionPrefix.steps.length,
      messageCount: options.executionPrefix.messages.length,
      lastMessageSeq: lastMessage?.seq,
      stateHash: hashStableState(options.state),
      executionPrefixHash: hashStableState(options.executionPrefix),
      agentsHash: hashStableState(options.agents),
      channelsHash: hashStableState(options.executionPrefix.channels),
      messagesHash: hashStableState(options.executionPrefix.messages),
      agentSnapshotFrameId: options.agentSnapshotFrameId,
      failureReason: options.artifact.failureReason,
      truncationReason: options.artifact.truncationReason
    },
    state: cloneJson(options.state),
    agents: cloneJson(options.agents),
    executionPrefix: cloneJson(options.executionPrefix)
  };
}

/**
 * The harness envelope remains domain-neutral; this validator is deliberately
 * kept in the Werewolf artifact specialization.  A single replay recipe must
 * not combine config/state/episode/fork records from different semantics.
 */
function validateMatchArtifactRulesetBinding(artifact: MatchArtifact, errors: string[]): void {
  validateWerewolfRulesetId(artifact.rulesetId, "rulesetId", errors);
  const configs: Array<[string, GameConfig | undefined]> = [
    ["config", artifact.config],
    ["initialState.config", artifact.initialState?.config],
    ["finalState.config", artifact.finalState?.config],
    ["socialEpisode.initialState.config", (artifact.socialEpisode?.initialState as GameState | undefined)?.config],
    ["socialEpisode.finalState.config", (artifact.socialEpisode?.finalState as GameState | undefined)?.config]
  ];
  for (const [label, config] of configs) {
    validateWerewolfRulesetId(config?.rulesetId, `${label}.rulesetId`, errors);
    if (config?.rulesetId !== artifact.rulesetId) {
      errors.push(`${label}.rulesetId does not match artifact.rulesetId.`);
    }
  }

  const canonicalConfig = artifact.config;
  const canonicalConfigHash = hashStableState(canonicalConfig);
  for (const [label, config] of configs.slice(1)) {
    if (hashStableState(config) !== canonicalConfigHash) {
      errors.push(`${label} does not match artifact.config.`);
    }
  }

  if (artifact.forkOf) {
    validateWerewolfRulesetId(artifact.forkOf.parentRulesetId, "forkOf.parentRulesetId", errors);
    if (artifact.forkOf.parentRulesetId !== artifact.config?.rulesetId) {
      errors.push("forkOf.parentRulesetId does not match artifact.config.rulesetId.");
    }
  }
}

function validateHarnessCheckpointRulesetBinding(checkpoint: HarnessCheckpoint, errors: string[]): void {
  validateWerewolfRulesetId(checkpoint.source.rulesetId, "source.rulesetId", errors);
  const configs: Array<[string, GameConfig | undefined]> = [
    ["state.config", checkpoint.state?.config],
    ["executionPrefix.initialState.config", (checkpoint.executionPrefix?.initialState as GameState | undefined)?.config],
    ["executionPrefix.finalState.config", (checkpoint.executionPrefix?.finalState as GameState | undefined)?.config]
  ];
  for (const [label, config] of configs) {
    validateWerewolfRulesetId(config?.rulesetId, `${label}.rulesetId`, errors);
    if (config?.rulesetId !== checkpoint.source.rulesetId) {
      errors.push(`${label}.rulesetId does not match source.rulesetId.`);
    }
  }

  const stateConfigHash = hashStableState(checkpoint.state?.config);
  for (const [label, config] of configs.slice(1)) {
    if (hashStableState(config) !== stateConfigHash) {
      errors.push(`${label} does not match state.config.`);
    }
  }
}

function validateWerewolfRulesetId(value: unknown, label: string, errors: string[]): void {
  if (!isSupportedWerewolfRulesetId(value)) {
    errors.push(`${label} must be a supported Werewolf ruleset id; received ${typeof value === "string" && value ? value : "<missing>"}.`);
  }
}

function resolveAgentSnapshotsAfterNativeStep(
  artifact: MatchArtifact,
  step: MatchArtifact["socialEpisode"]["steps"][number]
): AgentHarnessState[] | undefined {
  if (Array.isArray(step.actorSnapshotsAfterStep)) return cloneJson(step.actorSnapshotsAfterStep) as AgentHarnessState[];
  if (!step.actorSnapshotFrameIdAfterStep) return undefined;
  const frame = artifact.agentSnapshotFrames?.find((candidate) => candidate.frameId === step.actorSnapshotFrameIdAfterStep);
  if (!frame || frame.agentsHash !== step.actorSnapshotsHashAfterStep) return undefined;
  return cloneJson(frame.agents);
}

function resolveCheckpointPrefixSelection(
  artifact: MatchArtifact,
  selector: HarnessCheckpointPrefixSelector
): { index: number; step: SocialEpisodeArtifact["steps"][number] } {
  const selectors = [
    selector.traceId !== undefined ? "traceId" : undefined,
    selector.nativeTurnIndex !== undefined ? "nativeTurnIndex" : undefined,
    selector.nativeStepCount !== undefined ? "nativeStepCount" : undefined
  ].filter((value): value is string => Boolean(value));
  if (selectors.length !== 1) {
    throw new HarnessCheckpointSelectionError(
      selectors.length === 0 ? "selector_not_found" : "ambiguous_selector",
      selectors.length === 0
        ? "Prefix checkpoint requires exactly one selector."
        : `Prefix checkpoint selector is ambiguous: ${selectors.join(", ")}.`
    );
  }
  let index = -1;
  if (selector.traceId !== undefined) {
    index = artifact.socialEpisode.steps.findIndex((step) => step.traceId === selector.traceId);
  } else if (selector.nativeTurnIndex !== undefined) {
    index = artifact.socialEpisode.steps.findIndex((step) => step.turnIndex === selector.nativeTurnIndex);
  } else if (selector.nativeStepCount !== undefined) {
    index = selector.nativeStepCount - 1;
  }
  const step = artifact.socialEpisode.steps[index];
  if (!step) {
    throw new HarnessCheckpointSelectionError("selector_not_found", "Prefix checkpoint selector did not match a native social execution step.");
  }
  return { index, step };
}

function assertSafeCheckpointBoundary(artifact: MatchArtifact, stepIndex: number): void {
  const step = artifact.socialEpisode.steps[stepIndex];
  if (!step) {
    throw new HarnessCheckpointSelectionError("selector_not_found", "Prefix checkpoint selector did not match a native social execution step.");
  }
  if (!resolveAgentSnapshotsAfterNativeStep(artifact, step) || step.actorSnapshotsHashAfterStep === undefined) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build native prefix checkpoint at step ${stepIndex + 1}: agent snapshots are not recorded for this boundary.`
    );
  }
  if (!isSafeNativeCheckpointBoundary(artifact.socialEpisode.steps, stepIndex)) {
    throw new HarnessCheckpointSelectionError(
      "unsafe_batch_boundary",
      "Prefix checkpoint cannot be built from the middle of a native scheduler batch."
    );
  }
}

function isSafeNativeCheckpointBoundary(steps: SocialEpisodeArtifact["steps"], stepIndex: number): boolean {
  if (stepIndex < 0) return steps.length === 0;
  const step = steps[stepIndex];
  if (!step) return false;
  const nextStep = steps[stepIndex + 1];
  if (!step.batchId || nextStep?.batchId !== step.batchId) return true;
  return step.schedulerMode === "aec" && !step.atomic;
}

function latestMessageSeqForNativePrefix(
  episode: MatchArtifact["socialEpisode"],
  steps: MatchArtifact["socialEpisode"]["steps"]
): number {
  let messageSeq = episode.execution?.initialMessageCount ?? 0;
  for (const step of steps) {
    if (step.messageSeqRange) messageSeq = Math.max(messageSeq, step.messageSeqRange[1]);
  }
  return messageSeq;
}

function validateCheckpointAgentEvidence(checkpoint: HarnessCheckpoint, errors: string[]): void {
  const futureTraceIds = new Set<string>();
  const maxMessageSeq = checkpoint.source.lastMessageSeq ?? 0;
  const maxEventSeq = checkpoint.executionPrefix.steps.reduce(
    (max, step) => (step.eventSeqRange ? Math.max(max, step.eventSeqRange[1]) : max),
    0
  );
  for (const [agentIndex, agent] of checkpoint.agents.entries()) {
    validateAgentEvidenceNotBeyondBoundary({
      agent,
      maxMessageSeq,
      maxEventSeq,
      futureTraceIds,
      label: `agents[${agentIndex}]`,
      errors
    });
  }
}

function validateAgentEvidenceNotBeyondBoundary(input: {
  agent: AgentHarnessState;
  maxMessageSeq: number;
  maxEventSeq: number;
  futureTraceIds: Set<string>;
  label: string;
  errors: string[];
}): void {
  for (const entry of input.agent.social?.journal?.entries ?? []) {
    if (entry.traceId && input.futureTraceIds.has(entry.traceId)) {
      input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq} references future trace ${entry.traceId}.`);
    }
    if (entry.messageSeqRange && entry.messageSeqRange.end > input.maxMessageSeq) {
      input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq}.messageSeqRange references future social message seq.`);
    }
    if (entry.eventSeqRange && entry.eventSeqRange.end > input.maxEventSeq) {
      input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq}.eventSeqRange references future event seq.`);
    }
    for (const evidenceRef of entry.evidenceRefs ?? []) {
      if (evidenceRef.artifact === "trace" && evidenceRef.traceId && input.futureTraceIds.has(evidenceRef.traceId)) {
        input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq} evidence references future trace ${evidenceRef.traceId}.`);
      }
      if (evidenceRef.artifact === "message" && evidenceRef.seq !== undefined && evidenceRef.seq > input.maxMessageSeq) {
        input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq} evidence references future message seq ${evidenceRef.seq}.`);
      }
      if (evidenceRef.artifact === "event" && evidenceRef.seq !== undefined && evidenceRef.seq > input.maxEventSeq) {
        input.errors.push(`${input.label}.social.journal entry ${entry.journalSeq} evidence references future event seq ${evidenceRef.seq}.`);
      }
    }
  }
}

function failureReasonFromEventPayload(payload: unknown): string | null {
  if (isRecord(payload) && typeof payload.message === "string") return payload.message;
  if (payload === undefined || payload === null) return null;
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function validateEventSeqRange(range: [number, number], eventSeqs: Set<number>, label: string, errors: string[]): void {
  if (!isTupleRange(range)) {
    errors.push(`${label} must be a positive integer [start, end] range with start <= end.`);
    return;
  }
  const [start, end] = range;
  for (let seq = start; seq <= end; seq += 1) {
    if (!eventSeqs.has(seq)) errors.push(`${label} references missing event seq ${seq}.`);
  }
}

function validateMessageSeqRange(range: [number, number] | undefined, messageSeqs: Set<number>, label: string, errors: string[]): void {
  if (!range) return;
  if (!isTupleRange(range)) {
    errors.push(`${label} must be a positive integer [start, end] range with start <= end.`);
    return;
  }
  const [start, end] = range;
  for (let seq = start; seq <= end; seq += 1) {
    if (!messageSeqs.has(seq)) errors.push(`${label} references missing social message seq ${seq}.`);
  }
}

function validateAgentSnapshotFrames(artifact: MatchArtifact, playerIds: Set<string>, errors: string[]): void {
  const seen = new Set<string>();
  const referencedFrameIds = referencedAgentSnapshotFrameIds(artifact);
  for (const [index, frame] of (artifact.agentSnapshotFrames ?? []).entries()) {
    const label = `agentSnapshotFrames[${index}]`;
    if (frame.artifactVersion !== AGENT_SNAPSHOT_FRAME_VERSION) {
      errors.push(`${label}.artifactVersion must be ${AGENT_SNAPSHOT_FRAME_VERSION}.`);
    }
    if (frame.kind !== "agent-snapshot-frame") {
      errors.push(`${label}.kind must be agent-snapshot-frame.`);
    }
    if (!frame.frameId?.trim()) {
      errors.push(`${label}.frameId is missing.`);
    } else if (seen.has(frame.frameId)) {
      errors.push(`Duplicate agent snapshot frame id ${frame.frameId}.`);
    }
    seen.add(frame.frameId);
    if (frame.agentsHash !== hashStableState(frame.agents)) {
      errors.push(`${label}.agentsHash mismatch.`);
    }
    if (frame.frameId !== harnessAgentSnapshotFrameId(frame.agentsHash)) {
      errors.push(`${label}.frameId mismatch for agentsHash.`);
    }
    if (!referencedFrameIds.has(frame.frameId)) {
      errors.push(`${label}.frameId ${frame.frameId} is not referenced by any trajectory or social step.`);
    }
    validateStepAgentSnapshots({
      snapshots: frame.agents,
      snapshotHash: frame.agentsHash,
      playerIds,
      actorId: "",
      agentStateHash: undefined,
      label,
      required: true,
      errors
    });
  }
}

function referencedAgentSnapshotFrameIds(artifact: MatchArtifact): Set<string> {
  const refs = new Set<string>();
  const framesByHash = new Map((artifact.agentSnapshotFrames ?? []).map((frame) => [frame.agentsHash, frame.frameId]));
  for (const step of artifact.trajectory) {
    if (step.agentSnapshotFrameIdAfterStep) refs.add(step.agentSnapshotFrameIdAfterStep);
    if (!step.agentSnapshotFrameIdAfterStep && step.agentSnapshotsHashAfterStep) {
      const frameId = framesByHash.get(step.agentSnapshotsHashAfterStep);
      if (frameId) refs.add(frameId);
    }
  }
  for (const step of artifact.socialEpisode.steps) {
    if (step.actorSnapshotFrameIdAfterStep) refs.add(step.actorSnapshotFrameIdAfterStep);
    if (!step.actorSnapshotFrameIdAfterStep && step.actorSnapshotsHashAfterStep) {
      const frameId = framesByHash.get(step.actorSnapshotsHashAfterStep);
      if (frameId) refs.add(frameId);
    }
  }
  return refs;
}

function validateStepAgentSnapshots(input: {
  snapshots: AgentHarnessState[] | undefined;
  snapshotHash: string | undefined;
  playerIds: Set<string>;
  actorId: string;
  agentStateHash: string | undefined;
  label: string;
  required: boolean;
  errors: string[];
}): void {
  if (!input.snapshots || !input.snapshotHash) {
    if (input.required) {
      input.errors.push(`${input.label}.agentSnapshotsAfterStep and agentSnapshotsHashAfterStep are required for recoverable prefix checkpoints.`);
    }
    return;
  }
  const actualHash = hashStableState(input.snapshots);
  if (actualHash !== input.snapshotHash) {
    input.errors.push(`${input.label}.agentSnapshotsHashAfterStep mismatch: expected ${actualHash}, received ${input.snapshotHash}.`);
  }
  const seen = new Set<string>();
  for (const [index, agent] of input.snapshots.entries()) {
    if (seen.has(agent.playerId)) {
      input.errors.push(`${input.label}.agentSnapshotsAfterStep[${index}] duplicates playerId ${agent.playerId}.`);
    }
    seen.add(agent.playerId);
    if (!input.playerIds.has(agent.playerId)) {
      input.errors.push(`${input.label}.agentSnapshotsAfterStep[${index}] references unknown player ${agent.playerId}.`);
    }
  }
  for (const playerId of input.playerIds) {
    if (!seen.has(playerId)) {
      input.errors.push(`${input.label}.agentSnapshotsAfterStep is missing agent state for player ${playerId}.`);
    }
  }
  if (input.actorId) {
    const actor = input.snapshots.find((agent) => agent.playerId === input.actorId);
    if (!actor) {
      input.errors.push(`${input.label}.agentSnapshotsAfterStep is missing acting agent ${input.actorId}.`);
    } else if (input.agentStateHash && actor.socialStateHash !== input.agentStateHash) {
      input.errors.push(`${input.label}.agentStateHash mismatch with acting agent snapshot ${input.actorId}.`);
    }
  }
}

function validateAgentSnapshotFrameReference(input: {
  frames: AgentSnapshotFrame[];
  frameId: string | undefined;
  snapshotHash: string | undefined;
  label: string;
  fieldName: string;
  hashFieldName: string;
  errors: string[];
}): void {
  if (!input.frameId) return;
  const frame = input.frames.find((candidate) => candidate.frameId === input.frameId);
  if (!frame) {
    input.errors.push(`${input.label}.${input.fieldName} references missing agent snapshot frame ${input.frameId}.`);
    return;
  }
  if (input.snapshotHash && frame.agentsHash !== input.snapshotHash) {
    input.errors.push(
      `${input.label}.${input.fieldName} hash mismatch: ${input.hashFieldName}=${input.snapshotHash}, frame.agentsHash=${frame.agentsHash}.`
    );
  }
}

function validateMutationRange(
  range: { start: number; end: number } | undefined,
  seqs: Set<number>,
  label: string,
  errors: string[]
): void {
  if (!range) return;
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start <= 0 || range.end < range.start) {
    errors.push(`${label} must be a positive integer range with start <= end.`);
    return;
  }
  for (let seq = range.start; seq <= range.end; seq += 1) {
    if (!seqs.has(seq)) errors.push(`${label} references missing seq ${seq}.`);
  }
}

function isTupleRange(range: [number, number]): boolean {
  const [start, end] = range;
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start;
}

function sameRange(left: [number, number] | undefined, right: [number, number] | undefined): boolean {
  if (!left || !right) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}

function isForkParentTraceRef(artifact: MatchArtifact, traceId: string): boolean {
  const inheritedTraceIds = artifact.forkOf?.parentEvidenceTraceIds;
  if (Array.isArray(inheritedTraceIds)) {
    return inheritedTraceIds.includes(traceId);
  }
  const parentRunId = artifact.forkOf?.parentRunId;
  return Boolean(parentRunId && traceId.startsWith(`${parentRunId}:`));
}

function inheritedEvidenceTraceIdsFromCheckpoint(checkpoint: HarnessCheckpoint): string[] {
  const traceIds = new Set<string>();
  if (checkpoint.source.boundaryTraceId) traceIds.add(checkpoint.source.boundaryTraceId);
  for (const step of checkpoint.executionPrefix.steps) {
    if (step.traceId) traceIds.add(step.traceId);
  }
  for (const agent of checkpoint.agents) {
    for (const entry of agent.social?.journal?.entries ?? []) {
      if (entry.traceId) traceIds.add(entry.traceId);
      for (const evidenceRef of entry.evidenceRefs ?? []) {
        if (evidenceRef.artifact === "trace" && evidenceRef.traceId) traceIds.add(evidenceRef.traceId);
      }
    }
  }
  return [...traceIds].sort();
}

function commandTypeFromUnknown(value: unknown): string | undefined {
  const record = isRecord(value) ? value : undefined;
  return typeof record?.type === "string" ? record.type : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
