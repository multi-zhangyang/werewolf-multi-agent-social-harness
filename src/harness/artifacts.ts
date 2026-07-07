import type { GameConfig, GameEvent, GameState, MatchMetrics } from "../core/types";
import type { HarnessAssignmentConfig, ResolvedAgentAssignment } from "./profiles";
import { summarizeEvaluationWarnings } from "./evaluation";
import { deriveSocialExposureRecords, validateSocialEpisodeArtifact, type SocialEpisodeArtifact, type SocialMessage } from "./social";
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
import { replayHarnessTrajectory } from "./replay";
import { redactSecrets } from "./redaction";

export const MATCH_ARTIFACT_VERSION = "harness.match.v1";
export const HARNESS_CHECKPOINT_VERSION = "harness.checkpoint.v1";
export const AGENT_SNAPSHOT_FRAME_VERSION = "harness.agent-snapshot-frame.v1";

export interface AgentSnapshotFrame {
  artifactVersion: typeof AGENT_SNAPSHOT_FRAME_VERSION;
  kind: "agent-snapshot-frame";
  frameId: string;
  agentsHash: string;
  agents: AgentHarnessState[];
}

export interface MatchArtifact {
  artifactVersion: typeof MATCH_ARTIFACT_VERSION;
  kind: "match";
  runId: string;
  matchId?: string;
  createdAt: string;
  seed: string;
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
  trajectory: HarnessStepRecord[];
  socialEpisode: SocialEpisodeArtifact;
  events: GameEvent[];
  evaluation: AdversarialEvaluation;
  evaluationReport: HarnessEvaluationReport;
  metrics: MatchMetrics;
  agents: AgentHarnessState[];
  agentSnapshotFrames?: AgentSnapshotFrame[];
}

export interface HarnessCheckpoint {
  artifactVersion: typeof HARNESS_CHECKPOINT_VERSION;
  kind: "checkpoint";
  checkpointId: string;
  createdAt: string;
  reason?: string;
  source: {
    runId: string;
    matchId?: string;
    seed: string;
    status: HarnessRunResult["status"];
    traceId?: string;
    turnIndex?: number;
    trajectoryLength: number;
    messageSeq?: number;
    stateHash: string;
    trajectoryHash: string;
    agentsHash: string;
    socialMessagesHash: string;
    failureReason?: string;
    truncationReason?: string;
  };
  state: GameState;
  agents: AgentHarnessState[];
  trajectory: HarnessStepRecord[];
  socialMessages: SocialMessage[];
}

export interface HarnessCheckpointPrefixSelector {
  traceId?: string;
  turnIndex?: number;
  trajectoryLength?: number;
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
  const redacted = redactSecrets(artifact) as MatchArtifact;
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
    const frameId = agentSnapshotFrameId(agentsHash);
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

  for (const step of options.socialEpisode.steps) {
    if (!step.actorSnapshotsAfterStep || !step.actorSnapshotsHashAfterStep) continue;
    const frame = frameFor(step.actorSnapshotsAfterStep as AgentHarnessState[], step.actorSnapshotsHashAfterStep);
    step.actorSnapshotFrameIdAfterStep = frame.frameId;
    delete step.actorSnapshotsAfterStep;
  }

