import { summarizeEvaluationWarnings } from "../evaluation";
import { harnessFailureEvidenceFromEpisode } from "../executionEvidence";
import { sanitizePersistedProviderDiagnostics } from "../providerFailure";
import { redactSecrets } from "../redaction";
import { SocialMessage, deriveSocialExposureRecords } from "../social";
import { werewolfHarnessTurnEvidenceFromEpisode } from "../werewolfExecutionEvidence";
import { TrajectoryJsonlSource } from "./types";
export function toTrajectoryJsonl(artifact: TrajectoryJsonlSource): string {
  const evaluationReport = artifact.evaluationReport;
  const evaluationWarnings = evaluationReport?.warnings ?? [];
  const evaluationFailures = evaluationReport?.failures ?? [];
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
      status: evaluationReport?.status ?? "completed",
      evaluatorIds: evaluationReport?.evaluatorIds ?? [],
      evaluatorRegistry: evaluationReport?.evaluatorRegistry ?? [],
      metricCount: evaluationReport?.metricCount ?? null,
      failureCount: evaluationFailures.length,
      failures: evaluationFailures,
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
    // Exposure sidecars are optional, validated caches. JSONL evidence must
    // always come from the canonical scoped-observation derivation so callers
    // cannot make an export trust a mutable cached field.
    ...deriveSocialExposureRecords(artifact.socialEpisode).map((exposure) => ({
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
  return `${lines.map((line) => JSON.stringify(sanitizePersistedProviderDiagnostics(redactSecrets(line)))).join("\n")}\n`;
}