  return [...framesById.values()].sort((a, b) => a.frameId.localeCompare(b.frameId));
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
    const frameId = agentSnapshotFrameId(agentsHash);
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

function agentSnapshotFrameId(agentsHash: string): string {
  return `agent-snapshot:${agentsHash}`;
}

export function toTrajectoryJsonl(artifact: MatchArtifact): string {
  const lines: unknown[] = [
    {
      type: "header",
      artifactVersion: artifact.artifactVersion,
      kind: artifact.kind,
      runId: artifact.runId,
      matchId: artifact.matchId,
      createdAt: artifact.createdAt,
      seed: artifact.seed,
      models: artifact.models,
      profiles: artifact.profiles,
      assignment: artifact.assignment,
      resolvedAssignments: artifact.resolvedAssignments,
      status: artifact.status,
      truncationReason: artifact.truncationReason ?? null,
      failureReason: artifact.failureReason ?? null,
      failureStateHash: artifact.failureStateHash ?? null,
      forkOf: artifact.forkOf ?? null
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
      id: artifact.evaluationReport.id,
      createdAt: artifact.evaluationReport.createdAt,
      evaluatorIds: artifact.evaluationReport.evaluatorIds,
      evaluatorRegistry: artifact.evaluationReport.evaluatorRegistry ?? [],
      metricCount: artifact.evaluationReport.metricCount,
      warnings: artifact.evaluationReport.warnings ?? [],
      warningSummary: summarizeEvaluationWarnings(artifact.evaluationReport.warnings),
      summary: artifact.evaluationReport.summary
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
      infosByAgent: step.infosByAgent ?? null,
      episodeTerminated: step.episodeTerminated ?? null,
      episodeTruncated: step.episodeTruncated ?? null,
      terminationReason: step.terminationReason ?? null,
      truncationReason: step.truncationReason ?? null,
      error: step.error ?? null
    })),
    ...artifact.trajectory.map((step) => ({
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
    ...artifact.trajectory.map((step) => ({
      type: "trace",
      traceId: step.traceId,
      turnIndex: step.turnIndex,
      actorId: step.actorId,
      profileId: step.profileId,
      model: step.model,
      actionKind: step.pendingAction.kind,
      commandType: step.command.type,
      policyPlan: step.policyPlan,
      reasonerOutput: step.reasonerOutput,
      turnTrace: step.turnTrace,
      agentStateHash: step.agentStateHash,
      agentSnapshotsHashAfterStep: step.agentSnapshotsHashAfterStep ?? null,
      agentSnapshotFrameIdAfterStep: step.agentSnapshotFrameIdAfterStep ?? null,
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
    ...artifact.events.map((event) => ({
      ...event,
      type: "event",
      eventType: event.type
    })),
    ...artifact.events
      .filter((event) => event.type === "harness.error")
      .map((event) => ({
        type: "error",
        eventId: event.id,
        eventSeq: event.seq,
        day: event.day,
        phase: event.phase,
        actorId: event.actorId ?? null,
        failureReason: failureReasonFromEventPayload(event.payload),
        payload: event.payload
      })),
    ...artifact.agents.map((agent) => ({
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
    ...artifact.agents.flatMap((agent) =>
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
    ...artifact.evaluationReport.metrics.map((metric) => ({
      type: "metric",
      evaluationReportId: artifact.evaluationReport.id,
      ...metric
    }))
  ];
  return `${lines.map((line) => JSON.stringify(redactSecrets(line))).join("\n")}\n`;
}

export function validateMatchArtifactIntegrity(artifact: MatchArtifact): string[] {
  const errors: string[] = [];
  if (artifact.artifactVersion !== MATCH_ARTIFACT_VERSION) errors.push(`artifactVersion must be ${MATCH_ARTIFACT_VERSION}.`);
  if (artifact.kind !== "match") errors.push("kind must be match.");
  if (artifact.socialEpisode.status !== artifact.status) {
    errors.push(`socialEpisode.status mismatch: expected ${artifact.status}, received ${artifact.socialEpisode.status}.`);
  }

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

  errors.push(...validateSocialEpisodeArtifact(artifact.socialEpisode).map((error) => `socialEpisode.${error}`));

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
    if (socialStep.turnIndex !== step.turnIndex) errors.push(`trajectory[${index}] turnIndex mismatch with socialEpisode step ${step.traceId}.`);
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
  const traceIds = new Set([...artifact.trajectory.map((step) => step.traceId), ...artifact.socialEpisode.steps.map((step) => step.traceId)]);
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

  return errors;
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
  const trajectory = cloneJson(options.artifact.trajectory);
  const lastStep = trajectory.at(-1);
  const lastMessage = options.artifact.socialEpisode.messages.at(-1);
  const stateHash = hashStableState(options.artifact.finalState);
  const replayablePrefixHash = lastStep?.postStateHash ?? hashStableState(options.artifact.initialState);
  if (options.artifact.status === "failed" && replayablePrefixHash !== stateHash) {
    throw new Error("Cannot build final replay checkpoint from failed artifact whose final state is beyond the replayable trajectory prefix.");
  }
  const agentsHash = hashStableState(options.artifact.agents);
  stripAgentSnapshotEvidenceFromTrajectory(trajectory);
  const trajectoryHash = hashStableState(trajectory);
  const socialMessagesHash = hashStableState(options.artifact.socialEpisode.messages);
  return {
    artifactVersion: HARNESS_CHECKPOINT_VERSION,
    kind: "checkpoint",
    checkpointId: options.checkpointId ?? `${options.artifact.runId}:checkpoint:${options.artifact.trajectory.length}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    reason: options.reason,
    source: {
      runId: options.artifact.runId,
      matchId: options.artifact.matchId,
      seed: options.artifact.seed,
      status: options.artifact.status,
      traceId: lastStep?.traceId,
      turnIndex: lastStep?.turnIndex,
      trajectoryLength: options.artifact.trajectory.length,
      messageSeq: lastMessage?.seq,
      stateHash,
      trajectoryHash,
      agentsHash,
      socialMessagesHash,
      failureReason: options.artifact.failureReason,
      truncationReason: options.artifact.truncationReason
    },
    state: cloneJson(options.artifact.finalState),
    agents: cloneJson(options.artifact.agents),
    trajectory,
    socialMessages: cloneJson(options.artifact.socialEpisode.messages)
  };
}

export function buildHarnessCheckpointAtPrefix(options: {
  artifact: MatchArtifact;
  selector: HarnessCheckpointPrefixSelector;
  checkpointId?: string;
  createdAt?: string;
  reason?: string;
}): HarnessCheckpoint {
  const selected = resolveCheckpointPrefixSelection(options.artifact, options.selector);
  assertSafeCheckpointBoundary(options.artifact, selected.index);
  const agents = resolveAgentSnapshotsAfterStep(options.artifact, selected.step);
  const trajectory = cloneJson(options.artifact.trajectory.slice(0, selected.index + 1));
  stripAgentSnapshotEvidenceFromTrajectory(trajectory);
  const selectedStep = trajectory.at(-1);
  if (!selectedStep) {
    throw new HarnessCheckpointSelectionError("selector_not_found", "Prefix checkpoint requires at least one committed trajectory step.");
  }
  if (!agents || !selected.step.agentSnapshotsHashAfterStep) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build prefix checkpoint at trajectoryLength ${trajectory.length}: agent snapshots are not recorded for this boundary.`
    );
  }
  const agentsHash = hashStableState(agents);
  if (agentsHash !== selected.step.agentSnapshotsHashAfterStep) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build prefix checkpoint at trajectoryLength ${trajectory.length}: agent snapshot hash mismatch.`
    );
  }
  const evidenceErrors: string[] = [];
  validateSnapshotEvidenceWithinArtifactPrefix({
    snapshots: agents,
    trajectory: options.artifact.trajectory,
    stepIndex: selected.index,
    label: `trajectory[${selected.index}].agentSnapshotsAfterStep`,
    errors: evidenceErrors
  });
  if (evidenceErrors.length) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build prefix checkpoint at trajectoryLength ${trajectory.length}: ${evidenceErrors.join(" ")}`
    );
  }
  const replay = replayHarnessTrajectory({
    initialState: options.artifact.initialState,
    trajectory,
    expectedFinalHash: selectedStep.postStateHash
  });
  if (!replay.ok) {
    throw new HarnessCheckpointSelectionError(
      "prefix_replay_mismatch",
      `Cannot build prefix checkpoint at trajectoryLength ${trajectory.length}: trajectory prefix replay failed.`
    );
  }
  const messageSeq = latestMessageSeqForTrajectoryPrefix(trajectory);
  const socialMessages = cloneJson(options.artifact.socialEpisode.messages.filter((message) => message.seq <= messageSeq));
  const stateHash = hashStableState(replay.finalState);
  const trajectoryHash = hashStableState(trajectory);
  const socialMessagesHash = hashStableState(socialMessages);
  return {
    artifactVersion: HARNESS_CHECKPOINT_VERSION,
    kind: "checkpoint",
    checkpointId: options.checkpointId ?? `${options.artifact.runId}:checkpoint:${trajectory.length}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    reason: options.reason,
    source: {
      runId: options.artifact.runId,
      matchId: options.artifact.matchId,
      seed: options.artifact.seed,
      status: options.artifact.status,
      traceId: selectedStep.traceId,
      turnIndex: selectedStep.turnIndex,
      trajectoryLength: trajectory.length,
      messageSeq: socialMessages.at(-1)?.seq,
      stateHash,
      trajectoryHash,
      agentsHash,
      socialMessagesHash,
      failureReason: options.artifact.failureReason,
      truncationReason: options.artifact.truncationReason
    },
    state: cloneJson(replay.finalState),
    agents,
    trajectory,
    socialMessages
  };
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
  return {
    initialState: cloneJson(options.checkpoint.state),
    initialAgentStates: cloneJson(options.checkpoint.agents),
    initialSocialMessages: cloneJson(options.checkpoint.socialMessages),
    agents: cloneJson(options.agents ?? agentConfigsFromCheckpoint(options.checkpoint)),
    reasoner: options.reasoner,
    maxTransitions: options.maxTransitions,
    forkOf: {
      checkpointId: options.checkpoint.checkpointId,
      parentRunId: options.checkpoint.source.runId,
      parentMatchId: options.checkpoint.source.matchId,
      parentTraceId: options.checkpoint.source.traceId,
      parentEvidenceTraceIds: inheritedEvidenceTraceIdsFromCheckpoint(options.checkpoint),
      parentTurnIndex: options.checkpoint.source.turnIndex,
      parentStateHash: options.checkpoint.source.stateHash,
      parentTrajectoryHash: options.checkpoint.source.trajectoryHash,
      parentAgentsHash: options.checkpoint.source.agentsHash,
      parentSocialMessagesHash: options.checkpoint.source.socialMessagesHash,
      parentTrajectoryLength: options.checkpoint.source.trajectoryLength,
      createdAt: options.createdAt ?? new Date().toISOString(),
      reason: options.reason
    }
  };
}

export function validateHarnessCheckpoint(checkpoint: HarnessCheckpoint): string[] {
  const errors: string[] = [];
  if (checkpoint.artifactVersion !== HARNESS_CHECKPOINT_VERSION) {
    errors.push(`artifactVersion must be ${HARNESS_CHECKPOINT_VERSION}.`);
  }
  if (checkpoint.kind !== "checkpoint") {
    errors.push("kind must be checkpoint.");
  }
  const actualStateHash = hashStableState(checkpoint.state);
  if (checkpoint.source.stateHash !== actualStateHash) {
    errors.push(`source.stateHash mismatch: expected ${actualStateHash}, received ${checkpoint.source.stateHash}.`);
  }
  const actualTrajectoryHash = hashStableState(checkpoint.trajectory);
  if (checkpoint.source.trajectoryHash !== actualTrajectoryHash) {
    errors.push(`source.trajectoryHash mismatch: expected ${actualTrajectoryHash}, received ${checkpoint.source.trajectoryHash ?? "undefined"}.`);
  }
  const actualAgentsHash = hashStableState(checkpoint.agents);
  if (checkpoint.source.agentsHash !== actualAgentsHash) {
    errors.push(`source.agentsHash mismatch: expected ${actualAgentsHash}, received ${checkpoint.source.agentsHash ?? "undefined"}.`);
  }
  const actualSocialMessagesHash = hashStableState(checkpoint.socialMessages);
  if (checkpoint.source.socialMessagesHash !== actualSocialMessagesHash) {
    errors.push(
      `source.socialMessagesHash mismatch: expected ${actualSocialMessagesHash}, received ${checkpoint.source.socialMessagesHash ?? "undefined"}.`
    );
  }
  if (checkpoint.source.trajectoryLength !== checkpoint.trajectory.length) {
    errors.push(`source.trajectoryLength mismatch: expected ${checkpoint.trajectory.length}, received ${checkpoint.source.trajectoryLength}.`);
  }

  const lastStep = checkpoint.trajectory.at(-1);
  if (lastStep) {
    if (checkpoint.source.traceId !== lastStep.traceId) {
      errors.push(`source.traceId mismatch: expected ${lastStep.traceId}, received ${checkpoint.source.traceId ?? "undefined"}.`);
    }
    if (checkpoint.source.turnIndex !== lastStep.turnIndex) {
      errors.push(`source.turnIndex mismatch: expected ${lastStep.turnIndex}, received ${checkpoint.source.turnIndex ?? "undefined"}.`);
    }
    if (lastStep.postStateHash !== checkpoint.source.stateHash) {
      errors.push(`last trajectory postStateHash mismatch: expected ${checkpoint.source.stateHash}, received ${lastStep.postStateHash}.`);
    }
  } else {
    if (checkpoint.source.traceId !== undefined) errors.push("source.traceId must be undefined when trajectory is empty.");
    if (checkpoint.source.turnIndex !== undefined) errors.push("source.turnIndex must be undefined when trajectory is empty.");
  }

  const lastMessage = checkpoint.socialMessages.at(-1);
  const messageIds = new Set<string>();
  for (const [index, message] of checkpoint.socialMessages.entries()) {
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
  if (lastMessage) {
    if (checkpoint.source.messageSeq !== lastMessage.seq) {
      errors.push(`source.messageSeq mismatch: expected ${lastMessage.seq}, received ${checkpoint.source.messageSeq ?? "undefined"}.`);
    }
  } else if (checkpoint.source.messageSeq !== undefined) {
    errors.push("source.messageSeq must be undefined when socialMessages is empty.");
  }

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
  validateCheckpointAgentEvidence(checkpoint, errors);

  return errors;
}

export function assertValidHarnessCheckpoint(checkpoint: HarnessCheckpoint): void {
  const errors = validateHarnessCheckpoint(checkpoint);
  if (errors.length) {
    throw new Error(`Invalid harness checkpoint ${checkpoint.checkpointId}: ${errors.join(" ")}`);
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

function resolveCheckpointPrefixSelection(
  artifact: MatchArtifact,
  selector: HarnessCheckpointPrefixSelector
): { index: number; step: HarnessStepRecord } {
  const selectors = [
    selector.traceId !== undefined ? "traceId" : undefined,
    selector.turnIndex !== undefined ? "turnIndex" : undefined,
    selector.trajectoryLength !== undefined ? "trajectoryLength" : undefined
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
    index = artifact.trajectory.findIndex((step) => step.traceId === selector.traceId);
  } else if (selector.turnIndex !== undefined) {
    index = artifact.trajectory.findIndex((step) => step.turnIndex === selector.turnIndex);
  } else if (selector.trajectoryLength !== undefined) {
    index = selector.trajectoryLength - 1;
  }
  const step = artifact.trajectory[index];
  if (!step) {
    throw new HarnessCheckpointSelectionError("selector_not_found", "Prefix checkpoint selector did not match a committed trajectory step.");
  }
  return { index, step };
}

function assertSafeCheckpointBoundary(artifact: MatchArtifact, stepIndex: number): void {
  const step = artifact.trajectory[stepIndex];
  if (!step) {
    throw new HarnessCheckpointSelectionError("selector_not_found", "Prefix checkpoint selector did not match a committed trajectory step.");
  }
  if (!resolveAgentSnapshotsAfterStep(artifact, step) || step.agentSnapshotsHashAfterStep === undefined) {
    throw new HarnessCheckpointSelectionError(
      "missing_agent_snapshots",
      `Cannot build prefix checkpoint at trajectoryLength ${stepIndex + 1}: agent snapshots are not recorded for this boundary.`
    );
  }
  const socialStep = artifact.socialEpisode.steps.find((candidate) => candidate.traceId === step.traceId);
  if (socialStep?.schedulerMode === "parallel" || socialStep?.atomic) {
    throw new HarnessCheckpointSelectionError(
      "unsafe_batch_boundary",
      "Prefix checkpoint cannot be built from a parallel or atomic step without batch snapshot evidence."
    );
  }
  if (!isSafeCheckpointBoundaryIndex(artifact, stepIndex)) {
    throw new HarnessCheckpointSelectionError(
      "unsafe_batch_boundary",
      "Prefix checkpoint cannot be built from the middle of an aec-batched-decision batch."
    );
  }
}

function isSafeCheckpointBoundaryIndex(artifact: MatchArtifact, stepIndex: number): boolean {
  const step = artifact.trajectory[stepIndex];
  if (!step) return false;
  const socialStep = artifact.socialEpisode.steps.find((candidate) => candidate.traceId === step.traceId);
  if (socialStep?.schedulerMode === "parallel" || socialStep?.atomic) return false;
  const nextStep = artifact.trajectory[stepIndex + 1];
  const nextSocialStep = nextStep ? artifact.socialEpisode.steps.find((candidate) => candidate.traceId === nextStep.traceId) : undefined;
  if (
    socialStep?.schedulerMode === "aec-batched-decision" &&
    socialStep.batchId &&
    nextSocialStep?.batchId === socialStep.batchId
  ) {
    return false;
  }
  return true;
}

function latestMessageSeqForTrajectoryPrefix(trajectory: HarnessStepRecord[]): number {
  let messageSeq = 0;
  for (const step of trajectory) {
    if (step.messageSeqRange) messageSeq = Math.max(messageSeq, step.messageSeqRange[1]);
  }
  return messageSeq;
}

function latestEventSeqForTrajectoryPrefix(trajectory: HarnessStepRecord[]): number {
  let eventSeq = 0;
  for (const step of trajectory) {
    if (step.eventSeqRange) eventSeq = Math.max(eventSeq, step.eventSeqRange[1]);
  }
  return eventSeq;
}

function validateSnapshotEvidenceWithinArtifactPrefix(input: {
  snapshots: AgentHarnessState[];
  trajectory: HarnessStepRecord[];
  stepIndex: number;
  label: string;
  errors: string[];
}): void {
  const prefix = input.trajectory.slice(0, input.stepIndex + 1);
  const futureTraceIds = new Set(input.trajectory.slice(input.stepIndex + 1).map((step) => step.traceId));
  const maxMessageSeq = latestMessageSeqForTrajectoryPrefix(prefix);
  const maxEventSeq = latestEventSeqForTrajectoryPrefix(prefix);
  for (const [agentIndex, agent] of input.snapshots.entries()) {
    validateAgentEvidenceNotBeyondBoundary({
      agent,
      maxMessageSeq,
      maxEventSeq,
      futureTraceIds,
      label: `${input.label}[${agentIndex}]`,
      errors: input.errors
    });
  }
}

function validateCheckpointAgentEvidence(checkpoint: HarnessCheckpoint, errors: string[]): void {
  const futureTraceIds = new Set<string>();
  const maxMessageSeq = checkpoint.source.messageSeq ?? 0;
  const maxEventSeq = latestEventSeqForTrajectoryPrefix(checkpoint.trajectory);
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

function stripAgentSnapshotEvidenceFromTrajectory(trajectory: HarnessStepRecord[]): void {
  for (const step of trajectory) {
    delete step.agentSnapshotsAfterStep;
    delete step.agentSnapshotsHashAfterStep;
    delete step.agentSnapshotFrameIdAfterStep;
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
    if (frame.frameId !== agentSnapshotFrameId(frame.agentsHash)) {
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
  if (checkpoint.source.traceId) traceIds.add(checkpoint.source.traceId);
  for (const step of checkpoint.trajectory) {
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
